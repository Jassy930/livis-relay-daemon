import { isAbsolute } from "node:path";
import {
  codexLocalEnvironment,
  CodexAppServerRequestTransportError,
  CodexAppServerTimeoutError,
} from "./app-server-client.ts";
import {
  inspectCodexThreadPolicyResponse,
  inspectCodexThreadTail,
  validateNativeCodexFeatures,
  validatePermissionProfiles,
} from "./codex-execution-backend.ts";
import type { CodexNativeExecutionClient } from "./native-execution-lifecycle.ts";
import { CODEX_NATIVE_PERMISSION_PROFILE } from "./runtime-layout.ts";
import { sha256 } from "../../util.ts";

export interface CodexNativeThreadCheckpoint {
  turnId: string | null;
  turnStatus: "completed" | "failed" | "interrupted" | null;
  turnCount: number;
  turnsSha256: string;
}

export type CodexNativeThreadMode =
  | { kind: "fresh" }
  | {
      kind: "resume";
      threadId: string;
      expectedEffectiveModel: string;
      checkpoint: CodexNativeThreadCheckpoint;
    };

export interface CodexNativeThreadPolicyOptions {
  workspace: string;
  cliVersion: string;
  requestedModel: string | null;
  expectedModelProvider: string | null;
  requestTimeoutMs: number;
  mode: CodexNativeThreadMode;
}

export interface CodexNativeThreadPolicyReceipt {
  threadId: string;
  effectiveModel: string;
  modelProvider: string;
  featureSnapshotSha256: string;
  policyBindingSha256: string;
  memoryMode: "disabled";
  checkpoint: CodexNativeThreadCheckpoint;
  productionReady: false;
}

export type CodexNativeThreadPolicyErrorCode =
  | "native_thread_preflight_incompatible"
  | "native_thread_not_submitted"
  | "native_thread_submission_ambiguous"
  | "native_thread_policy_incompatible"
  | "native_thread_checkpoint_drift";

export class CodexNativeThreadPolicyError extends Error {
  constructor(
    readonly code: CodexNativeThreadPolicyErrorCode,
    readonly sessionDisposition: "none" | "quarantine_required",
    message: string,
  ) {
    super(message);
    this.name = "CodexNativeThreadPolicyError";
  }
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} 必须是正整数`);
}

function requestWasDefinitelyUnwritten(error: unknown): boolean {
  return (
    (error instanceof CodexAppServerTimeoutError ||
      error instanceof CodexAppServerRequestTransportError) &&
    !error.written
  );
}

function sameCheckpoint(
  left: CodexNativeThreadCheckpoint,
  right: CodexNativeThreadCheckpoint,
): boolean {
  return left.turnId === right.turnId && left.turnStatus === right.turnStatus &&
    left.turnCount === right.turnCount && left.turnsSha256 === right.turnsSha256;
}

async function preflightRequest(
  client: CodexNativeExecutionClient,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<unknown> {
  try {
    return await client.request(method, params, timeoutMs);
  } catch {
    throw new CodexNativeThreadPolicyError(
      "native_thread_preflight_incompatible",
      "none",
      "Codex native thread 前置安全能力无法完成回读",
    );
  }
}

/**
 * 固定逐 thread 安全边界。调用会创建或恢复 thread，因此真实端点只能由显式
 * `native-current` adapter 在操作者授权的 serve/canary 中使用。
 */
export async function prepareCodexNativeThread(
  client: CodexNativeExecutionClient,
  options: CodexNativeThreadPolicyOptions,
): Promise<CodexNativeThreadPolicyReceipt> {
  if (!isAbsolute(options.workspace)) throw new Error("workspace 必须是绝对路径");
  if (options.cliVersion.trim() === "") throw new Error("cliVersion 不能为空");
  if (options.expectedModelProvider !== null && options.expectedModelProvider.trim() === "") {
    throw new Error("expectedModelProvider 不能为空");
  }
  positiveInteger(options.requestTimeoutMs, "requestTimeoutMs");
  if (options.mode.kind === "resume") {
    if (options.mode.threadId.trim() === "" || options.mode.expectedEffectiveModel.trim() === "") {
      throw new Error("resume threadId/effectiveModel 不能为空");
    }
  }

  const permissionProfiles = await preflightRequest(
    client,
    "permissionProfile/list",
    { cwd: options.workspace },
    options.requestTimeoutMs,
  );
  const featureList = await preflightRequest(
    client,
    "experimentalFeature/list",
    { cursor: null, limit: 256 },
    options.requestTimeoutMs,
  );
  let featureSnapshotSha256: string;
  try {
    validatePermissionProfiles(permissionProfiles, CODEX_NATIVE_PERMISSION_PROFILE);
    featureSnapshotSha256 = validateNativeCodexFeatures(featureList);
  } catch {
    throw new CodexNativeThreadPolicyError(
      "native_thread_preflight_incompatible",
      "none",
      "Codex native daemon 未提供逐 thread 执行所需的固定 permission profile 或 feature 快照",
    );
  }

  const commonParams = {
    cwd: options.workspace,
    runtimeWorkspaceRoots: [options.workspace],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    permissions: CODEX_NATIVE_PERMISSION_PROFILE,
    ...(options.requestedModel === null ? {} : { model: options.requestedModel }),
  } as const;
  let threadResponse: unknown;
  try {
    threadResponse = options.mode.kind === "fresh"
      ? await client.request("thread/start", {
          ...commonParams,
          environments: codexLocalEnvironment(options.workspace),
          ephemeral: false,
        }, options.requestTimeoutMs)
      : await client.request("thread/resume", {
          threadId: options.mode.threadId,
          ...commonParams,
        }, options.requestTimeoutMs);
  } catch (error) {
    if (requestWasDefinitelyUnwritten(error)) {
      throw new CodexNativeThreadPolicyError(
        "native_thread_not_submitted",
        "none",
        "Codex native thread 请求可证明未写入",
      );
    }
    throw new CodexNativeThreadPolicyError(
      "native_thread_submission_ambiguous",
      "quarantine_required",
      "Codex native thread 创建或恢复结果不确定，禁止自动替代",
    );
  }

  const expectedThreadId = options.mode.kind === "resume" ? options.mode.threadId : null;
  let binding;
  try {
    binding = inspectCodexThreadPolicyResponse(threadResponse, {
      workspace: options.workspace,
      expectedThreadId,
      expectedModelProvider: options.expectedModelProvider,
      permissionProfile: CODEX_NATIVE_PERMISSION_PROFILE,
      instructionSourcePolicy: "local-opaque",
    });
    if (
      options.requestedModel !== null && binding.effectiveModel !== options.requestedModel
    ) {
      throw new Error("requested model drift");
    }
    if (
      options.mode.kind === "resume" &&
      binding.effectiveModel !== options.mode.expectedEffectiveModel
    ) {
      throw new Error("persisted model drift");
    }
  } catch {
    throw new CodexNativeThreadPolicyError(
      "native_thread_policy_incompatible",
      "quarantine_required",
      "Codex native thread 安全回读不满足 workspace-only、无网络、无继承配置边界",
    );
  }

  try {
    await client.request("thread/memoryMode/set", {
      threadId: binding.threadId,
      mode: "disabled",
    }, options.requestTimeoutMs);
  } catch {
    throw new CodexNativeThreadPolicyError(
      "native_thread_policy_incompatible",
      "quarantine_required",
      "Codex native thread 无法确认关闭 memory",
    );
  }

  let checkpoint: CodexNativeThreadCheckpoint;
  try {
    const persisted = await client.request("thread/read", {
      threadId: binding.threadId,
      includeTurns: true,
    }, options.requestTimeoutMs);
    const tail = inspectCodexThreadTail(persisted, binding.threadId);
    checkpoint = {
      turnId: tail.turnId,
      turnStatus: tail.turnStatus,
      turnCount: tail.turnCount,
      turnsSha256: tail.turnsSha256,
    };
  } catch {
    throw new CodexNativeThreadPolicyError(
      "native_thread_checkpoint_drift",
      "quarantine_required",
      "Codex native thread 尾部无法建立稳定 checkpoint",
    );
  }
  if (
    (options.mode.kind === "fresh" &&
      (checkpoint.turnId !== null || checkpoint.turnStatus !== null || checkpoint.turnCount !== 0)) ||
    (options.mode.kind === "resume" &&
      !sameCheckpoint(checkpoint, options.mode.checkpoint))
  ) {
    throw new CodexNativeThreadPolicyError(
      "native_thread_checkpoint_drift",
      "quarantine_required",
      "Codex native thread 存在未归属 turn 或 checkpoint 漂移",
    );
  }

  return {
    threadId: binding.threadId,
    effectiveModel: binding.effectiveModel,
    modelProvider: binding.modelProvider,
    featureSnapshotSha256,
    policyBindingSha256: sha256(JSON.stringify([
      "livis-codex-native-thread-policy-v2",
      options.cliVersion,
      options.workspace,
      CODEX_NATIVE_PERMISSION_PROFILE,
      featureSnapshotSha256,
      binding.effectiveModel,
      binding.modelProvider,
      binding.instructionSourcesSha256,
    ])),
    memoryMode: "disabled",
    checkpoint,
    productionReady: false,
  };
}
