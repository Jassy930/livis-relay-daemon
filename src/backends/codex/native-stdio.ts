import { realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  CodexAppServerClientOptions,
  CodexAppServerNotification,
} from "./app-server-client.ts";
import {
  CodexAppServerClient,
  CodexAppServerProcessOwnershipUnconfirmedError,
  CodexAppServerStartCloseUnconfirmedError,
} from "./app-server-client.ts";
import {
  runCodexCommand,
  type CodexCommandRunner,
} from "./codex-execution-backend.ts";
import {
  assertPinnedCodexCommand,
  type PinnedCodexCommand,
} from "./runtime-layout.ts";
import type { CodexNativeExecutionClient } from "./native-execution-lifecycle.ts";

export type CodexNativeStdioErrorCode =
  | "native_runtime_selector_invalid"
  | "native_cli_version_unavailable"
  | "native_app_server_unavailable"
  | "native_initialize_incompatible"
  | "native_app_server_close_unconfirmed";

export class CodexNativeStdioError extends Error {
  constructor(
    readonly code: CodexNativeStdioErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodexNativeStdioError";
  }
}

export interface CodexNativeStdioProbeReport {
  ok: true;
  probeCompleted: true;
  readiness: "ready";
  transport: "app-server-stdio";
  compatibilityBasis: "protocol-handshake";
  versionRelation: "same" | "different";
  cliVersion: string;
  appServerVersion: string;
  touchedDesktopDaemon: false;
  sentModelTurn: false;
  probeProcessClosed: true;
  productionReady: false;
  verified: readonly ["native-stdio-transport", "desktop-daemon-not-targeted"];
  unverified: readonly [
    "native-backend-execution-state",
    "thread-turn-lifecycle",
    "session-resume",
    "concurrent-desktop-cli",
  ];
}

interface CodexNativeStdioProbeClient {
  readonly initializeResult: unknown;
  close(): Promise<void>;
}

export interface CodexNativeStdioAttachedClient extends CodexNativeExecutionClient {
  readonly initializeResult: unknown;
}

export interface CodexNativeStdioAttachment {
  client: CodexNativeStdioAttachedClient;
  transport: "app-server-stdio";
  compatibilityBasis: "protocol-handshake";
  versionRelation: "same" | "different";
  cliVersion: string;
  appServerVersion: string;
  ownsAppServerProcess: true;
  touchedDesktopDaemon: false;
  productionReady: false;
}

export interface CodexNativeStdioProbeOptions {
  command: PinnedCodexCommand;
  stateDir: string;
  cwd: string;
  sourceEnv?: NodeJS.ProcessEnv;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
  clientVersion: string;
}

export interface CodexNativeStdioAttachOptions extends CodexNativeStdioProbeOptions {
  onNotification?: (notification: CodexAppServerNotification) => void | Promise<void>;
}

export interface CodexNativeStdioProbeDependencies {
  commandRunner?: CodexCommandRunner;
  clientStart?: (options: CodexAppServerClientOptions) => Promise<CodexNativeStdioProbeClient>;
  commandPinAsserter?: (pin: PinnedCodexCommand) => Promise<void>;
}

export interface CodexNativeStdioAttachDependencies {
  commandRunner?: CodexCommandRunner;
  clientStart?: (
    options: CodexAppServerClientOptions,
  ) => Promise<CodexNativeStdioAttachedClient>;
  commandPinAsserter?: (pin: PinnedCodexCommand) => Promise<void>;
}

interface NativeRuntimeSelection {
  environment: Record<string, string>;
  codexHome: string;
}

interface NativeStdioTarget extends NativeRuntimeSelection {
  cliVersion: string;
}

const OBSERVED_SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

const NATIVE_ENVIRONMENT_KEYS = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "NO_COLOR",
] as const;

function isWithin(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function observedVersion(value: unknown, label: string): string {
  if (
    typeof value !== "string" || value.length > 64 ||
    !OBSERVED_SEMVER_PATTERN.test(value)
  ) {
    throw new CodexNativeStdioError(
      "native_cli_version_unavailable",
      `${label} 必须是有界 semver 字符串`,
    );
  }
  return value;
}

function observeCliVersion(result: Awaited<ReturnType<CodexCommandRunner>>): string {
  if (result.exitCode !== 0) {
    throw new CodexNativeStdioError(
      "native_cli_version_unavailable",
      `Codex native CLI 版本探针失败（exit ${result.exitCode}）`,
    );
  }
  const match = result.stdout.trim().match(/^codex-cli\s+(\S+)$/);
  if (!match) {
    throw new CodexNativeStdioError(
      "native_cli_version_unavailable",
      "Codex native CLI 版本输出格式不兼容",
    );
  }
  return observedVersion(match[1], "Codex native CLI 版本");
}

function requireNativeSelector(
  value: string | undefined,
  label: string,
  stateDir: string,
): string {
  if (value === undefined || !isAbsolute(value)) {
    throw new CodexNativeStdioError(
      "native_runtime_selector_invalid",
      `${label} 必须是已存在本地 runtime 的绝对路径选择器`,
    );
  }
  const selected = resolve(value);
  if (isWithin(resolve(stateDir), selected)) {
    throw new CodexNativeStdioError(
      "native_runtime_selector_invalid",
      `${label} 不能指向 Relay stateDir`,
    );
  }
  return selected;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === code;
}

async function assertNativeSelectorIdentity(
  selected: string,
  label: string,
  stateDir: string,
): Promise<void> {
  try {
    const canonical = await realpath(selected);
    const info = await stat(canonical);
    if (!info.isDirectory() || canonical !== selected || isWithin(stateDir, canonical)) {
      throw new CodexNativeStdioError(
        "native_runtime_selector_invalid",
        `${label} 必须是 stateDir 外的非 symlink 本地目录`,
      );
    }
  } catch (error) {
    // fake client 的纯离线测试可以使用不存在的占位路径；真实 app-server 会在 initialize
    // 回读中证明 runtime。已经存在的路径则必须通过目录、canonical 和边界检查。
    if (isErrnoCode(error, "ENOENT")) return;
    if (error instanceof CodexNativeStdioError) throw error;
    throw new CodexNativeStdioError(
      "native_runtime_selector_invalid",
      `${label} 无法完成本地目录身份检查`,
      { cause: error },
    );
  }
}

async function sanitizedPath(
  value: string | undefined,
  stateDir: string,
): Promise<string | undefined> {
  const entries: string[] = [];
  for (const entry of (value ?? "").split(delimiter)) {
    if (entry === "" || !isAbsolute(entry)) continue;
    const selected = resolve(entry);
    if (isWithin(stateDir, selected)) continue;
    try {
      const canonical = await realpath(selected);
      const info = await stat(canonical);
      if (!info.isDirectory() || isWithin(stateDir, canonical)) continue;
      if (!entries.includes(canonical)) entries.push(canonical);
    } catch {
      // 不存在或不可解析的 PATH 段不交给原生 app-server。
    }
  }
  return entries.length === 0 ? undefined : entries.join(delimiter);
}

/**
 * 只把本地 runtime 选择器和非认证运行环境交给原生 app-server。
 *
 * Relay 不读取选择器下的文件，也不透传未列入白名单的 daemon 环境。认证、账号、provider 与错误状态
 * 始终由 Codex 自己解释；这里仅证明子进程使用了操作者当前选择的本地 runtime。
 */
export async function buildCodexNativeStdioEnvironment(
  stateDir: string,
  source: NodeJS.ProcessEnv = process.env,
): Promise<NativeRuntimeSelection> {
  const canonicalStateDir = resolve(stateDir);
  const home = requireNativeSelector(source.HOME, "HOME", canonicalStateDir);
  const codexHome = source.CODEX_HOME === undefined
    ? join(home, ".codex")
    : requireNativeSelector(source.CODEX_HOME, "CODEX_HOME", canonicalStateDir);
  await assertNativeSelectorIdentity(home, "HOME", canonicalStateDir);
  await assertNativeSelectorIdentity(codexHome, "CODEX_HOME", canonicalStateDir);
  const environment: Record<string, string> = { HOME: home };
  if (source.CODEX_HOME !== undefined) environment.CODEX_HOME = codexHome;
  const safePath = await sanitizedPath(source.PATH, canonicalStateDir);
  if (safePath !== undefined) environment.PATH = safePath;
  if (source.TMPDIR !== undefined && isAbsolute(source.TMPDIR)) {
    const selectedTmp = resolve(source.TMPDIR);
    if (!isWithin(canonicalStateDir, selectedTmp)) environment.TMPDIR = selectedTmp;
  }
  for (const key of NATIVE_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return { environment, codexHome };
}

export function buildCodexNativeStdioCommand(command: string): readonly string[] {
  if (!isAbsolute(command)) throw new Error("Codex native stdio command 必须是绝对路径");
  return [command, "app-server", "--stdio"];
}

function inspectInitialize(
  value: unknown,
  expectedCodexHome: string,
  clientName: string,
): { appServerVersion: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CodexNativeStdioError(
      "native_initialize_incompatible",
      "Codex native stdio initialize response 必须是对象",
    );
  }
  const response = value as Record<string, unknown>;
  if (
    typeof response.codexHome !== "string" ||
    resolve(response.codexHome) !== resolve(expectedCodexHome)
  ) {
    throw new CodexNativeStdioError(
      "native_initialize_incompatible",
      "Codex native stdio initialize 未证明使用当前本地 runtime",
    );
  }
  if (
    typeof response.platformFamily !== "string" || response.platformFamily.trim() === "" ||
    typeof response.platformOs !== "string" || response.platformOs.trim() === "" ||
    typeof response.userAgent !== "string"
  ) {
    throw new CodexNativeStdioError(
      "native_initialize_incompatible",
      "Codex native stdio initialize 响应结构不兼容",
    );
  }
  const product = response.userAgent.split(" ", 1)[0] ?? "";
  const prefix = `${clientName}/`;
  if (!product.startsWith(prefix)) {
    throw new CodexNativeStdioError(
      "native_initialize_incompatible",
      "Codex native stdio initialize userAgent 未绑定本次客户端",
    );
  }
  try {
    return { appServerVersion: observedVersion(product.slice(prefix.length), "app-server 版本") };
  } catch (error) {
    throw new CodexNativeStdioError(
      "native_initialize_incompatible",
      "Codex native stdio initialize app-server 版本不可观测",
      { cause: error },
    );
  }
}

async function validateTarget(
  options: CodexNativeStdioProbeOptions,
  dependencies: Pick<CodexNativeStdioProbeDependencies, "commandRunner" | "commandPinAsserter">,
): Promise<NativeStdioTarget> {
  const commandRunner = dependencies.commandRunner ?? runCodexCommand;
  const commandPinAsserter = dependencies.commandPinAsserter ?? assertPinnedCodexCommand;
  const selection = await buildCodexNativeStdioEnvironment(
    options.stateDir,
    options.sourceEnv ?? process.env,
  );
  await commandPinAsserter(options.command);
  const cliVersion = observeCliVersion(await commandRunner(
    [options.command.path, "--version"],
    {
      cwd: options.cwd,
      env: selection.environment,
      timeoutMs: options.requestTimeoutMs,
    },
  ));
  await commandPinAsserter(options.command);
  return { ...selection, cliVersion };
}

function clientOptions(
  options: CodexNativeStdioAttachOptions,
  target: NativeStdioTarget,
  clientName: "livis-relay-native-stdio-attach" | "livis-relay-native-stdio-probe",
): CodexAppServerClientOptions {
  return {
    command: buildCodexNativeStdioCommand(options.command.path),
    cwd: options.cwd,
    env: target.environment,
    requestTimeoutMs: options.requestTimeoutMs,
    closeTimeoutMs: options.shutdownTimeoutMs,
    clientInfo: {
      name: clientName,
      title: clientName === "livis-relay-native-stdio-attach"
        ? "LiViS Relay Native Codex Stdio"
        : "LiViS Relay Native Codex Stdio Probe",
      version: options.clientVersion,
    },
    capabilities: { experimentalApi: false, requestAttestation: false },
    ...(options.onNotification === undefined
      ? {}
      : { onNotification: options.onNotification }),
  };
}

function mapStartError(error: unknown): CodexNativeStdioError {
  if (
    error instanceof CodexAppServerStartCloseUnconfirmedError ||
    error instanceof CodexAppServerProcessOwnershipUnconfirmedError
  ) {
    return new CodexNativeStdioError(
      "native_app_server_close_unconfirmed",
      "Codex native stdio 初始化失败且自有 app-server 进程组收口未确认",
      { cause: error },
    );
  }
  return new CodexNativeStdioError(
    "native_app_server_unavailable",
    "Codex native stdio app-server 无法完成 initialize",
    { cause: error },
  );
}

async function closeAfterFailure(
  client: CodexNativeStdioProbeClient,
  primaryError: unknown,
): Promise<never> {
  try {
    await client.close();
  } catch (closeError) {
    throw new CodexNativeStdioError(
      "native_app_server_close_unconfirmed",
      "Codex native stdio 校验失败且自有 app-server 收口未确认",
      { cause: new AggregateError([primaryError, closeError]) },
    );
  }
  throw primaryError;
}

/** 启动一个由 Relay 独占并负责收口的原生 stdio app-server；不连接 Desktop daemon。 */
export async function attachCodexNativeStdio(
  options: CodexNativeStdioAttachOptions,
  dependencies: CodexNativeStdioAttachDependencies = {},
): Promise<CodexNativeStdioAttachment> {
  const target = await validateTarget(options, dependencies);
  const clientStart = dependencies.clientStart ?? ((value) => CodexAppServerClient.start(value));
  let client: CodexNativeStdioAttachedClient;
  try {
    client = await clientStart(clientOptions(options, target, "livis-relay-native-stdio-attach"));
  } catch (error) {
    throw mapStartError(error);
  }
  try {
    const inspection = inspectInitialize(
      client.initializeResult,
      target.codexHome,
      "livis-relay-native-stdio-attach",
    );
    if (!client.running) {
      throw new CodexNativeStdioError(
        "native_app_server_unavailable",
        "Codex native stdio app-server 在 initialize 后已不可用",
      );
    }
    await (dependencies.commandPinAsserter ?? assertPinnedCodexCommand)(options.command);
    return {
      client,
      transport: "app-server-stdio",
      compatibilityBasis: "protocol-handshake",
      versionRelation: target.cliVersion === inspection.appServerVersion ? "same" : "different",
      cliVersion: target.cliVersion,
      appServerVersion: inspection.appServerVersion,
      ownsAppServerProcess: true,
      touchedDesktopDaemon: false,
      productionReady: false,
    };
  } catch (error) {
    return closeAfterFailure(client, error);
  }
}

/** 只完成 CLI 版本观测与 initialize；不会读取账号、创建 thread 或发送 model turn。 */
export async function probeCodexNativeStdio(
  options: CodexNativeStdioProbeOptions,
  dependencies: CodexNativeStdioProbeDependencies = {},
): Promise<CodexNativeStdioProbeReport> {
  const target = await validateTarget(options, dependencies);
  const clientStart = dependencies.clientStart ?? ((value) => CodexAppServerClient.start(value));
  let client: CodexNativeStdioProbeClient;
  try {
    client = await clientStart(clientOptions(options, target, "livis-relay-native-stdio-probe"));
  } catch (error) {
    throw mapStartError(error);
  }
  let inspection: { appServerVersion: string };
  try {
    inspection = inspectInitialize(
      client.initializeResult,
      target.codexHome,
      "livis-relay-native-stdio-probe",
    );
    await (dependencies.commandPinAsserter ?? assertPinnedCodexCommand)(options.command);
  } catch (error) {
    return closeAfterFailure(client, error);
  }
  try {
    await client.close();
  } catch (error) {
    throw new CodexNativeStdioError(
      "native_app_server_close_unconfirmed",
      "Codex native stdio 探针无法确认自有 app-server 收口",
      { cause: error },
    );
  }
  return {
    ok: true,
    probeCompleted: true,
    readiness: "ready",
    transport: "app-server-stdio",
    compatibilityBasis: "protocol-handshake",
    versionRelation: target.cliVersion === inspection.appServerVersion ? "same" : "different",
    cliVersion: target.cliVersion,
    appServerVersion: inspection.appServerVersion,
    touchedDesktopDaemon: false,
    sentModelTurn: false,
    probeProcessClosed: true,
    productionReady: false,
    verified: ["native-stdio-transport", "desktop-daemon-not-targeted"],
    unverified: [
      "native-backend-execution-state",
      "thread-turn-lifecycle",
      "session-resume",
      "concurrent-desktop-cli",
    ],
  };
}
