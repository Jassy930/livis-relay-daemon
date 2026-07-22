import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import {
  BackendSessionConflictError,
  JobConflictError,
  JobStore,
  PENDING_CANCEL_MAX_ROWS,
  PendingCancelCapacityError,
  PENDING_CANCEL_TTL_MS,
} from "../src/state/store.ts";
import { incomingJob, temporaryDirectory } from "./helpers.ts";

const BACKEND_SESSION_METADATA = {
  accountType: "chatgpt",
  accountSubjectSha256: "b".repeat(64),
  accountIdentityStrength: "subject" as const,
  requestedModel: null,
  effectiveModel: "gpt-5.6-sol",
  modelProvider: "openai",
  securityConfigSha256: "c".repeat(64),
  featureSnapshotSha256: "d".repeat(64),
  checkpointTurnId: null,
  checkpointTurnStatus: null,
  checkpointTurnCount: 0,
  checkpointTurnsSha256: "e".repeat(64),
  checkpointedAt: 100,
};

function pendingCancelCount(databasePath: string): number {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pending_cancels")
      .get()?.count ?? 0;
  } finally {
    database.close();
  }
}

interface DatabaseHealth {
  version: number;
  integrity: string;
  foreignKeyViolations: Array<Record<string, unknown>>;
  outboxColumns: string[];
  backendSessionColumns: string[];
  jobColumns: string[];
  executionAttemptEventColumns: string[];
}

function databaseHealth(databasePath: string): DatabaseHealth {
  const database = new Database(databasePath, { strict: true });
  try {
    const version = database.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    const integrity = database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()!.integrity_check;
    const foreignKeyViolations = database
      .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
      .all();
    const outboxColumns = database
      .query<{ name: string }, []>("PRAGMA table_info(outbox)")
      .all()
      .map((column) => column.name);
    const backendSessionColumns = database
      .query<{ name: string }, []>("PRAGMA table_info(backend_sessions)")
      .all()
      .map((column) => column.name);
    const jobColumns = database
      .query<{ name: string }, []>("PRAGMA table_info(jobs)")
      .all()
      .map((column) => column.name);
    const executionAttemptEventColumns = database
      .query<{ name: string }, []>("PRAGMA table_info(execution_attempt_events)")
      .all()
      .map((column) => column.name);
    return {
      version,
      integrity,
      foreignKeyViolations,
      outboxColumns,
      backendSessionColumns,
      jobColumns,
      executionAttemptEventColumns,
    };
  } finally {
    database.close();
  }
}

function expectHealthyV7(databasePath: string): void {
  const health = databaseHealth(databasePath);
  expect(health.version).toBe(7);
  expect(health.integrity).toBe("ok");
  expect(health.foreignKeyViolations).toEqual([]);
  expect(health.outboxColumns).toContain("next_attempt_at");
  expect(health.backendSessionColumns).toContain("active_turn_id");
  expect(health.backendSessionColumns).toContain("recovery_required");
  expect(health.backendSessionColumns).toContain("account_type");
  expect(health.backendSessionColumns).toContain("feature_snapshot_sha256");
  expect(health.backendSessionColumns).toContain("checkpoint_turn_count");
  expect(health.backendSessionColumns).toContain("checkpoint_turns_sha256");
  expect(health.jobColumns).toContain("target_backend");
  expect(health.executionAttemptEventColumns).toContain("provider_session_id");
  expect(health.executionAttemptEventColumns).toContain("provider_operation_id");
  expect(health.executionAttemptEventColumns).toContain("event_type");
}

const DROP_V7_EXECUTION_ATTEMPTS = `
  DROP TRIGGER execution_attempt_events_no_update;
  DROP TRIGGER execution_attempt_events_no_delete;
  DROP TABLE execution_attempt_events;
  DROP TRIGGER jobs_target_backend_immutable;
`;

const DROP_V6_BACKEND_METADATA = `
  DROP TRIGGER backend_sessions_v6_metadata_insert_required;
  DROP TRIGGER backend_sessions_v6_metadata_binding_complete;
  DROP TRIGGER backend_sessions_v6_metadata_immutable;
  DROP TRIGGER backend_sessions_v6_checkpoint_shape;
  DROP TRIGGER backend_sessions_v6_checkpoint_monotonic;
  ALTER TABLE backend_sessions DROP COLUMN checkpointed_at;
  ALTER TABLE backend_sessions DROP COLUMN checkpoint_turns_sha256;
  ALTER TABLE backend_sessions DROP COLUMN checkpoint_turn_count;
  ALTER TABLE backend_sessions DROP COLUMN checkpoint_turn_status;
  ALTER TABLE backend_sessions DROP COLUMN checkpoint_turn_id;
  ALTER TABLE backend_sessions DROP COLUMN feature_snapshot_sha256;
  ALTER TABLE backend_sessions DROP COLUMN security_config_sha256;
  ALTER TABLE backend_sessions DROP COLUMN model_provider;
  ALTER TABLE backend_sessions DROP COLUMN effective_model;
  ALTER TABLE backend_sessions DROP COLUMN requested_model;
  ALTER TABLE backend_sessions DROP COLUMN account_identity_strength;
  ALTER TABLE backend_sessions DROP COLUMN account_subject_sha256;
  ALTER TABLE backend_sessions DROP COLUMN account_type;
`;

const DROP_V5_JOB_BACKEND = `
  DROP TRIGGER jobs_target_backend_insert_required;
  DROP TRIGGER jobs_target_backend_update_required;
  DROP INDEX idx_jobs_dispatch;
  ALTER TABLE jobs DROP COLUMN target_backend;
  CREATE INDEX idx_jobs_dispatch ON jobs(scope_key,status,cancel_requested,session_key,created_at);
`;

function downgradeV7ToV6(databasePath: string): void {
  const database = new Database(databasePath, { strict: true });
  database.exec(`${DROP_V7_EXECUTION_ATTEMPTS} PRAGMA user_version=6;`);
  database.close();
}

function downgradeV6ToV5(databasePath: string): void {
  const database = new Database(databasePath, { strict: true });
  database.exec(`${DROP_V7_EXECUTION_ATTEMPTS} ${DROP_V6_BACKEND_METADATA} PRAGMA user_version=5;`);
  database.close();
}

function downgradeV6ToV4(databasePath: string): void {
  const database = new Database(databasePath, { strict: true });
  database.exec(`${DROP_V7_EXECUTION_ATTEMPTS} ${DROP_V6_BACKEND_METADATA} ${DROP_V5_JOB_BACKEND} PRAGMA user_version=4;`);
  database.close();
}

function downgradeV4ToV2(databasePath: string): void {
  const database = new Database(databasePath, { strict: true });
  database.exec(`
    ${DROP_V7_EXECUTION_ATTEMPTS}
    ${DROP_V6_BACKEND_METADATA}
    ${DROP_V5_JOB_BACKEND}
    DROP TABLE backend_sessions;
    DROP INDEX idx_outbox_delivery;
    DROP INDEX idx_pending_cancels_gc;
    ALTER TABLE outbox DROP COLUMN next_attempt_at;
    CREATE INDEX idx_outbox_delivery ON outbox(scope_key,status,updated_at);
    PRAGMA user_version=2;
  `);
  database.close();
}

function downgradeV4ToV1(databasePath: string): void {
  const database = new Database(databasePath, { strict: true });
  database.exec(`
    ${DROP_V7_EXECUTION_ATTEMPTS}
    ${DROP_V6_BACKEND_METADATA}
    ${DROP_V5_JOB_BACKEND}
    DROP TABLE backend_sessions;
    DROP INDEX idx_outbox_delivery;
    DROP INDEX idx_pending_cancels_gc;
    DROP TABLE outbox_delivery_attempts;
    ALTER TABLE outbox DROP COLUMN next_attempt_at;
    CREATE INDEX idx_outbox_delivery ON outbox(scope_key,status,updated_at);
    PRAGMA user_version=1;
  `);
  database.close();
}

function downgradeV4ToV3(databasePath: string): void {
  const database = new Database(databasePath, { strict: true });
  database.exec(`${DROP_V7_EXECUTION_ATTEMPTS} ${DROP_V6_BACKEND_METADATA} ${DROP_V5_JOB_BACKEND} DROP TABLE backend_sessions; PRAGMA user_version=3;`);
  database.close();
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`等待子进程 marker 超时：${path}`);
    await Bun.sleep(5);
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

  test("job 首次入库即绑定 backend，配置切换与重复投递都不能改写", () => {
    const first = store.ingest(incomingJob("provider-bound"), "session-1", "codex");
    expect(first.job.targetBackend).toBe("codex");
    store.markAcked("provider-bound");

    const duplicateAfterSwitch = store.ingest(
      incomingJob("provider-bound"),
      "session-1",
      "hermes",
    );
    expect(duplicateAfterSwitch.inserted).toBeFalse();
    expect(duplicateAfterSwitch.job.targetBackend).toBe("codex");
    expect(store.listDispatchable("hermes").map((job) => job.jobId)).not.toContain("provider-bound");
    expect(store.listDispatchable("codex").map((job) => job.jobId)).toContain("provider-bound");
    expect(store.claimForDispatch("provider-bound", "hermes-connector", "lease-hermes"))
      .toBeNull();
    expect(store.require("provider-bound").status).toBe("Acked");
    expect(store.listBackendBacklog()).toEqual([{
      backend: "codex",
      count: 1,
      oldestCreatedAt: first.job.createdAt,
    }]);

    const direct = new Database(join(directory.path, "relay.db"), { strict: true });
    try {
      expect(() => direct.query(
        "UPDATE jobs SET target_backend='hermes' WHERE scope_key=? AND job_id=?",
      ).run("account:agent", "provider-bound")).toThrow("jobs.target_backend is immutable");
    } finally {
      direct.close();
    }
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
    expect(store.listExecutionAttemptEvents("job-1").map((event) => ({
      eventType: event.eventType,
      backend: event.backend,
      providerSessionId: event.providerSessionId,
      backendExecutionId: event.backendExecutionId,
    }))).toEqual([
      {
        eventType: "reserved",
        backend: "hermes",
        providerSessionId: null,
        backendExecutionId: "connector",
      },
      {
        eventType: "accepted",
        backend: "hermes",
        providerSessionId: null,
        backendExecutionId: "connector",
      },
      {
        eventType: "succeeded",
        backend: "hermes",
        providerSessionId: null,
        backendExecutionId: "connector",
      },
    ]);
    expect(store.startResultDelivery("job-1", "result-msg-1", false)?.retryCount).toBe(0);
    expect(store.startResultDelivery("job-1", "result-msg-2", true)?.retryCount).toBe(1);
    expect(store.findJobIdByOutboxMessageId("result-msg-1")).toBe("job-1");
    expect(store.findJobIdByOutboxMessageId("result-msg-2")).toBe("job-1");
    expect(store.findJobIdByOutboxMessageId("unknown-msg")).toBeNull();
    expect(store.markOutboxDelivered("job-1")?.status).toBe("Delivered");
    expect(store.markOutboxDelivered("no-such-job")).toBeNull();
    expect(store.integrityCheck()).toBe("ok");
  });

  test("execution attempt ledger 拒绝 UPDATE/DELETE", () => {
    store.ingest(incomingJob("attempt-append-only"), "session-append-only");
    store.markAcked("attempt-append-only");
    store.claimForDispatch("attempt-append-only", "connector", "lease-append-only");
    store.markRunning("attempt-append-only", "connector", "lease-append-only");
    store.finishFailure(
      "attempt-append-only",
      "lease-append-only",
      '{"text":"failed"}',
      "synthetic failure",
    );

    const direct = new Database(join(directory.path, "relay.db"), { strict: true });
    try {
      expect(() => direct.query(
        "UPDATE execution_attempt_events SET reason='tampered' WHERE job_id='attempt-append-only'",
      ).run()).toThrow("execution_attempt_events is append-only");
      expect(() => direct.query(
        "DELETE FROM execution_attempt_events WHERE job_id='attempt-append-only'",
      ).run()).toThrow("execution_attempt_events is append-only");
    } finally {
      direct.close();
    }
    expect(store.listExecutionAttemptEvents("attempt-append-only").map((event) => event.eventType))
      .toEqual(["reserved", "accepted", "failed"]);
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

    downgradeV4ToV1(databasePath);

    store = new JobStore(databasePath, "account:agent");
    expect(store.findJobIdByOutboxMessageId("legacy-result-msg")).toBe("job-migrated");
    expect(store.integrityCheck()).toBe("ok");
    store.close();
    expectHealthyV7(databasePath);
    store = new JobStore(databasePath, "account:agent");
  });

  test("v2 中已失败的 outbox 迁移后立即恢复投递", () => {
    const databasePath = join(directory.path, "relay.db");
    store.ingest(incomingJob("legacy-failed"), "session-1");
    store.markAcked("legacy-failed");
    store.claimForDispatch("legacy-failed", "connector", "lease-1");
    store.markRunning("legacy-failed", "connector", "lease-1");
    store.finishSuccess("legacy-failed", "lease-1", '{"text":"done"}');
    store.startResultDelivery("legacy-failed", "legacy-failed-msg", false);
    store.markOutboxAckFailed("legacy-failed", Date.now() + 60_000);
    store.close();

    downgradeV4ToV2(databasePath);

    store = new JobStore(databasePath, "account:agent");
    const migrated = store.require("legacy-failed").outbox!;
    expect(migrated.status).toBe("Pending");
    expect(migrated.retryCount).toBe(0);
    expect(migrated.nextAttemptAt).toBeNull();
    expect(store.listPendingOutbox().map((outbox) => outbox.jobId)).toContain("legacy-failed");
    expect(store.integrityCheck()).toBe("ok");
  });

  test("AckFailed 是持久化退避态，迟到 ACK 仍可完成投递", () => {
    store.ingest(incomingJob("delayed-ack"), "session-1");
    store.markAcked("delayed-ack");
    store.claimForDispatch("delayed-ack", "connector", "lease-1");
    store.markRunning("delayed-ack", "connector", "lease-1");
    store.finishSuccess("delayed-ack", "lease-1", '{"text":"done"}');
    expect(store.markOutboxDelivered("delayed-ack")).toBeNull();
    store.startResultDelivery("delayed-ack", "result-msg", false);
    const nextAttemptAt = Date.now() + 60_000;
    const failed = store.markOutboxAckFailed("delayed-ack", nextAttemptAt)!;

    expect(failed.status).toBe("AckFailed");
    expect(failed.nextAttemptAt).toBe(nextAttemptAt);
    expect(store.listPendingOutbox(100, nextAttemptAt - 1)).toHaveLength(0);
    expect(store.nextOutboxAttemptAt()).toBe(nextAttemptAt);
    expect(store.markOutboxDelivered("delayed-ack")?.status).toBe("Delivered");
    expect(store.nextOutboxAttemptAt()).toBeNull();
  });

  test("同步发送失败会撤销未出进程的投递 ID 与投递时间", () => {
    store.ingest(incomingJob("send-failed"), "session-1");
    store.markAcked("send-failed");
    store.claimForDispatch("send-failed", "connector", "lease-1");
    store.markRunning("send-failed", "connector", "lease-1");
    store.finishSuccess("send-failed", "lease-1", '{"text":"done"}');

    store.startResultDelivery("send-failed", "never-sent", false);
    const reset = store.resetOutboxPendingAfterSendFailure("send-failed", "never-sent", false)!;
    expect(reset.status).toBe("Pending");
    expect(reset.lastMessageId).toBeNull();
    expect(reset.deliveredAt).toBeNull();
    expect(reset.retryCount).toBe(0);
    expect(store.findJobIdByOutboxMessageId("never-sent")).toBeNull();
    expect(store.markOutboxDelivered("send-failed")).toBeNull();

    const first = store.startResultDelivery("send-failed", "sent-once", false)!;
    store.startResultDelivery("send-failed", "retry-never-sent", true);
    const retryReset = store.resetOutboxPendingAfterSendFailure(
      "send-failed",
      "retry-never-sent",
      true,
    )!;
    expect(retryReset.status).toBe("Pending");
    expect(retryReset.lastMessageId).toBe("sent-once");
    expect(retryReset.deliveredAt).toBe(first.deliveredAt);
    expect(retryReset.retryCount).toBe(0);
    expect(store.findJobIdByOutboxMessageId("retry-never-sent")).toBeNull();
    expect(store.findJobIdByOutboxMessageId("sent-once")).toBe("send-failed");
  });

  test("重启后到期 AckFailed 从新的重试周期继续", () => {
    const databasePath = join(directory.path, "relay.db");
    store.ingest(incomingJob("restart-recovery"), "session-1");
    store.markAcked("restart-recovery");
    store.claimForDispatch("restart-recovery", "connector", "lease-1");
    store.markRunning("restart-recovery", "connector", "lease-1");
    store.finishSuccess("restart-recovery", "lease-1", '{"text":"done"}');
    store.startResultDelivery("restart-recovery", "result-msg-1", false);
    store.startResultDelivery("restart-recovery", "result-msg-2", true);
    store.markOutboxAckFailed("restart-recovery", Date.now() - 1);
    store.close();

    store = new JobStore(databasePath, "account:agent");
    store.recoverAfterRestart();
    expect(store.listPendingOutbox().map((outbox) => outbox.jobId)).toContain("restart-recovery");
    const recovered = store.startResultDelivery("restart-recovery", "result-msg-3", false)!;
    expect(recovered.status).toBe("Delivering");
    expect(recovered.retryCount).toBe(0);
    expect(recovered.nextAttemptAt).toBeNull();
    expect(store.findJobIdByOutboxMessageId("result-msg-1")).toBe("restart-recovery");
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

  test("schema v2 迁移到 v7 时补 GC 索引，并在 daemon 恢复时清除历史 intent", () => {
    const databasePath = join(directory.path, "relay.db");
    store.ingest(incomingJob("matched-job"), "session-1");
    store.close();

    downgradeV4ToV2(databasePath);
    const legacy = new Database(databasePath);
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
    const outboxColumns = migrated.query<{ name: string }, []>("PRAGMA table_info(outbox)")
      .all().map((row) => row.name);
    migrated.close();
    expect(indexes).toContain("idx_pending_cancels_gc");
    expect(version?.user_version).toBe(7);
    expect(outboxColumns).toContain("next_attempt_at");
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

describe("backend session durability", () => {
  const backend = "codex";
  const sessionKey = "livis:agent";
  const sessionHash = "a".repeat(64);
  let directory: Awaited<ReturnType<typeof temporaryDirectory>>;
  let databasePath: string;
  let store: JobStore;

  beforeEach(async () => {
    directory = await temporaryDirectory("livis-backend-session-");
    databasePath = join(directory.path, "relay.db");
    store = new JobStore(databasePath, "account:agent");
  });

  afterEach(async () => {
    store.close();
    await directory.cleanup();
  });

  function ensureSession() {
    return store.ensureBackendSession({
      ...BACKEND_SESSION_METADATA,
      backend,
      sessionKey,
      sessionHash,
      cwd: join(directory.path, "sessions", sessionHash, "workspace"),
      cliVersion: "0.1.0",
    });
  }

  function prepareRunningJob(jobId = "codex-job") {
    ensureSession();
    store.bindBackendThread(backend, sessionKey, "thread-1");
    store.ingest(incomingJob(jobId), sessionKey, backend);
    store.markAcked(jobId);
    const claimed = store.claimForBackendDispatch(jobId, backend, "codex:process-1", "lease-1")!;
    expect(claimed.status).toBe("Dispatching");
    return claimed;
  }

  test("ensure/get/bind thread 幂等且 immutable metadata 冲突失败关闭", () => {
    const created = ensureSession();
    expect(created.threadId).toBeNull();
    expect(created.recoveryRequired).toBeFalse();
    expect(created.accountType).toBe(BACKEND_SESSION_METADATA.accountType);
    expect(created.accountSubjectSha256).toBe(BACKEND_SESSION_METADATA.accountSubjectSha256);
    expect(created.accountIdentityStrength).toBe("subject");
    expect(created.requestedModel).toBeNull();
    expect(created.effectiveModel).toBe(BACKEND_SESSION_METADATA.effectiveModel);
    expect(created.modelProvider).toBe(BACKEND_SESSION_METADATA.modelProvider);
    expect(created.securityConfigSha256).toBe(BACKEND_SESSION_METADATA.securityConfigSha256);
    expect(created.featureSnapshotSha256).toBe(BACKEND_SESSION_METADATA.featureSnapshotSha256);
    expect(created.checkpointTurnId).toBeNull();
    expect(created.checkpointTurnStatus).toBeNull();
    expect(created.checkpointTurnCount).toBe(0);
    expect(created.checkpointTurnsSha256).toBe(BACKEND_SESSION_METADATA.checkpointTurnsSha256);
    expect(created.checkpointedAt).toBe(BACKEND_SESSION_METADATA.checkpointedAt);
    expect(store.getBackendSession(backend, sessionKey)).toEqual(created);
    expect(ensureSession()).toEqual(created);

    const bound = store.bindBackendThread(backend, sessionKey, "thread-1");
    expect(bound.threadId).toBe("thread-1");
    expect(store.bindBackendThread(backend, sessionKey, "thread-1").threadId).toBe("thread-1");
    expect(() => store.bindBackendThread(backend, sessionKey, "thread-2"))
      .toThrow(BackendSessionConflictError);
    expect(() => store.ensureBackendSession({
      ...BACKEND_SESSION_METADATA,
      backend,
      sessionKey,
      sessionHash,
      cwd: join(directory.path, "different"),
      cliVersion: "0.1.0",
    })).toThrow(BackendSessionConflictError);

    for (const immutableDrift of [
      { accountType: "apiKey", accountSubjectSha256: null, accountIdentityStrength: "type-only" as const },
      { requestedModel: "gpt-5.6-sol" },
      { effectiveModel: "gpt-5.7" },
      { modelProvider: "different-provider" },
      { securityConfigSha256: "1".repeat(64) },
      { featureSnapshotSha256: "2".repeat(64) },
    ]) {
      expect(() => store.ensureBackendSession({
        ...BACKEND_SESSION_METADATA,
        ...immutableDrift,
        backend,
        sessionKey,
        sessionHash,
        cwd: join(directory.path, "sessions", sessionHash, "workspace"),
        cliVersion: "0.1.0",
      })).toThrow(BackendSessionConflictError);
    }

    const direct = new Database(databasePath, { strict: true });
    expect(() => direct
      .query("UPDATE backend_sessions SET effective_model='direct-drift' WHERE backend=?")
      .run(backend)).toThrow("immutable metadata drift");
    direct.close();
  });

  test("idle thread-tail checkpoint 单调、幂等并受 quarantine 保护", () => {
    ensureSession();
    store.bindBackendThread(backend, sessionKey, "thread-1");
    const firstInput = {
      backend,
      sessionKey,
      threadId: "thread-1",
      checkpointTurnId: "turn-1",
      checkpointTurnStatus: "completed" as const,
      checkpointTurnCount: 1,
      checkpointTurnsSha256: "1".repeat(64),
      checkpointedAt: 200,
      fence: { kind: "idle" as const },
    };
    const first = store.checkpointBackendThreadTail(firstInput);
    expect(first.checkpointTurnId).toBe("turn-1");
    expect(first.checkpointTurnStatus).toBe("completed");
    expect(first.checkpointTurnCount).toBe(1);
    expect(first.checkpointTurnsSha256).toBe("1".repeat(64));
    expect(first.checkpointedAt).toBe(200);

    const duplicate = store.checkpointBackendThreadTail({
      ...firstInput,
      checkpointedAt: 999,
    });
    expect(duplicate.checkpointedAt).toBe(200);
    expect(() => store.checkpointBackendThreadTail({
      ...firstInput,
      checkpointTurnsSha256: "2".repeat(64),
    })).toThrow("相同 turn count");
    expect(() => store.checkpointBackendThreadTail({
      ...firstInput,
      checkpointTurnId: null,
      checkpointTurnStatus: null,
      checkpointTurnCount: 0,
      checkpointTurnsSha256: BACKEND_SESSION_METADATA.checkpointTurnsSha256,
    })).toThrow("不得回退");

    const second = store.checkpointBackendThreadTail({
      ...firstInput,
      checkpointTurnId: "turn-2",
      checkpointTurnStatus: "failed",
      checkpointTurnCount: 2,
      checkpointTurnsSha256: "3".repeat(64),
      checkpointedAt: 300,
    });
    expect(second.checkpointTurnId).toBe("turn-2");
    expect(second.checkpointTurnStatus).toBe("failed");
    expect(second.checkpointTurnCount).toBe(2);

    expect(store.quarantineSession(sessionKey, "tail audit mismatch")).toBeTrue();
    expect(() => store.checkpointBackendThreadTail({
      ...firstInput,
      checkpointTurnId: "turn-3",
      checkpointTurnStatus: "interrupted",
      checkpointTurnCount: 3,
      checkpointTurnsSha256: "4".repeat(64),
    })).toThrow("recovery/quarantine");
  });

  test("active thread-tail checkpoint 要求 thread/turn/lease/generation 完全匹配", () => {
    const claimed = prepareRunningJob();
    store.markBackendRunning(
      claimed.jobId,
      backend,
      "lease-1",
      claimed.runGeneration,
      "turn-1",
    );
    const checkpoint = {
      backend,
      sessionKey,
      threadId: "thread-1",
      checkpointTurnId: "turn-1",
      checkpointTurnStatus: "completed" as const,
      checkpointTurnCount: 1,
      checkpointTurnsSha256: "1".repeat(64),
      checkpointedAt: 200,
      fence: {
        kind: "active" as const,
        jobId: claimed.jobId,
        leaseId: "lease-1",
        runGeneration: claimed.runGeneration,
        turnId: "turn-1",
      },
    };
    for (const staleFence of [
      { leaseId: "stale-lease" },
      { runGeneration: claimed.runGeneration + 1 },
      { jobId: "stale-job" },
    ]) {
      expect(() => store.checkpointBackendThreadTail({
        ...checkpoint,
        fence: { ...checkpoint.fence, ...staleFence },
      })).toThrow("fencing evidence");
    }
    expect(() => store.checkpointBackendThreadTail({
      ...checkpoint,
      checkpointTurnId: "turn-other",
    })).toThrow("active fence turn");
    expect(() => store.checkpointBackendThreadTail({
      ...checkpoint,
      threadId: "thread-other",
    })).toThrow("thread 或 v6 metadata");

    const stored = store.checkpointBackendThreadTail(checkpoint);
    expect(stored.checkpointTurnId).toBe("turn-1");
    expect(stored.checkpointTurnCount).toBe(1);
  });

  test("thread/start ambiguous quarantine 在人工 release 前阻止绑定", () => {
    ensureSession();
    expect(store.quarantineSession(sessionKey, "thread/start response 丢失")).toBeTrue();
    expect(store.quarantineSession(sessionKey, "duplicate reason")).toBeFalse();
    expect(store.getSessionQuarantine(sessionKey)?.reason).toBe("thread/start response 丢失");
    expect(() => store.bindBackendThread(backend, sessionKey, "thread-unknown"))
      .toThrow(BackendSessionConflictError);
    expect(store.releaseSessionQuarantine(sessionKey)).toBeTrue();
    expect(store.getSessionQuarantine(sessionKey)).toBeNull();
    expect(store.bindBackendThread(backend, sessionKey, "thread-after-release").threadId)
      .toBe("thread-after-release");
  });

  test("turnId 与 Running 同事务提交，写入失败不会留下半状态", () => {
    const claimed = prepareRunningJob();
    const database = new Database(databasePath);
    database.exec(`
      CREATE TRIGGER fail_turn_binding
      BEFORE UPDATE OF active_turn_id ON backend_sessions
      WHEN NEW.active_turn_id IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'injected turn binding failure');
      END;
    `);
    database.close();

    expect(() => store.markBackendRunning(
      claimed.jobId,
      backend,
      "lease-1",
      claimed.runGeneration,
      "turn-1",
    )).toThrow("injected turn binding failure");
    expect(store.require(claimed.jobId).status).toBe("Dispatching");
    expect(store.getBackendSession(backend, sessionKey)?.activeTurnId).toBeNull();

    const cleanup = new Database(databasePath);
    cleanup.exec("DROP TRIGGER fail_turn_binding;");
    cleanup.close();
    const running = store.markBackendRunning(
      claimed.jobId,
      backend,
      "lease-1",
      claimed.runGeneration,
      "turn-1",
    )!;
    expect(running.status).toBe("Running");
    expect(store.getBackendSession(backend, sessionKey)?.activeTurnId).toBe("turn-1");
    expect(store.markBackendRunning(
      claimed.jobId,
      backend,
      "lease-1",
      claimed.runGeneration,
      "turn-1",
    )?.status).toBe("Running");
    expect(store.markBackendRunning(
      claimed.jobId,
      backend,
      "stale-lease",
      claimed.runGeneration,
      "turn-stale",
    )).toBeNull();
  });

  test("execution attempt event 写入失败会回滚 claim、accepted 与 terminal", () => {
    const jobId = "attempt-event-insert-failure";
    ensureSession();
    store.bindBackendThread(backend, sessionKey, "thread-1");
    store.ingest(incomingJob(jobId), sessionKey, backend);
    store.markAcked(jobId);

    const installFailure = () => {
      const database = new Database(databasePath, { strict: true });
      try {
        database.exec(`
          CREATE TRIGGER fail_execution_attempt_event_insert
          BEFORE INSERT ON execution_attempt_events
          BEGIN
            SELECT RAISE(ABORT, 'injected execution attempt event failure');
          END;
        `);
      } finally {
        database.close();
      }
    };
    const removeFailure = () => {
      const database = new Database(databasePath, { strict: true });
      try {
        database.exec("DROP TRIGGER fail_execution_attempt_event_insert;");
      } finally {
        database.close();
      }
    };

    installFailure();
    expect(() => store.claimForBackendDispatch(
      jobId,
      backend,
      "codex:process-1",
      "lease-1",
    )).toThrow("injected execution attempt event failure");
    expect(store.require(jobId)).toMatchObject({
      status: "Acked",
      connectorId: null,
      leaseId: null,
      runGeneration: 0,
    });
    expect(store.getBackendSession(backend, sessionKey)).toMatchObject({
      activeJobId: null,
      activeLeaseId: null,
      activeRunGeneration: null,
    });
    expect(store.listExecutionAttemptEvents(jobId)).toEqual([]);

    removeFailure();
    const claimed = store.claimForBackendDispatch(
      jobId,
      backend,
      "codex:process-1",
      "lease-1",
    )!;
    installFailure();
    expect(() => store.markBackendRunning(
      jobId,
      backend,
      "lease-1",
      claimed.runGeneration,
      "turn-1",
    )).toThrow("injected execution attempt event failure");
    expect(store.require(jobId).status).toBe("Dispatching");
    expect(store.getBackendSession(backend, sessionKey)).toMatchObject({
      activeJobId: jobId,
      activeLeaseId: "lease-1",
      activeRunGeneration: claimed.runGeneration,
      activeTurnId: null,
    });
    expect(store.listExecutionAttemptEvents(jobId).map((event) => event.eventType))
      .toEqual(["reserved"]);

    removeFailure();
    store.markBackendRunning(
      jobId,
      backend,
      "lease-1",
      claimed.runGeneration,
      "turn-1",
    );
    installFailure();
    expect(() => store.finishBackendSuccess(
      jobId,
      backend,
      "lease-1",
      claimed.runGeneration,
      "turn-1",
      '{"text":"done"}',
    )).toThrow("injected execution attempt event failure");
    expect(store.require(jobId)).toMatchObject({ status: "Running", outbox: null });
    expect(store.getBackendSession(backend, sessionKey)).toMatchObject({
      activeJobId: jobId,
      activeLeaseId: "lease-1",
      activeRunGeneration: claimed.runGeneration,
      activeTurnId: "turn-1",
    });
    expect(store.listExecutionAttemptEvents(jobId).map((event) => event.eventType))
      .toEqual(["reserved", "accepted"]);
    removeFailure();
  });

  test("terminal、outbox 与 active attempt 原子提交", () => {
    const claimed = prepareRunningJob();
    store.markBackendRunning(
      claimed.jobId,
      backend,
      "lease-1",
      claimed.runGeneration,
      "turn-1",
    );
    const database = new Database(databasePath);
    database.exec(`
      CREATE TRIGGER fail_active_clear
      BEFORE UPDATE OF active_job_id ON backend_sessions
      WHEN OLD.active_job_id IS NOT NULL AND NEW.active_job_id IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'injected active clear failure');
      END;
    `);
    database.close();

    expect(() => store.finishBackendSuccess(
      claimed.jobId,
      backend,
      "lease-1",
      claimed.runGeneration,
      "turn-1",
      '{"text":"done"}',
    )).toThrow("injected active clear failure");
    expect(store.require(claimed.jobId).status).toBe("Running");
    expect(store.require(claimed.jobId).outbox).toBeNull();
    expect(store.getBackendSession(backend, sessionKey)?.activeJobId).toBe(claimed.jobId);
    expect(store.listExecutionAttemptEvents(claimed.jobId).map((event) => event.eventType))
      .toEqual(["reserved", "accepted"]);

    const cleanup = new Database(databasePath);
    cleanup.exec("DROP TRIGGER fail_active_clear;");
    cleanup.close();
    const finished = store.finishBackendSuccess(
      claimed.jobId,
      backend,
      "lease-1",
      claimed.runGeneration,
      "turn-1",
      '{"text":"done"}',
    )!;
    expect(finished.status).toBe("Succeeded");
    expect(finished.outbox?.status).toBe("Pending");
    const session = store.getBackendSession(backend, sessionKey)!;
    expect(session.activeJobId).toBeNull();
    expect(session.activeTurnId).toBeNull();
    expect(session.recoveryRequired).toBeFalse();
    const attemptEvents = store.listExecutionAttemptEvents(claimed.jobId);
    expect(attemptEvents.map((event) => event.eventType))
      .toEqual(["reserved", "accepted", "succeeded"]);
    expect(attemptEvents.map((event) => event.providerSessionId))
      .toEqual(["thread-1", "thread-1", "thread-1"]);
    expect(attemptEvents.map((event) => event.providerOperationId))
      .toEqual([null, "turn-1", "turn-1"]);
    expect(attemptEvents.at(-1)).toMatchObject({
      runtimeVersion: "0.1.0",
      effectiveModel: BACKEND_SESSION_METADATA.effectiveModel,
      modelProvider: BACKEND_SESSION_METADATA.modelProvider,
    });
  });

  test("重启保留 active evidence 并要求显式 release recovery", () => {
    const claimed = prepareRunningJob();
    store.markBackendRunning(
      claimed.jobId,
      backend,
      "lease-1",
      claimed.runGeneration,
      "turn-1",
    );
    expect(store.releaseBackendSessionRecovery(backend, sessionKey)).toBeFalse();
    store.close();
    store = new JobStore(databasePath, "account:agent");

    const recovery = store.recoverAfterRestart();
    expect(recovery.interrupted).toBe(1);
    expect(store.require(claimed.jobId).status).toBe("Interrupted");
    const interrupted = store.getBackendSession(backend, sessionKey)!;
    expect(interrupted.recoveryRequired).toBeTrue();
    expect(interrupted.activeJobId).toBe(claimed.jobId);
    expect(interrupted.activeTurnId).toBe("turn-1");
    expect(store.listQuarantinedSessions().map((entry) => entry.sessionKey)).toContain(sessionKey);

    expect(store.releaseSessionRecoveryWithReceipt(sessionKey)).toEqual({
      released: true,
      retiredBackendSessions: [backend],
      releasedQuarantineWithoutBackendSession: false,
    });
    expect(store.getBackendSession(backend, sessionKey)).toBeNull();
    expect(store.listQuarantinedSessions()).toHaveLength(0);
    expect(store.listExecutionAttemptEvents(claimed.jobId).map((event) => event.eventType))
      .toEqual(["reserved", "accepted", "interrupted"]);
    expect(store.latestExecutionAttemptEvent(claimed.jobId)?.providerOperationId).toBe("turn-1");
    expect(store.releaseSessionRecovery(sessionKey)).toBeFalse();
  });

  test("显式 release 会退役无 active/recovery 的 quarantined idle session", () => {
    ensureSession();
    store.bindBackendThread(backend, sessionKey, "thread-idle-drift");
    store.quarantineSession(sessionKey, "command security binding drift");

    expect(store.getBackendSession(backend, sessionKey)?.recoveryRequired).toBeFalse();
    expect(store.getBackendSession(backend, sessionKey)?.activeJobId).toBeNull();
    expect(store.releaseSessionRecoveryWithReceipt(sessionKey)).toEqual({
      released: true,
      retiredBackendSessions: [backend],
      releasedQuarantineWithoutBackendSession: false,
    });
    expect(store.getBackendSession(backend, sessionKey)).toBeNull();
    expect(store.getSessionQuarantine(sessionKey)).toBeNull();
    expect(store.releaseSessionRecovery(sessionKey)).toBeFalse();
  });

  test("显式 release 原子回报仅有 quarantine、尚无 backend session 的场景", () => {
    const unboundSessionKey = "livis:thread-start-ambiguous";
    store.quarantineSession(unboundSessionKey, "thread/start response 丢失");

    expect(store.releaseSessionRecoveryWithReceipt(unboundSessionKey)).toEqual({
      released: true,
      retiredBackendSessions: [],
      releasedQuarantineWithoutBackendSession: true,
    });
    expect(store.getSessionQuarantine(unboundSessionKey)).toBeNull();
  });

  test("ambiguous 与 cancel unknown 原子进入 recovery，且保留精确 attempt", () => {
    const dispatching = prepareRunningJob("dispatch-unknown");
    const interrupted = store.markBackendInterrupted(
      dispatching.jobId,
      backend,
      "lease-1",
      dispatching.runGeneration,
      null,
      "turn/start response 丢失",
    )!;
    expect(interrupted.status).toBe("Interrupted");
    expect(store.getBackendSession(backend, sessionKey)?.recoveryRequired).toBeTrue();
    expect(store.getBackendSession(backend, sessionKey)?.activeTurnId).toBeNull();
    expect(store.listQuarantinedSessions().map((entry) => entry.sessionKey)).toContain(sessionKey);
    expect(store.releaseBackendSessionRecovery(backend, sessionKey)).toBeTrue();
    expect(store.getBackendSession(backend, sessionKey)).toBeNull();

    ensureSession();
    store.bindBackendThread(backend, sessionKey, "thread-2");

    store.ingest(incomingJob("cancel-unknown"), sessionKey, backend);
    store.markAcked("cancel-unknown");
    const cancelling = store.claimForBackendDispatch(
      "cancel-unknown",
      backend,
      "codex:process-2",
      "lease-2",
    )!;
    store.markBackendRunning(
      cancelling.jobId,
      backend,
      "lease-2",
      cancelling.runGeneration,
      "turn-2",
    );
    expect(store.requestCancel(cancelling.jobId)?.status).toBe("Cancelling");
    expect(store.markBackendCancelUnknown(
      cancelling.jobId,
      backend,
      "lease-2",
      cancelling.runGeneration,
      null,
      "stale turn",
    )).toBeNull();
    const unknown = store.markBackendCancelUnknown(
      cancelling.jobId,
      backend,
      "lease-2",
      cancelling.runGeneration,
      "turn-2",
      "interrupt 无法证明工具退出",
    )!;
    expect(unknown.status).toBe("CancelUnknown");
    const session = store.getBackendSession(backend, sessionKey)!;
    expect(session.recoveryRequired).toBeTrue();
    expect(session.activeJobId).toBe(cancelling.jobId);
    expect(session.activeTurnId).toBe("turn-2");
  });

  test("cancel 与 turn/start accept 竞态先持久化 turnId，等待 terminal 再裁决", () => {
    const claimed = prepareRunningJob("cancel-before-accept");
    expect(store.requestCancel(claimed.jobId)?.status).toBe("Cancelling");
    expect(store.markBackendRunning(
      claimed.jobId,
      backend,
      "lease-1",
      claimed.runGeneration,
      "turn-after-cancel",
    )?.status).toBe("Cancelling");
    expect(store.getBackendSession(backend, sessionKey)?.activeTurnId).toBe("turn-after-cancel");
    expect(store.getBackendSession(backend, sessionKey)?.recoveryRequired).toBeFalse();
    expect(store.listQuarantinedSessions()).toHaveLength(0);

    const unknown = store.markBackendCancelUnknown(
      claimed.jobId,
      backend,
      "lease-1",
      claimed.runGeneration,
      "turn-after-cancel",
      "interrupt 已提交但工具退出未知",
    )!;
    expect(unknown.status).toBe("CancelUnknown");
    const session = store.getBackendSession(backend, sessionKey)!;
    expect(session.activeTurnId).toBe("turn-after-cancel");
    expect(session.recoveryRequired).toBeTrue();
    expect(store.listQuarantinedSessions()).toHaveLength(1);
  });

  test("可证明 not_sent 的并发取消直接 Cancelled 并清除 reservation", () => {
    const claimed = prepareRunningJob("cancel-before-unsent");
    expect(store.requestCancel(claimed.jobId)?.status).toBe("Cancelling");
    expect(store.finishUnsentBackendCancellation(
      claimed.jobId,
      backend,
      "lease-1",
      claimed.runGeneration + 1,
    )).toBeNull();
    const cancelled = store.finishUnsentBackendCancellation(
      claimed.jobId,
      backend,
      "lease-1",
      claimed.runGeneration,
    )!;
    expect(cancelled.status).toBe("Cancelled");
    expect(cancelled.outbox).toBeNull();
    const session = store.getBackendSession(backend, sessionKey)!;
    expect(session.activeJobId).toBeNull();
    expect(session.activeTurnId).toBeNull();
    expect(session.recoveryRequired).toBeFalse();
    expect(store.listQuarantinedSessions()).toHaveLength(0);
    expect(store.listExecutionAttemptEvents(claimed.jobId).map((event) => event.eventType))
      .toEqual(["reserved", "cancelled_not_sent"]);
  });

  test("not_sent 重派使用新 generation，旧 attempt 历史不会被覆盖", () => {
    const first = prepareRunningJob("codex-not-sent-retry");
    expect(store.resetUnsentBackendDispatch(
      first.jobId,
      backend,
      "lease-1",
      first.runGeneration,
    )).toBeTrue();
    const second = store.claimForBackendDispatch(
      first.jobId,
      backend,
      "codex:process-1",
      "lease-2",
    )!;
    expect(second.runGeneration).toBe(first.runGeneration + 1);
    store.markBackendRunning(
      second.jobId,
      backend,
      "lease-2",
      second.runGeneration,
      "turn-2",
    );
    store.finishBackendFailure(
      second.jobId,
      backend,
      "lease-2",
      second.runGeneration,
      "turn-2",
      '{"text":"failed"}',
      "synthetic failure",
    );

    expect(store.listExecutionAttemptEvents(first.jobId).map((event) => [
      event.runGeneration,
      event.sequence,
      event.eventType,
    ])).toEqual([
      [1, 1, "reserved"],
      [1, 2, "not_sent"],
      [2, 1, "reserved"],
      [2, 2, "accepted"],
      [2, 3, "failed"],
    ]);
  });

  test("execution attempt 默认窗口保留最新 100 条并按时间正序返回", () => {
    const jobId = "attempt-event-window";
    let claimed = prepareRunningJob(jobId);
    for (let generation = 1; generation <= 51; generation += 1) {
      expect(claimed.runGeneration).toBe(generation);
      expect(store.resetUnsentBackendDispatch(
        jobId,
        backend,
        `lease-${generation}`,
        claimed.runGeneration,
      )).toBeTrue();
      if (generation < 51) {
        claimed = store.claimForBackendDispatch(
          jobId,
          backend,
          "codex:process-1",
          `lease-${generation + 1}`,
        )!;
      }
    }

    const recent = store.listExecutionAttemptEvents(jobId);
    expect(recent).toHaveLength(100);
    expect(recent[0]).toMatchObject({
      runGeneration: 2,
      sequence: 1,
      eventType: "reserved",
    });
    expect(recent.at(-1)).toMatchObject({
      runGeneration: 51,
      sequence: 2,
      eventType: "not_sent",
    });
    expect(store.listExecutionAttemptEvents(jobId, 3).map((event) => [
      event.runGeneration,
      event.sequence,
      event.eventType,
    ])).toEqual([
      [50, 2, "not_sent"],
      [51, 1, "reserved"],
      [51, 2, "not_sent"],
    ]);
  });

  test("backend disconnect 按 executionId 批量收口 active jobs", () => {
    const executionId = "codex:shared-process";
    const cases = [
      {
        sessionKey,
        sessionHash,
        threadId: "thread-1",
        jobId: "running-on-exit",
        leaseId: "lease-running",
        turnId: "turn-running",
      },
      {
        sessionKey: "livis:second-agent",
        sessionHash: "b".repeat(64),
        threadId: "thread-2",
        jobId: "cancelling-on-exit",
        leaseId: "lease-cancelling",
        turnId: "turn-cancelling",
      },
    ];
    for (const item of cases) {
      store.ensureBackendSession({
        ...BACKEND_SESSION_METADATA,
        backend,
        sessionKey: item.sessionKey,
        sessionHash: item.sessionHash,
        cwd: join(directory.path, "sessions", item.sessionHash, "workspace"),
        cliVersion: "0.1.0",
      });
      store.bindBackendThread(backend, item.sessionKey, item.threadId);
      store.ingest(incomingJob(item.jobId), item.sessionKey, backend);
      store.markAcked(item.jobId);
      const claimed = store.claimForBackendDispatch(
        item.jobId,
        backend,
        executionId,
        item.leaseId,
      )!;
      store.markBackendRunning(
        item.jobId,
        backend,
        item.leaseId,
        claimed.runGeneration,
        item.turnId,
      );
    }
    expect(store.requestCancel("cancelling-on-exit")?.status).toBe("Cancelling");

    expect(store.markBackendDisconnected(backend, executionId, "app-server child exited"))
      .toBe(2);
    expect(store.require("running-on-exit").status).toBe("Interrupted");
    expect(store.require("cancelling-on-exit").status).toBe("CancelUnknown");
    for (const item of cases) {
      const session = store.getBackendSession(backend, item.sessionKey)!;
      expect(session.recoveryRequired).toBeTrue();
      expect(session.activeJobId).toBe(item.jobId);
      expect(session.activeTurnId).toBe(item.turnId);
    }
    expect(store.listQuarantinedSessions()).toHaveLength(2);
    expect(store.markBackendDisconnected(backend, executionId, "duplicate close")).toBe(0);
  });
});

describe("SQLite schema v7 migration", () => {
  test("fresh 数据库直接创建 v7，重复打开保持完整", async () => {
    const directory = await temporaryDirectory("livis-store-fresh-v7-");
    const databasePath = join(directory.path, "relay.db");
    try {
      const first = new JobStore(databasePath, "account:agent");
      first.close();
      expectHealthyV7(databasePath);

      const reopened = new JobStore(databasePath, "account:agent");
      reopened.close();
      expectHealthyV7(databasePath);
    } finally {
      await directory.cleanup();
    }
  });

  test("v6 active attempt 只导入可证明快照，恢复后继续 append-only 时间线", async () => {
    const directory = await temporaryDirectory("livis-store-v6-attempt-import-");
    const databasePath = join(directory.path, "relay.db");
    const sessionKey = "livis:legacy-active";
    let migrated: JobStore | null = null;
    try {
      const seed = new JobStore(databasePath, "account:agent");
      seed.ensureBackendSession({
        ...BACKEND_SESSION_METADATA,
        backend: "codex",
        sessionKey,
        sessionHash: "a".repeat(64),
        cwd: join(directory.path, "workspace"),
        cliVersion: "0.145.0",
      });
      seed.bindBackendThread("codex", sessionKey, "legacy-thread");
      seed.ingest(incomingJob("legacy-active-job"), sessionKey, "codex");
      seed.markAcked("legacy-active-job");
      const claimed = seed.claimForBackendDispatch(
        "legacy-active-job",
        "codex",
        "codex:legacy-thread",
        "legacy-lease",
      )!;
      seed.markBackendRunning(
        claimed.jobId,
        "codex",
        "legacy-lease",
        claimed.runGeneration,
        "legacy-turn",
      );
      seed.close();
      downgradeV7ToV6(databasePath);

      migrated = new JobStore(databasePath, "account:agent");
      expect(migrated.listExecutionAttemptEvents("legacy-active-job")).toMatchObject([{
        sequence: 1,
        eventType: "legacy_active_imported",
        providerSessionId: "legacy-thread",
        providerOperationId: "legacy-turn",
      }]);
      expect(migrated.recoverAfterRestart()).toMatchObject({ interrupted: 1 });
      expect(migrated.listExecutionAttemptEvents("legacy-active-job").map((event) => event.eventType))
        .toEqual(["legacy_active_imported", "interrupted"]);
      expectHealthyV7(databasePath);
    } finally {
      migrated?.close();
      await directory.cleanup();
    }
  });

  test("v6 Codex active attempt 与 session fence 不一致时拒绝迁移", async () => {
    for (const mismatch of ["job", "lease", "generation"] as const) {
      const directory = await temporaryDirectory(`livis-store-v6-attempt-${mismatch}-mismatch-`);
      const databasePath = join(directory.path, "relay.db");
      try {
        const sessionKey = `livis:legacy-${mismatch}`;
        const seed = new JobStore(databasePath, "account:agent");
        seed.ensureBackendSession({
          ...BACKEND_SESSION_METADATA,
          backend: "codex",
          sessionKey,
          sessionHash: "a".repeat(64),
          cwd: join(directory.path, "workspace"),
          cliVersion: "0.145.0",
        });
        seed.bindBackendThread("codex", sessionKey, `thread-${mismatch}`);
        seed.ingest(incomingJob(`legacy-${mismatch}`), sessionKey, "codex");
        seed.ingest(incomingJob(`other-${mismatch}`), sessionKey, "codex");
        seed.markAcked(`legacy-${mismatch}`);
        const claimed = seed.claimForBackendDispatch(
          `legacy-${mismatch}`,
          "codex",
          `codex:thread-${mismatch}`,
          `lease-${mismatch}`,
        )!;
        seed.markBackendRunning(
          claimed.jobId,
          "codex",
          `lease-${mismatch}`,
          claimed.runGeneration,
          `turn-${mismatch}`,
        );
        seed.close();
        downgradeV7ToV6(databasePath);

        const database = new Database(databasePath, { strict: true });
        if (mismatch === "job") {
          database.query(`UPDATE backend_sessions SET active_job_id=?
                          WHERE backend='codex' AND session_key=?`)
            .run(`other-${mismatch}`, sessionKey);
        } else if (mismatch === "lease") {
          database.query(`UPDATE backend_sessions SET active_lease_id='wrong-lease'
                          WHERE backend='codex' AND session_key=?`)
            .run(sessionKey);
        } else {
          database.query(`UPDATE backend_sessions SET active_run_generation=active_run_generation+1
                          WHERE backend='codex' AND session_key=?`)
            .run(sessionKey);
        }
        database.close();

        expect(() => new JobStore(databasePath, "account:agent"))
          .toThrow("Codex 审计事件缺少 session 锚点");
        expect(databaseHealth(databasePath).version).toBe(6);
        expect(databaseHealth(databasePath).executionAttemptEventColumns).toEqual([]);
      } finally {
        await directory.cleanup();
      }
    }
  });

  test("v5 backend session 仅在无 active/recovery 时一次性绑定完整 v6 metadata", async () => {
    const directory = await temporaryDirectory("livis-store-v5-session-binding-");
    const databasePath = join(directory.path, "relay.db");
    const sessionHash = "a".repeat(64);
    const sessionInput = {
      ...BACKEND_SESSION_METADATA,
      backend: "codex",
      sessionKey: "livis:legacy-agent",
      sessionHash,
      cwd: join(directory.path, "workspace"),
      cliVersion: "0.145.0",
      checkpointTurnId: "legacy-turn",
      checkpointTurnStatus: "completed" as const,
      checkpointTurnCount: 1,
      checkpointTurnsSha256: "f".repeat(64),
      checkpointedAt: 500,
    };
    try {
      const seed = new JobStore(databasePath, "account:agent");
      seed.ensureBackendSession({
        ...sessionInput,
        checkpointTurnId: null,
        checkpointTurnStatus: null,
        checkpointTurnCount: 0,
        checkpointTurnsSha256: BACKEND_SESSION_METADATA.checkpointTurnsSha256,
      });
      seed.bindBackendThread("codex", sessionInput.sessionKey, "legacy-thread");
      seed.close();
      downgradeV6ToV5(databasePath);

      const migrated = new JobStore(databasePath, "account:agent");
      const unbound = migrated.getBackendSession("codex", sessionInput.sessionKey)!;
      expect(unbound.accountType).toBeNull();
      expect(unbound.effectiveModel).toBeNull();
      expect(unbound.checkpointTurnCount).toBeNull();

      const partialBinding = new Database(databasePath, { strict: true });
      expect(() => partialBinding
        .query(`UPDATE backend_sessions SET account_type='chatgpt'
                WHERE backend='codex' AND session_key=?`)
        .run(sessionInput.sessionKey)).toThrow("metadata binding must be complete");
      partialBinding.close();

      const bound = migrated.ensureBackendSession(sessionInput);
      expect(bound.accountType).toBe("chatgpt");
      expect(bound.accountIdentityStrength).toBe("subject");
      expect(bound.threadId).toBe("legacy-thread");
      expect(bound.checkpointTurnId).toBe("legacy-turn");
      expect(bound.checkpointTurnCount).toBe(1);
      expect(bound.checkpointedAt).toBe(500);

      // mutable tail 不属于 ensure 的 immutable 比较，也不会被重复 ensure 覆盖。
      const repeated = migrated.ensureBackendSession({
        ...sessionInput,
        checkpointTurnId: "different-observation",
        checkpointTurnStatus: "failed",
        checkpointTurnCount: 2,
        checkpointTurnsSha256: "1".repeat(64),
        checkpointedAt: 999,
      });
      expect(repeated.checkpointTurnId).toBe("legacy-turn");
      expect(repeated.checkpointTurnCount).toBe(1);
      expect(repeated.checkpointedAt).toBe(500);
      expect(() => migrated.ensureBackendSession({
        ...sessionInput,
        effectiveModel: "gpt-drift",
      })).toThrow("immutable metadata");
      migrated.close();
      expectHealthyV7(databasePath);
    } finally {
      await directory.cleanup();
    }
  });

  test("v5 active/recovery session 拒绝补绑 v6 metadata", async () => {
    const directory = await temporaryDirectory("livis-store-v5-active-session-");
    const databasePath = join(directory.path, "relay.db");
    const sessionInput = {
      ...BACKEND_SESSION_METADATA,
      backend: "codex",
      sessionKey: "livis:active-agent",
      sessionHash: "a".repeat(64),
      cwd: join(directory.path, "workspace"),
      cliVersion: "0.145.0",
    };
    try {
      const seed = new JobStore(databasePath, "account:agent");
      seed.ensureBackendSession(sessionInput);
      seed.bindBackendThread("codex", sessionInput.sessionKey, "thread-active");
      seed.ingest(incomingJob("legacy-active"), sessionInput.sessionKey, "codex");
      seed.markAcked("legacy-active");
      const claimed = seed.claimForBackendDispatch(
        "legacy-active",
        "codex",
        "codex:legacy",
        "lease-active",
      )!;
      seed.markBackendRunning(
        claimed.jobId,
        "codex",
        "lease-active",
        claimed.runGeneration,
        "turn-active",
      );
      seed.close();
      downgradeV6ToV5(databasePath);

      const migrated = new JobStore(databasePath, "account:agent");
      const recovery = migrated.recoverAfterRestart();
      expect(recovery.interrupted).toBe(1);
      const legacy = migrated.getBackendSession("codex", sessionInput.sessionKey)!;
      expect(legacy.accountType).toBeNull();
      expect(legacy.activeJobId).toBe("legacy-active");
      expect(legacy.recoveryRequired).toBeTrue();
      expect(() => migrated.ensureBackendSession(sessionInput)).toThrow(
        "当前不可绑定 v6 metadata",
      );
      expect(migrated.getBackendSession("codex", sessionInput.sessionKey)?.accountType)
        .toBeNull();
      migrated.close();
      const reopened = new JobStore(databasePath, "account:agent");
      try {
        expect(reopened.listExecutionAttemptEvents("legacy-active").map((event) => event.eventType))
          .toEqual(["legacy_active_imported", "interrupted"]);
      } finally {
        reopened.close();
      }
      expectHealthyV7(databasePath);
    } finally {
      await directory.cleanup();
    }
  });

  test("schema v3 原地升级到 v7", async () => {
    const directory = await temporaryDirectory("livis-store-v3-to-v7-");
    const databasePath = join(directory.path, "relay.db");
    try {
      const seed = new JobStore(databasePath, "account:agent");
      seed.close();
      downgradeV4ToV3(databasePath);

      const migrated = new JobStore(databasePath, "account:agent");
      migrated.close();
      expectHealthyV7(databasePath);
    } finally {
      await directory.cleanup();
    }
  });

  test("v4 待派发 job 缺少来源声明时回滚，显式声明后固定绑定", async () => {
    const directory = await temporaryDirectory("livis-store-v4-provider-binding-");
    const databasePath = join(directory.path, "relay.db");
    try {
      const seed = new JobStore(databasePath, "account:agent");
      seed.ensureBackendSession({
        ...BACKEND_SESSION_METADATA,
        backend: "codex",
        sessionKey: "session-1",
        sessionHash: "c".repeat(64),
        cwd: join(directory.path, "codex-workspace"),
        cliVersion: "0.145.0",
      });
      seed.bindBackendThread("codex", "session-1", "legacy-thread");
      seed.ingest(incomingJob("legacy-pending"), "session-1", "codex");
      seed.markAcked("legacy-pending");
      seed.close();
      downgradeV6ToV4(databasePath);

      expect(() => new JobStore(databasePath, "account:agent"))
        .toThrow("config.execution.legacyV4JobBackend");
      const rolledBack = databaseHealth(databasePath);
      expect(rolledBack.version).toBe(4);
      expect(rolledBack.jobColumns).not.toContain("target_backend");

      expect(() => new JobStore(databasePath, "account:agent", {
        legacyV4JobBackend: "hermes",
      })).toThrow("session 证据");
      expect(databaseHealth(databasePath).version).toBe(4);

      const migrated = new JobStore(databasePath, "account:agent", {
        legacyV4JobBackend: "codex",
      });
      expect(migrated.require("legacy-pending").targetBackend).toBe("codex");
      expect(migrated.listDispatchable("hermes")).toHaveLength(0);
      expect(migrated.listDispatchable("codex").map((job) => job.jobId))
        .toEqual(["legacy-pending"]);
      migrated.close();
      expectHealthyV7(databasePath);
      expect(() => new JobStore(databasePath, "account:agent", {
        legacyV4JobBackend: "hermes",
      })).toThrow("SQLite v5 已按 codex 绑定原 v4 积压");
    } finally {
      await directory.cleanup();
    }
  });

  test("并发 opener 在取得 IMMEDIATE 写锁后才裁决版本", async () => {
    const directory = await temporaryDirectory("livis-store-concurrent-v7-");
    const databasePath = join(directory.path, "relay.db");
    const readyPath = join(directory.path, "child-ready");
    const proceedPath = join(directory.path, "child-proceed");
    let blocker: Database | null = null;
    let child: ReturnType<typeof Bun.spawn> | null = null;
    let committed = false;
    try {
      const seed = new JobStore(databasePath, "account:agent");
      seed.close();
      downgradeV4ToV2(databasePath);

      blocker = new Database(databasePath, { strict: true });
      blocker.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;");

      child = Bun.spawn([
        process.execPath,
        "--eval",
        `
          import { JobStore } from "./src/state/store.ts";
          import { existsSync, writeFileSync } from "node:fs";
          const databasePath = process.env.LIVIS_TEST_DB_PATH;
          const readyPath = process.env.LIVIS_TEST_READY_PATH;
          const proceedPath = process.env.LIVIS_TEST_PROCEED_PATH;
          if (!databasePath || !readyPath || !proceedPath) throw new Error("missing migration test paths");
          const waitCell = new Int32Array(new SharedArrayBuffer(4));
          const store = new JobStore(databasePath, "account:agent", {
            beforeMigrationLock: () => {
              writeFileSync(readyPath, "ready");
              while (!existsSync(proceedPath)) Atomics.wait(waitCell, 0, 0, 10);
            },
          });
          store.close();
          process.stdout.write("opened-v7");
        `,
      ], {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          LIVIS_TEST_DB_PATH: databasePath,
          LIVIS_TEST_READY_PATH: readyPath,
          LIVIS_TEST_PROCEED_PATH: proceedPath,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = new Response(child.stdout as ReadableStream<Uint8Array>).text();
      const stderr = new Response(child.stderr as ReadableStream<Uint8Array>).text();

      await waitForFile(readyPath);
      writeFileSync(proceedPath, "proceed");
      const whileLocked = await Promise.race([
        child.exited.then(() => "exited" as const),
        Bun.sleep(50).then(() => "blocked" as const),
      ]);
      expect(whileLocked).toBe("blocked");
      blocker.exec(`
        ALTER TABLE outbox ADD COLUMN next_attempt_at INTEGER;
        UPDATE outbox SET status='Pending', retry_count=0 WHERE status='AckFailed';
        DROP INDEX idx_outbox_delivery;
        CREATE INDEX idx_outbox_delivery ON outbox(scope_key,status,next_attempt_at,updated_at);
        CREATE INDEX IF NOT EXISTS idx_pending_cancels_gc
          ON pending_cancels(created_at,scope_key,job_id);
        PRAGMA user_version=3;
        COMMIT;
      `);
      committed = true;

      const [exitCode, childStdout, childStderr] = await Promise.all([child.exited, stdout, stderr]);
      expect(exitCode).toBe(0);
      expect(childStdout).toBe("opened-v7");
      expect(childStderr).toBe("");
      expectHealthyV7(databasePath);
    } finally {
      if (blocker) {
        if (!committed) {
          try {
            blocker.exec("ROLLBACK");
          } catch {
            // 已由 SQLite 回滚或尚未进入事务。
          }
        }
        blocker.close();
      }
      if (child && child.exitCode === null) {
        child.kill();
        await child.exited.catch(() => undefined);
      }
      await directory.cleanup();
    }
  });

  test("外键检查失败会回滚全部 v2→v7 DDL 与版本号", async () => {
    const directory = await temporaryDirectory("livis-store-rollback-v7-");
    const databasePath = join(directory.path, "relay.db");
    try {
      const seed = new JobStore(databasePath, "account:agent");
      seed.ingest(incomingJob("orphaned-job"), "session-1");
      seed.markAcked("orphaned-job");
      seed.claimForDispatch("orphaned-job", "connector", "lease-1");
      seed.markRunning("orphaned-job", "connector", "lease-1");
      seed.finishSuccess("orphaned-job", "lease-1", '{"text":"done"}');
      seed.close();
      downgradeV4ToV2(databasePath);

      const corrupt = new Database(databasePath, { strict: true });
      corrupt.exec("PRAGMA foreign_keys=OFF; DELETE FROM jobs WHERE job_id='orphaned-job';");
      corrupt.close();

      expect(() => new JobStore(databasePath, "account:agent")).toThrow("SQLite v5 迁移外键检查失败");
      const rolledBack = databaseHealth(databasePath);
      expect(rolledBack.version).toBe(2);
      expect(rolledBack.outboxColumns).not.toContain("next_attempt_at");
      expect(rolledBack.integrity).toBe("ok");
      expect(rolledBack.foreignKeyViolations).toHaveLength(1);
    } finally {
      await directory.cleanup();
    }
  });
});
