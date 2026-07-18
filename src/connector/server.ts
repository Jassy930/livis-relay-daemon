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
const CONNECTOR_PATH_PREFIX = "/v1/connectors/";

interface ConnectorSocketData {
  authenticated: true;
  expectedBackend: string;
  connectorId: string | null;
  backend: string | null;
  ready: boolean;
  lastPongAt: number;
}

export interface ConnectorBackendSpec {
  backend: string;
  implementation: string;
  bridgeMinimumVersion: string;
  bridgeMaximumExclusiveVersion: string;
  runtimeMinimumVersion: string;
  runtimeMaximumExclusiveVersion: string;
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
  helloTimeoutMs: number;
  resultStoreTimeoutMs: number;
  maxFrameBytes: number;
  daemonVersion: string;
  backends: ConnectorBackendSpec[];
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
      typeof data.backend !== "string" ||
      data.backend.trim() === "" ||
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
  private readonly activeSockets = new Map<string, Bun.ServerWebSocket<ConnectorSocketData>>();
  private readonly registry = new Map<string, ConnectorBackendSpec>();
  private readonly helloTimers = new Map<Bun.ServerWebSocket<ConnectorSocketData>, ReturnType<typeof setTimeout>>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly options: ConnectorServerOptions,
    private readonly handlers: ConnectorServerHandlers,
    private readonly logger: Logger,
  ) {
    for (const spec of options.backends) {
      if (this.registry.has(spec.backend)) {
        throw new Error(`connector backend 重复注册：${spec.backend}`);
      }
      this.registry.set(spec.backend, spec);
    }
    if (this.registry.size === 0) {
      throw new Error("connector server 至少需要一个已注册 backend");
    }
  }

  get socketPath(): string {
    return this.options.socketPath;
  }

  registeredBackends(): string[] {
    return [...this.registry.keys()];
  }

  ready(backend: string): boolean {
    return this.activeSockets.get(backend)?.data.ready === true;
  }

  connectorId(backend: string): string | null {
    return this.activeSockets.get(backend)?.data.connectorId ?? null;
  }

  connectorsStatus(): Array<{ backend: string; connectorId: string | null; ready: boolean }> {
    return this.registeredBackends().map((backend) => ({
      backend,
      connectorId: this.connectorId(backend),
      ready: this.ready(backend),
    }));
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
          return Response.json({ ok: true, connectors: this.connectorsStatus() });
        }
        if (url.pathname === "/v1/status") {
          if (!this.authorized(request)) {
            return new Response("Unauthorized", { status: 401 });
          }
          return Response.json({
            ok: true,
            connectors: this.connectorsStatus(),
            daemon: handlers.status(),
          });
        }
        if (!url.pathname.startsWith(CONNECTOR_PATH_PREFIX)) {
          return new Response("Not Found", { status: 404 });
        }
        const requestedBackend = url.pathname.slice(CONNECTOR_PATH_PREFIX.length);
        if (!this.registry.has(requestedBackend)) {
          return new Response("Unknown connector backend", { status: 404 });
        }
        if (!this.authorized(request)) {
          return new Response("Unauthorized", { status: 401 });
        }
        const upgraded = server.upgrade(request, {
          data: {
            authenticated: true,
            expectedBackend: requestedBackend,
            connectorId: null,
            backend: null,
            ready: false,
            lastPongAt: Date.now(),
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
          void this.handleMessage(socket, raw).catch((error) => {
            logger.warn("connector 消息处理失败", { error: errorMessage(error) });
            this.send(socket, { type: "error", code: "invalid_message", message: errorMessage(error) });
          });
        },
        close: (socket) => {
          const timer = this.helloTimers.get(socket);
          if (timer) clearTimeout(timer);
          this.helloTimers.delete(socket);
          const connectorId = socket.data.connectorId;
          const backend = socket.data.backend;
          const wasActive = backend !== null && this.activeSockets.get(backend) === socket;
          if (backend && wasActive) {
            this.activeSockets.delete(backend);
          }
          if (connectorId && wasActive) {
            void handlers.onDisconnected(connectorId).catch((error) => {
              logger.error("connector 断开清理失败", { connectorId, error: errorMessage(error) });
            });
          }
        },
      },
    });
    chmodSync(options.socketPath, 0o600);
    this.heartbeatTimer = setInterval(() => {
      for (const socket of this.activeSockets.values()) {
        if (!socket.data.ready) continue;
        if (Date.now() - socket.data.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
          socket.close(1001, "connector heartbeat timeout");
          continue;
        }
        this.send(socket, { type: "ping", timestamp: Date.now() });
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.logger.info("connector server 已启动", {
      socketPath: options.socketPath,
      backends: this.registeredBackends(),
    });
  }

  stop(): void {
    for (const socket of this.activeSockets.values()) {
      socket.close(1001, "daemon stopping");
    }
    this.activeSockets.clear();
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

  sendJob(job: StoredJob, backend: string): boolean {
    const socket = this.activeSockets.get(backend);
    if (!socket?.data.ready || !job.leaseId) {
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
    // cancel 必须送达持有 lease 的那个 connector 实例，而不是当前 backend
    // 在线的任意实例。
    const socket = job.connectorId ? this.findByConnectorId(job.connectorId) : null;
    if (!socket?.data.ready || !job.leaseId) {
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

  acknowledgeResult(jobId: string, leaseId: string, connectorId: string): void {
    const socket = this.findByConnectorId(connectorId);
    if (socket?.data.ready) {
      this.send(socket, { type: "result_stored", jobId, leaseId });
    }
  }

  rejectJobMessage(jobId: string, code: string, message: string, connectorId: string): void {
    const socket = this.findByConnectorId(connectorId);
    if (socket?.data.ready) {
      this.send(socket, { type: "error", code, message, jobId });
    }
  }

  private findByConnectorId(connectorId: string): Bun.ServerWebSocket<ConnectorSocketData> | null {
    for (const socket of this.activeSockets.values()) {
      if (socket.data.connectorId === connectorId) {
        return socket;
      }
    }
    return null;
  }

  private authorized(request: Request): boolean {
    const value = request.headers.get("authorization") ?? "";
    const token = value.startsWith("Bearer ") ? value.slice(7) : "";
    return token !== "" && safeEqual(token, this.options.connectorToken);
  }

  private async handleMessage(socket: Bun.ServerWebSocket<ConnectorSocketData>, raw: string): Promise<void> {
    const message = parseConnectorMessage(raw);
    if (message.type === "hello") {
      if (socket.data.ready) {
        throw new Error("重复 hello");
      }
      const spec = this.registry.get(message.backend);
      if (!spec || message.backend !== socket.data.expectedBackend) {
        this.send(socket, {
          type: "error",
          code: "backend_unsupported",
          message: `未注册或与连接路径不符的 connector backend：${message.backend}`,
        });
        socket.close(1008, "unsupported backend");
        return;
      }
      const existing = this.activeSockets.get(message.backend);
      if (existing && existing !== socket) {
        // 同 backend 重启后旧 socket 可能还没被心跳超时（最长 45 秒）回收。
        // 旧连接已错过一个完整心跳周期时按失活处理，把位置让给新连接。
        if (Date.now() - existing.data.lastPongAt > HEARTBEAT_INTERVAL_MS * 2) {
          this.logger.warn("驱逐失活的旧 connector，接受新 hello", {
            backend: message.backend,
            staleConnectorId: existing.data.connectorId,
          });
          // 先撤销 backend 的 active 身份，再关闭旧 socket。这样旧连接迟到的
          // close 回调不会清理复用同一 connectorId 的新连接所持有的 job。
          this.activeSockets.delete(message.backend);
          existing.close(1001, "replaced by new connector");
        } else {
          this.send(socket, {
            type: "error",
            code: "connector_conflict",
            message: `backend ${message.backend} 已有 connector 在线`,
          });
          socket.close(1008, "connector conflict");
          return;
        }
      }
      if (message.implementation.name !== spec.implementation) {
        this.send(socket, {
          type: "error",
          code: "bridge_implementation_unsupported",
          message: `connector implementation 必须是 ${spec.implementation}`,
        });
        socket.close(1008, "unsupported bridge implementation");
        return;
      }
      const bridgeVersion = parseSemverTriplet(message.implementation.version);
      const bridgeMinimum = parseSemverTriplet(spec.bridgeMinimumVersion);
      const bridgeMaximum = parseSemverTriplet(spec.bridgeMaximumExclusiveVersion);
      if (
        !bridgeVersion || !bridgeMinimum || !bridgeMaximum ||
        !versionAtLeast(bridgeVersion, bridgeMinimum) ||
        !versionLessThan(bridgeVersion, bridgeMaximum)
      ) {
        this.send(socket, {
          type: "error",
          code: "bridge_version_unsupported",
          message: `bridge ${message.implementation.version} 不在已审核范围 [${spec.bridgeMinimumVersion}, ${spec.bridgeMaximumExclusiveVersion})`,
        });
        socket.close(1008, "unsupported bridge version");
        return;
      }
      const runtimeVersion = parseSemverTriplet(message.implementation.runtimeVersion ?? "");
      const minimumVersion = parseSemverTriplet(spec.runtimeMinimumVersion);
      const maximumVersion = parseSemverTriplet(spec.runtimeMaximumExclusiveVersion);
      if (
        !runtimeVersion || !minimumVersion || !maximumVersion ||
        !versionAtLeast(runtimeVersion, minimumVersion) ||
        !versionLessThan(runtimeVersion, maximumVersion)
      ) {
        this.send(socket, {
          type: "error",
          code: "hermes_version_unsupported",
          message: `${message.backend} runtime ${message.implementation.runtimeVersion ?? "unknown"} 不在已审核范围 [${spec.runtimeMinimumVersion}, ${spec.runtimeMaximumExclusiveVersion})`,
        });
        socket.close(1008, "unsupported runtime version");
        return;
      }
      socket.data.connectorId = message.connectorId;
      socket.data.backend = message.backend;
      socket.data.ready = true;
      this.activeSockets.set(message.backend, socket);
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
      this.logger.info("connector 已就绪", {
        backend: message.backend,
        connectorId: message.connectorId,
        implementation: message.implementation,
      });
      return;
    }
    if (!socket.data.ready || !socket.data.connectorId) {
      throw new Error("connector 尚未完成 hello");
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
