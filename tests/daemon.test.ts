import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import WebSocket from "ws";
import type { IdaasClient } from "../src/auth/idaas.ts";
import type { RelayConfig } from "../src/config.ts";
import { RelayDaemon } from "../src/daemon.ts";
import type { RelayIdentity } from "../src/identity.ts";
import { IdentityStore } from "../src/identity.ts";
import { Logger } from "../src/logger.ts";
import type { ProtocolProfile } from "../src/protocol/profile.ts";
import { SecretStore } from "../src/secrets.ts";
import { JobStore } from "../src/state/store.ts";
import type { RelayEnvelope } from "../src/types.ts";
import type { UpstreamChecker, UpstreamSnapshot } from "../src/upstream/checker.ts";
import { FakeLivisRelay, bounded, waitFor } from "./fake_livis.ts";
import { temporaryDirectory, testConfig, testProfile } from "./helpers.ts";

function messageEnvelope(jobId: string, nodeId = "node-1", content = "hello"): RelayEnvelope {
  return {
    type: "send_message",
    metadata: { job_id: jobId, msg_id: `msg-${jobId}`, timestamp: 1_700_000_000_000 },
    payload: {
      from_node_id: nodeId,
      from_node_type: "phone",
      data: { type: "exec", content },
    },
  };
}

function supportedSnapshot(profile: ProtocolProfile): UpstreamSnapshot {
  return {
    checkedAt: new Date().toISOString(),
    activeProfileId: profile.id,
    compatibility: "supported",
    detectedVersion: profile.officialPluginVersion,
    setup: { url: profile.upstream.setupUrl, sha256: profile.upstream.setupSha256 },
    installPlugin: { url: profile.upstream.installPluginUrl, sha256: profile.upstream.installPluginSha256 },
    package: { url: profile.upstream.packageUrl, sha256: profile.upstream.packageSha256 },
    bundleMarkers: Object.fromEntries(
      profile.upstream.requiredBundleMarkers.map((marker) => [marker, true]),
    ),
    matchedProfileId: profile.id,
    reasons: [],
  };
}

interface FakeConnector {
  socket: WebSocket;
  read: () => Promise<Record<string, unknown>>;
  send: (message: Record<string, unknown>) => void;
  close: () => Promise<void>;
}

async function connectFakeConnector(
  socketPath: string,
  token: string,
  connectorId: string,
): Promise<FakeConnector> {
  const socket = new WebSocket(`ws+unix://${socketPath}:/v1/connectors/hermes`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const queued: Array<Record<string, unknown>> = [];
  const waiters: Array<(message: Record<string, unknown>) => void> = [];
  socket.on("message", (data) => {
    const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else queued.push(parsed);
  });
  const read = async () => {
    const message = queued.shift();
    if (message) return message;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const onMessage = (received: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(received);
      };
      const timer = setTimeout(() => {
        const index = waiters.indexOf(onMessage);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error("等待 connector 消息超时"));
      }, 2_000);
      waiters.push(onMessage);
    });
  };
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  expect((await read()).type).toBe("hello_required");
  socket.send(JSON.stringify({
    type: "hello",
    protocolVersion: 1,
    connectorId,
    backend: "hermes",
    implementation: { name: "livis-hermes-bridge", version: "0.1.0", runtimeVersion: "0.15.1" },
    capabilities: { cancel: true, finalResult: true },
  }));
  expect((await read()).type).toBe("hello_ack");
  return {
    socket,
    read,
    send: (message) => socket.send(JSON.stringify(message)),
    close: async () => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
        await new Promise((resolve) => socket.once("close", resolve));
      }
    },
  };
}

describe("RelayDaemon 编排：fake LiViS + 真 UDS connector", () => {
  let directory: Awaited<ReturnType<typeof temporaryDirectory>>;
  let fakeRelay: FakeLivisRelay;
  let profile: ProtocolProfile;
  let config: RelayConfig;
  let identity: RelayIdentity;
  let secrets: SecretStore;
  let connectorToken: string;
  let daemon: RelayDaemon | null;
  let readerStore: JobStore | null;
  let connector: FakeConnector | null;
  let checkerMode: "supported" | "drift" | "error";

  beforeEach(async () => {
    directory = await temporaryDirectory("livis-daemon-test-");
    fakeRelay = new FakeLivisRelay();
    await fakeRelay.start();
    const baseProfile = await testProfile();
    profile = {
      ...baseProfile,
      endpoints: { ...baseProfile.endpoints, relayWebSocketUrl: fakeRelay.url },
      timing: {
        ...baseProfile.timing,
        heartbeatIntervalMs: 10_000,
        pongTimeoutMs: 20_000,
        resultAckTimeoutMs: 500,
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
    const secretValues = await secrets.initialize();
    connectorToken = secretValues.connectorToken;
    await secrets.setRefreshToken("refresh-test");
    checkerMode = "supported";
    daemon = null;
    readerStore = null;
    connector = null;
  });

  afterEach(async () => {
    await connector?.close();
    if (daemon) await bounded(daemon.stop(), 2_000, "RelayDaemon.stop");
    readerStore?.close();
    await bounded(fakeRelay.stop(), 1_000, "FakeLivisRelay.stop");
    await directory.cleanup();
  });

  function createDaemon(options: { recheckIntervalMs?: number } = {}): RelayDaemon {
    const auth = {
      getAccessToken: async () => "access-test",
    } as unknown as IdaasClient;
    const upstreamChecker = {
      check: async () => {
        if (checkerMode === "error") throw new Error("fake upstream check failure");
        const snapshot = supportedSnapshot(profile);
        return checkerMode === "supported"
          ? snapshot
          : { ...snapshot, compatibility: "drift" as const, matchedProfileId: null };
      },
    } as unknown as UpstreamChecker;
    daemon = RelayDaemon.create({
      config,
      profile,
      identity,
      secrets,
      secretValues: { schemaVersion: 1, connectorToken, refreshToken: "refresh-test" },
      upstreamProofExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
      logger: new Logger("test.daemon", "error"),
      auth,
      upstreamChecker,
      upstreamRecheckIntervalMs: options.recheckIntervalMs ?? 60 * 60 * 1000,
    });
    return daemon;
  }

  function openReaderStore(): JobStore {
    readerStore = new JobStore(
      join(config.stateDir, "relay.db"),
      IdentityStore.scopeKey(identity),
    );
    return readerStore;
  }

  test("send_message 到 ack_send_result 的端到端闭环", async () => {
    createDaemon().start();
    const relaySocket = await fakeRelay.handshake(
      () => (daemon!.status().relay as Record<string, unknown>).connected === true,
    );
    connector = await connectFakeConnector(config.connector.socketPath, connectorToken, "hermes-e2e");
    const store = openReaderStore();

    fakeRelay.send(relaySocket, messageEnvelope("job-e2e"));
    const offered = await connector.read();
    expect(offered.type).toBe("job");
    const job = offered.job as Record<string, unknown>;
    expect(job.jobId).toBe("job-e2e");
    const leaseId = job.leaseId as string;

    expect((await fakeRelay.next("ack_send_message")).envelope.metadata?.job_id).toBe("job-e2e");
    connector.send({ type: "accepted", jobId: "job-e2e", leaseId });
    connector.send({ type: "result", jobId: "job-e2e", leaseId, text: "执行完成" });
    const stored = await connector.read();
    expect(stored).toEqual({ type: "result_stored", jobId: "job-e2e", leaseId });

    const delivered = await fakeRelay.next("send_result");
    expect(delivered.envelope.metadata?.job_id).toBe("job-e2e");
    expect(delivered.envelope.payload?.data).toBe(JSON.stringify({ text: "执行完成" }));
    fakeRelay.send(relaySocket, {
      type: "ack_send_result",
      metadata: { job_id: "job-e2e" },
      payload: {},
    });
    await waitFor(
      () => store.get("job-e2e")?.outbox?.status === "Delivered",
      2_000,
      "outbox delivered",
    );
    expect(store.require("job-e2e").status).toBe("Succeeded");
  });

  test("cancel 竞争获胜：final 收到 cancel_superseded，session 进入隔离", async () => {
    createDaemon().start();
    const relaySocket = await fakeRelay.handshake(
      () => (daemon!.status().relay as Record<string, unknown>).connected === true,
    );
    connector = await connectFakeConnector(config.connector.socketPath, connectorToken, "hermes-cancel");
    const store = openReaderStore();

    fakeRelay.send(relaySocket, messageEnvelope("job-cancel"));
    const offered = await connector.read();
    const leaseId = (offered.job as Record<string, unknown>).leaseId as string;
    connector.send({ type: "accepted", jobId: "job-cancel", leaseId });
    await waitFor(() => store.get("job-cancel")?.status === "Running", 2_000, "job running");

    fakeRelay.send(relaySocket, {
      type: "cancel_chat",
      metadata: { job_id: "job-cancel", msg_id: "cancel-1" },
      payload: {},
    });
    const cancelMessage = await connector.read();
    expect(cancelMessage).toEqual({
      type: "cancel",
      protocolVersion: 1,
      jobId: "job-cancel",
      leaseId,
    });
    expect((await fakeRelay.next("ack_cancel_chat")).envelope.metadata?.job_id).toBe("job-cancel");

    // 模拟竞争：cancel 已在 daemon 侧获胜后，connector 仍上报 final。
    connector.send({ type: "result", jobId: "job-cancel", leaseId, text: "迟到的结果" });
    const rejected = await connector.read();
    expect(rejected.type).toBe("error");
    expect(rejected.code).toBe("cancel_superseded");

    connector.send({ type: "cancelled", jobId: "job-cancel", leaseId });
    await waitFor(() => store.get("job-cancel")?.status === "CancelUnknown", 2_000, "cancel unknown");
    const quarantined = store.listQuarantinedSessions();
    expect(quarantined).toHaveLength(1);
    expect(daemon!.releaseSessionQuarantine(quarantined[0]!.sessionKey)).toBeTrue();
  });

  test("connector 断开把执行中 job 标记 Interrupted 并隔离 session", async () => {
    createDaemon().start();
    const relaySocket = await fakeRelay.handshake(
      () => (daemon!.status().relay as Record<string, unknown>).connected === true,
    );
    connector = await connectFakeConnector(config.connector.socketPath, connectorToken, "hermes-drop");
    const store = openReaderStore();

    fakeRelay.send(relaySocket, messageEnvelope("job-drop"));
    const offered = await connector.read();
    const leaseId = (offered.job as Record<string, unknown>).leaseId as string;
    connector.send({ type: "accepted", jobId: "job-drop", leaseId });
    await waitFor(() => store.get("job-drop")?.status === "Running", 2_000, "job running");

    await connector.close();
    await waitFor(() => store.get("job-drop")?.status === "Interrupted", 2_000, "job interrupted");
    expect(store.listQuarantinedSessions()).toHaveLength(1);
  });

  test("未授权 node 的 job 被拒绝并投递拒绝话术", async () => {
    createDaemon().start();
    const relaySocket = await fakeRelay.handshake(
      () => (daemon!.status().relay as Record<string, unknown>).connected === true,
    );
    connector = await connectFakeConnector(config.connector.socketPath, connectorToken, "hermes-authz");
    const store = openReaderStore();

    fakeRelay.send(relaySocket, messageEnvelope("job-evil", "node-evil"));
    expect((await fakeRelay.next("ack_send_message")).envelope.metadata?.job_id).toBe("job-evil");
    const delivered = await fakeRelay.next("send_result");
    expect(delivered.envelope.metadata?.job_id).toBe("job-evil");
    expect(delivered.envelope.payload?.data).toBe(
      JSON.stringify({ text: config.security.unauthorizedMessage }),
    );
    expect(store.require("job-evil").status).toBe("Rejected");
  });

  test("upstream 门禁关闭后断开 relay，恢复 supported 时自动重连", async () => {
    createDaemon({ recheckIntervalMs: 50 }).start();
    await fakeRelay.handshake(
      () => (daemon!.status().relay as Record<string, unknown>).connected === true,
    );

    checkerMode = "drift";
    await waitFor(
      () => (daemon!.status().upstream as Record<string, unknown>).blocked !== null,
      2_000,
      "upstream blocked",
    );
    await waitFor(() => fakeRelay.connectionCount() === 0, 2_000, "relay disconnected");

    checkerMode = "supported";
    await fakeRelay.handshake(
      () => (daemon!.status().relay as Record<string, unknown>).connected === true,
      3_000,
    );
    expect((daemon!.status().upstream as Record<string, unknown>).blocked).toBeNull();
  });
});
