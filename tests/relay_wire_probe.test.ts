import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { IdaasClient } from "../src/auth/idaas.ts";
import type { RelayConfig } from "../src/config.ts";
import type { RelayIdentity } from "../src/identity.ts";
import { Logger } from "../src/logger.ts";
import { serializeResult } from "../src/protocol/livis.ts";
import type { ProtocolProfile } from "../src/protocol/profile.ts";
import { RelayClient, type RelayClientHandlers } from "../src/relay/client.ts";
import { SecretStore } from "../src/secrets.ts";
import { JobStore } from "../src/state/store.ts";
import type { RelayEnvelope } from "../src/types.ts";
import { incomingJob, temporaryDirectory, testConfig, testProfile } from "./helpers.ts";
import {
  ProbeNormalizer,
  RELAY_PROBE_SENTINELS,
  ScriptedRelay,
  type ProbeCloseEvent,
  type ProbeControlEvent,
  type ProbeUpgradeEvent,
} from "./helpers/scripted_relay.ts";

const UUID_MARKER = /^<uuid:\d+>$/;
const TIMESTAMP_MARKER = /^<timestamp:\d+>$/;

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
  label = "条件",
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error(`等待 ${label} 超时（${timeoutMs} ms）`);
    }
    await Bun.sleep(2);
  }
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function incomingMessage(jobId: string): RelayEnvelope {
  return {
    type: "send_message",
    metadata: {
      job_id: jobId,
      msg_id: `message-${jobId}`,
      timestamp: 1_700_000_000_000,
    },
    payload: {
      from_node_id: RELAY_PROBE_SENTINELS.nodeId,
      from_node_type: "probe-device",
      data: { type: "exec", content: "本地 S2 probe 输入" },
    },
  };
}

function cancelMessage(jobId: string): RelayEnvelope {
  return {
    type: "cancel_chat",
    metadata: { job_id: jobId, msg_id: `cancel-${jobId}` },
    payload: {},
  };
}

function createPendingResult(store: JobStore, jobId: string): void {
  store.ingest(incomingJob(jobId, "本地 S2 probe 输入", RELAY_PROBE_SENTINELS.nodeId), `session-${jobId}`);
  store.markAcked(jobId);
  store.claimForDispatch(jobId, "probe-connector", `lease-${jobId}`);
  store.markRunning(jobId, "probe-connector", `lease-${jobId}`);
  store.finishSuccess(jobId, `lease-${jobId}`, serializeResult("本地 S2 probe 输出"));
}

describe("本地 Relay wire contract probe（S2，不代表真实服务端要求）", () => {
  let directory: Awaited<ReturnType<typeof temporaryDirectory>>;
  let relay: ScriptedRelay;
  let profile: ProtocolProfile;
  let config: RelayConfig;
  let identity: RelayIdentity;
  let secrets: SecretStore;
  let store: JobStore;
  let client: RelayClient | null;
  let authCalls: boolean[];
  let incomingJobIds: string[];
  let cancelledJobIds: string[];
  let connectedCount: number;

  beforeEach(async () => {
    directory = await temporaryDirectory("livis-relay-wire-probe-");
    relay = new ScriptedRelay();
    await relay.start();
    const baseProfile = await testProfile();
    profile = {
      ...baseProfile,
      endpoints: { ...baseProfile.endpoints, relayWebSocketUrl: relay.url },
      timing: {
        ...baseProfile.timing,
        heartbeatIntervalMs: 200,
        pongTimeoutMs: 1_000,
        resultAckTimeoutMs: 1_000,
        tokenRefreshAckTimeoutMs: 1_000,
      },
    };
    config = testConfig(directory.path);
    config.relay.nodeName = RELAY_PROBE_SENTINELS.nodeName;
    config.relay.handshakeTimeoutMs = 300;
    config.relay.reconnectMaxMs = 1_000;
    identity = {
      schemaVersion: 1,
      accountId: RELAY_PROBE_SENTINELS.accountId,
      agentId: RELAY_PROBE_SENTINELS.agentId,
      deviceId: RELAY_PROBE_SENTINELS.deviceId,
      createdAt: new Date(0).toISOString(),
    };
    secrets = new SecretStore(directory.path);
    await secrets.initialize();
    await secrets.setRefreshToken(RELAY_PROBE_SENTINELS.refreshToken);
    store = new JobStore(
      join(directory.path, "relay-probe.db"),
      `${RELAY_PROBE_SENTINELS.accountId}:${RELAY_PROBE_SENTINELS.agentId}`,
    );
    client = null;
    authCalls = [];
    incomingJobIds = [];
    cancelledJobIds = [];
    connectedCount = 0;
  });

  afterEach(async () => {
    if (client) await bounded(client.stop(), 1_000, "RelayClient.stop");
    await bounded(relay.stop(), 1_000, "ScriptedRelay.stop");
    store?.close();
    await directory.cleanup();
  });

  function setTiming(timing: Partial<ProtocolProfile["timing"]>): void {
    profile = { ...profile, timing: { ...profile.timing, ...timing } };
  }

  function createClient(overrides: Partial<RelayClientHandlers> = {}): RelayClient {
    const auth = {
      getAccessToken: async (forceRefresh = false) => {
        authCalls.push(forceRefresh);
        return forceRefresh
          ? RELAY_PROBE_SENTINELS.refreshedAccessToken
          : RELAY_PROBE_SENTINELS.accessToken;
      },
    } as unknown as IdaasClient;
    const handlers: RelayClientHandlers = {
      onIncoming: async (envelope) => {
        const jobId = envelope.metadata?.job_id;
        if (typeof jobId === "string") incomingJobIds.push(jobId);
      },
      onCancel: async (jobId) => {
        cancelledJobIds.push(jobId);
      },
      onConnected: async () => {
        connectedCount += 1;
      },
      ...overrides,
    };
    client = new RelayClient(
      config,
      profile,
      identity,
      secrets,
      auth,
      store,
      handlers,
      new Logger("test.relay-wire-probe", "error"),
    );
    return client;
  }

  async function completeHandshake(): Promise<{
    connectionId: string;
    connect: Awaited<ReturnType<ScriptedRelay["nextClientEnvelope"]>>;
  }> {
    const connect = await relay.nextClientEnvelope("connect");
    relay.sendEnvelope(connect.connectionId, {
      type: "connected",
      metadata: { job_id: connect.envelope.metadata?.job_id },
      payload: {},
    });
    await waitFor(() => client?.connected === true, 1_000, "Relay 握手完成");
    return { connectionId: connect.connectionId, connect };
  }

  test("[S2 当前 daemon 行为] 记录 query、控制帧和全部出站 envelope 字段", async () => {
    createPendingResult(store, "probe-result-job");
    const relayClient = createClient();
    relayClient.start();

    const upgrade = await relay.waitForEvent(
      (event): event is ProbeUpgradeEvent => event.kind === "upgrade",
    );
    const connect = await relay.nextClientEnvelope("connect");
    expect(upgrade.connectionId).toBe(connect.connectionId);
    expect(upgrade.path).toBe("/api/v1/ws");
    expect(upgrade.query).toEqual([["protocol_version", "1"]]);

    const connectedFrame = relay.sendEnvelope(connect.connectionId, {
      type: "connected",
      metadata: { job_id: connect.envelope.metadata?.job_id },
      payload: {},
    });
    await waitFor(() => relayClient.connected, 1_000, "Relay 握手完成");
    const result = await relay.nextClientEnvelope("send_result");

    const serverPing = relay.sendPing(connect.connectionId, "probe-control-frame");
    const daemonPong = await relay.waitForEvent(
      (event): event is ProbeControlEvent => (
        event.kind === "pong"
        && event.direction === "daemon->relay"
        && event.connectionId === connect.connectionId
      ),
      1_000,
      serverPing.sequence,
    );
    expect(daemonPong.data).toBe("probe-control-frame");

    relay.sendEnvelope(connect.connectionId, incomingMessage("probe-incoming-job"));
    const messageAck = await relay.nextClientEnvelope("ack_send_message");
    relay.sendEnvelope(connect.connectionId, cancelMessage("probe-cancel-job"));
    const cancelAck = await relay.nextClientEnvelope("ack_cancel_chat");
    relay.sendEnvelope(connect.connectionId, { type: "token_expiring", payload: {} });
    const tokenRefresh = await relay.nextClientEnvelope("token_refresh");
    const heartbeat = await relay.nextClientEnvelope("heartbeat");
    const daemonPing = await relay.waitForEvent(
      (event): event is ProbeControlEvent => (
        event.kind === "ping"
        && event.direction === "daemon->relay"
        && event.connectionId === connect.connectionId
      ),
      1_000,
      connectedFrame.sequence,
    );
    expect(daemonPing.data).toBe("");

    const normalizer = new ProbeNormalizer();
    const normalizedConnect = normalizer.normalizeEnvelope(connect.envelope);
    const normalizedConnected = normalizer.normalizeEnvelope(connectedFrame.envelope);
    const normalizedResult = normalizer.normalizeEnvelope(result.envelope);
    const normalizedMessageAck = normalizer.normalizeEnvelope(messageAck.envelope);
    const normalizedCancelAck = normalizer.normalizeEnvelope(cancelAck.envelope);
    const normalizedTokenRefresh = normalizer.normalizeEnvelope(tokenRefresh.envelope);
    const normalizedHeartbeat = normalizer.normalizeEnvelope(heartbeat.envelope);

    expect(normalizedConnect).toEqual({
      type: "connect",
      metadata: {
        msg_id: expect.stringMatching(UUID_MARKER),
        job_id: expect.stringMatching(UUID_MARKER),
        agent_id: RELAY_PROBE_SENTINELS.agentId,
        timestamp: expect.stringMatching(TIMESTAMP_MARKER),
      },
      payload: {
        device_id: RELAY_PROBE_SENTINELS.deviceId,
        node_name: RELAY_PROBE_SENTINELS.nodeName,
        node_desc: `${profile.wireIdentity.nodeType} ${RELAY_PROBE_SENTINELS.nodeName}`,
        client: profile.wireIdentity.client,
        token: "<access-token:1>",
        refresh_token: "<refresh-token:1>",
      },
    });
    expect(normalizedConnected.metadata?.job_id).toBe(normalizedConnect.metadata?.job_id);
    expect(normalizedResult).toEqual({
      type: "send_result",
      metadata: {
        msg_id: expect.stringMatching(UUID_MARKER),
        job_id: "probe-result-job",
        agent_id: RELAY_PROBE_SENTINELS.agentId,
        device_id: RELAY_PROBE_SENTINELS.deviceId,
        timestamp: expect.stringMatching(TIMESTAMP_MARKER),
        client: profile.wireIdentity.client,
      },
      payload: {
        data: serializeResult("本地 S2 probe 输出"),
        nodeType: profile.wireIdentity.nodeType,
      },
    });
    expect(normalizedMessageAck).toEqual({
      type: "ack_send_message",
      metadata: {
        msg_id: expect.stringMatching(UUID_MARKER),
        job_id: "probe-incoming-job",
        agent_id: RELAY_PROBE_SENTINELS.agentId,
        device_id: RELAY_PROBE_SENTINELS.deviceId,
        timestamp: expect.stringMatching(TIMESTAMP_MARKER),
        client: profile.wireIdentity.client,
      },
      payload: { nodeType: profile.wireIdentity.nodeType },
    });
    expect(normalizedCancelAck).toEqual({
      type: "ack_cancel_chat",
      metadata: {
        msg_id: expect.stringMatching(UUID_MARKER),
        job_id: "probe-cancel-job",
        agent_id: RELAY_PROBE_SENTINELS.agentId,
        device_id: RELAY_PROBE_SENTINELS.deviceId,
        timestamp: expect.stringMatching(TIMESTAMP_MARKER),
        client: profile.wireIdentity.client,
      },
      payload: { nodeType: profile.wireIdentity.nodeType },
    });
    expect(normalizedTokenRefresh).toEqual({
      type: "token_refresh",
      metadata: {
        msg_id: expect.stringMatching(UUID_MARKER),
        job_id: "",
        agent_id: RELAY_PROBE_SENTINELS.agentId,
        device_id: RELAY_PROBE_SENTINELS.deviceId,
        timestamp: expect.stringMatching(TIMESTAMP_MARKER),
        client: profile.wireIdentity.client,
      },
      payload: {
        token: "<access-token:2>",
        refresh_token: "<refresh-token:1>",
        nodeType: profile.wireIdentity.nodeType,
      },
    });
    expect(normalizedHeartbeat).toEqual({
      type: "heartbeat",
      metadata: {
        msg_id: expect.stringMatching(UUID_MARKER),
        job_id: expect.stringMatching(UUID_MARKER),
        agent_id: RELAY_PROBE_SENTINELS.agentId,
        device_id: RELAY_PROBE_SENTINELS.deviceId,
        timestamp: expect.stringMatching(TIMESTAMP_MARKER),
        client: profile.wireIdentity.client,
      },
      payload: { nodeType: profile.wireIdentity.nodeType },
    });
    expect(incomingJobIds).toEqual(["probe-incoming-job"]);
    expect(cancelledJobIds).toEqual(["probe-cancel-job"]);
    expect(authCalls).toEqual([false, true]);
    expect(connect.sequence).toBeGreaterThan(upgrade.sequence);
    expect(daemonPong.elapsedMs).toBeGreaterThanOrEqual(serverPing.elapsedMs);
    expect(heartbeat.elapsedMs).toBeGreaterThanOrEqual(connectedFrame.elapsedMs);
  });

  test("[S2 当前 daemon 行为] 握手前业务帧被拒绝但连接仍可继续握手", async () => {
    const relayClient = createClient();
    relayClient.start();
    const connect = await relay.nextClientEnvelope("connect");

    relay.sendEnvelope(connect.connectionId, incomingMessage("before-connected-job"));
    await Bun.sleep(30);
    expect(incomingJobIds).toEqual([]);
    expect(relay.clientTextCount("ack_send_message", connect.connectionId)).toBe(0);
    expect(relayClient.connected).toBeFalse();

    relay.sendEnvelope(connect.connectionId, {
      type: "connected",
      metadata: { job_id: connect.envelope.metadata?.job_id },
      payload: {},
    });
    await waitFor(() => relayClient.connected, 1_000, "握手前异常后的 connected");
    relay.sendEnvelope(connect.connectionId, incomingMessage("after-connected-job"));
    const ack = await relay.nextClientEnvelope("ack_send_message");
    expect(ack.envelope.metadata?.job_id).toBe("after-connected-job");
    expect(incomingJobIds).toEqual(["after-connected-job"]);
  });

  for (const scenario of [
    { label: "缺失关联 ID", metadata: undefined },
    { label: "关联 ID 错误", metadata: { job_id: "not-the-connect-job" } },
  ] as const) {
    test(`[S2 当前 daemon 行为] connected ${scenario.label}仍被接受`, async () => {
      const relayClient = createClient();
      relayClient.start();
      const connect = await relay.nextClientEnvelope("connect");
      relay.sendEnvelope(connect.connectionId, {
        type: "connected",
        ...(scenario.metadata ? { metadata: scenario.metadata } : {}),
        payload: {},
      });
      await waitFor(() => relayClient.connected, 1_000, `connected ${scenario.label}`);
      expect(relayClient.connected).toBeTrue();
      expect(connectedCount).toBe(1);
    });
  }

  test("[S2 当前 daemon 行为] Relay 静默时首次心跳 tick 在发帧前关闭", async () => {
    setTiming({ heartbeatIntervalMs: 60, pongTimeoutMs: 20 });
    const relayClient = createClient();
    relayClient.start();
    const { connectionId } = await completeHandshake();
    const close = await relay.waitForEvent(
      (event): event is ProbeCloseEvent => event.kind === "close" && event.connectionId === connectionId,
      500,
    );

    expect(close).toMatchObject({
      initiator: "daemon",
      code: 1000,
    });
    expect(relay.clientTextCount("heartbeat", connectionId)).toBe(0);
    expect(relay.events.some((event) => (
      event.kind === "ping"
      && event.direction === "daemon->relay"
      && event.connectionId === connectionId
    ))).toBeFalse();
    expect(close.elapsedMs).toBeGreaterThanOrEqual(40);
    await waitFor(() => !relayClient.connected, 500, "心跳超时状态清理");
  });

  test("[S2 当前 daemon 行为] 首次心跳前的可解析未知消息会续活且被忽略", async () => {
    // 无续活时 400ms > 300ms 会关闭；200ms 注入后到首次 tick 仍有约 100ms 双边裕量。
    setTiming({ heartbeatIntervalMs: 400, pongTimeoutMs: 300 });
    const relayClient = createClient();
    relayClient.start();
    const { connectionId } = await completeHandshake();

    await Bun.sleep(200);
    relay.sendEnvelope(connectionId, {
      type: "probe_unknown_keepalive",
      metadata: { probe_sequence: 1 },
      payload: {},
    });
    await relay.nextClientEnvelope("heartbeat", 800);

    expect(relayClient.connected).toBeTrue();
    expect(relay.clientTextCount("heartbeat", connectionId)).toBe(1);
    expect(relay.events.filter((event) => (
      event.kind === "ping"
      && event.direction === "daemon->relay"
      && event.connectionId === connectionId
    )).length).toBe(1);
    expect(relay.events.some((event) => event.kind === "close" && event.connectionId === connectionId)).toBeFalse();
    expect(incomingJobIds).toEqual([]);
    expect(cancelledJobIds).toEqual([]);
  });

  test("[S2 当前 daemon 行为] token_expiring 强制刷新，未关联 token_refreshed 可清除超时", async () => {
    setTiming({
      heartbeatIntervalMs: 1_000,
      pongTimeoutMs: 5_000,
      tokenRefreshAckTimeoutMs: 60,
      tokenRefreshMaxFailures: 1,
    });
    const relayClient = createClient();
    relayClient.start();
    const { connectionId } = await completeHandshake();

    relay.sendEnvelope(connectionId, { type: "token_expiring", payload: {} });
    const firstRefresh = await relay.nextClientEnvelope("token_refresh");
    expect(firstRefresh.envelope.payload).toEqual({
      token: RELAY_PROBE_SENTINELS.refreshedAccessToken,
      refresh_token: RELAY_PROBE_SENTINELS.refreshToken,
      nodeType: profile.wireIdentity.nodeType,
    });
    relay.sendEnvelope(connectionId, {
      type: "token_refreshed",
      metadata: { job_id: "unrelated-token-refresh" },
      payload: {},
    });
    await Bun.sleep(90);
    expect(relayClient.connected).toBeTrue();
    expect(relayClient.status().terminalFailure).toBeNull();

    relay.sendEnvelope(connectionId, { type: "token_expiring", payload: {} });
    await relay.nextClientEnvelope("token_refresh");
    const close = await relay.waitForEvent(
      (event): event is ProbeCloseEvent => event.kind === "close" && event.connectionId === connectionId,
      500,
    );
    expect(close).toMatchObject({
      initiator: "daemon",
      code: 1008,
    });
    expect(relay.clientTextCount("token_refresh", connectionId)).toBe(2);
    expect(authCalls).toEqual([false, true, true]);
    expect(relayClient.status().terminalFailure).toBe("token_refresh ACK 连续失败");
  });

  test("[S2 当前 daemon 行为] 断线清理握手、心跳、token 与 result ACK 定时状态", async () => {
    setTiming({
      heartbeatIntervalMs: 30,
      pongTimeoutMs: 1_000,
      resultAckTimeoutMs: 150,
      tokenRefreshAckTimeoutMs: 150,
      tokenRefreshMaxFailures: 1,
    });
    createPendingResult(store, "disconnect-result-job");
    const relayClient = createClient();
    relayClient.start();
    const { connectionId } = await completeHandshake();
    await relay.nextClientEnvelope("send_result");
    relay.sendEnvelope(connectionId, { type: "token_expiring", payload: {} });
    await relay.nextClientEnvelope("token_refresh");

    relay.closeConnection(connectionId, 1012, "probe forced disconnect");
    const close = await relay.waitForEvent(
      (event): event is ProbeCloseEvent => event.kind === "close" && event.connectionId === connectionId,
      500,
    );
    await waitFor(
      () => store.require("disconnect-result-job").outbox?.status === "Pending",
      500,
      "断线后 outbox 重置",
    );
    const clientFrameCountAfterClose = relay.clientTextCount(undefined, connectionId);
    await Bun.sleep(210);

    expect(close).toMatchObject({
      initiator: "relay",
      code: 1012,
      reason: "probe forced disconnect",
    });
    expect(relayClient.status()).toMatchObject({
      connected: false,
      handshakeComplete: false,
      terminalFailure: null,
    });
    expect(store.require("disconnect-result-job").outbox?.status).toBe("Pending");
    expect(relay.clientTextCount(undefined, connectionId)).toBe(clientFrameCountAfterClose);
  });
});
