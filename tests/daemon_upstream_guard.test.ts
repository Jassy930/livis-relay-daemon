import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { RelayDaemon, type RelayDaemonTestHooks } from "../src/daemon.ts";
import type { RelayIdentity } from "../src/identity.ts";
import { Logger } from "../src/logger.ts";
import { SecretStore } from "../src/secrets.ts";
import { ProfileOperationGuard } from "../src/state/offline-guard.ts";
import type { JobStore } from "../src/state/store.ts";
import type { ConnectorInboundMessage, RelayEnvelope, StoredJob } from "../src/types.ts";
import type { UpstreamSnapshot } from "../src/upstream/checker.ts";
import { supportedProofPath, UPSTREAM_PROOF_MAX_AGE_MS } from "../src/upstream/proof.ts";
import { atomicWritePrivate, sha256 } from "../src/util.ts";
import { incomingJob, temporaryDirectory, testConfig, testProfile } from "./helpers.ts";

function supportedSnapshot(profile: Awaited<ReturnType<typeof testProfile>>): UpstreamSnapshot {
  return {
    checkedAt: "2026-07-18T12:00:00.000Z",
    activeProfileId: profile.id,
    compatibility: "supported",
    detectedVersion: profile.officialPluginVersion,
    setup: { url: profile.upstream.setupUrl, sha256: profile.upstream.setupSha256 },
    installPlugin: {
      url: profile.upstream.installPluginUrl,
      sha256: profile.upstream.installPluginSha256,
    },
    package: { url: profile.upstream.packageUrl, sha256: profile.upstream.packageSha256 },
    bundleMarkers: Object.fromEntries(profile.upstream.requiredBundleMarkers.map((marker) => [marker, true])),
    matchedProfileId: profile.id,
    reasons: ["test"],
  };
}

interface DaemonInternals {
  recheckUpstream(): Promise<void>;
  onRelayConnected(): Promise<void>;
  onRelayIncoming(envelope: RelayEnvelope): Promise<void>;
  dispatchPending(): Promise<void>;
  onConnectorFailed(
    message: Extract<ConnectorInboundMessage, { type: "failed" }>,
    connectorId: string,
  ): Promise<void>;
  armUpstreamProofExpiry(): boolean;
  isUpstreamProofExpired(now?: number): boolean;
  upstreamChecker: { check(): Promise<UpstreamSnapshot> };
  upstreamProofExpiresAt: number;
  upstreamExpiryTimer: ReturnType<typeof setTimeout> | null;
  upstreamBlockPromise: Promise<void> | null;
  upstreamBlocked: string | null;
  upstreamRelayStopped: boolean;
  connector: {
    readonly ready: boolean;
    readonly connectorId: string | null;
    sendJob(job: StoredJob): boolean;
    acknowledgeResult(jobId: string, leaseId: string): void;
    stop(): void;
  };
  relay: {
    start(): void;
    stop(): Promise<void>;
    notifyOutboxPending(): Promise<void>;
  };
  store: JobStore;
}

describe("daemon connector failed durable transition", () => {
  test("v1 failed 可从 Dispatching 持久化失败并在 durable outbox 后确认同一 lease", async () => {
    const fixture = await createDaemonFixture(
      "livis-daemon-connector-failed-",
      Date.now() + 60_000,
    );
    try {
      const jobId = "remote-input-rejected";
      const leaseId = "lease-remote-input-rejected";
      fixture.internals.store.ingest(incomingJob(jobId), "livis:test-agent-id");
      fixture.internals.store.markAcked(jobId);
      const claimed = fixture.internals.store.claimForDispatch(
        jobId,
        "hermes-test",
        leaseId,
      );
      expect(claimed?.status).toBe("Dispatching");

      const acknowledgements: Array<{
        jobId: string;
        leaseId: string;
        status: string;
        outboxStatus: string | undefined;
      }> = [];
      let notifications = 0;
      fixture.internals.connector.acknowledgeResult = (ackJobId, ackLeaseId) => {
        const durable = fixture.internals.store.require(ackJobId);
        acknowledgements.push({
          jobId: ackJobId,
          leaseId: ackLeaseId,
          status: durable.status,
          outboxStatus: durable.outbox?.status,
        });
      };
      fixture.internals.relay.notifyOutboxPending = async () => {
        notifications += 1;
      };

      await fixture.internals.onConnectorFailed({
        type: "failed",
        jobId,
        leaseId,
        error: "LiViS 远程渠道不允许执行 Hermes 命令",
        retryable: false,
      }, "hermes-test");

      const failed = fixture.internals.store.require(jobId);
      expect(failed.status).toBe("Failed");
      expect(failed.leaseId).toBe(leaseId);
      expect(failed.error).toBe("LiViS 远程渠道不允许执行 Hermes 命令");
      expect(failed.outbox?.status).toBe("Pending");
      expect(JSON.parse(failed.outbox!.resultJson)).toEqual({
        text: "Hermes 暂时无法完成该请求，请稍后重试。",
      });
      expect(acknowledgements).toEqual([{
        jobId,
        leaseId,
        status: "Failed",
        outboxStatus: "Pending",
      }]);
      expect(notifications).toBe(1);
    } finally {
      await cleanupDaemonFixture(fixture);
    }
  });
});

interface DaemonFixture {
  directory: Awaited<ReturnType<typeof temporaryDirectory>>;
  profile: Awaited<ReturnType<typeof testProfile>>;
  config: ReturnType<typeof testConfig>;
  daemon: RelayDaemon;
  internals: DaemonInternals;
}

interface ManualProofClock {
  hooks: RelayDaemonTestHooks;
  scheduledDelay: () => number | null;
  fireAt: (now: number) => void;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function manualProofClock(initialNow: number): ManualProofClock {
  let now = initialNow;
  let scheduled: {
    token: ReturnType<typeof setTimeout>;
    callback: () => void;
    delayMs: number;
  } | null = null;
  return {
    hooks: {
      now: () => now,
      setProofExpiryTimer: (callback, delayMs) => {
        const token = {
          unref: () => token,
        } as unknown as ReturnType<typeof setTimeout>;
        scheduled = { token, callback, delayMs };
        return token;
      },
      clearProofExpiryTimer: (token) => {
        if (scheduled?.token === token) scheduled = null;
      },
    },
    scheduledDelay: () => scheduled?.delayMs ?? null,
    fireAt: (nextNow) => {
      now = nextNow;
      const current = scheduled;
      scheduled = null;
      if (!current) throw new Error("proof expiry timer 未处于 armed 状态");
      current.callback();
    },
  };
}

function messageEnvelope(jobId: string): RelayEnvelope {
  return {
    type: "send_message",
    metadata: {
      job_id: jobId,
      msg_id: `msg-${jobId}`,
      timestamp: 1_700_000_000_000,
    },
    payload: {
      from_node_id: "node-1",
      from_node_type: "phone",
      data: { type: "exec", content: "hello" },
    },
  };
}

async function createDaemonFixture(
  prefix: string,
  upstreamProofExpiresAt: number,
  testHooks?: RelayDaemonTestHooks,
): Promise<DaemonFixture> {
  const directory = await temporaryDirectory(prefix);
  const profile = await testProfile();
  const profileText = `${JSON.stringify(profile, null, 2)}\n`;
  const profilePath = join(directory.path, "protocol-profiles", "active.json");
  await atomicWritePrivate(profilePath, profileText);
  const config = {
    ...testConfig(directory.path),
    profile: profilePath,
    profileSha256: sha256(profileText),
  };
  const identity: RelayIdentity = {
    schemaVersion: 1,
    accountId: "account",
    agentId: `${profile.wireIdentity.agentIdPrefix}agent`,
    deviceId: `${profile.wireIdentity.deviceIdPrefix}device`,
    createdAt: "2026-07-18T00:00:00.000Z",
  };
  const secrets = new SecretStore(directory.path);
  await secrets.initialize();
  const secretValues = await secrets.load();
  const daemon = RelayDaemon.create({
    config,
    profile,
    identity,
    secrets,
    secretValues,
    upstreamProofExpiresAt,
    logger: new Logger("test.daemon-proof-deadline", "error"),
    testHooks,
  });
  return {
    directory,
    profile,
    config,
    daemon,
    internals: daemon as unknown as DaemonInternals,
  };
}

async function cleanupDaemonFixture(fixture: DaemonFixture): Promise<void> {
  await fixture.daemon.stop().catch(() => undefined);
  await fixture.directory.cleanup();
}

describe("daemon upstream proof writer guard", () => {
  test("周期复核遇到同一 ProfileOperationGuard 时跳过，释放后才写 proof", async () => {
    const directory = await temporaryDirectory("livis-daemon-proof-guard-");
    let daemon: RelayDaemon | null = null;
    try {
      const profile = await testProfile();
      const profileText = `${JSON.stringify(profile, null, 2)}\n`;
      const profilePath = join(directory.path, "protocol-profiles", "active.json");
      await atomicWritePrivate(profilePath, profileText);
      const config = {
        ...testConfig(directory.path),
        profile: profilePath,
        profileSha256: sha256(profileText),
      };
      const identity: RelayIdentity = {
        schemaVersion: 1,
        accountId: "account",
        agentId: `${profile.wireIdentity.agentIdPrefix}agent`,
        deviceId: `${profile.wireIdentity.deviceIdPrefix}device`,
        createdAt: "2026-07-18T00:00:00.000Z",
      };
      const secrets = new SecretStore(directory.path);
      await secrets.initialize();
      const secretValues = await secrets.load();
      daemon = RelayDaemon.create({
        config,
        profile,
        identity,
        secrets,
        secretValues,
        upstreamProofExpiresAt: Date.now() + 60_000,
        logger: new Logger("test.daemon-proof-guard", "error"),
      });
      let checks = 0;
      const internals = daemon as unknown as {
        recheckUpstream(): Promise<void>;
        upstreamChecker: { check(): Promise<UpstreamSnapshot> };
      };
      internals.upstreamChecker.check = async () => {
        checks += 1;
        return supportedSnapshot(profile);
      };

      const guard = await ProfileOperationGuard.acquire(directory.path, "upstream-activate");
      try {
        await internals.recheckUpstream();
        expect(checks).toBe(0);
        expect(await Bun.file(supportedProofPath(directory.path, config.profileSha256)).exists()).toBeFalse();
      } finally {
        await guard.release();
      }

      await internals.recheckUpstream();
      expect(checks).toBe(1);
      expect(await Bun.file(supportedProofPath(directory.path, config.profileSha256)).exists()).toBeTrue();
    } finally {
      if (daemon) await daemon.stop();
      await directory.cleanup();
    }
  });

  test("guard 被占用且 proof 已过期时仍关闭 upstream 门禁", async () => {
    const directory = await temporaryDirectory("livis-daemon-proof-expired-guard-");
    let daemon: RelayDaemon | null = null;
    try {
      const profile = await testProfile();
      const profileText = `${JSON.stringify(profile, null, 2)}\n`;
      const profilePath = join(directory.path, "protocol-profiles", "active.json");
      await atomicWritePrivate(profilePath, profileText);
      const config = {
        ...testConfig(directory.path),
        profile: profilePath,
        profileSha256: sha256(profileText),
      };
      const identity: RelayIdentity = {
        schemaVersion: 1,
        accountId: "account",
        agentId: `${profile.wireIdentity.agentIdPrefix}agent`,
        deviceId: `${profile.wireIdentity.deviceIdPrefix}device`,
        createdAt: "2026-07-18T00:00:00.000Z",
      };
      const secrets = new SecretStore(directory.path);
      await secrets.initialize();
      const secretValues = await secrets.load();
      daemon = RelayDaemon.create({
        config,
        profile,
        identity,
        secrets,
        secretValues,
        upstreamProofExpiresAt: Date.now() - 1,
        logger: new Logger("test.daemon-proof-expired-guard", "error"),
      });
      let checks = 0;
      const internals = daemon as unknown as {
        recheckUpstream(): Promise<void>;
        upstreamChecker: { check(): Promise<UpstreamSnapshot> };
      };
      internals.upstreamChecker.check = async () => {
        checks += 1;
        return supportedSnapshot(profile);
      };

      const guard = await ProfileOperationGuard.acquire(directory.path, "upstream-activate");
      try {
        await internals.recheckUpstream();
        expect(checks).toBe(0);
        expect(daemon.status()).toMatchObject({
          upstream: {
            profile: profile.id,
            proofExpiresAt: expect.any(String),
            blocked: "profile operation guard 被占用且 supported proof 已过期",
          },
        });
        expect(await Bun.file(supportedProofPath(directory.path, config.profileSha256)).exists()).toBeFalse();
      } finally {
        await guard.release();
      }
    } finally {
      if (daemon) await daemon.stop();
      await directory.cleanup();
    }
  });

  test("timer 未触发时 admission 与 dispatch 仍按绝对 expiresAt 失败关闭", async () => {
    const clock = manualProofClock(10_000);
    const fixture = await createDaemonFixture(
      "livis-daemon-proof-absolute-gate-",
      10_000,
      clock.hooks,
    );
    try {
      let relayStops = 0;
      let ingestCalls = 0;
      let ackCalls = 0;
      let listCalls = 0;
      fixture.internals.relay.stop = async () => {
        relayStops += 1;
      };
      fixture.internals.store.ingest = () => {
        ingestCalls += 1;
        throw new Error("expired admission 不应 ingest");
      };
      fixture.internals.store.markAcked = () => {
        ackCalls += 1;
        throw new Error("expired admission 不应 ACK");
      };
      fixture.internals.store.listDispatchable = () => {
        listCalls += 1;
        return [];
      };

      expect(fixture.internals.upstreamExpiryTimer).toBeNull();
      await expect(fixture.internals.onRelayIncoming(messageEnvelope("expired-admission")))
        .rejects.toThrow("supported proof 已过期");
      await fixture.internals.dispatchPending();

      expect(ingestCalls).toBe(0);
      expect(ackCalls).toBe(0);
      expect(listCalls).toBe(0);
      expect(relayStops).toBe(1);
      expect(fixture.internals.upstreamBlocked).toContain("supported proof 已过期");
    } finally {
      await cleanupDaemonFixture(fixture);
    }
  });

  test("relay.stop 首次失败后保持门禁，并由下一次 dispatch 重试停止", async () => {
    const clock = manualProofClock(15_000);
    const fixture = await createDaemonFixture(
      "livis-daemon-proof-stop-retry-",
      15_000,
      clock.hooks,
    );
    try {
      const firstStopError = new Error("synthetic first relay stop failure");
      const retryStop = deferred<void>();
      let relayStops = 0;
      let ingestCalls = 0;
      let listCalls = 0;
      fixture.internals.relay.stop = () => {
        relayStops += 1;
        return relayStops === 1 ? Promise.reject(firstStopError) : retryStop.promise;
      };
      fixture.internals.store.ingest = () => {
        ingestCalls += 1;
        throw new Error("blocked admission 不应 ingest");
      };
      fixture.internals.store.listDispatchable = () => {
        listCalls += 1;
        return [];
      };

      await expect(fixture.internals.onRelayIncoming(messageEnvelope("stop-retry-first")))
        .rejects.toBe(firstStopError);
      expect(fixture.internals.upstreamBlocked).toContain("supported proof 已过期");
      expect(fixture.internals.upstreamRelayStopped).toBeFalse();
      expect(fixture.internals.upstreamBlockPromise).toBeNull();
      expect(ingestCalls).toBe(0);

      const firstRetry = fixture.internals.dispatchPending();
      const sameInflightRetry = fixture.internals.dispatchPending();
      expect(relayStops).toBe(2);
      expect(fixture.internals.upstreamBlockPromise).not.toBeNull();
      retryStop.resolve(undefined);
      await Promise.all([firstRetry, sameInflightRetry]);
      expect(fixture.internals.upstreamRelayStopped).toBeTrue();
      expect(fixture.internals.upstreamBlocked).toContain("supported proof 已过期");
      expect(listCalls).toBe(0);

      await expect(fixture.internals.onRelayIncoming(messageEnvelope("stop-retry-confirmed")))
        .rejects.toThrow("supported proof 已过期");
      expect(relayStops).toBe(2);
      expect(ingestCalls).toBe(0);
    } finally {
      await cleanupDaemonFixture(fixture);
    }
  });

  test("connected 回调入口已过期时先关门发起 stop，再于 stop 完成前返回", async () => {
    const clock = manualProofClock(16_000);
    const fixture = await createDaemonFixture(
      "livis-daemon-proof-connected-expired-",
      16_000,
      clock.hooks,
    );
    try {
      const stopRelease = deferred<void>();
      let relayStops = 0;
      let listCalls = 0;
      fixture.internals.relay.stop = () => {
        relayStops += 1;
        return stopRelease.promise;
      };
      fixture.internals.store.listDispatchable = () => {
        listCalls += 1;
        return [];
      };

      let callbackReturned = false;
      const connected = fixture.internals.onRelayConnected();
      void connected.then(
        () => { callbackReturned = true; },
        () => { callbackReturned = true; },
      );
      await Bun.sleep(0);
      const returnedBeforeStop = callbackReturned;
      const inFlightStop = fixture.internals.upstreamBlockPromise;
      stopRelease.resolve(undefined);
      await connected;
      await inFlightStop;

      expect(returnedBeforeStop).toBeTrue();
      expect(relayStops).toBe(1);
      expect(listCalls).toBe(0);
      expect(fixture.internals.upstreamBlocked).toContain("supported proof 已过期");
      expect(fixture.internals.upstreamRelayStopped).toBeTrue();
    } finally {
      await cleanupDaemonFixture(fixture);
    }
  });

  test("connected 回调在 claim 后临界到期时 reset lease，且不自等待 stop", async () => {
    const fixture = await createDaemonFixture(
      "livis-daemon-proof-connected-claim-expiry-",
      Date.now() + 60_000,
    );
    try {
      const jobId = "connected-claim-cross-expiry";
      fixture.internals.store.ingest(incomingJob(jobId), "session-connected-claim-expiry");
      fixture.internals.store.markAcked(jobId);
      Object.defineProperties(fixture.internals.connector, {
        ready: { configurable: true, value: true },
        connectorId: { configurable: true, value: "connector-connected-deadline-test" },
      });
      const stopRelease = deferred<void>();
      let expiryChecks = 0;
      let sendCalls = 0;
      let relayStops = 0;
      fixture.internals.isUpstreamProofExpired = () => {
        expiryChecks += 1;
        return expiryChecks >= 3;
      };
      fixture.internals.connector.sendJob = () => {
        sendCalls += 1;
        return true;
      };
      fixture.internals.relay.stop = () => {
        relayStops += 1;
        return stopRelease.promise;
      };

      let callbackReturned = false;
      const connected = fixture.internals.onRelayConnected();
      void connected.then(
        () => { callbackReturned = true; },
        () => { callbackReturned = true; },
      );
      await Bun.sleep(0);
      const returnedBeforeStop = callbackReturned;
      const inFlightStop = fixture.internals.upstreamBlockPromise;
      stopRelease.resolve(undefined);
      await connected;
      await inFlightStop;

      const reset = fixture.internals.store.require(jobId);
      expect(returnedBeforeStop).toBeTrue();
      expect(expiryChecks).toBe(3);
      expect(reset.status).toBe("Acked");
      expect(reset.connectorId).toBeNull();
      expect(reset.leaseId).toBeNull();
      expect(sendCalls).toBe(0);
      expect(relayStops).toBe(1);
      expect(fixture.internals.upstreamBlocked).toContain("supported proof 已过期");
    } finally {
      await cleanupDaemonFixture(fixture);
    }
  });

  test("已有 blocker 的周期复核先重试 relay.stop，停止成功后才访问 upstream", async () => {
    const fixture = await createDaemonFixture(
      "livis-daemon-proof-recheck-stop-first-",
      Date.now() + 60_000,
    );
    try {
      const firstStopError = new Error("synthetic previous blocker stop failure");
      let relayStops = 0;
      let checks = 0;
      let relayStarts = 0;
      fixture.internals.upstreamBlocked = "前次 relay.stop 失败留下的 blocker";
      fixture.internals.relay.stop = () => {
        relayStops += 1;
        return relayStops === 1 ? Promise.reject(firstStopError) : Promise.resolve();
      };
      fixture.internals.upstreamChecker.check = async () => {
        checks += 1;
        expect(relayStops).toBe(2);
        return supportedSnapshot(fixture.profile);
      };
      fixture.internals.relay.start = () => {
        relayStarts += 1;
      };
      fixture.internals.dispatchPending = async () => undefined;

      await fixture.internals.recheckUpstream();
      expect(relayStops).toBe(1);
      expect(checks).toBe(0);
      expect(fixture.internals.upstreamBlocked).toContain("前次 relay.stop 失败");
      expect(fixture.internals.upstreamRelayStopped).toBeFalse();

      await fixture.internals.recheckUpstream();
      expect(relayStops).toBe(2);
      expect(checks).toBe(1);
      expect(fixture.internals.upstreamBlocked).toBeNull();
      expect(fixture.internals.upstreamRelayStopped).toBeFalse();
      expect(relayStarts).toBe(1);
    } finally {
      await cleanupDaemonFixture(fixture);
    }
  });

  for (const scenario of ["guard busy", "network failure"] as const) {
    test(`到期前 ${scenario} 不会取消 proof deadline，到期后同步门禁仍生效`, async () => {
      const clock = manualProofClock(20_000);
      const expiresAt = 20_100;
      const fixture = await createDaemonFixture(
        `livis-daemon-proof-${scenario.replace(" ", "-")}-`,
        expiresAt,
        clock.hooks,
      );
      let competingGuard: ProfileOperationGuard | null = null;
      try {
        let checks = 0;
        let relayStops = 0;
        fixture.internals.relay.stop = async () => {
          relayStops += 1;
        };
        fixture.internals.upstreamChecker.check = async () => {
          checks += 1;
          if (scenario === "network failure") throw new Error("synthetic upstream network failure");
          return supportedSnapshot(fixture.profile);
        };
        expect(fixture.internals.armUpstreamProofExpiry()).toBeTrue();
        if (scenario === "guard busy") {
          competingGuard = await ProfileOperationGuard.acquire(
            fixture.directory.path,
            "upstream-activate",
          );
        }

        await fixture.internals.recheckUpstream();
        expect(checks).toBe(scenario === "guard busy" ? 0 : 1);
        expect(fixture.internals.upstreamBlocked).toBeNull();
        expect(clock.scheduledDelay()).toBe(100);
        if (competingGuard) {
          await competingGuard.release();
          competingGuard = null;
        }

        clock.fireAt(expiresAt);
        expect(fixture.internals.upstreamBlocked).toContain("supported proof 已过期");
        expect(relayStops).toBe(1);
        expect(await Bun.file(
          supportedProofPath(fixture.directory.path, fixture.config.profileSha256),
        ).exists()).toBeFalse();

        let ingestCalls = 0;
        let ackCalls = 0;
        let listCalls = 0;
        fixture.internals.store.ingest = () => {
          ingestCalls += 1;
          throw new Error("expired admission 不应 ingest");
        };
        fixture.internals.store.markAcked = () => {
          ackCalls += 1;
          throw new Error("expired admission 不应 ACK");
        };
        fixture.internals.store.listDispatchable = () => {
          listCalls += 1;
          return [];
        };
        await expect(fixture.internals.onRelayIncoming(messageEnvelope(`expired-${scenario}`)))
          .rejects.toThrow("supported proof 已过期");
        await fixture.internals.dispatchPending();
        expect(ingestCalls).toBe(0);
        expect(ackCalls).toBe(0);
        expect(listCalls).toBe(0);
      } finally {
        if (competingGuard) await competingGuard.release().catch(() => undefined);
        await cleanupDaemonFixture(fixture);
      }
    });
  }

  test("在途复核跨过旧 deadline 时先关闭，写入新 proof 后才恢复", async () => {
    const clock = manualProofClock(30_000);
    const expiresAt = 30_100;
    const fixture = await createDaemonFixture(
      "livis-daemon-proof-inflight-expiry-",
      expiresAt,
      clock.hooks,
    );
    try {
      const checkerEntered = deferred<void>();
      const checkerResult = deferred<UpstreamSnapshot>();
      let relayStarts = 0;
      let relayStops = 0;
      let dispatchCalls = 0;
      let proofExistedAtStart = false;
      const proofPath = supportedProofPath(
        fixture.directory.path,
        fixture.config.profileSha256,
      );
      fixture.internals.upstreamChecker.check = async () => {
        checkerEntered.resolve(undefined);
        return checkerResult.promise;
      };
      fixture.internals.relay.stop = async () => {
        relayStops += 1;
      };
      fixture.internals.relay.start = () => {
        relayStarts += 1;
        proofExistedAtStart = existsSync(proofPath);
      };
      fixture.internals.dispatchPending = async () => {
        dispatchCalls += 1;
      };

      expect(fixture.internals.armUpstreamProofExpiry()).toBeTrue();
      const recheck = fixture.internals.recheckUpstream();
      await checkerEntered.promise;
      clock.fireAt(expiresAt);
      expect(fixture.internals.upstreamBlocked).toContain("supported proof 已过期");
      expect(relayStarts).toBe(0);
      expect(await Bun.file(proofPath).exists()).toBeFalse();

      checkerResult.resolve(supportedSnapshot(fixture.profile));
      await recheck;
      expect(await Bun.file(proofPath).exists()).toBeTrue();
      expect(fixture.internals.upstreamBlocked).toBeNull();
      expect(proofExistedAtStart).toBeTrue();
      expect(relayStarts).toBe(1);
      expect(relayStops).toBe(1);
      expect(dispatchCalls).toBe(1);
      expect(clock.scheduledDelay()).toBe(UPSTREAM_PROOF_MAX_AGE_MS);
    } finally {
      await cleanupDaemonFixture(fixture);
    }
  });

  test("恢复等待 relay.stop 跨过新 proof deadline 时保持门禁且不 restart", async () => {
    const now = 40_000;
    const clock = manualProofClock(now);
    const fixture = await createDaemonFixture(
      "livis-daemon-proof-recovery-cross-expiry-",
      now + 100,
      clock.hooks,
    );
    try {
      const checkerEntered = deferred<void>();
      const checkerResult = deferred<UpstreamSnapshot>();
      const relayStopEntered = deferred<void>();
      const relayStopRelease = deferred<void>();
      let relayStarts = 0;
      let dispatchCalls = 0;
      fixture.internals.upstreamChecker.check = async () => {
        checkerEntered.resolve(undefined);
        return checkerResult.promise;
      };
      fixture.internals.relay.stop = () => {
        relayStopEntered.resolve(undefined);
        return relayStopRelease.promise;
      };
      fixture.internals.relay.start = () => {
        relayStarts += 1;
      };
      fixture.internals.dispatchPending = async () => {
        dispatchCalls += 1;
      };

      expect(fixture.internals.armUpstreamProofExpiry()).toBeTrue();
      const recheck = fixture.internals.recheckUpstream();
      await checkerEntered.promise;
      clock.fireAt(now + 100);
      await relayStopEntered.promise;
      checkerResult.resolve(supportedSnapshot(fixture.profile));
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (clock.scheduledDelay() === UPSTREAM_PROOF_MAX_AGE_MS) break;
        await Bun.sleep(1);
      }
      const newProofDelay = clock.scheduledDelay();
      if (newProofDelay !== UPSTREAM_PROOF_MAX_AGE_MS) {
        relayStopRelease.resolve(undefined);
      }
      expect(newProofDelay).toBe(UPSTREAM_PROOF_MAX_AGE_MS);
      clock.fireAt(now + 100 + UPSTREAM_PROOF_MAX_AGE_MS);
      expect(relayStarts).toBe(0);
      expect(dispatchCalls).toBe(0);

      relayStopRelease.resolve(undefined);
      await recheck;
      expect(fixture.internals.upstreamBlocked).toContain("supported proof 已过期");
      expect(relayStarts).toBe(0);
      expect(dispatchCalls).toBe(0);
    } finally {
      await cleanupDaemonFixture(fixture);
    }
  });

  test("dispatch 循环在 claim 后跨过 deadline 时 reset lease 且不 send", async () => {
    const fixture = await createDaemonFixture(
      "livis-daemon-proof-dispatch-cross-expiry-",
      Date.now() + 60_000,
    );
    try {
      const jobId = "dispatch-cross-expiry";
      fixture.internals.store.ingest(incomingJob(jobId), "session-dispatch-cross-expiry");
      fixture.internals.store.markAcked(jobId);
      Object.defineProperties(fixture.internals.connector, {
        ready: { configurable: true, value: true },
        connectorId: { configurable: true, value: "connector-deadline-test" },
      });
      let expiryChecks = 0;
      let sendCalls = 0;
      let relayStops = 0;
      fixture.internals.isUpstreamProofExpired = () => {
        expiryChecks += 1;
        return expiryChecks >= 3;
      };
      fixture.internals.connector.sendJob = () => {
        sendCalls += 1;
        return true;
      };
      fixture.internals.relay.stop = async () => {
        relayStops += 1;
      };

      await fixture.internals.dispatchPending();
      const reset = fixture.internals.store.require(jobId);
      expect(expiryChecks).toBe(3);
      expect(reset.status).toBe("Acked");
      expect(reset.connectorId).toBeNull();
      expect(reset.leaseId).toBeNull();
      expect(reset.runGeneration).toBe(1);
      expect(sendCalls).toBe(0);
      expect(relayStops).toBe(1);
      expect(fixture.internals.upstreamBlocked).toContain("supported proof 已过期");
    } finally {
      await cleanupDaemonFixture(fixture);
    }
  });

  test("stop 等待在途 checker，返回后不写 proof、不解门禁、不 restart 或 dispatch", async () => {
    const fixture = await createDaemonFixture(
      "livis-daemon-proof-stop-join-",
      Date.now() + 60_000,
    );
    try {
      const checkerEntered = deferred<void>();
      const checkerResult = deferred<UpstreamSnapshot>();
      let checkerReturned = false;
      let relayStarts = 0;
      let relayStops = 0;
      let dispatchCalls = 0;
      let closeCalls = 0;
      fixture.internals.upstreamBlocked = "测试中的既有 upstream blocker";
      fixture.internals.upstreamChecker.check = async () => {
        checkerEntered.resolve(undefined);
        const snapshot = await checkerResult.promise;
        checkerReturned = true;
        return snapshot;
      };
      fixture.internals.relay.start = () => {
        relayStarts += 1;
      };
      fixture.internals.relay.stop = async () => {
        relayStops += 1;
      };
      fixture.internals.dispatchPending = async () => {
        dispatchCalls += 1;
      };
      const originalClose = fixture.internals.store.close.bind(fixture.internals.store);
      fixture.internals.store.close = () => {
        expect(checkerReturned).toBeTrue();
        closeCalls += 1;
        originalClose();
      };

      const recheck = fixture.internals.recheckUpstream();
      await checkerEntered.promise;
      let stopSettled = false;
      const stop = fixture.daemon.stop();
      void stop.then(
        () => { stopSettled = true; },
        () => { stopSettled = true; },
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(stopSettled).toBeFalse();
      expect(closeCalls).toBe(0);

      checkerResult.resolve(supportedSnapshot(fixture.profile));
      await Promise.all([recheck, stop]);
      expect(closeCalls).toBe(1);
      expect(fixture.internals.upstreamBlocked).toBe("测试中的既有 upstream blocker");
      expect(await Bun.file(
        supportedProofPath(fixture.directory.path, fixture.config.profileSha256),
      ).exists()).toBeFalse();
      expect(relayStarts).toBe(0);
      expect(dispatchCalls).toBe(0);
      expect(relayStops).toBe(2);

      await fixture.internals.recheckUpstream();
      expect(closeCalls).toBe(1);
      expect(relayStarts).toBe(0);
      expect(dispatchCalls).toBe(0);
    } finally {
      await cleanupDaemonFixture(fixture);
    }
  });

  test("stop 不吞掉在途复核的 guard release 失败并保留 guard", async () => {
    const guardClass = ProfileOperationGuard as unknown as {
      acquire: typeof ProfileOperationGuard.acquire;
    };
    const originalAcquire = guardClass.acquire;
    const captured: { guard: ProfileOperationGuard | null } = { guard: null };
    guardClass.acquire = async (...args) => {
      const guard = await originalAcquire(...args);
      if (args[1] === "upstream-check") captured.guard = guard;
      return guard;
    };
    const fixture = await createDaemonFixture(
      "livis-daemon-proof-stop-release-failure-",
      Date.now() + 60_000,
    );
    try {
      const checkerEntered = deferred<void>();
      const checkerResult = deferred<UpstreamSnapshot>();
      fixture.internals.upstreamChecker.check = async () => {
        checkerEntered.resolve(undefined);
        return checkerResult.promise;
      };
      fixture.internals.relay.stop = async () => undefined;
      const recheck = fixture.internals.recheckUpstream();
      void recheck.catch(() => undefined);
      await checkerEntered.promise;
      const ownedGuard = captured.guard;
      if (!ownedGuard) throw new Error("未捕获 daemon upstream-check guard");

      const stop = fixture.daemon.stop();
      await chmod(ownedGuard.path, 0o400);
      checkerResult.resolve(supportedSnapshot(fixture.profile));
      let stopFailure: unknown;
      try {
        await stop;
      } catch (error) {
        stopFailure = error;
      }
      expect(stopFailure).toBeInstanceOf(AggregateError);
      const cleanupErrors = (stopFailure as AggregateError).errors;
      expect(cleanupErrors).toHaveLength(1);
      expect(String(cleanupErrors[0])).toContain("类型、权限或 inode 已变化");
      expect(await Bun.file(ownedGuard.path).exists()).toBeTrue();

      await chmod(ownedGuard.path, 0o600);
      await ownedGuard.release();
    } finally {
      guardClass.acquire = originalAcquire;
      await cleanupDaemonFixture(fixture);
    }
  });
});
