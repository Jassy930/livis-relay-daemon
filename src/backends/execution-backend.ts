import type { StoredJob } from "../types.ts";

/**
 * daemon 当前选择的本地执行后端。
 *
 * `hermes` 仍通过 connector v1 接入；`codex` 使用 daemon 持有的
 * app-server 子进程。这个类型不代表两种后端共享传输协议。
 */
export type ExecutionBackendKind = "hermes" | "codex";

/**
 * `not_sent` 只能在后端能够证明请求没有离开 daemon 时返回。
 * 一旦请求可能已经提交，哪怕尚未收到 accepted，也必须返回
 * `submitted` 或走断连/隔离路径，调用方不得撤销 lease 后自动重发。
 */
export type ExecutionSubmission = "not_sent" | "submitted";

export interface ExecutionReadyEvent {
  kind: ExecutionBackendKind;
  executionId: string;
  implementation?: Record<string, unknown>;
}

export interface ExecutionJobEvent {
  kind: ExecutionBackendKind;
  executionId: string;
  jobId: string;
  leaseId: string;
  /** Codex attempt 的持久化 fencing 字段；Hermes connector v1 不携带。 */
  runGeneration?: number;
}

export interface ExecutionAcceptedEvent extends ExecutionJobEvent {
  /** Codex turn/start 返回值；Hermes connector v1 不携带。 */
  turnId?: string;
}

export interface ExecutionResultEvent extends ExecutionJobEvent {
  /** Codex terminal notification 对应的 turn；Hermes connector v1 不携带。 */
  turnId?: string;
  text: string;
}

export interface ExecutionFailedEvent extends ExecutionJobEvent {
  /** Codex terminal notification 对应的 turn；Hermes connector v1 不携带。 */
  turnId?: string;
  error: string;
  retryable?: boolean;
}

export interface ExecutionCancelledEvent extends ExecutionJobEvent {
  /** turn/start 尚未返回时可以为空；Hermes connector v1 不携带。 */
  turnId?: string | null;
}

export interface ExecutionDisconnectedEvent {
  kind: ExecutionBackendKind;
  executionId: string;
  reason?: string;
}

/**
 * 所有 handler 都必须在相应的持久化迁移完成后才 resolve。
 * 后端可以据此回复传输层 ACK，或安全释放当前 turn 的内存映射。
 */
export interface ExecutionBackendHandlers {
  onReady(event: ExecutionReadyEvent): Promise<void>;
  onAccepted(event: ExecutionAcceptedEvent): Promise<void>;
  onResult(event: ExecutionResultEvent): Promise<void>;
  onFailed(event: ExecutionFailedEvent): Promise<void>;
  onCancelled(event: ExecutionCancelledEvent): Promise<void>;
  onDisconnected(event: ExecutionDisconnectedEvent): Promise<void>;
}

/**
 * LiViS/job 状态仍由 daemon + JobStore 持有；实现不得自行重试 job、
 * 生成 outbox 或把后端会话状态当成执行状态真源。
 */
export interface ExecutionBackend {
  readonly kind: ExecutionBackendKind;
  readonly ready: boolean;
  readonly executionId: string | null;

  start(): Promise<void>;
  stop(): Promise<void>;
  dispatch(job: StoredJob): Promise<ExecutionSubmission>;
  cancel(job: StoredJob): Promise<ExecutionSubmission>;
  status(): Record<string, unknown>;
}
