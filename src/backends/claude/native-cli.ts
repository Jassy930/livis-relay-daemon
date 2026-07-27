import { realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, relative, resolve, sep } from "node:path";

export const CLAUDE_NATIVE_SYSTEM_PROMPT =
  "你通过 LiViS Relay 接收单次纯文本请求。只返回对用户有用的最终文本；不得调用工具、MCP、技能、浏览器、插件、Hook 或斜杠命令。";

export const CLAUDE_NATIVE_REQUIRED_FLAGS = [
  "--print",
  "--input-format",
  "--output-format",
  "--verbose",
  "--safe-mode",
  "--no-chrome",
  "--disable-slash-commands",
  "--strict-mcp-config",
  "--mcp-config",
  "--tools",
  "--permission-mode",
  "--no-session-persistence",
  "--prompt-suggestions",
  "--max-budget-usd",
  "--system-prompt",
] as const;

const OBSERVATION_MAX_BYTES = 256 * 1024;
const STDERR_MAX_BYTES = 64 * 1024;
const ENVIRONMENT_KEYS = ["LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "NO_COLOR"] as const;

export interface PinnedClaudeCommand {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface ClaudeNativeCliProbeReport {
  ok: true;
  readiness: "ready";
  transport: "cli-stream-json";
  compatibilityBasis: "capability-probe";
  cliVersion: string;
  versionsAreObservational: true;
  requiredFlags: readonly string[];
  sentModelTurn: false;
  credentialStateInspected: false;
}

export interface ClaudeNativeCliPreparation {
  command: PinnedClaudeCommand;
  environment: Record<string, string>;
  report: ClaudeNativeCliProbeReport;
}

export interface ClaudeNativeCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ClaudeNativeCommandRunner = (
  command: readonly string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
  },
) => Promise<ClaudeNativeCommandResult>;

export interface ClaudeNativeStreamResult {
  sessionId: string;
  success: boolean;
  text: string | null;
  terminalSubtype: string;
}

export class ClaudeNativeCliError extends Error {
  constructor(
    readonly code:
      | "native_command_invalid"
      | "native_capability_probe_failed"
      | "native_capability_incompatible"
      | "native_stream_incompatible"
      | "native_output_exceeded",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ClaudeNativeCliError";
  }
}

function isWithin(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === code;
}

async function boundedStreamText(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (kept >= maxBytes) continue;
      const remaining = maxBytes - kept;
      const selected = value.byteLength <= remaining ? value : value.slice(0, remaining);
      chunks.push(selected);
      kept += selected.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(kept);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export const runClaudeNativeCommand: ClaudeNativeCommandRunner = async (command, options) => {
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
      child.kill("SIGKILL");
    } catch {
      // exited 会完成最终收口。
    }
  }, options.timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      boundedStreamText(child.stdout, OBSERVATION_MAX_BYTES),
      boundedStreamText(child.stderr, OBSERVATION_MAX_BYTES),
      child.exited,
    ]);
    if (timedOut) {
      throw new ClaudeNativeCliError(
        "native_capability_probe_failed",
        `Claude CLI 能力探针超时（${options.timeoutMs} ms）`,
      );
    }
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timeout);
  }
};

export async function pinClaudeCommand(
  command: string,
  stateDir: string,
): Promise<PinnedClaudeCommand> {
  if (!isAbsolute(command)) {
    throw new ClaudeNativeCliError("native_command_invalid", "Claude command 必须是绝对路径");
  }
  const canonicalStateDir = await realpath(stateDir);
  let path: string;
  try {
    path = await realpath(command);
  } catch (error) {
    throw new ClaudeNativeCliError("native_command_invalid", "Claude command 不存在或无法解析", {
      cause: error,
    });
  }
  if (isWithin(canonicalStateDir, path)) {
    throw new ClaudeNativeCliError(
      "native_command_invalid",
      "Claude command 不能位于 Relay stateDir 内",
    );
  }
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o111) === 0) {
    throw new ClaudeNativeCliError(
      "native_command_invalid",
      "Claude command 必须是可执行普通文件",
    );
  }
  return { path, size: info.size, mtimeMs: info.mtimeMs };
}

export async function assertPinnedClaudeCommand(command: PinnedClaudeCommand): Promise<void> {
  const canonical = await realpath(command.path);
  const info = await stat(canonical);
  if (
    canonical !== command.path || !info.isFile() || (info.mode & 0o111) === 0 ||
    info.size !== command.size || info.mtimeMs !== command.mtimeMs
  ) {
    throw new ClaudeNativeCliError(
      "native_command_invalid",
      "Claude command 在能力探针后发生漂移",
    );
  }
}

async function sanitizedPath(value: string | undefined, stateDir: string): Promise<string | null> {
  const entries: string[] = [];
  for (const entry of (value ?? "").split(delimiter)) {
    if (!isAbsolute(entry)) continue;
    try {
      const canonical = await realpath(entry);
      const info = await stat(canonical);
      if (!info.isDirectory() || isWithin(stateDir, canonical) || entries.includes(canonical)) continue;
      entries.push(canonical);
    } catch {
      // 不存在或不可解析的 PATH 段不会透传。
    }
  }
  return entries.length === 0 ? null : entries.join(delimiter);
}

/**
 * 从空环境开始构造 Claude 子进程环境。HOME 只是把当前本地 runtime 选择交给 Claude 自己；
 * Relay 不读取其内容，也不会透传 daemon 进程中的任意未审核变量。
 */
export async function buildClaudeNativeEnvironment(options: {
  stateDir: string;
  runtimeTmpDir: string;
  source?: NodeJS.ProcessEnv;
}): Promise<Record<string, string>> {
  const source = options.source ?? process.env;
  const stateDir = await realpath(options.stateDir);
  const runtimeTmpDir = await realpath(options.runtimeTmpDir);
  if (!isWithin(stateDir, runtimeTmpDir)) {
    throw new ClaudeNativeCliError(
      "native_command_invalid",
      "Claude runtime TMPDIR 必须位于 Relay stateDir 内",
    );
  }
  if (source.HOME === undefined || !isAbsolute(source.HOME)) {
    throw new ClaudeNativeCliError(
      "native_command_invalid",
      "Claude native-current 需要绝对 HOME runtime 选择器",
    );
  }
  const home = await realpath(source.HOME);
  const homeInfo = await stat(home);
  if (!homeInfo.isDirectory() || isWithin(stateDir, home)) {
    throw new ClaudeNativeCliError(
      "native_command_invalid",
      "Claude native-current HOME 必须是 stateDir 外的真实目录",
    );
  }
  const environment: Record<string, string> = { HOME: home, TMPDIR: runtimeTmpDir };
  const safePath = await sanitizedPath(source.PATH, stateDir);
  if (safePath !== null) environment.PATH = safePath;
  for (const key of ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function observedVersion(stdout: string, stderr: string): string {
  const line = `${stdout}\n${stderr}`.split(/\r?\n/u).map((item) => item.trim()).find(Boolean);
  if (!line || line.length > 128) {
    throw new ClaudeNativeCliError(
      "native_capability_incompatible",
      "Claude CLI 版本观察值为空或超出边界",
    );
  }
  return line;
}

export async function prepareClaudeNativeCli(options: {
  command: string;
  stateDir: string;
  runtimeTmpDir: string;
  cwd: string;
  requestTimeoutMs: number;
  sourceEnv?: NodeJS.ProcessEnv;
  commandRunner?: ClaudeNativeCommandRunner;
}): Promise<ClaudeNativeCliPreparation> {
  const command = await pinClaudeCommand(options.command, options.stateDir);
  const environment = await buildClaudeNativeEnvironment({
    stateDir: options.stateDir,
    runtimeTmpDir: options.runtimeTmpDir,
    source: options.sourceEnv,
  });
  const runner = options.commandRunner ?? runClaudeNativeCommand;
  const version = await runner([command.path, "--version"], {
    cwd: options.cwd,
    env: environment,
    timeoutMs: options.requestTimeoutMs,
  });
  const help = await runner([command.path, "--help"], {
    cwd: options.cwd,
    env: environment,
    timeoutMs: options.requestTimeoutMs,
  });
  if (version.exitCode !== 0 || help.exitCode !== 0) {
    throw new ClaudeNativeCliError(
      "native_capability_probe_failed",
      "Claude CLI version/help 能力探针失败",
    );
  }
  const helpText = `${help.stdout}\n${help.stderr}`;
  const missing = CLAUDE_NATIVE_REQUIRED_FLAGS.filter((flag) => !helpText.includes(flag));
  if (missing.length > 0) {
    throw new ClaudeNativeCliError(
      "native_capability_incompatible",
      `Claude CLI 缺少安全执行所需参数：${missing.join(", ")}`,
    );
  }
  await assertPinnedClaudeCommand(command);
  return {
    command,
    environment,
    report: {
      ok: true,
      readiness: "ready",
      transport: "cli-stream-json",
      compatibilityBasis: "capability-probe",
      cliVersion: observedVersion(version.stdout, version.stderr),
      versionsAreObservational: true,
      requiredFlags: [...CLAUDE_NATIVE_REQUIRED_FLAGS],
      sentModelTurn: false,
      credentialStateInspected: false,
    },
  };
}

export function buildClaudeNativeInvocationCommand(
  command: PinnedClaudeCommand,
  maxBudgetUsd: number,
): readonly string[] {
  if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) {
    throw new Error("Claude maxBudgetUsd 必须是正数");
  }
  return [
    command.path,
    "--print",
    "--input-format",
    "text",
    "--output-format",
    "stream-json",
    "--verbose",
    "--safe-mode",
    "--no-chrome",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    "--prompt-suggestions",
    "false",
    "--max-budget-usd",
    String(maxBudgetUsd),
    "--system-prompt",
    CLAUDE_NATIVE_SYSTEM_PROMPT,
  ];
}

function safeInitSessionId(record: Record<string, unknown>): string {
  const sessionId = record.session_id;
  const emptyArray = (value: unknown): boolean => Array.isArray(value) && value.length === 0;
  const optionalEmptyArray = (value: unknown): boolean => value === undefined || emptyArray(value);
  if (
    typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 128 ||
    !emptyArray(record.tools) || !emptyArray(record.mcp_servers) || !emptyArray(record.skills) ||
    !emptyArray(record.slash_commands) || !optionalEmptyArray(record.plugins) ||
    !optionalEmptyArray(record.agents) || record.permissionMode !== "dontAsk"
  ) {
    throw new ClaudeNativeCliError(
      "native_stream_incompatible",
      "Claude system/init 未证明禁用工具、MCP、技能、插件、子代理和斜杠命令",
    );
  }
  return sessionId;
}

function assertNoExecutionEvent(record: Record<string, unknown>): void {
  if (record.type === "user" || record.type === "tool") {
    throw new ClaudeNativeCliError(
      "native_stream_incompatible",
      "Claude safe-mode stream 出现了工具结果或用户回注事件",
    );
  }
  if (record.type !== "assistant") return;
  const message = record.message;
  if (!isRecord(message)) {
    throw new ClaudeNativeCliError(
      "native_stream_incompatible",
      "Claude assistant 事件缺少有效 message",
    );
  }
  if (message.stop_reason === "tool_use") {
    throw new ClaudeNativeCliError(
      "native_stream_incompatible",
      "Claude safe-mode assistant 试图进入 tool_use",
    );
  }
  if (!Array.isArray(message.content)) {
    throw new ClaudeNativeCliError(
      "native_stream_incompatible",
      "Claude assistant 事件缺少有界 content 数组",
    );
  }
  for (const block of message.content) {
    if (!isRecord(block) || typeof block.type !== "string") {
      throw new ClaudeNativeCliError(
        "native_stream_incompatible",
        "Claude assistant content 结构无效",
      );
    }
    if (
      block.type === "tool_use" || block.type === "server_tool_use" ||
      block.type === "tool_result" || block.type === "mcp_tool_use"
    ) {
      throw new ClaudeNativeCliError(
        "native_stream_incompatible",
        `Claude safe-mode stream 出现了 ${block.type} block`,
      );
    }
  }
}

export async function consumeClaudeNativeStream(options: {
  stream: ReadableStream<Uint8Array>;
  maxOutputChars: number;
  onInit: (sessionId: string) => Promise<void>;
}): Promise<ClaudeNativeStreamResult> {
  const maxBytes = Math.max(1_048_576, options.maxOutputChars * 4 + 512 * 1024);
  const reader = options.stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let totalBytes = 0;
  let sessionId: string | null = null;
  let terminal: ClaudeNativeStreamResult | null = null;

  const consumeLine = async (line: string): Promise<void> => {
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new ClaudeNativeCliError(
        "native_stream_incompatible",
        "Claude stream-json 包含无效 JSON 行",
        { cause: error },
      );
    }
    if (!isRecord(value) || typeof value.type !== "string") {
      throw new ClaudeNativeCliError(
        "native_stream_incompatible",
        "Claude stream-json 事件结构无效",
      );
    }
    if (value.type === "system" && value.subtype === "init") {
      if (sessionId !== null) {
        throw new ClaudeNativeCliError("native_stream_incompatible", "Claude 重复发送 system/init");
      }
      sessionId = safeInitSessionId(value);
      await options.onInit(sessionId);
      return;
    }
    if (value.type === "system" && typeof value.subtype === "string" && /hook/iu.test(value.subtype)) {
      throw new ClaudeNativeCliError(
        "native_stream_incompatible",
        "Claude safe-mode 执行出现了 Hook 事件",
      );
    }
    assertNoExecutionEvent(value);
    if (value.type !== "result") return;
    if (terminal !== null || sessionId === null || value.session_id !== sessionId) {
      throw new ClaudeNativeCliError(
        "native_stream_incompatible",
        "Claude result 与 system/init 的会话边界不一致",
      );
    }
    const subtype = typeof value.subtype === "string" && value.subtype.length <= 128
      ? value.subtype
      : "unknown";
    const success = subtype === "success" && value.is_error === false;
    const text = success && typeof value.result === "string" ? value.result : null;
    if (success && text === null) {
      throw new ClaudeNativeCliError(
        "native_stream_incompatible",
        "Claude success result 缺少最终文本",
      );
    }
    if (text !== null && text.length > options.maxOutputChars) {
      throw new ClaudeNativeCliError(
        "native_output_exceeded",
        "Claude 最终输出超过 Relay 上限",
      );
    }
    terminal = { sessionId, success, text, terminalSubtype: subtype };
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new ClaudeNativeCliError(
          "native_output_exceeded",
          "Claude stream-json 总输出超过 Relay 解析上限",
        );
      }
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).replace(/\r$/u, "");
        buffered = buffered.slice(newline + 1);
        await consumeLine(line);
        newline = buffered.indexOf("\n");
      }
      if (new TextEncoder().encode(buffered).byteLength > maxBytes) {
        throw new ClaudeNativeCliError("native_output_exceeded", "Claude stream-json 单行超过解析上限");
      }
    }
    buffered += decoder.decode();
    await consumeLine(buffered.replace(/\r$/u, ""));
  } finally {
    reader.releaseLock();
  }
  if (sessionId === null || terminal === null) {
    throw new ClaudeNativeCliError(
      "native_stream_incompatible",
      "Claude stream-json 未形成 system/init 到 terminal result 的完整序列",
    );
  }
  return terminal;
}

export async function consumeClaudeNativeStderr(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  return boundedStreamText(stream, STDERR_MAX_BYTES);
}

export function errnoIsMissingProcess(error: unknown): boolean {
  return isErrnoCode(error, "ESRCH");
}
