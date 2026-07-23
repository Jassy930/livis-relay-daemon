import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  durableAtomicWritePrivate,
  durableMkdirPrivate,
  readOptionalPrivateFileText,
  readPrivateFileText,
  sha256,
} from "../../util.ts";

export const CODEX_REMOTE_PERMISSION_PROFILE = "livis-remote";

/**
 * 该文件属于 daemon 的安全配置，不是用户 Codex 配置。workspace 是唯一声明为
 * 可写的 runtime root，工具网络关闭，且任何审批请求都由 app-server client 拒绝。
 *
 * 必须预先把 workspace 标成 untrusted。Codex 0.145.0 否则会在 thread/start 时把
 * 该项目追加成 trusted，既会修改 daemon 固定的 config，也会扩大项目配置面。
 */
export function codexRemoteConfig(workspace: string): string {
  const canonicalWorkspace = resolve(workspace);
  const agentHome = join(canonicalWorkspace, ".agent-home");
  const agentTmpDir = join(canonicalWorkspace, ".agent-tmp");
  return `default_permissions = "${CODEX_REMOTE_PERMISSION_PROFILE}"
approval_policy = "never"
approvals_reviewer = "user"
web_search = "disabled"
cli_auth_credentials_store = "file"

[agents]
enabled = false

[skills]
include_instructions = false

[skills.bundled]
enabled = false

[shell_environment_policy]
inherit = "core"
exclude = ["CODEX_HOME", "OPENAI_*", "LIVIS_*"]
set = { HOME = ${JSON.stringify(agentHome)}, TMPDIR = ${JSON.stringify(agentTmpDir)} }

[permissions.${CODEX_REMOTE_PERMISSION_PROFILE}]
description = "LiViS 远程会话：仅访问 daemon 托管 workspace"

[permissions.${CODEX_REMOTE_PERMISSION_PROFILE}.filesystem]
":root" = "deny"
":minimal" = "read"
":workspace_roots" = "write"

[permissions.${CODEX_REMOTE_PERMISSION_PROFILE}.network]
enabled = false

[projects.${JSON.stringify(canonicalWorkspace)}]
trust_level = "untrusted"
`;
}

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

export interface CodexRuntimeLayout {
  stateDir: string;
  backendRoot: string;
  codexHome: string;
  sessionsRoot: string;
  sessionHash: string;
  sessionRoot: string;
  workspace: string;
  hostHome: string;
  hostTmpDir: string;
  agentHome: string;
  agentTmpDir: string;
  configPath: string;
  identities: Readonly<Record<string, DirectoryIdentity>>;
}

export interface PinnedCodexCommand {
  path: string;
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  contentSha256: string;
  identitySha256: string;
}

function isWithin(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

async function requirePrivateDirectory(
  path: string,
  label: string,
  expected?: DirectoryIdentity,
): Promise<DirectoryIdentity> {
  const absolute = resolve(path);
  const info = await lstat(absolute);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    (info.mode & 0o777) !== 0o700 ||
    (expected !== undefined && (info.dev !== expected.dev || info.ino !== expected.ino))
  ) {
    throw new Error(`${label} 必须是固定 inode 的 0700 普通目录且不能是 symlink：${absolute}`);
  }
  if (await realpath(absolute) !== absolute) {
    throw new Error(`${label} realpath 已变化：${absolute}`);
  }
  return { dev: info.dev, ino: info.ino };
}

async function canonicalPrivateStateDir(path: string): Promise<{
  path: string;
  identity: DirectoryIdentity;
}> {
  const requested = resolve(path);
  const info = await lstat(requested);
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700) {
    throw new Error(`Codex stateDir 必须是 0700 普通目录且不能是 symlink：${requested}`);
  }
  const canonical = await realpath(requested);
  const identity = await requirePrivateDirectory(canonical, "Codex canonical stateDir", {
    dev: info.dev,
    ino: info.ino,
  });
  return { path: canonical, identity };
}

async function ensurePrivateDirectory(path: string, label: string): Promise<DirectoryIdentity> {
  await durableMkdirPrivate(path);
  return requirePrivateDirectory(path, label);
}

export function codexSessionHash(
  scopeKey: string,
  sessionKey: string,
  remoteNodeId: string,
): string {
  if (!remoteNodeId.trim()) throw new Error("Codex remoteNodeId 不能为空");
  return sha256(
    JSON.stringify(["livis-backend-session-v2", scopeKey, "codex", sessionKey, remoteNodeId]),
  );
}

export async function ensureCodexRuntimeLayout(options: {
  stateDir: string;
  scopeKey: string;
  sessionKey: string;
  remoteNodeId: string;
}): Promise<CodexRuntimeLayout> {
  const canonicalState = await canonicalPrivateStateDir(options.stateDir);
  const stateDir = canonicalState.path;
  const stateIdentity = canonicalState.identity;
  const backendRoot = join(stateDir, "backends", "codex");
  const codexHome = join(backendRoot, "home");
  const sessionsRoot = join(backendRoot, "sessions");
  const sessionHash = codexSessionHash(
    options.scopeKey,
    options.sessionKey,
    options.remoteNodeId,
  );
  const sessionRoot = join(sessionsRoot, sessionHash);
  const workspace = join(sessionRoot, "workspace");
  const hostHome = join(sessionRoot, "host-home");
  const hostTmpDir = join(sessionRoot, "host-tmp");
  const agentHome = join(workspace, ".agent-home");
  const agentTmpDir = join(workspace, ".agent-tmp");
  const configPath = join(codexHome, "config.toml");
  const expectedConfig = codexRemoteConfig(workspace);
  for (const path of [
    backendRoot,
    codexHome,
    sessionsRoot,
    sessionRoot,
    workspace,
    hostHome,
    hostTmpDir,
    agentHome,
    agentTmpDir,
  ]) {
    if (!isWithin(stateDir, path)) {
      throw new Error(`Codex runtime 路径逃逸出 stateDir：${path}`);
    }
  }

  const identities: Record<string, DirectoryIdentity> = { [stateDir]: stateIdentity };
  for (const [path, label] of [
    [join(stateDir, "backends"), "Codex backends 目录"],
    [backendRoot, "Codex backend 目录"],
    [codexHome, "Codex home 目录"],
    [sessionsRoot, "Codex sessions 目录"],
    [sessionRoot, "Codex session 目录"],
    [workspace, "Codex workspace 目录"],
    [hostHome, "Codex app-server HOME 目录"],
    [hostTmpDir, "Codex app-server TMPDIR 目录"],
    [agentHome, "Codex agent HOME 目录"],
    [agentTmpDir, "Codex agent TMPDIR 目录"],
  ] as const) {
    identities[path] = await ensurePrivateDirectory(path, label);
  }

  const existingConfig = await readOptionalPrivateFileText(configPath, "Codex 安全 config");
  if (existingConfig === null) {
    await durableAtomicWritePrivate(configPath, expectedConfig);
  } else if (existingConfig !== expectedConfig) {
    throw new Error(`Codex 安全 config 已漂移，拒绝启动：${configPath}`);
  }
  if (await readPrivateFileText(configPath, "Codex 安全 config") !== expectedConfig) {
    throw new Error(`Codex 安全 config 写后读回不一致：${configPath}`);
  }

  return {
    stateDir,
    backendRoot,
    codexHome,
    sessionsRoot,
    sessionHash,
    sessionRoot,
    workspace,
    hostHome,
    hostTmpDir,
    agentHome,
    agentTmpDir,
    configPath,
    identities,
  };
}

export async function assertCodexRuntimeLayout(layout: CodexRuntimeLayout): Promise<void> {
  for (const [path, identity] of Object.entries(layout.identities)) {
    await requirePrivateDirectory(path, `Codex runtime 目录 ${path}`, identity);
  }
  if (
    await readPrivateFileText(layout.configPath, "Codex 安全 config") !==
      codexRemoteConfig(layout.workspace)
  ) {
    throw new Error(`Codex 安全 config 已漂移，拒绝继续执行：${layout.configPath}`);
  }
}

function assertExecutableInfo(info: Stats, path: string): void {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    (info.mode & 0o111) === 0 ||
    (info.mode & 0o022) !== 0 ||
    (currentUid !== null && info.uid !== 0 && info.uid !== currentUid)
  ) {
    throw new Error(
      `Codex command 必须是当前用户或 root 持有、不可被 group/other 写入、单 link 的可执行普通文件：${path}`,
    );
  }
}

function executableInfoMatches(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function hashExecutableHandle(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
): Promise<string> {
  const hasher = createHash("sha256");
  const buffer = new Uint8Array(1024 * 1024);
  let position = 0;
  while (position < size) {
    const length = Math.min(buffer.byteLength, size - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead <= 0) throw new Error("Codex command 在摘要计算期间提前 EOF");
    hasher.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  const trailing = await handle.read(buffer, 0, 1, position);
  if (trailing.bytesRead !== 0) {
    throw new Error("Codex command 在摘要计算期间长度发生变化");
  }
  return hasher.digest("hex");
}

async function capturePinnedCodexCommand(path: string): Promise<PinnedCodexCommand> {
  const pathInfo = await lstat(path);
  assertExecutableInfo(pathInfo, path);
  if (await realpath(path) !== path) {
    throw new Error(`Codex command canonical 路径已变化：${path}`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const openedInfo = await handle.stat();
    assertExecutableInfo(openedInfo, path);
    if (!executableInfoMatches(pathInfo, openedInfo)) {
      throw new Error(`Codex command 在打开期间文件身份已变化：${path}`);
    }
    const contentSha256 = await hashExecutableHandle(handle, openedInfo.size);
    const finalOpenedInfo = await handle.stat();
    const finalPathInfo = await lstat(path);
    assertExecutableInfo(finalOpenedInfo, path);
    assertExecutableInfo(finalPathInfo, path);
    if (
      !executableInfoMatches(openedInfo, finalOpenedInfo) ||
      !executableInfoMatches(openedInfo, finalPathInfo) ||
      await realpath(path) !== path
    ) {
      throw new Error(`Codex command 在摘要计算期间文件身份已变化：${path}`);
    }
    const identitySha256 = sha256(JSON.stringify([
      "livis-codex-command-identity-v1",
      path,
      openedInfo.dev,
      openedInfo.ino,
      openedInfo.mode,
      openedInfo.nlink,
      openedInfo.uid,
      openedInfo.gid,
      openedInfo.size,
      openedInfo.mtimeMs,
      openedInfo.ctimeMs,
      contentSha256,
    ]));
    return {
      path,
      dev: openedInfo.dev,
      ino: openedInfo.ino,
      mode: openedInfo.mode,
      nlink: openedInfo.nlink,
      uid: openedInfo.uid,
      gid: openedInfo.gid,
      size: openedInfo.size,
      mtimeMs: openedInfo.mtimeMs,
      ctimeMs: openedInfo.ctimeMs,
      contentSha256,
      identitySha256,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Codex 自身运行在 agent sandbox 外，不能依赖 PATH 或 workspace 内可改写的 argv[0]。
 * 允许 Homebrew 等可信绝对 symlink，但实际 spawn 固定使用解析出的 canonical file，
 * 并绑定单 link、dev/ino、权限、时间戳、长度和完整内容摘要。
 */
export async function pinCodexCommand(
  layout: CodexRuntimeLayout,
  command: string,
): Promise<PinnedCodexCommand> {
  if (!isAbsolute(command)) throw new Error("Codex command 必须是绝对路径");
  const configured = resolve(command);
  if (isWithin(layout.stateDir, configured)) {
    throw new Error("Codex command 不能位于 daemon stateDir 内");
  }
  const canonical = await realpath(configured);
  if (isWithin(layout.stateDir, canonical)) {
    throw new Error("Codex command realpath 不能位于 daemon stateDir 内");
  }
  return capturePinnedCodexCommand(canonical);
}

export async function assertPinnedCodexCommand(pin: PinnedCodexCommand): Promise<void> {
  const current = await capturePinnedCodexCommand(pin.path);
  if (current.identitySha256 !== pin.identitySha256) {
    throw new Error(
      `Codex command 文件身份或内容摘要已漂移：${pin.path} ` +
        `(expected=${pin.identitySha256}, actual=${current.identitySha256})`,
    );
  }
}

export function codexSecurityBindingSha256(
  layout: CodexRuntimeLayout,
  command: PinnedCodexCommand | null,
): string {
  const configSha256 = sha256(codexRemoteConfig(layout.workspace));
  if (command === null) return configSha256;
  return sha256(JSON.stringify([
    "livis-codex-security-binding-v2",
    configSha256,
    command.identitySha256,
  ]));
}

export async function resolveCodexCommand(
  layout: CodexRuntimeLayout,
  command: string,
): Promise<string> {
  return (await pinCodexCommand(layout, command)).path;
}

export async function buildCodexEnvironment(
  layout: CodexRuntimeLayout,
  source: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string>> {
  const environment: Record<string, string> = {};
  const safePathEntries: string[] = [];
  for (const entry of (source.PATH ?? "").split(delimiter)) {
    if (entry.length === 0 || !isAbsolute(entry)) continue;
    const resolved = resolve(entry);
    if (isWithin(layout.stateDir, resolved)) continue;
    try {
      const canonical = await realpath(resolved);
      const info = await stat(canonical);
      if (!info.isDirectory() || isWithin(layout.stateDir, canonical)) continue;
      if (!safePathEntries.includes(canonical)) safePathEntries.push(canonical);
    } catch {
      // 不存在、无权读取或无法 canonicalize 的 PATH 段都不交给 app-server。
    }
  }
  if (safePathEntries.length > 0) environment.PATH = safePathEntries.join(delimiter);
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "NO_COLOR"] as const) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.HOME = layout.hostHome;
  environment.TMPDIR = layout.hostTmpDir;
  environment.CODEX_HOME = layout.codexHome;
  return environment;
}
