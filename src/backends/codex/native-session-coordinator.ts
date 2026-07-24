import { isAbsolute } from "node:path";
import type { CodexAppServerNotification } from "./app-server-client.ts";
import {
  CodexNativeClientEpochFence,
  type CodexNativeClientEpochReceipt,
} from "./native-client-epoch.ts";
import {
  CodexNativeExecutionLifecycle,
  type CodexNativeExecutionClient,
} from "./native-execution-lifecycle.ts";
import {
  CodexNativeThreadPolicyError,
  prepareCodexNativeThread,
  type CodexNativeThreadCheckpoint,
  type CodexNativeThreadPolicyReceipt,
} from "./native-thread-policy.ts";
import { inspectCodexThreadTail } from "./codex-execution-backend.ts";
import type {
  ExecutionAcceptedEvent,
  ExecutionBackendHandlers,
  ExecutionCancelledEvent,
  ExecutionFailedEvent,
  ExecutionResultEvent,
  ExecutionSubmission,
} from "../execution-backend.ts";
import type { JobStore } from "../../state/store.ts";
import type { StoredBackendSession, StoredJob } from "../../types.ts";

export interface CodexNativeSessionCoordinatorOptions {
  sessionKey: string;
  sessionHash: string;
  workspace: string;
  cliVersion: string;
  requestedModel: string | null;
  expectedModelProvider: string;
  requestTimeoutMs: number;
  turnTimeoutMs: number;
  maxOutputChars: number;
}

export interface CodexNativeSessionCoordinatorDependencies {
  store: JobStore;
  client: CodexNativeExecutionClient;
  handlers: ExecutionBackendHandlers;
  clientEpochFence: CodexNativeClientEpochFence;
}

export type CodexNativeSessionCoordinatorErrorCode =
  | "native_session_quarantined"
  | "native_session_active_attempt"
  | "native_session_client_epoch_superseded"
  | "native_session_metadata_drift"
  | "native_session_persistence_failed";

export class CodexNativeSessionCoordinatorError extends Error {
  constructor(
    readonly code: CodexNativeSessionCoordinatorErrorCode,
    readonly sessionDisposition: "none" | "quarantine_required",
    message: string,
  ) {
    super(message);
    this.name = "CodexNativeSessionCoordinatorError";
  }
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} 必须是正整数`);
}

async function closeClientAfterFailure(
  client: CodexNativeExecutionClient,
  primaryError: unknown,
): Promise<never> {
  try {
    await client.close();
  } catch (closeError) {
    throw new AggregateError(
      [primaryError, closeError],
      "Codex native coordinator 失败后 proxy client 收口未确认",
    );
  }
  throw primaryError;
}

function validateOptions(options: CodexNativeSessionCoordinatorOptions): void {
  if (options.sessionKey.trim() === "") throw new Error("sessionKey 不能为空");
  if (!/^[0-9a-f]{64}$/.test(options.sessionHash)) {
    throw new Error("sessionHash 必须是 64 位小写 SHA-256");
  }
  if (!isAbsolute(options.workspace)) throw new Error("workspace 必须是绝对路径");
  if (options.cliVersion.trim() === "") throw new Error("cliVersion 不能为空");
  if (options.requestedModel !== null && options.requestedModel.trim() === "") {
    throw new Error("requestedModel 不能为空字符串");
  }
  if (options.expectedModelProvider.trim() === "") {
    throw new Error("expectedModelProvider 不能为空");
  }
  positiveInteger(options.requestTimeoutMs, "requestTimeoutMs");
  positiveInteger(options.turnTimeoutMs, "turnTimeoutMs");
  positiveInteger(options.maxOutputChars, "maxOutputChars");
}

function storedCheckpoint(session: StoredBackendSession): CodexNativeThreadCheckpoint {
  if (
    session.checkpointTurnCount === null || session.checkpointTurnsSha256 === null ||
    session.checkpointedAt === null
  ) {
    throw new CodexNativeSessionCoordinatorError(
      "native_session_metadata_drift",
      "quarantine_required",
      "Codex native session 缺少完整 checkpoint",
    );
  }
  return {
    turnId: session.checkpointTurnId,
    turnStatus: session.checkpointTurnStatus,
    turnCount: session.checkpointTurnCount,
    turnsSha256: session.checkpointTurnsSha256,
  };
}

function assertResumeMetadata(
  session: StoredBackendSession,
  options: CodexNativeSessionCoordinatorOptions,
): void {
  if (
    session.stateOwnership !== "local-state-opaque" || session.threadId === null ||
    session.sessionHash !== options.sessionHash || session.cwd !== options.workspace ||
    session.cliVersion !== options.cliVersion ||
    session.requestedModel !== options.requestedModel || session.effectiveModel === null ||
    session.modelProvider !== options.expectedModelProvider ||
    session.securityConfigSha256 === null || session.featureSnapshotSha256 === null
  ) {
    throw new CodexNativeSessionCoordinatorError(
      "native_session_metadata_drift",
      "quarantine_required",
      "Codex native session immutable metadata 不一致",
    );
  }
}

function sameReceiptMetadata(
  session: StoredBackendSession,
  receipt: CodexNativeThreadPolicyReceipt,
): boolean {
  return session.threadId === receipt.threadId &&
    session.effectiveModel === receipt.effectiveModel &&
    session.modelProvider === receipt.modelProvider &&
    session.securityConfigSha256 === receipt.policyBindingSha256 &&
    session.featureSnapshotSha256 === receipt.featureSnapshotSha256;
}

/**
 * 组合持久 session、client epoch、thread policy/checkpoint 与执行生命周期的离线原型。
 *
 * 本类只接收上层已经建立的 proxy client，不连接真实 Desktop、不管理原生 daemon，
 * 也不读取或分类本地 backend 状态。生产 serve 仍不得导入本文件。
 */
export class CodexNativeSessionCoordinator {
  readonly kind = "codex" as const;
  readonly executionId: string;

  private constructor(
    private readonly options: CodexNativeSessionCoordinatorOptions,
    private readonly store: JobStore,
    private readonly clientEpochReceipt: CodexNativeClientEpochReceipt,
    private readonly threadReceipt: CodexNativeThreadPolicyReceipt,
    private readonly lifecycle: CodexNativeExecutionLifecycle,
  ) {
    this.executionId = lifecycle.executionId;
  }

  static async start(
    options: CodexNativeSessionCoordinatorOptions,
    dependencies: CodexNativeSessionCoordinatorDependencies,
  ): Promise<CodexNativeSessionCoordinator> {
    validateOptions(options);
    const existing = dependencies.store.getBackendSession("codex", options.sessionKey);
    await this.rejectUnsafePersistentState(options, dependencies, existing);

    const clientEpochReceipt = dependencies.clientEpochFence.attach(dependencies.client);
    let threadReceipt: CodexNativeThreadPolicyReceipt;
    try {
      threadReceipt = await prepareCodexNativeThread(dependencies.client, {
        workspace: options.workspace,
        cliVersion: options.cliVersion,
        requestedModel: options.requestedModel,
        expectedModelProvider: options.expectedModelProvider,
        requestTimeoutMs: options.requestTimeoutMs,
        mode: existing
          ? {
              kind: "resume",
              threadId: existing.threadId!,
              expectedEffectiveModel: existing.effectiveModel!,
              checkpoint: storedCheckpoint(existing),
            }
          : { kind: "fresh" },
      });
      if (!dependencies.clientEpochFence.isCurrent(clientEpochReceipt, dependencies.client)) {
        throw new CodexNativeSessionCoordinatorError(
          "native_session_client_epoch_superseded",
          "quarantine_required",
          "Codex native thread 准备期间 client epoch 已被替代",
        );
      }
      if (existing) {
        if (!sameReceiptMetadata(existing, threadReceipt)) {
          throw new CodexNativeSessionCoordinatorError(
            "native_session_metadata_drift",
            "quarantine_required",
            "Codex native resume 回读与持久 session 锚点不一致",
          );
        }
      } else {
        dependencies.store.createLocalOpaqueBackendSession({
          backend: "codex",
          sessionKey: options.sessionKey,
          sessionHash: options.sessionHash,
          threadId: threadReceipt.threadId,
          cwd: options.workspace,
          cliVersion: options.cliVersion,
          requestedModel: options.requestedModel,
          effectiveModel: threadReceipt.effectiveModel,
          modelProvider: threadReceipt.modelProvider,
          securityConfigSha256: threadReceipt.policyBindingSha256,
          featureSnapshotSha256: threadReceipt.featureSnapshotSha256,
          checkpointTurnId: threadReceipt.checkpoint.turnId,
          checkpointTurnStatus: threadReceipt.checkpoint.turnStatus,
          checkpointTurnCount: threadReceipt.checkpoint.turnCount,
          checkpointTurnsSha256: threadReceipt.checkpoint.turnsSha256,
          checkpointedAt: Date.now(),
        });
      }
    } catch (error) {
      if (
        (error instanceof CodexNativeThreadPolicyError &&
          error.sessionDisposition === "quarantine_required") ||
        (error instanceof CodexNativeSessionCoordinatorError &&
          error.sessionDisposition === "quarantine_required")
      ) {
        dependencies.store.quarantineSession(options.sessionKey, error.message);
      } else if (!(error instanceof CodexNativeThreadPolicyError)) {
        dependencies.store.quarantineSession(
          options.sessionKey,
          "Codex native thread 已返回但持久 session 无法原子绑定",
        );
      }
      dependencies.clientEpochFence.invalidate(clientEpochReceipt, dependencies.client);
      const outwardError = (
        error instanceof CodexNativeThreadPolicyError ||
        error instanceof CodexNativeSessionCoordinatorError
      )
        ? error
        : new CodexNativeSessionCoordinatorError(
            "native_session_persistence_failed",
            "quarantine_required",
            "Codex native session 持久化失败",
          );
      return closeClientAfterFailure(dependencies.client, outwardError);
    }

    const executionId = `codex-native:${threadReceipt.threadId}:${clientEpochReceipt.clientEpoch}`;
    const lifecycle = new CodexNativeExecutionLifecycle({
      executionId,
      threadId: threadReceipt.threadId,
      workspace: options.workspace,
      requestTimeoutMs: options.requestTimeoutMs,
      turnTimeoutMs: options.turnTimeoutMs,
      maxOutputChars: options.maxOutputChars,
    }, {
      client: dependencies.client,
      clientEpochFence: dependencies.clientEpochFence,
      clientEpochReceipt,
      handlers: this.checkpointingHandlers(
        options,
        dependencies,
        threadReceipt.threadId,
      ),
      onSessionQuarantine: async (code) => {
        dependencies.store.quarantineSession(options.sessionKey, code);
        await dependencies.handlers.onDisconnected({
          kind: "codex",
          executionId,
          reason: code,
        });
      },
    });
    const coordinator = new CodexNativeSessionCoordinator(
      options,
      dependencies.store,
      clientEpochReceipt,
      threadReceipt,
      lifecycle,
    );
    try {
      await dependencies.handlers.onReady({
        kind: "codex",
        executionId,
        implementation: {
          name: "codex-native-session-coordinator-prototype",
          version: options.cliVersion,
          stateOwnership: "local-state-opaque",
          effectiveModel: threadReceipt.effectiveModel,
          modelProvider: threadReceipt.modelProvider,
          clientEpoch: clientEpochReceipt.clientEpoch,
          productionReady: false,
        },
      });
    } catch (error) {
      try {
        await coordinator.stop();
      } catch (stopError) {
        throw new AggregateError(
          [error, stopError],
          "Codex native ready handler 与 proxy client 收口同时失败",
        );
      }
      throw error;
    }
    return coordinator;
  }

  get ready(): boolean {
    const session = this.store.getBackendSession("codex", this.options.sessionKey);
    return this.lifecycle.ready && this.store.getSessionQuarantine(this.options.sessionKey) === null &&
      session?.stateOwnership === "local-state-opaque" &&
      session.threadId === this.threadReceipt.threadId && !session.recoveryRequired;
  }

  dispatch(job: StoredJob): Promise<ExecutionSubmission> {
    if (!this.ready) return Promise.resolve("not_sent");
    return this.lifecycle.dispatch(job);
  }

  cancel(job: StoredJob): Promise<ExecutionSubmission> {
    return this.lifecycle.cancel(job);
  }

  handleNotification(
    notification: CodexAppServerNotification,
    clientEpoch = this.clientEpochReceipt.clientEpoch,
  ): void {
    this.lifecycle.handleNotification(notification, clientEpoch);
  }

  waitForIdle(): Promise<void> {
    return this.lifecycle.waitForIdle();
  }

  stop(): Promise<void> {
    return this.lifecycle.stop();
  }

  status(): Record<string, unknown> {
    return {
      implementation: "codex-native-session-coordinator-prototype",
      ready: this.ready,
      sessionKey: this.options.sessionKey,
      threadId: this.threadReceipt.threadId,
      clientEpoch: this.clientEpochReceipt.clientEpoch,
      stateOwnership: "local-state-opaque",
      lifecycle: this.lifecycle.status(),
      productionReady: false,
    };
  }

  private static async rejectUnsafePersistentState(
    options: CodexNativeSessionCoordinatorOptions,
    dependencies: CodexNativeSessionCoordinatorDependencies,
    existing: StoredBackendSession | null,
  ): Promise<void> {
    if (existing && (
      existing.activeJobId !== null || existing.activeLeaseId !== null ||
      existing.activeRunGeneration !== null || existing.activeTurnId !== null ||
      existing.recoveryRequired
    )) {
      if (existing.activeJobId !== null) {
        const activeJob = dependencies.store.get(existing.activeJobId);
        if (activeJob?.connectorId) {
          dependencies.store.markBackendDisconnected(
            "codex",
            activeJob.connectorId,
            "Codex native coordinator 检测到历史 active attempt",
          );
        }
      }
      dependencies.store.quarantineSession(
        options.sessionKey,
        "Codex native coordinator 检测到历史 active/recovery attempt",
      );
      const error = new CodexNativeSessionCoordinatorError(
        "native_session_active_attempt",
        "quarantine_required",
        "Codex native session 存在未结算执行，禁止自动恢复或替代 thread",
      );
      return closeClientAfterFailure(dependencies.client, error);
    }

    const quarantine = dependencies.store.getSessionQuarantine(options.sessionKey);
    if (quarantine) {
      const error = new CodexNativeSessionCoordinatorError(
        "native_session_quarantined",
        "none",
        `Codex native session 已隔离：${quarantine.reason}`,
      );
      return closeClientAfterFailure(dependencies.client, error);
    }
    if (!existing) return;
    try {
      assertResumeMetadata(existing, options);
      storedCheckpoint(existing);
    } catch (error) {
      dependencies.store.quarantineSession(
        options.sessionKey,
        error instanceof Error ? error.message : "Codex native session metadata 漂移",
      );
      return closeClientAfterFailure(dependencies.client, error);
    }
  }

  private static checkpointingHandlers(
    options: CodexNativeSessionCoordinatorOptions,
    dependencies: CodexNativeSessionCoordinatorDependencies,
    threadId: string,
  ): ExecutionBackendHandlers {
    const checkpoint = async (
      event: ExecutionResultEvent | ExecutionFailedEvent | ExecutionCancelledEvent,
      expectedStatus: "completed" | "failed" | null,
    ): Promise<void> => {
      if (event.runGeneration === undefined || event.turnId === null || event.turnId === undefined) {
        throw new Error("Codex native terminal 缺少 generation/turn fence");
      }
      const persisted = await dependencies.client.request("thread/read", {
        threadId,
        includeTurns: true,
      }, options.requestTimeoutMs);
      const tail = inspectCodexThreadTail(persisted, threadId);
      if (tail.turnId !== event.turnId || (expectedStatus !== null && tail.turnStatus !== expectedStatus)) {
        throw new Error("Codex native terminal 与 thread checkpoint 回读不一致");
      }
      dependencies.store.checkpointBackendThreadTail({
        backend: "codex",
        sessionKey: options.sessionKey,
        threadId,
        checkpointTurnId: tail.turnId,
        checkpointTurnStatus: tail.turnStatus,
        checkpointTurnCount: tail.turnCount,
        checkpointTurnsSha256: tail.turnsSha256,
        checkpointedAt: Date.now(),
        fence: {
          kind: "active",
          jobId: event.jobId,
          leaseId: event.leaseId,
          runGeneration: event.runGeneration,
          turnId: event.turnId,
        },
      });
    };

    return {
      onReady: dependencies.handlers.onReady,
      onAccepted: async (event: ExecutionAcceptedEvent) => dependencies.handlers.onAccepted(event),
      onResult: async (event) => {
        await checkpoint(event, "completed");
        await dependencies.handlers.onResult(event);
      },
      onFailed: async (event) => {
        await checkpoint(event, "failed");
        await dependencies.handlers.onFailed(event);
      },
      onCancelled: async (event) => {
        await checkpoint(event, null);
        await dependencies.handlers.onCancelled(event);
      },
      onDisconnected: async (event) => dependencies.handlers.onDisconnected(event),
    };
  }
}
