import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { statSync } from "node:fs";
import { Database } from "bun:sqlite";
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
    legacy.exec(`
      DROP TABLE outbox_delivery_attempts;
      ALTER TABLE jobs DROP COLUMN quarantine_released_at;
      PRAGMA user_version=1;
    `);
    legacy.close();

    store = new JobStore(databasePath, "account:agent");
    expect(store.findJobIdByOutboxMessageId("legacy-result-msg")).toBe("job-migrated");
    expect(store.integrityCheck()).toBe("ok");
  });

  test("v2 quarantine 迁移后绑定原 job 与 lease", () => {
    const databasePath = join(directory.path, "relay.db");
    store.ingest(incomingJob("job-v2-quarantine"), "session-v2-quarantine");
    store.markAcked("job-v2-quarantine");
    store.claimForDispatch(
      "job-v2-quarantine",
      "connector-v2",
      "lease-v2-quarantine",
    );
    expect(store.markConnectorDisconnected("connector-v2")).toBe(1);
    store.close();

    const legacy = new Database(databasePath);
    legacy.exec(`
      ALTER TABLE session_quarantine RENAME TO session_quarantine_v3;
      CREATE TABLE session_quarantine (
        scope_key TEXT NOT NULL,
        session_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(scope_key,session_key)
      );
      INSERT INTO session_quarantine(scope_key,session_key,reason,created_at)
        SELECT scope_key,session_key,reason,created_at
        FROM session_quarantine_v3;
      INSERT INTO session_quarantine(scope_key,session_key,reason,created_at)
        VALUES('account:agent','legacy-orphan','legacy quarantine without job',1);
      DROP TABLE session_quarantine_v3;
      ALTER TABLE jobs DROP COLUMN quarantine_released_at;
      PRAGMA user_version=2;
    `);
    legacy.close();

    store = new JobStore(databasePath, "account:agent");
    expect(store.listQuarantinedSessions()).toHaveLength(2);
    expect(store.finishPrestartFailure(
      "job-v2-quarantine",
      "lease-v2-quarantine",
      '{"text":"unavailable"}',
      "replayed after schema migration",
    ).status).toBe("Failed");
    expect(store.listQuarantinedSessions()).toEqual([{
      sessionKey: "legacy-orphan",
      reason: "legacy quarantine without job",
      createdAt: 1,
    }]);
    expect(store.releaseSessionQuarantine("legacy-orphan")).toBeTrue();
    expect(store.listQuarantinedSessions()).toEqual([]);
    expect(store.integrityCheck()).toBe("ok");
  });

  test("v2 人工释放状态迁移后不被迟到 cancel 恢复隔离", () => {
    const databasePath = join(directory.path, "relay.db");
    for (const [jobId, sessionKey, connectorId, leaseId] of [
      ["legacy-released", "session-released", "connector-released", "lease-released"],
      ["legacy-retained", "session-retained", "connector-retained", "lease-retained"],
    ] as const) {
      store.ingest(incomingJob(jobId), sessionKey);
      store.markAcked(jobId);
      store.claimForDispatch(jobId, connectorId, leaseId);
      store.markRunning(jobId, connectorId, leaseId);
      expect(store.markConnectorDisconnected(connectorId)).toBe(1);
      expect(store.require(jobId).status).toBe("Interrupted");
    }
    store.close();

    const legacy = new Database(databasePath);
    legacy.exec(`
      ALTER TABLE session_quarantine RENAME TO session_quarantine_v3;
      CREATE TABLE session_quarantine (
        scope_key TEXT NOT NULL,
        session_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(scope_key,session_key)
      );
      INSERT INTO session_quarantine(scope_key,session_key,reason,created_at)
        SELECT scope_key,session_key,reason,created_at
        FROM session_quarantine_v3;
      DROP TABLE session_quarantine_v3;
      ALTER TABLE jobs DROP COLUMN quarantine_released_at;
      DELETE FROM session_quarantine
        WHERE scope_key='account:agent' AND session_key='session-released';
      PRAGMA user_version=2;
    `);
    legacy.close();

    store = new JobStore(databasePath, "account:agent");
    const migrated = Reflect.get(store, "database") as Database;
    const releaseMarkers = migrated.query<{
      job_id: string;
      quarantine_released_at: number | null;
    }, []>(`
      SELECT job_id,quarantine_released_at FROM jobs
      WHERE scope_key='account:agent'
        AND job_id IN ('legacy-released','legacy-retained')
      ORDER BY job_id
    `).all();
    expect(releaseMarkers[0]?.job_id).toBe("legacy-released");
    expect(releaseMarkers[0]?.quarantine_released_at).not.toBeNull();
    expect(releaseMarkers[1]).toEqual({
      job_id: "legacy-retained",
      quarantine_released_at: null,
    });
    expect(store.listQuarantinedSessions().map((item) => item.sessionKey)).toEqual([
      "session-retained",
    ]);

    expect(store.requestCancel("legacy-released")?.status).toBe("CancelUnknown");
    expect(store.listQuarantinedSessions().map((item) => item.sessionKey)).toEqual([
      "session-retained",
    ]);
    expect(store.require("legacy-retained").status).toBe("Interrupted");
    expect(store.integrityCheck()).toBe("ok");
  });

  test("v2 同 session 历史 epoch 迁移只绑定当前隔离 job", () => {
    const databasePath = join(directory.path, "relay.db");
    const sessionKey = "session-reused-v2";

    store.ingest(incomingJob("epoch-a"), sessionKey);
    store.markAcked("epoch-a");
    store.claimForDispatch("epoch-a", "connector-a", "lease-a");
    store.markRunning("epoch-a", "connector-a", "lease-a");
    expect(store.markConnectorDisconnected("connector-a")).toBe(1);
    expect(store.require("epoch-a").status).toBe("Interrupted");
    expect(store.releaseSessionQuarantine(sessionKey)).toBeTrue();
    expect(store.require("epoch-a").status).toBe("Interrupted");

    store.ingest(incomingJob("epoch-b"), sessionKey);
    store.markAcked("epoch-b");
    expect(store.claimForDispatch(
      "epoch-b",
      "connector-b",
      "lease-b",
    )).not.toBeNull();
    expect(store.markConnectorDisconnected("connector-b")).toBe(1);
    expect(store.require("epoch-b").status).toBe("Interrupted");
    store.close();

    const legacy = new Database(databasePath);
    legacy.exec(`
      ALTER TABLE session_quarantine RENAME TO session_quarantine_v3;
      CREATE TABLE session_quarantine (
        scope_key TEXT NOT NULL,
        session_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(scope_key,session_key)
      );
      INSERT INTO session_quarantine(scope_key,session_key,reason,created_at)
        SELECT scope_key,session_key,reason,created_at
        FROM session_quarantine_v3;
      DROP TABLE session_quarantine_v3;
      UPDATE jobs
        SET completed_at=1000, updated_at=1000
        WHERE scope_key='account:agent' AND job_id='epoch-a';
      UPDATE jobs
        SET completed_at=2000, updated_at=2000
        WHERE scope_key='account:agent' AND job_id='epoch-b';
      UPDATE session_quarantine
        SET created_at=2000
        WHERE scope_key='account:agent' AND session_key='session-reused-v2';
      ALTER TABLE jobs DROP COLUMN quarantine_released_at;
      PRAGMA user_version=2;
    `);
    legacy.close();

    store = new JobStore(databasePath, "account:agent");
    const migrated = Reflect.get(store, "database") as Database;
    expect(migrated.query<{ job_id: string; lease_id: string }, []>(`
      SELECT job_id,lease_id FROM session_quarantine
      WHERE scope_key='account:agent' AND session_key='session-reused-v2'
      ORDER BY job_id
    `).all()).toEqual([{ job_id: "epoch-b", lease_id: "lease-b" }]);

    const markers = migrated.query<{
      job_id: string;
      quarantine_released_at: number | null;
    }, []>(`
      SELECT job_id,quarantine_released_at FROM jobs
      WHERE scope_key='account:agent' AND job_id IN ('epoch-a','epoch-b')
      ORDER BY job_id
    `).all();
    expect(markers[0]?.job_id).toBe("epoch-a");
    expect(markers[0]?.quarantine_released_at).not.toBeNull();
    expect(markers[1]).toEqual({
      job_id: "epoch-b",
      quarantine_released_at: null,
    });

    expect(store.finishPrestartFailure(
      "epoch-b",
      "lease-b",
      '{"text":"unavailable"}',
      "exact proof for latest epoch",
    ).status).toBe("Failed");
    expect(store.listQuarantinedSessions()).toEqual([]);

    store.ingest(incomingJob("epoch-c"), sessionKey);
    store.markAcked("epoch-c");
    expect(store.claimForDispatch(
      "epoch-c",
      "connector-c",
      "lease-c",
    )).not.toBeNull();
    expect(store.integrityCheck()).toBe("ok");
  });

  test("v2 时间戳碰撞与孤儿隔离保持 fail-closed", () => {
    const databasePath = join(directory.path, "relay.db");

    store.ingest(incomingJob("collision-a"), "session-collision");
    store.markAcked("collision-a");
    store.claimForDispatch("collision-a", "connector-collision-a", "lease-collision-a");
    store.markRunning("collision-a", "connector-collision-a", "lease-collision-a");
    expect(store.markConnectorDisconnected("connector-collision-a")).toBe(1);
    expect(store.releaseSessionQuarantine("session-collision")).toBeTrue();

    store.ingest(incomingJob("collision-b"), "session-collision");
    store.markAcked("collision-b");
    store.claimForDispatch("collision-b", "connector-collision-b", "lease-collision-b");
    store.markRunning("collision-b", "connector-collision-b", "lease-collision-b");
    expect(store.markConnectorDisconnected("connector-collision-b")).toBe(1);

    store.ingest(incomingJob("orphan-source"), "session-orphan-source");
    store.markAcked("orphan-source");
    store.claimForDispatch("orphan-source", "connector-orphan", "lease-orphan");
    store.markRunning("orphan-source", "connector-orphan", "lease-orphan");
    expect(store.markConnectorDisconnected("connector-orphan")).toBe(1);
    store.close();

    const legacy = new Database(databasePath);
    legacy.exec(`
      ALTER TABLE session_quarantine RENAME TO session_quarantine_v3;
      CREATE TABLE session_quarantine (
        scope_key TEXT NOT NULL,
        session_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(scope_key,session_key)
      );
      INSERT INTO session_quarantine(scope_key,session_key,reason,created_at)
        SELECT scope_key,session_key,reason,created_at
        FROM session_quarantine_v3;
      DROP TABLE session_quarantine_v3;
      UPDATE jobs
        SET completed_at=3000, updated_at=3000
        WHERE scope_key='account:agent'
          AND job_id IN ('collision-a','collision-b');
      UPDATE session_quarantine
        SET created_at=3000
        WHERE scope_key='account:agent' AND session_key='session-collision';
      UPDATE jobs
        SET completed_at=4000, updated_at=4000
        WHERE scope_key='account:agent' AND job_id='orphan-source';
      UPDATE session_quarantine
        SET created_at=5000
        WHERE scope_key='account:agent' AND session_key='session-orphan-source';
      ALTER TABLE jobs DROP COLUMN quarantine_released_at;
      PRAGMA user_version=2;
    `);
    legacy.close();

    store = new JobStore(databasePath, "account:agent");
    const migrated = Reflect.get(store, "database") as Database;
    expect(migrated.query<{
      session_key: string;
      job_id: string;
      lease_id: string;
    }, []>(`
      SELECT session_key,job_id,lease_id FROM session_quarantine
      WHERE scope_key='account:agent'
      ORDER BY session_key,job_id
    `).all()).toEqual([
      {
        session_key: "session-collision",
        job_id: "collision-a",
        lease_id: "lease-collision-a",
      },
      {
        session_key: "session-collision",
        job_id: "collision-b",
        lease_id: "lease-collision-b",
      },
      {
        session_key: "session-orphan-source",
        job_id: "",
        lease_id: "",
      },
      {
        session_key: "session-orphan-source",
        job_id: "orphan-source",
        lease_id: "lease-orphan",
      },
    ]);

    expect(store.finishPrestartFailure(
      "collision-b",
      "lease-collision-b",
      '{"text":"unavailable"}',
      "proof for only one colliding epoch",
    ).status).toBe("Failed");
    expect(store.listQuarantinedSessions().map((item) => item.sessionKey)).toEqual([
      "session-collision",
      "session-orphan-source",
    ]);

    expect(store.releaseSessionQuarantine("session-collision")).toBeTrue();
    expect(store.requestCancel("collision-a")?.status).toBe("CancelUnknown");
    expect(store.listQuarantinedSessions().map((item) => item.sessionKey)).toEqual([
      "session-orphan-source",
    ]);

    expect(store.releaseSessionQuarantine("session-orphan-source")).toBeTrue();
    expect(store.requestCancel("orphan-source")?.status).toBe("CancelUnknown");
    expect(store.listQuarantinedSessions()).toEqual([]);
    expect(store.integrityCheck()).toBe("ok");
  });

  test("v2 迟到取消覆盖隔离 epoch 时保留 sentinel", () => {
    const databasePath = join(directory.path, "relay.db");
    const sessionKey = "session-late-cancel-v2";

    store.ingest(incomingJob("historic-exact"), sessionKey);
    store.markAcked("historic-exact");
    store.claimForDispatch("historic-exact", "connector-historic", "lease-historic");
    store.markRunning("historic-exact", "connector-historic", "lease-historic");
    expect(store.markConnectorDisconnected("connector-historic")).toBe(1);
    expect(store.releaseSessionQuarantine(sessionKey)).toBeTrue();

    store.ingest(incomingJob("cancelled-origin"), sessionKey);
    store.markAcked("cancelled-origin");
    store.claimForDispatch("cancelled-origin", "connector-origin", "lease-origin");
    store.markRunning("cancelled-origin", "connector-origin", "lease-origin");
    expect(store.markConnectorDisconnected("connector-origin")).toBe(1);
    store.close();

    const legacy = new Database(databasePath);
    legacy.exec(`
      ALTER TABLE session_quarantine RENAME TO session_quarantine_v3;
      CREATE TABLE session_quarantine (
        scope_key TEXT NOT NULL,
        session_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(scope_key,session_key)
      );
      INSERT INTO session_quarantine(scope_key,session_key,reason,created_at)
        SELECT scope_key,session_key,reason,created_at
        FROM session_quarantine_v3;
      DROP TABLE session_quarantine_v3;
      UPDATE jobs
        SET completed_at=6000, updated_at=6000
        WHERE scope_key='account:agent' AND job_id='historic-exact';
      UPDATE session_quarantine
        SET created_at=6000
        WHERE scope_key='account:agent' AND session_key='session-late-cancel-v2';
      UPDATE jobs
        SET status='Cancelled', cancel_requested=1,
            completed_at=7000, updated_at=7000
        WHERE scope_key='account:agent' AND job_id='cancelled-origin';
      ALTER TABLE jobs DROP COLUMN quarantine_released_at;
      PRAGMA user_version=2;
    `);
    legacy.close();

    store = new JobStore(databasePath, "account:agent");
    const migrated = Reflect.get(store, "database") as Database;
    expect(migrated.query<{ job_id: string; lease_id: string }, []>(`
      SELECT job_id,lease_id FROM session_quarantine
      WHERE scope_key='account:agent' AND session_key='session-late-cancel-v2'
      ORDER BY job_id
    `).all()).toEqual([
      { job_id: "", lease_id: "" },
      { job_id: "cancelled-origin", lease_id: "lease-origin" },
      { job_id: "historic-exact", lease_id: "lease-historic" },
    ]);

    expect(store.finishPrestartFailure(
      "historic-exact",
      "lease-historic",
      '{"text":"unavailable"}',
      "historic proof must not unlock drifted origin",
    ).status).toBe("Failed");
    expect(store.listQuarantinedSessions().map((item) => item.sessionKey)).toEqual([
      sessionKey,
    ]);

    expect(store.releaseSessionQuarantine(sessionKey)).toBeTrue();
    expect(store.listQuarantinedSessions()).toEqual([]);
    store.ingest(incomingJob("after-late-cancel-migration"), sessionKey);
    store.markAcked("after-late-cancel-migration");
    expect(store.claimForDispatch(
      "after-late-cancel-migration",
      "connector-next",
      "lease-next",
    )).not.toBeNull();
    expect(store.integrityCheck()).toBe("ok");
  });

  test("v2 迁移中途失败时完整回滚 schema", () => {
    const database = Reflect.get(store, "database") as Database;
    database.exec(`
      ALTER TABLE session_quarantine RENAME TO session_quarantine_v3;
      CREATE TABLE session_quarantine (
        scope_key TEXT NOT NULL,
        session_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(scope_key,session_key)
      );
      INSERT INTO session_quarantine(scope_key,session_key,reason,created_at)
        VALUES('account:agent','migration-fault','keep legacy row',1);
      DROP TABLE session_quarantine_v3;
      ALTER TABLE jobs DROP COLUMN quarantine_released_at;
      PRAGMA user_version=2;
    `);

    const migrate = Reflect.get(store, "migrate") as () => void;
    const originalExec = database.exec.bind(database);
    let injected = false;
    Reflect.set(database, "exec", (sql: string) => {
      const failurePoint = sql.indexOf("DROP TABLE session_quarantine_v2;");
      if (!injected && failurePoint !== -1) {
        injected = true;
        originalExec(sql.slice(0, failurePoint));
        throw new Error("injected v2 migration failure");
      }
      return originalExec(sql);
    });
    try {
      expect(() => migrate.call(store)).toThrow("injected v2 migration failure");
    } finally {
      Reflect.set(database, "exec", originalExec);
    }
    expect(injected).toBeTrue();

    expect(database.query<{ user_version: number }, []>(
      "PRAGMA user_version",
    ).get()?.user_version).toBe(2);
    expect(database.query<{ name: string }, []>(`
      SELECT name FROM sqlite_schema
      WHERE type='table' AND name LIKE 'session_quarantine%'
      ORDER BY name
    `).all().map((row) => row.name)).toEqual(["session_quarantine"]);
    expect(database.query<{ name: string }, []>(
      "PRAGMA table_info(jobs)",
    ).all().map((row) => row.name)).not.toContain("quarantine_released_at");
    expect(database.query<{ name: string }, []>(
      "PRAGMA table_info(session_quarantine)",
    ).all().map((row) => row.name)).toEqual([
      "scope_key",
      "session_key",
      "reason",
      "created_at",
    ]);
    expect(database.query<{ reason: string }, []>(`
      SELECT reason FROM session_quarantine
      WHERE scope_key='account:agent' AND session_key='migration-fault'
    `).get()?.reason).toBe("keep legacy row");
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

  test("重复 cancel 保持 Cancelling 并继续隔离同 session", () => {
    for (const jobId of ["active-job", "next-job"]) {
      store.ingest(incomingJob(jobId), "session-cancel-risk");
      store.markAcked(jobId);
    }
    store.claimForDispatch("active-job", "connector", "lease-active");
    store.markRunning("active-job", "connector", "lease-active");

    expect(store.requestCancel("active-job")?.status).toBe("Cancelling");
    expect(store.requestCancel("active-job")?.status).toBe("Cancelling");
    expect(store.claimForDispatch("next-job", "connector", "lease-next")).toBeNull();

    const cancelled = store.markCancelUnknown(
      "active-job",
      "lease-active",
      "best-effort cancel",
    );
    expect(cancelled.status).toBe("CancelUnknown");
    expect(store.listQuarantinedSessions().map((item) => item.sessionKey)).toContain(
      "session-cancel-risk",
    );
    expect(store.releaseSessionQuarantine("session-cancel-risk")).toBeTrue();
    expect(store.requestCancel("active-job")?.status).toBe("CancelUnknown");
    expect(store.listQuarantinedSessions()).toEqual([]);
  });

  test("Hermes 未启动的拒绝与 cancel 竞态都能结算", () => {
    store.ingest(incomingJob("rejected-first"), "session-1");
    store.markAcked("rejected-first");
    store.claimForDispatch("rejected-first", "connector", "lease-rejected");
    const rejected = store.finishPrestartFailure(
      "rejected-first",
      "lease-rejected",
      '{"text":"unavailable"}',
      "remote command rejected",
    );
    expect(rejected.status).toBe("Failed");
    expect(rejected.outbox?.status).toBe("Pending");

    // accepted only transfers the lease to the adapter. A disconnect can close
    // the gate before Hermes sees the event, so the exact notStarted proof must
    // also be able to settle that transient Running representation.
    store.ingest(incomingJob("accepted-before-drain"), "session-accepted-drain");
    store.markAcked("accepted-before-drain");
    store.claimForDispatch(
      "accepted-before-drain",
      "connector",
      "lease-accepted-drain",
    );
    store.markRunning(
      "accepted-before-drain",
      "connector",
      "lease-accepted-drain",
    );
    const drainedAfterAccepted = store.finishPrestartFailure(
      "accepted-before-drain",
      "lease-accepted-drain",
      '{"text":"unavailable"}',
      "connector drained before Hermes dispatch",
    );
    expect(drainedAfterAccepted.status).toBe("Failed");
    expect(drainedAfterAccepted.outbox?.status).toBe("Pending");

    store.ingest(incomingJob("cancel-first"), "session-2");
    store.markAcked("cancel-first");
    store.claimForDispatch("cancel-first", "connector", "lease-cancel");
    expect(store.requestCancel("cancel-first")?.status).toBe("Cancelling");
    const cancelled = store.finishPrestartFailure(
      "cancel-first",
      "lease-cancel",
      '{"text":"unavailable"}',
      "remote command rejected before dispatch",
    );
    expect(cancelled.status).toBe("Cancelled");
    expect(cancelled.outbox).toBeNull();
    expect(store.listQuarantinedSessions()).toEqual([]);

    store.ingest(incomingJob("next-job"), "session-2");
    store.markAcked("next-job");
    expect(store.claimForDispatch("next-job", "connector", "lease-next")).not.toBeNull();
  });

  test("派发前拒绝证明可消解断线产生的假歧义", () => {
    store.ingest(incomingJob("rejected-disconnect"), "session-rejected");
    store.markAcked("rejected-disconnect");
    store.claimForDispatch(
      "rejected-disconnect",
      "connector",
      "lease-rejected-disconnect",
    );
    expect(store.markConnectorDisconnected("connector")).toBe(1);
    expect(store.require("rejected-disconnect").status).toBe("Interrupted");
    expect(store.listQuarantinedSessions()).toHaveLength(1);

    const rejected = store.finishPrestartFailure(
      "rejected-disconnect",
      "lease-rejected-disconnect",
      '{"text":"unavailable"}',
      "replayed pre-start rejection",
    );
    expect(rejected.status).toBe("Failed");
    expect(rejected.outbox?.status).toBe("Pending");
    expect(store.listQuarantinedSessions()).toEqual([]);

    store.ingest(incomingJob("cancelled-disconnect"), "session-cancelled");
    store.markAcked("cancelled-disconnect");
    store.claimForDispatch(
      "cancelled-disconnect",
      "connector",
      "lease-cancelled-disconnect",
    );
    expect(store.requestCancel("cancelled-disconnect")?.status).toBe("Cancelling");
    expect(store.markConnectorDisconnected("connector")).toBe(1);
    expect(store.require("cancelled-disconnect").status).toBe("CancelUnknown");
    expect(store.listQuarantinedSessions()).toHaveLength(1);

    const cancelled = store.finishPrestartFailure(
      "cancelled-disconnect",
      "lease-cancelled-disconnect",
      '{"text":"unavailable"}',
      "replayed pre-start rejection after cancel",
    );
    expect(cancelled.status).toBe("Cancelled");
    expect(cancelled.outbox).toBeNull();
    expect(store.listQuarantinedSessions()).toEqual([]);
  });

  test("旧未执行证明只能解除其原 job 与 lease", () => {
    store.ingest(incomingJob("old-rejection"), "shared-session");
    store.markAcked("old-rejection");
    store.claimForDispatch("old-rejection", "connector", "lease-old");
    expect(store.markConnectorDisconnected("connector")).toBe(1);
    expect(store.require("old-rejection").status).toBe("Interrupted");
    expect(store.releaseSessionQuarantine("shared-session")).toBeTrue();

    store.ingest(incomingJob("real-execution"), "shared-session");
    store.markAcked("real-execution");
    store.claimForDispatch("real-execution", "connector", "lease-real");
    store.markRunning("real-execution", "connector", "lease-real");
    expect(store.markConnectorDisconnected("connector")).toBe(1);
    expect(store.require("real-execution").status).toBe("Interrupted");
    expect(store.requestCancel("real-execution")?.status).toBe("CancelUnknown");
    expect(store.listQuarantinedSessions()).toHaveLength(1);

    expect(store.finishPrestartFailure(
      "old-rejection",
      "lease-old",
      '{"text":"unavailable"}',
      "replayed old pre-start rejection",
    ).status).toBe("Failed");
    expect(store.require("real-execution").status).toBe("CancelUnknown");
    expect(store.listQuarantinedSessions()).toHaveLength(1);
  });

  test("人工释放的历史歧义不阻塞后续匹配 proof", () => {
    store.ingest(incomingJob("historical-run"), "reused-session");
    store.markAcked("historical-run");
    store.claimForDispatch("historical-run", "connector-old", "lease-old-run");
    store.markRunning("historical-run", "connector-old", "lease-old-run");
    expect(store.markConnectorDisconnected("connector-old")).toBe(1);
    expect(store.require("historical-run").status).toBe("Interrupted");
    expect(store.releaseSessionQuarantine("reused-session")).toBeTrue();

    store.ingest(incomingJob("new-prestart"), "reused-session");
    store.markAcked("new-prestart");
    store.claimForDispatch("new-prestart", "connector-new", "lease-new-prestart");
    expect(store.markConnectorDisconnected("connector-new")).toBe(1);
    expect(store.listQuarantinedSessions()).toHaveLength(1);

    expect(store.finishPrestartFailure(
      "new-prestart",
      "lease-new-prestart",
      '{"text":"unavailable"}',
      "matching new proof",
    ).status).toBe("Failed");
    expect(store.listQuarantinedSessions()).toEqual([]);

    store.ingest(incomingJob("after-proof"), "reused-session");
    store.markAcked("after-proof");
    expect(store.claimForDispatch(
      "after-proof",
      "connector-after",
      "lease-after",
    )).not.toBeNull();
  });

  test("人工释放 Interrupted 后的迟到 cancel 不会恢复隔离", () => {
    store.ingest(incomingJob("released-interrupted"), "released-session");
    store.markAcked("released-interrupted");
    store.claimForDispatch(
      "released-interrupted",
      "connector-release",
      "lease-release",
    );
    store.markRunning("released-interrupted", "connector-release", "lease-release");
    expect(store.markConnectorDisconnected("connector-release")).toBe(1);
    expect(store.require("released-interrupted").status).toBe("Interrupted");
    expect(store.releaseSessionQuarantine("released-session")).toBeTrue();

    expect(store.requestCancel("released-interrupted")?.status).toBe("CancelUnknown");
    expect(store.listQuarantinedSessions()).toEqual([]);

    store.ingest(incomingJob("after-late-cancel"), "released-session");
    store.markAcked("after-late-cancel");
    expect(store.claimForDispatch(
      "after-late-cancel",
      "connector-after-release",
      "lease-after-release",
    )).not.toBeNull();
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
