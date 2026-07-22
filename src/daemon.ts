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
import {
  ProfileOperationGuard,
  ProfileOperationGuardBusyError,
} from "./state/offline-guard.ts";
import type { ConnectorHello, ConnectorInboundMessage, RelayEnvelope, StoredJob } from "./types.ts";
import { UpstreamChecker } from "./upstream/checker.ts";
import { saveSupportedProof } from "./upstream/proof.ts";

export const DAEMON_VERSION = "0.1.1";
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
    private readonly relay: RelayClient,
    private readonly logger: Logger,
    private upstreamProofExpiresAt: number,
    private readonly upstreamChecker: UpstreamChecker,
    private readonly testHooks?: RelayDaemonTestHooks,
  ) {}

  static create(dependencies: RelayDaemonDependencies): RelayDaemon {
    const logger = dependencies.logger ?? new Logger("livis-relayd");
    const scopeKey = IdentityStore.scopeKey(dependencies.identity);
    const store = new JobStore(join(dependencies.config.stateDir, "relay.db"), scopeKey);
    const auth = new IdaasClient(dependencies.profile, dependencies.secrets);
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
    const connector = new ConnectorServer(
      {
        socketPath: dependencies.config.connector.socketPath,
        connectorToken: dependencies.secretValues.connectorToken,
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
      new UpstreamChecker(),
      dependencies.testHooks,
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
        Promise.resolve().then(() => this.connector.stop()),
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
    return this.store.releaseSessionQuarantine(sessionKey);
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
      if (!this.connector.sendCancel(job)) {
        this.store.markCancelUnknown(job.jobId, job.leaseId, "cancel could not be delivered to connector");
      }
    }
  }

  private async onRelayConnected(): Promise<void> {
    // RelayClient.connectOnce() 会 await 此回调；这里不能反向 await
    // relay.stop()（stop 又会等待 connectOnce 所属的 runPromise）。门禁仍
    // 同步设置并立即发起 stop，只把“等待完全停止”留给回调之外的调用者。
    await this.dispatchPending(false);
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
      this.connector.rejectJobMessage(message.jobId, "stale_lease", "accepted 使用了失效 lease");
    }
  }

  private async onConnectorResult(
    message: Extract<ConnectorInboundMessage, { type: "result" }>,
    _connectorId: string,
  ): Promise<void> {
    if (message.text.length > this.config.security.maxOutputChars) {
      this.connector.rejectJobMessage(message.jobId, "output_too_large", "Hermes 输出超过 daemon 上限");
      return;
    }
    const resultJson = serializeResult(message.text);
    const before = this.store.get(message.jobId);
    if (!before || before.leaseId !== message.leaseId) {
      this.connector.rejectJobMessage(message.jobId, "stale_lease", "result 使用了失效 lease");
      return;
    }
    if (before.cancelRequested) {
      this.connector.rejectJobMessage(message.jobId, "cancel_superseded", "cancel 已获胜，final result 被丢弃");
      return;
    }
    const job = this.store.finishSuccess(message.jobId, message.leaseId, resultJson);
    if (job.outbox?.resultJson !== resultJson) {
      this.connector.rejectJobMessage(message.jobId, "result_conflict", "同一 job 收到不同 final result");
      return;
    }
    this.connector.acknowledgeResult(message.jobId, message.leaseId);
    await this.relay.notifyOutboxPending();
    await this.dispatchPending();
  }

  private async onConnectorFailed(
    message: Extract<ConnectorInboundMessage, { type: "failed" }>,
    _connectorId: string,
  ): Promise<void> {
    const before = this.store.get(message.jobId);
    if (!before || before.leaseId !== message.leaseId) {
      this.connector.rejectJobMessage(message.jobId, "stale_lease", "failed 使用了失效 lease");
      return;
    }
    if (before.cancelRequested) {
      this.connector.rejectJobMessage(message.jobId, "cancel_superseded", "cancel 已获胜，failed 上报被丢弃");
      return;
    }
    const userMessage = "Hermes 暂时无法完成该请求，请稍后重试。";
    const job = this.store.finishFailure(message.jobId, message.leaseId, serializeResult(userMessage), message.error);
    if (job.outbox) {
      this.connector.acknowledgeResult(message.jobId, message.leaseId);
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
    if (!this.connector.ready) return;
    for (const candidate of this.store.listDispatchable()) {
      if (this.isUpstreamProofExpired()) {
        await this.beginUpstreamBlock(UPSTREAM_PROOF_EXPIRED_REASON, waitForRelayStop);
        return;
      }
      const leaseId = crypto.randomUUID();
      const claimed = this.store.claimForDispatch(candidate.jobId, this.connector.connectorId!, leaseId);
      if (!claimed) continue;
      if (this.isUpstreamProofExpired()) {
        this.store.resetUnsentDispatch(claimed.jobId, leaseId);
        await this.beginUpstreamBlock(UPSTREAM_PROOF_EXPIRED_REASON, waitForRelayStop);
        return;
      }
      if (!this.connector.sendJob(claimed)) {
        this.store.resetUnsentDispatch(claimed.jobId, leaseId);
        break;
      }
    }
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
