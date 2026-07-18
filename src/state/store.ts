import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { IncomingRelayJob, JobStatus, OutboxStatus, StoredJob, StoredOutbox } from "../types.ts";
import { sha256 } from "../util.ts";

export const PENDING_CANCEL_TTL_MS = 24 * 60 * 60 * 1_000;
export const PENDING_CANCEL_MAX_ROWS = 4_096;

export class PendingCancelCapacityError extends Error {
  constructor() {
    super(`pending cancel intent 已达到总量上限：${PENDING_CANCEL_MAX_ROWS}`);
    this.name = "PendingCancelCapacityError";
  }
}

interface JobViewRow {
  scope_key: string;
  job_id: string;
  msg_id: string;
  payload_hash: string;
  from_node_id: string;
  from_node_type: string | null;
  input_text: string;
  raw_payload: string;
  status: JobStatus;
  session_key: string;
  connector_id: string | null;
  lease_id: string | null;
  run_generation: number;
  error: string | null;
  cancel_requested: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  input_timestamp: number;
  outbox_status: OutboxStatus | null;
  result_json: string | null;
  retry_count: number | null;
  last_message_id: string | null;
  outbox_created_at: number | null;
  outbox_updated_at: number | null;
  delivered_at: number | null;
  acked_at: number | null;
}

const JOB_VIEW = `
  SELECT j.*,
         o.status AS outbox_status,
         o.result_json,
         o.retry_count,
         o.last_message_id,
         o.created_at AS outbox_created_at,
         o.updated_at AS outbox_updated_at,
         o.delivered_at,
         o.acked_at
  FROM jobs j
  LEFT JOIN outbox o ON o.scope_key=j.scope_key AND o.job_id=j.job_id
`;

function rowToJob(row: JobViewRow): StoredJob {
  const outbox: StoredOutbox | null = row.outbox_status && row.result_json !== null
    ? {
        jobId: row.job_id,
        status: row.outbox_status,
        resultJson: row.result_json,
        retryCount: row.retry_count ?? 0,
        lastMessageId: row.last_message_id,
        createdAt: row.outbox_created_at ?? row.created_at,
        updatedAt: row.outbox_updated_at ?? row.updated_at,
        deliveredAt: row.delivered_at,
        ackedAt: row.acked_at,
      }
    : null;
  return {
    scopeKey: row.scope_key,
    payloadHash: row.payload_hash,
    jobId: row.job_id,
    messageId: row.msg_id,
    fromNodeId: row.from_node_id,
    fromNodeType: row.from_node_type,
    text: row.input_text,
    rawPayload: row.raw_payload,
    timestamp: row.input_timestamp,
    status: row.status,
    sessionKey: row.session_key,
    connectorId: row.connector_id,
    leaseId: row.lease_id,
    runGeneration: row.run_generation,
    error: row.error,
    cancelRequested: row.cancel_requested === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    outbox,
  };
}

function businessPayloadHash(input: IncomingRelayJob): string {
  return sha256(JSON.stringify({
    fromNodeId: input.fromNodeId,
    fromNodeType: input.fromNodeType,
    text: input.text,
  }));
}

export class JobConflictError extends Error {}

export class JobStore {
  private readonly database: Database;
  private readonly path: string;

  constructor(
    path: string,
    private readonly scopeKey: string,
  ) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new Database(path, { create: true, strict: true });
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    this.migrate();
    const prune = this.database.transaction(() => {
      const now = Date.now();
      this.pruneExpiredPendingCancelsLocked(now);
      this.consumeAllMatchedPendingCancelsLocked(now);
      this.trimLegacyPendingCancelOverflowLocked();
    });
    prune.immediate();
    this.enforcePrivatePermissions();
  }

  close(): void {
    this.enforcePrivatePermissions();
    this.database.close(false);
    this.enforcePrivatePermissions();
  }

  integrityCheck(): string {
    const row = this.database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
    return row?.integrity_check ?? "unknown";
  }

  private enforcePrivatePermissions(): void {
    for (const candidate of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      if (existsSync(candidate)) chmodSync(candidate, 0o600);
    }
  }

  recoverAfterRestart(): { interrupted: number; cancelUnknown: number; outboxPending: number } {
    const now = Date.now();
    const transaction = this.database.transaction(() => {
      this.database.query(`
        INSERT OR IGNORE INTO session_quarantine(scope_key,session_key,reason,created_at)
        SELECT scope_key,session_key,'daemon restarted during active execution',?
        FROM jobs
        WHERE scope_key=? AND status IN ('Dispatching','Running','Cancelling')
      `).run(now, this.scopeKey);
      const cancelUnknown = this.database
        .query("UPDATE jobs SET status='CancelUnknown', completed_at=?, updated_at=? WHERE scope_key=? AND status='Cancelling'")
        .run(now, now, this.scopeKey).changes;
      const interrupted = this.database
        .query("UPDATE jobs SET status='Interrupted', completed_at=?, updated_at=?, error=COALESCE(error, 'daemon restarted while connector job was active') WHERE scope_key=? AND status IN ('Dispatching','Running')")
        .run(now, now, this.scopeKey).changes;
      const outboxPending = this.database
        .query("UPDATE outbox SET status='Pending', updated_at=? WHERE scope_key=? AND status='Delivering'")
        .run(now, this.scopeKey).changes;
      return { interrupted, cancelUnknown, outboxPending };
    });
    return transaction.immediate();
  }

  ingest(input: IncomingRelayJob, sessionKey: string): { inserted: boolean; job: StoredJob } {
    const payloadHash = businessPayloadHash(input);
    const transaction = this.database.transaction(() => {
      const now = Date.now();
      this.pruneExpiredPendingCancelsLocked(now);
      const result = this.database
        .query(`INSERT OR IGNORE INTO jobs (
          scope_key, job_id, msg_id, payload_hash, from_node_id, from_node_type, input_text, raw_payload,
          status, session_key, created_at, updated_at, input_timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Received', ?, ?, ?, ?)`)
        .run(
          this.scopeKey,
          input.jobId,
          input.messageId,
          payloadHash,
          input.fromNodeId,
          input.fromNodeType,
          input.text,
          input.rawPayload,
          sessionKey,
          now,
          now,
          input.timestamp,
        );
      this.consumeMatchedPendingCancelLocked(this.scopeKey, input.jobId, now);
      return result.changes === 1;
    });
    const inserted = transaction.immediate();
    const job = this.require(input.jobId);
    if (job.payloadHash !== payloadHash) {
      throw new JobConflictError(`同一 job_id 收到不同业务内容：${input.jobId}`);
    }
    return { inserted, job };
  }

  get(jobId: string): StoredJob | null {
    const row = this.database
      .query<JobViewRow, [string, string]>(`${JOB_VIEW} WHERE j.scope_key=? AND j.job_id=?`)
      .get(this.scopeKey, jobId);
    return row ? rowToJob(row) : null;
  }

  require(jobId: string): StoredJob {
    const job = this.get(jobId);
    if (!job) {
      throw new Error(`job 不存在：${jobId}`);
    }
    return job;
  }

  markAcked(jobId: string): StoredJob {
    this.transition(jobId, ["Received"], "Acked");
    return this.require(jobId);
  }

  claimForDispatch(jobId: string, connectorId: string, leaseId: string): StoredJob | null {
    const now = Date.now();
    const result = this.database
      .query(`UPDATE jobs AS target
              SET status='Dispatching', connector_id=?, lease_id=?, run_generation=run_generation+1, updated_at=?
              WHERE target.scope_key=? AND target.job_id=?
                AND target.status IN ('Received','Acked') AND target.cancel_requested=0
                AND NOT EXISTS (
                  SELECT 1 FROM jobs active
                  WHERE active.scope_key=target.scope_key
                    AND active.session_key=target.session_key
                    AND active.job_id<>target.job_id
                    AND active.status IN ('Dispatching','Running','Cancelling')
                )
                AND NOT EXISTS (
                  SELECT 1 FROM session_quarantine q
                  WHERE q.scope_key=target.scope_key AND q.session_key=target.session_key
                )`)
      .run(connectorId, leaseId, now, this.scopeKey, jobId);
    return result.changes === 1 ? this.require(jobId) : null;
  }

  resetUnsentDispatch(jobId: string, leaseId: string): void {
    this.database
      .query("UPDATE jobs SET status='Acked', connector_id=NULL, lease_id=NULL, updated_at=? WHERE scope_key=? AND job_id=? AND status='Dispatching' AND lease_id=?")
      .run(Date.now(), this.scopeKey, jobId, leaseId);
  }

  markRunning(jobId: string, connectorId: string, leaseId: string): StoredJob {
    this.database
      .query("UPDATE jobs SET status='Running', connector_id=?, updated_at=? WHERE scope_key=? AND job_id=? AND status='Dispatching' AND lease_id=? AND cancel_requested=0")
      .run(connectorId, Date.now(), this.scopeKey, jobId, leaseId);
    return this.require(jobId);
  }

  finishSuccess(jobId: string, leaseId: string, resultJson: string): StoredJob {
    return this.finishWithOutbox(jobId, leaseId, "Succeeded", resultJson, null);
  }

  finishFailure(jobId: string, leaseId: string, resultJson: string, error: string): StoredJob {
    return this.finishWithOutbox(jobId, leaseId, "Failed", resultJson, error);
  }

  reject(jobId: string, resultJson: string, reason: string): StoredJob {
    const now = Date.now();
    const transaction = this.database.transaction(() => {
      const result = this.database
        .query("UPDATE jobs SET status='Rejected', error=?, completed_at=?, updated_at=? WHERE scope_key=? AND job_id=? AND status IN ('Received','Acked')")
        .run(reason, now, now, this.scopeKey, jobId);
      if (result.changes === 1) {
        this.upsertOutbox(jobId, resultJson, now);
      }
    });
    transaction.immediate();
    return this.require(jobId);
  }

  startResultDelivery(jobId: string, messageId: string, retry: boolean): StoredOutbox | null {
    const now = Date.now();
    const expected: OutboxStatus = retry ? "Delivering" : "Pending";
    let changed = false;
    const transaction = this.database.transaction(() => {
      const result = this.database
        .query(`UPDATE outbox SET status='Delivering', last_message_id=?, retry_count=retry_count+?, delivered_at=?, updated_at=?
                WHERE scope_key=? AND job_id=? AND status=?
                  AND EXISTS (
                    SELECT 1 FROM jobs
                    WHERE jobs.scope_key=outbox.scope_key AND jobs.job_id=outbox.job_id AND cancel_requested=0
                  )`)
        .run(messageId, retry ? 1 : 0, now, now, this.scopeKey, jobId, expected);
      changed = result.changes === 1;
      if (changed) {
        this.database
          .query(`INSERT INTO outbox_delivery_attempts(scope_key,message_id,job_id,created_at)
                  VALUES(?,?,?,?)`)
          .run(this.scopeKey, messageId, jobId, now);
      }
    });
    transaction.immediate();
    return changed ? this.require(jobId).outbox : null;
  }

  resetOutboxPending(jobId: string): StoredOutbox | null {
    this.database
      .query("UPDATE outbox SET status='Pending', updated_at=? WHERE scope_key=? AND job_id=? AND status='Delivering'")
      .run(Date.now(), this.scopeKey, jobId);
    return this.require(jobId).outbox;
  }

  markOutboxDelivered(jobId: string): StoredOutbox | null {
    const now = Date.now();
    this.database
      .query("UPDATE outbox SET status='Delivered', acked_at=?, updated_at=? WHERE scope_key=? AND job_id=? AND status='Delivering'")
      .run(now, now, this.scopeKey, jobId);
    return this.get(jobId)?.outbox ?? null;
  }

  findJobIdByOutboxMessageId(messageId: string): string | null {
    const row = this.database
      .query<{ job_id: string }, [string, string]>(
        "SELECT job_id FROM outbox_delivery_attempts WHERE scope_key=? AND message_id=?",
      )
      .get(this.scopeKey, messageId);
    return row?.job_id ?? null;
  }

  markOutboxAckFailed(jobId: string): StoredOutbox | null {
    this.database
      .query("UPDATE outbox SET status='AckFailed', updated_at=? WHERE scope_key=? AND job_id=? AND status='Delivering'")
      .run(Date.now(), this.scopeKey, jobId);
    return this.require(jobId).outbox;
  }

  requestCancel(jobId: string): StoredJob | null {
    const transaction = this.database.transaction(() => {
      const now = Date.now();
      this.pruneExpiredPendingCancelsLocked(now);
      // cancel 可能先于 job 到达；条件插入与 job 状态更新共享 IMMEDIATE
      // 事务，避免在“查无 job”和保存 intent 之间漏掉并发入库。
      this.database
        .query(`UPDATE jobs
                SET cancel_requested=1,
                    status=CASE
                      WHEN status IN ('Dispatching','Running') THEN 'Cancelling'
                      ELSE 'Cancelled'
                    END,
                    completed_at=CASE
                      WHEN status IN ('Received','Acked') THEN ?
                      ELSE completed_at
                    END,
                    updated_at=?
                WHERE scope_key=? AND job_id=?
                  AND status IN ('Received','Acked','Dispatching','Running')`)
        .run(now, now, this.scopeKey, jobId);

      const existingJob = this.database
        .query<{ present: number }, [string, string]>(
          "SELECT 1 AS present FROM jobs WHERE scope_key=? AND job_id=?",
        )
        .get(this.scopeKey, jobId);
      if (existingJob) {
        this.database
          .query("DELETE FROM pending_cancels WHERE scope_key=? AND job_id=?")
          .run(this.scopeKey, jobId);
        return;
      }

      const refreshed = this.database
        .query("UPDATE pending_cancels SET created_at=? WHERE scope_key=? AND job_id=?")
        .run(now, this.scopeKey, jobId);
      if (refreshed.changes === 1) return;

      const count = this.database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pending_cancels")
        .get()?.count ?? 0;
      if (count >= PENDING_CANCEL_MAX_ROWS) {
        throw new PendingCancelCapacityError();
      }
      this.database
        .query("INSERT INTO pending_cancels(scope_key,job_id,created_at) VALUES(?,?,?)")
        .run(this.scopeKey, jobId, now);
    });
    transaction.immediate();
    return this.get(jobId);
  }

  markCancelUnknown(jobId: string, leaseId: string, reason: string): StoredJob {
    const now = Date.now();
    const transaction = this.database.transaction(() => {
      const result = this.database
        .query("UPDATE jobs SET status='CancelUnknown', cancel_requested=1, error=?, completed_at=?, updated_at=? WHERE scope_key=? AND job_id=? AND lease_id=? AND status='Cancelling'")
        .run(reason, now, now, this.scopeKey, jobId, leaseId);
      if (result.changes === 1) {
        this.database
          .query("INSERT OR IGNORE INTO session_quarantine(scope_key,session_key,reason,created_at) SELECT scope_key,session_key,?,? FROM jobs WHERE scope_key=? AND job_id=?")
          .run(reason, now, this.scopeKey, jobId);
      }
    });
    transaction.immediate();
    return this.require(jobId);
  }

  markConnectorDisconnected(connectorId: string): number {
    const now = Date.now();
    const transaction = this.database.transaction(() => {
      this.database.query(`
        INSERT OR IGNORE INTO session_quarantine(scope_key,session_key,reason,created_at)
        SELECT scope_key,session_key,'connector disconnected during active execution',?
        FROM jobs
        WHERE scope_key=? AND connector_id=? AND status IN ('Dispatching','Running','Cancelling')
      `).run(now, this.scopeKey, connectorId);
      const cancelUnknown = this.database
        .query("UPDATE jobs SET status='CancelUnknown', error=COALESCE(error, 'connector disconnected during cancellation'), completed_at=?, updated_at=? WHERE scope_key=? AND connector_id=? AND status='Cancelling'")
        .run(now, now, this.scopeKey, connectorId).changes;
      const interrupted = this.database
        .query(`UPDATE jobs SET status='Interrupted', error=COALESCE(error, 'connector disconnected'), completed_at=?, updated_at=?
                WHERE scope_key=? AND connector_id=? AND status IN ('Dispatching','Running')`)
        .run(now, now, this.scopeKey, connectorId).changes;
      return cancelUnknown + interrupted;
    });
    return transaction.immediate();
  }

  listDispatchable(limit = 100): StoredJob[] {
    return this.database
      .query<JobViewRow, [string, number]>(`${JOB_VIEW}
        WHERE j.scope_key=? AND j.status IN ('Received','Acked') AND j.cancel_requested=0
          AND NOT EXISTS (
            SELECT 1 FROM jobs active
            WHERE active.scope_key=j.scope_key
              AND active.session_key=j.session_key
              AND active.job_id<>j.job_id
              AND active.status IN ('Dispatching','Running','Cancelling')
          )
          AND NOT EXISTS (
            SELECT 1 FROM session_quarantine q
            WHERE q.scope_key=j.scope_key AND q.session_key=j.session_key
          )
        ORDER BY j.created_at ASC LIMIT ?`)
      .all(this.scopeKey, limit)
      .map(rowToJob);
  }

  listPendingOutbox(limit = 100): StoredOutbox[] {
    return this.database
      .query<JobViewRow, [string, number]>(`${JOB_VIEW}
        WHERE j.scope_key=? AND o.status='Pending' AND j.cancel_requested=0
        ORDER BY o.updated_at ASC LIMIT ?`)
      .all(this.scopeKey, limit)
      .map(rowToJob)
      .flatMap((job) => (job.outbox ? [job.outbox] : []));
  }

  listRecent(limit = 50): StoredJob[] {
    return this.database
      .query<JobViewRow, [string, number]>(`${JOB_VIEW} WHERE j.scope_key=? ORDER BY j.updated_at DESC LIMIT ?`)
      .all(this.scopeKey, limit)
      .map(rowToJob);
  }

  listQuarantinedSessions(): Array<{ sessionKey: string; reason: string; createdAt: number }> {
    return this.database
      .query<{ session_key: string; reason: string; created_at: number }, [string]>(
        "SELECT session_key,reason,created_at FROM session_quarantine WHERE scope_key=? ORDER BY created_at",
      )
      .all(this.scopeKey)
      .map((row) => ({ sessionKey: row.session_key, reason: row.reason, createdAt: row.created_at }));
  }

  releaseSessionQuarantine(sessionKey: string): boolean {
    return this.database
      .query("DELETE FROM session_quarantine WHERE scope_key=? AND session_key=?")
      .run(this.scopeKey, sessionKey).changes === 1;
  }

  getMeta(key: string): string | null {
    const row = this.database.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key=?").get(key);
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.database
      .query("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, value);
  }

  private finishWithOutbox(
    jobId: string,
    leaseId: string,
    status: "Succeeded" | "Failed",
    resultJson: string,
    error: string | null,
  ): StoredJob {
    const now = Date.now();
    const transaction = this.database.transaction(() => {
      const result = this.database
        .query(`UPDATE jobs SET status=?, error=?, completed_at=?, updated_at=?
                WHERE scope_key=? AND job_id=? AND lease_id=?
                  AND status IN ('Dispatching','Running') AND cancel_requested=0`)
        .run(status, error, now, now, this.scopeKey, jobId, leaseId);
      if (result.changes === 1) {
        this.upsertOutbox(jobId, resultJson, now);
      }
    });
    transaction.immediate();
    return this.require(jobId);
  }

  private upsertOutbox(jobId: string, resultJson: string, now: number): void {
    this.database
      .query(`INSERT INTO outbox(scope_key,job_id,status,result_json,retry_count,created_at,updated_at)
              VALUES(?,?,'Pending',?,0,?,?)
              ON CONFLICT(scope_key,job_id) DO NOTHING`)
      .run(this.scopeKey, jobId, resultJson, now, now);
  }

  private transition(jobId: string, from: JobStatus[], to: JobStatus, error: string | null = null): void {
    const placeholders = from.map(() => "?").join(",");
    this.database
      .query(`UPDATE jobs SET status=?, error=COALESCE(?,error), updated_at=? WHERE scope_key=? AND job_id=? AND status IN (${placeholders})`)
      .run(to, error, Date.now(), this.scopeKey, jobId, ...from);
  }

  private pruneExpiredPendingCancelsLocked(now: number): void {
    this.database
      .query("DELETE FROM pending_cancels WHERE created_at < ?")
      .run(now - PENDING_CANCEL_TTL_MS);
  }

  private consumeMatchedPendingCancelLocked(scopeKey: string, jobId: string, now: number): void {
    this.database.query(`
      UPDATE jobs
      SET cancel_requested=1,
          status=CASE
            WHEN status IN ('Dispatching','Running') THEN 'Cancelling'
            ELSE 'Cancelled'
          END,
          completed_at=CASE
            WHEN status IN ('Received','Acked') THEN ?
            ELSE completed_at
          END,
          updated_at=?
      WHERE scope_key=? AND job_id=?
        AND status IN ('Received','Acked','Dispatching','Running')
        AND EXISTS (
          SELECT 1 FROM pending_cancels
          WHERE pending_cancels.scope_key=jobs.scope_key
            AND pending_cancels.job_id=jobs.job_id
        )
    `).run(now, now, scopeKey, jobId);
    this.database
      .query("DELETE FROM pending_cancels WHERE scope_key=? AND job_id=?")
      .run(scopeKey, jobId);
  }

  private consumeAllMatchedPendingCancelsLocked(now: number): void {
    this.database.query(`
      UPDATE jobs
      SET cancel_requested=1,
          status=CASE
            WHEN status IN ('Dispatching','Running') THEN 'Cancelling'
            ELSE 'Cancelled'
          END,
          completed_at=CASE
            WHEN status IN ('Received','Acked') THEN ?
            ELSE completed_at
          END,
          updated_at=?
      WHERE status IN ('Received','Acked','Dispatching','Running')
        AND EXISTS (
          SELECT 1 FROM pending_cancels
          WHERE pending_cancels.scope_key=jobs.scope_key
            AND pending_cancels.job_id=jobs.job_id
        )
    `).run(now, now);
    this.database.query(`
      DELETE FROM pending_cancels
      WHERE EXISTS (
        SELECT 1 FROM jobs
        WHERE jobs.scope_key=pending_cancels.scope_key
          AND jobs.job_id=pending_cancels.job_id
      )
    `).run();
  }

  private trimLegacyPendingCancelOverflowLocked(): void {
    this.database.query(`
      DELETE FROM pending_cancels
      WHERE rowid IN (
        SELECT rowid FROM pending_cancels
        ORDER BY created_at DESC, rowid DESC
        LIMIT -1 OFFSET ?
      )
    `).run(PENDING_CANCEL_MAX_ROWS);
  }

  private migrate(): void {
    const row = this.database.query<{ user_version: number }, []>("PRAGMA user_version").get();
    const version = row?.user_version ?? 0;
    if (version !== 0 && version !== 1 && version !== 2) {
      throw new Error(`不支持的数据库 schema 版本：${version}`);
    }
    if (version === 1) {
      this.database.exec(`
        CREATE TABLE outbox_delivery_attempts (
          scope_key TEXT NOT NULL,
          message_id TEXT NOT NULL,
          job_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY(scope_key,message_id),
          FOREIGN KEY(scope_key,job_id) REFERENCES outbox(scope_key,job_id) ON DELETE CASCADE
        );
        INSERT INTO outbox_delivery_attempts(scope_key,message_id,job_id,created_at)
          SELECT scope_key,last_message_id,job_id,updated_at FROM outbox WHERE last_message_id IS NOT NULL;
        CREATE INDEX idx_outbox_attempt_job ON outbox_delivery_attempts(scope_key,job_id);
        PRAGMA user_version=2;
      `);
    }
    if (version === 1 || version === 2) {
      this.database.exec(`
        CREATE INDEX IF NOT EXISTS idx_pending_cancels_gc
          ON pending_cancels(created_at,scope_key,job_id);
      `);
      return;
    }
    this.database.exec(`
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE jobs (
        scope_key TEXT NOT NULL,
        job_id TEXT NOT NULL,
        msg_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        from_node_id TEXT NOT NULL,
        from_node_type TEXT,
        input_text TEXT NOT NULL,
        raw_payload TEXT NOT NULL,
        status TEXT NOT NULL,
        session_key TEXT NOT NULL,
        connector_id TEXT,
        lease_id TEXT,
        run_generation INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
        input_timestamp INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        PRIMARY KEY(scope_key,job_id)
      );
      CREATE TABLE outbox (
        scope_key TEXT NOT NULL,
        job_id TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_message_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        delivered_at INTEGER,
        acked_at INTEGER,
        PRIMARY KEY(scope_key,job_id),
        FOREIGN KEY(scope_key,job_id) REFERENCES jobs(scope_key,job_id) ON DELETE CASCADE
      );
      CREATE TABLE outbox_delivery_attempts (
        scope_key TEXT NOT NULL,
        message_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(scope_key,message_id),
        FOREIGN KEY(scope_key,job_id) REFERENCES outbox(scope_key,job_id) ON DELETE CASCADE
      );
      CREATE TABLE session_quarantine (
        scope_key TEXT NOT NULL,
        session_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(scope_key,session_key)
      );
      CREATE TABLE pending_cancels (
        scope_key TEXT NOT NULL,
        job_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(scope_key,job_id)
      );
      CREATE INDEX idx_jobs_dispatch ON jobs(scope_key,status,cancel_requested,session_key,created_at);
      CREATE INDEX idx_jobs_connector ON jobs(scope_key,connector_id,status);
      CREATE INDEX idx_outbox_delivery ON outbox(scope_key,status,updated_at);
      CREATE INDEX idx_outbox_attempt_job ON outbox_delivery_attempts(scope_key,job_id);
      CREATE INDEX idx_pending_cancels_gc ON pending_cancels(created_at,scope_key,job_id);
      PRAGMA user_version=2;
    `);
  }
}
