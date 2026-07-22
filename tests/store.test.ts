import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { statSync } from "node:fs";
import { Database } from "bun:sqlite";
import {
  JobConflictError,
  JobStore,
  PENDING_CANCEL_MAX_ROWS,
  PendingCancelCapacityError,
  PENDING_CANCEL_TTL_MS,
} from "../src/state/store.ts";
import { incomingJob, temporaryDirectory } from "./helpers.ts";

function pendingCancelCount(databasePath: string): number {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pending_cancels")
      .get()?.count ?? 0;
  } finally {
    database.close();
  }
}

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
    expect(store.findJobIdByOutboxMessageId("result-msg-1")).toBe("job-1");
    expect(store.findJobIdByOutboxMessageId("result-msg-2")).toBe("job-1");
    expect(store.findJobIdByOutboxMessageId("unknown-msg")).toBeNull();
    expect(store.markOutboxDelivered("job-1")?.status).toBe("Delivered");
    expect(store.markOutboxDelivered("no-such-job")).toBeNull();
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

  test("v1 数据库迁移后保留最后一次结果投递 ID", () => {
    const databasePath = join(directory.path, "relay.db");
    store.ingest(incomingJob("job-migrated"), "session-1");
    store.markAcked("job-migrated");
    store.claimForDispatch("job-migrated", "connector", "lease-1");
    store.markRunning("job-migrated", "connector", "lease-1");
    store.finishSuccess("job-migrated", "lease-1", '{"text":"done"}');
    store.startResultDelivery("job-migrated", "legacy-result-msg", false);
    store.close();

    const legacy = new Database(databasePath);
    legacy.exec("DROP TABLE outbox_delivery_attempts; PRAGMA user_version=1;");
    legacy.close();

    store = new JobStore(databasePath, "account:agent");
    expect(store.findJobIdByOutboxMessageId("legacy-result-msg")).toBe("job-migrated");
    expect(store.integrityCheck()).toBe("ok");
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
    const databasePath = join(directory.path, "relay.db");
    expect(store.requestCancel("future-job")).toBeNull();
    expect(pendingCancelCount(databasePath)).toBe(1);
    const ingested = store.ingest(incomingJob("future-job"), "session-1").job;
    expect(ingested.status).toBe("Cancelled");
    expect(ingested.cancelRequested).toBeTrue();
    expect(pendingCancelCount(databasePath)).toBe(0);
  });

  test("重复 job 入库和 daemon 启动恢复都会先应用再消费历史匹配的 cancel intent", () => {
    const databasePath = join(directory.path, "relay.db");
    store.ingest(incomingJob("duplicate-job"), "session-duplicate");
    store.markAcked("duplicate-job");
    store.ingest(incomingJob("startup-job"), "session-startup");
    store.markAcked("startup-job");

    let legacy = new Database(databasePath);
    legacy.query("INSERT INTO pending_cancels(scope_key,job_id,created_at) VALUES(?,?,?)")
      .run("account:agent", "duplicate-job", Date.now());
    legacy.close();
    expect(store.ingest(incomingJob("duplicate-job"), "session-duplicate").job.status).toBe("Cancelled");
    expect(pendingCancelCount(databasePath)).toBe(0);

    legacy = new Database(databasePath);
    legacy.query("INSERT INTO pending_cancels(scope_key,job_id,created_at) VALUES(?,?,?)")
      .run("account:agent", "startup-job", Date.now());
    legacy.close();
    store.close();
    store = new JobStore(databasePath, "account:agent");
    expect(pendingCancelCount(databasePath)).toBe(1);
    expect(store.require("startup-job").status).toBe("Acked");
    store.recoverAfterRestart();
    expect(pendingCancelCount(databasePath)).toBe(0);
    expect(store.require("startup-job").status).toBe("Cancelled");
  });

  test("daemon 启动恢复将 active job 的历史 intent 隔离为 CancelUnknown", () => {
    const databasePath = join(directory.path, "relay.db");
    store.ingest(incomingJob("active-job"), "session-active");
    store.markAcked("active-job");
    store.claimForDispatch("active-job", "connector", "lease-active");
    store.markRunning("active-job", "connector", "lease-active");
    store.close();

    const legacy = new Database(databasePath);
    legacy.query("INSERT INTO pending_cancels(scope_key,job_id,created_at) VALUES(?,?,?)")
      .run("account:agent", "active-job", Date.now());
    legacy.close();

    store = new JobStore(databasePath, "account:agent");
    expect(store.require("active-job").status).toBe("Running");
    expect(pendingCancelCount(databasePath)).toBe(1);
    const recovery = store.recoverAfterRestart();
    expect(recovery.cancelUnknown).toBe(1);
    expect(store.require("active-job").status).toBe("CancelUnknown");
    expect(store.listQuarantinedSessions().map((entry) => entry.sessionKey))
      .toContain("session-active");
  });

  test("启动恢复只消费当前 scope 的匹配 intent", () => {
    const databasePath = join(directory.path, "relay.db");
    store.close();
    store = new JobStore(databasePath, "foreign:scope");
    store.ingest(incomingJob("foreign-job"), "foreign-session");
    store.markAcked("foreign-job");
    store.claimForDispatch("foreign-job", "foreign-connector", "foreign-lease");
    store.markRunning("foreign-job", "foreign-connector", "foreign-lease");
    store.close();

    const legacy = new Database(databasePath);
    legacy.query("INSERT INTO pending_cancels(scope_key,job_id,created_at) VALUES(?,?,?)")
      .run("foreign:scope", "foreign-job", Date.now());
    legacy.close();

    store = new JobStore(databasePath, "account:agent");
    store.recoverAfterRestart();
    expect(pendingCancelCount(databasePath)).toBe(1);
    store.close();
    store = new JobStore(databasePath, "foreign:scope");
    expect(store.require("foreign-job").status).toBe("Running");
  });

  test("过期 cancel 不影响迟到 job，TTL 边界内 intent 仍生效且都会被删除", () => {
    const databasePath = join(directory.path, "relay.db");
    const fixedNow = 1_800_000_000_000;
    const originalNow = Date.now;
    Date.now = () => fixedNow;
    try {
      store.requestCancel("expired-job");
      store.requestCancel("boundary-job");
      const database = new Database(databasePath);
      database.query("UPDATE pending_cancels SET created_at=? WHERE scope_key=? AND job_id=?")
        .run(fixedNow - PENDING_CANCEL_TTL_MS - 1, "account:agent", "expired-job");
      database.query("UPDATE pending_cancels SET created_at=? WHERE scope_key=? AND job_id=?")
        .run(fixedNow - PENDING_CANCEL_TTL_MS, "account:agent", "boundary-job");
      database.close();

      expect(store.ingest(incomingJob("expired-job"), "session-expired").job.status).toBe("Received");
      expect(store.ingest(incomingJob("boundary-job"), "session-boundary").job.status).toBe("Cancelled");
      expect(pendingCancelCount(databasePath)).toBe(0);
    } finally {
      Date.now = originalNow;
    }
  });

  test("未知 cancel 达到总量上限后拒绝新 ID，但允许刷新旧 intent 和取消已有 job", () => {
    const databasePath = join(directory.path, "relay.db");
    const database = new Database(databasePath);
    const insert = database.query(
      "INSERT INTO pending_cancels(scope_key,job_id,created_at) VALUES(?,?,?)",
    );
    const now = Date.now();
    const fill = database.transaction(() => {
      for (let index = 0; index < PENDING_CANCEL_MAX_ROWS; index += 1) {
        insert.run("account:agent", `unknown-${index}`, now);
      }
    });
    fill.immediate();
    database.close();

    expect(pendingCancelCount(databasePath)).toBe(PENDING_CANCEL_MAX_ROWS);
    expect(() => store.requestCancel("overflow")).toThrow(PendingCancelCapacityError);
    expect(pendingCancelCount(databasePath)).toBe(PENDING_CANCEL_MAX_ROWS);
    expect(store.requestCancel("unknown-0")).toBeNull();

    store.ingest(incomingJob("known-job"), "session-known");
    store.markAcked("known-job");
    expect(store.requestCancel("known-job")?.status).toBe("Cancelled");
    expect(pendingCancelCount(databasePath)).toBe(PENDING_CANCEL_MAX_ROWS);
  });

  test("schema v2 幂等补 GC 索引，并在 daemon 恢复时清除历史 intent", () => {
    const databasePath = join(directory.path, "relay.db");
    store.ingest(incomingJob("matched-job"), "session-1");
    store.close();

    const legacy = new Database(databasePath);
    legacy.exec("DROP INDEX idx_pending_cancels_gc; PRAGMA user_version=2;");
    const insert = legacy.query(
      "INSERT INTO pending_cancels(scope_key,job_id,created_at) VALUES(?,?,?)",
    );
    insert.run("account:agent", "matched-job", Date.now());
    insert.run("account:agent", "expired-job", Date.now() - PENDING_CANCEL_TTL_MS - 1);
    const fill = legacy.transaction(() => {
      for (let index = 0; index <= PENDING_CANCEL_MAX_ROWS; index += 1) {
        insert.run("account:agent", `fresh-${index}`, Date.now() + index);
      }
    });
    fill.immediate();
    legacy.close();

    store = new JobStore(databasePath, "account:agent");
    expect(store.require("matched-job").status).toBe("Received");
    expect(pendingCancelCount(databasePath)).toBe(PENDING_CANCEL_MAX_ROWS + 3);
    store.recoverAfterRestart();
    expect(pendingCancelCount(databasePath)).toBe(PENDING_CANCEL_MAX_ROWS);
    expect(store.require("matched-job").status).toBe("Cancelled");
    const migrated = new Database(databasePath, { readonly: true });
    const indexes = migrated.query<{ name: string }, []>("PRAGMA index_list('pending_cancels')")
      .all().map((row) => row.name);
    const version = migrated.query<{ user_version: number }, []>("PRAGMA user_version").get();
    migrated.close();
    expect(indexes).toContain("idx_pending_cancels_gc");
    expect(version?.user_version).toBe(2);
  });

  test("未派发 job 可取消，终态和 Interrupted 不回退", () => {
    store.ingest(incomingJob("received-job"), "session-received");
    expect(store.requestCancel("received-job")?.status).toBe("Cancelled");

    store.ingest(incomingJob("acked-job"), "session-acked");
    store.markAcked("acked-job");
    expect(store.requestCancel("acked-job")?.status).toBe("Cancelled");

    store.ingest(incomingJob("interrupted-job"), "session-interrupted");
    store.markAcked("interrupted-job");
    store.claimForDispatch("interrupted-job", "connector", "lease-interrupted");
    store.markRunning("interrupted-job", "connector", "lease-interrupted");
    store.recoverAfterRestart();
    expect(store.requestCancel("interrupted-job")?.status).toBe("Interrupted");
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

  test("重复 cancel 保持 Cancelling 并继续隔离同 session", () => {
    for (const jobId of ["active-job", "next-job"]) {
      store.ingest(incomingJob(jobId), "session-risk");
      store.markAcked(jobId);
    }
    store.claimForDispatch("active-job", "connector", "lease-active");
    store.markRunning("active-job", "connector", "lease-active");

    expect(store.requestCancel("active-job")?.status).toBe("Cancelling");
    expect(store.requestCancel("active-job")?.status).toBe("Cancelling");
    expect(store.claimForDispatch("next-job", "connector", "lease-next")).toBeNull();

    const cancelled = store.markCancelUnknown("active-job", "lease-active", "best-effort cancel");
    expect(cancelled.status).toBe("CancelUnknown");
    expect(store.listQuarantinedSessions().map((item) => item.sessionKey)).toContain("session-risk");
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
