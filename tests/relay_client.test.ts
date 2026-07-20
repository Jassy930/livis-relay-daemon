import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { IdaasClient } from "../src/auth/idaas.ts";
import type { RelayConfig } from "../src/config.ts";
import type { RelayIdentity } from "../src/identity.ts";
import { Logger } from "../src/logger.ts";
import {
  parseIncomingRelayJob,
  serializeResult,
} from "../src/protocol/livis.ts";
import type { ProtocolProfile } from "../src/protocol/profile.ts";
import {
  RelayClient,
  type RelayClientHandlers,
} from "../src/relay/client.ts";
import { SecretStore } from "../src/secrets.ts";
import { JobStore } from "../src/state/store.ts";
import type { RelayEnvelope } from "../src/types.ts";
import {
  incomingJob,
  temporaryDirectory,
  testConfig,
  testProfile,
} from "./helpers.ts";

interface CapturedEnvelope {
  socket: Bun.ServerWebSocket<FakeSocketData>;
  envelope: RelayEnvelope;
}

interface FakeSocketData {
  connectionId: string;
}

interface EnvelopeWaiter {
  type: string;
  resolve: (captured: CapturedEnvelope) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class FakeLivisRelay {
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
    client: RelayClient,
    timeoutMs = 2_000,
  ): Promise<Bun.ServerWebSocket<FakeSocketData>> {
    const connect = await this.next("connect", timeoutMs);
    this.send(connect.socket, {
      type: "connected",
      metadata: { job_id: connect.envelope.metadata?.job_id },
      payload: {},
    });
    await waitFor(() => client.connected, timeoutMs, "RelayClient handshake");
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(
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

async function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
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

function messageEnvelope(jobId: string, messageId = `msg-${jobId}`): RelayEnvelope {
  return {
    type: "send_message",
    metadata: {
      job_id: jobId,
      msg_id: messageId,
      timestamp: 1_700_000_000_000,
    },
    payload: {
      from_node_id: "node-1",
      from_node_type: "phone",
      data: { type: "exec", content: "hello" },
    },
  };
}

function cancelEnvelope(jobId: string): RelayEnvelope {
  return {
    type: "cancel_chat",
    metadata: { job_id: jobId, msg_id: `cancel-${jobId}` },
    payload: {},
  };
}

function createPendingResult(store: JobStore, jobId: string): void {
  store.ingest(incomingJob(jobId), `session-${jobId}`);
  store.markAcked(jobId);
  store.claimForDispatch(jobId, "connector-test", `lease-${jobId}`);
  store.markRunning(jobId, "connector-test", `lease-${jobId}`);
  store.finishSuccess(jobId, `lease-${jobId}`, serializeResult(`result-${jobId}`));
}

describe("RelayClient fake LiViS end-to-end", () => {
  let directory: Awaited<ReturnType<typeof temporaryDirectory>>;
  let fakeRelay: FakeLivisRelay;
  let profile: ProtocolProfile;
  let config: RelayConfig;
  let identity: RelayIdentity;
  let secrets: SecretStore;
  let store: JobStore;
  let client: RelayClient | null;

  beforeEach(async () => {
    directory = await temporaryDirectory("livis-relay-client-test-");
    fakeRelay = new FakeLivisRelay();
    await fakeRelay.start();
    const baseProfile = await testProfile();
    profile = {
      ...baseProfile,
      endpoints: {
        ...baseProfile.endpoints,
        relayWebSocketUrl: fakeRelay.url,
      },
      timing: {
        ...baseProfile.timing,
        heartbeatIntervalMs: 10_000,
        pongTimeoutMs: 20_000,
        resultAckTimeoutMs: 40,
        resultMaxRetries: 3,
      },
    };
    config = testConfig(directory.path);
    config.relay.handshakeTimeoutMs = 500;
    config.relay.reconnectMaxMs = 1;
    identity = {
      schemaVersion: 1,
      accountId: "account-test",
      agentId: "test-agent-id",
      deviceId: "pc_device-test",
      createdAt: new Date(0).toISOString(),
    };
    secrets = new SecretStore(directory.path);
    await secrets.initialize();
    await secrets.setRefreshToken("refresh-test");
    store = new JobStore(join(directory.path, "relay.db"), "account-test:test-agent-id");
    client = null;
  });

  afterEach(async () => {
    if (client) await bounded(client.stop(), 1_000, "RelayClient.stop");
    await bounded(fakeRelay.stop(), 1_000, "FakeLivisRelay.stop");
    store.close();
    await directory.cleanup();
  });

  function createClient(handlers: RelayClientHandlers): RelayClient {
    const auth = {
      getAccessToken: async () => "access-test",
    } as unknown as IdaasClient;
    client = new RelayClient(
      config,
      profile,
      identity,
      secrets,
      auth,
      store,
      handlers,
      new Logger("test.relay-client", "error"),
    );
    return client;
  }

  function durableHandlers(onCommitted?: (jobId: string, inserted: boolean) => void): RelayClientHandlers {
    return {
      onIncoming: async (envelope) => {
        const incoming = parseIncomingRelayJob(envelope, config.security.maxInputChars);
        const ingested = store.ingest(incoming, `session-${incoming.fromNodeId}`);
        if (ingested.job.status === "Received") {
          store.markAcked(incoming.jobId);
        }
        onCommitted?.(incoming.jobId, ingested.inserted);
      },
      onCancel: async (jobId) => {
        store.requestCancel(jobId);
      },
      onConnected: async () => undefined,
    };
  }

  test("durable commit 完成后才发送 ack_send_message", async () => {
    const allowCommit = deferred<void>();
    const committed = deferred<void>();
    const handlers = durableHandlers(() => committed.resolve());
    const originalIncoming = handlers.onIncoming;
    handlers.onIncoming = async (envelope) => {
      await allowCommit.promise;
      await originalIncoming(envelope);
    };
    const relayClient = createClient(handlers);
    relayClient.start();
    const socket = await fakeRelay.handshake(relayClient);

    fakeRelay.send(socket, messageEnvelope("durable-job"));
    await Bun.sleep(25);
    expect(fakeRelay.count("ack_send_message")).toBe(0);
    expect(store.get("durable-job")).toBeNull();

    allowCommit.resolve();
    await committed.promise;
    const ack = await fakeRelay.next("ack_send_message");
    expect(ack.envelope.metadata?.job_id).toBe("durable-job");
    expect(store.require("durable-job").status).toBe("Acked");
  });

  test("重复 job 不重复执行，但每次投递都重新 ACK", async () => {
    let executionCount = 0;
    const relayClient = createClient(durableHandlers((_jobId, inserted) => {
      if (inserted) executionCount += 1;
    }));
    relayClient.start();
    const socket = await fakeRelay.handshake(relayClient);

    fakeRelay.send(socket, messageEnvelope("duplicate-job", "wire-message-1"));
    const firstAck = await fakeRelay.next("ack_send_message");
    fakeRelay.send(socket, messageEnvelope("duplicate-job", "wire-message-2"));
    const duplicateAck = await fakeRelay.next("ack_send_message");

    expect(firstAck.envelope.metadata?.job_id).toBe("duplicate-job");
    expect(duplicateAck.envelope.metadata?.job_id).toBe("duplicate-job");
    expect(executionCount).toBe(1);
    expect(fakeRelay.count("ack_send_message")).toBe(2);
    expect(store.listRecent().filter((job) => job.jobId === "duplicate-job")).toHaveLength(1);
  });

  test("result ACK 丢失时重试同一 job 和内容，但使用新的 msg_id", async () => {
    createPendingResult(store, "result-job");
    const relayClient = createClient(durableHandlers());
    relayClient.start();
    const socket = await fakeRelay.handshake(relayClient);

    const first = await fakeRelay.next("send_result");
    const retry = await fakeRelay.next("send_result");

    expect(first.envelope.metadata?.job_id).toBe("result-job");
    expect(retry.envelope.metadata?.job_id).toBe("result-job");
    expect(first.envelope.payload?.data).toBe(retry.envelope.payload?.data);
    expect(first.envelope.metadata?.msg_id).toBeString();
    expect(retry.envelope.metadata?.msg_id).toBeString();
    expect(retry.envelope.metadata?.msg_id).not.toBe(first.envelope.metadata?.msg_id);
    expect(store.require("result-job").outbox?.retryCount).toBe(1);

    fakeRelay.send(socket, {
      type: "ack_send_result",
      metadata: { job_id: "result-job" },
      payload: {},
    });
    await waitFor(
      () => store.require("result-job").outbox?.status === "Delivered",
      1_000,
      "result ACK durable delivery",
    );
  });

  test("重试后仍接受 ref_msg_id 引用首次投递的延迟 ACK", async () => {
    createPendingResult(store, "ref-ack-job");
    const relayClient = createClient(durableHandlers());
    relayClient.start();
    const socket = await fakeRelay.handshake(relayClient);

    const firstDelivery = await fakeRelay.next("send_result");
    const deliveryMessageId = firstDelivery.envelope.metadata?.msg_id;
    expect(deliveryMessageId).toBeString();
    expect(deliveryMessageId).not.toBe("ref-ack-job");
    const retry = await fakeRelay.next("send_result");
    expect(retry.envelope.metadata?.msg_id).not.toBe(deliveryMessageId);
    fakeRelay.send(socket, {
      type: "ack_send_result",
      metadata: {},
      payload: { ref_msg_id: deliveryMessageId },
    });
    await waitFor(
      () => store.require("ref-ack-job").outbox?.status === "Delivered",
      1_000,
      "delayed ref_msg_id ack delivery",
    );
  });

  test("send 同步失败后不接受尚未发出的 result ACK", async () => {
    createPendingResult(store, "sync-send-failure");
    const relayClient = createClient(durableHandlers());
    const internals = relayClient as unknown as {
      handshakeComplete: boolean;
      socket: { readyState: number; close: () => void };
      send: (envelope: RelayEnvelope) => void;
      deliverResult: (jobId: string, retry: boolean) => Promise<void>;
    };
    internals.handshakeComplete = true;
    internals.socket = { readyState: 1, close: () => undefined };
    internals.send = () => {
      throw new Error("synthetic send failure");
    };

    await expect(internals.deliverResult("sync-send-failure", false)).rejects.toThrow(
      "synthetic send failure",
    );
    const outbox = store.require("sync-send-failure").outbox!;
    expect(outbox.status).toBe("Pending");
    expect(outbox.lastMessageId).toBeNull();
    expect(store.markOutboxDelivered("sync-send-failure")?.status).toBe("Pending");
  });

  test("重试耗尽后迟到 ACK 可从持久化退避态完成投递", async () => {
    profile = {
      ...profile,
      timing: { ...profile.timing, resultMaxRetries: 1 },
    };
    createPendingResult(store, "late-after-failure");
    const relayClient = createClient(durableHandlers());
    relayClient.start();
    const socket = await fakeRelay.handshake(relayClient);

    const first = await fakeRelay.next("send_result");
    await fakeRelay.next("send_result");
    await waitFor(
      () => store.require("late-after-failure").outbox?.status === "AckFailed",
      1_000,
      "outbox persistent backoff",
    );
    const nextAttemptAt = store.require("late-after-failure").outbox?.nextAttemptAt;
    expect(nextAttemptAt).toBeNumber();
    expect(nextAttemptAt!).toBeGreaterThan(Date.now());

    fakeRelay.send(socket, {
      type: "ack_send_result",
      metadata: {},
      payload: { ref_msg_id: first.envelope.metadata?.msg_id },
    });
    await waitFor(
      () => store.require("late-after-failure").outbox?.status === "Delivered",
      1_000,
      "late ACK after retry exhaustion",
    );
    await Bun.sleep(Math.max(0, nextAttemptAt! - Date.now() + 20));
    expect(fakeRelay.count("send_result")).toBe(2);
  });

  test("AckFailed 退避到期后在当前连接自动开启新的重试周期", async () => {
    profile = {
      ...profile,
      timing: { ...profile.timing, resultMaxRetries: 1 },
    };
    createPendingResult(store, "online-recovery");
    const relayClient = createClient(durableHandlers());
    relayClient.start();
    const socket = await fakeRelay.handshake(relayClient);

    const first = await fakeRelay.next("send_result");
    await fakeRelay.next("send_result");
    await waitFor(
      () => store.require("online-recovery").outbox?.status === "AckFailed",
      1_000,
      "online outbox backoff",
    );
    const recovered = await fakeRelay.next("send_result");
    expect(recovered.envelope.metadata?.job_id).toBe("online-recovery");
    expect(recovered.envelope.payload?.data).toBe(first.envelope.payload?.data);
    expect(recovered.envelope.metadata?.msg_id).not.toBe(first.envelope.metadata?.msg_id);
    expect(store.require("online-recovery").outbox?.retryCount).toBe(0);

    fakeRelay.send(socket, {
      type: "ack_send_result",
      metadata: { job_id: "online-recovery" },
      payload: {},
    });
    await waitFor(
      () => store.require("online-recovery").outbox?.status === "Delivered",
      1_000,
      "online recovered result ACK",
    );
  });

  test("断线跨过退避期后，重连会恢复 AckFailed 结果", async () => {
    profile = {
      ...profile,
      timing: { ...profile.timing, resultMaxRetries: 1 },
    };
    createPendingResult(store, "reconnect-failed");
    const relayClient = createClient(durableHandlers());
    relayClient.start();
    const firstSocket = await fakeRelay.handshake(relayClient);

    const first = await fakeRelay.next("send_result");
    await fakeRelay.next("send_result");
    await waitFor(
      () => store.require("reconnect-failed").outbox?.status === "AckFailed",
      1_000,
      "reconnect outbox backoff",
    );
    await fakeRelay.disconnect(firstSocket);

    const secondSocket = await fakeRelay.handshake(relayClient, 3_000);
    const replayed = await fakeRelay.next("send_result");
    expect(replayed.envelope.metadata?.job_id).toBe("reconnect-failed");
    expect(replayed.envelope.payload?.data).toBe(first.envelope.payload?.data);
    expect(replayed.envelope.metadata?.msg_id).not.toBe(first.envelope.metadata?.msg_id);

    fakeRelay.send(secondSocket, {
      type: "ack_send_result",
      metadata: { job_id: "reconnect-failed" },
      payload: {},
    });
    await waitFor(
      () => store.require("reconnect-failed").outbox?.status === "Delivered",
      1_000,
      "reconnected failed result ACK",
    );
  });

  test("cancel-before-message 先持久化意图，后到消息不执行并分别 ACK", async () => {
    let executionCount = 0;
    const relayClient = createClient(durableHandlers((_jobId, inserted) => {
      if (inserted && store.require(_jobId).status === "Acked") executionCount += 1;
    }));
    relayClient.start();
    const socket = await fakeRelay.handshake(relayClient);

    fakeRelay.send(socket, cancelEnvelope("future-job"));
    const cancelAck = await fakeRelay.next("ack_cancel_chat");
    expect(cancelAck.envelope.metadata?.job_id).toBe("future-job");
    expect(store.get("future-job")).toBeNull();

    fakeRelay.send(socket, messageEnvelope("future-job"));
    const messageAck = await fakeRelay.next("ack_send_message");
    expect(messageAck.envelope.metadata?.job_id).toBe("future-job");
    expect(store.require("future-job").status).toBe("Cancelled");
    expect(store.require("future-job").cancelRequested).toBeTrue();
    expect(executionCount).toBe(0);
  });

  test("断开后把 Delivering 重置为 Pending，重连重放并完成 ACK", async () => {
    createPendingResult(store, "recover-job");
    let connectedCount = 0;
    const handlers = durableHandlers();
    handlers.onConnected = async () => { connectedCount += 1; };
    const relayClient = createClient(handlers);
    relayClient.start();
    const firstSocket = await fakeRelay.handshake(relayClient);

    const firstResult = await fakeRelay.next("send_result");
    expect(store.require("recover-job").outbox?.status).toBe("Delivering");
    await fakeRelay.disconnect(firstSocket);
    await waitFor(
      () => store.require("recover-job").outbox?.status === "Pending",
      1_000,
      "outbox reset after disconnect",
    );

    const secondSocket = await fakeRelay.handshake(relayClient, 3_000);
    const replayed = await fakeRelay.next("send_result");
    expect(replayed.envelope.metadata?.job_id).toBe("recover-job");
    expect(replayed.envelope.payload?.data).toBe(firstResult.envelope.payload?.data);
    expect(replayed.envelope.metadata?.msg_id).not.toBe(firstResult.envelope.metadata?.msg_id);

    fakeRelay.send(secondSocket, {
      type: "ack_send_result",
      metadata: { job_id: "recover-job" },
      payload: {},
    });
    await waitFor(
      () => store.require("recover-job").outbox?.status === "Delivered",
      1_000,
      "replayed result ACK",
    );
    expect(connectedCount).toBe(2);
  });
});
