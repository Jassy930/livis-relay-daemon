import { isAbsolute } from "node:path";
import type { Logger } from "../../logger.ts";
import { errorMessage } from "../../logger.ts";
import {
  CODEX_MAXIMUM_EXCLUSIVE_VERSION,
  CODEX_MINIMUM_VERSION,
} from "../../config.ts";
import type { JobStore } from "../../state/store.ts";
import type { StoredJob } from "../../types.ts";
import {
  parseSemverTriplet,
  versionAtLeast,
  versionLessThan,
} from "../../util.ts";
import type {
  ExecutionBackend,
  ExecutionBackendHandlers,
  ExecutionSubmission,
} from "../execution-backend.ts";
import {
  CODEX_APP_SERVER_COMMAND,
  CodexAppServerClient,
  CodexAppServerRequestTransportError,
  CodexAppServerTimeoutError,
  type CodexAppServerNotification,
  type CodexAppServerSpawn,
} from "./app-server-client.ts";
import {
  assertCodexRuntimeLayout,
  buildCodexEnvironment,
  CODEX_REMOTE_PERMISSION_PROFILE,
  ensureCodexRuntimeLayout,
  resolveCodexCommand,
  type CodexRuntimeLayout,
} from "./runtime-layout.ts";

const CODEX_BACKEND_KIND = "codex" as const;
const VERSION_OUTPUT_MAX_BYTES = 64 * 1024;
const CODEX_NOTIFICATION_BACKLOG_MAX_COUNT = 256;
const CODEX_NOTIFICATION_BACKLOG_MAX_BYTES = 8 * 1024 * 1024;
const CODEX_AGENT_MESSAGE_MAX_COUNT = 1_024;
const CODEX_AGENT_MESSAGE_ID_MAX_CHARS = 256;
const CODEX_AGENT_MESSAGE_HARD_MAX_CHARS = 4 * 1024 * 1024;

export interface CodexExecutionBackendOptions {
  stateDir: string;
  scopeKey: string;
  sessionKey: string;
  /** 唯一获授权的远端设备节点；参与 sessionHash，禁止换设备复用旧 thread。 */
  remoteNodeId: string;
  command: string;
  model: string | null;
  maxOutputChars: number;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
}

export interface CodexCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CodexCommandRunner = (
  command: readonly string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
  },
) => Promise<CodexCommandResult>;

export interface CodexExecutionBackendDependencies {
  store: JobStore;
  handlers: ExecutionBackendHandlers;
  logger?: Logger;
  /** 仅供测试注入 fake app-server；生产不得替换为 shell command。 */
  appServerSpawn?: CodexAppServerSpawn;
  /** 仅供测试注入版本探针；生产使用无 shell 的 argv spawn。 */
  commandRunner?: CodexCommandRunner;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

interface AgentMessage {
  id: string;
  text: string;
  phase: "commentary" | "final_answer" | null;
  sequence: number;
}

interface ActiveAttempt {
  jobId: string;
  leaseId: string;
  runGeneration: number;
  turnId: string | null;
  turnReady: Deferred<string>;
  bufferedNotifications: AdmittedNotification[];
  pendingNotificationCount: number;
  pendingNotificationBytes: number;
  messages: Map<string, AgentMessage>;
  agentMessageChars: number;
  nextMessageSequence: number;
  cancelRequested: boolean;
  cancelReported: boolean;
  terminal: boolean;
  submissionAmbiguous: boolean;
}

interface AdmittedNotification {
  notification: CodexAppServerNotification;
  bytes: number;
}

type BackendState = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed";

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // cancel 可能永远不会等待 turnReady；先安装 observer，避免失败路径产生
  // unhandled rejection，同时仍允许显式 await 得到同一个 rejection。
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} 必须是对象`);
  return value;
}

function requestWasDefinitelyUnwritten(error: unknown): boolean {
  return (
    (error instanceof CodexAppServerTimeoutError ||
      error instanceof CodexAppServerRequestTransportError) &&
    !error.written
  );
}

async function boundedStreamText(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let keptBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (keptBytes >= maxBytes) continue;
      const remaining = maxBytes - keptBytes;
      const kept = value.byteLength <= remaining ? value : value.slice(0, remaining);
      chunks.push(kept);
      keptBytes += kept.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(keptBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export const runCodexCommand: CodexCommandRunner = async (command, options) => {
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill(9);
    } catch {
      // 进程可能刚好退出；exited 会完成最终收口。
    }
  }, options.timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      boundedStreamText(child.stdout, VERSION_OUTPUT_MAX_BYTES),
      boundedStreamText(child.stderr, VERSION_OUTPUT_MAX_BYTES),
      child.exited,
    ]);
    if (timedOut) throw new Error(`Codex CLI 版本探针超时（${options.timeoutMs} ms）`);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
};

function parseSupportedVersion(result: CodexCommandResult): string {
  if (result.exitCode !== 0) {
    throw new Error(`Codex CLI 版本探针失败（exit ${result.exitCode}）`);
  }
  const parsed = parseSemverTriplet(`${result.stdout}\n${result.stderr}`);
  const minimum = parseSemverTriplet(CODEX_MINIMUM_VERSION)!;
  const maximum = parseSemverTriplet(CODEX_MAXIMUM_EXCLUSIVE_VERSION)!;
  if (!parsed || !versionAtLeast(parsed, minimum) || !versionLessThan(parsed, maximum)) {
    throw new Error(
      `Codex CLI 版本不在已审核窗口 [${CODEX_MINIMUM_VERSION}, ${CODEX_MAXIMUM_EXCLUSIVE_VERSION})`,
    );
  }
  return parsed.join(".");
}

function validateAccountResponse(value: unknown): string {
  const response = requireRecord(value, "account/read response");
  if (typeof response.requiresOpenaiAuth !== "boolean") {
    throw new Error("account/read response.requiresOpenaiAuth 必须是布尔值");
  }
  const account = requireRecord(response.account, "Codex 私有 CODEX_HOME account");
  const accountType = nonEmptyString(account.type, "Codex account.type");
  if (!["apiKey", "chatgpt", "amazonBedrock"].includes(accountType)) {
    throw new Error(`Codex account.type 未经审核：${accountType}`);
  }
  return accountType;
}

function validatePermissionProfiles(value: unknown): void {
  const response = requireRecord(value, "permissionProfile/list response");
  if (!Array.isArray(response.data)) {
    throw new Error("permissionProfile/list response.data 必须是数组");
  }
  const profile = response.data.find(
    (candidate) => isRecord(candidate) && candidate.id === CODEX_REMOTE_PERMISSION_PROFILE,
  );
  if (!profile || profile.allowed !== true) {
    throw new Error(`Codex permission profile ${CODEX_REMOTE_PERMISSION_PROFILE} 不存在或不可用`);
  }
}

function validateThreadResponse(
  value: unknown,
  layout: CodexRuntimeLayout,
  expectedThreadId: string | null,
): string {
  const response = requireRecord(value, "Codex thread response");
  const thread = requireRecord(response.thread, "Codex thread response.thread");
  const threadId = nonEmptyString(thread.id, "Codex thread.id");
  if (expectedThreadId !== null && threadId !== expectedThreadId) {
    throw new Error("Codex thread/resume 返回了不同 threadId");
  }
  if (response.cwd !== layout.workspace || thread.cwd !== layout.workspace) {
    throw new Error("Codex thread cwd 回读未固定到 daemon workspace");
  }
  if (
    !Array.isArray(response.runtimeWorkspaceRoots) ||
    response.runtimeWorkspaceRoots.length !== 1 ||
    response.runtimeWorkspaceRoots[0] !== layout.workspace
  ) {
    throw new Error("Codex runtimeWorkspaceRoots 回读与 daemon workspace 不一致");
  }
  if (response.approvalPolicy !== "never") {
    throw new Error("Codex approvalPolicy 回读不是 never");
  }
  if (response.approvalsReviewer !== "user") {
    throw new Error("Codex approvalsReviewer 回读不是 user");
  }
  const activeProfile = requireRecord(
    response.activePermissionProfile,
    "Codex activePermissionProfile",
  );
  if (activeProfile.id !== CODEX_REMOTE_PERMISSION_PROFILE) {
    throw new Error("Codex active permission profile 回读不一致");
  }
  if (activeProfile.extends !== null) {
    throw new Error("Codex active permission profile 不应继承其他 profile");
  }
  const sandbox = requireRecord(response.sandbox, "Codex sandbox 回读");
  if (
    sandbox.type !== "workspaceWrite" ||
    sandbox.networkAccess !== false ||
    sandbox.excludeTmpdirEnvVar !== true ||
    sandbox.excludeSlashTmp !== true
  ) {
    throw new Error("Codex sandbox 回读未满足 workspace-only、无网络和隔离临时目录边界");
  }
  if (!Array.isArray(sandbox.writableRoots)) {
    throw new Error("Codex sandbox.writableRoots 回读必须是数组");
  }
  if (sandbox.writableRoots.length !== 0) {
    throw new Error("Codex sandbox 回读不应包含 runtime workspace 之外的额外 writable root");
  }
  return threadId;
}

function buildAppServerCommand(command: string): readonly string[] {
  return [command, ...CODEX_APP_SERVER_COMMAND.slice(1)];
}

function relevantNotification(notification: CodexAppServerNotification): boolean {
  return (
    notification.method === "item/completed" ||
    notification.method === "turn/completed" ||
    notification.method === "error"
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
  if (isRecord(notification.params.turn) && typeof notification.params.turn.id === "string") {
    return notification.params.turn.id;
  }
  return null;
}

/**
 * daemon 内部的 Codex app-server 执行后端。
 *
 * JobStore/lease/outbox 仍由 daemon 持有。本类只管理固定的 Codex 私有目录、
 * thread/turn RPC、执行侧事件归属和 fail-closed 断连；绝不自动重发 turn/start。
 */
export class CodexExecutionBackend implements ExecutionBackend {
  readonly kind = CODEX_BACKEND_KIND;

  private readonly store: JobStore;
  private readonly handlers: ExecutionBackendHandlers;
  private readonly logger?: Logger;
  private readonly appServerSpawn?: CodexAppServerSpawn;
  private readonly commandRunner: CodexCommandRunner;
  private state: BackendState = "idle";
  private layout: CodexRuntimeLayout | null = null;
  private client: CodexAppServerClient | null = null;
  private cliVersion: string | null = null;
  private accountType: string | null = null;
  private threadId: string | null = null;
  private _executionId: string | null = null;
  private activeAttempt: ActiveAttempt | null = null;
  private eventTail: Promise<void> = Promise.resolve();
  private disconnectPromise: Promise<void> | null = null;
  private suppressProcessDisconnect = false;
  private readonly agentMessageMaxChars: number;

  constructor(
    private readonly options: CodexExecutionBackendOptions,
    dependencies: CodexExecutionBackendDependencies,
  ) {
    if (!options.command.trim()) throw new Error("Codex command 不能为空");
    if (!isAbsolute(options.command)) throw new Error("Codex command 必须是绝对路径");
    if (!options.remoteNodeId.trim()) throw new Error("Codex remoteNodeId 不能为空");
    if (!Number.isSafeInteger(options.maxOutputChars) || options.maxOutputChars <= 0) {
      throw new Error("Codex maxOutputChars 必须是正整数");
    }
    if (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0) {
      throw new Error("Codex requestTimeoutMs 必须是正整数");
    }
    if (!Number.isSafeInteger(options.shutdownTimeoutMs) || options.shutdownTimeoutMs <= 0) {
      throw new Error("Codex shutdownTimeoutMs 必须是正整数");
    }
    this.store = dependencies.store;
    this.handlers = dependencies.handlers;
    this.logger = dependencies.logger;
    this.appServerSpawn = dependencies.appServerSpawn;
    this.commandRunner = dependencies.commandRunner ?? runCodexCommand;
    this.agentMessageMaxChars = Math.min(
      CODEX_AGENT_MESSAGE_HARD_MAX_CHARS,
      options.maxOutputChars * 4,
    );
  }

  get ready(): boolean {
    return this.state === "running" && this.client !== null && this.disconnectPromise === null;
  }

  get executionId(): string | null {
    return this._executionId;
  }

  async start(): Promise<void> {
    if (this.state !== "idle") throw new Error(`Codex backend 不能从 ${this.state} 状态启动`);
    this.state = "starting";
    let client: CodexAppServerClient | null = null;
    try {
      const layout = await ensureCodexRuntimeLayout({
        stateDir: this.options.stateDir,
        scopeKey: this.options.scopeKey,
        sessionKey: this.options.sessionKey,
        remoteNodeId: this.options.remoteNodeId,
      });
      await assertCodexRuntimeLayout(layout);
      const environment = await buildCodexEnvironment(layout);
      const command = this.appServerSpawn === undefined && this.commandRunner === runCodexCommand
        ? await resolveCodexCommand(layout, this.options.command)
        : this.options.command;
      const versionResult = await this.commandRunner([command, "--version"], {
        cwd: layout.workspace,
        env: environment,
        timeoutMs: this.options.requestTimeoutMs,
      });
      const cliVersion = parseSupportedVersion(versionResult);
      const storedSession = this.store.ensureBackendSession({
        backend: this.kind,
        sessionKey: this.options.sessionKey,
        sessionHash: layout.sessionHash,
        cwd: layout.workspace,
        cliVersion,
      });
      if (storedSession.recoveryRequired || storedSession.activeJobId !== null) {
        throw new Error("Codex backend session 存在未人工释放的恢复证据，拒绝启动");
      }
      const quarantine = this.store.getSessionQuarantine(this.options.sessionKey);
      if (quarantine) {
        throw new Error(`Codex backend session 仍在 quarantine：${quarantine.reason}`);
      }

      client = await CodexAppServerClient.start({
        command: buildAppServerCommand(command),
        cwd: layout.workspace,
        env: environment,
        spawn: this.appServerSpawn,
        requestTimeoutMs: this.options.requestTimeoutMs,
        closeTimeoutMs: this.options.shutdownTimeoutMs,
        capabilities: { experimentalApi: true, requestAttestation: false },
        onNotification: (notification) => this.receiveNotification(notification),
        onApprovalRequest: (request) => {
          this.logger?.warn("Codex app-server 审批请求已默认拒绝", { method: request.method });
        },
      });
      this.client = client;
      void client.exited.then(
        (exitCode) => this.onProcessExit(exitCode),
        (error: unknown) => this.onProcessExit(null, error),
      );

      const accountType = validateAccountResponse(
        await client.request("account/read", { refreshToken: false }),
      );
      validatePermissionProfiles(
        await client.request("permissionProfile/list", { cwd: layout.workspace }),
      );
      await assertCodexRuntimeLayout(layout);

      const commonThreadParams = {
        cwd: layout.workspace,
        runtimeWorkspaceRoots: [layout.workspace],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        permissions: CODEX_REMOTE_PERMISSION_PROFILE,
        ...(this.options.model === null ? {} : { model: this.options.model }),
      } as const;
      let threadResponse: unknown;
      try {
        if (storedSession.threadId === null) {
          threadResponse = await client.threadStart({
            ...commonThreadParams,
            environments: [],
            ephemeral: false,
          });
        } else {
          threadResponse = await client.threadResume({
            threadId: storedSession.threadId,
            ...commonThreadParams,
          });
        }
      } catch (error) {
        if (
          (error instanceof CodexAppServerTimeoutError ||
            error instanceof CodexAppServerRequestTransportError) &&
          error.written
        ) {
          this.store.quarantineSession(
            this.options.sessionKey,
            `Codex ${error.method} 结果不确定，禁止自动创建或恢复替代 thread`,
          );
        }
        throw error;
      }
      let threadId: string;
      try {
        threadId = validateThreadResponse(
          threadResponse,
          layout,
          storedSession.threadId,
        );
        this.store.bindBackendThread(this.kind, this.options.sessionKey, threadId);
      } catch (error) {
        this.store.quarantineSession(
          this.options.sessionKey,
          `Codex thread 已返回但安全回读或 SQLite bind 失败：${errorMessage(error)}`,
        );
        throw error;
      }
      await assertCodexRuntimeLayout(layout);

      this.layout = layout;
      this.cliVersion = cliVersion;
      this.accountType = accountType;
      this.threadId = threadId;
      this._executionId = `codex:${threadId}`;
      this.state = "running";
      try {
        await this.handlers.onReady({
          kind: this.kind,
          executionId: this._executionId,
          implementation: {
            name: "codex-app-server",
            version: cliVersion,
            accountType,
            permissionProfile: CODEX_REMOTE_PERMISSION_PROFILE,
          },
        });
      } catch (error) {
        await this.failClosed(`Codex ready handler 失败：${errorMessage(error)}`);
        throw error;
      }
      if (!this.ready) {
        throw new Error("Codex backend 在 ready handler 期间失效");
      }
      this.logger?.info("Codex app-server backend 已就绪", {
        executionId: this._executionId,
        cliVersion,
      });
    } catch (error) {
      this.state = "failed";
      this.suppressProcessDisconnect = true;
      this.client = null;
      if (client) await client.close().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    if (this.state === "stopping") {
      await this.eventTail;
      return;
    }
    const hadActiveAttempt = this.activeAttempt !== null && !this.activeAttempt.terminal;
    this.state = "stopping";
    if (hadActiveAttempt) {
      await this.failClosed("daemon 停止时 Codex turn 仍处于活动状态");
    } else {
      this.suppressProcessDisconnect = true;
    }
    await this.eventTail.catch(() => undefined);
    const client = this.client;
    this.client = null;
    if (client) await client.close();
    this.state = "stopped";
  }

  async dispatch(job: StoredJob): Promise<ExecutionSubmission> {
    if (!this.ready || !this.client || !this.layout || !this.threadId || !this._executionId) {
      return "not_sent";
    }
    if (
      this.activeAttempt !== null ||
      job.status !== "Dispatching" ||
      !job.leaseId ||
      job.connectorId !== this._executionId ||
      job.sessionKey !== this.options.sessionKey
    ) {
      return "not_sent";
    }
    const storedSession = this.store.getBackendSession(this.kind, this.options.sessionKey);
    if (
      !storedSession ||
      storedSession.threadId !== this.threadId ||
      storedSession.activeJobId !== job.jobId ||
      storedSession.activeLeaseId !== job.leaseId ||
      storedSession.activeRunGeneration !== job.runGeneration ||
      storedSession.activeTurnId !== null ||
      storedSession.recoveryRequired
    ) {
      return "not_sent";
    }

    const attempt: ActiveAttempt = {
      jobId: job.jobId,
      leaseId: job.leaseId,
      runGeneration: job.runGeneration,
      turnId: null,
      turnReady: deferred<string>(),
      bufferedNotifications: [],
      pendingNotificationCount: 0,
      pendingNotificationBytes: 0,
      messages: new Map(),
      agentMessageChars: 0,
      nextMessageSequence: 0,
      cancelRequested: false,
      cancelReported: false,
      terminal: false,
      submissionAmbiguous: false,
    };
    this.activeAttempt = attempt;

    try {
      await assertCodexRuntimeLayout(this.layout);
    } catch (error) {
      attempt.turnReady.reject(error);
      this.activeAttempt = null;
      await this.disableBeforeSubmission(`Codex runtime 安全边界校验失败：${errorMessage(error)}`);
      return "not_sent";
    }

    let response: unknown;
    try {
      response = await this.client.turnStart({
        threadId: this.threadId,
        input: [{ type: "text", text: job.text, text_elements: [] }],
        environments: [],
        cwd: this.layout.workspace,
        runtimeWorkspaceRoots: [this.layout.workspace],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        permissions: CODEX_REMOTE_PERMISSION_PROFILE,
        model: this.options.model,
      });
    } catch (error) {
      if (requestWasDefinitelyUnwritten(error)) {
        attempt.turnReady.reject(error);
        this.activeAttempt = null;
        await this.disableBeforeSubmission(
          `Codex turn/start 未写入且 transport 已不可继续：${errorMessage(error)}`,
        );
        return "not_sent";
      }
      attempt.submissionAmbiguous = true;
      attempt.turnReady.reject(error);
      await this.failClosed(`Codex turn/start 提交结果不确定：${errorMessage(error)}`);
      return "submitted";
    }

    let turnId: string;
    try {
      const turn = requireRecord(requireRecord(response, "turn/start response").turn, "turn");
      turnId = nonEmptyString(turn.id, "turn/start response.turn.id");
    } catch (error) {
      attempt.submissionAmbiguous = true;
      attempt.turnReady.reject(error);
      await this.failClosed(`Codex turn/start 响应无法绑定 turn：${errorMessage(error)}`);
      return "submitted";
    }

    attempt.turnId = turnId;
    attempt.turnReady.resolve(turnId);
    const accepted = this.enqueueEvent(async () => {
      await this.handlers.onAccepted(this.jobEvent(attempt));
    });
    const buffered = attempt.bufferedNotifications.splice(0);
    for (const notification of buffered) this.enqueueNotification(attempt, notification);
    try {
      await accepted;
    } catch {
      return "submitted";
    }
    return "submitted";
  }

  async cancel(job: StoredJob): Promise<ExecutionSubmission> {
    const attempt = this.activeAttempt;
    if (
      !attempt ||
      attempt.terminal ||
      job.jobId !== attempt.jobId ||
      job.leaseId !== attempt.leaseId ||
      job.runGeneration !== attempt.runGeneration
    ) {
      return "not_sent";
    }
    attempt.cancelRequested = true;
    let turnId: string;
    try {
      turnId = attempt.turnId ?? await attempt.turnReady.promise;
    } catch {
      return attempt.submissionAmbiguous ? "submitted" : "not_sent";
    }
    if (attempt.terminal) return "submitted";
    if (!this.ready || !this.client || !this.layout || !this.threadId) {
      await this.failClosed("Codex turn 已启动但 cancel 时 backend 不可用");
      return "submitted";
    }
    try {
      await assertCodexRuntimeLayout(this.layout);
    } catch (error) {
      await this.failClosed(`cancel 前 Codex runtime 安全边界校验失败：${errorMessage(error)}`);
      return "submitted";
    }
    try {
      await this.client.turnInterrupt({ threadId: this.threadId, turnId });
      try {
        await this.enqueueEvent(async () => {
          await this.reportCancellation(attempt);
        });
      } catch {
        // enqueueEvent 已 fail-closed；interrupt 已写入，禁止回报 not_sent。
      }
      return "submitted";
    } catch (error) {
      if (attempt.cancelReported) return "submitted";
      if (requestWasDefinitelyUnwritten(error)) {
        // 这里只能证明 interrupt 没有离开 daemon，不能撤销已经取得 turnId 的
        // 原 turn。仍须按活动执行不确定性断连、隔离，禁止落成 Cancelled。
        await this.failClosed(
          `Codex turn/interrupt 未写入，但原 turn 已提交：${errorMessage(error)}`,
        );
        return "submitted";
      }
      await this.failClosed(`Codex turn/interrupt 结果不确定：${errorMessage(error)}`);
      return "submitted";
    }
  }

  status(): Record<string, unknown> {
    return {
      kind: this.kind,
      ready: this.ready,
      executionId: this.executionId,
      cliVersion: this.cliVersion,
      threadId: this.threadId,
      permissionProfile: CODEX_REMOTE_PERMISSION_PROFILE,
      workspace: this.layout?.workspace ?? null,
      active: this.activeAttempt
        ? {
            jobId: this.activeAttempt.jobId,
            runGeneration: this.activeAttempt.runGeneration,
            turnId: this.activeAttempt.turnId,
            cancelRequested: this.activeAttempt.cancelRequested,
          }
        : null,
    };
  }

  private jobEvent(attempt: ActiveAttempt): {
    kind: "codex";
    executionId: string;
    jobId: string;
    leaseId: string;
    runGeneration: number;
    turnId: string;
  } {
    if (!this._executionId || !attempt.turnId) {
      throw new Error("Codex attempt 尚未绑定 executionId/turnId");
    }
    return {
      kind: this.kind,
      executionId: this._executionId,
      jobId: attempt.jobId,
      leaseId: attempt.leaseId,
      runGeneration: attempt.runGeneration,
      turnId: attempt.turnId,
    };
  }

  private receiveNotification(notification: CodexAppServerNotification): void {
    if (!relevantNotification(notification)) return;
    const attempt = this.activeAttempt;
    if (!attempt || attempt.terminal || notificationThreadId(notification) !== this.threadId) return;
    const admitted = this.admitNotification(attempt, notification);
    if (!admitted) return;
    if (attempt.turnId === null) {
      attempt.bufferedNotifications.push(admitted);
      return;
    }
    this.enqueueNotification(attempt, admitted);
  }

  private enqueueNotification(attempt: ActiveAttempt, admitted: AdmittedNotification): void {
    void this.enqueueEvent(async () => {
      await this.processNotification(admitted.notification);
    }).finally(() => {
      this.releaseNotification(attempt, admitted);
    }).catch(() => undefined);
  }

  private admitNotification(
    attempt: ActiveAttempt,
    notification: CodexAppServerNotification,
  ): AdmittedNotification | null {
    const bytes = Buffer.byteLength(JSON.stringify(notification), "utf8");
    if (
      attempt.pendingNotificationCount + 1 > CODEX_NOTIFICATION_BACKLOG_MAX_COUNT ||
      attempt.pendingNotificationBytes + bytes > CODEX_NOTIFICATION_BACKLOG_MAX_BYTES
    ) {
      void this.failClosed("Codex notification backlog 超过有界 admission，已隔离 active attempt")
        .catch((error) => {
          this.logger?.error("Codex notification backlog 隔离失败", {
            error: errorMessage(error),
          });
        });
      return null;
    }
    attempt.pendingNotificationCount += 1;
    attempt.pendingNotificationBytes += bytes;
    return { notification, bytes };
  }

  private releaseNotification(attempt: ActiveAttempt, admitted: AdmittedNotification): void {
    attempt.pendingNotificationCount = Math.max(0, attempt.pendingNotificationCount - 1);
    attempt.pendingNotificationBytes = Math.max(0, attempt.pendingNotificationBytes - admitted.bytes);
  }

  private async processNotification(notification: CodexAppServerNotification): Promise<void> {
    const attempt = this.activeAttempt;
    if (!attempt || attempt.terminal || !attempt.turnId) return;
    if (
      notificationThreadId(notification) !== this.threadId ||
      notificationTurnId(notification) !== attempt.turnId
    ) {
      return;
    }
    if (this.layout) await assertCodexRuntimeLayout(this.layout);

    if (notification.method === "item/completed") {
      this.captureAgentMessage(attempt, notification.params);
      return;
    }
    if (notification.method === "error") {
      // error 通知可能伴随 willRetry；只有 turn/completed 才是 terminal 真源。
      return;
    }
    if (notification.method !== "turn/completed") return;

    const params = requireRecord(notification.params, "turn/completed params");
    const turn = requireRecord(params.turn, "turn/completed turn");
    const status = nonEmptyString(turn.status, "turn/completed turn.status");
    if (status === "inProgress") {
      throw new Error("turn/completed 携带了非 terminal inProgress 状态");
    }
    if (attempt.cancelRequested) {
      await this.reportCancellation(attempt);
      return;
    }
    attempt.terminal = true;
    if (status === "completed") {
      const terminalAgentMessageIds: string[] = [];
      if (Array.isArray(turn.items)) {
        for (const item of turn.items) {
          if (isRecord(item) && item.type === "agentMessage" && typeof item.id === "string") {
            terminalAgentMessageIds.push(item.id);
          }
          this.captureAgentMessage(attempt, { item });
        }
      }
      const text = this.finalText(attempt, terminalAgentMessageIds);
      await this.handlers.onResult({ ...this.jobEvent(attempt), text });
      this.activeAttempt = null;
      return;
    }
    if (status === "failed") {
      const turnError = isRecord(turn.error) ? turn.error : null;
      const failure =
        turnError && typeof turnError.message === "string" && turnError.message.trim()
          ? turnError.message
          : "Codex turn 执行失败";
      await this.handlers.onFailed({ ...this.jobEvent(attempt), error: failure, retryable: false });
      this.activeAttempt = null;
      return;
    }
    if (status === "interrupted") {
      throw new Error("Codex turn 未经本 daemon cancel 即被中断");
    }
    throw new Error(`Codex turn/completed 返回未知状态：${status}`);
  }

  private captureAgentMessage(attempt: ActiveAttempt, value: unknown): void {
    const params = requireRecord(value, "item/completed params");
    const item = requireRecord(params.item, "item/completed item");
    if (item.type !== "agentMessage") return;
    const id = nonEmptyString(item.id, "agentMessage.id");
    if (id.length > CODEX_AGENT_MESSAGE_ID_MAX_CHARS) {
      throw new Error("agentMessage.id 超过有界长度");
    }
    const text = typeof item.text === "string" ? item.text : null;
    if (text === null) throw new Error("agentMessage.text 必须是字符串");
    const phase = item.phase === "commentary" || item.phase === "final_answer"
      ? item.phase
      : item.phase === null || item.phase === undefined
        ? null
        : (() => {
            throw new Error("agentMessage.phase 未经审核");
          })();
    const existing = attempt.messages.get(id);
    if (existing) {
      if (existing.text !== text || existing.phase !== phase) {
        throw new Error("同一 agentMessage.id 收到冲突内容");
      }
      return;
    }
    if (
      attempt.messages.size + 1 > CODEX_AGENT_MESSAGE_MAX_COUNT ||
      attempt.agentMessageChars + id.length + text.length > this.agentMessageMaxChars
    ) {
      throw new Error("Codex agentMessage 累计内容超过有界 attempt 上限");
    }
    attempt.messages.set(id, {
      id,
      text,
      phase,
      sequence: attempt.nextMessageSequence++,
    });
    attempt.agentMessageChars += id.length + text.length;
  }

  private finalText(attempt: ActiveAttempt, terminalAgentMessageIds: readonly string[]): string {
    const messages = [...attempt.messages.values()].sort((left, right) => left.sequence - right.sequence);
    const terminalMessages = terminalAgentMessageIds.flatMap((id) => {
      const message = attempt.messages.get(id);
      return message ? [message] : [];
    });
    const terminalFinal = terminalMessages
      .filter((message) => message.phase === "final_answer")
      .at(-1);
    const observedFinal = messages.filter((message) => message.phase === "final_answer").at(-1);
    const terminalLegacy = terminalMessages.filter((message) => message.phase === null).at(-1);
    const observedLegacy = messages.filter((message) => message.phase === null).at(-1);
    const selected = terminalFinal ?? observedFinal ?? terminalLegacy ?? observedLegacy;
    if (!selected) {
      throw new Error("Codex turn completed 但没有 final_answer 或兼容期 phase=null agentMessage");
    }
    return selected.text;
  }

  private async reportCancellation(attempt: ActiveAttempt): Promise<void> {
    if (attempt.cancelReported) return;
    attempt.cancelReported = true;
    attempt.terminal = true;
    await this.handlers.onCancelled(this.jobEvent(attempt));
    if (this.activeAttempt === attempt) this.activeAttempt = null;
    await this.disableAfterTerminal();
  }

  private enqueueEvent(operation: () => Promise<void>): Promise<void> {
    const run = this.eventTail.then(async () => {
      if (this.disconnectPromise) return;
      try {
        await operation();
      } catch (error) {
        await this.failClosed(`Codex 事件处理失败：${errorMessage(error)}`);
        throw error;
      }
    });
    this.eventTail = run.catch(() => undefined);
    return run;
  }

  private failClosed(reason: string): Promise<void> {
    if (this.disconnectPromise) return this.disconnectPromise;
    this.state = this.state === "stopping" ? "stopping" : "failed";
    const executionId = this._executionId ?? `codex:${this.options.sessionKey}`;
    this.disconnectPromise = (async () => {
      try {
        await this.handlers.onDisconnected({ kind: this.kind, executionId, reason });
      } finally {
        this.suppressProcessDisconnect = true;
        const client = this.client;
        this.client = null;
        if (client) await client.close().catch(() => undefined);
      }
    })();
    return this.disconnectPromise;
  }

  private async disableBeforeSubmission(reason: string): Promise<void> {
    this.logger?.error("Codex backend 在请求写入前失效", { reason });
    this.state = "failed";
    this.suppressProcessDisconnect = true;
    const client = this.client;
    this.client = null;
    if (client) await client.close().catch(() => undefined);
  }

  private async disableAfterTerminal(): Promise<void> {
    this.state = "failed";
    this.suppressProcessDisconnect = true;
    const client = this.client;
    this.client = null;
    if (client) await client.close().catch(() => undefined);
  }

  private onProcessExit(exitCode: number | null, cause?: unknown): void {
    if (this.suppressProcessDisconnect || this.state === "stopped") return;
    const detail = cause ? errorMessage(cause) : `exit ${exitCode ?? "unknown"}`;
    void this.failClosed(`Codex app-server 意外退出（${detail}）`).catch((error) => {
      this.logger?.error("Codex app-server 断连持久化失败", { error: errorMessage(error) });
    });
  }
}
