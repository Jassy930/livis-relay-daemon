import { chmod, lstat, mkdir, mkdtemp, realpath } from "node:fs/promises";
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
  assertCodexRuntimeLayout,
  buildCodexEnvironment,
  CODEX_REMOTE_PERMISSION_PROFILE,
  ensureCodexRuntimeLayout,
  resolveCodexCommand,
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
}

export interface CodexAppServerLocalSmokeReport {
  ok: true;
  sentModelTurn: false;
  backendStartReady: boolean;
  stateDir: string;
  workspace: string;
  codexCommand: string;
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
    codexHomeReadDenied: true;
    codexHomeWriteDenied: true;
    sensitiveEnvironmentHidden: true;
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

async function runReadIsolationCanary(
  client: CodexAppServerClient,
  layout: Awaited<ReturnType<typeof ensureCodexRuntimeLayout>>,
  timeoutMs: number,
): Promise<NonNullable<CodexAppServerLocalSmokeReport["readIsolationCanary"]>> {
  await requireStateOutsideTemporaryRoots(layout.stateDir);
  const workspaceMarker = "livis-workspace-read-canary-v1\n";
  const codexHomeMarker = "livis-codex-home-deny-read-canary-v1\n";
  const workspaceMarkerPath = join(layout.workspace, ".livis-workspace-read-canary");
  const codexHomeMarkerPath = join(layout.codexHome, ".livis-deny-read-canary");
  const workspaceWritePath = join(layout.workspace, ".livis-workspace-write-canary");
  const codexHomeWritePath = join(layout.codexHome, ".livis-deny-write-canary");
  await durableAtomicWritePrivate(workspaceMarkerPath, workspaceMarker);
  await durableAtomicWritePrivate(codexHomeMarkerPath, codexHomeMarker);

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
  const environmentNames = new Set(
    environmentRead.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return separator >= 0 ? line.slice(0, separator) : line;
      }),
  );
  if (
    environmentNames.has("CODEX_HOME") ||
    [...environmentNames].some((name) => name.startsWith("OPENAI_") || name.startsWith("LIVIS_"))
  ) {
    throw new Error("Codex sandbox 子进程仍继承了敏感宿主环境变量");
  }
  return {
    stateDirOutsideTemporaryRoots: true,
    workspaceRead: true,
    workspaceWrite: true,
    codexHomeReadDenied: true,
    codexHomeWriteDenied: true,
    sensitiveEnvironmentHidden: true,
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
  const command = await resolveCodexCommand(layout, options.command);
  const environment = await buildCodexEnvironment(layout);
  const versionResult = await (dependencies.commandRunner ?? runCodexCommand)(
    [command, "--version"],
    { cwd: layout.workspace, env: environment, timeoutMs: requestTimeoutMs },
  );
  const cliVersion = validateCodexVersion(versionResult);
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
    if (options.stateDir === undefined && account.accountType !== null) {
      throw new Error("全新 Codex smoke state 意外继承了账号，拒绝继续创建 thread");
    }
    validatePermissionProfiles(
      await client.request("permissionProfile/list", { cwd: layout.workspace }),
    );
    validateDisabledCodexFeatures(
      await client.request("experimentalFeature/list", { cursor: null, limit: 256 }),
    );
    readIsolationCanary = options.verifyReadIsolation === true
      ? await runReadIsolationCanary(client, layout, requestTimeoutMs)
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
      resumedAccount.requiresOpenaiAuth !== account.requiresOpenaiAuth
    ) {
      throw new Error("Codex smoke 重启后的账号状态发生变化");
    }
    validatePermissionProfiles(
      await resumeClient.request("permissionProfile/list", { cwd: layout.workspace }),
    );
    validateDisabledCodexFeatures(
      await resumeClient.request("experimentalFeature/list", { cursor: null, limit: 256 }),
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
    if (approvalRequestCount !== 0) {
      throw new Error("Codex smoke 在零 turn 恢复时收到意外 approval request");
    }
  } finally {
    await resumeClient.close();
  }
  return {
    ok: true,
    sentModelTurn: false,
    backendStartReady: account.accountType !== null,
    stateDir,
    workspace: layout.workspace,
    codexCommand: command,
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
