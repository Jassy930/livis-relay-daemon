import { join } from "node:path";
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
import type { ConnectorHello, ConnectorInboundMessage, RelayEnvelope, StoredJob } from "./types.ts";
import { UpstreamChecker } from "./upstream/checker.ts";
import { saveSupportedProof } from "./upstream/proof.ts";

export const DAEMON_VERSION = "0.1.0";
const UPSTREAM_RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface RelayDaemonDependencies {
  config: RelayConfig;
  profile: ProtocolProfile;
  identity: RelayIdentity;
  secrets: SecretStore;
  secretValues: RelaySecrets;
  upstreamProofExpiresAt: number;
  logger?: Logger;
  auth?: IdaasClient;
  upstreamChecker?: UpstreamChecker;
  upstreamRecheckIntervalMs?: number;
}

export class RelayDaemon {
  private stopping = false;
  private upstreamTimer: ReturnType<typeof setInterval> | null = null;
  private upstreamCheckRunning = false;
  private upstreamBlocked: string | null = null;

  private constructor(
    private readonly config: RelayConfig,
    private readonly profile: ProtocolProfile,
    private readonly identity: RelayIdentity,
    private readonly store: JobStore,
    private readonly connector: ConnectorServer,
    private readonly relay: RelayClient,
    private readonly logger: Logger,
    private upstreamProofExpiresAt: number,
    private readonly upstreamChecker: UpstreamChecker,
    private readonly upstreamRecheckIntervalMs: number,
  ) {}

  static create(dependencies: RelayDaemonDependencies): RelayDaemon {
    const logger = dependencies.logger ?? new Logger("livis-relayd");
    const scopeKey = IdentityStore.scopeKey(dependencies.identity);
    const store = new JobStore(join(dependencies.config.stateDir, "relay.db"), scopeKey);
    const auth = dependencies.auth ?? new IdaasClient(dependencies.profile, dependencies.secrets);
    let daemon!: RelayDaemon;

    const connectorHandlers: ConnectorServerHandlers = {
      onReady: (hello) => daemon.onConnectorReady(hello),
      onAccepted: (message, connectorId) => daemon.onConnectorAccepted(message, connectorId),
      onResult: (message, connectorId) => daemon.onConnectorResult(message, connectorId),
      onFailed: (message, connectorId) => daemon.onConnectorFailed(message, connectorId),
      onCancelled: (message, connectorId) => daemon.onConnectorCancelled(message, connectorId),
      onDisconnected: (connectorId) => daemon.onConnectorDisconnected(connectorId),
      status: () => daemon.status(),
    };
    // 一期注册表只有 hermes 一个后端；将来接入其他 agent 时在这里追加
    // spec，并通过 config.routing 决定消息去向。
    const backends = [{
      backend: "hermes",
      implementation: dependencies.config.hermes.bridgeImplementation,
      bridgeMinimumVersion: dependencies.config.hermes.bridgeMinimumVersion,
      bridgeMaximumExclusiveVersion: dependencies.config.hermes.bridgeMaximumExclusiveVersion,
      runtimeMinimumVersion: dependencies.config.hermes.minimumVersion,
      runtimeMaximumExclusiveVersion: dependencies.config.hermes.maximumExclusiveVersion,
    }];
    const backendNames = new Set(backends.map((spec) => spec.backend));
    if (!backendNames.has(dependencies.config.routing.defaultBackend)) {
      throw new Error(`config.routing.defaultBackend 未注册：${dependencies.config.routing.defaultBackend}`);
    }
    for (const [nodeId, backend] of Object.entries(dependencies.config.routing.nodeBackends)) {
      if (!backendNames.has(backend)) {
        throw new Error(`config.routing.nodeBackends.${nodeId} 指向未注册的 backend：${backend}`);
      }
    }
    const connector = new ConnectorServer(
      {
        socketPath: dependencies.config.connector.socketPath,
        connectorToken: dependencies.secretValues.connectorToken,
        helloTimeoutMs: dependencies.config.connector.helloTimeoutMs,
        resultStoreTimeoutMs: dependencies.config.connector.resultStoreTimeoutMs,
        maxFrameBytes: dependencies.config.connector.maxFrameBytes,
        daemonVersion: DAEMON_VERSION,
        backends,
      },
      connectorHandlers,
      logger.child("connector"),
    );

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
      relay,
      logger,
      dependencies.upstreamProofExpiresAt,
      dependencies.upstreamChecker ?? new UpstreamChecker(),
      dependencies.upstreamRecheckIntervalMs ?? UPSTREAM_RECHECK_INTERVAL_MS,
    );
    return daemon;
  }

  start(): void {
    if (!this.config.security.acknowledgeUnofficialProtocol) {
      throw new Error(
        "尚未确认 LiViS 第三方兼容协议边界；请审阅文档后设置 security.acknowledgeUnofficialProtocol=true",
      );
    }
    const recovery = this.store.recoverAfterRestart();
    this.logger.info("SQLite 恢复完成", recovery);
    this.connector.start();
    this.relay.start();
    this.upstreamTimer = setInterval(() => {
      void this.recheckUpstream();
    }, this.upstreamRecheckIntervalMs);
    this.upstreamTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.upstreamTimer) clearInterval(this.upstreamTimer);
    this.upstreamTimer = null;
    this.connector.stop();
    await this.relay.stop();
    this.store.close();
    this.logger.info("daemon 已停止");
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
      connector: {
        socketPath: this.connector.socketPath,
        backends: this.connector.connectorsStatus(),
      },
      quarantinedSessions: this.store.listQuarantinedSessions(),
      recentJobs: this.store.listRecent(20).map((job) => ({
        jobId: job.jobId,
        status: job.status,
        outboxStatus: job.outbox?.status ?? null,
        runGeneration: job.runGeneration,
        updatedAt: job.updatedAt,
      })),
    };
  }

  releaseSessionQuarantine(sessionKey: string): boolean {
    return this.store.releaseSessionQuarantine(sessionKey);
  }

  private async onRelayIncoming(envelope: RelayEnvelope): Promise<void> {
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
      if (!this.connector.sendCancel(job)) {
        this.store.markCancelUnknown(job.jobId, job.leaseId, "cancel could not be delivered to connector");
      }
    }
  }

  private async onRelayConnected(): Promise<void> {
    await this.dispatchPending();
  }

  private async onConnectorReady(_hello: ConnectorHello): Promise<void> {
    await this.dispatchPending();
  }

  private async onConnectorAccepted(
    message: Extract<ConnectorInboundMessage, { type: "accepted" }>,
    connectorId: string,
  ): Promise<void> {
    const job = this.store.markRunning(message.jobId, connectorId, message.leaseId);
    if (job.status !== "Running" || job.leaseId !== message.leaseId) {
      this.connector.rejectJobMessage(message.jobId, "stale_lease", "accepted 使用了失效 lease", connectorId);
    }
  }

  private async onConnectorResult(
    message: Extract<ConnectorInboundMessage, { type: "result" }>,
    connectorId: string,
  ): Promise<void> {
    if (message.text.length > this.config.security.maxOutputChars) {
      this.connector.rejectJobMessage(message.jobId, "output_too_large", "Agent 输出超过 daemon 上限", connectorId);
      return;
    }
    const resultJson = serializeResult(message.text);
    const before = this.store.get(message.jobId);
    if (!before || before.leaseId !== message.leaseId) {
      this.connector.rejectJobMessage(message.jobId, "stale_lease", "result 使用了失效 lease", connectorId);
      return;
    }
    if (before.cancelRequested) {
      this.connector.rejectJobMessage(message.jobId, "cancel_superseded", "cancel 已获胜，final result 被丢弃", connectorId);
      return;
    }
    const job = this.store.finishSuccess(message.jobId, message.leaseId, resultJson);
    if (job.outbox?.resultJson !== resultJson) {
      this.connector.rejectJobMessage(message.jobId, "result_conflict", "同一 job 收到不同 final result", connectorId);
      return;
    }
    this.connector.acknowledgeResult(message.jobId, message.leaseId, connectorId);
    await this.relay.notifyOutboxPending();
    await this.dispatchPending();
  }

  private async onConnectorFailed(
    message: Extract<ConnectorInboundMessage, { type: "failed" }>,
    connectorId: string,
  ): Promise<void> {
    const before = this.store.get(message.jobId);
    if (!before || before.leaseId !== message.leaseId) {
      this.connector.rejectJobMessage(message.jobId, "stale_lease", "failed 使用了失效 lease", connectorId);
      return;
    }
    if (before.cancelRequested) {
      this.connector.rejectJobMessage(message.jobId, "cancel_superseded", "cancel 已获胜，failed 上报被丢弃", connectorId);
      return;
    }
    const userMessage = "Agent 暂时无法完成该请求，请稍后重试。";
    const job = this.store.finishFailure(message.jobId, message.leaseId, serializeResult(userMessage), message.error);
    if (job.outbox) {
      this.connector.acknowledgeResult(message.jobId, message.leaseId, connectorId);
      await this.relay.notifyOutboxPending();
    }
    await this.dispatchPending();
  }

  private async onConnectorCancelled(
    message: Extract<ConnectorInboundMessage, { type: "cancelled" }>,
    _connectorId: string,
  ): Promise<void> {
    const before = this.store.get(message.jobId);
    if (!before || before.leaseId !== message.leaseId) {
      return;
    }
    this.store.markCancelUnknown(
      message.jobId,
      message.leaseId,
      "Hermes /stop 已发出，但一期无法证明所有工具线程已经退出",
    );
  }

  private async onConnectorDisconnected(connectorId: string): Promise<void> {
    const affected = this.store.markConnectorDisconnected(connectorId);
    if (affected > 0) {
      this.logger.warn("connector 断开导致 session 隔离", { connectorId, affected });
    }
  }

  private async dispatchPending(): Promise<void> {
    if (this.upstreamBlocked) return;
    for (const candidate of this.store.listDispatchable()) {
      const backend = this.routeBackend(candidate);
      const connectorId = this.connector.connectorId(backend);
      if (!connectorId || !this.connector.ready(backend)) continue;
      const leaseId = crypto.randomUUID();
      const claimed = this.store.claimForDispatch(candidate.jobId, connectorId, leaseId);
      if (!claimed) continue;
      if (!this.connector.sendJob(claimed, backend)) {
        this.store.resetUnsentDispatch(claimed.jobId, leaseId);
        break;
      }
    }
  }

  private routeBackend(job: StoredJob): string {
    return this.config.routing.nodeBackends[job.fromNodeId] ?? this.config.routing.defaultBackend;
  }

  private isNodeAuthorized(nodeId: string): boolean {
    return this.config.security.allowAllNodes || this.config.security.allowedNodeIds.includes(nodeId);
  }

  private async recheckUpstream(): Promise<void> {
    if (this.stopping || this.upstreamCheckRunning) return;
    this.upstreamCheckRunning = true;
    try {
      const snapshot = await this.upstreamChecker.check(this.profile, [this.profile]);
      if (snapshot.compatibility !== "supported") {
        await this.blockForUpstream(`官方 upstream 兼容状态变为 ${snapshot.compatibility}`);
        return;
      }
      const saved = await saveSupportedProof({
        stateDir: this.config.stateDir,
        profile: this.profile,
        profileSha256: this.config.profileSha256,
        snapshot,
      });
      this.upstreamProofExpiresAt = Date.parse(saved.proof.expiresAt);
      if (this.upstreamBlocked) {
        // 门禁关闭可能只是 CDN 抖动导致复核失败；恢复 supported 后自动
        // 解除，避免必须重启进程。
        const reason = this.upstreamBlocked;
        this.upstreamBlocked = null;
        this.logger.info("官方 upstream 门禁恢复，重新连接 LiViS relay", { previousReason: reason });
        this.relay.start();
        await this.dispatchPending();
      }
      this.logger.info("官方 upstream 周期复核通过", {
        profile: this.profile.id,
        expiresAt: saved.proof.expiresAt,
      });
    } catch (error) {
      if (this.upstreamBlocked) {
        this.logger.warn("官方 upstream 门禁保持关闭，复核仍失败", { error: errorMessage(error) });
      } else if (Date.now() >= this.upstreamProofExpiresAt) {
        await this.blockForUpstream(`在线复核失败且 supported proof 已过期：${errorMessage(error)}`);
      } else {
        this.logger.warn("官方 upstream 周期复核失败，暂用未过期证明", {
          error: errorMessage(error),
          proofExpiresAt: new Date(this.upstreamProofExpiresAt).toISOString(),
        });
      }
    } finally {
      this.upstreamCheckRunning = false;
    }
  }

  private async blockForUpstream(reason: string): Promise<void> {
    if (this.upstreamBlocked) return;
    this.upstreamBlocked = reason;
    this.logger.error("官方 upstream 门禁关闭：停止新 job 并断开 LiViS relay", { reason });
    await this.relay.stop();
  }
}
