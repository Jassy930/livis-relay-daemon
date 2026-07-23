import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CODEX_APP_SERVER_COMMAND,
  CodexAppServerClient,
  codexLocalEnvironment,
  type CodexAppServerSpawn,
} from "./app-server-client.ts";
import {
  inspectCodexAccountResponse,
  materializeFreshCodexThread,
  runCodexCommand,
  validateCodexVersion,
  validateDisabledCodexFeatures,
  validateCodexInitializeResponse,
  validatePersistedCodexThread,
  validatePermissionProfiles,
  validateThreadResponse,
  type CodexCommandRunner,
} from "./codex-execution-backend.ts";
import {
  assertPinnedCodexCommand,
  assertCodexRuntimeLayout,
  buildCodexEnvironment,
  CODEX_REMOTE_PERMISSION_PROFILE,
  ensureCodexRuntimeLayout,
  pinCodexCommand,
  type PinnedCodexCommand,
} from "./runtime-layout.ts";
import {
  durableAtomicWritePrivate,
  readPrivateFileText,
  sha256,
} from "../../util.ts";

const SMOKE_STATE_MARKER = "livis-codex-app-server-local-smoke-v1\n";
const SMOKE_STATE_MARKER_NAME = ".livis-codex-app-server-smoke";

export interface CodexAppServerLocalSmokeOptions {
  command: string;
  stateDir?: string;
  createStateDir?: string;
  verifyReadIsolation?: boolean;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

export interface CodexAppServerLocalSmokeDependencies {
  appServerSpawn?: CodexAppServerSpawn;
  commandRunner?: CodexCommandRunner;
  /** 仅供 deterministic 测试替换非临时目录门禁；生产调用不得传入。 */
  readIsolationStateDirAsserter?: (stateDir: string) => Promise<void>;
  /** 仅供 deterministic 测试替换宿主 loopback socket；生产调用不得传入。 */
  loopbackProbeFactory?: () => CodexLocalSmokeLoopbackProbe;
  /** 仅供测试观察牺牲文件成功创建顺序；生产调用不得传入。 */
  canaryFileCreatedObserver?: (path: string) => void;
}

export interface CodexLocalSmokeLoopbackProbe {
  port: number;
  acceptCount(): number;
  connectControl(): Promise<void>;
  waitForAcceptCount(expected: number, waitMs: number): Promise<boolean>;
  stop(): void;
}

export interface CodexAppServerLocalSmokeReport {
  ok: true;
  sentModelTurn: false;
  backendStartReady: boolean;
  stateDir: string;
  workspace: string;
  codexCommand: string;
  codexCommandContentSha256: string;
  codexCommandIdentitySha256: string;
  cliVersion: string;
  account: {
    authenticated: boolean;
    requiresOpenaiAuth: boolean;
    type: string | null;
  };
  permissionProfile: typeof CODEX_REMOTE_PERMISSION_PROFILE;
  environmentId: "local";
  zeroTurnMaterialized: true;
  zeroTurnResumeVerified: true;
  threadIdSha256: string;
  safety: {
    cwdMatchesWorkspace: true;
    runtimeWorkspaceRootsMatch: true;
    sandboxType: "workspaceWrite";
    networkAccess: false;
    additionalWritableRoots: 0;
    approvalPolicy: "never";
    highRiskFeaturesDisabled: true;
    bundledSkillsDisabled: true;
  };
  readIsolationCanary: null | {
    stateDirOutsideTemporaryRoots: true;
    workspaceRead: true;
    workspaceWrite: true;
    agentHomeWrite: true;
    agentTmpWrite: true;
    agentEnvironmentPinned: true;
    codexHomeReadDenied: true;
    codexHomeWriteDenied: true;
    hostHomeReadDenied: true;
    hostHomeWriteDenied: true;
    hostTmpReadDenied: true;
    hostTmpWriteDenied: true;
    sensitiveEnvironmentHidden: true;
    workspaceHardlinkControlPassed: true;
    externalFileHardlinkDenied: true;
    externalFileIdentityStable: true;
    commandIdentityStable: true;
    loopbackEndpointReachable: true;
    systemNcProbeAvailable: true;
    toolNetworkPermissionDenied: true;
  };
  appServerStderrObserved: boolean;
  appServerStderrTruncated: boolean;
}

async function requireSmokeStateDirectory(path: string): Promise<string> {
  const requested = resolve(path);
  const info = await lstat(requested);
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700) {
    throw new Error(`Codex smoke stateDir 必须是 0700 普通目录且不能是 symlink：${requested}`);
  }
  const canonical = await realpath(requested);
  if (canonical !== requested) {
    throw new Error(`Codex smoke stateDir realpath 已变化：${requested}`);
  }
  const marker = await readPrivateFileText(
    join(canonical, SMOKE_STATE_MARKER_NAME),
    "Codex smoke state marker",
  );
  if (marker !== SMOKE_STATE_MARKER) {
    throw new Error("拒绝复用没有专用 marker 的 stateDir，避免误触生产状态");
  }
  return canonical;
}

async function createSmokeStateDirectory(path: string): Promise<string> {
  const requested = resolve(path);
  const requestedParent = dirname(requested);
  const parentInfo = await lstat(requestedParent);
  if (
    parentInfo.isSymbolicLink() ||
    !parentInfo.isDirectory() ||
    await realpath(requestedParent) !== requestedParent
  ) {
    throw new Error(
      `Codex smoke 新 stateDir 的父目录必须是 canonical 普通目录：${requestedParent}`,
    );
  }
  await mkdir(requested, { mode: 0o700 });
  await chmod(requested, 0o700);
  const canonical = await realpath(requested);
  if (canonical !== requested) {
    throw new Error(`Codex smoke 新 stateDir realpath 已变化：${requested}`);
  }
  await durableAtomicWritePrivate(
    join(canonical, SMOKE_STATE_MARKER_NAME),
    SMOKE_STATE_MARKER,
  );
  return requireSmokeStateDirectory(canonical);
}

async function prepareSmokeStateDirectory(options: {
  stateDir?: string;
  createStateDir?: string;
}): Promise<string> {
  if (options.stateDir !== undefined && options.createStateDir !== undefined) {
    throw new Error("Codex smoke 的 --state-dir 与 --create-state-dir 不能同时使用");
  }
  if (options.stateDir !== undefined) return requireSmokeStateDirectory(options.stateDir);
  if (options.createStateDir !== undefined) {
    return createSmokeStateDirectory(options.createStateDir);
  }
  const created = await mkdtemp(join(tmpdir(), "livis-codex-appserver-smoke-"));
  await chmod(created, 0o700);
  const canonical = await realpath(created);
  await durableAtomicWritePrivate(
    join(canonical, SMOKE_STATE_MARKER_NAME),
    SMOKE_STATE_MARKER,
  );
  return canonical;
}

async function requireStateOutsideTemporaryRoots(stateDir: string): Promise<void> {
  const roots = new Set([tmpdir(), "/tmp", "/private/tmp", "/var/tmp"]);
  for (const candidate of roots) {
    try {
      const canonical = await realpath(candidate);
      if (isWithin(canonical, stateDir)) {
        throw new Error(
          `读取隔离 canary 的 stateDir 不能位于系统临时目录：${stateDir}`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("不能位于系统临时目录")) {
        throw error;
      }
      // 某些平台没有全部候选临时目录；不存在的候选不影响其余检查。
    }
  }
}

interface CommandExecInspection {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function inspectCommandExec(value: unknown, label: string): CommandExecInspection {
  const response = isRecord(value) ? value : {};
  if (
    !Number.isSafeInteger(response.exitCode) ||
    typeof response.stdout !== "string" ||
    typeof response.stderr !== "string"
  ) {
    throw new Error(`${label} 返回格式不合法`);
  }
  return {
    exitCode: response.exitCode as number,
    stdout: response.stdout,
    stderr: response.stderr,
  };
}

function macOsNcPermissionErrno(
  result: CommandExecInspection,
  port: number,
): 1 | 13 | null {
  if (
    result.exitCode !== 1 ||
    !result.stdout.endsWith("\n") ||
    !result.stderr.endsWith("\n")
  ) {
    return null;
  }
  const stdoutLines = result.stdout.slice(0, -1).split("\n");
  const stderrLines = result.stderr.slice(0, -1).split("\n");
  if (stdoutLines.length !== 1 || stderrLines.length !== 1) return null;
  const errnoMatch = /^error = 0 (1|13) ?$/.exec(stdoutLines[0]!);
  if (!errnoMatch) return null;
  const errno = Number(errnoMatch[1]) as 1 | 13;
  const errorText = errno === 1 ? "Operation not permitted" : "Permission denied";
  if (
    stderrLines[0] !==
      `nc: connect to 127.0.0.1 port ${port} (tcp) failed: ${errorText}`
  ) {
    return null;
  }
  return errno;
}

interface CanaryFileIdentity {
  dev: number;
  ino: number;
}

async function createExclusiveCanaryFile(
  path: string,
  content: string,
): Promise<CanaryFileIdentity> {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o700,
  );
  let identity: CanaryFileIdentity | null = null;
  let createError: unknown = null;
  try {
    const openedInfo = await handle.stat();
    identity = { dev: openedInfo.dev, ino: openedInfo.ino };
    if (!openedInfo.isFile() || openedInfo.nlink !== 1 || (openedInfo.mode & 0o777) !== 0o700) {
      throw new Error(`Codex canary 文件身份不安全：${path}`);
    }
    await handle.writeFile(content);
    await handle.sync();
    const finalInfo = await handle.stat();
    if (
      !finalInfo.isFile() ||
      finalInfo.dev !== identity.dev ||
      finalInfo.ino !== identity.ino ||
      finalInfo.nlink !== 1 ||
      (finalInfo.mode & 0o777) !== 0o700
    ) {
      throw new Error(`Codex canary 文件身份在创建期间发生变化：${path}`);
    }
  } catch (error) {
    createError = error;
  }
  let closeError: unknown = null;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  if (createError !== null || closeError !== null) {
    let cleanupError: unknown = null;
    try {
      if (identity === null) {
        throw new Error(`Codex canary 创建失败且无法取得安全清理身份：${path}`);
      }
      await removeOwnedCanaryPath(path, identity);
    } catch (error) {
      cleanupError = error;
    }
    const errors = [createError, closeError, cleanupError].filter(
      (error): error is NonNullable<typeof error> => error !== null,
    );
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, `Codex canary 文件创建失败且未能完整清理：${path}`);
  }
  if (identity === null) throw new Error(`Codex canary 文件创建后缺少身份：${path}`);
  return identity;
}

async function removeOwnedCanaryPath(
  path: string,
  expected: CanaryFileIdentity,
): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  if (!info.isFile() || info.dev !== expected.dev || info.ino !== expected.ino) {
    throw new Error(`Codex canary cleanup 拒绝删除身份漂移的路径：${path}`);
  }
  await unlink(path);
}

async function cleanupCanaryPaths(
  paths: ReadonlyArray<{ path: string; identity: CanaryFileIdentity }>,
): Promise<void> {
  const errors: unknown[] = [];
  for (const item of paths) {
    try {
      await removeOwnedCanaryPath(item.path, item.identity);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Codex canary 路径未能按文件身份完整清理");
  }
}

function createLoopbackProbe(): CodexLocalSmokeLoopbackProbe {
  let loopbackAccepts = 0;
  const acceptWaiters = new Set<() => void>();
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        loopbackAccepts += 1;
        for (const resolveWaiter of [...acceptWaiters]) resolveWaiter();
        socket.end();
      },
      data() {},
      error() {},
    },
  });
  return {
    port: listener.port,
    acceptCount: () => loopbackAccepts,
    connectControl: async () => {
      const socket = await Bun.connect({
        hostname: "127.0.0.1",
        port: listener.port,
        socket: { data() {}, open() {}, error() {} },
      });
      socket.end();
    },
    waitForAcceptCount: async (expected, waitMs) => {
      if (loopbackAccepts >= expected) return true;
      return new Promise<boolean>((resolvePromise) => {
        const done = () => {
          clearTimeout(timer);
          acceptWaiters.delete(done);
          resolvePromise(true);
        };
        const timer = setTimeout(() => {
          acceptWaiters.delete(done);
          resolvePromise(loopbackAccepts >= expected);
        }, waitMs);
        acceptWaiters.add(done);
      });
    },
    stop: () => listener.stop(true),
  };
}

async function runReadIsolationCanary(
  client: CodexAppServerClient,
  layout: Awaited<ReturnType<typeof ensureCodexRuntimeLayout>>,
  commandPin: PinnedCodexCommand,
  timeoutMs: number,
  stateDirAsserter: (stateDir: string) => Promise<void>,
  loopbackProbeFactory: () => CodexLocalSmokeLoopbackProbe,
  canaryFileCreatedObserver: (path: string) => void,
): Promise<NonNullable<CodexAppServerLocalSmokeReport["readIsolationCanary"]>> {
  await stateDirAsserter(layout.stateDir);
  const workspaceMarker = "livis-workspace-read-canary-v1\n";
  const codexHomeMarker = "livis-codex-home-deny-read-canary-v1\n";
  const hostHomeMarker = "livis-host-home-deny-read-canary-v1\n";
  const hostTmpMarker = "livis-host-tmp-deny-read-canary-v1\n";
  const workspaceMarkerPath = join(layout.workspace, ".livis-workspace-read-canary");
  const codexHomeMarkerPath = join(layout.codexHome, ".livis-deny-read-canary");
  const hostHomeMarkerPath = join(layout.hostHome, ".livis-deny-read-canary");
  const hostTmpMarkerPath = join(layout.hostTmpDir, ".livis-deny-read-canary");
  const workspaceWritePath = join(layout.workspace, ".livis-workspace-write-canary");
  const agentHomeWritePath = join(layout.agentHome, ".livis-agent-home-write-canary");
  const agentTmpWritePath = join(layout.agentTmpDir, ".livis-agent-tmp-write-canary");
  const codexHomeWritePath = join(layout.codexHome, ".livis-deny-write-canary");
  const hostHomeWritePath = join(layout.hostHome, ".livis-deny-write-canary");
  const hostTmpWritePath = join(layout.hostTmpDir, ".livis-deny-write-canary");
  await durableAtomicWritePrivate(workspaceMarkerPath, workspaceMarker);
  await durableAtomicWritePrivate(codexHomeMarkerPath, codexHomeMarker);
  await durableAtomicWritePrivate(hostHomeMarkerPath, hostHomeMarker);
  await durableAtomicWritePrivate(hostTmpMarkerPath, hostTmpMarker);

  const common = {
    cwd: layout.workspace,
    permissionProfile: CODEX_REMOTE_PERMISSION_PROFILE,
    timeoutMs,
    outputBytesCap: 16 * 1024,
  } as const;
  const workspaceRead = inspectCommandExec(
    await client.request("command/exec", {
      ...common,
      command: ["/bin/cat", workspaceMarkerPath],
    }),
    "Codex workspace 读取 canary",
  );
  if (workspaceRead.exitCode !== 0 || workspaceRead.stdout !== workspaceMarker) {
    throw new Error(
      `Codex 读取隔离 canary 无法读取 daemon workspace：exit=${workspaceRead.exitCode} stderr=${JSON.stringify(workspaceRead.stderr.slice(0, 512))}`,
    );
  }

  const workspaceWrite = inspectCommandExec(
    await client.request("command/exec", {
      ...common,
      command: ["/usr/bin/touch", workspaceWritePath],
    }),
    "Codex workspace 写入 canary",
  );
  if (workspaceWrite.exitCode !== 0) {
    throw new Error(
      `Codex 读取隔离 canary 无法写入 daemon workspace：exit=${workspaceWrite.exitCode} stderr=${JSON.stringify(workspaceWrite.stderr.slice(0, 512))}`,
    );
  }

  const agentHomeWrite = inspectCommandExec(
    await client.request("command/exec", {
      ...common,
      command: ["/usr/bin/touch", agentHomeWritePath],
    }),
    "Codex agent HOME 写入 canary",
  );
  if (agentHomeWrite.exitCode !== 0) {
    throw new Error(
      `Codex 读取隔离 canary 无法写入 agent HOME：exit=${agentHomeWrite.exitCode} stderr=${JSON.stringify(agentHomeWrite.stderr.slice(0, 512))}`,
    );
  }

  const agentTmpWrite = inspectCommandExec(
    await client.request("command/exec", {
      ...common,
      command: ["/usr/bin/touch", agentTmpWritePath],
    }),
    "Codex agent TMPDIR 写入 canary",
  );
  if (agentTmpWrite.exitCode !== 0) {
    throw new Error(
      `Codex 读取隔离 canary 无法写入 agent TMPDIR：exit=${agentTmpWrite.exitCode} stderr=${JSON.stringify(agentTmpWrite.stderr.slice(0, 512))}`,
    );
  }

  const codexHomeRead = inspectCommandExec(
    await client.request("command/exec", {
      ...common,
      command: ["/bin/cat", codexHomeMarkerPath],
    }),
    "Codex CODEX_HOME 读取 canary",
  );
  if (codexHomeRead.exitCode === 0 || codexHomeRead.stdout.includes(codexHomeMarker.trim())) {
    throw new Error("Codex 读取隔离 canary 仍可读取专用 CODEX_HOME");
  }

  const codexHomeWrite = inspectCommandExec(
    await client.request("command/exec", {
      ...common,
      command: ["/usr/bin/touch", codexHomeWritePath],
    }),
    "Codex CODEX_HOME 写入 canary",
  );
  if (codexHomeWrite.exitCode === 0) {
    throw new Error("Codex 读取隔离 canary 仍可写入专用 CODEX_HOME");
  }

  const hostHomeRead = inspectCommandExec(
    await client.request("command/exec", {
      ...common,
      command: ["/bin/cat", hostHomeMarkerPath],
    }),
    "Codex app-server HOME 读取 canary",
  );
  if (hostHomeRead.exitCode === 0 || hostHomeRead.stdout.includes(hostHomeMarker.trim())) {
    throw new Error("Codex 读取隔离 canary 仍可读取 app-server HOME");
  }

  const hostHomeWrite = inspectCommandExec(
    await client.request("command/exec", {
      ...common,
      command: ["/usr/bin/touch", hostHomeWritePath],
    }),
    "Codex app-server HOME 写入 canary",
  );
  if (hostHomeWrite.exitCode === 0) {
    throw new Error("Codex 读取隔离 canary 仍可写入 app-server HOME");
  }

  const hostTmpRead = inspectCommandExec(
    await client.request("command/exec", {
      ...common,
      command: ["/bin/cat", hostTmpMarkerPath],
    }),
    "Codex app-server TMPDIR 读取 canary",
  );
  if (hostTmpRead.exitCode === 0 || hostTmpRead.stdout.includes(hostTmpMarker.trim())) {
    throw new Error("Codex 读取隔离 canary 仍可读取 app-server TMPDIR");
  }

  const hostTmpWrite = inspectCommandExec(
    await client.request("command/exec", {
      ...common,
      command: ["/usr/bin/touch", hostTmpWritePath],
    }),
    "Codex app-server TMPDIR 写入 canary",
  );
  if (hostTmpWrite.exitCode === 0) {
    throw new Error("Codex 读取隔离 canary 仍可写入 app-server TMPDIR");
  }

  const environmentRead = inspectCommandExec(
    await client.request("command/exec", {
      ...common,
      command: ["/usr/bin/env"],
    }),
    "Codex 环境变量 canary",
  );
  if (environmentRead.exitCode !== 0) {
    throw new Error("Codex 环境变量 canary 执行失败");
  }
  const environmentValues = new Map<string, string>();
  for (const line of environmentRead.stdout.split("\n").filter(Boolean)) {
    const separator = line.indexOf("=");
    if (separator >= 0) {
      environmentValues.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }
  if (
    environmentValues.get("HOME") !== layout.agentHome ||
    environmentValues.get("TMPDIR") !== layout.agentTmpDir
  ) {
    throw new Error("Codex sandbox 子进程 HOME/TMPDIR 未固定到 agent workspace");
  }
  if (
    environmentValues.has("CODEX_HOME") ||
    [...environmentValues.keys()].some(
      (name) => name.startsWith("OPENAI_") || name.startsWith("LIVIS_"),
    )
  ) {
    throw new Error("Codex sandbox 子进程仍继承了敏感宿主环境变量");
  }

  const nonce = crypto.randomUUID();
  const workspaceInfo = await lstat(layout.workspace);
  const hardlinkControlSource = join(layout.workspace, `.livis-hardlink-control-source-${nonce}`);
  const hardlinkControlTarget = join(layout.workspace, `.livis-hardlink-control-target-${nonce}`);
  const externalSource = join(layout.hostHome, `.livis-hardlink-external-source-${nonce}`);
  const externalTarget = join(layout.workspace, `.livis-hardlink-external-target-${nonce}`);
  const ownedCanaryPaths: Array<{ path: string; identity: CanaryFileIdentity }> = [];
  let hardlinkError: unknown = null;
  try {
    const controlIdentity = await createExclusiveCanaryFile(
      hardlinkControlSource,
      "livis-hardlink-control-v2\n",
    );
    ownedCanaryPaths.push({ path: hardlinkControlSource, identity: controlIdentity });
    ownedCanaryPaths.unshift({ path: hardlinkControlTarget, identity: controlIdentity });
    canaryFileCreatedObserver(hardlinkControlSource);
    const externalIdentity = await createExclusiveCanaryFile(
      externalSource,
      "livis-hardlink-external-v2\n",
    );
    ownedCanaryPaths.push({ path: externalSource, identity: externalIdentity });
    ownedCanaryPaths.unshift({ path: externalTarget, identity: externalIdentity });
    canaryFileCreatedObserver(externalSource);
    if (
      workspaceInfo.dev !== controlIdentity.dev ||
      workspaceInfo.dev !== externalIdentity.dev
    ) {
      throw new Error("Codex hardlink canary 的 workspace 与外部牺牲文件不在同一文件系统");
    }
    const hardlinkControl = inspectCommandExec(
      await client.request("command/exec", {
        ...common,
        command: ["/bin/ln", hardlinkControlSource, hardlinkControlTarget],
      }),
      "Codex workspace hardlink 正向 control",
    );
    if (hardlinkControl.exitCode !== 0) {
      throw new Error(
        `Codex workspace hardlink 正向 control 失败：${JSON.stringify(hardlinkControl.stderr.slice(0, 512))}`,
      );
    }
    const controlTargetInfo = await lstat(hardlinkControlTarget);
    if (
      !controlTargetInfo.isFile() ||
      controlTargetInfo.dev !== controlIdentity.dev ||
      controlTargetInfo.ino !== controlIdentity.ino ||
      controlTargetInfo.nlink !== 2
    ) {
      throw new Error("Codex workspace hardlink 正向 control 未形成预期的双 link inode");
    }

    const externalHardlink = inspectCommandExec(
      await client.request("command/exec", {
        ...common,
        command: ["/bin/ln", externalSource, externalTarget],
      }),
      "Codex workspace 外文件 hardlink 负向 canary",
    );
    let externalLinkCreated = false;
    try {
      const targetInfo = await lstat(externalTarget);
      externalLinkCreated = true;
      if (
        !targetInfo.isFile() ||
        targetInfo.dev !== externalIdentity.dev ||
        targetInfo.ino !== externalIdentity.ino
      ) {
        throw new Error("Codex 外部文件 hardlink canary 产生了非预期目录项");
      }
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        (error as { code?: unknown }).code !== "ENOENT"
      ) {
        throw error;
      }
    }
    if (externalHardlink.exitCode === 0 || externalLinkCreated) {
      throw new Error("Codex sandbox 允许把 workspace 外文件 hardlink 进 workspace");
    }
    const externalAfter = await lstat(externalSource);
    if (
      externalAfter.dev !== externalIdentity.dev ||
      externalAfter.ino !== externalIdentity.ino ||
      externalAfter.nlink !== 1
    ) {
      throw new Error("Codex hardlink 负向 canary 后外部牺牲文件身份已变化");
    }
    await assertPinnedCodexCommand(commandPin);
  } catch (error) {
    hardlinkError = error;
  }
  let hardlinkCleanupError: unknown = null;
  try {
    await cleanupCanaryPaths(ownedCanaryPaths);
  } catch (error) {
    hardlinkCleanupError = error;
  }
  if (hardlinkError !== null && hardlinkCleanupError !== null) {
    throw new AggregateError(
      [hardlinkError, hardlinkCleanupError],
      "Codex hardlink canary 失败且牺牲文件未完整清理",
    );
  }
  if (hardlinkCleanupError !== null) throw hardlinkCleanupError;
  if (hardlinkError !== null) throw hardlinkError;

  const loopback = loopbackProbeFactory();
  try {
    await loopback.connectControl();
    if (
      !await loopback.waitForAcceptCount(1, Math.min(timeoutMs, 1_000)) ||
      loopback.acceptCount() !== 1
    ) {
      throw new Error("Codex 工具网络 canary 的 host TCP 正向 control 失败");
    }
    const networkProbe = inspectCommandExec(
      await client.request("command/exec", {
        ...common,
        command: [
          "/usr/bin/nc",
          "-4",
          "-n",
          "-O",
          "-G",
          "1",
          "-v",
          "-z",
          "127.0.0.1",
          String(loopback.port),
        ],
      }),
      "Codex macOS 系统 nc 工具网络权限负向 canary",
    );
    const delayedAccept = await loopback.waitForAcceptCount(
      2,
      Math.min(timeoutMs, 250),
    );
    const errno = macOsNcPermissionErrno(networkProbe, loopback.port);
    if (
      (errno !== 1 && errno !== 13) ||
      delayedAccept ||
      loopback.acceptCount() !== 1
    ) {
      throw new Error(
        `Codex 工具网络 canary 未得到明确 EPERM/EACCES：exit=${networkProbe.exitCode} ` +
          `accepts=${loopback.acceptCount()} stdout=${JSON.stringify(networkProbe.stdout.slice(0, 512))} ` +
          `stderr=${JSON.stringify(networkProbe.stderr.slice(0, 512))}`,
      );
    }
  } finally {
    loopback.stop();
  }
  return {
    stateDirOutsideTemporaryRoots: true,
    workspaceRead: true,
    workspaceWrite: true,
    agentHomeWrite: true,
    agentTmpWrite: true,
    agentEnvironmentPinned: true,
    codexHomeReadDenied: true,
    codexHomeWriteDenied: true,
    hostHomeReadDenied: true,
    hostHomeWriteDenied: true,
    hostTmpReadDenied: true,
    hostTmpWriteDenied: true,
    sensitiveEnvironmentHidden: true,
    workspaceHardlinkControlPassed: true,
    externalFileHardlinkDenied: true,
    externalFileIdentityStable: true,
    commandIdentityStable: true,
    loopbackEndpointReachable: true,
    systemNcProbeAvailable: true,
    toolNetworkPermissionDenied: true,
  };
}

function buildAppServerCommand(command: string): readonly string[] {
  return [command, ...CODEX_APP_SERVER_COMMAND.slice(1)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWithin(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function validateFreshSmokeThread(
  value: unknown,
  cliVersion: string,
): void {
  if (!isRecord(value) || !isRecord(value.thread)) {
    throw new Error("Codex smoke thread/start response 必须包含 thread 对象");
  }
  const thread = value.thread;
  if (thread.cliVersion !== cliVersion) {
    throw new Error("Codex smoke thread.cliVersion 与版本探针不一致");
  }
  if (thread.ephemeral !== false) {
    throw new Error("Codex smoke thread 必须按生产路径创建为非 ephemeral");
  }
  if (!isRecord(thread.status) || thread.status.type !== "idle") {
    throw new Error("Codex smoke 新 thread 状态必须为 idle");
  }
  if (!Array.isArray(thread.turns) || thread.turns.length !== 0) {
    throw new Error("Codex smoke 新 thread 不应包含任何模型 turn");
  }
  if (!Array.isArray(value.instructionSources) || value.instructionSources.length !== 0) {
    throw new Error("Codex smoke 空 workspace 不应加载 instruction source");
  }
}

/**
 * 在专用、可丢弃 state directory 中启动真实 app-server，只验证初始化、账号状态、
 * permission profile 与 thread 安全回读。该函数绝不发送 turn/start，但 thread/start
 * 本身仍可能触发 Codex 控制面网络连接，不能宣称完全离线。
 */
export async function runCodexAppServerLocalSmoke(
  options: CodexAppServerLocalSmokeOptions,
  dependencies: CodexAppServerLocalSmokeDependencies = {},
): Promise<CodexAppServerLocalSmokeReport> {
  if (!isAbsolute(options.command)) throw new Error("Codex smoke command 必须是绝对路径");
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
  const stateDir = await prepareSmokeStateDirectory(options);
  const layout = await ensureCodexRuntimeLayout({
    stateDir,
    scopeKey: "local-smoke",
    sessionKey: "livis:local-smoke",
    remoteNodeId: "local-smoke-node",
  });
  await assertCodexRuntimeLayout(layout);
  const commandPin = await pinCodexCommand(layout, options.command);
  const command = commandPin.path;
  const environment = await buildCodexEnvironment(layout);
  const versionResult = await (dependencies.commandRunner ?? runCodexCommand)(
    [command, "--version"],
    { cwd: layout.workspace, env: environment, timeoutMs: requestTimeoutMs },
  );
  const cliVersion = validateCodexVersion(versionResult);
  await assertPinnedCodexCommand(commandPin);
  let approvalRequestCount = 0;
  const startClient = () => CodexAppServerClient.start({
      command: buildAppServerCommand(command),
      cwd: layout.workspace,
      env: environment,
      spawn: dependencies.appServerSpawn,
      requestTimeoutMs,
      closeTimeoutMs: shutdownTimeoutMs,
      capabilities: { experimentalApi: true, requestAttestation: false },
      onApprovalRequest: () => {
        approvalRequestCount += 1;
      },
    });
  const client = await startClient();
  let account: ReturnType<typeof inspectCodexAccountResponse> | null = null;
  let readIsolationCanary: CodexAppServerLocalSmokeReport["readIsolationCanary"] = null;
  let threadId: string | null = null;
  try {
    validateCodexInitializeResponse(client.initializeResult, layout, cliVersion);
    account = inspectCodexAccountResponse(
      await client.request("account/read", { refreshToken: false }),
    );
    if (account.accountType !== null && account.accountType !== "apiKey") {
      throw new Error("Codex smoke 只允许未登录或 API key account");
    }
    if (options.stateDir === undefined && account.accountType !== null) {
      throw new Error("全新 Codex smoke state 意外继承了账号，拒绝继续创建 thread");
    }
    validatePermissionProfiles(
      await client.request("permissionProfile/list", { cwd: layout.workspace }),
    );
    validateDisabledCodexFeatures(
      await client.request("experimentalFeature/list", { cursor: null, limit: 256 }),
      cliVersion,
    );
    readIsolationCanary = options.verifyReadIsolation === true
      ? await runReadIsolationCanary(
          client,
          layout,
          commandPin,
          requestTimeoutMs,
          dependencies.readIsolationStateDirAsserter ?? requireStateOutsideTemporaryRoots,
          dependencies.loopbackProbeFactory ?? createLoopbackProbe,
          dependencies.canaryFileCreatedObserver ?? (() => undefined),
        )
      : null;
    const threadResponse = await client.threadStart({
      cwd: layout.workspace,
      runtimeWorkspaceRoots: [layout.workspace],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      permissions: CODEX_REMOTE_PERMISSION_PROFILE,
      environments: codexLocalEnvironment(layout.workspace),
      ephemeral: false,
    });
    threadId = validateThreadResponse(threadResponse, layout, null);
    validateFreshSmokeThread(threadResponse, cliVersion);
    await materializeFreshCodexThread(client, layout, threadId, requestTimeoutMs);
    await assertCodexRuntimeLayout(layout);
    await assertPinnedCodexCommand(commandPin);
    if (approvalRequestCount !== 0) {
      throw new Error("Codex smoke 在未发送 turn 时收到意外 approval request");
    }
  } finally {
    await client.close();
  }
  if (account === null || threadId === null) {
    throw new Error("Codex smoke 首次启动未完成 thread 物化");
  }

  const resumeClient = await startClient();
  try {
    validateCodexInitializeResponse(resumeClient.initializeResult, layout, cliVersion);
    const resumedAccount = inspectCodexAccountResponse(
      await resumeClient.request("account/read", { refreshToken: false }),
    );
    if (
      resumedAccount.accountType !== account.accountType ||
      resumedAccount.requiresOpenaiAuth !== account.requiresOpenaiAuth ||
      resumedAccount.accountSubjectSha256 !== account.accountSubjectSha256 ||
      resumedAccount.identityStrength !== account.identityStrength
    ) {
      throw new Error("Codex smoke 重启后的账号状态发生变化");
    }
    validatePermissionProfiles(
      await resumeClient.request("permissionProfile/list", { cwd: layout.workspace }),
    );
    validateDisabledCodexFeatures(
      await resumeClient.request("experimentalFeature/list", { cursor: null, limit: 256 }),
      cliVersion,
    );
    const resumed = await resumeClient.threadResume({
      threadId,
      cwd: layout.workspace,
      runtimeWorkspaceRoots: [layout.workspace],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      permissions: CODEX_REMOTE_PERMISSION_PROFILE,
    });
    validateThreadResponse(resumed, layout, threadId);
    await validatePersistedCodexThread(resumed, layout, threadId);
    await assertCodexRuntimeLayout(layout);
    await assertPinnedCodexCommand(commandPin);
    if (approvalRequestCount !== 0) {
      throw new Error("Codex smoke 在零 turn 恢复时收到意外 approval request");
    }
  } finally {
    await resumeClient.close();
  }
  return {
    ok: true,
    sentModelTurn: false,
    backendStartReady: account.accountType === "apiKey",
    stateDir,
    workspace: layout.workspace,
    codexCommand: command,
    codexCommandContentSha256: commandPin.contentSha256,
    codexCommandIdentitySha256: commandPin.identitySha256,
    cliVersion,
    account: {
      authenticated: account.accountType !== null,
      requiresOpenaiAuth: account.requiresOpenaiAuth,
      type: account.accountType,
    },
    permissionProfile: CODEX_REMOTE_PERMISSION_PROFILE,
    environmentId: "local",
    zeroTurnMaterialized: true,
    zeroTurnResumeVerified: true,
    threadIdSha256: sha256(threadId),
    safety: {
      cwdMatchesWorkspace: true,
      runtimeWorkspaceRootsMatch: true,
      sandboxType: "workspaceWrite",
      networkAccess: false,
      additionalWritableRoots: 0,
      approvalPolicy: "never",
      highRiskFeaturesDisabled: true,
      bundledSkillsDisabled: true,
    },
    readIsolationCanary,
    appServerStderrObserved:
      client.stderrText.trim().length > 0 || resumeClient.stderrText.trim().length > 0,
    appServerStderrTruncated: client.stderrTruncated || resumeClient.stderrTruncated,
  };
}
