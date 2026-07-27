import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantContextConfig } from "../../config.ts";
import {
  assistantContextFailureStatus,
  loadAssistantContextSnapshot,
  materializeAssistantContextSnapshot,
} from "../../context/assistant-context.ts";
import type {
  ExecutionBackend,
  ExecutionBackendHandlers,
  ExecutionSubmission,
} from "../execution-backend.ts";
import type { JobStore } from "../../state/store.ts";
import { requirePrivateDirectory } from "../../state/offline-guard.ts";
import type { StoredBackendSession, StoredJob } from "../../types.ts";
import { durableMkdirPrivate, sha256 } from "../../util.ts";
import {
  assertPinnedClaudeCommand,
  buildClaudeNativeInvocationCommand,
  CLAUDE_NATIVE_SYSTEM_PROMPT,
  consumeClaudeNativeStderr,
  consumeClaudeNativeStream,
  errnoIsMissingProcess,
  prepareClaudeNativeCli,
  type ClaudeNativeCliPreparation,
  type ClaudeNativeStreamResult,
} from "./native-cli.ts";

const CLAUDE_SESSION_CONTRACT_VERSION = "claude-native-stateless-v1";
const CLAUDE_EFFECTIVE_MODEL = "native-current-opaque";
const CLAUDE_MODEL_PROVIDER = "claude-code-native-opaque";
const EMPTY_CHECKPOINT_SHA256 = sha256("[]");
const CLAUDE_SECURITY_CONFIG_SHA256 = sha256(JSON.stringify({
  safeMode: true,
  tools: [],
  mcpServers: [],
  skills: [],
  slashCommands: [],
  permissionMode: "dontAsk",
  sessionPersistence: false,
  spawnEnvironment: "allowlist-v1",
}));
const CLAUDE_FEATURE_SNAPSHOT_SHA256 = sha256(JSON.stringify({
  transport: "cli-stream-json",
  execution: "stateless-per-job",
  final: "single-result",
  accountState: "opaque",
}));

interface ClaudeNativeInput {
  write(chunk: string | Uint8Array): number | Promise<number>;
  flush?(): number | Promise<number>;
  end?(): number | Promise<number>;
}

export interface ClaudeNativeProcess {
  readonly pid?: number;
  readonly stdin: ClaudeNativeInput;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

export interface ClaudeNativeProcessGroupController {
  signal(processGroupId: number, signal: NodeJS.Signals): void;
  exists(processGroupId: number): boolean;
}

export type ClaudeNativeSpawn = (
  command: readonly string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    detached: true;
  },
) => ClaudeNativeProcess;

export interface ClaudeNativeExecutionBackendOptions {
  stateDir: string;
  scopeKey: string;
  sessionKey: string;
  remoteNodeId: string;
  command: string;
  requestTimeoutMs: number;
  turnTimeoutMs: number;
  shutdownTimeoutMs: number;
  maxOutputChars: number;
  maxBudgetUsd: number;
  assistantContext?: AssistantContextConfig | null;
}

export interface ClaudeNativeExecutionBackendDependencies {
  store: JobStore;
  handlers: ExecutionBackendHandlers;
  prepare?: typeof prepareClaudeNativeCli;
  assertCommand?: typeof assertPinnedClaudeCommand;
  spawn?: ClaudeNativeSpawn;
  processGroupController?: ClaudeNativeProcessGroupController | null;
  sourceEnv?: NodeJS.ProcessEnv;
}

interface ClaudeNativeLayout {
  stateDir: string;
  workspace: string;
  runtimeTmpDir: string;
  sessionHash: string;
}

interface ActiveClaudeAttempt {
  job: StoredJob;
  child: ClaudeNativeProcess;
  turnId: string | null;
  accepted: boolean;
  cancelRequested: boolean;
  deadlineReason: string | null;
  terminal: boolean;
  scheduled: ReturnType<typeof setTimeout> | null;
  done: Promise<void>;
  resolveDone: () => void;
  stdoutTask: Promise<ClaudeNativeStreamResult> | null;
  stderrTask: Promise<string> | null;
}

interface PendingClaudeSubmission {
  jobId: string;
  leaseId: string;
  cancelled: boolean;
}

function defaultSpawn(
  command: readonly string[],
  options: { cwd: string; env: Record<string, string>; detached: true },
): ClaudeNativeProcess {
  return Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }) as unknown as ClaudeNativeProcess;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === code;
}

const DEFAULT_PROCESS_GROUP_CONTROLLER: ClaudeNativeProcessGroupController | null =
  process.platform === "darwin" || process.platform === "linux"
    ? {
        signal(processGroupId, signal) {
          process.kill(-processGroupId, signal);
        },
        exists(processGroupId) {
          try {
            process.kill(-processGroupId, 0);
            return true;
          } catch (error) {
            if (isErrnoCode(error, "ESRCH")) return false;
            if (isErrnoCode(error, "EPERM")) return true;
            throw error;
          }
        },
      }
    : null;

function stableSessionHash(scopeKey: string, sessionKey: string, remoteNodeId: string): string {
  return sha256(JSON.stringify({ scopeKey, sessionKey, remoteNodeId, backend: "claude" }));
}

async function ensureClaudeLayout(options: ClaudeNativeExecutionBackendOptions): Promise<ClaudeNativeLayout> {
  const stateDir = await requirePrivateDirectory(options.stateDir, "Claude native stateDir");
  const sessionHash = stableSessionHash(options.scopeKey, options.sessionKey, options.remoteNodeId);
  const sessionDir = join(stateDir, "backends", "claude", "native-sessions", sessionHash);
  const paths = [
    join(stateDir, "backends"),
    join(stateDir, "backends", "claude"),
    join(stateDir, "backends", "claude", "native-sessions"),
    sessionDir,
    join(sessionDir, "workspace"),
    join(sessionDir, "tmp"),
  ];
  for (const path of paths) await durableMkdirPrivate(path);
  const workspace = await realpath(join(sessionDir, "workspace"));
  const runtimeTmpDir = await realpath(join(sessionDir, "tmp"));
  return { stateDir, workspace, runtimeTmpDir, sessionHash };
}

function expectedThreadId(sessionHash: string): string {
  return `claude-stateless:${sessionHash.slice(0, 24)}`;
}

function sessionMatchesAnchor(session: StoredBackendSession, layout: ClaudeNativeLayout): boolean {
  return session.stateOwnership === "local-state-opaque" &&
    session.sessionHash === layout.sessionHash &&
    session.threadId === expectedThreadId(layout.sessionHash) &&
    session.cwd === layout.workspace &&
    session.cliVersion === CLAUDE_SESSION_CONTRACT_VERSION &&
    session.requestedModel === null &&
    session.effectiveModel === CLAUDE_EFFECTIVE_MODEL &&
    session.modelProvider === CLAUDE_MODEL_PROVIDER &&
    session.securityConfigSha256 === CLAUDE_SECURITY_CONFIG_SHA256 &&
    session.featureSnapshotSha256 === CLAUDE_FEATURE_SNAPSHOT_SHA256 &&
    session.checkpointTurnId === null && session.checkpointTurnStatus === null &&
    session.checkpointTurnCount === 0 && session.checkpointTurnsSha256 === EMPTY_CHECKPOINT_SHA256 &&
    !session.recoveryRequired && session.activeJobId === null;
}

function boundedTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}（${timeoutMs} ms）`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Claude Code 原生当前状态的首版生产 adapter。
 *
 * 每个 job 都启动一个无持久会话的安全文本子进程；持久 backend session 只是 JobStore
 * fencing 锚点，不代表 Claude 原生会话，也不保存或解释任何本地账号状态。
 */
export class ClaudeNativeExecutionBackend implements ExecutionBackend {
  readonly kind = "claude" as const;
  private layout: ClaudeNativeLayout | null = null;
  private preparation: ClaudeNativeCliPreparation | null = null;
  private active: ActiveClaudeAttempt | null = null;
  private started = false;
  private stopping = false;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private pendingSubmission: PendingClaudeSubmission | null = null;
  private pendingSubmissionPromise: Promise<ExecutionSubmission> | null = null;
  private currentExecutionId: string | null = null;
  private lastFailure: string | null = null;
  private failed = false;
  private contextGeneration: string | null = null;
  private lastContextFailure: string | null = null;

  constructor(
    private readonly options: ClaudeNativeExecutionBackendOptions,
    private readonly dependencies: ClaudeNativeExecutionBackendDependencies,
  ) {}

  get ready(): boolean {
    return this.started && !this.stopping && !this.failed && this.preparation !== null &&
      this.dependencies.store.getSessionQuarantine(this.options.sessionKey) === null;
  }

  get executionId(): string | null {
    return this.ready ? this.currentExecutionId : null;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.stopPromise) return Promise.reject(new Error("Claude backend 已进入停止流程"));
    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    const layout = await ensureClaudeLayout(this.options);
    if ((this.options.assistantContext ?? null) !== null) {
      await this.syncAssistantContext(layout.workspace);
    }
    const prepare = this.dependencies.prepare ?? prepareClaudeNativeCli;
    const preparation = await prepare({
      command: this.options.command,
      stateDir: layout.stateDir,
      runtimeTmpDir: layout.runtimeTmpDir,
      cwd: layout.workspace,
      requestTimeoutMs: this.options.requestTimeoutMs,
      sourceEnv: this.dependencies.sourceEnv,
    });
    this.ensureSessionAnchor(layout);
    this.layout = layout;
    this.preparation = preparation;
    this.currentExecutionId = `claude-native:${layout.sessionHash.slice(0, 24)}:${crypto.randomUUID()}`;
    this.started = true;
    try {
      await this.dependencies.handlers.onReady({
        kind: "claude",
        executionId: this.currentExecutionId,
        implementation: {
          name: "claude-native-stateless",
          version: preparation.report.cliVersion,
          compatibilityBasis: "capability-probe",
          versionsAreObservational: true,
          stateOwnership: "local-state-opaque",
          sessionPersistence: false,
        },
      });
    } catch (error) {
      this.failed = true;
      this.lastFailure = error instanceof Error ? error.message : "Claude ready 持久化失败";
      throw error;
    }
  }

  private ensureSessionAnchor(layout: ClaudeNativeLayout): void {
    const quarantine = this.dependencies.store.getSessionQuarantine(this.options.sessionKey);
    if (quarantine) throw new Error(`Claude backend session 已隔离：${quarantine.reason}`);
    const existing = this.dependencies.store.getBackendSession("claude", this.options.sessionKey);
    if (existing) {
      if (sessionMatchesAnchor(existing, layout)) return;
      this.dependencies.store.quarantineSession(
        this.options.sessionKey,
        "Claude stateless session anchor 与当前安全契约不一致",
      );
      throw new Error("Claude stateless session anchor 不兼容，已失败关闭并隔离");
    }
    this.dependencies.store.createLocalOpaqueBackendSession({
      backend: "claude",
      sessionKey: this.options.sessionKey,
      sessionHash: layout.sessionHash,
      threadId: expectedThreadId(layout.sessionHash),
      cwd: layout.workspace,
      cliVersion: CLAUDE_SESSION_CONTRACT_VERSION,
      requestedModel: null,
      effectiveModel: CLAUDE_EFFECTIVE_MODEL,
      modelProvider: CLAUDE_MODEL_PROVIDER,
      securityConfigSha256: CLAUDE_SECURITY_CONFIG_SHA256,
      featureSnapshotSha256: CLAUDE_FEATURE_SNAPSHOT_SHA256,
      checkpointTurnId: null,
      checkpointTurnStatus: null,
      checkpointTurnCount: 0,
      checkpointTurnsSha256: EMPTY_CHECKPOINT_SHA256,
      checkpointedAt: Date.now(),
    });
  }

  dispatch(job: StoredJob): Promise<ExecutionSubmission> {
    if (this.pendingSubmission !== null) return Promise.resolve("not_sent");
    const pending: PendingClaudeSubmission = {
      jobId: job.jobId,
      leaseId: job.leaseId ?? "",
      cancelled: false,
    };
    this.pendingSubmission = pending;
    const promise = this.dispatchInternal(job, pending).finally(() => {
      if (this.pendingSubmission === pending) this.pendingSubmission = null;
      if (this.pendingSubmissionPromise === promise) this.pendingSubmissionPromise = null;
    });
    this.pendingSubmissionPromise = promise;
    return promise;
  }

  private async dispatchInternal(
    job: StoredJob,
    pending: PendingClaudeSubmission,
  ): Promise<ExecutionSubmission> {
    const preparation = this.preparation;
    const layout = this.layout;
    if (
      !this.ready || this.active !== null || !preparation || !layout ||
      !job.leaseId || job.runGeneration < 1 || job.targetBackend !== "claude"
    ) {
      return "not_sent";
    }
    try {
      const assertCommand = this.dependencies.assertCommand ?? assertPinnedClaudeCommand;
      await assertCommand(preparation.command);
    } catch (error) {
      this.lastFailure = error instanceof Error ? error.message : "Claude command pin 检查失败";
      return "not_sent";
    }
    if (
      pending.cancelled || !this.ready || this.preparation !== preparation || this.layout !== layout
    ) {
      return "not_sent";
    }
    let contextPrompt: string | null;
    try {
      contextPrompt = await this.syncAssistantContext(layout.workspace);
    } catch (error) {
      const message = assistantContextFailureStatus(error);
      this.lastContextFailure = message;
      this.lastFailure = message;
      return "not_sent";
    }
    if (
      pending.cancelled || !this.ready || this.preparation !== preparation || this.layout !== layout
    ) {
      return "not_sent";
    }
    let child: ClaudeNativeProcess;
    try {
      const spawn = this.dependencies.spawn ?? defaultSpawn;
      child = spawn(
        buildClaudeNativeInvocationCommand(
          preparation.command,
          this.options.maxBudgetUsd,
          contextPrompt === null
            ? undefined
            : `${CLAUDE_NATIVE_SYSTEM_PROMPT}\n\n${contextPrompt}`,
        ),
        {
          cwd: layout.workspace,
          env: preparation.environment,
          detached: true,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Claude 子进程 spawn 失败";
      this.lastFailure = message;
      return "not_sent";
    }
    let resolveDone!: () => void;
    const active: ActiveClaudeAttempt = {
      job,
      child,
      turnId: null,
      accepted: false,
      cancelRequested: false,
      deadlineReason: null,
      terminal: false,
      scheduled: null,
      done: new Promise<void>((resolvePromise) => { resolveDone = resolvePromise; }),
      resolveDone,
      stdoutTask: null,
      stderrTask: null,
    };
    this.active = active;
    // 事件处理必须晚于 dispatch() 的 submitted 回执，防止 accepted/result 抢在
    // daemon 的提交状态语义之前到达。
    active.scheduled = setTimeout(() => {
      active.scheduled = null;
      void this.runAttempt(active)
        .catch((error) => this.failClosed(active, error))
        .catch((error) => {
          this.lastFailure = error instanceof Error ? error.message : "Claude attempt 收口失败";
        })
        .finally(active.resolveDone);
    }, 0);
    return "submitted";
  }

  private async syncAssistantContext(workspace: string): Promise<string | null> {
    const config = this.options.assistantContext ?? null;
    if (config === null) return null;
    const snapshot = await loadAssistantContextSnapshot({
      config,
      stateDir: this.options.stateDir,
    });
    await materializeAssistantContextSnapshot(snapshot, workspace);
    this.contextGeneration = snapshot.generation;
    this.lastContextFailure = null;
    return snapshot.prompt;
  }

  async cancel(job: StoredJob): Promise<ExecutionSubmission> {
    const pending = this.pendingSubmission;
    if (pending && pending.jobId === job.jobId && pending.leaseId === job.leaseId) {
      pending.cancelled = true;
      return "not_sent";
    }
    const active = this.active;
    if (!active || active.job.jobId !== job.jobId || active.job.leaseId !== job.leaseId) {
      return "not_sent";
    }
    active.cancelRequested = true;
    this.signal(active, "SIGTERM");
    return "submitted";
  }

  private async runAttempt(active: ActiveClaudeAttempt): Promise<void> {
    if (this.active !== active) return;
    if (this.stopping) {
      await this.closeProcess(active);
      await this.finishDisconnected(active, "Claude backend 停止时仍有已提交执行");
      return;
    }
    if (active.cancelRequested) {
      await this.closeProcess(active);
      await this.finishCancelled(active);
      return;
    }
    let deadline: ReturnType<typeof setTimeout> | null = null;
    let deadlineReject!: (error: Error) => void;
    const deadlinePromise = new Promise<never>((_resolve, reject) => { deadlineReject = reject; });
    const armDeadline = (timeoutMs: number, reason: string): void => {
      if (deadline) clearTimeout(deadline);
      deadline = setTimeout(() => {
        active.deadlineReason = reason;
        this.signal(active, "SIGTERM");
        deadlineReject(new Error(reason));
      }, timeoutMs);
    };
    armDeadline(this.options.requestTimeoutMs, "Claude system/init 等待超时");
    active.stdoutTask = consumeClaudeNativeStream({
      stream: active.child.stdout,
      maxOutputChars: this.options.maxOutputChars,
      onInit: async (sessionId) => {
        if (active.turnId !== null) throw new Error("Claude attempt 重复绑定 session_id");
        active.turnId = sessionId;
        await this.dependencies.handlers.onAccepted({
          kind: "claude",
          executionId: this.requireExecutionId(),
          jobId: active.job.jobId,
          leaseId: active.job.leaseId!,
          runGeneration: active.job.runGeneration,
          turnId: sessionId,
        });
        active.accepted = true;
        armDeadline(this.options.turnTimeoutMs, "Claude terminal result 等待超时");
      },
    });
    active.stderrTask = consumeClaudeNativeStderr(active.child.stderr);
    try {
      const sendInput = async (): Promise<void> => {
        await Promise.resolve(active.child.stdin.write(active.job.text));
        if (active.child.stdin.flush) await Promise.resolve(active.child.stdin.flush());
        if (active.child.stdin.end) await Promise.resolve(active.child.stdin.end());
      };
      await Promise.race([sendInput(), deadlinePromise]);
      const [result, _stderr, exitCode] = await Promise.race([
        Promise.all([active.stdoutTask, active.stderrTask, active.child.exited]),
        deadlinePromise,
      ]);
      if (deadline) clearTimeout(deadline);
      await this.confirmProcessClosed(active);
      if (active.cancelRequested) {
        await this.finishCancelled(active);
        return;
      }
      if (exitCode !== 0) {
        await this.finishDisconnected(active, `Claude CLI 非零退出（exit ${exitCode}）`);
        return;
      }
      if (!active.accepted || active.turnId === null) {
        await this.finishDisconnected(active, "Claude terminal result 未绑定有效 system/init");
        return;
      }
      if (result.success) {
        await this.finishResult(active, result.text!);
      } else {
        await this.finishFailed(active, `Claude Code terminal failure (${result.terminalSubtype})`);
      }
    } catch (error) {
      if (deadline) clearTimeout(deadline);
      if (active.terminal) throw error;
      try {
        await this.closeProcess(active);
      } catch (closeError) {
        this.lastFailure = closeError instanceof Error ? closeError.message : "Claude 进程组收口失败";
      }
      if (active.cancelRequested) {
        await this.finishCancelled(active);
      } else {
        const reason = active.deadlineReason ??
          (error instanceof Error ? error.message : "Claude stream-json 执行异常");
        await this.finishDisconnected(active, reason);
      }
    }
  }

  private requireExecutionId(): string {
    if (!this.currentExecutionId) throw new Error("Claude executionId 尚未建立");
    return this.currentExecutionId;
  }

  private processGroupController(): ClaudeNativeProcessGroupController | null {
    return this.dependencies.processGroupController === undefined
      ? DEFAULT_PROCESS_GROUP_CONTROLLER
      : this.dependencies.processGroupController;
  }

  private signal(active: ActiveClaudeAttempt, signal: NodeJS.Signals): void {
    const controller = this.processGroupController();
    if (controller && active.child.pid && active.child.pid > 0) {
      try {
        controller.signal(active.child.pid, signal);
        return;
      } catch (error) {
        if (errnoIsMissingProcess(error)) return;
      }
    }
    try {
      active.child.kill(signal);
    } catch (error) {
      if (!errnoIsMissingProcess(error)) {
        this.lastFailure = error instanceof Error ? error.message : "Claude signal 发送失败";
      }
    }
  }

  private async waitForGroupGone(active: ActiveClaudeAttempt): Promise<void> {
    const controller = this.processGroupController();
    if (!controller || !active.child.pid || active.child.pid <= 0) return;
    const wait = async (): Promise<void> => {
      while (controller.exists(active.child.pid!)) {
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
      }
    };
    await boundedTimeout(wait(), this.options.shutdownTimeoutMs, "Claude 进程组未收口");
  }

  private async confirmProcessClosed(active: ActiveClaudeAttempt): Promise<void> {
    await this.waitForGroupGone(active);
  }

  private async closeProcess(active: ActiveClaudeAttempt): Promise<void> {
    let closeError: unknown = null;
    this.signal(active, "SIGTERM");
    try {
      await boundedTimeout(active.child.exited, this.options.shutdownTimeoutMs, "Claude SIGTERM 收口超时");
      await this.waitForGroupGone(active);
    } catch (gracefulError) {
      this.signal(active, "SIGKILL");
      try {
        await boundedTimeout(active.child.exited, this.options.shutdownTimeoutMs, "Claude SIGKILL 收口超时");
        await this.waitForGroupGone(active);
      } catch (killError) {
        closeError = new AggregateError(
          [gracefulError, killError],
          "Claude 独立进程组两阶段收口未确认",
        );
      }
    }
    const ioTasks: Promise<unknown>[] = [
      active.stdoutTask ?? Promise.resolve(),
      active.stderrTask ?? Promise.resolve(),
    ];
    try {
      if (active.child.stdin.end) {
        ioTasks.push(Promise.resolve(active.child.stdin.end()));
      }
    } catch {
      // stdin 可能已经关闭。
    }
    let drainError: unknown = null;
    try {
      await boundedTimeout(
        Promise.allSettled(ioTasks).then(() => undefined),
        this.options.shutdownTimeoutMs,
        "Claude stdio 收口超时",
      );
    } catch (error) {
      drainError = error;
    }
    if (closeError !== null && drainError !== null) {
      throw new AggregateError([closeError, drainError], "Claude 进程组与 stdio 均未确认收口");
    }
    if (closeError !== null) throw closeError;
    if (drainError !== null) throw drainError;
  }

  private async failClosed(active: ActiveClaudeAttempt, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : "Claude attempt 未知异常";
    this.failed = true;
    this.lastFailure = reason;
    const failures: unknown[] = [];
    try {
      await this.closeProcess(active);
    } catch (closeError) {
      failures.push(closeError);
    }
    if (this.active === active) {
      active.terminal = true;
      try {
        await this.dependencies.handlers.onDisconnected({
          kind: "claude",
          executionId: this.requireExecutionId(),
          reason: `Claude attempt 失败关闭：${reason}`,
        });
      } catch (persistenceError) {
        failures.push(persistenceError);
      } finally {
        if (this.active === active) this.active = null;
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `Claude fail-closed 未完整收口：${reason}`);
    }
  }

  private beginTerminal(active: ActiveClaudeAttempt): boolean {
    if (active.terminal || this.active !== active) return false;
    active.terminal = true;
    return true;
  }

  private completeTerminal(active: ActiveClaudeAttempt): void {
    if (this.active === active) this.active = null;
  }

  private async finishResult(active: ActiveClaudeAttempt, text: string): Promise<void> {
    if (!this.beginTerminal(active)) return;
    await this.dependencies.handlers.onResult({
      kind: "claude",
      executionId: this.requireExecutionId(),
      jobId: active.job.jobId,
      leaseId: active.job.leaseId!,
      runGeneration: active.job.runGeneration,
      turnId: active.turnId!,
      text,
    });
    this.completeTerminal(active);
  }

  private async finishFailed(active: ActiveClaudeAttempt, error: string): Promise<void> {
    if (!this.beginTerminal(active)) return;
    await this.dependencies.handlers.onFailed({
      kind: "claude",
      executionId: this.requireExecutionId(),
      jobId: active.job.jobId,
      leaseId: active.job.leaseId!,
      runGeneration: active.job.runGeneration,
      turnId: active.turnId!,
      error,
      retryable: false,
    });
    this.completeTerminal(active);
  }

  private async finishCancelled(active: ActiveClaudeAttempt): Promise<void> {
    if (!this.beginTerminal(active)) return;
    this.failed = true;
    await this.dependencies.handlers.onCancelled({
      kind: "claude",
      executionId: this.requireExecutionId(),
      jobId: active.job.jobId,
      leaseId: active.job.leaseId!,
      runGeneration: active.job.runGeneration,
      turnId: active.turnId,
    });
    this.completeTerminal(active);
  }

  private async finishDisconnected(active: ActiveClaudeAttempt, reason: string): Promise<void> {
    if (!this.beginTerminal(active)) return;
    this.failed = true;
    await this.dependencies.handlers.onDisconnected({
      kind: "claude",
      executionId: this.requireExecutionId(),
      reason,
    });
    this.completeTerminal(active);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      this.stopping = true;
      await this.startPromise?.catch(() => undefined);
      await this.pendingSubmissionPromise?.catch(() => undefined);
      const active = this.active;
      if (active) {
        this.signal(active, "SIGTERM");
        if (active.scheduled) {
          clearTimeout(active.scheduled);
          active.scheduled = null;
          void this.runAttempt(active)
            .catch((error) => this.failClosed(active, error))
            .catch((error) => {
              this.lastFailure = error instanceof Error ? error.message : "Claude stop 收口失败";
            })
            .finally(active.resolveDone);
        }
        await active.done;
      }
      if (this.active === active) this.active = null;
      this.started = false;
      this.preparation = null;
      this.currentExecutionId = null;
    })();
    return this.stopPromise;
  }

  status(): Record<string, unknown> {
    return {
      kind: this.kind,
      mode: "native-current",
      implementation: "claude-native-stateless",
      ready: this.ready,
      executionId: this.executionId,
      transport: "cli-stream-json",
      compatibilityBasis: "capability-probe",
      cliVersion: this.preparation?.report.cliVersion ?? null,
      versionsAreObservational: true,
      stateOwnership: "local-state-opaque",
      sessionPersistence: false,
      safeMode: true,
      activeJobId: this.active?.job.jobId ?? null,
      credentialStateInspected: false,
      assistantContext: {
        enabled: (this.options.assistantContext ?? null) !== null,
        mode: this.options.assistantContext?.mode ?? null,
        generation: this.contextGeneration,
        lastFailure: this.lastContextFailure,
      },
      lastFailure: this.lastFailure,
      failed: this.failed,
      experimental: true,
    };
  }
}

export const CLAUDE_NATIVE_TEST_CONSTANTS = {
  sessionContractVersion: CLAUDE_SESSION_CONTRACT_VERSION,
  effectiveModel: CLAUDE_EFFECTIVE_MODEL,
  modelProvider: CLAUDE_MODEL_PROVIDER,
  securityConfigSha256: CLAUDE_SECURITY_CONFIG_SHA256,
  featureSnapshotSha256: CLAUDE_FEATURE_SNAPSHOT_SHA256,
  emptyCheckpointSha256: EMPTY_CHECKPOINT_SHA256,
} as const;
