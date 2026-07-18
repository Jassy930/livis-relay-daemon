import type { Logger } from "../logger.ts";
import { errorMessage } from "../logger.ts";
import type { JobStore } from "../state/store.ts";
import type { StoredOutbox } from "../types.ts";

export interface OutboxPumpDependencies {
  store: JobStore;
  timing: {
    resultAckTimeoutMs: number;
    resultMaxRetries: number;
  };
  isConnected(): boolean;
  deliver(outbox: StoredOutbox, messageId: string): void;
  logger: Logger;
}

// 结果投递完全由 outbox 的持久化状态驱动：Pending 启动投递、Delivering 超
// 时重试或 AckFailed。连接建立、新结果入库、收到 ACK 都只是 kick() 一下，
// 不再为每个 job 维护内存定时器，消除定时器与 DB 状态不同步的整类问题。
export class OutboxPump {
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: OutboxPumpDependencies) {}

  kick(): void {
    try {
      this.run();
    } catch (error) {
      this.deps.logger.error("outbox pump 运行失败", { error: errorMessage(error) });
    }
  }

  stop(): void {
    this.clearWake();
  }

  private run(): void {
    this.clearWake();
    if (!this.deps.isConnected()) {
      return;
    }
    const now = Date.now();
    for (const outbox of this.deps.store.listDeliveringOutbox()) {
      if (outbox.updatedAt + this.deps.timing.resultAckTimeoutMs > now) {
        continue;
      }
      if (outbox.retryCount >= this.deps.timing.resultMaxRetries) {
        this.deps.store.markOutboxAckFailed(outbox.jobId);
        this.deps.logger.error("LiViS 结果 ACK 重试耗尽", {
          jobId: outbox.jobId,
          retries: outbox.retryCount,
        });
        continue;
      }
      if (!this.startDelivery(outbox.jobId, true)) {
        return;
      }
    }
    for (const outbox of this.deps.store.listPendingOutbox()) {
      if (!this.startDelivery(outbox.jobId, false)) {
        return;
      }
    }
    this.scheduleWake();
  }

  private startDelivery(jobId: string, retry: boolean): boolean {
    const messageId = crypto.randomUUID();
    const started = this.deps.store.startResultDelivery(jobId, messageId, retry);
    if (!started) {
      return true;
    }
    try {
      this.deps.deliver(started, messageId);
      return true;
    } catch (error) {
      this.deps.store.resetOutboxPending(jobId);
      this.deps.logger.warn("结果投递失败，回退 Pending", { jobId, error: errorMessage(error) });
      return false;
    }
  }

  private scheduleWake(): void {
    let earliestDeadline: number | null = null;
    for (const outbox of this.deps.store.listDeliveringOutbox()) {
      const deadline = outbox.updatedAt + this.deps.timing.resultAckTimeoutMs;
      earliestDeadline = earliestDeadline === null ? deadline : Math.min(earliestDeadline, deadline);
    }
    if (earliestDeadline === null) {
      return;
    }
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.kick();
    }, Math.max(1, earliestDeadline - Date.now()));
    this.wakeTimer.unref?.();
  }

  private clearWake(): void {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
  }
}
