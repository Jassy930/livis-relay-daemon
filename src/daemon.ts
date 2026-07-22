import { join } from "node:path";
import type {
  ExecutionAcceptedEvent,
  ExecutionBackend,
  ExecutionBackendHandlers,
  ExecutionCancelledEvent,
  ExecutionDisconnectedEvent,
  ExecutionFailedEvent,
  ExecutionReadyEvent,
  ExecutionResultEvent,
} from "./backends/execution-backend.ts";
import { HermesExecutionBackend } from "./backends/hermes-backend.ts";
import { CodexExecutionBackend } from "./backends/codex/codex-execution-backend.ts";
import type { RelayConfig } from "./config.ts";
import { ConnectorServer, type ConnectorServerHandlers } from "./connector/server.ts";
import { IdaasClient } from "./auth/idaas.ts";
import { IdentityStore, type RelayIdentity } from "./identity.ts";
import { Logger } from "./logger.ts";
import { errorMessage } from "./logger.ts";
import { parseIncomingRelayJob, serializeResult } from "./protocol/livis.ts";
import type { ProtocolProfile } from "./protocol/profile.ts";
import { RelayClient, type RelayClientHandlers } from "./relay/client.ts";
import { SecretStore, type RelaySecrets } from "./secrets.ts";
import { JobConflictError, JobStore } from "./state/store.ts";
import {
  ProfileOperationGuard,
  ProfileOperationGuardBusyError,
} from "./state/offline-guard.ts";
import type { RelayEnvelope, StoredJob } from "./types.ts";
import { UpstreamChecker } from "./upstream/checker.ts";
import { saveSupportedProof } from "./upstream/proof.ts";

export const DAEMON_VERSION = "0.1.0";
const UPSTREAM_RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPSTREAM_PROOF_EXPIRED_REASON = "supported proof 已过期；必须在线复核通过后才能继续派发";

export interface RelayDaemonDependencies {
  config: RelayConfig;
  profile: ProtocolProfile;
  identity: RelayIdentity;
  secrets: SecretStore;
  secretValues: RelaySecrets;
  upstreamProofExpiresAt: number;
  logger?: Logger;
  /** 仅用于 deterministic deadline 测试；生产调用不传。 */
  testHooks?: RelayDaemonTestHooks;
}

export interface RelayDaemonTestHooks {
  now?: () => number;
  setProofExpiryTimer?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearProofExpiryTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class RelayDaemon {
  private stopping = false;
  private upstreamTimer: ReturnType<typeof setInterval> | null = null;
  private upstreamExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private upstreamCheckPromise: Promise<void> | null = null;
  private upstreamBlockPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private upstreamBlocked: string | null = null;
  private upstreamRelayStopped = false;

  private constructor(
    private readonly config: RelayConfig,
    private readonly profile: ProtocolProfile,
    private readonly identity: RelayIdentity,
    private readonly store: JobStore,
    private readonly connector: ConnectorServer,
    private readonly executionBackend: ExecutionBackend,
    private readonly relay: RelayClient,
    private readonly logger: Logger,
    private upstreamProofExpiresAt: number,
    private readonly upstreamChecker: UpstreamChecker,
    private readonly testHooks?: RelayDaemonTestHooks,
  ) {}

  static create(dependencies: RelayDaemonDependencies): RelayDaemon {
    const logger = dependencies.logger ?? new Logger("livis-relayd");
    const scopeKey = IdentityStore.scopeKey(dependencies.identity);
    if (
      dependencies.config.execution.backend === "codex" &&
      (dependencies.config.security.allowAllNodes ||
        dependencies.config.security.allowedNodeIds.length !== 1)
    ) {
      throw new Error(
        "Codex backend 只支持单设备：必须关闭 allowAllNodes 并配置唯一 allowedNodeId",
      );
    }
    const store = new JobStore(join(dependencies.config.stateDir, "relay.db"), scopeKey);
    const auth = new IdaasClient(dependencies.profile, dependencies.secrets);
    let daemon!: RelayDaemon;

    const executionHandlers: ExecutionBackendHandlers = {
      onReady: (event) => daemon.onExecutionReady(event),
      onAccepted: (event) => daemon.onExecutionAccepted(event),
      onResult: (event) => daemon.onExecutionResult(event),
      onFailed: (event) => daemon.onExecutionFailed(event),
      onCancelled: (event) => daemon.onExecutionCancelled(event),
      onDisconnected: (event) => daemon.onExecutionDisconnected(event),
    };

    const connectorHandlers: ConnectorServerHandlers = {
      onReady: (hello) => executionHandlers.onReady({
        kind: "hermes",
        executionId: hello.connectorId,
        implementation: { ...hello.implementation },
      }),
      onAccepted: (message, connectorId) => executionHandlers.onAccepted({
        kind: "hermes",
        executionId: connectorId,
        jobId: message.jobId,
        leaseId: message.leaseId,
      }),
      onResult: (message, connectorId) => executionHandlers.onResult({
        kind: "hermes",
        executionId: connectorId,
        jobId: message.jobId,
        leaseId: message.leaseId,
        text: message.text,
      }),
      onFailed: (message, connectorId) => executionHandlers.onFailed({
        kind: "hermes",
        executionId: connectorId,
        jobId: message.jobId,
        leaseId: message.leaseId,
        error: message.error,
        retryable: message.retryable,
      }),
      onCancelled: (message, connectorId) => executionHandlers.onCancelled({
        kind: "hermes",
        executionId: connectorId,
        jobId: message.jobId,
        leaseId: message.leaseId,
      }),
      onDisconnected: (connectorId) => executionHandlers.onDisconnected({
        kind: "hermes",
        executionId: connectorId,
      }),
      status: () => daemon.status(),
    };
    const connector = new ConnectorServer(
      {
        socketPath: dependencies.config.connector.socketPath,
        connectorToken: dependencies.secretValues.connectorToken,
        acceptHermesConnector: dependencies.config.execution.backend === "hermes",
        helloTimeoutMs: dependencies.config.connector.helloTimeoutMs,
        resultStoreTimeoutMs: dependencies.config.connector.resultStoreTimeoutMs,
        maxFrameBytes: dependencies.config.connector.maxFrameBytes,
        daemonVersion: DAEMON_VERSION,
        hermesMinimumVersion: dependencies.config.hermes.minimumVersion,
        hermesMaximumExclusiveVersion: dependencies.config.hermes.maximumExclusiveVersion,
        bridgeImplementation: dependencies.config.hermes.bridgeImplementation,
        bridgeMinimumVersion: dependencies.config.hermes.bridgeMinimumVersion,
        bridgeMaximumExclusiveVersion: dependencies.config.hermes.bridgeMaximumExclusiveVersion,
      },
      connectorHandlers,
      logger.child("connector"),
    );
    const sessionKey = `livis:${dependencies.identity.agentId}`;
    const executionBackend: ExecutionBackend = dependencies.config.execution.backend === "codex"
      ? new CodexExecutionBackend({
        stateDir: dependencies.config.stateDir,
        scopeKey,
        sessionKey,
        remoteNodeId: dependencies.config.security.allowedNodeIds[0]!,
        command: dependencies.config.codex.command,
        model: dependencies.config.codex.model,
        maxOutputChars: dependencies.config.security.maxOutputChars,
        requestTimeoutMs: dependencies.config.codex.requestTimeoutMs,
        shutdownTimeoutMs: dependencies.config.codex.shutdownTimeoutMs,
      }, {
        store,
        handlers: executionHandlers,
        logger: logger.child("codex"),
      })
      : new HermesExecutionBackend(connector);

    const relayHandlers: RelayClientHandlers = {
      onIncoming: (envelope) => daemon.onRelayIncoming(envelope),
      onCancel: (jobId) => daemon.onRelayCancel(jobId),
      onConnected: () => daemon.onRelayConnected(),
    };
    const relay = new RelayClient(
      dependencies.config,
      dependencies.profile,
      dependencies.identity,
      dependencies.secrets,
      auth,
      store,
      relayHandlers,
      logger.child("relay"),
    );
    daemon = new RelayDaemon(
      dependencies.config,
      dependencies.profile,
      dependencies.identity,
      store,
      connector,
      executionBackend,
      relay,
      logger,
      dependencies.upstreamProofExpiresAt,
      new UpstreamChecker(),
      dependencies.testHooks,
    );
    return daemon;
  }

  async start(): Promise<void> {
    if (!this.config.security.acknowledgeUnofficialProtocol) {
      throw new Error(
        "尚未确认 LiViS 第三方兼容协议边界；请审阅文档后设置 security.acknowledgeUnofficialProtocol=true",
      );
    }
    if (this.executionBackend.kind === "codex" && !this.config.codex.acknowledgeRemoteExecution) {
      throw new Error(
        "尚未确认通过 Codex 远程执行 LiViS 请求；请审阅安全边界后设置 codex.acknowledgeRemoteExecution=true",
      );
    }
    const recovery = this.store.recoverAfterRestart();
    this.logger.info("SQLite 恢复完成", recovery);
    if (this.executionBackend.kind === "codex") {
      // Codex 不接 Hermes WS，但仍用同一私有 UDS 提供 health/status 控制面。
      this.connector.start();
    }
    await this.executionBackend.start();
    if (this.armUpstreamProofExpiry()) {
      this.relay.start();
    }
    this.upstreamTimer = setInterval(() => {
      void this.recheckUpstream().catch((error) => {
        if (!this.stopping) {
          this.logger.error("官方 upstream 周期复核异常退出", { error: errorMessage(error) });
        }
      });
    }, UPSTREAM_RECHECK_INTERVAL_MS);
    this.upstreamTimer.unref?.();
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    if (this.upstreamTimer) clearInterval(this.upstreamTimer);
    this.upstreamTimer = null;
    this.clearUpstreamProofExpiryTimer();
    const upstreamCheckPromise = this.upstreamCheckPromise;
    const upstreamBlockPromise = this.upstreamBlockPromise;
    this.stopPromise = (async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => this.executionBackend.stop()),
        ...(this.executionBackend.kind === "codex"
          ? [Promise.resolve().then(() => this.connector.stop())]
          : []),
        Promise.resolve().then(() => this.relay.stop()),
        upstreamCheckPromise ?? Promise.resolve(),
        upstreamBlockPromise ?? Promise.resolve(),
      ]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      try {
        this.store.close();
      } catch (error) {
        failures.push(error);
      }
      this.logger.info("daemon 已停止");
      if (failures.length > 0) {
        throw new AggregateError(failures, "daemon 停止期间存在未完成的清理错误");
      }
    })();
    return this.stopPromise;
  }

  status(): Record<string, unknown> {
    return {
      version: DAEMON_VERSION,
      upstream: {
        profile: this.profile.id,
        proofExpiresAt: new Date(this.upstreamProofExpiresAt).toISOString(),
        blocked: this.upstreamBlocked,
      },
      relay: this.relay.status(),
      execution: this.executionBackend.status(),
      connector: {
        ready: this.connector.ready,
        connectorId: this.connector.connectorId,
        socketPath: this.connector.socketPath,
      },
      quarantinedSessions: this.store.listQuarantinedSessions(),
      recentJobs: this.store.listRecent(20).map((job) => ({
        jobId: job.jobId,
        status: job.status,
        outboxStatus: job.outbox?.status ?? null,
        outboxNextAttemptAt: job.outbox?.nextAttemptAt ?? null,
        runGeneration: job.runGeneration,
        updatedAt: job.updatedAt,
      })),
    };
  }

  releaseSessionQuarantine(sessionKey: string): boolean {
    return this.store.releaseSessionRecovery(sessionKey);
  }

  private async onRelayIncoming(envelope: RelayEnvelope): Promise<void> {
    if (this.stopping) {
      throw new Error("daemon 正在停止，拒绝接收新 job");
    }
    if (this.isUpstreamProofExpired()) {
      await this.blockForUpstream(UPSTREAM_PROOF_EXPIRED_REASON);
      throw new Error(UPSTREAM_PROOF_EXPIRED_REASON);
    }
    if (this.upstreamBlocked) {
      const reason = this.upstreamBlocked;
      await this.blockForUpstream(reason);
      throw new Error(`upstream 门禁已关闭，拒绝接收新 job：${reason}`);
    }
    const incoming = parseIncomingRelayJob(envelope, this.config.security.maxInputChars);
    const sessionKey = `livis:${this.identity.agentId}`;
    let job: StoredJob;
    try {
      const ingested = this.store.ingest(incoming, sessionKey);
      job = ingested.job;
      if (job.status === "Received") {
        job = this.store.markAcked(job.jobId);
      }
      this.logger.info(ingested.inserted ? "LiViS job 已持久化" : "LiViS job 重复投递", {
        jobId: job.jobId,
        status: job.status,
      });
    } catch (error) {
      if (error instanceof JobConflictError) {
        this.logger.error("检测到相同 job_id 的内容冲突，保留首次内容并 ACK 当前 envelope", {
          jobId: incoming.jobId,
        });
        return;
      }
      throw error;
    }

    if (!this.isNodeAuthorized(job.fromNodeId) && ["Received", "Acked"].includes(job.status)) {
      this.store.reject(job.jobId, serializeResult(this.config.security.unauthorizedMessage), "node not authorized");
      await this.relay.notifyOutboxPending();
      return;
    }
    await this.dispatchPending();
    await this.relay.notifyOutboxPending();
  }

  private async onRelayCancel(jobId: string): Promise<void> {
    const job = this.store.requestCancel(jobId);
    if (!job) {
      this.logger.info("已持久化先到达的 cancel intent", { jobId });
      return;
    }
    if (job.status === "Cancelling" && job.leaseId) {
      let submission: Awaited<ReturnType<ExecutionBackend["cancel"]>>;
      try {
        submission = await this.executionBackend.cancel(job);
      } catch (error) {
        this.markCancellationUnknown(job, `cancel 请求异常：${errorMessage(error)}`);
        return;
      }
      if (submission === "not_sent") {
        if (this.executionBackend.kind === "codex") {
          const cancelled = this.store.finishUnsentBackendCancellation(
            job.jobId,
            this.executionBackend.kind,
            job.leaseId,
            job.runGeneration,
          );
          if (cancelled) return;
        }
        this.markCancellationUnknown(
          job,
          this.executionBackend.kind === "hermes"
            ? "cancel could not be delivered to connector"
            : "cancel could not be delivered to Codex app-server",
        );
      }
    }
  }

  private async onRelayConnected(): Promise<void> {
    // RelayClient.connectOnce() 会 await 此回调；这里不能反向 await
    // relay.stop()（stop 又会等待 connectOnce 所属的 runPromise）。门禁仍
    // 同步设置并立即发起 stop，只把“等待完全停止”留给回调之外的调用者。
    await this.dispatchPending(false);
  }

  private async onExecutionReady(event: ExecutionReadyEvent): Promise<void> {
    this.assertConfiguredBackend(event.kind);
    await this.dispatchPending();
  }

  private async onExecutionAccepted(event: ExecutionAcceptedEvent): Promise<void> {
    this.assertConfiguredBackend(event.kind);
    if (event.kind === "codex") {
      const { runGeneration, turnId } = this.requireCodexTurn(event);
      const job = this.store.markBackendRunning(
        event.jobId,
        event.kind,
        event.leaseId,
        runGeneration,
        turnId,
      );
      if (!job) {
        const current = this.store.get(event.jobId);
        if (
          current?.status === "Cancelling" &&
          current.leaseId === event.leaseId &&
          current.runGeneration === runGeneration
        ) {
          const quarantined = this.store.markBackendCancelUnknown(
            event.jobId,
            event.kind,
            event.leaseId,
            runGeneration,
            turnId,
            "cancel 与 Codex turn/start 并发；interrupt 只能证明请求已接受",
          );
          if (quarantined) return;
        }
        throw new Error(`Codex accepted 使用了失效 attempt：${event.jobId}`);
      }
      return;
    }
    const job = this.store.markRunning(event.jobId, event.executionId, event.leaseId);
    if (job.status !== "Running" || job.leaseId !== event.leaseId) {
      this.rejectHermesEvent(event.jobId, "stale_lease", "accepted 使用了失效 lease");
    }
  }

  private async onExecutionResult(event: ExecutionResultEvent): Promise<void> {
    this.assertConfiguredBackend(event.kind);
    if (event.text.length > this.config.security.maxOutputChars) {
      if (event.kind === "hermes") {
        this.rejectHermesEvent(event.jobId, "output_too_large", "Hermes 输出超过 daemon 上限");
        return;
      }
      const { runGeneration, turnId } = this.requireCodexTurn(event);
      const failed = this.store.finishBackendFailure(
        event.jobId,
        event.kind,
        event.leaseId,
        runGeneration,
        turnId,
        serializeResult("Codex 输出超过 daemon 上限，已拒绝返回。"),
        "Codex output exceeded daemon maxOutputChars",
      );
      if (!failed) throw new Error(`Codex 超限结果未能按当前 attempt 结算：${event.jobId}`);
      await this.relay.notifyOutboxPending();
      this.deferDispatchPending();
      return;
    }
    const resultJson = serializeResult(event.text);
    const before = this.store.get(event.jobId);
    if (!before || before.leaseId !== event.leaseId) {
      if (event.kind === "hermes") {
        this.rejectHermesEvent(event.jobId, "stale_lease", "result 使用了失效 lease");
        return;
      }
      throw new Error(`Codex result 使用了失效 lease：${event.jobId}`);
    }
    if (before.cancelRequested) {
      if (event.kind === "hermes") {
        this.rejectHermesEvent(event.jobId, "cancel_superseded", "cancel 已获胜，final result 被丢弃");
        return;
      }
      throw new Error(`Codex result 到达时 cancel 已获胜：${event.jobId}`);
    }
    if (event.kind === "codex") {
      const { runGeneration, turnId } = this.requireCodexTurn(event);
      const job = this.store.finishBackendSuccess(
        event.jobId,
        event.kind,
        event.leaseId,
        runGeneration,
        turnId,
        resultJson,
      );
      if (!job) throw new Error(`Codex result 未能按当前 attempt 结算：${event.jobId}`);
      await this.relay.notifyOutboxPending();
      this.deferDispatchPending();
      return;
    }
    const job = this.store.finishSuccess(event.jobId, event.leaseId, resultJson);
    if (job.outbox?.resultJson !== resultJson) {
      this.rejectHermesEvent(event.jobId, "result_conflict", "同一 job 收到不同 final result");
      return;
    }
    this.acknowledgeHermesResult(event.jobId, event.leaseId);
    await this.relay.notifyOutboxPending();
    await this.dispatchPending();
  }

  private async onExecutionFailed(event: ExecutionFailedEvent): Promise<void> {
    this.assertConfiguredBackend(event.kind);
    const before = this.store.get(event.jobId);
    if (!before || before.leaseId !== event.leaseId) {
      if (event.kind === "hermes") {
        this.rejectHermesEvent(event.jobId, "stale_lease", "failed 使用了失效 lease");
        return;
      }
      throw new Error(`Codex failed 使用了失效 lease：${event.jobId}`);
    }
    if (before.cancelRequested) {
      if (event.kind === "hermes") {
        this.rejectHermesEvent(event.jobId, "cancel_superseded", "cancel 已获胜，failed 上报被丢弃");
        return;
      }
      throw new Error(`Codex failed 到达时 cancel 已获胜：${event.jobId}`);
    }
    const userMessage = event.kind === "hermes"
      ? "Hermes 暂时无法完成该请求，请稍后重试。"
      : "Codex 暂时无法完成该请求，请稍后重试。";
    if (event.kind === "codex") {
      const { runGeneration, turnId } = this.requireCodexTurn(event);
      const job = this.store.finishBackendFailure(
        event.jobId,
        event.kind,
        event.leaseId,
        runGeneration,
        turnId,
        serializeResult(userMessage),
        event.error,
      );
      if (!job) throw new Error(`Codex failed 未能按当前 attempt 结算：${event.jobId}`);
      await this.relay.notifyOutboxPending();
      this.deferDispatchPending();
      return;
    }
    const job = this.store.finishFailure(event.jobId, event.leaseId, serializeResult(userMessage), event.error);
    if (job.outbox) {
      this.acknowledgeHermesResult(event.jobId, event.leaseId);
      await this.relay.notifyOutboxPending();
    }
    await this.dispatchPending();
  }

  private async onExecutionCancelled(event: ExecutionCancelledEvent): Promise<void> {
    this.assertConfiguredBackend(event.kind);
    const before = this.store.get(event.jobId);
    if (!before || before.leaseId !== event.leaseId) {
      return;
    }
    if (event.kind === "codex") {
      const runGeneration = this.requireCodexRunGeneration(event);
      this.store.markBackendCancelUnknown(
        event.jobId,
        event.kind,
        event.leaseId,
        runGeneration,
        event.turnId ?? null,
        "Codex turn/interrupt 已接受，但无法证明工具副作用已经停止",
      );
      return;
    }
    this.store.markCancelUnknown(event.jobId, event.leaseId, "Hermes /stop 已发出，但一期无法证明所有工具线程已经退出");
  }

  private async onExecutionDisconnected(event: ExecutionDisconnectedEvent): Promise<void> {
    this.assertConfiguredBackend(event.kind);
    let affected = 0;
    if (event.kind === "hermes") {
      affected = this.store.markConnectorDisconnected(event.executionId);
    } else {
      affected = this.store.markBackendDisconnected(
        event.kind,
        event.executionId,
        event.reason ?? "Codex app-server disconnected during active execution",
      );
    }
    if (affected > 0) {
      this.logger.warn("execution backend 断开导致 session 隔离", {
        kind: event.kind,
        executionId: event.executionId,
        affected,
      });
    }
  }

  private async dispatchPending(waitForRelayStop = true): Promise<void> {
    if (this.stopping) return;
    if (this.isUpstreamProofExpired()) {
      await this.beginUpstreamBlock(UPSTREAM_PROOF_EXPIRED_REASON, waitForRelayStop);
      return;
    }
    if (this.upstreamBlocked) {
      await this.beginUpstreamBlock(this.upstreamBlocked, waitForRelayStop);
      return;
    }
    if (!this.executionBackend.ready || !this.executionBackend.executionId) return;
    for (const candidate of this.store.listDispatchable()) {
      if (this.isUpstreamProofExpired()) {
        await this.beginUpstreamBlock(UPSTREAM_PROOF_EXPIRED_REASON, waitForRelayStop);
        return;
      }
      if (!this.isNodeAuthorized(candidate.fromNodeId)) {
        this.store.reject(
          candidate.jobId,
          serializeResult(this.config.security.unauthorizedMessage),
          "node not authorized",
        );
        await this.relay.notifyOutboxPending();
        continue;
      }
      const leaseId = crypto.randomUUID();
      const executionId = this.executionBackend.executionId;
      if (!executionId) break;
      const claimed = this.executionBackend.kind === "codex"
        ? this.store.claimForBackendDispatch(candidate.jobId, this.executionBackend.kind, executionId, leaseId)
        : this.store.claimForDispatch(candidate.jobId, executionId, leaseId);
      if (!claimed) continue;
      if (this.isUpstreamProofExpired()) {
        this.resetUnsentExecution(claimed);
        await this.beginUpstreamBlock(UPSTREAM_PROOF_EXPIRED_REASON, waitForRelayStop);
        return;
      }
      const submission = await this.executionBackend.dispatch(claimed);
      if (submission === "not_sent") {
        this.resetUnsentExecution(claimed);
        break;
      }
    }
  }

  private resetUnsentExecution(job: StoredJob): void {
    if (!job.leaseId) throw new Error(`待 reset 的 execution 缺少 lease：${job.jobId}`);
    if (this.executionBackend.kind === "codex") {
      const current = this.store.get(job.jobId);
      if (current?.status === "Cancelling") {
        const cancelled = this.store.finishUnsentBackendCancellation(
          job.jobId,
          this.executionBackend.kind,
          job.leaseId,
          job.runGeneration,
        );
        if (!cancelled) throw new Error(`Codex 未发送 cancel attempt 无法安全结算：${job.jobId}`);
        return;
      }
      if (current?.status !== "Dispatching") {
        // 并发 cancel/disconnect 已经完成更严格的终态迁移，不得回退。
        return;
      }
      const reset = this.store.resetUnsentBackendDispatch(
        job.jobId,
        this.executionBackend.kind,
        job.leaseId,
        job.runGeneration,
      );
      if (!reset) throw new Error(`Codex 未发送 attempt 无法安全 reset：${job.jobId}`);
      return;
    }
    this.store.resetUnsentDispatch(job.jobId, job.leaseId);
  }

  private assertConfiguredBackend(kind: ExecutionBackend["kind"]): void {
    if (kind !== this.executionBackend.kind) {
      throw new Error(`收到非当前 execution backend 的事件：${kind}`);
    }
  }

  private requireCodexRunGeneration(event: {
    jobId: string;
    runGeneration?: number;
  }): number {
    if (!Number.isSafeInteger(event.runGeneration) || (event.runGeneration ?? 0) < 1) {
      throw new Error(`Codex 事件缺少有效 runGeneration：${event.jobId}`);
    }
    return event.runGeneration!;
  }

  private requireCodexTurn(event: {
    jobId: string;
    runGeneration?: number;
    turnId?: string | null;
  }): { runGeneration: number; turnId: string } {
    const runGeneration = this.requireCodexRunGeneration(event);
    if (typeof event.turnId !== "string" || event.turnId.length === 0) {
      throw new Error(`Codex 事件缺少有效 turnId：${event.jobId}`);
    }
    return { runGeneration, turnId: event.turnId };
  }

  private acknowledgeHermesResult(jobId: string, leaseId: string): void {
    if (!(this.executionBackend instanceof HermesExecutionBackend)) {
      throw new Error("非 Hermes backend 不支持 connector result ACK");
    }
    this.executionBackend.acknowledgeResult(jobId, leaseId);
  }

  private rejectHermesEvent(jobId: string, code: string, message: string): void {
    if (!(this.executionBackend instanceof HermesExecutionBackend)) {
      throw new Error("非 Hermes backend 不支持 connector 结构化拒绝");
    }
    this.executionBackend.rejectJobMessage(jobId, code, message);
  }

  private markCancellationUnknown(job: StoredJob, reason: string): void {
    if (!job.leaseId) return;
    if (this.executionBackend.kind === "hermes") {
      this.store.markCancelUnknown(job.jobId, job.leaseId, reason);
      return;
    }
    const session = this.store.getBackendSession(this.executionBackend.kind, job.sessionKey);
    this.store.markBackendCancelUnknown(
      job.jobId,
      this.executionBackend.kind,
      job.leaseId,
      job.runGeneration,
      session?.activeTurnId ?? null,
      reason,
    );
  }

  private deferDispatchPending(): void {
    const timer = setTimeout(() => {
      void this.dispatchPending().catch((error) => {
        if (!this.stopping) {
          this.logger.error("terminal 结算后的延迟派发失败", { error: errorMessage(error) });
        }
      });
    }, 0);
    timer.unref?.();
  }

  private isNodeAuthorized(nodeId: string): boolean {
    return this.config.security.allowAllNodes || this.config.security.allowedNodeIds.includes(nodeId);
  }

  private recheckUpstream(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.upstreamCheckPromise) return this.upstreamCheckPromise;
    let running!: Promise<void>;
    running = this.runUpstreamRecheck().finally(() => {
      if (this.upstreamCheckPromise === running) {
        this.upstreamCheckPromise = null;
      }
    });
    this.upstreamCheckPromise = running;
    return running;
  }

  private async runUpstreamRecheck(): Promise<void> {
    let guardReleaseFailed = false;
    let upstreamStopAttempted = false;
    const stopForUpstream = (reason: string): Promise<void> => {
      upstreamStopAttempted = true;
      return this.blockForUpstream(reason);
    };
    try {
      let guard: ProfileOperationGuard;
      try {
        guard = await ProfileOperationGuard.acquire(this.config.stateDir, "upstream-check");
      } catch (error) {
        if (this.stopping) return;
        if (error instanceof ProfileOperationGuardBusyError) {
          if (this.isUpstreamProofExpired()) {
            await stopForUpstream(
              "profile operation guard 被占用且 supported proof 已过期",
            );
            return;
          }
          if (this.upstreamBlocked && !this.upstreamRelayStopped) {
            await stopForUpstream(this.upstreamBlocked);
          }
          this.logger.info("官方 upstream 周期复核因 profile operation guard 被占用而跳过", {
            guardPath: error.path,
            proofExpiresAt: new Date(this.upstreamProofExpiresAt).toISOString(),
          });
          return;
        }
        throw error;
      }
      let workFailed = false;
      let workError: unknown;
      try {
        if (this.stopping) return;
        if (this.upstreamBlocked && !this.upstreamRelayStopped) {
          await stopForUpstream(this.upstreamBlocked);
          if (this.stopping) return;
        }
        const snapshot = await this.upstreamChecker.check(this.profile, [this.profile]);
        if (this.stopping) return;
        if (snapshot.compatibility !== "supported") {
          await stopForUpstream(`官方 upstream 兼容状态变为 ${snapshot.compatibility}`);
          return;
        }
        const saved = await saveSupportedProof({
          stateDir: this.config.stateDir,
          profile: this.profile,
          profileSha256: this.config.profileSha256,
          snapshot,
          now: this.now(),
        }, guard);
        if (this.stopping) return;
        this.upstreamProofExpiresAt = Date.parse(saved.proof.expiresAt);
        if (!this.armUpstreamProofExpiry()) return;
        if (this.upstreamBlocked) {
          // 门禁关闭可能只是 CDN 抖动导致复核失败；恢复 supported 后自动
          // 解除，避免必须重启进程。
          const reason = this.upstreamBlocked;
          // expiry timer 可能正在停止 relay；等待同一 stop 完成后再清门禁，
          // 避免 stop/start 交错后留下已解锁但未运行的 client。
          await stopForUpstream(reason);
          if (this.stopping) return;
          if (this.isUpstreamProofExpired()) {
            this.clearUpstreamProofExpiryTimer();
            this.upstreamBlocked = UPSTREAM_PROOF_EXPIRED_REASON;
            this.logger.error("在线复核生成的新 proof 在 relay 停止期间已过期，保持 upstream 门禁关闭", {
              expiresAt: new Date(this.upstreamProofExpiresAt).toISOString(),
            });
            return;
          }
          this.upstreamBlocked = null;
          this.upstreamRelayStopped = false;
          this.logger.info("官方 upstream 门禁恢复，重新连接 LiViS relay", { previousReason: reason });
          this.relay.start();
          await this.dispatchPending();
          if (this.stopping) return;
        }
        this.logger.info("官方 upstream 周期复核通过", {
          profile: this.profile.id,
          expiresAt: saved.proof.expiresAt,
        });
      } catch (error) {
        workFailed = true;
        workError = error;
        throw error;
      } finally {
        try {
          await guard.release();
        } catch (releaseError) {
          guardReleaseFailed = true;
          if (workFailed) {
            throw new AggregateError(
              [workError, releaseError],
              "daemon upstream 复核失败且 ProfileOperationGuard 无法释放",
              { cause: workError },
            );
          }
          throw releaseError;
        }
      }
    } catch (error) {
      if (this.stopping) {
        if (guardReleaseFailed) throw error;
        return;
      }
      if (this.upstreamBlocked) {
        if (!upstreamStopAttempted && !this.upstreamRelayStopped) {
          try {
            await stopForUpstream(this.upstreamBlocked);
          } catch (stopError) {
            this.logger.warn("官方 upstream 门禁保持关闭，复核与 relay 停止均失败", {
              error: errorMessage(error),
              stopError: errorMessage(stopError),
            });
            return;
          }
        }
        this.logger.warn("官方 upstream 门禁保持关闭，复核仍失败", { error: errorMessage(error) });
      } else if (this.isUpstreamProofExpired()) {
        await stopForUpstream(`在线复核失败且 supported proof 已过期：${errorMessage(error)}`);
      } else {
        this.logger.warn("官方 upstream 周期复核失败，暂用未过期证明", {
          error: errorMessage(error),
          proofExpiresAt: new Date(this.upstreamProofExpiresAt).toISOString(),
        });
      }
    }
  }

  private now(): number {
    return this.testHooks?.now?.() ?? Date.now();
  }

  private isUpstreamProofExpired(now = this.now()): boolean {
    return !Number.isFinite(this.upstreamProofExpiresAt) || now >= this.upstreamProofExpiresAt;
  }

  private clearUpstreamProofExpiryTimer(): void {
    if (this.upstreamExpiryTimer) {
      if (this.testHooks?.clearProofExpiryTimer) {
        this.testHooks.clearProofExpiryTimer(this.upstreamExpiryTimer);
      } else {
        clearTimeout(this.upstreamExpiryTimer);
      }
    }
    this.upstreamExpiryTimer = null;
  }

  private armUpstreamProofExpiry(): boolean {
    this.clearUpstreamProofExpiryTimer();
    if (this.stopping) return false;
    const delayMs = this.upstreamProofExpiresAt - this.now();
    if (!Number.isFinite(delayMs) || delayMs <= 0) {
      void this.blockForUpstream(UPSTREAM_PROOF_EXPIRED_REASON).catch((error) => {
        if (!this.stopping) {
          this.logger.error("supported proof 到期关闭 relay 失败", { error: errorMessage(error) });
        }
      });
      return false;
    }
    const onExpired = () => {
      this.upstreamExpiryTimer = null;
      void this.blockForUpstream(UPSTREAM_PROOF_EXPIRED_REASON).catch((error) => {
        if (!this.stopping) {
          this.logger.error("supported proof 到期关闭 relay 失败", { error: errorMessage(error) });
        }
      });
    };
    this.upstreamExpiryTimer = this.testHooks?.setProofExpiryTimer
      ? this.testHooks.setProofExpiryTimer(onExpired, delayMs)
      : setTimeout(onExpired, delayMs);
    this.upstreamExpiryTimer.unref?.();
    return true;
  }

  private async beginUpstreamBlock(reason: string, waitForRelayStop: boolean): Promise<void> {
    const stopping = this.blockForUpstream(reason);
    if (waitForRelayStop) {
      await stopping;
      return;
    }
    void stopping.catch((error) => {
      if (!this.stopping) {
        this.logger.error("连接回调发起 upstream 门禁后停止 relay 失败", {
          error: errorMessage(error),
        });
      }
    });
  }

  private blockForUpstream(reason: string): Promise<void> {
    if (!this.upstreamBlocked) {
      this.upstreamBlocked = reason;
      this.upstreamRelayStopped = false;
      this.clearUpstreamProofExpiryTimer();
      this.logger.error("官方 upstream 门禁关闭：停止新 job 并断开 LiViS relay", { reason });
    }
    if (this.upstreamBlockPromise) return this.upstreamBlockPromise;
    if (this.upstreamRelayStopped) return Promise.resolve();

    let blocking: Promise<void>;
    try {
      blocking = Promise.resolve(this.relay.stop());
    } catch (error) {
      blocking = Promise.reject(error);
    }
    let tracked!: Promise<void>;
    tracked = blocking.then(
      () => {
        if (this.upstreamBlockPromise === tracked) {
          this.upstreamRelayStopped = true;
          this.upstreamBlockPromise = null;
        }
      },
      (error) => {
        if (this.upstreamBlockPromise === tracked) {
          this.upstreamBlockPromise = null;
        }
        throw error;
      },
    );
    this.upstreamBlockPromise = tracked;
    return tracked;
  }
}
