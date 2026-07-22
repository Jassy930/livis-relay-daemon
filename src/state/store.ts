import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  BackendBacklogCount,
  BackendAccountIdentityStrength,
  BackendCheckpointTurnStatus,
  ExecutionBackendKind,
  ExecutionAttemptEventType,
  IncomingRelayJob,
  JobStatus,
  OutboxStatus,
  StoredBackendSession,
  StoredExecutionAttemptEvent,
  StoredJob,
  StoredOutbox,
  LegacyV4JobBackendKind,
} from "../types.ts";
import { sha256 } from "../util.ts";

export const PENDING_CANCEL_TTL_MS = 24 * 60 * 60 * 1_000;
export const PENDING_CANCEL_MAX_ROWS = 4_096;

export interface SessionReleaseReceipt {
  released: boolean;
  retiredBackendSessions: string[];
  releasedQuarantineWithoutBackendSession: boolean;
}

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
  target_backend: string;
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
  account_type: string | null;
  account_subject_sha256: string | null;
  account_identity_strength: BackendAccountIdentityStrength | null;
  requested_model: string | null;
  effective_model: string | null;
  model_provider: string | null;
  security_config_sha256: string | null;
  feature_snapshot_sha256: string | null;
  checkpoint_turn_id: string | null;
  checkpoint_turn_status: BackendCheckpointTurnStatus | null;
  checkpoint_turn_count: number | null;
  checkpoint_turns_sha256: string | null;
  checkpointed_at: number | null;
  active_job_id: string | null;
  active_lease_id: string | null;
  active_run_generation: number | null;
  active_turn_id: string | null;
  recovery_required: number;
  created_at: number;
  updated_at: number;
}

interface ExecutionAttemptEventRow {
  scope_key: string;
  job_id: string;
  run_generation: number;
  sequence: number;
  backend: string;
  session_key: string;
  lease_id: string;
  backend_execution_id: string;
  provider_session_id: string | null;
  provider_operation_id: string | null;
  runtime_version: string | null;
  requested_model: string | null;
  effective_model: string | null;
  model_provider: string | null;
  account_type: string | null;
  account_subject_sha256: string | null;
  security_config_sha256: string | null;
  feature_snapshot_sha256: string | null;
  event_type: ExecutionAttemptEventType;
  reason: string | null;
  created_at: number;
}

interface AttemptAuditContextRow {
  target_backend: string;
  session_key: string;
  lease_id: string | null;
  connector_id: string | null;
  thread_id: string | null;
  active_turn_id: string | null;
  cli_version: string | null;
  requested_model: string | null;
  effective_model: string | null;
  model_provider: string | null;
  account_type: string | null;
  account_subject_sha256: string | null;
  security_config_sha256: string | null;
  feature_snapshot_sha256: string | null;
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
  if (
    row.target_backend !== "hermes" &&
    row.target_backend !== "codex" &&
    row.target_backend !== "claude"
  ) {
    throw new Error(`job target_backend 非法或尚未完成迁移：${row.job_id}`);
  }
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
    targetBackend: row.target_backend,
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
    accountType: row.account_type,
    accountSubjectSha256: row.account_subject_sha256,
    accountIdentityStrength: row.account_identity_strength,
    requestedModel: row.requested_model,
    effectiveModel: row.effective_model,
    modelProvider: row.model_provider,
    securityConfigSha256: row.security_config_sha256,
    featureSnapshotSha256: row.feature_snapshot_sha256,
    checkpointTurnId: row.checkpoint_turn_id,
    checkpointTurnStatus: row.checkpoint_turn_status,
    checkpointTurnCount: row.checkpoint_turn_count,
    checkpointTurnsSha256: row.checkpoint_turns_sha256,
    checkpointedAt: row.checkpointed_at,
    activeJobId: row.active_job_id,
    activeLeaseId: row.active_lease_id,
    activeRunGeneration: row.active_run_generation,
    activeTurnId: row.active_turn_id,
    recoveryRequired: row.recovery_required === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToExecutionAttemptEvent(row: ExecutionAttemptEventRow): StoredExecutionAttemptEvent {
  if (row.backend !== "hermes" && row.backend !== "codex" && row.backend !== "claude") {
    throw new Error(`execution attempt backend 非法：${row.backend}`);
  }
  return {
    scopeKey: row.scope_key,
    jobId: row.job_id,
    runGeneration: row.run_generation,
    sequence: row.sequence,
    backend: row.backend,
    sessionKey: row.session_key,
    leaseId: row.lease_id,
    backendExecutionId: row.backend_execution_id,
    providerSessionId: row.provider_session_id,
    providerOperationId: row.provider_operation_id,
    runtimeVersion: row.runtime_version,
    requestedModel: row.requested_model,
    effectiveModel: row.effective_model,
    modelProvider: row.model_provider,
    accountType: row.account_type,
    accountSubjectSha256: row.account_subject_sha256,
    securityConfigSha256: row.security_config_sha256,
    featureSnapshotSha256: row.feature_snapshot_sha256,
    eventType: row.event_type,
    reason: row.reason,
    createdAt: row.created_at,
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
  accountType: string;
  accountSubjectSha256: string | null;
  accountIdentityStrength: BackendAccountIdentityStrength;
  requestedModel: string | null;
  effectiveModel: string;
  modelProvider: string;
  securityConfigSha256: string;
  featureSnapshotSha256: string;
  checkpointTurnId: string | null;
  checkpointTurnStatus: BackendCheckpointTurnStatus | null;
  checkpointTurnCount: number;
  checkpointTurnsSha256: string;
  checkpointedAt: number;
}

export type BackendThreadTailFence =
  | { kind: "idle" }
  | {
      kind: "active";
      jobId: string;
      leaseId: string;
      runGeneration: number;
      turnId: string;
    };

export interface CheckpointBackendThreadTailInput {
  backend: string;
  sessionKey: string;
  threadId: string;
  checkpointTurnId: string | null;
  checkpointTurnStatus: BackendCheckpointTurnStatus | null;
  checkpointTurnCount: number;
  checkpointTurnsSha256: string;
  checkpointedAt: number;
  fence: BackendThreadTailFence;
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const EXECUTION_ATTEMPT_REASON_MAX_CHARS = 4_096;

function boundedAttemptReason(reason: string | null): string | null {
  if (reason === null || reason.length <= EXECUTION_ATTEMPT_REASON_MAX_CHARS) return reason;
  return `[TRUNCATED chars=${reason.length} sha256=${sha256(reason)}]`;
}

function requireNonEmptyMetadata(value: string, field: string, maxLength: number): void {
  if (value.length === 0 || value.length > maxLength) {
    throw new BackendSessionConflictError(`${field} 长度非法`);
  }
}

function validateSha256(value: string, field: string): void {
  if (!SHA256_HEX_PATTERN.test(value)) {
    throw new BackendSessionConflictError(`${field} 必须是 64 位小写 SHA-256`);
  }
}

function validateCheckpointShape(input: {
  checkpointTurnId: string | null;
  checkpointTurnStatus: BackendCheckpointTurnStatus | null;
  checkpointTurnCount: number;
  checkpointTurnsSha256: string;
  checkpointedAt: number;
}): void {
  if (!Number.isSafeInteger(input.checkpointTurnCount) || input.checkpointTurnCount < 0) {
    throw new BackendSessionConflictError("checkpoint turn count 必须是非负安全整数");
  }
  if (!Number.isSafeInteger(input.checkpointedAt) || input.checkpointedAt < 0) {
    throw new BackendSessionConflictError("checkpointedAt 必须是非负安全整数");
  }
  validateSha256(input.checkpointTurnsSha256, "checkpointTurnsSha256");
  if (input.checkpointTurnCount === 0) {
    if (input.checkpointTurnId !== null || input.checkpointTurnStatus !== null) {
      throw new BackendSessionConflictError("零 turn checkpoint 不得携带 tail turn");
    }
    return;
  }
  if (input.checkpointTurnId === null || input.checkpointTurnStatus === null) {
    throw new BackendSessionConflictError("非空 checkpoint 必须携带 tail turn id/status");
  }
  requireNonEmptyMetadata(input.checkpointTurnId, "checkpointTurnId", 256);
  if (!["completed", "failed", "interrupted"].includes(input.checkpointTurnStatus)) {
    throw new BackendSessionConflictError(
      `checkpointTurnStatus 非法：${input.checkpointTurnStatus}`,
    );
  }
}

function validateEnsureBackendSessionInput(input: EnsureBackendSessionInput): void {
  requireNonEmptyMetadata(input.backend, "backend", 32);
  requireNonEmptyMetadata(input.sessionKey, "sessionKey", 4096);
  validateSha256(input.sessionHash, "sessionHash");
  requireNonEmptyMetadata(input.cwd, "cwd", 4096);
  requireNonEmptyMetadata(input.cliVersion, "cliVersion", 64);
  requireNonEmptyMetadata(input.accountType, "accountType", 64);
  if (input.accountSubjectSha256 !== null) {
    validateSha256(input.accountSubjectSha256, "accountSubjectSha256");
  }
  if (
    input.accountIdentityStrength !== "subject" &&
    input.accountIdentityStrength !== "type-only"
  ) {
    throw new BackendSessionConflictError(
      `accountIdentityStrength 非法：${input.accountIdentityStrength}`,
    );
  }
  if (
    (input.accountIdentityStrength === "subject" && input.accountSubjectSha256 === null) ||
    (input.accountIdentityStrength === "type-only" && input.accountSubjectSha256 !== null)
  ) {
    throw new BackendSessionConflictError("账号身份强度与 subject 摘要不一致");
  }
  if (input.requestedModel !== null) {
    requireNonEmptyMetadata(input.requestedModel, "requestedModel", 256);
  }
  requireNonEmptyMetadata(input.effectiveModel, "effectiveModel", 256);
  requireNonEmptyMetadata(input.modelProvider, "modelProvider", 128);
  validateSha256(input.securityConfigSha256, "securityConfigSha256");
  validateSha256(input.featureSnapshotSha256, "featureSnapshotSha256");
  validateCheckpointShape(input);
}

export interface JobStoreOptions {
  /** 仅供确定性迁移 harness 在尝试 IMMEDIATE 写锁前建立进程间屏障。 */
  beforeMigrationLock?: () => void;
  /**
   * 仅在含 Received/Acked job 的 SQLite v4→v5 迁移中使用。v4 未记录
   * provider，调用方必须显式声明这些积压 job 原本属于哪个 backend。
   */
  legacyV4JobBackend?: LegacyV4JobBackendKind;
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
      const activeAttempts = this.database
        .query<{ job_id: string; run_generation: number; status: JobStatus }, [string]>(`
          SELECT job_id,run_generation,status FROM jobs
          WHERE scope_key=? AND status IN ('Dispatching','Running','Cancelling')
        `)
        .all(this.scopeKey);
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
      if (activeAttempts.length !== cancelUnknown + interrupted) {
        throw new Error("daemon restart 的 job 与 execution attempt 数量不一致");
      }
      for (const attempt of activeAttempts) {
        const cancelling = attempt.status === "Cancelling";
        this.appendExecutionAttemptEventLocked({
          jobId: attempt.job_id,
          runGeneration: attempt.run_generation,
          eventType: cancelling ? "cancel_unknown" : "interrupted",
          reason: cancelling
            ? "daemon restarted during cancellation"
            : "daemon restarted during active execution",
          createdAt: now,
        });
      }
      const outboxPending = this.database
        .query("UPDATE outbox SET status='Pending', updated_at=? WHERE scope_key=? AND status='Delivering'")
        .run(now, this.scopeKey).changes;
      return { interrupted, cancelUnknown, outboxPending };
    });
    return transaction.immediate();
  }

  ingest(
    input: IncomingRelayJob,
    sessionKey: string,
    targetBackend: ExecutionBackendKind = "hermes",
  ): { inserted: boolean; job: StoredJob } {
    const payloadHash = businessPayloadHash(input);
    const transaction = this.database.transaction(() => {
      const now = Date.now();
      this.pruneExpiredPendingCancelsLocked(now);
      const result = this.database
        .query(`INSERT OR IGNORE INTO jobs (
          scope_key, job_id, msg_id, payload_hash, target_backend,
          from_node_id, from_node_type, input_text, raw_payload,
          status, session_key, created_at, updated_at, input_timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Received', ?, ?, ?, ?)`)
        .run(
          this.scopeKey,
          input.jobId,
          input.messageId,
          payloadHash,
          targetBackend,
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
    // duplicate delivery 在 backend 切换后仍属于首次入库时的 provider；
    // 这里故意不把 targetBackend 纳入业务冲突，也绝不改写已存绑定。
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
    validateEnsureBackendSessionInput(input);
    const now = Date.now();
    const transaction = this.database.transaction(() => {
      this.database
        .query(`INSERT INTO backend_sessions(
                  scope_key,backend,session_key,session_hash,cwd,cli_version,
                  account_type,account_subject_sha256,account_identity_strength,
                  requested_model,effective_model,model_provider,
                  security_config_sha256,feature_snapshot_sha256,
                  checkpoint_turn_id,checkpoint_turn_status,checkpoint_turn_count,
                  checkpoint_turns_sha256,checkpointed_at,created_at,updated_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(scope_key,backend,session_key) DO NOTHING`)
        .run(
          this.scopeKey,
          input.backend,
          input.sessionKey,
          input.sessionHash,
          input.cwd,
          input.cliVersion,
          input.accountType,
          input.accountSubjectSha256,
          input.accountIdentityStrength,
          input.requestedModel,
          input.effectiveModel,
          input.modelProvider,
          input.securityConfigSha256,
          input.featureSnapshotSha256,
          input.checkpointTurnId,
          input.checkpointTurnStatus,
          input.checkpointTurnCount,
          input.checkpointTurnsSha256,
          input.checkpointedAt,
          now,
          now,
        );
      let row = this.database
        .query<BackendSessionRow, [string, string, string]>(
          `SELECT * FROM backend_sessions
           WHERE scope_key=? AND backend=? AND session_key=?`,
        )
        .get(this.scopeKey, input.backend, input.sessionKey);
      if (!row) {
        throw new BackendSessionConflictError("backend session 唯一目录或路径发生冲突");
      }
      if (row.account_type === null) {
        // schema v5 旧行没有身份、模型、安全摘要和 tail checkpoint。只有没有
        // active/recovery 证据时才允许一次性补齐；一旦绑定，immutable trigger
        // 和下方严格比较都会拒绝漂移。
        const bound = this.database
          .query(`UPDATE backend_sessions
                  SET account_type=?,account_subject_sha256=?,account_identity_strength=?,
                      requested_model=?,effective_model=?,model_provider=?,
                      security_config_sha256=?,feature_snapshot_sha256=?,
                      checkpoint_turn_id=?,checkpoint_turn_status=?,checkpoint_turn_count=?,
                      checkpoint_turns_sha256=?,checkpointed_at=?,updated_at=?
                  WHERE scope_key=? AND backend=? AND session_key=?
                    AND account_type IS NULL
                    AND account_subject_sha256 IS NULL
                    AND account_identity_strength IS NULL
                    AND requested_model IS NULL
                    AND effective_model IS NULL
                    AND model_provider IS NULL
                    AND security_config_sha256 IS NULL
                    AND feature_snapshot_sha256 IS NULL
                    AND checkpoint_turn_id IS NULL
                    AND checkpoint_turn_status IS NULL
                    AND checkpoint_turn_count IS NULL
                    AND checkpoint_turns_sha256 IS NULL
                    AND checkpointed_at IS NULL
                    AND active_job_id IS NULL AND recovery_required=0`)
          .run(
            input.accountType,
            input.accountSubjectSha256,
            input.accountIdentityStrength,
            input.requestedModel,
            input.effectiveModel,
            input.modelProvider,
            input.securityConfigSha256,
            input.featureSnapshotSha256,
            input.checkpointTurnId,
            input.checkpointTurnStatus,
            input.checkpointTurnCount,
            input.checkpointTurnsSha256,
            input.checkpointedAt,
            now,
            this.scopeKey,
            input.backend,
            input.sessionKey,
          );
        if (bound.changes !== 1) {
          throw new BackendSessionConflictError(
            `schema v5 backend session 当前不可绑定 v6 metadata：${input.backend}/${input.sessionKey}`,
          );
        }
        row = this.database
          .query<BackendSessionRow, [string, string, string]>(
            `SELECT * FROM backend_sessions
             WHERE scope_key=? AND backend=? AND session_key=?`,
          )
          .get(this.scopeKey, input.backend, input.sessionKey)!;
      }
      if (
        row.session_hash !== input.sessionHash ||
        row.cwd !== input.cwd ||
        row.cli_version !== input.cliVersion ||
        row.account_type !== input.accountType ||
        row.account_subject_sha256 !== input.accountSubjectSha256 ||
        row.account_identity_strength !== input.accountIdentityStrength ||
        row.requested_model !== input.requestedModel ||
        row.effective_model !== input.effectiveModel ||
        row.model_provider !== input.modelProvider ||
        row.security_config_sha256 !== input.securityConfigSha256 ||
        row.feature_snapshot_sha256 !== input.featureSnapshotSha256
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
      if (current.accountType === null) {
        throw new BackendSessionConflictError(
          `backend session 尚未绑定 v6 metadata：${backend}/${sessionKey}`,
        );
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
                  AND thread_id IS NULL AND account_type IS NOT NULL AND recovery_required=0
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
   * 记录已验证的稳定 thread tail。idle 路径要求没有 active attempt；active
   * 路径则要求 job/lease/generation/turn 全部命中当前 fencing evidence。
   */
  checkpointBackendThreadTail(
    input: CheckpointBackendThreadTailInput,
  ): StoredBackendSession {
    requireNonEmptyMetadata(input.backend, "backend", 32);
    requireNonEmptyMetadata(input.sessionKey, "sessionKey", 4096);
    requireNonEmptyMetadata(input.threadId, "threadId", 256);
    validateCheckpointShape(input);
    if (input.fence.kind === "active") {
      requireNonEmptyMetadata(input.fence.jobId, "fence.jobId", 4096);
      requireNonEmptyMetadata(input.fence.leaseId, "fence.leaseId", 4096);
      requireNonEmptyMetadata(input.fence.turnId, "fence.turnId", 256);
      if (!Number.isSafeInteger(input.fence.runGeneration) || input.fence.runGeneration <= 0) {
        throw new BackendSessionConflictError("fence.runGeneration 必须是正安全整数");
      }
      if (input.checkpointTurnId !== input.fence.turnId) {
        throw new BackendSessionConflictError("active fence turn 与 checkpoint tail 不一致");
      }
    }

    const transaction = this.database.transaction(() => {
      const current = this.getBackendSession(input.backend, input.sessionKey);
      if (!current) {
        throw new BackendSessionConflictError(
          `backend session 不存在：${input.backend}/${input.sessionKey}`,
        );
      }
      if (current.threadId !== input.threadId || current.accountType === null) {
        throw new BackendSessionConflictError(
          `backend session thread 或 v6 metadata 未绑定：${input.backend}/${input.sessionKey}`,
        );
      }
      if (current.recoveryRequired || this.getSessionQuarantine(input.sessionKey) !== null) {
        throw new BackendSessionConflictError(
          `backend session 处于 recovery/quarantine：${input.backend}/${input.sessionKey}`,
        );
      }
      if (input.fence.kind === "idle") {
        if (
          current.activeJobId !== null ||
          current.activeLeaseId !== null ||
          current.activeRunGeneration !== null ||
          current.activeTurnId !== null
        ) {
          throw new BackendSessionConflictError("idle checkpoint 遇到 active attempt");
        }
      } else if (
        current.activeJobId !== input.fence.jobId ||
        current.activeLeaseId !== input.fence.leaseId ||
        current.activeRunGeneration !== input.fence.runGeneration ||
        current.activeTurnId !== input.fence.turnId
      ) {
        throw new BackendSessionConflictError("active checkpoint fencing evidence 不一致");
      }

      if (
        current.checkpointTurnCount === null ||
        current.checkpointTurnsSha256 === null ||
        current.checkpointedAt === null
      ) {
        throw new BackendSessionConflictError("backend session checkpoint 尚未完成 v6 绑定");
      }
      if (input.checkpointTurnCount < current.checkpointTurnCount) {
        throw new BackendSessionConflictError("checkpoint turn count 不得回退");
      }
      if (input.checkpointTurnCount === current.checkpointTurnCount) {
        if (
          input.checkpointTurnId !== current.checkpointTurnId ||
          input.checkpointTurnStatus !== current.checkpointTurnStatus ||
          input.checkpointTurnsSha256 !== current.checkpointTurnsSha256
        ) {
          throw new BackendSessionConflictError("相同 turn count 的 checkpoint 内容不一致");
        }
        return current;
      }

      const fenceClause = input.fence.kind === "idle"
        ? `AND active_job_id IS NULL AND active_lease_id IS NULL
             AND active_run_generation IS NULL AND active_turn_id IS NULL`
        : `AND active_job_id=? AND active_lease_id=?
             AND active_run_generation=? AND active_turn_id=?`;
      const query = this.database.query(`UPDATE backend_sessions
                SET checkpoint_turn_id=?,checkpoint_turn_status=?,checkpoint_turn_count=?,
                    checkpoint_turns_sha256=?,checkpointed_at=?,updated_at=?
                WHERE scope_key=? AND backend=? AND session_key=? AND thread_id=?
                  AND account_type IS NOT NULL AND recovery_required=0
                  AND checkpoint_turn_count=?
                  AND checkpoint_turn_id IS ? AND checkpoint_turn_status IS ?
                  AND checkpoint_turns_sha256=?
                  ${fenceClause}
                  AND NOT EXISTS (
                    SELECT 1 FROM session_quarantine quarantine
                    WHERE quarantine.scope_key=backend_sessions.scope_key
                      AND quarantine.session_key=backend_sessions.session_key
                  )`);
      const commonParameters = [
        input.checkpointTurnId,
        input.checkpointTurnStatus,
        input.checkpointTurnCount,
        input.checkpointTurnsSha256,
        input.checkpointedAt,
        Date.now(),
        this.scopeKey,
        input.backend,
        input.sessionKey,
        input.threadId,
        current.checkpointTurnCount,
        current.checkpointTurnId,
        current.checkpointTurnStatus,
        current.checkpointTurnsSha256,
      ];
      const updated = input.fence.kind === "idle"
        ? query.run(...commonParameters)
        : query.run(
            ...commonParameters,
            input.fence.jobId,
            input.fence.leaseId,
            input.fence.runGeneration,
            input.fence.turnId,
          );
      if (updated.changes !== 1) {
        throw new BackendSessionConflictError("checkpoint CAS/fence 未命中");
      }
      return this.getBackendSession(input.backend, input.sessionKey)!;
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
                  AND target.target_backend=?
                  AND target.status IN ('Received','Acked') AND target.cancel_requested=0
                  AND EXISTS (
                    SELECT 1 FROM backend_sessions backend_session
                    WHERE backend_session.scope_key=target.scope_key
                      AND backend_session.backend=?
                      AND backend_session.session_key=target.session_key
                      AND backend_session.thread_id IS NOT NULL
                      AND backend_session.account_type IS NOT NULL
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
        .run(connectorId, leaseId, now, this.scopeKey, jobId, backend, backend);
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
      this.appendExecutionAttemptEventLocked({
        jobId,
        runGeneration: attempt.run_generation,
        eventType: "reserved",
        providerOperationId: null,
        createdAt: now,
      });
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
                SET status='Acked', updated_at=?
                WHERE scope_key=? AND job_id=? AND status='Dispatching'
                  AND target_backend=? AND lease_id=? AND run_generation=?
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
          backend,
          leaseId,
          runGeneration,
          backend,
          leaseId,
          runGeneration,
        );
      if (reset.changes !== 1) return false;
      this.appendExecutionAttemptEventLocked({
        jobId,
        runGeneration,
        eventType: "not_sent",
        providerOperationId: null,
        reason: "backend request was proven not sent",
        createdAt: now,
      });
      const clearedJob = this.database
        .query(`UPDATE jobs SET connector_id=NULL,lease_id=NULL
                WHERE scope_key=? AND job_id=? AND status='Acked'
                  AND target_backend=? AND lease_id=? AND run_generation=?`)
        .run(this.scopeKey, jobId, backend, leaseId, runGeneration);
      if (clearedJob.changes !== 1) {
        throw new Error("backend unsent reset 未能原子清除 job attempt");
      }
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
                  AND target_backend=? AND cancel_requested=1
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
          now,
          this.scopeKey,
          jobId,
          backend,
          leaseId,
          runGeneration,
          backend,
          leaseId,
          runGeneration,
      );
      if (cancelled.changes !== 1) return false;
      this.appendExecutionAttemptEventLocked({
        jobId,
        runGeneration,
        eventType: "cancelled_not_sent",
        providerOperationId: null,
        reason: "cancel won before backend request left daemon",
        createdAt: now,
      });
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

  /**
   * turn/start 返回 turnId 后原子绑定。正常路径同时进入 Running；若 cancel 已先到，
   * job 保持 Cancelling，但仍必须持久化真实 turnId，等待 terminal checkpoint 裁决。
   */
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
                  AND target_backend=? AND lease_id=? AND run_generation=?
                  AND cancel_requested=0
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
          backend,
          leaseId,
          runGeneration,
          backend,
          leaseId,
          runGeneration,
        );
      if (running.changes !== 1) {
        const cancellingBound = this.database
          .query(`UPDATE backend_sessions
                  SET active_turn_id=?, updated_at=?
                  WHERE scope_key=? AND backend=? AND active_job_id=?
                    AND active_lease_id=? AND active_run_generation=?
                    AND active_turn_id IS NULL AND recovery_required=0
                    AND EXISTS (
                      SELECT 1 FROM jobs
                      WHERE jobs.scope_key=backend_sessions.scope_key
                        AND jobs.job_id=backend_sessions.active_job_id
                        AND jobs.status='Cancelling'
                        AND jobs.target_backend=?
                        AND jobs.lease_id=backend_sessions.active_lease_id
                        AND jobs.run_generation=backend_sessions.active_run_generation
                        AND jobs.cancel_requested=1
                    )`)
          .run(
            turnId,
            now,
            this.scopeKey,
            backend,
            jobId,
            leaseId,
            runGeneration,
            backend,
          );
        if (cancellingBound.changes === 1) {
          this.appendExecutionAttemptEventLocked({
            jobId,
            runGeneration,
            eventType: "accepted",
            providerOperationId: turnId,
            createdAt: now,
          });
          return true;
        }
        const duplicate = this.database
          .query<{ present: number }, [string, string, string, string, number, string, string, string]>(
            `SELECT 1 AS present
             FROM jobs
             JOIN backend_sessions backend_session
               ON backend_session.scope_key=jobs.scope_key
              AND backend_session.session_key=jobs.session_key
             WHERE jobs.scope_key=? AND jobs.job_id=?
               AND jobs.status IN ('Running','Cancelling')
               AND jobs.target_backend=?
               AND jobs.lease_id=? AND jobs.run_generation=?
               AND backend_session.backend=?
               AND backend_session.active_job_id=jobs.job_id
               AND backend_session.active_lease_id=?
               AND backend_session.active_run_generation=jobs.run_generation
               AND backend_session.active_turn_id=?
               AND backend_session.recovery_required=0`,
          )
          .get(this.scopeKey, jobId, backend, leaseId, runGeneration, backend, leaseId, turnId);
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
      this.appendExecutionAttemptEventLocked({
        jobId,
        runGeneration,
        eventType: "accepted",
        providerOperationId: turnId,
        createdAt: now,
      });
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
      const activeAttempts = this.database
        .query<{
          job_id: string;
          run_generation: number;
          status: JobStatus;
          active_turn_id: string | null;
        }, [string, string, string]>(`
          SELECT jobs.job_id,jobs.run_generation,jobs.status,backend_session.active_turn_id
          FROM jobs
          JOIN backend_sessions backend_session
            ON backend_session.scope_key=jobs.scope_key
           AND backend_session.backend=?
           AND backend_session.session_key=jobs.session_key
           AND backend_session.active_job_id=jobs.job_id
           AND backend_session.active_lease_id=jobs.lease_id
           AND backend_session.active_run_generation=jobs.run_generation
          WHERE jobs.scope_key=? AND jobs.connector_id=?
            AND jobs.target_backend=backend_session.backend
            AND jobs.status IN ('Dispatching','Running','Cancelling')
            AND backend_session.recovery_required=0
        `)
        .all(backend, this.scopeKey, connectorId);
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
                  AND jobs.target_backend=?
                  AND jobs.status IN ('Dispatching','Running','Cancelling')
                  AND backend_session.recovery_required=0`)
        .run(reason, now, backend, this.scopeKey, connectorId, backend);
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
                      AND jobs.target_backend=backend_sessions.backend
                      AND jobs.status IN ('Dispatching','Running','Cancelling')
                  )`)
        .run(now, this.scopeKey, backend, connectorId);
      const cancelUnknown = this.database
        .query(`UPDATE jobs
                SET status='CancelUnknown', cancel_requested=1,
                    error=COALESCE(error,?), completed_at=?, updated_at=?
                WHERE scope_key=? AND connector_id=? AND target_backend=?
                  AND status='Cancelling'
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
        .run(reason, now, now, this.scopeKey, connectorId, backend, backend).changes;
      const interrupted = this.database
        .query(`UPDATE jobs
                SET status='Interrupted', error=COALESCE(error,?),
                    completed_at=?, updated_at=?
                WHERE scope_key=? AND connector_id=? AND target_backend=?
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
        .run(reason, now, now, this.scopeKey, connectorId, backend, backend).changes;
      const changed = cancelUnknown + interrupted;
      if (marked.changes !== changed || activeAttempts.length !== changed) {
        throw new Error("backend disconnect 的 job 与 session recovery 数量不一致");
      }
      for (const attempt of activeAttempts) {
        this.appendExecutionAttemptEventLocked({
          jobId: attempt.job_id,
          runGeneration: attempt.run_generation,
          eventType: attempt.status === "Cancelling" ? "cancel_unknown" : "interrupted",
          providerOperationId: attempt.active_turn_id,
          reason,
          createdAt: now,
        });
      }
      return changed;
    });
    return transaction.immediate();
  }

  releaseBackendSessionRecovery(backend: string, sessionKey: string): boolean {
    const transaction = this.database.transaction(() => {
      const released = this.database
        .query(`DELETE FROM backend_sessions
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
        .run(this.scopeKey, backend, sessionKey);
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
   *
   * recovery 表示旧 provider execution 的最终尾部可能已经变化；仅清 active 字段
   * 再 resume 原 thread 会把未知尾部伪装成安全连续性。因此人工确认后退役整条
   * backend session，保留 jobs/outbox 与上游 rollout，但下次启动必须创建新 thread。
   * 没有 recovery 的 idle quarantine（例如 command/security binding 漂移）同样必须
   * 退役旧 session；只删除 quarantine 会让下一次启动再次命中旧 immutable metadata。
   */
  releaseSessionRecoveryWithReceipt(sessionKey: string): SessionReleaseReceipt {
    const transaction = this.database.transaction(() => {
      const existingBackends = this.database
        .query<{ backend: string }, [string, string]>(
          `SELECT backend FROM backend_sessions
           WHERE scope_key=? AND session_key=? ORDER BY backend`,
        )
        .all(this.scopeKey, sessionKey)
        .map((row) => row.backend);
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
        const quarantine = this.database
          .query<{ present: number }, [string, string]>(
            `SELECT EXISTS(
               SELECT 1 FROM session_quarantine WHERE scope_key=? AND session_key=?
             ) AS present`,
          )
          .get(this.scopeKey, sessionKey)?.present ?? 0;
        if (quarantine !== 1) {
          return {
            released: false,
            retiredBackendSessions: [],
            releasedQuarantineWithoutBackendSession: false,
          };
        }
        const unsafeSessions = this.database
          .query<{ count: number }, [string, string]>(
            `SELECT COUNT(*) AS count FROM backend_sessions
             WHERE scope_key=? AND session_key=?
               AND (active_job_id IS NOT NULL OR recovery_required<>0)`,
          )
          .get(this.scopeKey, sessionKey)?.count ?? 0;
        if (unsafeSessions !== 0) {
          return {
            released: false,
            retiredBackendSessions: [],
            releasedQuarantineWithoutBackendSession: false,
          };
        }
        const retired = this.database
          .query(`DELETE FROM backend_sessions
                  WHERE scope_key=? AND session_key=?
                    AND active_job_id IS NULL AND recovery_required=0`)
          .run(this.scopeKey, sessionKey).changes;
        if (retired !== existingBackends.length) {
          throw new Error("idle quarantine 退役数量与事务内快照不一致");
        }
        const released = this.database
          .query("DELETE FROM session_quarantine WHERE scope_key=? AND session_key=?")
          .run(this.scopeKey, sessionKey).changes === 1;
        return {
          released,
          retiredBackendSessions: released ? existingBackends : [],
          releasedQuarantineWithoutBackendSession: released && existingBackends.length === 0,
        };
      }
      if (recovery.releasable !== recovery.total) {
        return {
          released: false,
          retiredBackendSessions: [],
          releasedQuarantineWithoutBackendSession: false,
        };
      }

      const recoveryBackends = this.database
        .query<{ backend: string }, [string, string]>(
          `SELECT backend FROM backend_sessions
           WHERE scope_key=? AND session_key=? AND recovery_required=1
           ORDER BY backend`,
        )
        .all(this.scopeKey, sessionKey)
        .map((row) => row.backend);

      const released = this.database
        .query(`DELETE FROM backend_sessions
                WHERE scope_key=? AND session_key=? AND recovery_required=1`)
        .run(this.scopeKey, sessionKey);
      if (released.changes !== recovery.total) {
        throw new Error("session recovery 释放数量与已验证历史证据不一致");
      }
      this.database
        .query("DELETE FROM session_quarantine WHERE scope_key=? AND session_key=?")
        .run(this.scopeKey, sessionKey);
      return {
        released: true,
        retiredBackendSessions: recoveryBackends,
        releasedQuarantineWithoutBackendSession: false,
      };
    });
    return transaction.immediate();
  }

  releaseSessionRecovery(sessionKey: string): boolean {
    return this.releaseSessionRecoveryWithReceipt(sessionKey).released;
  }

  markAcked(jobId: string): StoredJob {
    this.transition(jobId, ["Received"], "Acked");
    return this.require(jobId);
  }

  claimForDispatch(jobId: string, connectorId: string, leaseId: string): StoredJob | null {
    const now = Date.now();
    const transaction = this.database.transaction(() => {
      const result = this.database
        .query(`UPDATE jobs AS target
                SET status='Dispatching', connector_id=?, lease_id=?, run_generation=run_generation+1, updated_at=?
                WHERE target.scope_key=? AND target.job_id=?
                  AND target.target_backend='hermes'
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
      if (result.changes !== 1) return false;
      const runGeneration = this.require(jobId).runGeneration;
      this.appendExecutionAttemptEventLocked({
        jobId,
        runGeneration,
        eventType: "reserved",
        providerOperationId: null,
        createdAt: now,
      });
      return true;
    });
    return transaction.immediate() ? this.require(jobId) : null;
  }

  resetUnsentDispatch(jobId: string, leaseId: string): void {
    const now = Date.now();
    const transaction = this.database.transaction(() => {
      const reset = this.database
        .query("UPDATE jobs SET status='Acked', updated_at=? WHERE scope_key=? AND job_id=? AND target_backend='hermes' AND status='Dispatching' AND lease_id=?")
        .run(now, this.scopeKey, jobId, leaseId);
      if (reset.changes !== 1) return;
      const runGeneration = this.require(jobId).runGeneration;
      this.appendExecutionAttemptEventLocked({
        jobId,
        runGeneration,
        eventType: "not_sent",
        providerOperationId: null,
        reason: "connector request was proven not sent",
        createdAt: now,
      });
      const cleared = this.database
        .query("UPDATE jobs SET connector_id=NULL,lease_id=NULL WHERE scope_key=? AND job_id=? AND target_backend='hermes' AND status='Acked' AND lease_id=? AND run_generation=?")
        .run(this.scopeKey, jobId, leaseId, runGeneration);
      if (cleared.changes !== 1) {
        throw new Error("Hermes unsent reset 未能原子清除 job attempt");
      }
    });
    transaction.immediate();
  }

  markRunning(jobId: string, connectorId: string, leaseId: string): StoredJob {
    const now = Date.now();
    const transaction = this.database.transaction(() => {
      const running = this.database
        .query("UPDATE jobs SET status='Running', connector_id=?, updated_at=? WHERE scope_key=? AND job_id=? AND target_backend='hermes' AND status='Dispatching' AND lease_id=? AND cancel_requested=0")
        .run(connectorId, now, this.scopeKey, jobId, leaseId);
      if (running.changes !== 1) return;
      this.appendExecutionAttemptEventLocked({
        jobId,
        runGeneration: this.require(jobId).runGeneration,
        eventType: "accepted",
        providerOperationId: null,
        createdAt: now,
      });
    });
    transaction.immediate();
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
        .query("UPDATE jobs SET status='CancelUnknown', cancel_requested=1, error=?, completed_at=?, updated_at=? WHERE scope_key=? AND job_id=? AND target_backend='hermes' AND lease_id=? AND status='Cancelling'")
        .run(reason, now, now, this.scopeKey, jobId, leaseId);
      if (result.changes === 1) {
        this.appendExecutionAttemptEventLocked({
          jobId,
          runGeneration: this.require(jobId).runGeneration,
          eventType: "cancel_unknown",
          providerOperationId: null,
          reason,
          createdAt: now,
        });
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
      const activeAttempts = this.database
        .query<{ job_id: string; run_generation: number; status: JobStatus }, [string, string]>(`
          SELECT job_id,run_generation,status FROM jobs
          WHERE scope_key=? AND connector_id=? AND target_backend='hermes'
            AND status IN ('Dispatching','Running','Cancelling')
        `)
        .all(this.scopeKey, connectorId);
      this.database.query(`
        INSERT OR IGNORE INTO session_quarantine(scope_key,session_key,reason,created_at)
        SELECT scope_key,session_key,'connector disconnected during active execution',?
        FROM jobs
        WHERE scope_key=? AND connector_id=? AND target_backend='hermes'
          AND status IN ('Dispatching','Running','Cancelling')
      `).run(now, this.scopeKey, connectorId);
      const cancelUnknown = this.database
        .query("UPDATE jobs SET status='CancelUnknown', error=COALESCE(error, 'connector disconnected during cancellation'), completed_at=?, updated_at=? WHERE scope_key=? AND connector_id=? AND target_backend='hermes' AND status='Cancelling'")
        .run(now, now, this.scopeKey, connectorId).changes;
      const interrupted = this.database
        .query(`UPDATE jobs SET status='Interrupted', error=COALESCE(error, 'connector disconnected'), completed_at=?, updated_at=?
                WHERE scope_key=? AND connector_id=? AND target_backend='hermes'
                  AND status IN ('Dispatching','Running')`)
        .run(now, now, this.scopeKey, connectorId).changes;
      const changed = cancelUnknown + interrupted;
      if (activeAttempts.length !== changed) {
        throw new Error("Hermes disconnect 的 job 与 execution attempt 数量不一致");
      }
      for (const attempt of activeAttempts) {
        const reason = attempt.status === "Cancelling"
          ? "connector disconnected during cancellation"
          : "connector disconnected";
        this.appendExecutionAttemptEventLocked({
          jobId: attempt.job_id,
          runGeneration: attempt.run_generation,
          eventType: attempt.status === "Cancelling" ? "cancel_unknown" : "interrupted",
          providerOperationId: null,
          reason,
          createdAt: now,
        });
      }
      return changed;
    });
    return transaction.immediate();
  }

  listDispatchable(targetBackend: ExecutionBackendKind, limit = 100): StoredJob[] {
    return this.database
      .query<JobViewRow, [string, string, number]>(`${JOB_VIEW}
        WHERE j.scope_key=? AND j.target_backend=?
          AND j.status IN ('Received','Acked') AND j.cancel_requested=0
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
      .all(this.scopeKey, targetBackend, limit)
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

  listBackendBacklog(): BackendBacklogCount[] {
    return this.database
      .query<{
        target_backend: string;
        count: number;
        oldest_created_at: number;
      }, [string]>(`
        SELECT target_backend,COUNT(*) AS count,MIN(created_at) AS oldest_created_at
        FROM jobs
        WHERE scope_key=? AND status IN ('Received','Acked','Dispatching','Running','Cancelling')
        GROUP BY target_backend
        ORDER BY target_backend
      `)
      .all(this.scopeKey)
      .map((row) => {
        if (
          row.target_backend !== "hermes" &&
          row.target_backend !== "codex" &&
          row.target_backend !== "claude"
        ) {
          throw new Error(`backlog target_backend 非法：${row.target_backend}`);
        }
        return {
          backend: row.target_backend,
          count: row.count,
          oldestCreatedAt: row.oldest_created_at,
        };
      });
  }

  /**
   * 返回最近的 limit 条 execution attempt 事件，并保持从旧到新的时间顺序。
   * 超过窗口的更旧事件会被截断，最新 attempt 不会因默认上限而被隐藏。
   */
  listExecutionAttemptEvents(jobId: string, limit = 100): StoredExecutionAttemptEvent[] {
    return this.database
      .query<ExecutionAttemptEventRow, [string, string, number]>(`
        SELECT * FROM (
          SELECT * FROM execution_attempt_events
          WHERE scope_key=? AND job_id=?
          ORDER BY run_generation DESC,sequence DESC
          LIMIT ?
        ) recent_events
        ORDER BY run_generation ASC,sequence ASC
      `)
      .all(this.scopeKey, jobId, limit)
      .map(rowToExecutionAttemptEvent);
  }

  latestExecutionAttemptEvent(jobId: string): StoredExecutionAttemptEvent | null {
    const row = this.database
      .query<ExecutionAttemptEventRow, [string, string]>(`
        SELECT * FROM execution_attempt_events
        WHERE scope_key=? AND job_id=?
        ORDER BY run_generation DESC,sequence DESC
        LIMIT 1
      `)
      .get(this.scopeKey, jobId);
    return row ? rowToExecutionAttemptEvent(row) : null;
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

  /** 调用方必须已经位于包含对应 job 状态迁移的写事务内。 */
  private appendExecutionAttemptEventLocked(input: {
    jobId: string;
    runGeneration: number;
    eventType: ExecutionAttemptEventType;
    providerOperationId?: string | null;
    reason?: string | null;
    createdAt: number;
  }): void {
    const context = this.database
      .query<AttemptAuditContextRow, [string, string, number]>(`
        SELECT jobs.target_backend,jobs.session_key,jobs.lease_id,jobs.connector_id,
               backend_sessions.thread_id,backend_sessions.active_turn_id,
               backend_sessions.cli_version,backend_sessions.requested_model,
               backend_sessions.effective_model,backend_sessions.model_provider,
               backend_sessions.account_type,backend_sessions.account_subject_sha256,
               backend_sessions.security_config_sha256,
               backend_sessions.feature_snapshot_sha256
        FROM jobs
        LEFT JOIN backend_sessions
          ON backend_sessions.scope_key=jobs.scope_key
         AND backend_sessions.backend=jobs.target_backend
         AND backend_sessions.session_key=jobs.session_key
        WHERE jobs.scope_key=? AND jobs.job_id=? AND jobs.run_generation=?
      `)
      .get(this.scopeKey, input.jobId, input.runGeneration);
    if (!context || !context.lease_id || !context.connector_id) {
      throw new Error(`execution attempt 缺少 durable job/lease/execution 上下文：${input.jobId}`);
    }
    if (
      context.target_backend !== "hermes" &&
      context.target_backend !== "codex" &&
      context.target_backend !== "claude"
    ) {
      throw new Error(`execution attempt backend 非法：${context.target_backend}`);
    }
    const allowsLegacyMetadata =
      (input.eventType === "interrupted" || input.eventType === "cancel_unknown") &&
      this.database
        .query<{ present: number }, [string, string, number]>(`
          SELECT 1 AS present FROM execution_attempt_events
          WHERE scope_key=? AND job_id=? AND run_generation=?
            AND event_type='legacy_active_imported'
          LIMIT 1
        `)
        .get(this.scopeKey, input.jobId, input.runGeneration) !== null;
    if (
      context.target_backend === "codex" && !allowsLegacyMetadata &&
      (!context.thread_id || !context.cli_version || !context.effective_model ||
        !context.model_provider || !context.account_type || !context.security_config_sha256 ||
        !context.feature_snapshot_sha256)
    ) {
      throw new Error(`Codex execution attempt 缺少 immutable session 元数据：${input.jobId}`);
    }
    const sequence = (this.database
      .query<{ sequence: number | null }, [string, string, number]>(`
        SELECT MAX(sequence) AS sequence FROM execution_attempt_events
        WHERE scope_key=? AND job_id=? AND run_generation=?
      `)
      .get(this.scopeKey, input.jobId, input.runGeneration)?.sequence ?? 0) + 1;
    const providerOperationId = input.providerOperationId === undefined
      ? context.active_turn_id
      : input.providerOperationId;
    const inserted = this.database
      .query(`INSERT INTO execution_attempt_events(
                scope_key,job_id,run_generation,sequence,backend,session_key,
                lease_id,backend_execution_id,provider_session_id,provider_operation_id,
                runtime_version,requested_model,effective_model,model_provider,
                account_type,account_subject_sha256,security_config_sha256,
                feature_snapshot_sha256,event_type,reason,created_at
              ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        this.scopeKey,
        input.jobId,
        input.runGeneration,
        sequence,
        context.target_backend,
        context.session_key,
        context.lease_id,
        context.connector_id,
        context.target_backend === "codex" ? context.thread_id : null,
        providerOperationId,
        context.cli_version,
        context.requested_model,
        context.effective_model,
        context.model_provider,
        context.account_type,
        context.account_subject_sha256,
        context.security_config_sha256,
        context.feature_snapshot_sha256,
        input.eventType,
        boundedAttemptReason(input.reason ?? null),
        input.createdAt,
      );
    if (inserted.changes !== 1) {
      throw new Error(`execution attempt event 未能持久化：${input.jobId}/${input.eventType}`);
    }
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
                  AND target_backend=? AND lease_id=? AND run_generation=?
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
          backend,
          leaseId,
          runGeneration,
          backend,
          leaseId,
          runGeneration,
          turnId,
          turnId,
      );
      if (terminal.changes !== 1) return false;
      this.appendExecutionAttemptEventLocked({
        jobId,
        runGeneration,
        eventType: status === "CancelUnknown" ? "cancel_unknown" : "interrupted",
        providerOperationId: turnId,
        reason,
        createdAt: now,
      });
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
                  AND target_backend=? AND lease_id=? AND run_generation=?
                  AND cancel_requested=0
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
          backend,
          leaseId,
          runGeneration,
          backend,
          leaseId,
          runGeneration,
          turnId,
      );
      if (finished.changes !== 1) return false;
      this.appendExecutionAttemptEventLocked({
        jobId,
        runGeneration,
        eventType: status === "Succeeded" ? "succeeded" : "failed",
        providerOperationId: turnId,
        reason: error,
        createdAt: now,
      });
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
                  AND target_backend='hermes'
                  AND status IN ('Dispatching','Running') AND cancel_requested=0`)
        .run(status, error, now, now, this.scopeKey, jobId, leaseId);
      if (result.changes === 1) {
        this.appendExecutionAttemptEventLocked({
          jobId,
          runGeneration: this.require(jobId).runGeneration,
          eventType: status === "Succeeded" ? "succeeded" : "failed",
          providerOperationId: null,
          reason: error,
          createdAt: now,
        });
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
      if (
        version !== 0 && version !== 1 && version !== 2 && version !== 3 &&
        version !== 4 && version !== 5 && version !== 6 && version !== 7
      ) {
        throw new Error(`不支持的数据库 schema 版本：${version}`);
      }
      if (version === 7) {
        this.assertMigratedSchemaV7();
        this.assertLegacyV4MigrationDecision();
        return;
      }
      if (version === 6) {
        this.assertMigratedSchemaV6();
        this.createExecutionAttemptLedgerSchemaV7();
        this.database.exec("PRAGMA user_version=7;");
        this.assertMigratedSchemaV7();
        this.assertLegacyV4MigrationDecision();
        return;
      }
      if (version === 5) {
        this.assertMigratedSchemaV5();
        this.createBackendSessionMetadataSchemaV6();
        this.createExecutionAttemptLedgerSchemaV7();
        this.database.exec("PRAGMA user_version=7;");
        this.assertMigratedSchemaV7();
        this.assertLegacyV4MigrationDecision();
        return;
      }
      if (version === 4) {
        this.assertBackendSessionsSchemaV4();
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
      if (version < 4) {
        this.createBackendSessionsSchemaV4();
      }
      this.createJobTargetBackendSchemaV5(version);
      this.assertMigratedSchemaV5();
      this.createBackendSessionMetadataSchemaV6();
      this.createExecutionAttemptLedgerSchemaV7();
      this.database.exec("PRAGMA user_version=7;");
      this.assertMigratedSchemaV7();
      this.assertLegacyV4MigrationDecision();
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

  private createJobTargetBackendSchemaV5(fromVersion: number): void {
    const pendingV4Jobs = fromVersion === 4
      ? this.database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM jobs WHERE status IN ('Received','Acked')",
        )
        .get()?.count ?? 0
      : 0;
    if (pendingV4Jobs > 0 && !this.options.legacyV4JobBackend) {
      throw new Error(
        `SQLite v4 中有 ${pendingV4Jobs} 个未绑定 provider 的待派发 job；` +
        "必须先确认它们入库时使用的 backend，并设置 config.execution.legacyV4JobBackend 后再迁移",
      );
    }
    if (pendingV4Jobs > 0) {
      const conflictingEvidence = this.database
        .query<{ count: number }, [string]>(`
          SELECT COUNT(*) AS count
          FROM jobs
          WHERE status IN ('Received','Acked')
            AND EXISTS (
              SELECT 1 FROM backend_sessions backend_session
              WHERE backend_session.scope_key=jobs.scope_key
                AND backend_session.session_key=jobs.session_key
                AND backend_session.backend<>?
            )
        `)
        .get(this.options.legacyV4JobBackend!)?.count ?? 0;
      if (conflictingEvidence > 0) {
        throw new Error(
          `SQLite v4 中有 ${conflictingEvidence} 个待派发 job 的 session 证据与 ` +
          `config.execution.legacyV4JobBackend=${this.options.legacyV4JobBackend} 冲突；` +
          "拒绝猜测 provider，必须保留备份并人工审阅",
        );
      }
    }

    // SQLite 不能给已有表直接增加“无默认值的 NOT NULL 列”。迁移专用默认值
    // 只负责填充旧行；两个 trigger 会拒绝任何新 INSERT/UPDATE 留下该标记，
    // rowToJob 和 schema readback 也会再次失败关闭。
    this.database.exec(`
      ALTER TABLE jobs ADD COLUMN target_backend TEXT NOT NULL DEFAULT '__migration_unbound__'
        CHECK(target_backend IN ('hermes','codex','claude','__migration_unbound__'));
      CREATE TRIGGER jobs_target_backend_insert_required
      BEFORE INSERT ON jobs
      WHEN NEW.target_backend='__migration_unbound__'
      BEGIN
        SELECT RAISE(ABORT, 'jobs.target_backend is required');
      END;
      CREATE TRIGGER jobs_target_backend_update_required
      BEFORE UPDATE OF target_backend ON jobs
      WHEN NEW.target_backend='__migration_unbound__'
      BEGIN
        SELECT RAISE(ABORT, 'jobs.target_backend is required');
      END;
      DROP INDEX idx_jobs_dispatch;
      CREATE INDEX idx_jobs_dispatch
        ON jobs(scope_key,target_backend,status,cancel_requested,session_key,created_at);
    `);

    if (fromVersion < 4) {
      // v1-v3 只有 Hermes connector，绑定为 Hermes 不需要猜测。
      this.database.query("UPDATE jobs SET target_backend='hermes'").run();
      this.database.query(
        "INSERT INTO meta(key,value) VALUES('schema_v5_legacy_job_backend','hermes-pre-v4') " +
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run();
      return;
    }

    // v4 已经可能由 Hermes 或 Codex 创建。活动 attempt 可从 backend_sessions
    // 精确恢复；已完成的 Codex job 只在同 session 存在 Codex 元数据且 execution
    // ID 使用固定 codex: 前缀时回填。其余历史终态不再派发，保守记为 Hermes。
    this.database.query("UPDATE jobs SET target_backend='hermes'").run();
    this.database.exec(`
      UPDATE jobs
      SET target_backend=(
        SELECT backend_session.backend
        FROM backend_sessions backend_session
        WHERE backend_session.scope_key=jobs.scope_key
          AND backend_session.active_job_id=jobs.job_id
          AND backend_session.backend IN ('hermes','codex','claude')
        LIMIT 1
      )
      WHERE EXISTS (
        SELECT 1 FROM backend_sessions backend_session
        WHERE backend_session.scope_key=jobs.scope_key
          AND backend_session.active_job_id=jobs.job_id
          AND backend_session.backend IN ('hermes','codex','claude')
      );
      UPDATE jobs
      SET target_backend='codex'
      WHERE connector_id LIKE 'codex:%'
        AND EXISTS (
          SELECT 1 FROM backend_sessions backend_session
          WHERE backend_session.scope_key=jobs.scope_key
            AND backend_session.session_key=jobs.session_key
            AND backend_session.backend='codex'
        );
    `);
    if (pendingV4Jobs > 0) {
      this.database
        .query("UPDATE jobs SET target_backend=? WHERE status IN ('Received','Acked')")
        .run(this.options.legacyV4JobBackend!);
    }
    this.database
      .query(
        "INSERT INTO meta(key,value) VALUES('schema_v5_legacy_job_backend',?) " +
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(pendingV4Jobs > 0 ? this.options.legacyV4JobBackend! : "no-pending-v4-jobs");
  }

  private createBackendSessionMetadataSchemaV6(): void {
    // 新字段允许 NULL 仅用于表示“由 v5 迁入、尚未安全绑定”的历史行。
    // fresh INSERT trigger 和一次性 binding trigger 保证 v6 新行不能留下半状态。
    this.database.exec(`
      ALTER TABLE backend_sessions ADD COLUMN account_type TEXT
        CHECK(account_type IS NULL OR length(account_type) BETWEEN 1 AND 64);
      ALTER TABLE backend_sessions ADD COLUMN account_subject_sha256 TEXT
        CHECK(account_subject_sha256 IS NULL OR (
          length(account_subject_sha256)=64 AND
          account_subject_sha256 NOT GLOB '*[^0-9a-f]*'
        ));
      ALTER TABLE backend_sessions ADD COLUMN account_identity_strength TEXT
        CHECK(account_identity_strength IS NULL OR account_identity_strength IN ('subject','type-only'));
      ALTER TABLE backend_sessions ADD COLUMN requested_model TEXT
        CHECK(requested_model IS NULL OR length(requested_model) BETWEEN 1 AND 256);
      ALTER TABLE backend_sessions ADD COLUMN effective_model TEXT
        CHECK(effective_model IS NULL OR length(effective_model) BETWEEN 1 AND 256);
      ALTER TABLE backend_sessions ADD COLUMN model_provider TEXT
        CHECK(model_provider IS NULL OR length(model_provider) BETWEEN 1 AND 128);
      ALTER TABLE backend_sessions ADD COLUMN security_config_sha256 TEXT
        CHECK(security_config_sha256 IS NULL OR (
          length(security_config_sha256)=64 AND
          security_config_sha256 NOT GLOB '*[^0-9a-f]*'
        ));
      ALTER TABLE backend_sessions ADD COLUMN feature_snapshot_sha256 TEXT
        CHECK(feature_snapshot_sha256 IS NULL OR (
          length(feature_snapshot_sha256)=64 AND
          feature_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
        ));
      ALTER TABLE backend_sessions ADD COLUMN checkpoint_turn_id TEXT
        CHECK(checkpoint_turn_id IS NULL OR length(checkpoint_turn_id) BETWEEN 1 AND 256);
      ALTER TABLE backend_sessions ADD COLUMN checkpoint_turn_status TEXT
        CHECK(checkpoint_turn_status IS NULL OR checkpoint_turn_status IN ('completed','failed','interrupted'));
      ALTER TABLE backend_sessions ADD COLUMN checkpoint_turn_count INTEGER
        CHECK(checkpoint_turn_count IS NULL OR checkpoint_turn_count >= 0);
      ALTER TABLE backend_sessions ADD COLUMN checkpoint_turns_sha256 TEXT
        CHECK(checkpoint_turns_sha256 IS NULL OR (
          length(checkpoint_turns_sha256)=64 AND
          checkpoint_turns_sha256 NOT GLOB '*[^0-9a-f]*'
        ));
      ALTER TABLE backend_sessions ADD COLUMN checkpointed_at INTEGER
        CHECK(checkpointed_at IS NULL OR checkpointed_at >= 0);

      CREATE TRIGGER backend_sessions_v6_metadata_insert_required
      BEFORE INSERT ON backend_sessions
      WHEN NEW.account_type IS NULL
        OR NEW.account_identity_strength IS NULL
        OR NEW.effective_model IS NULL
        OR NEW.model_provider IS NULL
        OR NEW.security_config_sha256 IS NULL
        OR NEW.feature_snapshot_sha256 IS NULL
        OR NEW.checkpoint_turn_count IS NULL
        OR NEW.checkpoint_turns_sha256 IS NULL
        OR NEW.checkpointed_at IS NULL
        OR (NEW.account_identity_strength='subject' AND NEW.account_subject_sha256 IS NULL)
        OR (NEW.account_identity_strength='type-only' AND NEW.account_subject_sha256 IS NOT NULL)
        OR (NEW.checkpoint_turn_count=0 AND (
          NEW.checkpoint_turn_id IS NOT NULL OR NEW.checkpoint_turn_status IS NOT NULL
        ))
        OR (NEW.checkpoint_turn_count>0 AND (
          NEW.checkpoint_turn_id IS NULL OR NEW.checkpoint_turn_status IS NULL
        ))
      BEGIN
        SELECT RAISE(ABORT, 'backend_sessions v6 metadata is required');
      END;

      CREATE TRIGGER backend_sessions_v6_metadata_binding_complete
      BEFORE UPDATE OF account_type,account_subject_sha256,account_identity_strength,
        requested_model,effective_model,model_provider,security_config_sha256,
        feature_snapshot_sha256,checkpoint_turn_id,checkpoint_turn_status,
        checkpoint_turn_count,checkpoint_turns_sha256,checkpointed_at
      ON backend_sessions
      WHEN OLD.account_type IS NULL AND (
        NEW.account_type IS NULL
        OR NEW.account_identity_strength IS NULL
        OR NEW.effective_model IS NULL
        OR NEW.model_provider IS NULL
        OR NEW.security_config_sha256 IS NULL
        OR NEW.feature_snapshot_sha256 IS NULL
        OR NEW.checkpoint_turn_count IS NULL
        OR NEW.checkpoint_turns_sha256 IS NULL
        OR NEW.checkpointed_at IS NULL
        OR (NEW.account_identity_strength='subject' AND NEW.account_subject_sha256 IS NULL)
        OR (NEW.account_identity_strength='type-only' AND NEW.account_subject_sha256 IS NOT NULL)
        OR (NEW.checkpoint_turn_count=0 AND (
          NEW.checkpoint_turn_id IS NOT NULL OR NEW.checkpoint_turn_status IS NOT NULL
        ))
        OR (NEW.checkpoint_turn_count>0 AND (
          NEW.checkpoint_turn_id IS NULL OR NEW.checkpoint_turn_status IS NULL
        ))
      )
      BEGIN
        SELECT RAISE(ABORT, 'backend_sessions v6 metadata binding must be complete');
      END;

      CREATE TRIGGER backend_sessions_v6_metadata_immutable
      BEFORE UPDATE OF account_type,account_subject_sha256,account_identity_strength,
        requested_model,effective_model,model_provider,security_config_sha256,
        feature_snapshot_sha256
      ON backend_sessions
      WHEN OLD.account_type IS NOT NULL AND (
        NEW.account_type IS NOT OLD.account_type
        OR NEW.account_subject_sha256 IS NOT OLD.account_subject_sha256
        OR NEW.account_identity_strength IS NOT OLD.account_identity_strength
        OR NEW.requested_model IS NOT OLD.requested_model
        OR NEW.effective_model IS NOT OLD.effective_model
        OR NEW.model_provider IS NOT OLD.model_provider
        OR NEW.security_config_sha256 IS NOT OLD.security_config_sha256
        OR NEW.feature_snapshot_sha256 IS NOT OLD.feature_snapshot_sha256
      )
      BEGIN
        SELECT RAISE(ABORT, 'backend_sessions v6 immutable metadata drift');
      END;

      CREATE TRIGGER backend_sessions_v6_checkpoint_shape
      BEFORE UPDATE OF checkpoint_turn_id,checkpoint_turn_status,checkpoint_turn_count,
        checkpoint_turns_sha256,checkpointed_at
      ON backend_sessions
      WHEN NEW.account_type IS NOT NULL AND (
        NEW.checkpoint_turn_count IS NULL
        OR NEW.checkpoint_turns_sha256 IS NULL
        OR NEW.checkpointed_at IS NULL
        OR (NEW.checkpoint_turn_count=0 AND (
          NEW.checkpoint_turn_id IS NOT NULL OR NEW.checkpoint_turn_status IS NOT NULL
        ))
        OR (NEW.checkpoint_turn_count>0 AND (
          NEW.checkpoint_turn_id IS NULL OR NEW.checkpoint_turn_status IS NULL
        ))
      )
      BEGIN
        SELECT RAISE(ABORT, 'backend_sessions v6 checkpoint shape invalid');
      END;

      CREATE TRIGGER backend_sessions_v6_checkpoint_monotonic
      BEFORE UPDATE OF checkpoint_turn_id,checkpoint_turn_status,checkpoint_turn_count,
        checkpoint_turns_sha256
      ON backend_sessions
      WHEN OLD.checkpoint_turn_count IS NOT NULL AND (
        NEW.checkpoint_turn_count < OLD.checkpoint_turn_count
        OR (NEW.checkpoint_turn_count=OLD.checkpoint_turn_count AND (
          NEW.checkpoint_turn_id IS NOT OLD.checkpoint_turn_id
          OR NEW.checkpoint_turn_status IS NOT OLD.checkpoint_turn_status
          OR NEW.checkpoint_turns_sha256 IS NOT OLD.checkpoint_turns_sha256
        ))
      )
      BEGIN
        SELECT RAISE(ABORT, 'backend_sessions v6 checkpoint must be monotonic');
      END;
    `);
  }

  private createExecutionAttemptLedgerSchemaV7(): void {
    this.database.exec(`
      CREATE TRIGGER jobs_target_backend_immutable
      BEFORE UPDATE OF target_backend ON jobs
      WHEN NEW.target_backend IS NOT OLD.target_backend
      BEGIN
        SELECT RAISE(ABORT, 'jobs.target_backend is immutable');
      END;

      CREATE TABLE execution_attempt_events (
        scope_key TEXT NOT NULL,
        job_id TEXT NOT NULL,
        run_generation INTEGER NOT NULL CHECK(run_generation > 0),
        sequence INTEGER NOT NULL CHECK(sequence > 0),
        backend TEXT NOT NULL CHECK(backend IN ('hermes','codex','claude')),
        session_key TEXT NOT NULL CHECK(length(session_key) BETWEEN 1 AND 4096),
        lease_id TEXT NOT NULL CHECK(length(lease_id) BETWEEN 1 AND 4096),
        backend_execution_id TEXT NOT NULL
          CHECK(length(backend_execution_id) BETWEEN 1 AND 4096),
        provider_session_id TEXT
          CHECK(provider_session_id IS NULL OR length(provider_session_id) BETWEEN 1 AND 256),
        provider_operation_id TEXT
          CHECK(provider_operation_id IS NULL OR length(provider_operation_id) BETWEEN 1 AND 256),
        runtime_version TEXT
          CHECK(runtime_version IS NULL OR length(runtime_version) BETWEEN 1 AND 64),
        requested_model TEXT
          CHECK(requested_model IS NULL OR length(requested_model) BETWEEN 1 AND 256),
        effective_model TEXT
          CHECK(effective_model IS NULL OR length(effective_model) BETWEEN 1 AND 256),
        model_provider TEXT
          CHECK(model_provider IS NULL OR length(model_provider) BETWEEN 1 AND 128),
        account_type TEXT
          CHECK(account_type IS NULL OR length(account_type) BETWEEN 1 AND 64),
        account_subject_sha256 TEXT CHECK(account_subject_sha256 IS NULL OR (
          length(account_subject_sha256)=64 AND
          account_subject_sha256 NOT GLOB '*[^0-9a-f]*'
        )),
        security_config_sha256 TEXT CHECK(security_config_sha256 IS NULL OR (
          length(security_config_sha256)=64 AND
          security_config_sha256 NOT GLOB '*[^0-9a-f]*'
        )),
        feature_snapshot_sha256 TEXT CHECK(feature_snapshot_sha256 IS NULL OR (
          length(feature_snapshot_sha256)=64 AND
          feature_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
        )),
        event_type TEXT NOT NULL CHECK(event_type IN (
          'reserved','accepted','not_sent','cancelled_not_sent','succeeded','failed',
          'cancel_unknown','interrupted','legacy_active_imported'
        )),
        reason TEXT CHECK(reason IS NULL OR length(reason) <= ${EXECUTION_ATTEMPT_REASON_MAX_CHARS}),
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        PRIMARY KEY(scope_key,job_id,run_generation,sequence),
        UNIQUE(scope_key,job_id,run_generation,event_type),
        FOREIGN KEY(scope_key,job_id) REFERENCES jobs(scope_key,job_id)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      );
      CREATE INDEX idx_execution_attempt_job
        ON execution_attempt_events(scope_key,job_id,run_generation,sequence);
      CREATE INDEX idx_execution_attempt_session
        ON execution_attempt_events(scope_key,backend,session_key,created_at);

      CREATE TRIGGER execution_attempt_events_no_update
      BEFORE UPDATE ON execution_attempt_events
      BEGIN
        SELECT RAISE(ABORT, 'execution_attempt_events is append-only');
      END;
      CREATE TRIGGER execution_attempt_events_no_delete
      BEFORE DELETE ON execution_attempt_events
      BEGIN
        SELECT RAISE(ABORT, 'execution_attempt_events is append-only');
      END;

      INSERT INTO execution_attempt_events(
        scope_key,job_id,run_generation,sequence,backend,session_key,
        lease_id,backend_execution_id,provider_session_id,provider_operation_id,
        runtime_version,requested_model,effective_model,model_provider,
        account_type,account_subject_sha256,security_config_sha256,
        feature_snapshot_sha256,event_type,reason,created_at
      )
      SELECT jobs.scope_key,jobs.job_id,jobs.run_generation,1,jobs.target_backend,
             jobs.session_key,jobs.lease_id,jobs.connector_id,
             CASE WHEN jobs.target_backend='codex' THEN backend_sessions.thread_id ELSE NULL END,
             CASE WHEN jobs.target_backend='codex' THEN backend_sessions.active_turn_id ELSE NULL END,
             backend_sessions.cli_version,backend_sessions.requested_model,
             backend_sessions.effective_model,backend_sessions.model_provider,
             backend_sessions.account_type,backend_sessions.account_subject_sha256,
             backend_sessions.security_config_sha256,backend_sessions.feature_snapshot_sha256,
             'legacy_active_imported',
             'schema v6 active attempt imported without reconstructing earlier events',
             jobs.updated_at
      FROM jobs
      LEFT JOIN backend_sessions
        ON backend_sessions.scope_key=jobs.scope_key
       AND backend_sessions.backend=jobs.target_backend
       AND backend_sessions.session_key=jobs.session_key
       AND backend_sessions.active_job_id=jobs.job_id
       AND backend_sessions.active_lease_id=jobs.lease_id
       AND backend_sessions.active_run_generation=jobs.run_generation
      WHERE jobs.status IN ('Dispatching','Running','Cancelling')
        AND jobs.run_generation > 0
        AND jobs.lease_id IS NOT NULL
        AND jobs.connector_id IS NOT NULL;
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

  private assertMigratedSchemaV5(): void {
    const integrity = this.database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
    if (integrity?.integrity_check !== "ok") {
      throw new Error(`SQLite v5 迁移完整性检查失败：${integrity?.integrity_check ?? "unknown"}`);
    }
    const foreignKeyViolations = this.database.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all();
    if (foreignKeyViolations.length > 0) {
      throw new Error(`SQLite v5 迁移外键检查失败：${JSON.stringify(foreignKeyViolations)}`);
    }
    this.assertBackendSessionsSchemaV4();
    const targetBackendColumn = this.database
      .query<{ name: string; notnull: number; dflt_value: string | null }, []>("PRAGMA table_info(jobs)")
      .all()
      .find((column) => column.name === "target_backend");
    if (
      !targetBackendColumn ||
      targetBackendColumn.notnull !== 1 ||
      targetBackendColumn.dflt_value !== "'__migration_unbound__'"
    ) {
      throw new Error("SQLite v5 jobs.target_backend schema 不完整");
    }
    const triggers = this.database
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='jobs'",
      )
      .all()
      .map((item) => item.name);
    for (const expected of [
      "jobs_target_backend_insert_required",
      "jobs_target_backend_update_required",
    ]) {
      if (!triggers.includes(expected)) {
        throw new Error(`SQLite v5 target_backend trigger 缺失：${expected}`);
      }
    }
    const unbound = this.database
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM jobs WHERE target_backend='__migration_unbound__'",
      )
      .get()?.count ?? 0;
    if (unbound !== 0) {
      throw new Error(`SQLite v5 仍有 ${unbound} 个未绑定 provider 的 job`);
    }
  }

  private assertMigratedSchemaV6(): void {
    const integrity = this.database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
    if (integrity?.integrity_check !== "ok") {
      throw new Error(`SQLite v6 迁移完整性检查失败：${integrity?.integrity_check ?? "unknown"}`);
    }
    const foreignKeyViolations = this.database.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all();
    if (foreignKeyViolations.length > 0) {
      throw new Error(`SQLite v6 迁移外键检查失败：${JSON.stringify(foreignKeyViolations)}`);
    }

    const backendSessionColumns = this.database
      .query<{ name: string }, []>("PRAGMA table_info(backend_sessions)")
      .all()
      .map((column) => column.name);
    const expectedBackendSessionColumns = [
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
      "account_type",
      "account_subject_sha256",
      "account_identity_strength",
      "requested_model",
      "effective_model",
      "model_provider",
      "security_config_sha256",
      "feature_snapshot_sha256",
      "checkpoint_turn_id",
      "checkpoint_turn_status",
      "checkpoint_turn_count",
      "checkpoint_turns_sha256",
      "checkpointed_at",
    ];
    if (
      backendSessionColumns.length !== expectedBackendSessionColumns.length ||
      expectedBackendSessionColumns.some((column) => !backendSessionColumns.includes(column))
    ) {
      throw new Error("SQLite v6 backend_sessions schema 不完整");
    }

    const targetBackendColumn = this.database
      .query<{ name: string; notnull: number; dflt_value: string | null }, []>("PRAGMA table_info(jobs)")
      .all()
      .find((column) => column.name === "target_backend");
    if (
      !targetBackendColumn ||
      targetBackendColumn.notnull !== 1 ||
      targetBackendColumn.dflt_value !== "'__migration_unbound__'"
    ) {
      throw new Error("SQLite v6 jobs.target_backend schema 不完整");
    }

    const triggers = this.database
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='trigger'")
      .all()
      .map((item) => item.name);
    for (const expected of [
      "jobs_target_backend_insert_required",
      "jobs_target_backend_update_required",
      "backend_sessions_v6_metadata_insert_required",
      "backend_sessions_v6_metadata_binding_complete",
      "backend_sessions_v6_metadata_immutable",
      "backend_sessions_v6_checkpoint_shape",
      "backend_sessions_v6_checkpoint_monotonic",
    ]) {
      if (!triggers.includes(expected)) {
        throw new Error(`SQLite v6 trigger 缺失：${expected}`);
      }
    }

    const unboundJobs = this.database
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM jobs WHERE target_backend='__migration_unbound__'",
      )
      .get()?.count ?? 0;
    if (unboundJobs !== 0) {
      throw new Error(`SQLite v6 仍有 ${unboundJobs} 个未绑定 provider 的 job`);
    }

    const malformedMetadata = this.database
      .query<{ count: number }, []>(`
        SELECT COUNT(*) AS count
        FROM backend_sessions
        WHERE (
          account_type IS NULL AND (
            account_subject_sha256 IS NOT NULL
            OR account_identity_strength IS NOT NULL
            OR requested_model IS NOT NULL
            OR effective_model IS NOT NULL
            OR model_provider IS NOT NULL
            OR security_config_sha256 IS NOT NULL
            OR feature_snapshot_sha256 IS NOT NULL
            OR checkpoint_turn_id IS NOT NULL
            OR checkpoint_turn_status IS NOT NULL
            OR checkpoint_turn_count IS NOT NULL
            OR checkpoint_turns_sha256 IS NOT NULL
            OR checkpointed_at IS NOT NULL
          )
        ) OR (
          account_type IS NOT NULL AND (
            account_identity_strength IS NULL
            OR effective_model IS NULL
            OR model_provider IS NULL
            OR security_config_sha256 IS NULL
            OR feature_snapshot_sha256 IS NULL
            OR checkpoint_turn_count IS NULL
            OR checkpoint_turns_sha256 IS NULL
            OR checkpointed_at IS NULL
            OR (account_identity_strength='subject' AND account_subject_sha256 IS NULL)
            OR (account_identity_strength='type-only' AND account_subject_sha256 IS NOT NULL)
            OR (checkpoint_turn_count=0 AND (
              checkpoint_turn_id IS NOT NULL OR checkpoint_turn_status IS NOT NULL
            ))
            OR (checkpoint_turn_count>0 AND (
              checkpoint_turn_id IS NULL OR checkpoint_turn_status IS NULL
            ))
          )
        )
      `)
      .get()?.count ?? 0;
    if (malformedMetadata !== 0) {
      throw new Error(`SQLite v6 有 ${malformedMetadata} 个半绑定 backend session`);
    }
  }

  private assertMigratedSchemaV7(): void {
    this.assertMigratedSchemaV6();
    const columns = this.database
      .query<{ name: string }, []>("PRAGMA table_info(execution_attempt_events)")
      .all()
      .map((column) => column.name);
    const expectedColumns = [
      "scope_key",
      "job_id",
      "run_generation",
      "sequence",
      "backend",
      "session_key",
      "lease_id",
      "backend_execution_id",
      "provider_session_id",
      "provider_operation_id",
      "runtime_version",
      "requested_model",
      "effective_model",
      "model_provider",
      "account_type",
      "account_subject_sha256",
      "security_config_sha256",
      "feature_snapshot_sha256",
      "event_type",
      "reason",
      "created_at",
    ];
    if (columns.length !== expectedColumns.length || expectedColumns.some((item) => !columns.includes(item))) {
      throw new Error("SQLite v7 execution_attempt_events schema 不完整");
    }

    const triggers = this.database
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='trigger'")
      .all()
      .map((item) => item.name);
    for (const expected of [
      "jobs_target_backend_immutable",
      "execution_attempt_events_no_update",
      "execution_attempt_events_no_delete",
    ]) {
      if (!triggers.includes(expected)) {
        throw new Error(`SQLite v7 trigger 缺失：${expected}`);
      }
    }

    const activeWithoutAudit = this.database
      .query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM jobs
        WHERE status IN ('Dispatching','Running','Cancelling')
          AND NOT EXISTS (
            SELECT 1 FROM execution_attempt_events events
            WHERE events.scope_key=jobs.scope_key
              AND events.job_id=jobs.job_id
              AND events.run_generation=jobs.run_generation
          )
      `)
      .get()?.count ?? 0;
    if (activeWithoutAudit !== 0) {
      throw new Error(`SQLite v7 有 ${activeWithoutAudit} 个 active attempt 缺少审计事件`);
    }

    const malformedCodexEvents = this.database
      .query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM execution_attempt_events
        WHERE backend='codex' AND (
          provider_session_id IS NULL
          OR ((
            runtime_version IS NULL
            OR effective_model IS NULL
            OR model_provider IS NULL
            OR account_type IS NULL
            OR security_config_sha256 IS NULL
            OR feature_snapshot_sha256 IS NULL
          ) AND NOT EXISTS (
            SELECT 1 FROM execution_attempt_events legacy
            WHERE legacy.scope_key=execution_attempt_events.scope_key
              AND legacy.job_id=execution_attempt_events.job_id
              AND legacy.run_generation=execution_attempt_events.run_generation
              AND legacy.event_type='legacy_active_imported'
          ))
        )
      `)
      .get()?.count ?? 0;
    if (malformedCodexEvents !== 0) {
      throw new Error(`SQLite v7 有 ${malformedCodexEvents} 个 Codex 审计事件缺少 session 锚点`);
    }

    const sequenceGaps = this.database
      .query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM (
          SELECT sequence,
                 ROW_NUMBER() OVER (
                   PARTITION BY scope_key,job_id,run_generation ORDER BY sequence
                 ) AS expected_sequence
          FROM execution_attempt_events
        ) WHERE sequence<>expected_sequence
      `)
      .get()?.count ?? 0;
    if (sequenceGaps !== 0) {
      throw new Error(`SQLite v7 有 ${sequenceGaps} 个 execution attempt 事件序列不连续`);
    }
  }

  private assertLegacyV4MigrationDecision(): void {
    if (!this.options.legacyV4JobBackend) return;
    const recorded = this.getMeta("schema_v5_legacy_job_backend");
    if (
      (recorded === "hermes" || recorded === "codex" || recorded === "claude") &&
      recorded !== this.options.legacyV4JobBackend
    ) {
      throw new Error(
        `SQLite v5 已按 ${recorded} 绑定原 v4 积压，与当前 ` +
        `config.execution.legacyV4JobBackend=${this.options.legacyV4JobBackend} 冲突`,
      );
    }
  }
}
