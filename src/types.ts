export const CONNECTOR_PROTOCOL_VERSION = 1 as const;

/**
 * daemon 启动时三选一的执行后端。该值同时作为 job 入库时的不可变路由绑定，
 * 不表示三种 transport 可以互换或在同一 daemon 内同时在线。
 */
export type ExecutionBackendKind = "hermes" | "codex" | "claude";

/** schema v4 发布时实际存在的两个 backend；仅用于一次性迁移声明。 */
export type LegacyV4JobBackendKind = Exclude<ExecutionBackendKind, "claude">;

export type JobStatus =
  | "Received"
  | "Acked"
  | "Dispatching"
  | "Running"
  | "Cancelling"
  | "Succeeded"
  | "Cancelled"
  | "CancelUnknown"
  | "Interrupted"
  | "Failed"
  | "Rejected";

export type OutboxStatus = "Pending" | "Delivering" | "Delivered" | "AckFailed";

/** 只有已经稳定落盘的 terminal turn 才能成为恢复 checkpoint。 */
export type BackendCheckpointTurnStatus = "completed" | "failed" | "interrupted";

/** 账号身份绑定能否区分同类型账号；API key/Bedrock 当前只能绑定账号类型。 */
export type BackendAccountIdentityStrength = "subject" | "type-only";

export interface RelayMetadata {
  msg_id?: string;
  job_id?: string;
  agent_id?: string;
  device_id?: string;
  timestamp?: number;
  client?: string;
  [key: string]: unknown;
}

export interface RelayEnvelope {
  type: string;
  metadata?: RelayMetadata;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface IncomingRelayJob {
  jobId: string;
  messageId: string;
  fromNodeId: string;
  fromNodeType: string | null;
  text: string;
  timestamp: number;
  rawPayload: string;
}

export interface StoredJob extends IncomingRelayJob {
  scopeKey: string;
  payloadHash: string;
  /** 首次入库时绑定；配置切换不得改写已有 job 的目标后端。 */
  targetBackend: ExecutionBackendKind;
  status: JobStatus;
  sessionKey: string;
  connectorId: string | null;
  leaseId: string | null;
  runGeneration: number;
  error: string | null;
  cancelRequested: boolean;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  outbox: StoredOutbox | null;
}

export interface StoredOutbox {
  jobId: string;
  status: OutboxStatus;
  resultJson: string;
  retryCount: number;
  lastMessageId: string | null;
  nextAttemptAt: number | null;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
  ackedAt: number | null;
}

/**
 * daemon 直接管理的执行后端会话元数据。
 *
 * `sessionKey` 仍是 LiViS 会话所有权键；`threadId` 只是后端私有标识，
 * 不得替代 session quarantine、job 或 lease 的裁决键。
 */
export interface StoredBackendSession {
  scopeKey: string;
  backend: string;
  sessionKey: string;
  sessionHash: string;
  threadId: string | null;
  cwd: string;
  cliVersion: string;
  /** v5 旧行在首次安全绑定前为 null；新建 v6 行始终完整。 */
  accountType: string | null;
  accountSubjectSha256: string | null;
  accountIdentityStrength: BackendAccountIdentityStrength | null;
  requestedModel: string | null;
  effectiveModel: string | null;
  modelProvider: string | null;
  securityConfigSha256: string | null;
  featureSnapshotSha256: string | null;
  checkpointTurnId: string | null;
  checkpointTurnStatus: BackendCheckpointTurnStatus | null;
  checkpointTurnCount: number | null;
  checkpointTurnsSha256: string | null;
  checkpointedAt: number | null;
  activeJobId: string | null;
  activeLeaseId: string | null;
  activeRunGeneration: number | null;
  activeTurnId: string | null;
  recoveryRequired: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ConnectorImplementation {
  name: string;
  version: string;
  runtimeVersion?: string;
}

export interface ConnectorCapabilities {
  cancel: boolean;
  finalResult: boolean;
}

export interface ConnectorHello {
  type: "hello";
  protocolVersion: number;
  connectorId: string;
  backend: "hermes";
  implementation: ConnectorImplementation;
  capabilities: ConnectorCapabilities;
}

export interface ConnectorJobMessage {
  type: "job";
  protocolVersion: typeof CONNECTOR_PROTOCOL_VERSION;
  job: {
    jobId: string;
    leaseId: string;
    runGeneration: number;
    messageId: string;
    chatId: string;
    text: string;
    timestamp: number;
    user: {
      id: string;
      displayName: string;
      trusted: boolean;
    };
    source: {
      nodeId: string;
      nodeType: string | null;
    };
  };
}

export interface ConnectorCancelMessage {
  type: "cancel";
  protocolVersion: typeof CONNECTOR_PROTOCOL_VERSION;
  jobId: string;
  leaseId: string;
}

export type ConnectorInboundMessage =
  | ConnectorHello
  | { type: "accepted"; jobId: string; leaseId: string }
  | { type: "result"; jobId: string; leaseId: string; text: string }
  | { type: "failed"; jobId: string; leaseId: string; error: string; retryable?: boolean }
  | { type: "cancelled"; jobId: string; leaseId: string }
  | { type: "pong"; timestamp?: number };

export type ConnectorOutboundMessage =
  | { type: "hello_required"; protocolVersion: typeof CONNECTOR_PROTOCOL_VERSION }
  | {
      type: "hello_ack";
      protocolVersion: typeof CONNECTOR_PROTOCOL_VERSION;
      connectorId: string;
      daemonVersion: string;
      resultStoreTimeoutMs: number;
    }
  | ConnectorJobMessage
  | ConnectorCancelMessage
  | { type: "result_stored"; jobId: string; leaseId: string }
  | { type: "error"; code: string; message: string; jobId?: string }
  | { type: "ping"; timestamp: number };

export interface DeviceCodeResponse {
  device_code: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  tokenType: string;
  idToken?: string;
}
