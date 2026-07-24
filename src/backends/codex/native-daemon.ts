import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  CodexAppServerNotification,
  CodexAppServerClientOptions,
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
export type CodexNativeDaemonProbeErrorCode =
  | "native_daemon_not_running"
  | "native_daemon_report_incompatible"
  | "native_daemon_socket_mismatch"
  | "native_daemon_socket_insecure"
  | "native_proxy_unavailable"
  | "native_initialize_incompatible"
  | "native_proxy_close_unconfirmed";

export class CodexNativeDaemonProbeError extends Error {
  constructor(
    readonly code: CodexNativeDaemonProbeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodexNativeDaemonProbeError";
  }
}

export interface CodexNativeDaemonProbeReport {
  ok: boolean;
  probeCompleted: true;
  readiness: "ready";
  transport: "app-server-daemon-proxy";
  compatibilityBasis: "protocol-handshake";
  versionRelation: "same" | "different";
  cliVersion: string;
  appServerVersion: string;
  startedNativeDaemon: false;
  sentModelTurn: false;
  productionReady: false;
  verified: readonly ["native-daemon-transport"];
  unverified: readonly [
    "native-backend-execution-state",
    "server-config-isolation",
    "thread-turn-lifecycle",
    "session-resume",
    "concurrent-desktop-cli",
  ];
}

interface NativeDaemonVersionReport {
  status: "running";
  socketPath: string;
  cliVersion: string;
  appServerVersion: string;
}

interface FileIdentity {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
}

export interface PinnedCodexNativeSocket {
  path: string;
  parentPath: string;
  socket: FileIdentity;
  parent: FileIdentity;
}

interface CodexNativeProbeClient {
  readonly initializeResult: unknown;
  close(): Promise<void>;
}

export interface CodexNativeAttachedClient extends CodexNativeExecutionClient {
  readonly initializeResult: unknown;
}

export interface CodexNativeDaemonAttachment {
  client: CodexNativeAttachedClient;
  transport: "app-server-daemon-proxy";
  compatibilityBasis: "protocol-handshake";
  versionRelation: "same" | "different";
  cliVersion: string;
  appServerVersion: string;
  startedNativeDaemon: false;
  productionReady: false;
}

export interface CodexNativeDaemonProbeOptions {
  command: PinnedCodexCommand;
  socketPath: string;
  stateDir: string;
  cwd: string;
  sourceEnv?: NodeJS.ProcessEnv;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
  clientVersion: string;
}

export interface CodexNativeDaemonAttachOptions extends CodexNativeDaemonProbeOptions {
  onNotification?: (notification: CodexAppServerNotification) => void | Promise<void>;
}

export interface CodexNativeDaemonProbeDependencies {
  commandRunner?: CodexCommandRunner;
  clientStart?: (options: CodexAppServerClientOptions) => Promise<CodexNativeProbeClient>;
  socketPinResolver?: (path: string) => Promise<PinnedCodexNativeSocket>;
  socketPinAsserter?: (pin: PinnedCodexNativeSocket) => Promise<void>;
  commandPinAsserter?: (pin: PinnedCodexCommand) => Promise<void>;
}

export interface CodexNativeDaemonAttachDependencies {
  commandRunner?: CodexCommandRunner;
  clientStart?: (
    options: CodexAppServerClientOptions,
  ) => Promise<CodexNativeAttachedClient>;
  socketPinResolver?: (path: string) => Promise<PinnedCodexNativeSocket>;
  socketPinAsserter?: (pin: PinnedCodexNativeSocket) => Promise<void>;
  commandPinAsserter?: (pin: PinnedCodexCommand) => Promise<void>;
}

interface CodexNativeDaemonValidatedTarget {
  cliVersion: string;
  appServerVersion: string;
  versionRelation: "same" | "different";
  socketPin: PinnedCodexNativeSocket;
}

const MANAGEMENT_ENV_KEYS = [
  "HOME",
  "CODEX_HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "NO_COLOR",
] as const;

const PROXY_ENV_KEYS = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "NO_COLOR",
] as const;

function selectEnvironment(
  source: NodeJS.ProcessEnv,
  keys: readonly string[],
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

/** `daemon version` 是唯一允许看到原生 HOME 选择器的只读管理命令。 */
export function buildCodexNativeManagementEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return selectEnvironment(source, MANAGEMENT_ENV_KEYS);
}

/** proxy 只连接显式 socket，不获得 HOME、CODEX_HOME 或 daemon 的其他环境。 */
export function buildCodexNativeProxyEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return selectEnvironment(source, PROXY_ENV_KEYS);
}

export function buildCodexNativeProxyCommand(
  command: string,
  socketPath: string,
): readonly string[] {
  if (!isAbsolute(command)) throw new Error("Codex native proxy command 必须是绝对路径");
  if (!isAbsolute(socketPath)) throw new Error("Codex native daemon socket 必须是绝对路径");
  return [command, "app-server", "proxy", "--sock", socketPath];
}

function fileIdentity(info: Stats): FileIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    nlink: info.nlink,
    uid: info.uid,
    gid: info.gid,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.nlink === right.nlink && left.uid === right.uid && left.gid === right.gid;
}

function currentUid(): number {
  if (typeof process.getuid !== "function") {
    throw new CodexNativeDaemonProbeError(
      "native_daemon_socket_insecure",
      "当前平台不能验证 Codex native daemon socket 所有者",
    );
  }
  return process.getuid();
}

async function inspectNativeSocket(path: string): Promise<PinnedCodexNativeSocket> {
  if (!isAbsolute(path)) {
    throw new CodexNativeDaemonProbeError(
      "native_daemon_socket_insecure",
      "Codex native daemon socket 必须是绝对路径",
    );
  }
  const canonicalPath = resolve(path);
  const parentPath = dirname(canonicalPath);
  try {
    const [socketInfo, parentInfo, parentRealpath] = await Promise.all([
      lstat(canonicalPath),
      lstat(parentPath),
      realpath(parentPath),
    ]);
    const uid = currentUid();
    if (
      parentRealpath !== parentPath ||
      socketInfo.isSymbolicLink() || !socketInfo.isSocket() ||
      (socketInfo.mode & 0o777) !== 0o600 || socketInfo.uid !== uid || socketInfo.nlink !== 1 ||
      parentInfo.isSymbolicLink() || !parentInfo.isDirectory() ||
      (parentInfo.mode & 0o777) !== 0o700 || parentInfo.uid !== uid
    ) {
      throw new Error("identity mismatch");
    }
    return {
      path: canonicalPath,
      parentPath,
      socket: fileIdentity(socketInfo),
      parent: fileIdentity(parentInfo),
    };
  } catch (error) {
    if (error instanceof CodexNativeDaemonProbeError) throw error;
    throw new CodexNativeDaemonProbeError(
      "native_daemon_socket_insecure",
      "Codex native daemon socket 必须是当前用户持有的 0600 普通 Unix socket，且直属父目录必须是固定 0700 普通目录",
      { cause: error },
    );
  }
}

export async function pinCodexNativeDaemonSocket(
  path: string,
): Promise<PinnedCodexNativeSocket> {
  return inspectNativeSocket(path);
}

export async function assertPinnedCodexNativeDaemonSocket(
  pin: PinnedCodexNativeSocket,
): Promise<void> {
  const current = await inspectNativeSocket(pin.path);
  if (
    current.parentPath !== pin.parentPath ||
    !sameIdentity(current.socket, pin.socket) ||
    !sameIdentity(current.parent, pin.parent)
  ) {
    throw new CodexNativeDaemonProbeError(
      "native_daemon_socket_insecure",
      "Codex native daemon socket 或父目录身份已漂移",
    );
  }
}

const OBSERVED_SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

/** 版本仅用于观测和漂移审计，不作为 native transport 兼容性判据。 */
function observedVersion(value: unknown, label: string): string {
  if (
    typeof value !== "string" || value.length > 64 ||
    !OBSERVED_SEMVER_PATTERN.test(value)
  ) {
    throw new CodexNativeDaemonProbeError(
      "native_daemon_report_incompatible",
      `${label} 必须是有界 semver 字符串`,
    );
  }
  return value;
}

function observeCodexNativeCliVersion(
  result: Awaited<ReturnType<CodexCommandRunner>>,
): string {
  if (result.exitCode !== 0) {
    throw new CodexNativeDaemonProbeError(
      "native_daemon_report_incompatible",
      `Codex native CLI 版本探针失败（exit ${result.exitCode}）`,
    );
  }
  const match = result.stdout.trim().match(/^codex-cli\s+(\S+)$/);
  if (!match) {
    throw new CodexNativeDaemonProbeError(
      "native_daemon_report_incompatible",
      "Codex native CLI 版本输出格式不兼容",
    );
  }
  return observedVersion(match[1], "Codex native CLI 版本");
}

export function parseCodexNativeDaemonVersionReport(
  result: Awaited<ReturnType<CodexCommandRunner>>,
  options: {
    cliVersion: string;
    socketPath: string;
  },
): NativeDaemonVersionReport {
  if (result.exitCode !== 0 || result.stderr.trim() !== "") {
    throw new CodexNativeDaemonProbeError(
      "native_daemon_report_incompatible",
      "Codex native daemon version 探针失败或产生非空 stderr",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new CodexNativeDaemonProbeError(
      "native_daemon_report_incompatible",
      "Codex native daemon version 输出不是 JSON",
      { cause: error },
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CodexNativeDaemonProbeError(
      "native_daemon_report_incompatible",
      "Codex native daemon version 输出必须是对象",
    );
  }
  const report = parsed as Record<string, unknown>;
  if (report.status !== "running") {
    throw new CodexNativeDaemonProbeError(
      "native_daemon_not_running",
      "Codex native app-server daemon 未运行；探针不会代替操作者启动或重启它",
    );
  }
  const socketPath = typeof report.socketPath === "string" && isAbsolute(report.socketPath)
    ? resolve(report.socketPath)
    : null;
  if (socketPath === null || socketPath !== resolve(options.socketPath)) {
    throw new CodexNativeDaemonProbeError(
      "native_daemon_socket_mismatch",
      "Codex native daemon 报告的 socket 与操作者显式配置不一致",
    );
  }
  const cliVersion = observedVersion(report.cliVersion, "Codex native daemon cliVersion");
  if (cliVersion !== options.cliVersion) {
    throw new CodexNativeDaemonProbeError(
      "native_daemon_report_incompatible",
      "Codex native daemon report 与已固定管理 CLI 版本不一致",
    );
  }
  const appServerVersion = observedVersion(
    report.appServerVersion,
    "Codex native daemon appServerVersion",
  );
  return { status: "running", socketPath, cliVersion, appServerVersion };
}

function isWithin(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function validateNativeInitialize(value: unknown, stateDir: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CodexNativeDaemonProbeError(
      "native_initialize_incompatible",
      "Codex native initialize response 必须是对象",
    );
  }
  const response = value as Record<string, unknown>;
  if (
    typeof response.codexHome !== "string" || !isAbsolute(response.codexHome) ||
    isWithin(resolve(stateDir), resolve(response.codexHome)) ||
    typeof response.userAgent !== "string" || response.userAgent.trim() === "" ||
    typeof response.platformFamily !== "string" || response.platformFamily.trim() === "" ||
    typeof response.platformOs !== "string" || response.platformOs.trim() === ""
  ) {
    throw new CodexNativeDaemonProbeError(
      "native_initialize_incompatible",
      "Codex native initialize 未证明使用 stateDir 外的原生 runtime",
    );
  }
}

async function validateCodexNativeDaemonTarget(
  options: CodexNativeDaemonProbeOptions,
  dependencies: Omit<CodexNativeDaemonProbeDependencies, "clientStart">,
): Promise<CodexNativeDaemonValidatedTarget> {
  const commandRunner = dependencies.commandRunner ?? runCodexCommand;
  const socketPinResolver = dependencies.socketPinResolver ?? pinCodexNativeDaemonSocket;
  const socketPinAsserter = dependencies.socketPinAsserter ?? assertPinnedCodexNativeDaemonSocket;
  const commandPinAsserter = dependencies.commandPinAsserter ?? assertPinnedCodexCommand;
  const sourceEnv = options.sourceEnv ?? process.env;

  await commandPinAsserter(options.command);
  const cliVersion = observeCodexNativeCliVersion(await commandRunner(
    [options.command.path, "--version"],
    {
      cwd: options.cwd,
      env: buildCodexNativeManagementEnvironment(sourceEnv),
      timeoutMs: options.requestTimeoutMs,
    },
  ));
  await commandPinAsserter(options.command);
  const daemonVersion = parseCodexNativeDaemonVersionReport(await commandRunner(
    [options.command.path, "app-server", "daemon", "version"],
    {
      cwd: options.cwd,
      env: buildCodexNativeManagementEnvironment(sourceEnv),
      timeoutMs: options.requestTimeoutMs,
    },
  ), {
    cliVersion,
    socketPath: options.socketPath,
  });
  await commandPinAsserter(options.command);
  const socketPin = await socketPinResolver(daemonVersion.socketPath);
  if (socketPin.path !== daemonVersion.socketPath) {
    throw new CodexNativeDaemonProbeError(
      "native_daemon_socket_mismatch",
      "Codex native daemon socket 固定结果与版本报告不一致",
    );
  }
  await socketPinAsserter(socketPin);
  return {
    cliVersion,
    appServerVersion: daemonVersion.appServerVersion,
    versionRelation: cliVersion === daemonVersion.appServerVersion ? "same" : "different",
    socketPin,
  };
}

function nativeProxyClientOptions(
  options: CodexNativeDaemonAttachOptions,
  target: CodexNativeDaemonValidatedTarget,
  clientName: "livis-relay-native-attach" | "livis-relay-native-probe",
): CodexAppServerClientOptions {
  return {
    command: buildCodexNativeProxyCommand(options.command.path, target.socketPin.path),
    cwd: options.cwd,
    env: buildCodexNativeProxyEnvironment(options.sourceEnv ?? process.env),
    requestTimeoutMs: options.requestTimeoutMs,
    closeTimeoutMs: options.shutdownTimeoutMs,
    clientInfo: {
      name: clientName,
      title: clientName === "livis-relay-native-attach"
        ? "LiViS Relay Native Codex Attach"
        : "LiViS Relay Native Codex Probe",
      version: options.clientVersion,
    },
    capabilities: { experimentalApi: false, requestAttestation: false },
    ...(options.onNotification === undefined
      ? {}
      : { onNotification: options.onNotification }),
  };
}

async function closeNativeProxyAfterFailure(
  client: CodexNativeProbeClient,
  primaryError: unknown,
): Promise<never> {
  try {
    await client.close();
  } catch (closeError) {
    throw new CodexNativeDaemonProbeError(
      "native_proxy_close_unconfirmed",
      "Codex native proxy 子进程收口未确认；原生 daemon 未被停止",
      {
        cause: new AggregateError(
          [primaryError, closeError],
          "Codex native attach 与 proxy 收口均失败",
        ),
      },
    );
  }
  throw primaryError;
}

/**
 * 建立一个仍由调用方持有的 native proxy 连接。
 *
 * 这里只验证 CLI、只读 daemon report、socket identity 与 initialize；不读取账号状态、不启动或
 * 停止原生 daemon，也不创建 thread。成功后的 client 必须交给 coordinator/harness 或显式 close。
 */
export async function attachCodexNativeDaemon(
  options: CodexNativeDaemonAttachOptions,
  dependencies: CodexNativeDaemonAttachDependencies = {},
): Promise<CodexNativeDaemonAttachment> {
  const target = await validateCodexNativeDaemonTarget(options, dependencies);
  const clientStart = dependencies.clientStart ?? ((clientOptions) =>
    CodexAppServerClient.start(clientOptions));
  let client: CodexNativeAttachedClient;
  try {
    client = await clientStart(nativeProxyClientOptions(
      options,
      target,
      "livis-relay-native-attach",
    ));
  } catch (error) {
    if (
      error instanceof CodexAppServerStartCloseUnconfirmedError ||
      error instanceof CodexAppServerProcessOwnershipUnconfirmedError
    ) {
      throw new CodexNativeDaemonProbeError(
        "native_proxy_close_unconfirmed",
        "Codex native proxy 初始化失败且进程组收口未确认；原生 daemon 未被停止",
        { cause: error },
      );
    }
    throw new CodexNativeDaemonProbeError(
      "native_proxy_unavailable",
      "Codex native daemon proxy 无法完成 initialize；attach 不会启用 remote control 或重启 daemon",
      { cause: error },
    );
  }

  try {
    validateNativeInitialize(client.initializeResult, options.stateDir);
    if (!client.running) {
      throw new CodexNativeDaemonProbeError(
        "native_proxy_unavailable",
        "Codex native daemon proxy 在 initialize 后已不可用",
      );
    }
    await (dependencies.commandPinAsserter ?? assertPinnedCodexCommand)(options.command);
    await (dependencies.socketPinAsserter ?? assertPinnedCodexNativeDaemonSocket)(
      target.socketPin,
    );
  } catch (error) {
    return closeNativeProxyAfterFailure(client, error);
  }

  return {
    client,
    transport: "app-server-daemon-proxy",
    compatibilityBasis: "protocol-handshake",
    versionRelation: target.versionRelation,
    cliVersion: target.cliVersion,
    appServerVersion: target.appServerVersion,
    startedNativeDaemon: false,
    productionReady: false,
  };
}

export async function probeCodexNativeDaemon(
  options: CodexNativeDaemonProbeOptions,
  dependencies: CodexNativeDaemonProbeDependencies = {},
): Promise<CodexNativeDaemonProbeReport> {
  const clientStart = dependencies.clientStart ?? ((clientOptions) =>
    CodexAppServerClient.start(clientOptions));
  const socketPinAsserter = dependencies.socketPinAsserter ?? assertPinnedCodexNativeDaemonSocket;
  const commandPinAsserter = dependencies.commandPinAsserter ?? assertPinnedCodexCommand;
  const target = await validateCodexNativeDaemonTarget(options, dependencies);

  let client: CodexNativeProbeClient;
  try {
    client = await clientStart(nativeProxyClientOptions(
      options,
      target,
      "livis-relay-native-probe",
    ));
  } catch (error) {
    throw new CodexNativeDaemonProbeError(
      "native_proxy_unavailable",
      "Codex native daemon proxy 无法完成 initialize；探针不会启用 remote control 或重启 daemon",
      { cause: error },
    );
  }

  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    validateNativeInitialize(client.initializeResult, options.stateDir);
    await commandPinAsserter(options.command);
    await socketPinAsserter(target.socketPin);
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
    throw error;
  } finally {
    try {
      await client.close();
    } catch (error) {
      throw new CodexNativeDaemonProbeError(
        "native_proxy_close_unconfirmed",
        "Codex native proxy 子进程收口未确认；原生 daemon 未被停止",
        {
          cause: hasPrimaryError
            ? new AggregateError([primaryError, error], "Codex native probe 与 proxy 收口均失败")
            : error,
        },
      );
    }
  }

  return {
    ok: true,
    probeCompleted: true,
    readiness: "ready",
    transport: "app-server-daemon-proxy",
    compatibilityBasis: "protocol-handshake",
    versionRelation: target.versionRelation,
    cliVersion: target.cliVersion,
    appServerVersion: target.appServerVersion,
    startedNativeDaemon: false,
    sentModelTurn: false,
    productionReady: false,
    verified: ["native-daemon-transport"],
    unverified: [
      "native-backend-execution-state",
      "server-config-isolation",
      "thread-turn-lifecycle",
      "session-resume",
      "concurrent-desktop-cli",
    ],
  };
}
