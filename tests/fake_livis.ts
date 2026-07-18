import type { RelayEnvelope } from "../src/types.ts";

export interface CapturedEnvelope {
  socket: Bun.ServerWebSocket<FakeSocketData>;
  envelope: RelayEnvelope;
}

export interface FakeSocketData {
  connectionId: string;
}

interface EnvelopeWaiter {
  type: string;
  resolve: (captured: CapturedEnvelope) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await Bun.sleep(5);
  }
}

export async function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class FakeLivisRelay {
  private server: Bun.Server<FakeSocketData> | null = null;
  private readonly sockets = new Set<Bun.ServerWebSocket<FakeSocketData>>();
  private readonly queued: CapturedEnvelope[] = [];
  private readonly waiters: EnvelopeWaiter[] = [];
  readonly history: CapturedEnvelope[] = [];
  url = "";

  async start(): Promise<void> {
    const relay = this;
    this.server = Bun.serve<FakeSocketData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request, { data: { connectionId: crypto.randomUUID() } })) {
          return undefined;
        }
        return new Response("WebSocket upgrade required", { status: 426 });
      },
      websocket: {
        open(socket) {
          relay.sockets.add(socket);
        },
        message(socket, data) {
          const envelope = JSON.parse(data.toString()) as RelayEnvelope;
          const captured = { socket, envelope };
          relay.history.push(captured);
          const waiterIndex = relay.waiters.findIndex((waiter) => waiter.type === envelope.type);
          if (waiterIndex >= 0) {
            const [waiter] = relay.waiters.splice(waiterIndex, 1);
            clearTimeout(waiter!.timer);
            waiter!.resolve(captured);
          } else {
            relay.queued.push(captured);
          }
        },
        close(socket) {
          relay.sockets.delete(socket);
        },
      },
    });
    this.url = `ws://${this.server.hostname}:${this.server.port}/api/v1/ws`;
  }

  async stop(): Promise<void> {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("fake LiViS relay stopped"));
    }
    for (const socket of this.sockets) {
      socket.close(1001, "fake relay stopping");
    }
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    server?.stop(true);
  }

  connectionCount(): number {
    return this.sockets.size;
  }

  async next(type: string, timeoutMs = 2_000): Promise<CapturedEnvelope> {
    const queuedIndex = this.queued.findIndex((captured) => captured.envelope.type === type);
    if (queuedIndex >= 0) {
      return this.queued.splice(queuedIndex, 1)[0]!;
    }
    return new Promise<CapturedEnvelope>((resolve, reject) => {
      const waiter: EnvelopeWaiter = {
        type,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error(`timed out waiting for fake LiViS ${type}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  send(socket: Bun.ServerWebSocket<FakeSocketData>, envelope: RelayEnvelope): void {
    socket.send(JSON.stringify(envelope));
  }

  async handshake(
    isReady: () => boolean,
    timeoutMs = 2_000,
  ): Promise<Bun.ServerWebSocket<FakeSocketData>> {
    const connect = await this.next("connect", timeoutMs);
    this.send(connect.socket, {
      type: "connected",
      metadata: { job_id: connect.envelope.metadata?.job_id },
      payload: {},
    });
    await waitFor(isReady, timeoutMs, "LiViS relay handshake");
    return connect.socket;
  }

  async disconnect(socket: Bun.ServerWebSocket<FakeSocketData>): Promise<void> {
    if (!this.sockets.has(socket)) return;
    socket.close(1012, "fake relay disconnect");
    await waitFor(() => !this.sockets.has(socket), 1_000, "fake relay socket close");
  }

  count(type: string): number {
    return this.history.filter((captured) => captured.envelope.type === type).length;
  }
}
