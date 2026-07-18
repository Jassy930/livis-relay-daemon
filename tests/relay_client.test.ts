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
import { FakeLivisRelay, bounded, waitFor } from "./fake_livis.ts";
import {
  incomingJob,
  temporaryDirectory,
  testConfig,
  testProfile,
} from "./helpers.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
    const socket = await fakeRelay.handshake(() => relayClient.connected);

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
    const socket = await fakeRelay.handshake(() => relayClient.connected);

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
    const socket = await fakeRelay.handshake(() => relayClient.connected);

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
    const socket = await fakeRelay.handshake(() => relayClient.connected);

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

  test("cancel-before-message 先持久化意图，后到消息不执行并分别 ACK", async () => {
    let executionCount = 0;
    const relayClient = createClient(durableHandlers((_jobId, inserted) => {
      if (inserted && store.require(_jobId).status === "Acked") executionCount += 1;
    }));
    relayClient.start();
    const socket = await fakeRelay.handshake(() => relayClient.connected);

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
    const firstSocket = await fakeRelay.handshake(() => relayClient.connected);

    const firstResult = await fakeRelay.next("send_result");
    expect(store.require("recover-job").outbox?.status).toBe("Delivering");
    await fakeRelay.disconnect(firstSocket);
    await waitFor(
      () => store.require("recover-job").outbox?.status === "Pending",
      1_000,
      "outbox reset after disconnect",
    );

    const secondSocket = await fakeRelay.handshake(() => relayClient.connected, 3_000);
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
