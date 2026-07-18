import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { RelayDaemon } from "../src/daemon.ts";
import { JobStore } from "../src/state/store.ts";
import type { ConnectorInboundMessage } from "../src/types.ts";
import { incomingJob, temporaryDirectory } from "./helpers.ts";

describe("daemon connector terminal protocol", () => {
  let directory: Awaited<ReturnType<typeof temporaryDirectory>>;
  let store: JobStore;
  let acknowledgements: Array<{ jobId: string; leaseId: string }>;
  let acknowledgementSnapshots: Array<{ jobId: string; status: string; outboxStatus: string | null }>;
  let rejections: Array<{ jobId: string; code: string }>;
  let outboxNotifications: number;
  let dispatches: number;
  let daemon: RelayDaemon;

  beforeEach(async () => {
    directory = await temporaryDirectory();
    store = new JobStore(join(directory.path, "relay.db"), "account:agent");
    acknowledgements = [];
    acknowledgementSnapshots = [];
    rejections = [];
    outboxNotifications = 0;
    dispatches = 0;
    daemon = Object.create(RelayDaemon.prototype) as RelayDaemon;
    Object.assign(daemon as unknown as Record<string, unknown>, {
      store,
      config: {
        security: {
          maxOutputChars: 8,
        },
      },
      connector: {
        acknowledgeResult(jobId: string, leaseId: string) {
          acknowledgements.push({ jobId, leaseId });
          const job = store.require(jobId);
          acknowledgementSnapshots.push({
            jobId,
            status: job.status,
            outboxStatus: job.outbox?.status ?? null,
          });
        },
        rejectJobMessage(jobId: string, code: string) {
          rejections.push({ jobId, code });
        },
      },
      relay: {
        async notifyOutboxPending() {
          outboxNotifications += 1;
        },
      },
      dispatchPending: async () => {
        dispatches += 1;
      },
    });
  });

  afterEach(async () => {
    store.close();
    await directory.cleanup();
  });

  async function reportNotStarted(jobId: string, leaseId: string): Promise<void> {
    const message: Extract<ConnectorInboundMessage, { type: "failed" }> = {
      type: "failed",
      jobId,
      leaseId,
      error: "remote command rejected before dispatch",
      retryable: false,
      notStarted: true,
    };
    await (daemon as unknown as {
      onConnectorFailed(
        value: Extract<ConnectorInboundMessage, { type: "failed" }>,
        connectorId: string,
      ): Promise<void>;
    }).onConnectorFailed(message, "connector");
  }

  async function reportResult(jobId: string, leaseId: string, text: string): Promise<void> {
    const message: Extract<ConnectorInboundMessage, { type: "result" }> = {
      type: "result",
      jobId,
      leaseId,
      text,
    };
    await (daemon as unknown as {
      onConnectorResult(
        value: Extract<ConnectorInboundMessage, { type: "result" }>,
        connectorId: string,
      ): Promise<void>;
    }).onConnectorResult(message, "connector");
  }

  async function reportFailed(jobId: string, leaseId: string, error: string): Promise<void> {
    const message: Extract<ConnectorInboundMessage, { type: "failed" }> = {
      type: "failed",
      jobId,
      leaseId,
      error,
      retryable: false,
    };
    await (daemon as unknown as {
      onConnectorFailed(
        value: Extract<ConnectorInboundMessage, { type: "failed" }>,
        connectorId: string,
      ): Promise<void>;
    }).onConnectorFailed(message, "connector");
  }

  function claim(jobId: string, leaseId = "lease-1"): void {
    store.ingest(incomingJob(jobId), `session-${jobId}`);
    store.markAcked(jobId);
    expect(store.claimForDispatch(jobId, "connector", leaseId)?.status).toBe("Dispatching");
  }

  test("oversized result is rejected before changing durable state", async () => {
    claim("job-1");

    await reportResult("job-1", "lease-1", "123456789");

    const job = store.require("job-1");
    expect(job.status).toBe("Dispatching");
    expect(job.outbox).toBeNull();
    expect(acknowledgements).toEqual([]);
    expect(rejections).toEqual([{ jobId: "job-1", code: "output_too_large" }]);
    expect(outboxNotifications).toBe(0);
    expect(dispatches).toBe(0);
  });

  test("cancel-first result is rejected and keeps Cancelling ownership", async () => {
    claim("job-1");
    expect(store.requestCancel("job-1")?.status).toBe("Cancelling");

    await reportResult("job-1", "lease-1", "done");

    const job = store.require("job-1");
    expect(job.status).toBe("Cancelling");
    expect(job.cancelRequested).toBeTrue();
    expect(job.outbox).toBeNull();
    expect(acknowledgements).toEqual([]);
    expect(rejections).toEqual([{ jobId: "job-1", code: "cancel_superseded" }]);
    expect(outboxNotifications).toBe(0);
    expect(dispatches).toBe(0);
  });

  test("cancel-first ordinary failure is rejected and keeps Cancelling ownership", async () => {
    claim("job-1");
    expect(store.requestCancel("job-1")?.status).toBe("Cancelling");

    await reportFailed("job-1", "lease-1", "Hermes failed after /stop");

    const job = store.require("job-1");
    expect(job.status).toBe("Cancelling");
    expect(job.cancelRequested).toBeTrue();
    expect(job.outbox).toBeNull();
    expect(acknowledgements).toEqual([]);
    expect(rejections).toEqual([{ jobId: "job-1", code: "cancel_superseded" }]);
    expect(outboxNotifications).toBe(0);
    expect(dispatches).toBe(0);
  });

  test("a different replayed final is rejected without replacing the first result", async () => {
    claim("job-1");

    await reportResult("job-1", "lease-1", "first");
    await reportResult("job-1", "lease-1", "second");

    const job = store.require("job-1");
    expect(job.status).toBe("Succeeded");
    expect(job.outbox?.status).toBe("Pending");
    expect(job.outbox?.resultJson).toBe('{"text":"first"}');
    expect(acknowledgements).toEqual([{ jobId: "job-1", leaseId: "lease-1" }]);
    expect(rejections).toEqual([{ jobId: "job-1", code: "result_conflict" }]);
    expect(outboxNotifications).toBe(1);
    expect(dispatches).toBe(1);
  });

  test("ordinary failure is persisted before result_stored acknowledgement", async () => {
    claim("job-1");

    await reportFailed("job-1", "lease-1", "Hermes runtime failure");

    const job = store.require("job-1");
    expect(job.status).toBe("Failed");
    expect(job.error).toBe("Hermes runtime failure");
    expect(job.outbox?.status).toBe("Pending");
    expect(job.outbox?.resultJson).toBe('{"text":"Hermes 暂时无法完成该请求，请稍后重试。"}');
    expect(acknowledgements).toEqual([{ jobId: "job-1", leaseId: "lease-1" }]);
    expect(acknowledgementSnapshots).toEqual([
      { jobId: "job-1", status: "Failed", outboxStatus: "Pending" },
    ]);
    expect(rejections).toEqual([]);
    expect(outboxNotifications).toBe(1);
    expect(dispatches).toBe(1);
  });

  test("stale result and failure leases cannot mutate or acknowledge jobs", async () => {
    claim("job-result", "lease-current-result");
    claim("job-failed", "lease-current-failed");

    await reportResult("job-result", "lease-stale", "done");
    await reportFailed("job-failed", "lease-stale", "stale failure");

    for (const jobId of ["job-result", "job-failed"]) {
      const job = store.require(jobId);
      expect(job.status).toBe("Dispatching");
      expect(job.outbox).toBeNull();
    }
    expect(acknowledgements).toEqual([]);
    expect(rejections).toEqual([
      { jobId: "job-result", code: "stale_lease" },
      { jobId: "job-failed", code: "stale_lease" },
    ]);
    expect(outboxNotifications).toBe(0);
    expect(dispatches).toBe(0);
  });

  test("normal rejection becomes Failed and receives durable acknowledgement", async () => {
    store.ingest(incomingJob("job-1"), "session-1");
    store.markAcked("job-1");
    store.claimForDispatch("job-1", "connector", "lease-1");

    await reportNotStarted("job-1", "lease-1");

    const job = store.require("job-1");
    expect(job.status).toBe("Failed");
    expect(job.outbox?.status).toBe("Pending");
    expect(acknowledgements).toEqual([{ jobId: "job-1", leaseId: "lease-1" }]);
    expect(rejections).toEqual([]);
    expect(outboxNotifications).toBe(1);
    expect(dispatches).toBe(1);
  });

  test("accepted job can still report notStarted during drain", async () => {
    claim("job-1");
    const accepted: Extract<ConnectorInboundMessage, { type: "accepted" }> = {
      type: "accepted",
      jobId: "job-1",
      leaseId: "lease-1",
    };
    await (daemon as unknown as {
      onConnectorAccepted(
        value: Extract<ConnectorInboundMessage, { type: "accepted" }>,
        connectorId: string,
      ): Promise<void>;
    }).onConnectorAccepted(accepted, "connector");
    expect(store.require("job-1").status).toBe("Running");

    await reportNotStarted("job-1", "lease-1");

    const job = store.require("job-1");
    expect(job.status).toBe("Failed");
    expect(job.outbox?.status).toBe("Pending");
    expect(acknowledgements).toEqual([{ jobId: "job-1", leaseId: "lease-1" }]);
    expect(acknowledgementSnapshots).toEqual([
      { jobId: "job-1", status: "Failed", outboxStatus: "Pending" },
    ]);
    expect(rejections).toEqual([]);
    expect(outboxNotifications).toBe(1);
    expect(dispatches).toBe(1);
  });

  test("cancel-first rejection becomes Cancelled without quarantine", async () => {
    store.ingest(incomingJob("job-1"), "session-1");
    store.markAcked("job-1");
    store.claimForDispatch("job-1", "connector", "lease-1");
    expect(store.requestCancel("job-1")?.status).toBe("Cancelling");

    await reportNotStarted("job-1", "lease-1");

    const job = store.require("job-1");
    expect(job.status).toBe("Cancelled");
    expect(job.outbox).toBeNull();
    expect(store.listQuarantinedSessions()).toEqual([]);
    expect(acknowledgements).toEqual([{ jobId: "job-1", leaseId: "lease-1" }]);
    expect(rejections).toEqual([]);
    expect(outboxNotifications).toBe(0);
    expect(dispatches).toBe(1);
  });

  test("replayed rejection corrects disconnect quarantine and is acknowledged", async () => {
    store.ingest(incomingJob("job-1"), "session-1");
    store.markAcked("job-1");
    store.claimForDispatch("job-1", "connector", "lease-1");
    expect(store.markConnectorDisconnected("connector")).toBe(1);
    expect(store.require("job-1").status).toBe("Interrupted");

    await reportNotStarted("job-1", "lease-1");

    const job = store.require("job-1");
    expect(job.status).toBe("Failed");
    expect(job.outbox?.status).toBe("Pending");
    expect(store.listQuarantinedSessions()).toEqual([]);
    expect(acknowledgements).toEqual([{ jobId: "job-1", leaseId: "lease-1" }]);
    expect(rejections).toEqual([]);
    expect(outboxNotifications).toBe(1);
    expect(dispatches).toBe(1);
  });
});
