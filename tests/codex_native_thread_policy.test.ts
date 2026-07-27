import { describe, expect, test } from "bun:test";
import {
  CODEX_0145_ALLOWED_ENABLED_FEATURES,
  CODEX_DISABLED_FEATURES,
  CodexAppServerTimeoutError,
} from "../src/backends/codex/app-server-client.ts";
import type { CodexNativeExecutionClient } from "../src/backends/codex/native-execution-lifecycle.ts";
import {
  CodexNativeThreadPolicyError,
  prepareCodexNativeThread,
  type CodexNativeThreadPolicyOptions,
} from "../src/backends/codex/native-thread-policy.ts";
import { sha256 } from "../src/util.ts";

function featureSnapshot(): Array<Record<string, unknown>> {
  const features = new Map<string, Record<string, unknown>>();
  for (const name of CODEX_DISABLED_FEATURES) {
    features.set(name, {
      name,
      stage: "experimental",
      enabled: false,
      defaultEnabled: false,
    });
  }
  for (const [name, stage] of CODEX_0145_ALLOWED_ENABLED_FEATURES) {
    features.set(name, {
      name,
      stage,
      enabled: true,
      defaultEnabled: true,
    });
  }
  return [...features.values()];
}

class FakeNativeThreadClient implements CodexNativeExecutionClient {
  readonly running = true;
  readonly exited = new Promise<number>(() => undefined);
  readonly requests: Array<{ method: string; params: unknown; timeoutMs?: number }> = [];
  threadId = "native-thread-1";
  model = "gpt-5.6-sol";
  modelProvider = "openai";
  permissionAllowed = true;
  enabledHighRiskFeature: string | null = null;
  threadResponseOverride: Record<string, unknown> = {};
  turns: Array<{ id: string; status: "completed" | "failed" | "interrupted" }> = [];
  threadStatus: "idle" | "active" | "systemError" = "idle";
  failMethod: string | null = null;
  failWritten = true;
  closed = false;

  async request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    this.requests.push({ method, params, timeoutMs });
    if (method === this.failMethod) {
      throw new CodexAppServerTimeoutError(method, this.requests.length, timeoutMs ?? 1, this.failWritten);
    }
    if (method === "permissionProfile/list") {
      return {
        data: [{ id: "livis-native-stdio", allowed: this.permissionAllowed }],
        nextCursor: null,
      } as T;
    }
    if (method === "experimentalFeature/list") {
      const data = featureSnapshot();
      if (this.enabledHighRiskFeature !== null) {
        const feature = data.find((candidate) => candidate.name === this.enabledHighRiskFeature);
        if (feature) feature.enabled = true;
      }
      return { data, nextCursor: null } as T;
    }
    if (method === "thread/start" || method === "thread/resume") {
      return this.threadResponse() as T;
    }
    if (method === "thread/memoryMode/set") return {} as T;
    if (method === "thread/read") {
      return {
        thread: {
          id: this.threadId,
          status: { type: this.threadStatus },
          turns: this.turns.map((turn) => ({ ...turn })),
        },
      } as T;
    }
    throw new Error(`fake client 未覆盖 ${method}`);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private threadResponse(): Record<string, unknown> {
    return {
      thread: { id: this.threadId, cwd: "/test/native-workspace" },
      cwd: "/test/native-workspace",
      runtimeWorkspaceRoots: ["/test/native-workspace"],
      instructionSources: [],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      activePermissionProfile: { id: "livis-native-stdio", extends: null },
      sandbox: {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
      model: this.model,
      modelProvider: this.modelProvider,
      ...this.threadResponseOverride,
    };
  }
}

function options(
  overrides: Partial<CodexNativeThreadPolicyOptions> = {},
): CodexNativeThreadPolicyOptions {
  return {
    workspace: "/test/native-workspace",
    cliVersion: "0.145.0",
    requestedModel: "gpt-5.6-sol",
    expectedModelProvider: "openai",
    requestTimeoutMs: 100,
    mode: { kind: "fresh" },
    ...overrides,
  };
}

function policyError(error: unknown): CodexNativeThreadPolicyError {
  expect(error).toBeInstanceOf(CodexNativeThreadPolicyError);
  return error as CodexNativeThreadPolicyError;
}

describe("Codex native thread 离线安全策略", () => {
  test("fresh thread 固定 workspace/审批/profile/memory 并建立空尾 checkpoint", async () => {
    const client = new FakeNativeThreadClient();
    const receipt = await prepareCodexNativeThread(client, options());

    expect(receipt).toMatchObject({
      threadId: "native-thread-1",
      effectiveModel: "gpt-5.6-sol",
      modelProvider: "openai",
      memoryMode: "disabled",
      checkpoint: { turnId: null, turnStatus: null, turnCount: 0 },
      productionReady: false,
    });
    expect(receipt.featureSnapshotSha256).toHaveLength(64);
    expect(receipt.policyBindingSha256).toHaveLength(64);
    expect(client.requests.map((request) => request.method)).toEqual([
      "permissionProfile/list",
      "experimentalFeature/list",
      "thread/start",
      "thread/memoryMode/set",
      "thread/read",
    ]);
    expect(client.requests[2]?.params).toEqual({
      cwd: "/test/native-workspace",
      runtimeWorkspaceRoots: ["/test/native-workspace"],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      permissions: "livis-native-stdio",
      model: "gpt-5.6-sol",
      environments: [{
        environmentId: "local",
        cwd: "/test/native-workspace",
        runtimeWorkspaceRoots: ["/test/native-workspace"],
      }],
      ephemeral: false,
    });
    expect(client.requests[3]?.params).toEqual({
      threadId: "native-thread-1",
      mode: "disabled",
    });
  });

  test("resume 只接受同一 thread、model/provider 和精确历史 checkpoint", async () => {
    const client = new FakeNativeThreadClient();
    client.turns = [{ id: "turn-1", status: "completed" }];
    const checkpoint = {
      turnId: "turn-1",
      turnStatus: "completed" as const,
      turnCount: 1,
      turnsSha256: sha256(JSON.stringify(client.turns)),
    };
    const receipt = await prepareCodexNativeThread(client, options({
      mode: {
        kind: "resume",
        threadId: "native-thread-1",
        expectedEffectiveModel: "gpt-5.6-sol",
        checkpoint,
      },
    }));

    expect(receipt.checkpoint).toEqual(checkpoint);
    expect(client.requests[2]?.method).toBe("thread/resume");
    expect(client.requests[2]?.params).toMatchObject({ threadId: "native-thread-1" });
  });

  test("fresh 接受本地不透明 provider 与有界 instruction source，并绑定到策略摘要", async () => {
    const client = new FakeNativeThreadClient();
    client.modelProvider = "custom";
    client.threadResponseOverride = {
      instructionSources: ["/Users/test/.codex/AGENTS.md"],
    };
    const receipt = await prepareCodexNativeThread(client, options({
      cliVersion: "0.146.0-alpha.3.1",
      expectedModelProvider: null,
    }));

    expect(receipt.modelProvider).toBe("custom");
    expect(receipt.policyBindingSha256).toHaveLength(64);

    client.threadResponseOverride = { instructionSources: ["relative/AGENTS.md"] };
    await expect(prepareCodexNativeThread(client, options({
      expectedModelProvider: null,
    }))).rejects.toMatchObject({
      code: "native_thread_policy_incompatible",
      sessionDisposition: "quarantine_required",
    });
  });

  test("启用受控 context 时必须回读 workspace AGENTS instruction source", async () => {
    const client = new FakeNativeThreadClient();
    client.threadResponseOverride = {
      instructionSources: ["/test/native-workspace/AGENTS.md", "/Users/test/.codex/AGENTS.md"],
    };
    await expect(prepareCodexNativeThread(client, options({
      requiredInstructionSource: "/test/native-workspace/AGENTS.md",
    }))).resolves.toMatchObject({ memoryMode: "disabled" });

    client.threadResponseOverride = {
      instructionSources: ["/Users/test/.codex/AGENTS.md"],
    };
    await expect(prepareCodexNativeThread(client, options({
      requiredInstructionSource: "/test/native-workspace/AGENTS.md",
    }))).rejects.toMatchObject({
      code: "native_thread_policy_incompatible",
      sessionDisposition: "quarantine_required",
    });
  });

  test("permission profile 或全局 feature 不满足时在创建 thread 前失败关闭", async () => {
    for (const variant of ["profile", "feature"] as const) {
      const client = new FakeNativeThreadClient();
      if (variant === "profile") client.permissionAllowed = false;
      else client.enabledHighRiskFeature = "plugins";
      let caught: unknown;
      try {
        await prepareCodexNativeThread(client, options());
      } catch (error) {
        caught = error;
      }
      const error = policyError(caught);
      expect(error.code).toBe("native_thread_preflight_incompatible");
      expect(error.sessionDisposition).toBe("none");
      expect(client.requests.some((request) => request.method === "thread/start")).toBeFalse();
    }
  });

  test("开放网络或额外写根均在 thread 创建后要求 quarantine", async () => {
    const variants: Record<string, Record<string, unknown>> = {
      network: {
        sandbox: {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: true,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      },
      writableRoot: {
        sandbox: {
          type: "workspaceWrite",
          writableRoots: ["/Users/test"],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      },
    };
    for (const override of Object.values(variants)) {
      const client = new FakeNativeThreadClient();
      client.threadResponseOverride = override;
      let caught: unknown;
      try {
        await prepareCodexNativeThread(client, options());
      } catch (error) {
        caught = error;
      }
      const error = policyError(caught);
      expect(error.code).toBe("native_thread_policy_incompatible");
      expect(error.sessionDisposition).toBe("quarantine_required");
      expect(client.requests.some((request) => request.method === "thread/start")).toBeTrue();
      expect(client.requests.some((request) => request.method === "thread/memoryMode/set"))
        .toBeFalse();
    }
  });

  test("thread 请求只有可证明未写入时可安全重试，否则必须 ambiguous quarantine", async () => {
    for (const written of [false, true]) {
      const client = new FakeNativeThreadClient();
      client.failMethod = "thread/start";
      client.failWritten = written;
      let caught: unknown;
      try {
        await prepareCodexNativeThread(client, options());
      } catch (error) {
        caught = error;
      }
      const error = policyError(caught);
      expect(error.code).toBe(
        written ? "native_thread_submission_ambiguous" : "native_thread_not_submitted",
      );
      expect(error.sessionDisposition).toBe(written ? "quarantine_required" : "none");
    }
  });

  test("memory 关闭失败或历史 checkpoint 漂移都要求 quarantine", async () => {
    const memoryFailure = new FakeNativeThreadClient();
    memoryFailure.failMethod = "thread/memoryMode/set";
    await expect(prepareCodexNativeThread(memoryFailure, options())).rejects.toMatchObject({
      code: "native_thread_policy_incompatible",
      sessionDisposition: "quarantine_required",
    });

    const checkpointDrift = new FakeNativeThreadClient();
    checkpointDrift.turns = [{ id: "unexpected-turn", status: "completed" }];
    await expect(prepareCodexNativeThread(checkpointDrift, options())).rejects.toMatchObject({
      code: "native_thread_checkpoint_drift",
      sessionDisposition: "quarantine_required",
    });
  });
});
