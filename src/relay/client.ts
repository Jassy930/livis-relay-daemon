import WebSocket, { type RawData } from "ws";
import type { RelayConfig } from "../config.ts";
import type { RelayIdentity } from "../identity.ts";
import type { Logger } from "../logger.ts";
import { errorMessage } from "../logger.ts";
import type { ProtocolProfile } from "../protocol/profile.ts";
import {
  buildAckEnvelope,
  buildConnectEnvelope,
  buildHeartbeatEnvelope,
  buildResultEnvelope,
  buildTokenRefreshEnvelope,
  parseIncomingRelayJob,
  parseRelayEnvelope,
  resultAckCandidates,
} from "../protocol/livis.ts";
import type { IdaasClient } from "../auth/idaas.ts";
import { TerminalAuthError } from "../auth/idaas.ts";
import type { SecretStore } from "../secrets.ts";
import type { JobStore } from "../state/store.ts";
import type { RelayEnvelope } from "../types.ts";
import { delay, withJitter } from "../util.ts";

export interface RelayClientHandlers {
  onIncoming(envelope: RelayEnvelope): Promise<void>;
  onCancel(jobId: string): Promise<void>;
  onConnected(): Promise<void>;
}

type RelayRawData = RawData | string;

export function relayFrameByteLength(data: RelayRawData): number {
  if (typeof data === "string") return Buffer.byteLength(data, "utf8");
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((total, part) => total + part.byteLength, 0);
  return data.byteLength;
}

function relayFrameText(data: RelayRawData): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}

export class RelayClient {
  private socket: WebSocket | null = null;
  private runPromise: Promise<void> | null = null;
  private abortController = new AbortController();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private tokenRefreshFailures = 0;
  private lastPongAt = 0;
  private handshakeComplete = false;
  private terminalFailure: string | null = null;
  private messageChain: Promise<void> = Promise.resolve();
  private readonly resultAckTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly config: RelayConfig,
    private readonly profile: ProtocolProfile,
    private readonly identity: RelayIdentity,
    private readonly secrets: SecretStore,
    private readonly auth: IdaasClient,
    private readonly store: JobStore,
    private readonly handlers: RelayClientHandlers,
    private readonly logger: Logger,
  ) {}

  get connected(): boolean {
    return this.handshakeComplete && this.socket?.readyState === WebSocket.OPEN;
  }

  status(): Record<string, unknown> {
    return {
      connected: this.connected,
      handshakeComplete: this.handshakeComplete,
      terminalFailure: this.terminalFailure,
      agentId: this.identity.agentId,
      deviceId: this.identity.deviceId,
      profile: this.profile.id,
    };
  }

  start(): void {
    if (this.runPromise) {
      return;
    }
    if (this.abortController.signal.aborted) {
      this.abortController = new AbortController();
    }
    this.runPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.abortController.abort(new Error("relay client stopping"));
    this.stopHeartbeat();
    this.stopTokenRefreshTimer();
    this.clearResultTimers(true);
    this.socket?.close(1000, "daemon stopping");
    await this.runPromise?.catch(() => undefined);
    this.runPromise = null;
  }

  async notifyOutboxPending(): Promise<void> {
    if (this.connected) {
      await this.replayOutbox();
    }
  }

  private async runLoop(): Promise<void> {
    let attempt = 0;
    while (!this.abortController.signal.aborted && !this.terminalFailure) {
      try {
        await this.connectOnce();
        attempt = 0;
      } catch (error) {
        if (this.abortController.signal.aborted) {
          break;
        }
        if (error instanceof TerminalAuthError) {
          this.terminalFailure = error.message;
          this.logger.error("LiViS 认证进入终止状态", { error: error.message });
          break;
        }
        attempt += 1;
        const base = Math.min(1000 * 2 ** Math.max(0, attempt - 1), this.config.relay.reconnectMaxMs);
        const waitMs = Math.max(1000, withJitter(base));
        this.logger.warn("LiViS 连接失败，将重试", { attempt, waitMs, error: errorMessage(error) });
        await delay(waitMs, this.abortController.signal).catch(() => undefined);
      }
    }
  }

  private async connectOnce(): Promise<void> {
    const accessToken = await this.auth.getAccessToken();
    const currentSecrets = await this.secrets.get();
    if (!currentSecrets.refreshToken) {
      throw new TerminalAuthError("缺少 refresh token");
    }
    const url = new URL(this.profile.endpoints.relayWebSocketUrl);
    url.searchParams.set("protocol_version", String(this.profile.wireProtocolVersion));
    const socket = new WebSocket(url, { maxPayload: this.config.relay.maxFrameBytes });
    this.socket = socket;
    this.handshakeComplete = false;
    this.messageChain = Promise.resolve();

    let resolveHandshake!: () => void;
    let rejectHandshake!: (error: Error) => void;
    const handshake = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveHandshake = resolvePromise;
      rejectHandshake = rejectPromise;
    });
    // Register the close observer before sending the handshake.  Otherwise a
    // fast stop/disconnect can close the socket after `connected` is parsed but
    // before the post-handshake close listener is installed, leaving
    // connectOnce() waiting forever for an event that already happened.
    const socketClosed = new Promise<{ code: number; reason: string }>((resolvePromise) => {
      socket.once("close", (code, reason) => {
        const text = reason.toString();
        if (!this.handshakeComplete) {
          rejectHandshake(new Error(`LiViS WebSocket 握手前断开：${code} ${text}`));
        }
        resolvePromise({ code, reason: text });
      });
    });
    const handshakeTimer = setTimeout(() => {
      rejectHandshake(new Error("LiViS connect handshake 超时"));
      socket.close(1000, "handshake timeout");
    }, this.config.relay.handshakeTimeoutMs);

    socket.on("open", () => {
      const envelope = buildConnectEnvelope({
        profile: this.profile,
        agentId: this.identity.agentId,
        deviceId: this.identity.deviceId,
        nodeName: this.config.relay.nodeName,
        accessToken,
        refreshToken: currentSecrets.refreshToken!,
      });
      socket.send(JSON.stringify(envelope));
    });
    socket.on("pong", () => {
      this.lastPongAt = Date.now();
    });
    socket.on("message", (data) => {
      const frameBytes = relayFrameByteLength(data);
      if (frameBytes > this.config.relay.maxFrameBytes) {
        this.logger.warn("LiViS 消息被拒绝", {
          error: "WebSocket frame 超过配置的字节上限",
          frameBytes,
          maxFrameBytes: this.config.relay.maxFrameBytes,
        });
        socket.close(1009, "frame too large");
        return;
      }
      const raw = relayFrameText(data);
      this.messageChain = this.messageChain
        .then(async () => {
          const envelope = parseRelayEnvelope(raw);
          // 任何能解析的服务端消息都证明链路存活；部分网关不回 WS 协议层
          // pong，只依赖 pong 会周期性误杀健康连接。
          this.lastPongAt = Date.now();
          if (envelope.type === "connected" && !this.handshakeComplete) {
            this.handshakeComplete = true;
            this.lastPongAt = Date.now();
            resolveHandshake();
            return;
          }
          await this.handleEnvelope(envelope);
        })
        .catch((error) => {
          this.logger.warn("LiViS 消息被拒绝", { error: errorMessage(error) });
        });
    });
    socket.on("error", (error) => {
      if (!this.handshakeComplete) {
        rejectHandshake(new Error(`LiViS WebSocket 错误：${error.message}`));
      }
    });

    try {
      await handshake;
      clearTimeout(handshakeTimer);
      this.startHeartbeat();
      this.logger.info("LiViS relay 已完成握手", { profile: this.profile.id });
      await this.handlers.onConnected();
      await this.replayOutbox();
      const closed = await socketClosed;
      if (!this.abortController.signal.aborted) {
        throw new Error(`LiViS WebSocket 断开：${closed.code} ${closed.reason}`);
      }
    } finally {
      clearTimeout(handshakeTimer);
      this.stopHeartbeat();
      this.stopTokenRefreshTimer();
      this.clearResultTimers(true);
      this.handshakeComplete = false;
      if (this.socket === socket) {
        this.socket = null;
      }
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }
  }

  private async handleEnvelope(envelope: RelayEnvelope): Promise<void> {
    if (!this.handshakeComplete) {
      throw new Error(`握手前收到业务消息：${envelope.type}`);
    }
    switch (envelope.type) {
      case "send_message": {
        const job = parseIncomingRelayJob(envelope, this.config.security.maxInputChars);
        await this.handlers.onIncoming(envelope);
        this.send(buildAckEnvelope(
          this.profile,
          "ack_send_message",
          job.jobId,
          this.identity.agentId,
          this.identity.deviceId,
        ));
        break;
      }
      case "cancel_chat": {
        const jobId = envelope.metadata?.job_id;
        if (typeof jobId !== "string" || jobId.trim() === "") {
          throw new Error("cancel_chat 缺少 job_id");
        }
        await this.handlers.onCancel(jobId);
        this.send(buildAckEnvelope(
          this.profile,
          "ack_cancel_chat",
          jobId,
          this.identity.agentId,
          this.identity.deviceId,
        ));
        break;
      }
      case "ack_send_result": {
        const candidates = resultAckCandidates(envelope);
        if (candidates.length === 0) {
          throw new Error("ack_send_result 缺少关联 ID");
        }
        const jobId = this.resolveAckJobId(candidates);
        if (!jobId) {
          this.logger.warn("ack_send_result 无法关联任何 outbox", { candidates });
          break;
        }
        const timer = this.resultAckTimers.get(jobId);
        if (timer) {
          clearTimeout(timer);
          this.resultAckTimers.delete(jobId);
        }
        this.store.markOutboxDelivered(jobId);
        this.logger.info("LiViS 结果已确认", { jobId });
        break;
      }
      case "token_expiring":
        await this.refreshRelayToken();
        break;
      case "token_refreshed":
        this.stopTokenRefreshTimer();
        this.tokenRefreshFailures = 0;
        break;
      case "connected":
        break;
      default:
        this.logger.warn("忽略未知 LiViS 消息类型", { type: envelope.type });
    }
  }

  private async refreshRelayToken(): Promise<void> {
    try {
      const accessToken = await this.auth.getAccessToken(true);
      const currentSecrets = await this.secrets.get();
      if (!currentSecrets.refreshToken) {
        throw new TerminalAuthError("刷新后缺少 refresh token");
      }
      this.send(buildTokenRefreshEnvelope({
        profile: this.profile,
        agentId: this.identity.agentId,
        deviceId: this.identity.deviceId,
        accessToken,
        refreshToken: currentSecrets.refreshToken,
      }));
      this.stopTokenRefreshTimer();
      this.tokenRefreshTimer = setTimeout(() => {
        this.tokenRefreshFailures += 1;
        if (this.tokenRefreshFailures >= this.profile.timing.tokenRefreshMaxFailures) {
          this.terminalFailure = "token_refresh ACK 连续失败";
          this.socket?.close(1008, "token refresh failure");
        }
      }, this.profile.timing.tokenRefreshAckTimeoutMs);
    } catch (error) {
      this.tokenRefreshFailures += 1;
      if (error instanceof TerminalAuthError || this.tokenRefreshFailures >= this.profile.timing.tokenRefreshMaxFailures) {
        this.terminalFailure = errorMessage(error);
        this.socket?.close(1008, "token refresh failure");
      }
      throw error;
    }
  }

  private async replayOutbox(): Promise<void> {
    for (const outbox of this.store.listPendingOutbox()) {
      await this.deliverResult(outbox.jobId, false);
    }
  }

  private async deliverResult(jobId: string, retry: boolean): Promise<void> {
    if (!this.connected) {
      if (retry) this.store.resetOutboxPending(jobId);
      return;
    }
    const messageId = crypto.randomUUID();
    const outbox = this.store.startResultDelivery(jobId, messageId, retry);
    if (!outbox) {
      return;
    }
    this.send(buildResultEnvelope({
      profile: this.profile,
      jobId,
      agentId: this.identity.agentId,
      deviceId: this.identity.deviceId,
      resultJson: outbox.resultJson,
      messageId,
    }));
    const previousTimer = this.resultAckTimers.get(jobId);
    if (previousTimer) clearTimeout(previousTimer);
    const timer = setTimeout(() => {
      try {
        this.resultAckTimers.delete(jobId);
        const current = this.store.get(jobId)?.outbox;
        if (!current || current.status !== "Delivering") return;
        if (!this.connected) {
          this.store.resetOutboxPending(jobId);
          return;
        }
        if (current.retryCount < this.profile.timing.resultMaxRetries) {
          void this.deliverResult(jobId, true);
        } else {
          this.store.markOutboxAckFailed(jobId);
          this.logger.error("LiViS 结果 ACK 重试耗尽", { jobId, retries: current.retryCount });
        }
      } catch (error) {
        this.logger.error("结果重试定时器处理失败", { jobId, error: errorMessage(error) });
      }
    }, this.profile.timing.resultAckTimeoutMs);
    this.resultAckTimers.set(jobId, timer);
  }

  private resolveAckJobId(candidates: string[]): string | null {
    for (const candidate of candidates) {
      if (this.store.get(candidate)) {
        return candidate;
      }
      const mapped = this.store.findJobIdByOutboxMessageId(candidate);
      if (mapped) {
        return mapped;
      }
    }
    return null;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPongAt > this.profile.timing.pongTimeoutMs) {
        socket.close(1000, "pong timeout");
        return;
      }
      socket.ping();
      this.send(buildHeartbeatEnvelope(this.profile, this.identity.agentId, this.identity.deviceId));
    }, this.profile.timing.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private stopTokenRefreshTimer(): void {
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
  }

  private clearResultTimers(resetPending: boolean): void {
    for (const [jobId, timer] of this.resultAckTimers) {
      clearTimeout(timer);
      if (resetPending) {
        this.store.resetOutboxPending(jobId);
      }
    }
    this.resultAckTimers.clear();
  }

  private send(envelope: RelayEnvelope): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`LiViS WebSocket 未连接，无法发送 ${envelope.type}`);
    }
    this.socket.send(JSON.stringify(envelope));
  }
}
