import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  CodexAppServerClientOptions,
} from "./app-server-client.ts";
import { CodexAppServerClient } from "./app-server-client.ts";
import {
  inspectCodexAccountResponse,
  runCodexCommand,
  validateCodexVersion,
  type CodexCommandRunner,
} from "./codex-execution-backend.ts";
import {
  assertPinnedCodexCommand,
  type PinnedCodexCommand,
} from "./runtime-layout.ts";
import {
  parseSemverTriplet,
  versionAtLeast,
  versionLessThan,
} from "../../util.ts";

export type CodexNativeDaemonProbeErrorCode =
  | "native_daemon_not_running"
  | "native_daemon_report_incompatible"
  | "native_daemon_version_incompatible"
  | "native_daemon_socket_mismatch"
  | "native_daemon_socket_insecure"
  | "native_proxy_unavailable"
  | "native_initialize_incompatible"
  | "native_account_response_incompatible"
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
  readiness: "ready" | "authentication-required";
  transport: "app-server-daemon-proxy";
  cliVersion: string;
  appServerVersion: string;
  startedNativeDaemon: false;
  sentModelTurn: false;
  productionReady: false;
  verified: readonly ["native-daemon-transport", "native-authentication-state"];
  unverified: readonly [
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
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  close(): Promise<void>;
}

export interface CodexNativeDaemonProbeOptions {
  command: PinnedCodexCommand;
  socketPath: string;
  stateDir: string;
  cwd: string;
  sourceEnv?: NodeJS.ProcessEnv;
  minimumVersion: string;
  maximumExclusiveVersion: string;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
  clientVersion: string;
}

export interface CodexNativeDaemonProbeDependencies {
  commandRunner?: CodexCommandRunner;
  clientStart?: (options: CodexAppServerClientOptions) => Promise<CodexNativeProbeClient>;
  socketPinResolver?: (path: string) => Promise<PinnedCodexNativeSocket>;
  socketPinAsserter?: (pin: PinnedCodexNativeSocket) => Promise<void>;
  commandPinAsserter?: (pin: PinnedCodexCommand) => Promise<void>;
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

function exactVersion(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new CodexNativeDaemonProbeError(
      "native_daemon_report_incompatible",
      `${label} 必须是版本字符串`,
    );
  }
  const parsed = parseSemverTriplet(value);
  if (!parsed || parsed.join(".") !== value) {
    throw new CodexNativeDaemonProbeError(
      "native_daemon_report_incompatible",
      `${label} 必须是精确 semver triplet`,
    );
  }
  return value;
}

function assertVersionWindow(
  version: string,
  minimumVersion: string,
  maximumExclusiveVersion: string,
): void {
  const current = parseSemverTriplet(version);
  const minimum = parseSemverTriplet(minimumVersion);
  const maximum = parseSemverTriplet(maximumExclusiveVersion);
  if (
    !current || !minimum || !maximum ||
    !versionAtLeast(current, minimum) || !versionLessThan(current, maximum)
  ) {
    throw new CodexNativeDaemonProbeError(
      "native_daemon_version_incompatible",
      `Codex native app-server 版本不在已审核窗口 [${minimumVersion}, ${maximumExclusiveVersion})`,
    );
  }
}

export function parseCodexNativeDaemonVersionReport(
  result: Awaited<ReturnType<CodexCommandRunner>>,
  options: {
    cliVersion: string;
    socketPath: string;
    minimumVersion: string;
    maximumExclusiveVersion: string;
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
  const cliVersion = exactVersion(report.cliVersion, "Codex native daemon cliVersion");
  if (cliVersion !== options.cliVersion) {
    throw new CodexNativeDaemonProbeError(
      "native_daemon_version_incompatible",
      "Codex native daemon 管理 CLI 与已固定 CLI 版本不一致",
    );
  }
  const appServerVersion = exactVersion(
    report.appServerVersion,
    "Codex native daemon appServerVersion",
  );
  assertVersionWindow(
    appServerVersion,
    options.minimumVersion,
    options.maximumExclusiveVersion,
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

export async function probeCodexNativeDaemon(
  options: CodexNativeDaemonProbeOptions,
  dependencies: CodexNativeDaemonProbeDependencies = {},
): Promise<CodexNativeDaemonProbeReport> {
  const commandRunner = dependencies.commandRunner ?? runCodexCommand;
  const clientStart = dependencies.clientStart ?? ((clientOptions) =>
    CodexAppServerClient.start(clientOptions));
  const socketPinResolver = dependencies.socketPinResolver ?? pinCodexNativeDaemonSocket;
  const socketPinAsserter = dependencies.socketPinAsserter ?? assertPinnedCodexNativeDaemonSocket;
  const commandPinAsserter = dependencies.commandPinAsserter ?? assertPinnedCodexCommand;
  const sourceEnv = options.sourceEnv ?? process.env;

  await commandPinAsserter(options.command);
  const cliVersion = validateCodexVersion(await commandRunner(
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
    minimumVersion: options.minimumVersion,
    maximumExclusiveVersion: options.maximumExclusiveVersion,
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

  let client: CodexNativeProbeClient;
  try {
    client = await clientStart({
      command: buildCodexNativeProxyCommand(options.command.path, socketPin.path),
      cwd: options.cwd,
      env: buildCodexNativeProxyEnvironment(sourceEnv),
      requestTimeoutMs: options.requestTimeoutMs,
      closeTimeoutMs: options.shutdownTimeoutMs,
      clientInfo: {
        name: "livis-relay-native-probe",
        title: "LiViS Relay Native Codex Probe",
        version: options.clientVersion,
      },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
  } catch (error) {
    throw new CodexNativeDaemonProbeError(
      "native_proxy_unavailable",
      "Codex native daemon proxy 无法完成 initialize；探针不会启用 remote control 或重启 daemon",
      { cause: error },
    );
  }

  let readiness: CodexNativeDaemonProbeReport["readiness"];
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    validateNativeInitialize(client.initializeResult, options.stateDir);
    await commandPinAsserter(options.command);
    await socketPinAsserter(socketPin);
    let account;
    try {
      account = inspectCodexAccountResponse(
        await client.request("account/read", { refreshToken: false }),
      );
    } catch (error) {
      throw new CodexNativeDaemonProbeError(
        "native_account_response_incompatible",
        "Codex native account/read 响应未经审核",
        { cause: error },
      );
    }
    readiness = account.accountType === null ? "authentication-required" : "ready";
    await commandPinAsserter(options.command);
    await socketPinAsserter(socketPin);
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
    ok: readiness === "ready",
    probeCompleted: true,
    readiness,
    transport: "app-server-daemon-proxy",
    cliVersion,
    appServerVersion: daemonVersion.appServerVersion,
    startedNativeDaemon: false,
    sentModelTurn: false,
    productionReady: false,
    verified: ["native-daemon-transport", "native-authentication-state"],
    unverified: [
      "server-config-isolation",
      "thread-turn-lifecycle",
      "session-resume",
      "concurrent-desktop-cli",
    ],
  };
}
