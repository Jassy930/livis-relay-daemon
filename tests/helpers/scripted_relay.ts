import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import type { RelayEnvelope } from "../../src/types.ts";

/**
 * 本地 S2 probe 只允许使用这些固定哨兵值，避免测试记录误带真实凭据或身份。
 */
export const RELAY_PROBE_SENTINELS = Object.freeze({
  accountId: "probe-account-id",
  agentId: "probe-agent-id",
  deviceId: "probe-device-id",
  nodeName: "本地协议探针",
  nodeId: "probe-node-id",
  accessToken: "probe-access-token-v1",
  refreshedAccessToken: "probe-access-token-v2",
  refreshToken: "probe-refresh-token-v1",
});

export type ProbeDirection = "daemon->relay" | "relay->daemon";

interface ProbeEventBase {
  sequence: number;
  elapsedMs: number;
  connectionId: string;
}

export interface ProbeUpgradeEvent extends ProbeEventBase {
  kind: "upgrade";
  path: string;
  query: Array<[string, string]>;
}

export interface ProbeOpenEvent extends ProbeEventBase {
  kind: "open";
}

export interface ProbeTextEvent extends ProbeEventBase {
  kind: "text";
  direction: ProbeDirection;
  raw: string;
  envelope: RelayEnvelope;
}

export interface ProbeControlEvent extends ProbeEventBase {
  kind: "ping" | "pong";
  direction: ProbeDirection;
  data: string;
}

export interface ProbeCloseEvent extends ProbeEventBase {
  kind: "close";
  initiator: "daemon" | "relay";
  code: number;
  reason: string;
}

export type ProbeEvent =
  | ProbeUpgradeEvent
  | ProbeOpenEvent
  | ProbeTextEvent
  | ProbeControlEvent
  | ProbeCloseEvent;

type UnrecordedProbeEvent = ProbeEvent extends infer Event
  ? Event extends ProbeEvent
    ? Omit<Event, "sequence" | "elapsedMs">
    : never
  : never;

interface ProbeConnection {
  id: string;
  socket: WebSocket;
  closeInitiator: "daemon" | "relay";
}

function parseEnvelope(raw: string): RelayEnvelope {
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("scripted Relay 只接受 JSON object 文本帧");
  }
  return value as RelayEnvelope;
}

function socketData(data: Buffer): string {
  return data.toString("utf8");
}

/**
 * 完全运行于 127.0.0.1 的脚本化 Relay。
 *
 * 它是 S2 fake Relay，不代表真实服务端要求。服务端配置 `autoPong=false`，
 * 但 Bun 1.3.x 的 ws 兼容层仍可能自动 pong；依赖“静默”的测试只断言 daemon
 * 首次 heartbeat tick 的超时分支，不把后续控制帧行为当作服务端事实。
 */
export class ScriptedRelay {
  readonly events: ProbeEvent[] = [];
  url = "";

  private readonly startedAt = performance.now();
  private readonly webSocketServer = new WebSocketServer({ noServer: true, autoPong: false });
  private readonly connections = new Map<string, ProbeConnection>();
  private readonly tcpSockets = new Set<Socket>();
  private readonly claimedClientTexts = new Set<number>();
  private httpServer: HttpServer | null = null;
  private nextSequence = 1;
  private nextConnection = 1;

  async start(): Promise<void> {
    if (this.httpServer) return;
    const server = createServer((_request, response) => {
      response.writeHead(426, { "content-type": "text/plain; charset=utf-8" });
      response.end("WebSocket upgrade required");
    });
    this.httpServer = server;
    server.on("connection", (socket) => {
      this.tcpSockets.add(socket);
      socket.once("close", () => this.tcpSockets.delete(socket));
    });
    server.on("upgrade", (request, socket, head) => {
      const connectionId = `connection-${this.nextConnection++}`;
      const parsed = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      this.record({
        kind: "upgrade",
        connectionId,
        path: parsed.pathname,
        query: [...parsed.searchParams.entries()],
      });
      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.registerConnection(connectionId, webSocket);
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });
    const address = server.address() as AddressInfo;
    this.url = `ws://127.0.0.1:${address.port}/api/v1/ws`;
  }

  async stop(): Promise<void> {
    for (const connection of this.connections.values()) {
      connection.closeInitiator = "relay";
      connection.socket.close(1001, "scripted relay stopping");
    }
    await this.waitFor(
      () => this.connections.size === 0,
      500,
      "scripted Relay WebSocket 关闭",
    ).catch(() => undefined);
    for (const connection of this.connections.values()) connection.socket.terminate();
    this.connections.clear();
    for (const socket of this.tcpSockets) socket.destroy();
    this.tcpSockets.clear();
    const server = this.httpServer;
    this.httpServer = null;
    this.webSocketServer.close();
    // Bun 的 node:http 兼容层在 upgrade socket 销毁后不总会调用 close callback。
    server?.close();
  }

  connectionIds(): string[] {
    return [...this.connections.keys()];
  }

  sendEnvelope(connectionId: string, envelope: RelayEnvelope): ProbeTextEvent {
    const connection = this.requireOpenConnection(connectionId);
    const raw = JSON.stringify(envelope);
    const event = this.record({
      kind: "text",
      connectionId,
      direction: "relay->daemon",
      raw,
      envelope,
    });
    connection.socket.send(raw);
    return event;
  }

  sendPing(connectionId: string, data = ""): ProbeControlEvent {
    const connection = this.requireOpenConnection(connectionId);
    const event = this.record({
      kind: "ping",
      connectionId,
      direction: "relay->daemon",
      data,
    });
    connection.socket.ping(data);
    return event;
  }

  sendPong(connectionId: string, data = ""): ProbeControlEvent {
    const connection = this.requireOpenConnection(connectionId);
    const event = this.record({
      kind: "pong",
      connectionId,
      direction: "relay->daemon",
      data,
    });
    connection.socket.pong(data);
    return event;
  }

  closeConnection(connectionId: string, code = 1012, reason = "scripted disconnect"): void {
    const connection = this.requireOpenConnection(connectionId);
    connection.closeInitiator = "relay";
    connection.socket.close(code, reason);
  }

  clientTextCount(type?: string, connectionId?: string): number {
    return this.events.filter((event) => (
      event.kind === "text"
      && event.direction === "daemon->relay"
      && (type === undefined || event.envelope.type === type)
      && (connectionId === undefined || event.connectionId === connectionId)
    )).length;
  }

  async nextClientEnvelope(type?: string, timeoutMs = 1_000): Promise<ProbeTextEvent> {
    let found: ProbeTextEvent | undefined;
    await this.waitFor(() => {
      found = this.events.find((event): event is ProbeTextEvent => (
        event.kind === "text"
        && event.direction === "daemon->relay"
        && !this.claimedClientTexts.has(event.sequence)
        && (type === undefined || event.envelope.type === type)
      ));
      return found !== undefined;
    }, timeoutMs, `daemon 文本帧${type ? ` ${type}` : ""}`);
    this.claimedClientTexts.add(found!.sequence);
    return found!;
  }

  async waitForEvent<T extends ProbeEvent>(
    predicate: (event: ProbeEvent) => event is T,
    timeoutMs?: number,
    afterSequence?: number,
  ): Promise<T>;
  async waitForEvent(
    predicate: (event: ProbeEvent) => boolean,
    timeoutMs?: number,
    afterSequence?: number,
  ): Promise<ProbeEvent>;
  async waitForEvent(
    predicate: (event: ProbeEvent) => boolean,
    timeoutMs = 1_000,
    afterSequence = 0,
  ): Promise<ProbeEvent> {
    let found: ProbeEvent | undefined;
    await this.waitFor(() => {
      found = this.events.find((event) => event.sequence > afterSequence && predicate(event));
      return found !== undefined;
    }, timeoutMs, "scripted Relay 事件");
    return found!;
  }

  private registerConnection(connectionId: string, socket: WebSocket): void {
    const connection: ProbeConnection = {
      id: connectionId,
      socket,
      closeInitiator: "daemon",
    };
    this.connections.set(connectionId, connection);
    this.record({ kind: "open", connectionId });
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, "S2 probe rejects binary frames");
        return;
      }
      const raw = data.toString();
      this.record({
        kind: "text",
        connectionId,
        direction: "daemon->relay",
        raw,
        envelope: parseEnvelope(raw),
      });
    });
    socket.on("ping", (data) => {
      this.record({
        kind: "ping",
        connectionId,
        direction: "daemon->relay",
        data: socketData(data),
      });
    });
    socket.on("pong", (data) => {
      this.record({
        kind: "pong",
        connectionId,
        direction: "daemon->relay",
        data: socketData(data),
      });
    });
    socket.on("close", (code, reason) => {
      this.record({
        kind: "close",
        connectionId,
        initiator: connection.closeInitiator,
        code,
        reason: reason.toString(),
      });
      this.connections.delete(connectionId);
    });
  }

  private requireOpenConnection(connectionId: string): ProbeConnection {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`scripted Relay connection 不可用：${connectionId}`);
    }
    return connection;
  }

  private record<T extends UnrecordedProbeEvent>(event: T): T & ProbeEventBase {
    const recorded = {
      ...event,
      sequence: this.nextSequence++,
      elapsedMs: performance.now() - this.startedAt,
    } as T & ProbeEventBase;
    this.events.push(recorded);
    return recorded;
  }

  private async waitFor(
    predicate: () => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (!predicate()) {
      if (performance.now() >= deadline) {
        throw new Error(`等待 ${label} 超时（${timeoutMs} ms）`);
      }
      await Bun.sleep(2);
    }
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 规范化动态 wire 值；同一个原值始终映射到同一个占位符，因此关联 ID
 * 的相等关系不会在快照中丢失。
 */
export class ProbeNormalizer {
  private readonly uuids = new Map<string, string>();
  private readonly timestamps = new Map<number, string>();
  private readonly accessTokens = new Map<string, string>();
  private readonly refreshTokens = new Map<string, string>();

  normalizeEnvelope(envelope: RelayEnvelope): RelayEnvelope {
    return this.normalizeValue(envelope) as RelayEnvelope;
  }

  private normalizeValue(value: unknown, key = ""): unknown {
    if (typeof value === "number" && key === "timestamp") {
      return this.placeholder(this.timestamps, value, "timestamp");
    }
    if (typeof value === "string") {
      if (key === "refresh_token") {
        return this.placeholder(this.refreshTokens, value, "refresh-token");
      }
      if (key === "token") {
        return this.placeholder(this.accessTokens, value, "access-token");
      }
      if (UUID_PATTERN.test(value)) {
        return this.placeholder(this.uuids, value, "uuid");
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.normalizeValue(item));
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([childKey, childValue]) => [
          childKey,
          this.normalizeValue(childValue, childKey),
        ]),
      );
    }
    return value;
  }

  private placeholder<K>(map: Map<K, string>, value: K, label: string): string {
    const existing = map.get(value);
    if (existing) return existing;
    const normalized = `<${label}:${map.size + 1}>`;
    map.set(value, normalized);
    return normalized;
  }
}
