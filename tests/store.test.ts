import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { statSync } from "node:fs";
import { JobConflictError, JobStore } from "../src/state/store.ts";
import { incomingJob, temporaryDirectory } from "./helpers.ts";

describe("durable jobs + outbox", () => {
  let directory: Awaited<ReturnType<typeof temporaryDirectory>>;
  let store: JobStore;

  beforeEach(async () => {
    directory = await temporaryDirectory();
    store = new JobStore(join(directory.path, "relay.db"), "account:agent");
  });

  afterEach(async () => {
    store.close();
    await directory.cleanup();
  });

  test("相同 job 幂等，不同业务内容冲突", () => {
    expect(store.ingest(incomingJob("job-1"), "session-1").inserted).toBeTrue();
    expect(store.ingest(incomingJob("job-1"), "session-1").inserted).toBeFalse();
    expect(() => store.ingest(incomingJob("job-1", "different"), "session-1")).toThrow(JobConflictError);
  });

  test("SQLite 主文件、WAL 和 SHM 都是 0600", () => {
    const databasePath = join(directory.path, "relay.db");
    for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  test("执行和结果 outbox 是两套状态", () => {
    store.ingest(incomingJob("job-1"), "session-1");
    store.markAcked("job-1");
    const claimed = store.claimForDispatch("job-1", "connector", "lease-1")!;
    expect(claimed.status).toBe("Dispatching");
    expect(claimed.runGeneration).toBe(1);
    store.markRunning("job-1", "connector", "lease-1");
    const completed = store.finishSuccess("job-1", "lease-1", '{"text":"done"}');
    expect(completed.status).toBe("Succeeded");
    expect(completed.outbox?.status).toBe("Pending");
    expect(store.startResultDelivery("job-1", "result-msg-1", false)?.retryCount).toBe(0);
    expect(store.startResultDelivery("job-1", "result-msg-2", true)?.retryCount).toBe(1);
    expect(store.markOutboxDelivered("job-1")?.status).toBe("Delivered");
    expect(store.integrityCheck()).toBe("ok");
  });

  test("旧 lease 的 final 无效", () => {
    store.ingest(incomingJob("job-1"), "session-1");
    store.markAcked("job-1");
    store.claimForDispatch("job-1", "connector", "lease-current");
    store.markRunning("job-1", "connector", "lease-current");
    const stale = store.finishSuccess("job-1", "lease-stale", '{"text":"stale"}');
    expect(stale.status).toBe("Running");
    expect(stale.outbox).toBeNull();
  });

  test("同 session 单活，不同 session 可并发", () => {
    for (const id of ["a", "b", "c"]) {
      store.ingest(incomingJob(id), id === "c" ? "session-2" : "session-1");
      store.markAcked(id);
    }
    expect(store.claimForDispatch("a", "connector", "lease-a")).not.toBeNull();
    expect(store.claimForDispatch("b", "connector", "lease-b")).toBeNull();
    expect(store.claimForDispatch("c", "connector", "lease-c")).not.toBeNull();
  });

  test("cancel intent 可先于消息到达", () => {
    expect(store.requestCancel("future-job")).toBeNull();
    const ingested = store.ingest(incomingJob("future-job"), "session-1").job;
    expect(ingested.status).toBe("Cancelled");
    expect(ingested.cancelRequested).toBeTrue();
  });

  test("cancel 和 final 由 CAS 决定先后", () => {
    store.ingest(incomingJob("cancel-first"), "session-1");
    store.markAcked("cancel-first");
    store.claimForDispatch("cancel-first", "connector", "lease-cancel");
    store.markRunning("cancel-first", "connector", "lease-cancel");
    expect(store.requestCancel("cancel-first")?.status).toBe("Cancelling");
    const lateFinal = store.finishSuccess("cancel-first", "lease-cancel", '{"text":"late"}');
    expect(lateFinal.status).toBe("Cancelling");
    expect(lateFinal.outbox).toBeNull();

    store.ingest(incomingJob("final-first"), "session-2");
    store.markAcked("final-first");
    store.claimForDispatch("final-first", "connector", "lease-final");
    store.markRunning("final-first", "connector", "lease-final");
    store.finishSuccess("final-first", "lease-final", '{"text":"done"}');
    const tooLate = store.requestCancel("final-first")!;
    expect(tooLate.status).toBe("Succeeded");
    expect(tooLate.outbox?.status).toBe("Pending");
  });

  test("重启把 ambiguous execution 隔离，不自动重跑", () => {
    store.ingest(incomingJob("job-1"), "session-risk");
    store.markAcked("job-1");
    store.claimForDispatch("job-1", "connector", "lease-1");
    store.markRunning("job-1", "connector", "lease-1");
    const recovery = store.recoverAfterRestart();
    expect(recovery.interrupted).toBe(1);
    expect(store.require("job-1").status).toBe("Interrupted");
    expect(store.listQuarantinedSessions()[0]?.sessionKey).toBe("session-risk");
    expect(store.releaseSessionQuarantine("session-risk")).toBeTrue();
  });
});
