import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type {
  ExecutionAcceptedEvent,
  ExecutionBackend,
  ExecutionDisconnectedEvent,
  ExecutionReadyEvent,
  ExecutionResultEvent,
  ExecutionSubmission,
} from "../src/backends/execution-backend.ts";
import { RelayDaemon } from "../src/daemon.ts";
import type { RelayIdentity } from "../src/identity.ts";
import { Logger } from "../src/logger.ts";
import { SecretStore } from "../src/secrets.ts";
import type { JobStore } from "../src/state/store.ts";
import type { StoredJob } from "../src/types.ts";
import { atomicWritePrivate, sha256 } from "../src/util.ts";
import { incomingJob, temporaryDirectory, testConfig, testProfile } from "./helpers.ts";

class FakeCodexBackend implements ExecutionBackend {
  readonly kind = "codex" as const;
  ready = true;
  executionId: string | null = "codex:thread-test";
  dispatched: StoredJob[] = [];
  dispatchImplementation: (job: StoredJob) => Promise<ExecutionSubmission> = async () => "submitted";

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async dispatch(job: StoredJob): Promise<ExecutionSubmission> {
    this.dispatched.push(job);
    return this.dispatchImplementation(job);
  }
  async cancel(): Promise<ExecutionSubmission> {
    return "submitted";
  }
  status(): Record<string, unknown> {
    return {
      kind: this.kind,
      ready: this.ready,
      executionId: this.executionId,
      active: this.dispatched.at(-1)?.jobId ?? null,
    };
  }
}

interface DaemonInternals {
  executionBackend: ExecutionBackend;
  store: JobStore;
  relay: { notifyOutboxPending(): Promise<void> };
  dispatchPending(): Promise<void>;
  onExecutionReady(event: ExecutionReadyEvent): Promise<void>;
  onExecutionAccepted(event: ExecutionAcceptedEvent): Promise<void>;
  onExecutionResult(event: ExecutionResultEvent): Promise<void>;
  onExecutionDisconnected(event: ExecutionDisconnectedEvent): Promise<void>;
}

async function daemonFixture(prefix: string): Promise<{
  daemon: RelayDaemon;
  backend: FakeCodexBackend;
  internals: DaemonInternals;
  sessionKey: string;
  cleanup(): Promise<void>;
}> {
  const directory = await temporaryDirectory(prefix);
  const profile = await testProfile();
  const profileText = `${JSON.stringify(profile, null, 2)}\n`;
  const profilePath = join(directory.path, "protocol-profiles", "active.json");
  await atomicWritePrivate(profilePath, profileText);
  const config = {
    ...testConfig(directory.path),
    profile: profilePath,
    profileSha256: sha256(profileText),
    execution: { backend: "codex" as const },
    codex: {
      ...testConfig(directory.path).codex,
      command: "/test/bin/codex",
      acknowledgeRemoteExecution: true,
    },
  };
  const identity: RelayIdentity = {
    schemaVersion: 1,
    accountId: "account",
    agentId: `${profile.wireIdentity.agentIdPrefix}agent`,
    deviceId: `${profile.wireIdentity.deviceIdPrefix}device`,
    createdAt: "2026-07-22T00:00:00.000Z",
  };
  const secrets = new SecretStore(directory.path);
  await secrets.initialize();
  const daemon = RelayDaemon.create({
    config,
    profile,
    identity,
    secrets,
    secretValues: await secrets.load(),
    upstreamProofExpiresAt: Date.now() + 60_000,
    logger: new Logger("test.daemon-execution", "error"),
  });
  const internals = daemon as unknown as DaemonInternals;
  const backend = new FakeCodexBackend();
  internals.executionBackend = backend;
  const sessionKey = `livis:${identity.agentId}`;
  internals.store.ensureBackendSession({
    backend: "codex",
    sessionKey,
    sessionHash: "a".repeat(64),
    cwd: join(directory.path, "workspace"),
    cliVersion: "0.145.0",
  });
  internals.store.bindBackendThread("codex", sessionKey, "thread-test");
  return {
    daemon,
    backend,
    internals,
    sessionKey,
    cleanup: async () => {
      await daemon.stop().catch(() => undefined);
      await directory.cleanup();
    },
  };
}

function enqueue(internals: DaemonInternals, sessionKey: string, jobId: string): void {
  internals.store.ingest(incomingJob(jobId), sessionKey);
  internals.store.markAcked(jobId);
}

describe("RelayDaemon execution backend 接线", () => {
  test("backend ready 恢复时重新拒绝未授权 Acked job，绝不派发", async () => {
    const fixture = await daemonFixture("livis-daemon-codex-unauthorized-recovery-");
    try {
      const jobId = "job-unauthorized-recovery";
      fixture.internals.store.ingest(
        incomingJob(jobId, "禁止执行", "node-unauthorized"),
        fixture.sessionKey,
      );
      fixture.internals.store.markAcked(jobId);
      let outboxNotifications = 0;
      fixture.internals.relay.notifyOutboxPending = async () => {
        outboxNotifications += 1;
      };

      await fixture.internals.onExecutionReady({
        kind: "codex",
        executionId: "codex:thread-test",
      });

      const rejected = fixture.internals.store.require(jobId);
      expect(rejected.status).toBe("Rejected");
      expect(rejected.error).toBe("node not authorized");
      expect(rejected.outbox).toMatchObject({
        status: "Pending",
        resultJson: JSON.stringify({ text: "unauthorized" }),
      });
      expect(fixture.backend.dispatched).toEqual([]);
      expect(outboxNotifications).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  test("Codex claim、accepted 与 terminal result 均由 daemon 原子持久化", async () => {
    const fixture = await daemonFixture("livis-daemon-codex-result-");
    try {
      enqueue(fixture.internals, fixture.sessionKey, "job-result");
      let outboxNotifications = 0;
      fixture.internals.relay.notifyOutboxPending = async () => {
        outboxNotifications += 1;
      };

      await fixture.internals.dispatchPending();
      const claimed = fixture.backend.dispatched[0]!;
      expect(claimed.status).toBe("Dispatching");
      expect(claimed.connectorId).toBe("codex:thread-test");
      await fixture.internals.onExecutionAccepted({
        kind: "codex",
        executionId: "codex:thread-test",
        jobId: claimed.jobId,
        leaseId: claimed.leaseId!,
        runGeneration: claimed.runGeneration,
        turnId: "turn-result",
      });
      expect(fixture.internals.store.require(claimed.jobId).status).toBe("Running");

      await fixture.internals.onExecutionResult({
        kind: "codex",
        executionId: "codex:thread-test",
        jobId: claimed.jobId,
        leaseId: claimed.leaseId!,
        runGeneration: claimed.runGeneration,
        turnId: "turn-result",
        text: "done",
      });
      const finished = fixture.internals.store.require(claimed.jobId);
      expect(finished.status).toBe("Succeeded");
      expect(finished.outbox).not.toBeNull();
      expect(fixture.internals.store.getBackendSession("codex", fixture.sessionKey)?.activeJobId).toBeNull();
      expect(outboxNotifications).toBe(1);
      expect(fixture.daemon.status()).toMatchObject({
        execution: {
          kind: "codex",
          ready: true,
          executionId: "codex:thread-test",
        },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test("Codex 可证明 not_sent 与并发 cancel 时直接 Cancelled 并清 reservation", async () => {
    const fixture = await daemonFixture("livis-daemon-codex-not-sent-cancel-");
    try {
      enqueue(fixture.internals, fixture.sessionKey, "job-not-sent-cancel");
      fixture.backend.dispatchImplementation = async (job) => {
        fixture.internals.store.requestCancel(job.jobId);
        return "not_sent";
      };

      await fixture.internals.dispatchPending();
      expect(fixture.internals.store.require("job-not-sent-cancel").status).toBe("Cancelled");
      const session = fixture.internals.store.getBackendSession("codex", fixture.sessionKey)!;
      expect(session.activeJobId).toBeNull();
      expect(session.recoveryRequired).toBeFalse();
    } finally {
      await fixture.cleanup();
    }
  });

  test("cancel 与 turn/start accepted 并发时补记 turnId 并进入人工恢复", async () => {
    const fixture = await daemonFixture("livis-daemon-codex-accept-cancel-");
    try {
      enqueue(fixture.internals, fixture.sessionKey, "job-accept-cancel");
      await fixture.internals.dispatchPending();
      const claimed = fixture.backend.dispatched[0]!;
      fixture.internals.store.requestCancel(claimed.jobId);

      await fixture.internals.onExecutionAccepted({
        kind: "codex",
        executionId: "codex:thread-test",
        jobId: claimed.jobId,
        leaseId: claimed.leaseId!,
        runGeneration: claimed.runGeneration,
        turnId: "turn-cancel-race",
      });
      expect(fixture.internals.store.require(claimed.jobId).status).toBe("CancelUnknown");
      const session = fixture.internals.store.getBackendSession("codex", fixture.sessionKey)!;
      expect(session.activeTurnId).toBe("turn-cancel-race");
      expect(session.recoveryRequired).toBeTrue();
      expect(fixture.internals.store.listQuarantinedSessions()).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  test("Codex 断连按 executionId 收口并由 backend-aware session release 清理", async () => {
    const fixture = await daemonFixture("livis-daemon-codex-disconnect-");
    try {
      enqueue(fixture.internals, fixture.sessionKey, "job-disconnect");
      await fixture.internals.dispatchPending();
      const claimed = fixture.backend.dispatched[0]!;
      await fixture.internals.onExecutionAccepted({
        kind: "codex",
        executionId: "codex:thread-test",
        jobId: claimed.jobId,
        leaseId: claimed.leaseId!,
        runGeneration: claimed.runGeneration,
        turnId: "turn-disconnect",
      });

      await fixture.internals.onExecutionDisconnected({
        kind: "codex",
        executionId: "codex:thread-test",
        reason: "synthetic child exit",
      });
      expect(fixture.internals.store.require(claimed.jobId).status).toBe("Interrupted");
      expect(fixture.internals.store.getBackendSession("codex", fixture.sessionKey)?.recoveryRequired).toBeTrue();
      expect(fixture.daemon.releaseSessionQuarantine(fixture.sessionKey)).toBeTrue();
      expect(fixture.internals.store.listQuarantinedSessions()).toHaveLength(0);
      expect(fixture.internals.store.getBackendSession("codex", fixture.sessionKey)?.activeJobId).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });
});
