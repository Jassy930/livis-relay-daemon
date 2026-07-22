export const CODEX_DISABLED_FEATURES = [
  "plugins",
  "remote_plugin",
  "apps",
  "shell_snapshot",
  "hooks",
  "image_generation",
  "goals",
  "memories",
  "skill_mcp_dependency_install",
  "multi_agent",
  "multi_agent_v2",
  "code_mode_host",
  "terminal_resize_reflow",
  "sqlite",
  "enable_request_compression",
  "tool_search_always_defer_mcp_tools",
  "tool_suggest",
  "in_app_browser",
  "browser_use",
  "browser_use_full_cdp_access",
  "browser_use_external",
  "computer_use",
  "plugin_sharing",
  "resize_all_images",
  "skill_search",
  "mentions_v2",
  "steer",
  "guardian_approval",
  "collaboration_modes",
  "tool_call_mcp_elicitation",
  "auth_elicitation",
  "personality",
  "fast_mode",
  "tui_app_server",
  "remote_compaction_v2",
  "workspace_dependencies",
] as const;

/**
 * Codex 0.145.0 即使收到 `--disable`，仍会把四个 removed feature 回读为 enabled。
 * 它们不是安全承诺，只是精确版本锁定的不可关闭例外；最终工具面仍须另做 canary。
 */
export const CODEX_0145_ALLOWED_ENABLED_FEATURES = new Map<string, string>([
  ["shell_tool", "stable"],
  ["unified_exec", "stable"],
  ["terminal_resize_reflow", "removed"],
  ["tool_search_always_defer_mcp_tools", "removed"],
  ["resize_all_images", "removed"],
  ["tui_app_server", "removed"],
]);

export const CODEX_APP_SERVER_COMMAND = [
  "codex",
  "app-server",
  "--strict-config",
  "--stdio",
  ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
] as const;

export const DEFAULT_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_CODEX_APP_SERVER_STDERR_MAX_BYTES = 64 * 1024;
export const DEFAULT_CODEX_APP_SERVER_STDOUT_LINE_MAX_BYTES = 4 * 1024 * 1024;
export const DEFAULT_CODEX_APP_SERVER_CLOSE_TIMEOUT_MS = 5_000;

const APPROVAL_REJECTION_REASON = "LiViS 远程通道未启用审批控制，已默认拒绝";
const V2_DECISION_APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);
const LEGACY_DECISION_APPROVAL_METHODS = new Set([
  "applyPatchApproval",
  "execCommandApproval",
]);
const KNOWN_SERVER_REQUEST_METHODS = new Set([
  ...V2_DECISION_APPROVAL_METHODS,
  ...LEGACY_DECISION_APPROVAL_METHODS,
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/permissions/requestApproval",
  "item/tool/call",
  "account/chatgptAuthTokens/refresh",
  "attestation/generate",
  "currentTime/read",
]);

export type CodexAppServerRequestId = string | number;

export interface CodexAppServerInput {
  write(chunk: string | Uint8Array): number | Promise<number>;
  flush?(): number | Promise<number>;
  end?(): number | Promise<number>;
}

/** 测试可以注入这一最小进程边界，避免读取真实 Codex 配置或会话。 */
export interface CodexAppServerProcess {
  readonly pid?: number;
  readonly stdin: CodexAppServerInput;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

export interface CodexAppServerSpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** 生产实现必须让 app-server 成为独立 POSIX 进程组 leader。 */
  detached?: boolean;
}

export type CodexAppServerSpawn = (
  command: readonly string[],
  options: CodexAppServerSpawnOptions,
) => CodexAppServerProcess;

export interface CodexProcessGroupController {
  signal(processGroupId: number, signal: number | NodeJS.Signals): void;
  exists(processGroupId: number): boolean;
}

export interface CodexAppServerNotification {
  method: string;
  params?: unknown;
}

export interface CodexAppServerApprovalRequest {
  id: CodexAppServerRequestId;
  method: string;
  params?: unknown;
}

export interface CodexAppServerClientInfo {
  name: string;
  title: string | null;
  version: string;
}

export interface CodexAppServerInitializeCapabilities {
  experimentalApi: boolean;
  requestAttestation: boolean;
  mcpServerOpenaiFormElicitation?: boolean;
  optOutNotificationMethods?: string[] | null;
}

/**
 * app-server 的 environment 不是普通环境变量集合，而是一次执行使用的 runtime
 * workspace 选择。空数组会清空本地 runtime roots，因此本地 daemon 必须显式选择
 * 稳定的 `local` environment。
 */
export interface CodexAppServerEnvironment {
  environmentId: string;
  cwd: string;
  runtimeWorkspaceRoots: readonly string[];
}

export function codexLocalEnvironment(
  workspace: string,
): readonly [CodexAppServerEnvironment] {
  return [{
    environmentId: "local",
    cwd: workspace,
    runtimeWorkspaceRoots: [workspace],
  }];
}

export interface CodexThreadStartParams {
  cwd?: string | null;
  model?: string | null;
  approvalPolicy?: unknown;
  sandbox?: unknown;
  environments?: readonly CodexAppServerEnvironment[] | null;
  ephemeral?: boolean | null;
  [key: string]: unknown;
}

export interface CodexThreadResumeParams {
  threadId: string;
  cwd?: string | null;
  [key: string]: unknown;
}

export interface CodexThreadMemoryModeSetParams {
  threadId: string;
  mode: "enabled" | "disabled";
}

export interface CodexThreadReadParams {
  threadId: string;
  includeTurns?: boolean;
}

export interface CodexTurnStartParams {
  threadId: string;
  input: readonly unknown[];
  cwd?: string | null;
  environments?: readonly CodexAppServerEnvironment[] | null;
  [key: string]: unknown;
}

export interface CodexTurnInterruptParams {
  threadId: string;
  turnId: string;
}

export interface CodexThreadUnsubscribeParams {
  threadId: string;
}

export interface CodexAppServerClientOptions {
  /** 默认使用 CODEX_APP_SERVER_COMMAND；由 backend 负责构造并审计显式 argv。 */
  command?: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  spawn?: CodexAppServerSpawn;
  /** 测试注入；生产默认在 macOS/Linux 使用负 PGID 信号和存活探针。 */
  processGroupController?: CodexProcessGroupController | null;
  requestTimeoutMs?: number;
  stderrMaxBytes?: number;
  stdoutLineMaxBytes?: number;
  closeTimeoutMs?: number;
  clientInfo?: Partial<CodexAppServerClientInfo>;
  capabilities?: Partial<CodexAppServerInitializeCapabilities>;
  onNotification?: (notification: CodexAppServerNotification) => void | Promise<void>;
  onApprovalRequest?: (request: CodexAppServerApprovalRequest) => void | Promise<void>;
}

interface PendingRequest {
  method: string;
  written: boolean;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type ClientState = "running" | "closing" | "exited";

export class CodexAppServerRpcError extends Error {
  constructor(
    readonly method: string,
    readonly requestId: CodexAppServerRequestId,
    readonly code: number | undefined,
    message: string,
    readonly data?: unknown,
  ) {
    super(`Codex app-server ${method} 失败：${message}`);
    this.name = "CodexAppServerRpcError";
  }
}

export class CodexAppServerStartCloseUnconfirmedError extends AggregateError {
  constructor(startError: unknown, closeError: unknown) {
    super(
      [startError, closeError],
      "Codex app-server 初始化失败且进程组收口未确认",
    );
    this.name = "CodexAppServerStartCloseUnconfirmedError";
  }
}

export class CodexAppServerProcessOwnershipUnconfirmedError extends Error {
  constructor(killError?: unknown) {
    super(
      "Codex app-server 已 spawn，但无法取得有效 PID/进程组所有权，关闭未确认",
      killError === undefined ? undefined : { cause: killError },
    );
    this.name = "CodexAppServerProcessOwnershipUnconfirmedError";
  }
}

export class CodexAppServerTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly requestId: CodexAppServerRequestId,
    readonly timeoutMs: number,
    /** false 才能证明请求未写入；true 表示服务端是否执行未知，禁止盲目重发。 */
    readonly written: boolean,
  ) {
    super(`Codex app-server ${method} 请求超时（${timeoutMs} ms）`);
    this.name = "CodexAppServerTimeoutError";
  }
}

export class CodexAppServerRequestTransportError extends Error {
  constructor(
    readonly method: string,
    readonly requestId: CodexAppServerRequestId,
    /** false 才能证明请求未写入；true 表示执行结果不确定。 */
    readonly written: boolean,
    override readonly cause: Error,
  ) {
    super(`Codex app-server ${method} 请求因传输终止：${cause.message}`);
    this.name = "CodexAppServerRequestTransportError";
  }
}

export class CodexAppServerProcessError extends Error {
  constructor(
    readonly exitCode: number,
    stderrText: string,
  ) {
    const suffix = stderrText.trim() ? `：${stderrText.trim()}` : "";
    super(`Codex app-server 已退出（exit ${exitCode}）${suffix}`);
    this.name = "CodexAppServerProcessError";
  }
}

export class CodexAppServerCloseUnconfirmedError extends Error {
  constructor(
    readonly timeoutMs: number,
    override readonly cause?: unknown,
  ) {
    super(`Codex app-server SIGKILL 后仍无法确认进程组与 stdio 收口（${timeoutMs} ms）`);
    this.name = "CodexAppServerCloseUnconfirmedError";
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === code;
}

const POSIX_PROCESS_GROUP_CONTROLLER: CodexProcessGroupController | null =
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

function defaultSpawn(
  command: readonly string[],
  options: CodexAppServerSpawnOptions,
): CodexAppServerProcess {
  return Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }) as unknown as CodexAppServerProcess;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} 必须是正整数`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requestId(value: unknown): CodexAppServerRequestId | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function isApprovalRequestMethod(method: string): boolean {
  return (
    V2_DECISION_APPROVAL_METHODS.has(method) ||
    LEGACY_DECISION_APPROVAL_METHODS.has(method) ||
    method.endsWith("/requestApproval") ||
    method.endsWith("Approval")
  );
}

function isKnownServerRequestMethod(method: string): boolean {
  return KNOWN_SERVER_REQUEST_METHODS.has(method) || isApprovalRequestMethod(method);
}

function rpcErrorDetails(value: unknown): { code?: number; message: string; data?: unknown } {
  if (!isRecord(value)) return { message: String(value) };
  return {
    code: typeof value.code === "number" ? value.code : undefined,
    message: typeof value.message === "string" ? value.message : JSON.stringify(value),
    data: value.data,
  };
}

export class CodexAppServerClient {
  private readonly child: CodexAppServerProcess;
  private readonly processGroupController: CodexProcessGroupController | null;
  private readonly processGroupId: number | null;
  private readonly requestTimeoutMs: number;
  private readonly stderrMaxBytes: number;
  private readonly stdoutLineMaxBytes: number;
  private readonly closeTimeoutMs: number;
  private readonly onNotification?: CodexAppServerClientOptions["onNotification"];
  private readonly onApprovalRequest?: CodexAppServerClientOptions["onApprovalRequest"];
  private readonly pending = new Map<CodexAppServerRequestId, PendingRequest>();
  private readonly stdoutTask: Promise<void>;
  private readonly stderrTask: Promise<void>;
  private writeTail: Promise<void> = Promise.resolve();
  private nextRequestId = 1;
  private state: ClientState = "running";
  private terminalError: Error | null = null;
  private _initializeResult: unknown = null;
  private stderrBytes = new Uint8Array(0);
  private stderrTotalBytes = 0;
  private _exitCode: number | null = null;
  private closePromise: Promise<void> | null = null;

  private constructor(options: CodexAppServerClientOptions) {
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS;
    this.stderrMaxBytes = options.stderrMaxBytes ?? DEFAULT_CODEX_APP_SERVER_STDERR_MAX_BYTES;
    this.stdoutLineMaxBytes =
      options.stdoutLineMaxBytes ?? DEFAULT_CODEX_APP_SERVER_STDOUT_LINE_MAX_BYTES;
    this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CODEX_APP_SERVER_CLOSE_TIMEOUT_MS;
    assertPositiveInteger(this.requestTimeoutMs, "requestTimeoutMs");
    assertPositiveInteger(this.stderrMaxBytes, "stderrMaxBytes");
    assertPositiveInteger(this.stdoutLineMaxBytes, "stdoutLineMaxBytes");
    assertPositiveInteger(this.closeTimeoutMs, "closeTimeoutMs");
    this.onNotification = options.onNotification;
    this.onApprovalRequest = options.onApprovalRequest;

    const spawn = options.spawn ?? defaultSpawn;
    const command = options.command ?? CODEX_APP_SERVER_COMMAND;
    if (command.length === 0 || command.some((part) => typeof part !== "string" || part.length === 0)) {
      throw new Error("Codex app-server command 必须包含非空 argv");
    }
    this.child = spawn(command, { cwd: options.cwd, env: options.env, detached: true });
    this.processGroupController = options.processGroupController === undefined
      ? options.spawn === undefined
        ? POSIX_PROCESS_GROUP_CONTROLLER
        : null
      : options.processGroupController;
    this.processGroupId = this.processGroupController !== null &&
        Number.isSafeInteger(this.child.pid) && (this.child.pid ?? 0) > 0
      ? this.child.pid!
      : null;
    if (this.processGroupController !== null && this.processGroupId === null) {
      let killError: unknown;
      try {
        this.child.kill("SIGKILL");
      } catch (error) {
        killError = error;
        // 构造失败时只能尽力终止直接 child；没有 PID 时不能声明进程组收口。
      }
      throw new CodexAppServerProcessOwnershipUnconfirmedError(killError);
    }
    this.stderrTask = this.collectStderr();
    void this.stderrTask.catch((error: unknown) => {
      this.failTransport(error instanceof Error ? error : new Error(String(error)));
    });
    this.stdoutTask = this.readStdout();
    void this.stdoutTask.catch((error: unknown) => {
      this.failTransport(error instanceof Error ? error : new Error(String(error)));
    });
    void this.child.exited.then(
      (exitCode) => this.handleExit(exitCode),
      (error: unknown) => {
        this.failTransport(error instanceof Error ? error : new Error(String(error)));
      },
    );
  }

  static async start(options: CodexAppServerClientOptions = {}): Promise<CodexAppServerClient> {
    const client = new CodexAppServerClient(options);
    const clientInfo: CodexAppServerClientInfo = {
      name: options.clientInfo?.name ?? "livis-relay-daemon",
      title: options.clientInfo?.title ?? "LiViS Relay Daemon",
      version: options.clientInfo?.version ?? "0.1.0",
    };
    const capabilities: CodexAppServerInitializeCapabilities = {
      experimentalApi: options.capabilities?.experimentalApi ?? false,
      requestAttestation: options.capabilities?.requestAttestation ?? false,
      ...(options.capabilities?.mcpServerOpenaiFormElicitation === undefined
        ? {}
        : { mcpServerOpenaiFormElicitation: options.capabilities.mcpServerOpenaiFormElicitation }),
      ...(options.capabilities?.optOutNotificationMethods === undefined
        ? {}
        : { optOutNotificationMethods: options.capabilities.optOutNotificationMethods }),
    };

    try {
      client._initializeResult = await client.request("initialize", { clientInfo, capabilities });
      await client.notify("initialized");
      return client;
    } catch (error) {
      try {
        await client.close();
      } catch (closeError) {
        throw new CodexAppServerStartCloseUnconfirmedError(error, closeError);
      }
      throw error;
    }
  }

  get exited(): Promise<number> {
    return this.child.exited;
  }

  /** initialize 的原始结果；调用方必须按自己的 runtime 安全边界完成回读校验。 */
  get initializeResult(): unknown {
    return this._initializeResult;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  get pendingRequestCount(): number {
    return this.pending.size;
  }

  /** 供持有方在 ready/recovery 交接前确认 transport 仍然可用。 */
  get running(): boolean {
    return this.state === "running" && this.terminalError === null;
  }

  get stderrText(): string {
    return new TextDecoder().decode(this.stderrBytes);
  }

  get stderrTruncated(): boolean {
    return this.stderrTotalBytes > this.stderrBytes.byteLength;
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
    this.ensureRunning();
    assertPositiveInteger(timeoutMs, "timeoutMs");
    const id = this.nextRequestId++;
    const response = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.reject(new CodexAppServerTimeoutError(method, id, timeoutMs, pending.written));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        written: false,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });

    const message: Record<string, unknown> = { id, method };
    if (params !== undefined) message.params = params;
    void this.writeMessage(message, () => {
      const pending = this.pending.get(id);
      if (!pending) return false;
      // 从调用 stdin.write 前开始就必须视为“可能已写入”。如果 write 的
      // Promise 随后超时或失败，无法证明管道没有接收部分或全部字节。
      pending.written = true;
      return true;
    }).catch((error: unknown) => {
      const cause =
        error instanceof Error ? error : new Error(`Codex app-server 写入失败：${String(error)}`);
      const pending = this.pending.get(id);
      this.rejectPending(
        id,
        new CodexAppServerRequestTransportError(method, id, pending?.written ?? false, cause),
      );
    });
    return response;
  }

  notify(method: string, params?: unknown): Promise<void> {
    this.ensureRunning();
    const message: Record<string, unknown> = { method };
    if (params !== undefined) message.params = params;
    return this.writeMessage(message);
  }

  threadStart<T = unknown>(params: CodexThreadStartParams): Promise<T> {
    return this.request<T>("thread/start", params);
  }

  threadResume<T = unknown>(params: CodexThreadResumeParams): Promise<T> {
    return this.request<T>("thread/resume", params);
  }

  threadMemoryModeSet<T = unknown>(params: CodexThreadMemoryModeSetParams): Promise<T> {
    return this.request<T>("thread/memoryMode/set", params);
  }

  threadRead<T = unknown>(params: CodexThreadReadParams, timeoutMs?: number): Promise<T> {
    return timeoutMs === undefined
      ? this.request<T>("thread/read", params)
      : this.request<T>("thread/read", params, timeoutMs);
  }

  turnStart<T = unknown>(params: CodexTurnStartParams): Promise<T> {
    return this.request<T>("turn/start", params);
  }

  turnInterrupt<T = unknown>(params: CodexTurnInterruptParams): Promise<T> {
    return this.request<T>("turn/interrupt", params);
  }

  threadUnsubscribe<T = unknown>(params: CodexThreadUnsubscribeParams): Promise<T> {
    return this.request<T>("thread/unsubscribe", params);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    if (this.state === "running") {
      this.state = "closing";
      this.rejectAll(new Error("Codex app-server 客户端已关闭"));
      try {
        void this.child.stdin.end?.();
      } catch {
        // 子进程可能已经关闭 stdin；后续 kill/exit observer 会完成收口。
      }
    }
    const gracefulSignalErrors = this.signalProcessTree("SIGTERM");
    try {
      await this.awaitCloseReceipt(this.closeTimeoutMs);
      return;
    } catch (gracefulError) {
      const killSignalErrors = this.signalProcessTree("SIGKILL");
      try {
        await this.awaitCloseReceipt(this.closeTimeoutMs);
        return;
      } catch (killError) {
        throw new CodexAppServerCloseUnconfirmedError(
          this.closeTimeoutMs,
          new AggregateError(
            [...gracefulSignalErrors, gracefulError, ...killSignalErrors, killError],
            "Codex app-server 两阶段关闭未确认",
          ),
        );
      }
    }
  }

  private signalProcessTree(signal: NodeJS.Signals): unknown[] {
    const errors: unknown[] = [];
    if (this.processGroupController && this.processGroupId !== null) {
      try {
        this.processGroupController.signal(this.processGroupId, signal);
        return errors;
      } catch (error) {
        if (isErrnoCode(error, "ESRCH")) return errors;
        errors.push(error);
      }
    }
    try {
      this.child.kill(signal);
    } catch (error) {
      errors.push(error);
    }
    return errors;
  }

  private async awaitCloseReceipt(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const groupGone = async (): Promise<void> => {
      if (!this.processGroupController || this.processGroupId === null) return;
      while (this.processGroupController.exists(this.processGroupId)) {
        if (Date.now() >= deadline) {
          throw new Error(`Codex app-server 进程组关闭超时（${timeoutMs} ms）`);
        }
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
      }
    };
    try {
      await Promise.race([
        Promise.all([
          this.child.exited.catch(() => undefined),
          Promise.allSettled([this.stdoutTask, this.stderrTask]),
          groupGone(),
        ]),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Codex app-server 关闭超时（${timeoutMs} ms）`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private ensureRunning(): void {
    if (this.state !== "running" || this.terminalError) {
      throw this.terminalError ?? new Error("Codex app-server 客户端未运行");
    }
  }

  private writeMessage(
    message: Record<string, unknown>,
    beforeWrite?: () => boolean,
  ): Promise<void> {
    this.ensureRunning();
    const line = `${JSON.stringify(message)}\n`;
    const write = this.writeTail.then(async () => {
      this.ensureRunning();
      // 请求可能在等待前序写入期间已经超时。此时 pending 已删除，必须
      // 跳过这条尚未开始的写入，才能安全报告 written=false。
      if (beforeWrite && !beforeWrite()) return;
      await Promise.resolve(this.child.stdin.write(line));
      if (this.child.stdin.flush) await Promise.resolve(this.child.stdin.flush());
    });
    this.writeTail = write.catch(() => undefined);
    return write;
  }

  private async readStdout(): Promise<void> {
    const reader = this.child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        buffered = await this.consumeCompleteLines(buffered);
        if (Buffer.byteLength(buffered, "utf8") > this.stdoutLineMaxBytes) {
          throw new Error("Codex app-server stdout NDJSON 单行超过上限");
        }
      }
      buffered += decoder.decode();
      if (buffered.trim()) await this.handleLine(buffered.replace(/\r$/, ""));
      if (this.state === "running") {
        throw new Error("Codex app-server stdout 在进程退出前意外关闭");
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async consumeCompleteLines(buffered: string): Promise<string> {
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).replace(/\r$/, "");
      buffered = buffered.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > this.stdoutLineMaxBytes) {
        throw new Error("Codex app-server stdout NDJSON 单行超过上限");
      }
      if (line.trim()) await this.handleLine(line);
      newline = buffered.indexOf("\n");
    }
    return buffered;
  }

  private async handleLine(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("Codex app-server stdout 包含无效 NDJSON");
    }
    if (!isRecord(parsed)) throw new Error("Codex app-server NDJSON 消息必须是对象");

    if (typeof parsed.method === "string") {
      const id = requestId(parsed.id);
      if (id === null) {
        if (isKnownServerRequestMethod(parsed.method)) {
          throw new Error(
            `Codex app-server server request 缺少有效 id，已关闭传输：${parsed.method}`,
          );
        }
        this.dispatchNotification({ method: parsed.method, params: parsed.params });
      } else {
        await this.handleServerRequest({ id, method: parsed.method, params: parsed.params });
      }
      return;
    }

    const id = requestId(parsed.id);
    if (id === null) throw new Error("Codex app-server 响应缺少有效 id 或 method");
    this.handleResponse(id, parsed);
  }

  private handleResponse(
    id: CodexAppServerRequestId,
    message: Record<string, unknown>,
  ): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (hasOwn(message, "error") && message.error !== null && message.error !== undefined) {
      const details = rpcErrorDetails(message.error);
      pending.reject(
        new CodexAppServerRpcError(
          pending.method,
          id,
          details.code,
          details.message,
          details.data,
        ),
      );
      return;
    }
    if (!hasOwn(message, "result")) {
      pending.reject(new Error(`Codex app-server ${pending.method} 响应缺少 result/error`));
      return;
    }
    pending.resolve(message.result);
  }

  private async handleServerRequest(request: CodexAppServerApprovalRequest): Promise<void> {
    if (isApprovalRequestMethod(request.method)) {
      this.dispatchApprovalRequest(request);
      if (V2_DECISION_APPROVAL_METHODS.has(request.method)) {
        await this.writeMessage({ id: request.id, result: { decision: "decline" } });
        return;
      }
      if (LEGACY_DECISION_APPROVAL_METHODS.has(request.method)) {
        await this.writeMessage({
          id: request.id,
          result: { decision: { denied: { rejection: APPROVAL_REJECTION_REASON } } },
        });
        return;
      }
      await this.writeMessage({
        id: request.id,
        error: { code: -32_001, message: APPROVAL_REJECTION_REASON },
      });
      return;
    }

    await this.writeMessage({
      id: request.id,
      error: { code: -32_601, message: `客户端不支持 server request：${request.method}` },
    });
  }

  private dispatchNotification(notification: CodexAppServerNotification): void {
    try {
      void Promise.resolve(this.onNotification?.(notification)).catch(() => undefined);
    } catch {
      // 通知观察回调不能阻塞 stdout 协议泵。
    }
  }

  private dispatchApprovalRequest(request: CodexAppServerApprovalRequest): void {
    try {
      void Promise.resolve(this.onApprovalRequest?.(request)).catch(() => undefined);
    } catch {
      // 审批观察回调失败不能把默认拒绝改成悬挂或接受。
    }
  }

  private async collectStderr(): Promise<void> {
    const reader = this.child.stderr.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.stderrTotalBytes += value.byteLength;
        if (value.byteLength >= this.stderrMaxBytes) {
          this.stderrBytes = value.slice(value.byteLength - this.stderrMaxBytes);
          continue;
        }
        const keepExisting = Math.min(
          this.stderrBytes.byteLength,
          this.stderrMaxBytes - value.byteLength,
        );
        const combined = new Uint8Array(keepExisting + value.byteLength);
        combined.set(this.stderrBytes.slice(this.stderrBytes.byteLength - keepExisting), 0);
        combined.set(value, keepExisting);
        this.stderrBytes = combined;
      }
    } finally {
      reader.releaseLock();
    }
  }

  private rejectPending(id: CodexAppServerRequestId, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private rejectAllForTransport(cause: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(
        new CodexAppServerRequestTransportError(pending.method, id, pending.written, cause),
      );
    }
  }

  private failTransport(error: Error): void {
    if (this.state !== "running") return;
    this.terminalError = error;
    this.rejectAllForTransport(error);
    this.signalProcessTree("SIGTERM");
  }

  private handleExit(exitCode: number): void {
    this._exitCode = exitCode;
    if (this.state === "running") {
      const error = new CodexAppServerProcessError(exitCode, this.stderrText);
      this.terminalError = error;
      this.rejectAllForTransport(error);
    }
    this.state = "exited";
  }
}

export function startCodexAppServerClient(
  options: CodexAppServerClientOptions = {},
): Promise<CodexAppServerClient> {
  return CodexAppServerClient.start(options);
}
