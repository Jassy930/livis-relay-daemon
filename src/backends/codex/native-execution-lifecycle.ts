import {
  codexLocalEnvironment,
  CodexAppServerRequestTransportError,
  CodexAppServerTimeoutError,
  type CodexAppServerNotification,
} from "./app-server-client.ts";
import type {
  ExecutionBackendHandlers,
  ExecutionJobEvent,
  ExecutionSubmission,
} from "../execution-backend.ts";
import type { StoredJob } from "../../types.ts";

/**
 * 只描述一个已经建立的 native proxy 连接；连接、版本、socket 和认证门禁仍由
 * native-daemon attach 层负责。本接口刻意不暴露登录或凭据方法。
 */
export interface CodexNativeExecutionClient {
  readonly running: boolean;
  readonly exited: Promise<number>;
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  close(): Promise<void>;
}

export interface CodexNativeExecutionLifecycleOptions {
  executionId: string;
  threadId: string;
  workspace: string;
  requestTimeoutMs: number;
  turnTimeoutMs: number;
  maxOutputChars: number;
}

export interface CodexNativeExecutionLifecycleDependencies {
  client: CodexNativeExecutionClient;
  handlers: ExecutionBackendHandlers;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

interface CapturedMessage {
  id: string;
  text: string;
  phase: "commentary" | "final_answer" | null;
  sequence: number;
}

interface NativeAttempt {
  job: StoredJob;
  turnId: string | null;
  accepted: Deferred<boolean>;
  cancelRequested: boolean;
  timeoutExpired: boolean;
  interruptPromise: Promise<void> | null;
  terminal: boolean;
  deadline: ReturnType<typeof setTimeout> | null;
  messages: Map<string, CapturedMessage>;
  nextMessageSequence: number;
  messageChars: number;
}

type LifecycleState = "running" | "stopping" | "stopped" | "disconnected";

const MAX_AGENT_MESSAGES = 1_024;
const MAX_AGENT_MESSAGE_ID_CHARS = 512;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} 必须是非空字符串`);
  }
  return value;
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} 必须是正整数`);
}

function requestWasDefinitelyUnwritten(error: unknown): boolean {
  return (
    (error instanceof CodexAppServerTimeoutError ||
      error instanceof CodexAppServerRequestTransportError) &&
    !error.written
  );
}

function notificationThreadId(notification: CodexAppServerNotification): string | null {
  return isRecord(notification.params) && typeof notification.params.threadId === "string"
    ? notification.params.threadId
    : null;
}

function notificationTurnId(notification: CodexAppServerNotification): string | null {
  if (!isRecord(notification.params)) return null;
  if (typeof notification.params.turnId === "string") return notification.params.turnId;
  return isRecord(notification.params.turn) && typeof notification.params.turn.id === "string"
    ? notification.params.turn.id
    : null;
}

function safeFailure(value: unknown): {
  error: string;
  credentialRejected: boolean;
} {
  if (!isRecord(value)) {
    return { error: "Codex turn 执行失败", credentialRejected: false };
  }
  const message = typeof value.message === "string" ? value.message : "";
  if (/\binvalid_api_key\b/i.test(message) || /Incorrect API key provided/i.test(message)) {
    return {
      error: "Codex provider 认证失败（401 invalid_api_key）",
      credentialRejected: true,
    };
  }
  if (value.codexErrorInfo === "unauthorized") {
    return { error: "Codex provider 认证失败", credentialRejected: true };
  }
  if (isRecord(value.codexErrorInfo)) {
    for (const detail of Object.values(value.codexErrorInfo)) {
      if (
        isRecord(detail) && detail.httpStatusCode === 401
      ) {
        return { error: "Codex provider 连接失败（HTTP 401）", credentialRejected: true };
      }
    }
  }
  return { error: "Codex turn 执行失败", credentialRejected: false };
}

function isRelevantNotification(notification: CodexAppServerNotification): boolean {
  return notification.method === "item/completed" ||
    notification.method === "turn/completed" || notification.method === "error";
}

/**
 * native daemon 执行路径的离线生命周期原型。
 *
 * 它只把一个测试或上层已经安全 attach 的 proxy 连接映射成 ExecutionBackend 的提交、
 * accepted、terminal、cancel 和 disconnect 语义；不负责连接真实 Desktop、不声明
 * server config/thread sandbox 已安全，也没有接入 `serve`。
 */
export class CodexNativeExecutionLifecycle {
  readonly kind = "codex" as const;
  readonly executionId: string;

  private readonly client: CodexNativeExecutionClient;
  private readonly handlers: ExecutionBackendHandlers;
  private readonly threadId: string;
  private readonly workspace: string;
  private readonly requestTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly maxOutputChars: number;
  private state: LifecycleState = "running";
  private activeAttempt: NativeAttempt | null = null;
  private notificationTail: Promise<void> = Promise.resolve();
  private disconnectPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(
    options: CodexNativeExecutionLifecycleOptions,
    dependencies: CodexNativeExecutionLifecycleDependencies,
  ) {
    if (options.executionId.trim() === "") throw new Error("executionId 不能为空");
    if (options.threadId.trim() === "") throw new Error("threadId 不能为空");
    if (!options.workspace.startsWith("/")) throw new Error("workspace 必须是绝对路径");
    positiveInteger(options.requestTimeoutMs, "requestTimeoutMs");
    positiveInteger(options.turnTimeoutMs, "turnTimeoutMs");
    positiveInteger(options.maxOutputChars, "maxOutputChars");
    this.executionId = options.executionId;
    this.threadId = options.threadId;
    this.workspace = options.workspace;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.turnTimeoutMs = options.turnTimeoutMs;
    this.maxOutputChars = options.maxOutputChars;
    this.client = dependencies.client;
    this.handlers = dependencies.handlers;

    void this.client.exited.then(
      () => this.disconnect("Codex native proxy 意外退出"),
      () => this.disconnect("Codex native proxy 退出状态不可读"),
    ).catch(() => undefined);
  }

  get ready(): boolean {
    return this.state === "running" && this.client.running;
  }

  status(): Record<string, unknown> {
    return {
      implementation: "codex-native-execution-lifecycle-prototype",
      state: this.state,
      ready: this.ready,
      active: this.activeAttempt !== null,
      productionReady: false,
    };
  }

  handleNotification(notification: CodexAppServerNotification): void {
    if (!isRelevantNotification(notification)) return;
    this.notificationTail = this.notificationTail
      .then(() => this.processNotification(notification))
      .catch((error: unknown) => this.disconnect(
        error instanceof Error
          ? "Codex native proxy 返回未经审核的执行事件"
          : "Codex native proxy 执行事件处理失败",
      ));
  }

  async dispatch(job: StoredJob): Promise<ExecutionSubmission> {
    if (!this.ready || this.activeAttempt !== null) return "not_sent";
    if (
      job.targetBackend !== "codex" || job.leaseId === null ||
      !Number.isSafeInteger(job.runGeneration) || job.runGeneration <= 0
    ) {
      return "not_sent";
    }

    const attempt: NativeAttempt = {
      job,
      turnId: null,
      accepted: deferred<boolean>(),
      cancelRequested: false,
      timeoutExpired: false,
      interruptPromise: null,
      terminal: false,
      deadline: null,
      messages: new Map(),
      nextMessageSequence: 0,
      messageChars: 0,
    };
    this.activeAttempt = attempt;

    let response: unknown;
    try {
      response = await this.client.request("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text: job.text, text_elements: [] }],
        cwd: this.workspace,
        environments: codexLocalEnvironment(this.workspace),
      }, this.requestTimeoutMs);
    } catch (error) {
      if (requestWasDefinitelyUnwritten(error)) {
        attempt.accepted.resolve(false);
        if (this.activeAttempt === attempt) this.activeAttempt = null;
        if (error instanceof CodexAppServerRequestTransportError) {
          await this.disconnect("Codex native proxy 在 turn/start 写入前断开");
        }
        return "not_sent";
      }
      attempt.accepted.resolve(false);
      await this.disconnect("Codex native turn/start 提交状态不确定");
      return "submitted";
    }

    try {
      const envelope = isRecord(response) ? response : null;
      const turn = envelope && isRecord(envelope.turn) ? envelope.turn : null;
      attempt.turnId = nonEmptyString(turn?.id, "turn/start response.turn.id");
      attempt.deadline = setTimeout(() => {
        void this.handleTurnTimeout(attempt).catch(() => undefined);
      }, this.turnTimeoutMs);
      await this.handlers.onAccepted({ ...this.jobEvent(attempt), turnId: attempt.turnId });
      attempt.accepted.resolve(true);
      if (attempt.cancelRequested) await this.interrupt(attempt);
      return "submitted";
    } catch {
      attempt.accepted.resolve(false);
      await this.disconnect("Codex native turn/start 响应或 accepted 持久化失败");
      return "submitted";
    }
  }

  async cancel(job: StoredJob): Promise<ExecutionSubmission> {
    const attempt = this.activeAttempt;
    if (!attempt || attempt.terminal || !this.sameAttempt(attempt, job)) return "not_sent";
    attempt.cancelRequested = true;
    if (attempt.turnId !== null) await this.interrupt(attempt);
    // turn/start 一旦进入 client.request 就可能已经写出；取消不能把原提交降格为 not_sent。
    return "submitted";
  }

  waitForIdle(): Promise<void> {
    return this.notificationTail.then(() => this.disconnectPromise ?? undefined);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    if (this.disconnectPromise) {
      try {
        await this.disconnectPromise;
      } finally {
        this.state = "stopped";
      }
      return;
    }
    if (this.state === "stopped") return;
    this.state = "stopping";
    const attempt = this.activeAttempt;
    let handlerError: unknown;
    if (attempt && !attempt.terminal) {
      this.clearDeadline(attempt);
      attempt.accepted.resolve(false);
      try {
        await this.handlers.onDisconnected({
          kind: "codex",
          executionId: this.executionId,
          reason: "Codex native execution lifecycle 正在停止",
        });
      } catch (error) {
        handlerError = error;
      }
    }
    let closeError: unknown;
    try {
      await this.client.close();
    } catch (error) {
      closeError = error;
    }
    this.state = "stopped";
    this.activeAttempt = null;
    if (handlerError !== undefined || closeError !== undefined) {
      throw new AggregateError(
        [handlerError, closeError].filter((error) => error !== undefined),
        "Codex native lifecycle 停止收口失败",
      );
    }
  }

  private async processNotification(notification: CodexAppServerNotification): Promise<void> {
    const attempt = this.activeAttempt;
    if (!attempt || attempt.terminal || this.state !== "running") return;
    if (notificationThreadId(notification) !== this.threadId) return;
    if (!await attempt.accepted.promise) return;
    if (this.activeAttempt !== attempt || attempt.terminal || this.state !== "running") return;
    if (notificationTurnId(notification) !== attempt.turnId) return;

    if (notification.method === "item/completed") {
      this.captureAgentMessage(attempt, notification.params);
      return;
    }
    if (notification.method === "error") return;
    if (notification.method !== "turn/completed") return;

    const params = isRecord(notification.params) ? notification.params : null;
    const turn = params && isRecord(params.turn) ? params.turn : null;
    const status = nonEmptyString(turn?.status, "turn/completed turn.status");
    if (!turn || !["completed", "failed", "interrupted"].includes(status)) {
      throw new Error("turn/completed status 未经审核");
    }

    if (attempt.timeoutExpired) return;
    if (attempt.cancelRequested) {
      this.finishAttempt(attempt);
      await this.handlers.onCancelled({ ...this.jobEvent(attempt), turnId: attempt.turnId });
      return;
    }
    if (status === "completed") {
      const terminalIds: string[] = [];
      if (Array.isArray(turn.items)) {
        for (const item of turn.items) {
          if (isRecord(item) && item.type === "agentMessage" && typeof item.id === "string") {
            terminalIds.push(item.id);
          }
          this.captureAgentMessage(attempt, { item });
        }
      }
      const text = this.finalText(attempt, terminalIds);
      this.finishAttempt(attempt);
      await this.handlers.onResult({
        ...this.jobEvent(attempt),
        turnId: attempt.turnId!,
        text,
      });
      return;
    }
    if (status === "failed") {
      const failure = safeFailure(turn.error);
      this.finishAttempt(attempt);
      await this.handlers.onFailed({
        ...this.jobEvent(attempt),
        turnId: attempt.turnId!,
        error: failure.error,
        retryable: false,
        ...(failure.credentialRejected
          ? { sessionDisposition: "credential_rejected" as const }
          : {}),
      });
      if (failure.credentialRejected) {
        await this.disconnect("Codex native provider 拒绝当前认证状态");
      }
      return;
    }
    throw new Error("Codex native turn 未经 relay cancel 即被中断");
  }

  private captureAgentMessage(attempt: NativeAttempt, value: unknown): void {
    const params = isRecord(value) ? value : null;
    const item = params && isRecord(params.item) ? params.item : null;
    if (!item || item.type !== "agentMessage") return;
    const id = nonEmptyString(item.id, "agentMessage.id");
    if (id.length > MAX_AGENT_MESSAGE_ID_CHARS) {
      throw new Error("agentMessage.id 超过上限");
    }
    if (typeof item.text !== "string") throw new Error("agentMessage.text 必须是字符串");
    const phase = item.phase === "commentary" || item.phase === "final_answer"
      ? item.phase
      : item.phase === null || item.phase === undefined
        ? null
        : (() => {
            throw new Error("agentMessage.phase 未经审核");
          })();
    const existing = attempt.messages.get(id);
    if (existing) {
      if (existing.text !== item.text || existing.phase !== phase) {
        throw new Error("同一 agentMessage.id 出现冲突内容");
      }
      return;
    }
    if (
      attempt.messages.size >= MAX_AGENT_MESSAGES ||
      attempt.messageChars + id.length + item.text.length > this.maxOutputChars
    ) {
      throw new Error("Codex native agentMessage 超过有界输出预算");
    }
    attempt.messages.set(id, {
      id,
      text: item.text,
      phase,
      sequence: attempt.nextMessageSequence++,
    });
    attempt.messageChars += id.length + item.text.length;
  }

  private finalText(attempt: NativeAttempt, terminalIds: readonly string[]): string {
    const messages = [...attempt.messages.values()].sort((a, b) => a.sequence - b.sequence);
    const terminal = terminalIds.flatMap((id) => {
      const message = attempt.messages.get(id);
      return message ? [message] : [];
    });
    const selected = terminal.filter((message) => message.phase === "final_answer").at(-1) ??
      messages.filter((message) => message.phase === "final_answer").at(-1) ??
      terminal.filter((message) => message.phase === null).at(-1) ??
      messages.filter((message) => message.phase === null).at(-1);
    if (!selected) throw new Error("Codex native turn 缺少唯一 final_answer");
    return selected.text;
  }

  private interrupt(attempt: NativeAttempt): Promise<void> {
    if (attempt.interruptPromise) return attempt.interruptPromise;
    if (attempt.turnId === null) return Promise.resolve();
    attempt.interruptPromise = this.client.request("turn/interrupt", {
      threadId: this.threadId,
      turnId: attempt.turnId,
    }, this.requestTimeoutMs).then(() => undefined).catch(async () => {
      await this.disconnect("Codex native turn/interrupt 结果不确定");
    });
    return attempt.interruptPromise;
  }

  private async handleTurnTimeout(attempt: NativeAttempt): Promise<void> {
    if (this.activeAttempt !== attempt || attempt.terminal || this.state !== "running") return;
    attempt.timeoutExpired = true;
    attempt.cancelRequested = true;
    await this.interrupt(attempt);
    if (this.state === "running") {
      await this.disconnect("Codex native turn 超时，执行结果不确定");
    }
  }

  private disconnect(reason: string): Promise<void> {
    if (this.disconnectPromise) return this.disconnectPromise;
    if (this.state === "disconnected") return Promise.resolve();
    if (this.state === "stopping" || this.state === "stopped") return Promise.resolve();
    this.state = "disconnected";
    const attempt = this.activeAttempt;
    if (attempt) {
      this.clearDeadline(attempt);
      attempt.accepted.resolve(false);
    }
    this.disconnectPromise = (async () => {
      let handlerError: unknown;
      try {
        await this.handlers.onDisconnected({
          kind: "codex",
          executionId: this.executionId,
          reason,
        });
      } catch (error) {
        handlerError = error;
      }
      let closeError: unknown;
      try {
        await this.client.close();
      } catch (error) {
        closeError = error;
      }
      this.activeAttempt = null;
      if (handlerError !== undefined || closeError !== undefined) {
        throw new AggregateError(
          [handlerError, closeError].filter((error) => error !== undefined),
          "Codex native lifecycle 断连收口失败",
        );
      }
    })();
    void this.disconnectPromise.catch(() => undefined);
    return this.disconnectPromise;
  }

  private finishAttempt(attempt: NativeAttempt): void {
    this.clearDeadline(attempt);
    attempt.terminal = true;
    if (this.activeAttempt === attempt) this.activeAttempt = null;
  }

  private clearDeadline(attempt: NativeAttempt): void {
    if (attempt.deadline !== null) clearTimeout(attempt.deadline);
    attempt.deadline = null;
  }

  private sameAttempt(attempt: NativeAttempt, job: StoredJob): boolean {
    return attempt.job.jobId === job.jobId && attempt.job.leaseId === job.leaseId &&
      attempt.job.runGeneration === job.runGeneration;
  }

  private jobEvent(attempt: NativeAttempt): ExecutionJobEvent {
    return {
      kind: "codex",
      executionId: this.executionId,
      jobId: attempt.job.jobId,
      leaseId: attempt.job.leaseId!,
      runGeneration: attempt.job.runGeneration,
    };
  }
}
