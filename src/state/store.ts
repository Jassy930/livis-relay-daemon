import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  IncomingRelayJob,
  JobStatus,
  OutboxStatus,
  StoredBackendSession,
  StoredJob,
  StoredOutbox,
} from "../types.ts";
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
  next_attempt_at: number | null;
  outbox_created_at: number | null;
  outbox_updated_at: number | null;
  delivered_at: number | null;
  acked_at: number | null;
}

interface BackendSessionRow {
  scope_key: string;
  backend: string;
  session_key: string;
  session_hash: string;
  thread_id: string | null;
  cwd: string;
  cli_version: string;
  active_job_id: string | null;
  active_lease_id: string | null;
  active_run_generation: number | null;
  active_turn_id: string | null;
  recovery_required: number;
  created_at: number;
  updated_at: number;
}

const JOB_VIEW = `
  SELECT j.*,
         o.status AS outbox_status,
         o.result_json,
         o.retry_count,
         o.last_message_id,
         o.next_attempt_at,
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
        nextAttemptAt: row.next_attempt_at,
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

function rowToBackendSession(row: BackendSessionRow): StoredBackendSession {
  return {
    scopeKey: row.scope_key,
    backend: row.backend,
    sessionKey: row.session_key,
    sessionHash: row.session_hash,
    threadId: row.thread_id,
    cwd: row.cwd,
    cliVersion: row.cli_version,
    activeJobId: row.active_job_id,
    activeLeaseId: row.active_lease_id,
    activeRunGeneration: row.active_run_generation,
    activeTurnId: row.active_turn_id,
    recoveryRequired: row.recovery_required === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

export class BackendSessionConflictError extends Error {}

export interface EnsureBackendSessionInput {
  backend: string;
  sessionKey: string;
  sessionHash: string;
  cwd: string;
  cliVersion: string;
}

export interface JobStoreOptions {
  /** 仅供确定性迁移 harness 在尝试 IMMEDIATE 写锁前建立进程间屏障。 */
  beforeMigrationLock?: () => void;
}

export class JobStore {
  private readonly database: Database;
  private readonly path: string;

  constructor(
    path: string,
    private readonly scopeKey: string,
    private readonly options: JobStoreOptions = {},
  ) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new Database(path, { create: true, strict: true });
    try {
      this.database.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      this.migrate();
      this.enforcePrivatePermissions();
    } catch (error) {
      this.database.close(false);
      throw error;
    }
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
      // 只有 daemon 启动恢复路径可以消费历史 intent 并改变 active job。
      // doctor/session release 等维护命令只构造 JobStore，不得产生运行时状态迁移。
      this.pruneExpiredPendingCancelsLocked(now);
      this.consumeAllMatchedPendingCancelsLocked(now);
      this.trimLegacyPendingCancelOverflowLocked();
      this.database.query(`
        INSERT OR IGNORE INTO session_quarantine(scope_key,session_key,reason,created_at)
        SELECT scope_key,session_key,'daemon restarted during active execution',?
        FROM jobs
        WHERE scope_key=? AND status IN ('Dispatching','Running','Cancelling')
      `).run(now, this.scopeKey);
      // 保留 active attempt 作为人工恢复证据。重启只把会话标成需要恢复，
      // 不清除 turn/job 映射，也绝不据此自动重放后端请求。
      this.database
        .query(`UPDATE backend_sessions
                SET recovery_required=1, updated_at=?
                WHERE scope_key=? AND active_job_id IS NOT NULL`)
        .run(now, this.scopeKey);
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

  getBackendSession(backend: string, sessionKey: string): StoredBackendSession | null {
    const row = this.database
      .query<BackendSessionRow, [string, string, string]>(
        `SELECT * FROM backend_sessions
         WHERE scope_key=? AND backend=? AND session_key=?`,
      )
      .get(this.scopeKey, backend, sessionKey);
    return row ? rowToBackendSession(row) : null;
  }

  ensureBackendSession(input: EnsureBackendSessionInput): StoredBackendSession {
    const now = Date.now();
    const transaction = this.database.transaction(() => {
      this.database
        .query(`INSERT INTO backend_sessions(
                  scope_key,backend,session_key,session_hash,cwd,cli_version,created_at,updated_at
                ) VALUES(?,?,?,?,?,?,?,?)
                ON CONFLICT(scope_key,backend,session_key) DO NOTHING`)
        .run(
          this.scopeKey,
          input.backend,
          input.sessionKey,
          input.sessionHash,
          input.cwd,
          input.cliVersion,
          now,
          now,
        );
      const row = this.database
        .query<BackendSessionRow, [string, string, string]>(
          `SELECT * FROM backend_sessions
           WHERE scope_key=? AND backend=? AND session_key=?`,
        )
        .get(this.scopeKey, input.backend, input.sessionKey);
      if (!row) {
        throw new BackendSessionConflictError("backend session 唯一目录或路径发生冲突");
      }
      if (
        row.session_hash !== input.sessionHash ||
        row.cwd !== input.cwd ||
        row.cli_version !== input.cliVersion
      ) {
        throw new BackendSessionConflictError(
          `backend session immutable metadata 不一致：${input.backend}/${input.sessionKey}`,
        );
      }
      return rowToBackendSession(row);
    });
    return transaction.immediate();
  }

  bindBackendThread(backend: string, sessionKey: string, threadId: string): StoredBackendSession {
    const transaction = this.database.transaction(() => {
      const current = this.getBackendSession(backend, sessionKey);
      if (!current) {
        throw new Error(`backend session 不存在：${backend}/${sessionKey}`);
      }
      if (current.threadId === threadId) return current;
      if (current.threadId !== null) {
        throw new BackendSessionConflictError(
          `backend session 已绑定不同 thread：${backend}/${sessionKey}`,
        );
      }
      const result = this.database
        .query(`UPDATE backend_sessions
                SET thread_id=?, updated_at=?
                WHERE scope_key=? AND backend=? AND session_key=?
                  AND thread_id IS NULL AND recovery_required=0
                  AND NOT EXISTS (
                    SELECT 1 FROM session_quarantine quarantine
                    WHERE quarantine.scope_key=backend_sessions.scope_key
                      AND quarantine.session_key=backend_sessions.session_key
                  )`)
        .run(threadId, Date.now(), this.scopeKey, backend, sessionKey);
      if (result.changes !== 1) {
        throw new BackendSessionConflictError(
          `backend session 当前不可绑定 thread：${backend}/${sessionKey}`,
        );
      }
      return this.getBackendSession(backend, sessionKey)!;
    });
    return transaction.immediate();
  }

  /**
   * 在同一写事务中领取 job 并保留 backend attempt。只有该方法成功返回后，
   * 调用方才可以向 app-server 发送 turn/start。
   */
  claimForBackendDispatch(
    jobId: string,
    backend: string,
    connectorId: string,
    leaseId: string,
  ): StoredJob | null {
    const now = Date.now();
    const transaction = this.database.transaction(() => {
      const claimed = this.database
        .query(`UPDATE jobs AS target
                SET status='Dispatching', connector_id=?, lease_id=?,
                    run_generation=run_generation+1, updated_at=?
                WHERE target.scope_key=? AND target.job_id=?
                  AND target.status IN ('Received','Acked') AND target.cancel_requested=0
                  AND EXISTS (
                    SELECT 1 FROM backend_sessions backend_session
                    WHERE backend_session.scope_key=target.scope_key
                      AND backend_session.backend=?
                      AND backend_session.session_key=target.session_key
                      AND backend_session.thread_id IS NOT NULL
                      AND backend_session.active_job_id IS NULL
                      AND backend_session.recovery_required=0
                  )
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
        .run(connectorId, leaseId, now, this.scopeKey, jobId, backend);
      if (claimed.changes !== 1) return false;

      const attempt = this.database
        .query<{ session_key: string; run_generation: number }, [string, string, string]>(
          `SELECT session_key,run_generation FROM jobs
           WHERE scope_key=? AND job_id=? AND lease_id=? AND status='Dispatching'`,
        )
        .get(this.scopeKey, jobId, leaseId);
      if (!attempt) throw new Error("backend dispatch claim 未能读回当前 attempt");
      const reserved = this.database
        .query(`UPDATE backend_sessions
                SET active_job_id=?, active_lease_id=?, active_run_generation=?, updated_at=?
                WHERE scope_key=? AND backend=? AND session_key=?
                  AND thread_id IS NOT NULL AND active_job_id IS NULL
                  AND recovery_required=0`)
        .run(
          jobId,
          leaseId,
          attempt.run_generation,
          now,
          this.scopeKey,
          backend,
          attempt.session_key,
        );
      if (reserved.changes !== 1) {
        throw new Error("backend session attempt reservation 与 job claim 不一致");
      }
      return true;
    });
    return transaction.immediate() ? this.require(jobId) : null;
  }

  resetUnsentBackendDispatch(
    jobId: string,
    backend: string,
    leaseId: string,
    runGeneration: number,
  ): boolean {
    const now = Date.now();
    const transaction = this.database.transaction(() => {
      const reset = this.database
        .query(`UPDATE jobs
                SET status='Acked', connector_id=NULL, lease_id=NULL, updated_at=?
                WHERE scope_key=? AND job_id=? AND status='Dispatching'
                  AND lease_id=? AND run_generation=?
                  AND EXISTS (
                    SELECT 1 FROM backend_sessions backend_session
                    WHERE backend_session.scope_key=jobs.scope_key
                      AND backend_session.backend=?
                      AND backend_session.session_key=jobs.session_key
                      AND backend_session.active_job_id=jobs.job_id
                      AND backend_session.active_lease_id=?
                      AND backend_session.active_run_generation=?
                      AND backend_session.active_turn_id IS NULL
                      AND backend_session.recovery_required=0
                  )`)
        .run(
          now,
          this.scopeKey,
          jobId,
          leaseId,
          runGeneration,
          backend,
          leaseId,
          runGeneration,
        );
      if (reset.changes !== 1) return false;
      const cleared = this.database
        .query(`UPDATE backend_sessions
                SET active_job_id=NULL, active_lease_id=NULL,
                    active_run_generation=NULL, active_turn_id=NULL, updated_at=?
                WHERE scope_key=? AND backend=? AND active_job_id=?
                  AND active_lease_id=? AND active_run_generation=?
                  AND active_turn_id IS NULL AND recovery_required=0`)
        .run(now, this.scopeKey, backend, jobId, leaseId, runGeneration);
      if (cleared.changes !== 1) {
        throw new Error("backend unsent reset 未能原子清除 session attempt");
      }
      return true;
    });
    return transaction.immediate();
  }

  finishUnsentBackendCancellation(
    jobId: string,
    backend: string,
    leaseId: string,
    runGeneration: number,
  ): StoredJob | null {
    const now = Date.now();
    const transaction = this.database.transaction(() => {
      const cancelled = this.database
        .query(`UPDATE jobs
                SET status='Cancelled', completed_at=?, updated_at=?
                WHERE scope_key=? AND job_id=? AND status='Cancelling'
                  AND cancel_requested=1 AND lease_id=? AND run_generation=?
                  AND EXISTS (
                    SELECT 1 FROM backend_sessions backend_session
                    WHERE backend_session.scope_key=jobs.scope_key
                      AND backend_session.backend=?
                      AND backend_session.session_key=jobs.session_key
                      AND backend_session.active_job_id=jobs.job_id
                      AND backend_session.active_lease_id=?
                      AND backend_session.active_run_generation=?
                      AND backend_session.active_turn_id IS NULL
                      AND backend_session.recovery_required=0
                  )`)
        .run(
          now,
          now,
          this.scopeKey,
          jobId,
          leaseId,
          runGeneration,
          backend,
          leaseId,
          runGeneration,
        );
      if (cancelled.changes !== 1) return false;
      const cleared = this.database
        .query(`UPDATE backend_sessions
                SET active_job_id=NULL, active_lease_id=NULL,
                    active_run_generation=NULL, active_turn_id=NULL, updated_at=?
                WHERE scope_key=? AND backend=? AND active_job_id=?
                  AND active_lease_id=? AND active_run_generation=?
                  AND active_turn_id IS NULL AND recovery_required=0`)
        .run(now, this.scopeKey, backend, jobId, leaseId, runGeneration);
      if (cleared.changes !== 1) {
        throw new Error("backend unsent cancellation 未能原子清除 session attempt");
      }
      return true;
    });
    return transaction.immediate() ? this.require(jobId) : null;
  }

  /** turn/start 返回 turnId 后，和 Running 状态在同一事务提交。 */
  markBackendRunning(
    jobId: string,
    backend: string,
    leaseId: string,
    runGeneration: number,
    turnId: string,
  ): StoredJob | null {
    const now = Date.now();
    const transaction = this.database.transaction(() => {
      const running = this.database
        .query(`UPDATE jobs
                SET status='Running', updated_at=?
                WHERE scope_key=? AND job_id=? AND status='Dispatching'
                  AND lease_id=? AND run_generation=? AND cancel_requested=0
                  AND EXISTS (
                    SELECT 1 FROM backend_sessions backend_session
                    WHERE backend_session.scope_key=jobs.scope_key
                      AND backend_session.backend=?
                      AND backend_session.session_key=jobs.session_key
                      AND backend_session.active_job_id=jobs.job_id
                      AND backend_session.active_lease_id=?
                      AND backend_session.active_run_generation=?
                      AND backend_session.active_turn_id IS NULL
                      AND backend_session.recovery_required=0
                  )`)
        .run(
          now,
          this.scopeKey,
          jobId,
          leaseId,
          runGeneration,
          backend,
          leaseId,
          runGeneration,
        );
      if (running.changes !== 1) {
        const duplicate = this.database
          .query<{ present: number }, [string, string, string, number, string, string, string]>(
            `SELECT 1 AS present
             FROM jobs
             JOIN backend_sessions backend_session
               ON backend_session.scope_key=jobs.scope_key
              AND backend_session.session_key=jobs.session_key
             WHERE jobs.scope_key=? AND jobs.job_id=? AND jobs.status='Running'
               AND jobs.lease_id=? AND jobs.run_generation=?
               AND backend_session.backend=?
               AND backend_session.active_job_id=jobs.job_id
               AND backend_session.active_lease_id=?
               AND backend_session.active_run_generation=jobs.run_generation
               AND backend_session.active_turn_id=?
               AND backend_session.recovery_required=0`,
          )
          .get(this.scopeKey, jobId, leaseId, runGeneration, backend, leaseId, turnId);
        return duplicate !== null;
      }
      const bound = this.database
        .query(`UPDATE backend_sessions
                SET active_turn_id=?, updated_at=?
                WHERE scope_key=? AND backend=? AND active_job_id=?
                  AND active_lease_id=? AND active_run_generation=?
                  AND active_turn_id IS NULL AND recovery_required=0`)
        .run(turnId, now, this.scopeKey, backend, jobId, leaseId, runGeneration);
      if (bound.changes !== 1) {
        throw new Error("backend turnId 与 Running 状态未能原子绑定");
      }
      return true;
    });
    return transaction.immediate() ? this.require(jobId) : null;
  }

  finishBackendSuccess(
    jobId: string,
    backend: string,
    leaseId: string,
    runGeneration: number,
    turnId: string,
    resultJson: string,
  ): StoredJob | null {
    return this.finishBackendWithOutbox(
      jobId,
      backend,
      leaseId,
      runGeneration,
      turnId,
      "Succeeded",
      resultJson,
      null,
    );
  }

  finishBackendFailure(
    jobId: string,
    backend: string,
    leaseId: string,
    runGeneration: number,
    turnId: string,
    resultJson: string,
    error: string,
  ): StoredJob | null {
    return this.finishBackendWithOutbox(
      jobId,
      backend,
      leaseId,
      runGeneration,
      turnId,
      "Failed",
      resultJson,
      error,
    );
  }

  markBackendCancelUnknown(
    jobId: string,
    backend: string,
    leaseId: string,
    runGeneration: number,
    turnId: string | null,
    reason: string,
  ): StoredJob | null {
    return this.markBackendRecoveryTerminal(
      jobId,
      backend,
      leaseId,
      runGeneration,
      turnId,
      "CancelUnknown",
      reason,
    );
  }

  markBackendInterrupted(
    jobId: string,
    backend: string,
    leaseId: string,
    runGeneration: number,
    turnId: string | null,
    reason: string,
  ): StoredJob | null {
    return this.markBackendRecoveryTerminal(
      jobId,
      backend,
      leaseId,
      runGeneration,
      turnId,
      "Interrupted",
      reason,
    );
  }

  markBackendDisconnected(backend: string, connectorId: string, reason: string): number {
    const now = Date.now();
    const transaction = this.database.transaction(() => {
      this.database
        .query(`INSERT OR IGNORE INTO session_quarantine(
                  scope_key,session_key,reason,created_at
                )
                SELECT jobs.scope_key,jobs.session_key,?,?
                FROM jobs
                JOIN backend_sessions backend_session
                  ON backend_session.scope_key=jobs.scope_key
                 AND backend_session.backend=?
                 AND backend_session.session_key=jobs.session_key
                 AND backend_session.active_job_id=jobs.job_id
                 AND backend_session.active_lease_id=jobs.lease_id
                 AND backend_session.active_run_generation=jobs.run_generation
                WHERE jobs.scope_key=? AND jobs.connector_id=?
                  AND jobs.status IN ('Dispatching','Running','Cancelling')
                  AND backend_session.recovery_required=0`)
        .run(reason, now, backend, this.scopeKey, connectorId);
      const marked = this.database
        .query(`UPDATE backend_sessions
                SET recovery_required=1, updated_at=?
                WHERE scope_key=? AND backend=? AND recovery_required=0
                  AND EXISTS (
                    SELECT 1 FROM jobs
                    WHERE jobs.scope_key=backend_sessions.scope_key
                      AND jobs.session_key=backend_sessions.session_key
                      AND jobs.job_id=backend_sessions.active_job_id
                      AND jobs.lease_id=backend_sessions.active_lease_id
                      AND jobs.run_generation=backend_sessions.active_run_generation
                      AND jobs.connector_id=?
                      AND jobs.status IN ('Dispatching','Running','Cancelling')
                  )`)
        .run(now, this.scopeKey, backend, connectorId);
      const cancelUnknown = this.database
        .query(`UPDATE jobs
                SET status='CancelUnknown', cancel_requested=1,
                    error=COALESCE(error,?), completed_at=?, updated_at=?
                WHERE scope_key=? AND connector_id=? AND status='Cancelling'
                  AND EXISTS (
                    SELECT 1 FROM backend_sessions backend_session
                    WHERE backend_session.scope_key=jobs.scope_key
                      AND backend_session.backend=?
                      AND backend_session.session_key=jobs.session_key
                      AND backend_session.active_job_id=jobs.job_id
                      AND backend_session.active_lease_id=jobs.lease_id
                      AND backend_session.active_run_generation=jobs.run_generation
                      AND backend_session.recovery_required=1
                  )`)
        .run(reason, now, now, this.scopeKey, connectorId, backend).changes;
      const interrupted = this.database
        .query(`UPDATE jobs
                SET status='Interrupted', error=COALESCE(error,?),
                    completed_at=?, updated_at=?
                WHERE scope_key=? AND connector_id=?
                  AND status IN ('Dispatching','Running')
                  AND EXISTS (
                    SELECT 1 FROM backend_sessions backend_session
                    WHERE backend_session.scope_key=jobs.scope_key
                      AND backend_session.backend=?
                      AND backend_session.session_key=jobs.session_key
                      AND backend_session.active_job_id=jobs.job_id
                      AND backend_session.active_lease_id=jobs.lease_id
                      AND backend_session.active_run_generation=jobs.run_generation
                      AND backend_session.recovery_required=1
                  )`)
        .run(reason, now, now, this.scopeKey, connectorId, backend).changes;
      const changed = cancelUnknown + interrupted;
      if (marked.changes !== changed) {
        throw new Error("backend disconnect 的 job 与 session recovery 数量不一致");
      }
      return changed;
    });
    return transaction.immediate();
  }

  releaseBackendSessionRecovery(backend: string, sessionKey: string): boolean {
    const now = Date.now();
    const transaction = this.database.transaction(() => {
      const released = this.database
        .query(`UPDATE backend_sessions
                SET active_job_id=NULL, active_lease_id=NULL,
                    active_run_generation=NULL, active_turn_id=NULL,
                    recovery_required=0, updated_at=?
                WHERE scope_key=? AND backend=? AND session_key=?
                  AND recovery_required=1
                  AND active_job_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM jobs
                    WHERE jobs.scope_key=backend_sessions.scope_key
                      AND jobs.job_id=backend_sessions.active_job_id
                      AND jobs.status IN (
                        'Succeeded','Cancelled','CancelUnknown','Interrupted','Failed','Rejected'
                      )
                  )`)
        .run(now, this.scopeKey, backend, sessionKey);
      if (released.changes !== 1) return false;
      this.database
        .query("DELETE FROM session_quarantine WHERE scope_key=? AND session_key=?")
        .run(this.scopeKey, sessionKey);
      return true;
    });
    return transaction.immediate();
  }

  /**
   * 离线人工释放 session 时以数据库中的历史 recovery 证据为准，而不是以
   * 当前 config 选择的 backend 为准。这样从 Codex 切回 Hermes 也不能只删
   * 通用 quarantine、遗留 active attempt 后绕过恢复所有权。
   */
  releaseSessionRecovery(sessionKey: string): boolean {
    const now = Date.now();
    const transaction = this.database.transaction(() => {
      const recovery = this.database
        .query<{ total: number; releasable: number }, [string, string]>(
          `SELECT COUNT(*) AS total,
                  COALESCE(SUM(CASE WHEN EXISTS (
                    SELECT 1 FROM jobs
                    WHERE jobs.scope_key=backend_sessions.scope_key
                      AND jobs.job_id=backend_sessions.active_job_id
                      AND jobs.status IN (
                        'Succeeded','Cancelled','CancelUnknown','Interrupted','Failed','Rejected'
                      )
                  ) THEN 1 ELSE 0 END),0) AS releasable
           FROM backend_sessions
           WHERE scope_key=? AND session_key=? AND recovery_required=1`,
        )
        .get(this.scopeKey, sessionKey) ?? { total: 0, releasable: 0 };

      if (recovery.total === 0) {
        return this.database
          .query("DELETE FROM session_quarantine WHERE scope_key=? AND session_key=?")
          .run(this.scopeKey, sessionKey).changes === 1;
      }
      if (recovery.releasable !== recovery.total) return false;

      const released = this.database
        .query(`UPDATE backend_sessions
                SET active_job_id=NULL, active_lease_id=NULL,
                    active_run_generation=NULL, active_turn_id=NULL,
                    recovery_required=0, updated_at=?
                WHERE scope_key=? AND session_key=? AND recovery_required=1`)
        .run(now, this.scopeKey, sessionKey);
      if (released.changes !== recovery.total) {
        throw new Error("session recovery 释放数量与已验证历史证据不一致");
      }
      this.database
        .query("DELETE FROM session_quarantine WHERE scope_key=? AND session_key=?")
        .run(this.scopeKey, sessionKey);
      return true;
    });
    return transaction.immediate();
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
    let changed = false;
    const transaction = this.database.transaction(() => {
      const result = this.database
        .query(`UPDATE outbox
                SET status='Delivering',
                    last_message_id=?,
                    retry_count=CASE WHEN status='AckFailed' THEN 0 ELSE retry_count+? END,
                    next_attempt_at=NULL,
                    delivered_at=?,
                    updated_at=?
                WHERE scope_key=? AND job_id=?
                  AND (
                    (?=1 AND status='Delivering')
                    OR
                    (?=0 AND (
                      status='Pending'
                      OR (status='AckFailed' AND next_attempt_at IS NOT NULL AND next_attempt_at<=?)
                    ))
                  )
                  AND EXISTS (
                    SELECT 1 FROM jobs
                    WHERE jobs.scope_key=outbox.scope_key AND jobs.job_id=outbox.job_id AND cancel_requested=0
                  )`)
        .run(
          messageId,
          retry ? 1 : 0,
          now,
          now,
          this.scopeKey,
          jobId,
          retry ? 1 : 0,
          retry ? 1 : 0,
          now,
        );
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
      .query("UPDATE outbox SET status='Pending', next_attempt_at=NULL, updated_at=? WHERE scope_key=? AND job_id=? AND status='Delivering'")
      .run(Date.now(), this.scopeKey, jobId);
    return this.require(jobId).outbox;
  }

  resetOutboxPendingAfterSendFailure(jobId: string, messageId: string, retry: boolean): StoredOutbox | null {
    const now = Date.now();
    const transaction = this.database.transaction(() => {
      const reset = this.database
        .query(`UPDATE outbox
                SET status='Pending',
                    retry_count=CASE WHEN ?=1 AND retry_count>0 THEN retry_count-1 ELSE retry_count END,
                    last_message_id=(
                      SELECT previous.message_id
                      FROM outbox_delivery_attempts previous
                      WHERE previous.scope_key=outbox.scope_key
                        AND previous.job_id=outbox.job_id
                        AND previous.message_id<>?
                      ORDER BY previous.created_at DESC, previous.rowid DESC
                      LIMIT 1
                    ),
                    delivered_at=(
                      SELECT previous.created_at
                      FROM outbox_delivery_attempts previous
                      WHERE previous.scope_key=outbox.scope_key
                        AND previous.job_id=outbox.job_id
                        AND previous.message_id<>?
                      ORDER BY previous.created_at DESC, previous.rowid DESC
                      LIMIT 1
                    ),
                    next_attempt_at=NULL,
                    updated_at=?
                WHERE scope_key=? AND job_id=?
                  AND status='Delivering' AND last_message_id=?`)
        .run(retry ? 1 : 0, messageId, messageId, now, this.scopeKey, jobId, messageId);
      if (reset.changes === 1) {
        this.database
          .query("DELETE FROM outbox_delivery_attempts WHERE scope_key=? AND job_id=? AND message_id=?")
          .run(this.scopeKey, jobId, messageId);
      }
    });
    transaction.immediate();
    return this.require(jobId).outbox;
  }

  markOutboxDelivered(jobId: string): StoredOutbox | null {
    const now = Date.now();
    const result = this.database
      .query(`UPDATE outbox
              SET status='Delivered', next_attempt_at=NULL, acked_at=?, updated_at=?
              WHERE scope_key=? AND job_id=? AND status IN ('Pending','Delivering','AckFailed')
                AND EXISTS (
                  SELECT 1 FROM outbox_delivery_attempts attempts
                  WHERE attempts.scope_key=outbox.scope_key AND attempts.job_id=outbox.job_id
                )`)
      .run(now, now, this.scopeKey, jobId);
    return result.changes === 1 ? this.require(jobId).outbox : null;
  }

  findJobIdByOutboxMessageId(messageId: string): string | null {
    const row = this.database
      .query<{ job_id: string }, [string, string]>(
        "SELECT job_id FROM outbox_delivery_attempts WHERE scope_key=? AND message_id=?",
      )
      .get(this.scopeKey, messageId);
    return row?.job_id ?? null;
  }

  markOutboxAckFailed(jobId: string, nextAttemptAt: number): StoredOutbox | null {
    this.database
      .query("UPDATE outbox SET status='AckFailed', next_attempt_at=?, updated_at=? WHERE scope_key=? AND job_id=? AND status='Delivering'")
      .run(nextAttemptAt, Date.now(), this.scopeKey, jobId);
    return this.require(jobId).outbox;
  }

  requestCancel(jobId: string): StoredJob | null {
    const transaction = this.database.transaction(() => {
      const now = Date.now();
      this.pruneExpiredPendingCancelsLocked(now);
      // cancel 可能先于 job 到达；条件更新、容量判断和 intent 写入共享
      // IMMEDIATE 事务，避免在“查无 job”和保存 intent 之间漏掉并发入库。
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

      // #19 的边界保持不变：Cancelling、Interrupted 和所有终态都不会
      // 回退；只要 job 已存在，就不能为迟到 cancel 新建未来 intent。
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

  listPendingOutbox(limit = 100, now = Date.now()): StoredOutbox[] {
    return this.database
      .query<JobViewRow, [string, number, number]>(`${JOB_VIEW}
        WHERE j.scope_key=? AND j.cancel_requested=0
          AND (o.status='Pending' OR (o.status='AckFailed' AND o.next_attempt_at IS NOT NULL AND o.next_attempt_at<=?))
        ORDER BY CASE WHEN o.status='Pending' THEN o.updated_at ELSE o.next_attempt_at END ASC LIMIT ?`)
      .all(this.scopeKey, now, limit)
      .map(rowToJob)
      .flatMap((job) => (job.outbox ? [job.outbox] : []));
  }

  nextOutboxAttemptAt(): number | null {
    const row = this.database
      .query<{ next_attempt_at: number | null }, [string]>(`
        SELECT MIN(o.next_attempt_at) AS next_attempt_at
        FROM outbox o
        JOIN jobs j ON j.scope_key=o.scope_key AND j.job_id=o.job_id
        WHERE o.scope_key=? AND o.status='AckFailed' AND o.next_attempt_at IS NOT NULL AND j.cancel_requested=0
      `)
      .get(this.scopeKey);
    return row?.next_attempt_at ?? null;
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

  getSessionQuarantine(
    sessionKey: string,
  ): { sessionKey: string; reason: string; createdAt: number } | null {
    const row = this.database
      .query<{ session_key: string; reason: string; created_at: number }, [string, string]>(
        `SELECT session_key,reason,created_at FROM session_quarantine
         WHERE scope_key=? AND session_key=?`,
      )
      .get(this.scopeKey, sessionKey);
    return row
      ? { sessionKey: row.session_key, reason: row.reason, createdAt: row.created_at }
      : null;
  }

  quarantineSession(sessionKey: string, reason: string): boolean {
    return this.database
      .query(`INSERT OR IGNORE INTO session_quarantine(
                scope_key,session_key,reason,created_at
              ) VALUES(?,?,?,?)`)
      .run(this.scopeKey, sessionKey, reason, Date.now()).changes === 1;
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

  private markBackendRecoveryTerminal(
    jobId: string,
    backend: string,
    leaseId: string,
    runGeneration: number,
    turnId: string | null,
    status: "CancelUnknown" | "Interrupted",
    reason: string,
  ): StoredJob | null {
    const now = Date.now();
    const transaction = this.database.transaction(() => {
      const fromStatus = status === "CancelUnknown"
        ? "status='Cancelling'"
        : "status IN ('Dispatching','Running')";
      const terminal = this.database
        .query(`UPDATE jobs
                SET status=?,
                    cancel_requested=CASE WHEN ?='CancelUnknown' THEN 1 ELSE cancel_requested END,
                    error=COALESCE(error,?),
                    completed_at=?, updated_at=?
                WHERE scope_key=? AND job_id=? AND ${fromStatus}
                  AND lease_id=? AND run_generation=?
                  AND EXISTS (
                    SELECT 1 FROM backend_sessions backend_session
                    WHERE backend_session.scope_key=jobs.scope_key
                      AND backend_session.backend=?
                      AND backend_session.session_key=jobs.session_key
                      AND backend_session.active_job_id=jobs.job_id
                      AND backend_session.active_lease_id=?
                      AND backend_session.active_run_generation=?
                      AND (
                        backend_session.active_turn_id IS ?
                        OR (
                          backend_session.active_turn_id IS NULL
                          AND ? IS NOT NULL
                        )
                      )
                      AND backend_session.recovery_required=0
                  )`)
        .run(
          status,
          status,
          reason,
          now,
          now,
          this.scopeKey,
          jobId,
          leaseId,
          runGeneration,
          backend,
          leaseId,
          runGeneration,
          turnId,
          turnId,
        );
      if (terminal.changes !== 1) return false;
      this.database
        .query(`INSERT OR IGNORE INTO session_quarantine(
                  scope_key,session_key,reason,created_at
                )
                SELECT scope_key,session_key,?,? FROM jobs
                WHERE scope_key=? AND job_id=?`)
        .run(reason, now, this.scopeKey, jobId);
      const marked = this.database
        .query(`UPDATE backend_sessions
                SET active_turn_id=COALESCE(active_turn_id,?),
                    recovery_required=1, updated_at=?
                WHERE scope_key=? AND backend=? AND active_job_id=?
                  AND active_lease_id=? AND active_run_generation=?
                  AND (
                    active_turn_id IS ?
                    OR (active_turn_id IS NULL AND ? IS NOT NULL)
                  )
                  AND recovery_required=0`)
        .run(
          turnId,
          now,
          this.scopeKey,
          backend,
          jobId,
          leaseId,
          runGeneration,
          turnId,
          turnId,
        );
      if (marked.changes !== 1) {
        throw new Error("backend terminal recovery 与 session quarantine 未能原子提交");
      }
      return true;
    });
    return transaction.immediate() ? this.require(jobId) : null;
  }

  private finishBackendWithOutbox(
    jobId: string,
    backend: string,
    leaseId: string,
    runGeneration: number,
    turnId: string,
    status: "Succeeded" | "Failed",
    resultJson: string,
    error: string | null,
  ): StoredJob | null {
    const now = Date.now();
    const transaction = this.database.transaction(() => {
      const finished = this.database
        .query(`UPDATE jobs
                SET status=?, error=?, completed_at=?, updated_at=?
                WHERE scope_key=? AND job_id=? AND status='Running'
                  AND lease_id=? AND run_generation=? AND cancel_requested=0
                  AND EXISTS (
                    SELECT 1 FROM backend_sessions backend_session
                    WHERE backend_session.scope_key=jobs.scope_key
                      AND backend_session.backend=?
                      AND backend_session.session_key=jobs.session_key
                      AND backend_session.active_job_id=jobs.job_id
                      AND backend_session.active_lease_id=?
                      AND backend_session.active_run_generation=?
                      AND backend_session.active_turn_id=?
                      AND backend_session.recovery_required=0
                  )`)
        .run(
          status,
          error,
          now,
          now,
          this.scopeKey,
          jobId,
          leaseId,
          runGeneration,
          backend,
          leaseId,
          runGeneration,
          turnId,
        );
      if (finished.changes !== 1) return false;
      this.upsertOutbox(jobId, resultJson, now);
      const cleared = this.database
        .query(`UPDATE backend_sessions
                SET active_job_id=NULL, active_lease_id=NULL,
                    active_run_generation=NULL, active_turn_id=NULL,
                    recovery_required=0, updated_at=?
                WHERE scope_key=? AND backend=? AND active_job_id=?
                  AND active_lease_id=? AND active_run_generation=?
                  AND active_turn_id=? AND recovery_required=0`)
        .run(now, this.scopeKey, backend, jobId, leaseId, runGeneration, turnId);
      if (cleared.changes !== 1) {
        throw new Error("backend terminal、outbox 与 session clear 未能原子提交");
      }
      return true;
    });
    return transaction.immediate() ? this.require(jobId) : null;
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
      WHERE scope_key=?
        AND status IN ('Received','Acked','Dispatching','Running')
        AND EXISTS (
          SELECT 1 FROM pending_cancels
          WHERE pending_cancels.scope_key=jobs.scope_key
            AND pending_cancels.job_id=jobs.job_id
        )
    `).run(now, now, this.scopeKey);
    this.database.query(`
      DELETE FROM pending_cancels
      WHERE scope_key=?
        AND EXISTS (
          SELECT 1 FROM jobs
          WHERE jobs.scope_key=pending_cancels.scope_key
            AND jobs.job_id=pending_cancels.job_id
        )
    `).run(this.scopeKey);
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
    const transaction = this.database.transaction(() => {
      const row = this.database.query<{ user_version: number }, []>("PRAGMA user_version").get();
      const version = row?.user_version ?? 0;
      if (version !== 0 && version !== 1 && version !== 2 && version !== 3 && version !== 4) {
        throw new Error(`不支持的数据库 schema 版本：${version}`);
      }
      if (version === 4) {
        this.assertBackendSessionsSchemaV4();
        return;
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
        `);
      }
      if (version === 1 || version === 2) {
        this.database.exec(`
          ALTER TABLE outbox ADD COLUMN next_attempt_at INTEGER;
          UPDATE outbox SET status='Pending', retry_count=0 WHERE status='AckFailed';
          DROP INDEX idx_outbox_delivery;
          CREATE INDEX idx_outbox_delivery ON outbox(scope_key,status,next_attempt_at,updated_at);
          CREATE INDEX IF NOT EXISTS idx_pending_cancels_gc
            ON pending_cancels(created_at,scope_key,job_id);
        `);
      }
      if (version === 0) {
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
          next_attempt_at INTEGER,
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
        CREATE INDEX idx_outbox_delivery ON outbox(scope_key,status,next_attempt_at,updated_at);
        CREATE INDEX idx_outbox_attempt_job ON outbox_delivery_attempts(scope_key,job_id);
        CREATE INDEX idx_pending_cancels_gc ON pending_cancels(created_at,scope_key,job_id);
        `);
      }
      this.createBackendSessionsSchemaV4();
      this.database.exec("PRAGMA user_version=4;");
      this.assertMigratedSchemaV4();
    });
    // 先取得 RESERVED 写锁，再读取 user_version。两个 opener 因而不会
    // 同时基于旧版本作迁移裁决；回调抛错时 Bun 会回滚全部 DDL/DML。
    this.options.beforeMigrationLock?.();
    transaction.immediate();
  }

  private createBackendSessionsSchemaV4(): void {
    this.database.exec(`
      CREATE TABLE backend_sessions (
        scope_key TEXT NOT NULL,
        backend TEXT NOT NULL CHECK(length(backend) BETWEEN 1 AND 32),
        session_key TEXT NOT NULL,
        session_hash TEXT NOT NULL
          CHECK(length(session_hash)=64 AND session_hash NOT GLOB '*[^0-9a-f]*'),
        thread_id TEXT CHECK(thread_id IS NULL OR length(thread_id) BETWEEN 1 AND 256),
        cwd TEXT NOT NULL CHECK(length(cwd) BETWEEN 1 AND 4096),
        cli_version TEXT NOT NULL CHECK(length(cli_version) BETWEEN 1 AND 64),
        active_job_id TEXT,
        active_lease_id TEXT,
        active_run_generation INTEGER,
        active_turn_id TEXT
          CHECK(active_turn_id IS NULL OR length(active_turn_id) BETWEEN 1 AND 256),
        recovery_required INTEGER NOT NULL DEFAULT 0
          CHECK(recovery_required IN (0,1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(scope_key,backend,session_key),
        FOREIGN KEY(scope_key,active_job_id)
          REFERENCES jobs(scope_key,job_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
        CHECK(thread_id IS NOT NULL OR active_job_id IS NULL),
        CHECK(
          (active_job_id IS NULL AND active_lease_id IS NULL
            AND active_run_generation IS NULL AND active_turn_id IS NULL)
          OR
          (active_job_id IS NOT NULL AND active_lease_id IS NOT NULL
            AND active_run_generation IS NOT NULL AND active_run_generation > 0)
        ),
        CHECK(recovery_required=0 OR active_job_id IS NOT NULL)
      );
      CREATE UNIQUE INDEX idx_backend_sessions_hash
        ON backend_sessions(session_hash);
      CREATE UNIQUE INDEX idx_backend_sessions_cwd
        ON backend_sessions(cwd);
      CREATE UNIQUE INDEX idx_backend_sessions_thread
        ON backend_sessions(backend,thread_id) WHERE thread_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_backend_sessions_active_job
        ON backend_sessions(scope_key,active_job_id) WHERE active_job_id IS NOT NULL;
      CREATE INDEX idx_backend_sessions_recovery
        ON backend_sessions(scope_key,recovery_required,updated_at);
    `);
  }

  private assertBackendSessionsSchemaV4(): void {
    const columns = this.database
      .query<{ name: string }, []>("PRAGMA table_info(backend_sessions)")
      .all()
      .map((column) => column.name);
    const expected = [
      "scope_key",
      "backend",
      "session_key",
      "session_hash",
      "thread_id",
      "cwd",
      "cli_version",
      "active_job_id",
      "active_lease_id",
      "active_run_generation",
      "active_turn_id",
      "recovery_required",
      "created_at",
      "updated_at",
    ];
    if (columns.length !== expected.length || expected.some((column) => !columns.includes(column))) {
      throw new Error("SQLite v4 backend_sessions schema 不完整");
    }
  }

  private assertMigratedSchemaV4(): void {
    const integrity = this.database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
    if (integrity?.integrity_check !== "ok") {
      throw new Error(`SQLite v4 迁移完整性检查失败：${integrity?.integrity_check ?? "unknown"}`);
    }
    const foreignKeyViolations = this.database.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all();
    if (foreignKeyViolations.length > 0) {
      throw new Error(`SQLite v4 迁移外键检查失败：${JSON.stringify(foreignKeyViolations)}`);
    }
    this.assertBackendSessionsSchemaV4();
  }
}
