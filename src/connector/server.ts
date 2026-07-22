import type {
  ConnectorCancelMessage,
  ConnectorHello,
  ConnectorInboundMessage,
  ConnectorJobMessage,
  ConnectorOutboundMessage,
  StoredJob,
} from "../types.ts";
import { CONNECTOR_PROTOCOL_VERSION } from "../types.ts";
import type { Logger } from "../logger.ts";
import { errorMessage } from "../logger.ts";
import {
  parseJsonObject,
  parseSemverTriplet,
  safeEqual,
  versionAtLeast,
  versionLessThan,
} from "../util.ts";
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;

interface ConnectorSocketData {
  authenticated: true;
  connectorId: string | null;
  backend: "hermes" | null;
  ready: boolean;
  lastPongAt: number;
  generation: number;
  disconnectHandled: boolean;
}

export interface ConnectorServerHandlers {
  onReady(hello: ConnectorHello): Promise<void>;
  onAccepted(message: Extract<ConnectorInboundMessage, { type: "accepted" }>, connectorId: string): Promise<void>;
  onResult(message: Extract<ConnectorInboundMessage, { type: "result" }>, connectorId: string): Promise<void>;
  onFailed(message: Extract<ConnectorInboundMessage, { type: "failed" }>, connectorId: string): Promise<void>;
  onCancelled(message: Extract<ConnectorInboundMessage, { type: "cancelled" }>, connectorId: string): Promise<void>;
  onDisconnected(connectorId: string): Promise<void>;
  status(): Record<string, unknown>;
}

export interface ConnectorServerOptions {
  socketPath: string;
  connectorToken: string;
  /**
   * 缺省保持 Hermes connector v1 路由开启。Codex 等 daemon-owned backend
   * 仍可复用同一 UDS 的 health/status 控制面，同时明确关闭 Hermes WS。
   */
  acceptHermesConnector?: boolean;
  helloTimeoutMs: number;
  resultStoreTimeoutMs: number;
  maxFrameBytes: number;
  daemonVersion: string;
  hermesMinimumVersion: string;
  hermesMaximumExclusiveVersion: string;
  bridgeImplementation: string;
  bridgeMinimumVersion: string;
  bridgeMaximumExclusiveVersion: string;
}

function parseConnectorMessage(raw: string): ConnectorInboundMessage {
  const data = parseJsonObject(raw, "connector message");
  if (typeof data.type !== "string") {
    throw new Error("connector message.type 缺失");
  }
  if (data.type === "hello") {
    if (
      data.protocolVersion !== CONNECTOR_PROTOCOL_VERSION ||
      typeof data.connectorId !== "string" ||
      data.connectorId.trim() === "" ||
      data.backend !== "hermes" ||
      data.implementation === null ||
      typeof data.implementation !== "object" ||
      data.capabilities === null ||
      typeof data.capabilities !== "object"
    ) {
      throw new Error("connector hello 不兼容或字段不完整");
    }
    const implementation = data.implementation as Record<string, unknown>;
    const capabilities = data.capabilities as Record<string, unknown>;
    if (
      typeof implementation.name !== "string" ||
      typeof implementation.version !== "string" ||
      typeof implementation.runtimeVersion !== "string" ||
      capabilities.cancel !== true ||
      capabilities.finalResult !== true
    ) {
      throw new Error("connector hello capability 不满足一期要求");
    }
    return data as unknown as ConnectorHello;
  }
  if (["accepted", "result", "failed", "cancelled"].includes(data.type)) {
    if (typeof data.jobId !== "string" || data.jobId === "" || typeof data.leaseId !== "string" || data.leaseId === "") {
      throw new Error(`${data.type} 缺少 jobId/leaseId`);
    }
    if (data.type === "result" && typeof data.text !== "string") {
      throw new Error("result.text 必须是字符串");
    }
    if (data.type === "failed" && typeof data.error !== "string") {
      throw new Error("failed.error 必须是字符串");
    }
    return data as unknown as ConnectorInboundMessage;
  }
  if (data.type === "pong") {
    return data as unknown as ConnectorInboundMessage;
  }
  throw new Error(`未知 connector 消息类型：${data.type}`);
}

export class ConnectorServer {
  private server: Bun.Server<ConnectorSocketData> | null = null;
  private activeSocket: Bun.ServerWebSocket<ConnectorSocketData> | null = null;
  private activeGeneration = 0;
  private nextGeneration = 0;
  private transitionChain: Promise<void> = Promise.resolve();
  private readonly helloTimers = new Map<Bun.ServerWebSocket<ConnectorSocketData>, ReturnType<typeof setTimeout>>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly options: ConnectorServerOptions,
    private readonly handlers: ConnectorServerHandlers,
    private readonly logger: Logger,
  ) {}

  get socketPath(): string {
    return this.options.socketPath;
  }

  get connectorId(): string | null {
    return this.currentSocket()?.data.connectorId ?? null;
  }

  get ready(): boolean {
    return this.currentSocket() !== null;
  }

  start(): void {
    if (this.server) {
      throw new Error("connector server 已启动");
    }
    const options = this.options;
    const handlers = this.handlers;
    const logger = this.logger;
    mkdirSync(dirname(options.socketPath), { recursive: true, mode: 0o700 });
    if (existsSync(options.socketPath)) {
      const existing = lstatSync(options.socketPath);
      if (!existing.isSocket()) {
        throw new Error(`connector socket 路径已存在且不是 socket：${options.socketPath}`);
      }
      unlinkSync(options.socketPath);
    }
    this.server = Bun.serve<ConnectorSocketData>({
      unix: options.socketPath,
      fetch: (request, server) => {
        const url = new URL(request.url);
        if (url.pathname === "/healthz") {
          return Response.json({ ok: true, connectorReady: this.ready });
        }
        if (url.pathname === "/v1/status") {
          if (!this.authorized(request)) {
            return new Response("Unauthorized", { status: 401 });
          }
          return Response.json({
            ok: true,
            connector: this.activeSocket?.data ?? null,
            daemon: handlers.status(),
          });
        }
        if (url.pathname !== "/v1/connectors/hermes") {
          return new Response("Not Found", { status: 404 });
        }
        if (options.acceptHermesConnector === false) {
          return new Response("Hermes connector is disabled", { status: 404 });
        }
        if (!this.authorized(request)) {
          return new Response("Unauthorized", { status: 401 });
        }
        const upgraded = server.upgrade(request, {
          data: {
            authenticated: true,
            connectorId: null,
            backend: null,
            ready: false,
            lastPongAt: Date.now(),
            generation: 0,
            disconnectHandled: false,
          },
        });
        return upgraded ? undefined : new Response("Upgrade Failed", { status: 400 });
      },
      websocket: {
        open: (socket) => {
          socket.send(JSON.stringify({
            type: "hello_required",
            protocolVersion: CONNECTOR_PROTOCOL_VERSION,
          } satisfies ConnectorOutboundMessage));
          const timer = setTimeout(() => {
            if (!socket.data.ready) {
              socket.close(1008, "hello timeout");
            }
          }, options.helloTimeoutMs);
          this.helloTimers.set(socket, timer);
        },
        message: (socket, message) => {
          const raw = typeof message === "string" ? message : Buffer.from(message).toString("utf8");
          if (Buffer.byteLength(raw, "utf8") > options.maxFrameBytes) {
            this.send(socket, { type: "error", code: "frame_too_large", message: "connector frame 超过上限" });
            socket.close(1009, "frame too large");
            return;
          }
          void this.enqueueTransition(() => this.handleMessage(socket, raw)).catch((error) => {
            logger.warn("connector 消息处理失败", { error: errorMessage(error) });
            this.send(socket, { type: "error", code: "invalid_message", message: errorMessage(error) });
          });
        },
        close: (socket) => {
          const timer = this.helloTimers.get(socket);
          if (timer) clearTimeout(timer);
          this.helloTimers.delete(socket);
          void this.enqueueTransition(async () => {
            if (this.isActiveSocket(socket)) {
              this.fenceSocket(socket);
            } else if (socket.data.generation === 0) {
              return;
            }
            // takeover 可能已 fence generation，但首次 durable settlement
            // 失败；迟到 close 仍应重试，而不是因“不再 active”直接跳过。
            await this.settleDisconnected(socket);
          }).catch((error) => {
            logger.error("connector 断开清理失败", {
              connectorId: socket.data.connectorId,
              generation: socket.data.generation,
              error: errorMessage(error),
            });
          });
        },
      },
    });
    chmodSync(options.socketPath, 0o600);
    this.heartbeatTimer = setInterval(() => {
      const socket = this.activeSocket;
      if (!socket?.data.ready) return;
      if (Date.now() - socket.data.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        socket.close(1001, "connector heartbeat timeout");
        return;
      }
      this.send(socket, { type: "ping", timestamp: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);
    this.logger.info("connector server 已启动", { socketPath: options.socketPath });
  }

  stop(): void {
    if (this.activeSocket) {
      const socket = this.activeSocket;
      this.activeSocket = null;
      this.activeGeneration = 0;
      socket.data.ready = false;
      socket.close(1001, "daemon stopping");
    }
    this.server?.stop(true);
    this.server = null;
    if (existsSync(this.options.socketPath) && lstatSync(this.options.socketPath).isSocket()) {
      unlinkSync(this.options.socketPath);
    }
    for (const timer of this.helloTimers.values()) clearTimeout(timer);
    this.helloTimers.clear();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  sendJob(job: StoredJob): boolean {
    const socket = this.currentSocket();
    if (!socket || !job.leaseId) {
      return false;
    }
    const message: ConnectorJobMessage = {
      type: "job",
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      job: {
        jobId: job.jobId,
        leaseId: job.leaseId,
        runGeneration: job.runGeneration,
        messageId: job.messageId,
        chatId: job.sessionKey,
        text: job.text,
        timestamp: job.timestamp,
        user: {
          id: job.fromNodeId,
          displayName: job.fromNodeId,
          trusted: true,
        },
        source: {
          nodeId: job.fromNodeId,
          nodeType: job.fromNodeType,
        },
      },
    };
    return this.send(socket, message);
  }

  sendCancel(job: StoredJob): boolean {
    const socket = this.currentSocket();
    if (!socket || !job.leaseId) {
      return false;
    }
    const message: ConnectorCancelMessage = {
      type: "cancel",
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      jobId: job.jobId,
      leaseId: job.leaseId,
    };
    return this.send(socket, message);
  }

  acknowledgeResult(jobId: string, leaseId: string): void {
    const socket = this.currentSocket();
    if (socket) {
      this.send(socket, { type: "result_stored", jobId, leaseId });
    }
  }

  rejectJobMessage(jobId: string, code: string, message: string): void {
    const socket = this.currentSocket();
    if (socket) {
      this.send(socket, { type: "error", code, message, jobId });
    }
  }

  private authorized(request: Request): boolean {
    const value = request.headers.get("authorization") ?? "";
    const token = value.startsWith("Bearer ") ? value.slice(7) : "";
    return token !== "" && safeEqual(token, this.options.connectorToken);
  }

  private async handleMessage(socket: Bun.ServerWebSocket<ConnectorSocketData>, raw: string): Promise<void> {
    const message = parseConnectorMessage(raw);
    if (message.type === "hello") {
      await this.acceptHello(socket, message);
      return;
    }
    if (!this.isActiveSocket(socket) || !socket.data.connectorId) {
      throw new Error("connector generation 已失效");
    }
    switch (message.type) {
      case "accepted":
        await this.handlers.onAccepted(message, socket.data.connectorId);
        break;
      case "result":
        await this.handlers.onResult(message, socket.data.connectorId);
        break;
      case "failed":
        await this.handlers.onFailed(message, socket.data.connectorId);
        break;
      case "cancelled":
        await this.handlers.onCancelled(message, socket.data.connectorId);
        break;
      case "pong":
        socket.data.lastPongAt = Date.now();
        break;
      default:
        throw new Error(`未处理 connector 消息：${(message as { type: string }).type}`);
    }
  }

  private async acceptHello(
    socket: Bun.ServerWebSocket<ConnectorSocketData>,
    message: ConnectorHello,
  ): Promise<void> {
    if (socket.data.ready || socket.data.generation !== 0) {
      throw new Error("重复 hello");
    }
    if (message.implementation.name !== this.options.bridgeImplementation) {
      this.send(socket, {
        type: "error",
        code: "bridge_implementation_unsupported",
        message: `connector implementation 必须是 ${this.options.bridgeImplementation}`,
      });
      socket.close(1008, "unsupported bridge implementation");
      return;
    }
    const bridgeVersion = parseSemverTriplet(message.implementation.version);
    const bridgeMinimum = parseSemverTriplet(this.options.bridgeMinimumVersion);
    const bridgeMaximum = parseSemverTriplet(this.options.bridgeMaximumExclusiveVersion);
    if (
      !bridgeVersion || !bridgeMinimum || !bridgeMaximum ||
      !versionAtLeast(bridgeVersion, bridgeMinimum) ||
      !versionLessThan(bridgeVersion, bridgeMaximum)
    ) {
      this.send(socket, {
        type: "error",
        code: "bridge_version_unsupported",
        message: `bridge ${message.implementation.version} 不在已审核范围 [${this.options.bridgeMinimumVersion}, ${this.options.bridgeMaximumExclusiveVersion})`,
      });
      socket.close(1008, "unsupported bridge version");
      return;
    }
    const runtimeVersion = parseSemverTriplet(message.implementation.runtimeVersion ?? "");
    const minimumVersion = parseSemverTriplet(this.options.hermesMinimumVersion);
    const maximumVersion = parseSemverTriplet(this.options.hermesMaximumExclusiveVersion);
    if (
      !runtimeVersion || !minimumVersion || !maximumVersion ||
      !versionAtLeast(runtimeVersion, minimumVersion) ||
      !versionLessThan(runtimeVersion, maximumVersion)
    ) {
      this.send(socket, {
        type: "error",
        code: "hermes_version_unsupported",
        message: `Hermes runtime ${message.implementation.runtimeVersion ?? "unknown"} 不在已审核范围 [${this.options.hermesMinimumVersion}, ${this.options.hermesMaximumExclusiveVersion})`,
      });
      socket.close(1008, "unsupported Hermes version");
      return;
    }

    const activeSocket = this.currentSocket();
    if (activeSocket && activeSocket !== socket) {
      // Hermes 重启后旧 socket 可能还没被心跳超时（最长 45 秒）回收。
      // takeover 必须先 fence 旧 generation，并完成所有 active lease 的
      // durable 结算，再暴露新 generation；connectorId 即使复用也不能越界。
      if (Date.now() - activeSocket.data.lastPongAt > HEARTBEAT_INTERVAL_MS * 2) {
        this.logger.warn("驱逐失活的旧 connector，接受新 hello", {
          staleConnectorId: activeSocket.data.connectorId,
          staleGeneration: activeSocket.data.generation,
        });
        this.fenceSocket(activeSocket);
        activeSocket.close(1001, "replaced by new connector");
        await this.settleDisconnected(activeSocket);
      } else {
        this.send(socket, { type: "error", code: "connector_conflict", message: "已有 Hermes connector 在线" });
        socket.close(1008, "connector conflict");
        return;
      }
    }

    const generation = ++this.nextGeneration;
    socket.data.connectorId = message.connectorId;
    socket.data.backend = message.backend;
    socket.data.generation = generation;
    socket.data.ready = true;
    this.activeSocket = socket;
    this.activeGeneration = generation;
    const timer = this.helloTimers.get(socket);
    if (timer) clearTimeout(timer);
    this.helloTimers.delete(socket);
    this.send(socket, {
      type: "hello_ack",
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      connectorId: message.connectorId,
      daemonVersion: this.options.daemonVersion,
      resultStoreTimeoutMs: this.options.resultStoreTimeoutMs,
    });
    await this.handlers.onReady(message);
    this.logger.info("Hermes connector 已就绪", {
      connectorId: message.connectorId,
      generation,
      implementation: message.implementation,
    });
  }

  private currentSocket(): Bun.ServerWebSocket<ConnectorSocketData> | null {
    const socket = this.activeSocket;
    return socket && this.isActiveSocket(socket) ? socket : null;
  }

  private isActiveSocket(socket: Bun.ServerWebSocket<ConnectorSocketData>): boolean {
    return this.activeSocket === socket &&
      socket.data.ready &&
      socket.data.generation !== 0 &&
      socket.data.generation === this.activeGeneration;
  }

  private fenceSocket(socket: Bun.ServerWebSocket<ConnectorSocketData>): void {
    if (!this.isActiveSocket(socket)) return;
    socket.data.ready = false;
    this.activeSocket = null;
    this.activeGeneration = 0;
  }

  private async settleDisconnected(socket: Bun.ServerWebSocket<ConnectorSocketData>): Promise<void> {
    if (socket.data.disconnectHandled) return;
    if (socket.data.connectorId) {
      await this.handlers.onDisconnected(socket.data.connectorId);
    }
    // 只有 durable handler 成功后才能记为已结算；否则 takeover/close 的
    // 后续路径必须仍可重试同一 generation。
    socket.data.disconnectHandled = true;
  }

  private enqueueTransition(operation: () => Promise<void>): Promise<void> {
    const queued = this.transitionChain.then(operation);
    this.transitionChain = queued.catch(() => undefined);
    return queued;
  }

  private send(socket: Bun.ServerWebSocket<ConnectorSocketData>, message: ConnectorOutboundMessage): boolean {
    try {
      // Bun：-1 表示背压但消息已入队仍会送达，0 表示连接已关闭被丢弃。
      // 把 -1 判为失败会触发 resetUnsentDispatch 后重新派发一条实际已送达
      // 的 job，破坏至多执行一次。
      return socket.send(JSON.stringify(message)) !== 0;
    } catch (error) {
      this.logger.warn("发送 connector 消息失败", { type: message.type, error: errorMessage(error) });
      return false;
    }
  }
}
