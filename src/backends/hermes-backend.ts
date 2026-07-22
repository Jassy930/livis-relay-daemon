import type { ConnectorServer } from "../connector/server.ts";
import type { StoredJob } from "../types.ts";
import type { ExecutionBackend, ExecutionSubmission } from "./execution-backend.ts";

/**
 * 保留现有 Hermes connector v1 行为的薄适配器。
 *
 * 它只把 ConnectorServer 的生命周期和发送结果映射到通用后端接口，
 * 不改变 hello、版本门禁、generation fencing 或 durable result ACK。
 */
export class HermesExecutionBackend implements ExecutionBackend {
  readonly kind = "hermes" as const;

  constructor(private readonly connector: ConnectorServer) {}

  get ready(): boolean {
    return this.connector.ready;
  }

  get executionId(): string | null {
    return this.connector.connectorId;
  }

  get socketPath(): string {
    return this.connector.socketPath;
  }

  async start(): Promise<void> {
    this.connector.start();
  }

  async stop(): Promise<void> {
    this.connector.stop();
  }

  async dispatch(job: StoredJob): Promise<ExecutionSubmission> {
    return this.connector.sendJob(job) ? "submitted" : "not_sent";
  }

  async cancel(job: StoredJob): Promise<ExecutionSubmission> {
    return this.connector.sendCancel(job) ? "submitted" : "not_sent";
  }

  status(): Record<string, unknown> {
    return {
      kind: this.kind,
      ready: this.ready,
      executionId: this.executionId,
      socketPath: this.socketPath,
    };
  }

  /** Hermes 的 connector v1 durable result ACK；不属于通用 backend 协议。 */
  acknowledgeResult(jobId: string, leaseId: string): void {
    this.connector.acknowledgeResult(jobId, leaseId);
  }

  /** Hermes connector v1 的结构化拒绝；Codex app-server 不使用该方法。 */
  rejectJobMessage(jobId: string, code: string, message: string): void {
    this.connector.rejectJobMessage(jobId, code, message);
  }
}
