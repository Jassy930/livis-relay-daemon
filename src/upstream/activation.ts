import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseRelayConfig, type RelayConfig } from "../config.ts";
import type { RelayIdentity } from "../identity.ts";
import {
  parseProtocolProfile,
  resolveProfilePath,
  runtimeContractSha256,
  type ProtocolProfile,
} from "../protocol/profile.ts";
import {
  requirePrivateDirectory,
  type ProfileOperationGuard,
} from "../state/offline-guard.ts";
import {
  durableAtomicWritePrivate,
  durableMkdirPrivate,
  durableRename,
  durableUnlink,
  parseJsonObject,
  readOptionalPrivateFileText,
  readPrivateFileText as readVerifiedPrivateText,
  sha256,
} from "../util.ts";
import type { UpstreamSnapshot } from "./checker.ts";
import { saveSupportedProof, supportedProofPath } from "./proof.ts";

export interface ProfileActivationReceipt {
  schemaVersion: 1;
  activatedAt: string;
  configPath: string;
  sourceProfilePath: string;
  backupConfigPath: string;
  configCommitSha256: string;
  previous: {
    profileId: string;
    profilePath: string;
    profileSha256: string;
  };
  activated: {
    profileId: string;
    profilePath: string;
    profileSha256: string;
  };
  upstream: UpstreamSnapshot;
  restartRequired: true;
}

export interface ProfileConfigTransactionHooks {
  /** 仅供托管目录 fsync 故障注入测试；生产调用不传。 */
  syncManagedDirectory?: (path: string) => Promise<void>;
  /** 仅供故障注入测试；生产调用不传。 */
  beforeConfigRename?: (context: { stagingPath: string; targetText: string }) => void | Promise<void>;
  /** 仅供故障注入测试；生产调用不传。 */
  afterConfigRename?: (context: { configPath: string; targetText: string }) => void | Promise<void>;
  /** 仅供故障注入测试；生产调用不传。 */
  beforeConfigCompensation?: (context: { configPath: string; targetText: string }) => void | Promise<void>;
}

export class ProfileActivationRollbackError extends AggregateError {
  readonly backupConfigPath: string;

  constructor(activationError: unknown, rollbackErrors: unknown[], backupConfigPath: string) {
    super(
      [activationError, ...rollbackErrors],
      `profile 激活失败，且精确补偿未全部完成；请使用配置备份人工恢复：${backupConfigPath}`,
    );
    this.name = "ProfileActivationRollbackError";
    this.backupConfigPath = backupConfigPath;
  }
}

export class ProfileRollbackCompensationError extends AggregateError {
  readonly preRollbackBackupPath: string;

  constructor(rollbackError: unknown, compensationError: unknown, preRollbackBackupPath: string) {
    super(
      [rollbackError, compensationError],
      `profile config 回滚失败，且无法确认已恢复操作前配置；请人工检查：${preRollbackBackupPath}`,
    );
    this.name = "ProfileRollbackCompensationError";
    this.preRollbackBackupPath = preRollbackBackupPath;
  }
}

interface PrivateFileSnapshot {
  path: string;
  text: string | null;
}

interface WrittenPrivateFile {
  snapshot: PrivateFileSnapshot;
  writtenText: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function assertProfileStateDirOverrideAbsent(): void {
  if (process.env.LIVIS_RELAY_STATE_DIR !== undefined) {
    throw new Error(
      "upstream profile 激活/回滚禁止使用 LIVIS_RELAY_STATE_DIR 覆盖；必须以磁盘 config.stateDir 为准",
    );
  }
}

async function readOptionalText(path: string): Promise<string | null> {
  return readOptionalPrivateFileText(path, "事务私有文件");
}

async function ensureManagedPrivateDirectories(options: {
  paths: string[];
  stateDir: string;
  guard: ProfileOperationGuard;
  syncDirectory?: (path: string) => Promise<void>;
}): Promise<void> {
  for (const path of options.paths) {
    await options.guard.assertHeldForStateDir(options.stateDir);
    await durableMkdirPrivate(path, { syncDirectory: options.syncDirectory });
    await options.guard.assertHeldForStateDir(options.stateDir);
  }
}

async function writeDurableExact(options: {
  path: string;
  text: string;
  stateDir: string;
  guard: ProfileOperationGuard;
}): Promise<void> {
  await options.guard.assertHeldForStateDir(options.stateDir);
  await durableAtomicWritePrivate(options.path, options.text);
  await options.guard.assertHeldForStateDir(options.stateDir);
  if (await readOptionalText(options.path) !== options.text) {
    throw new Error(`私有文件写后读回不一致：${options.path}`);
  }
}

async function restoreWrittenPrivateFile(options: {
  file: WrittenPrivateFile;
  stateDir: string;
  guard: ProfileOperationGuard;
}): Promise<void> {
  const { snapshot, writtenText } = options.file;
  const current = await readOptionalText(snapshot.path);
  if (current === snapshot.text) return;
  if (current !== writtenText) {
    throw new Error(`补偿期间检测到并发文件修改，拒绝覆盖：${snapshot.path}`);
  }
  await options.guard.assertHeldForStateDir(options.stateDir);
  if (snapshot.text === null) {
    await durableUnlink(snapshot.path);
  } else {
    await durableAtomicWritePrivate(snapshot.path, snapshot.text);
  }
  await options.guard.assertHeldForStateDir(options.stateDir);
  if (await readOptionalText(snapshot.path) !== snapshot.text) {
    throw new Error(`补偿读回不一致：${snapshot.path}`);
  }
}

interface ConfigDirectoryLease {
  sourcePath: string;
  path: string;
  dev: number;
  ino: number;
}

interface PrivateStagingFileLease {
  path: string;
  text: string;
  handle: FileHandle;
  dev: number;
  ino: number;
  directory: ConfigDirectoryLease;
  state: "linked" | "renamed" | "released";
}

async function assertConfigStateDirBoundary(options: {
  configPath: string;
  configText: string;
  effectiveStateDir: string;
  guard: ProfileOperationGuard;
}): Promise<string> {
  const diskConfig = parseRelayConfig(options.configText, options.configPath);
  const [diskStateDir, effectiveStateDir] = await Promise.all([
    requirePrivateDirectory(diskConfig.stateDir, "磁盘 config.stateDir"),
    requirePrivateDirectory(options.effectiveStateDir, "effective stateDir"),
  ]);
  if (diskStateDir !== effectiveStateDir) {
    throw new Error(
      `磁盘 config.stateDir 与 effective stateDir 不一致，拒绝隐式迁移：${diskStateDir} != ${effectiveStateDir}`,
    );
  }
  await options.guard.assertHeldForStateDir(effectiveStateDir);
  if (dirname(options.guard.path) !== effectiveStateDir) {
    throw new Error("profile operation guard 不属于磁盘 config.stateDir");
  }
  return diskStateDir;
}

async function assertStateDirAliasStillCanonical(
  rawStateDir: string,
  canonicalStateDir: string,
): Promise<void> {
  if (await requirePrivateDirectory(rawStateDir, "磁盘 config.stateDir") !== canonicalStateDir) {
    throw new Error("磁盘 config.stateDir 的 canonical 目标在事务期间发生变化");
  }
}

function assertPrivateDirectoryInfo(
  info: Stats,
  expected: { dev: number; ino: number },
  path: string,
): void {
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    info.dev !== expected.dev ||
    info.ino !== expected.ino
  ) {
    throw new Error(`config parent directory 类型、权限或 inode 已变化：${path}`);
  }
}

async function acquireConfigDirectory(configPath: string): Promise<ConfigDirectoryLease> {
  const sourcePath = dirname(resolve(configPath));
  const path = await requirePrivateDirectory(sourcePath, "config parent directory");
  if (path !== sourcePath) {
    throw new Error(`config parent directory 不能包含 symlink 祖先：${sourcePath}`);
  }
  const info = await lstat(path);
  const lease = { sourcePath, path, dev: info.dev, ino: info.ino };
  assertPrivateDirectoryInfo(info, lease, path);
  return lease;
}

async function assertConfigDirectory(lease: ConfigDirectoryLease): Promise<void> {
  const current = await requirePrivateDirectory(lease.sourcePath, "config parent directory");
  if (current !== lease.path) {
    throw new Error(`config parent directory realpath 已变化：${lease.sourcePath}`);
  }
  assertPrivateDirectoryInfo(await lstat(lease.path), lease, lease.path);
}

function assertPrivateStagingInfo(
  info: Stats,
  lease: Pick<PrivateStagingFileLease, "dev" | "ino" | "path">,
): void {
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.nlink !== 1 ||
    (info.mode & 0o777) !== 0o600 ||
    info.dev !== lease.dev ||
    info.ino !== lease.ino
  ) {
    throw new Error(`config staging 文件类型、权限或 inode 已变化：${lease.path}`);
  }
}

async function readStagingHandle(lease: PrivateStagingFileLease): Promise<string> {
  const expected = Buffer.from(lease.text, "utf8");
  const actual = Buffer.alloc(expected.byteLength);
  let offset = 0;
  while (offset < actual.byteLength) {
    const { bytesRead } = await lease.handle.read(
      actual,
      offset,
      actual.byteLength - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  const info = await lease.handle.stat();
  if (offset !== expected.byteLength || info.size !== expected.byteLength || !actual.equals(expected)) {
    throw new Error(`config staging 文件内容已变化：${lease.path}`);
  }
  return actual.toString("utf8");
}

async function assertPrivateStagingFile(lease: PrivateStagingFileLease): Promise<void> {
  if (lease.state !== "linked") {
    throw new Error(`config staging 文件已不在 linked 状态：${lease.path}`);
  }
  await assertConfigDirectory(lease.directory);
  assertPrivateStagingInfo(await lease.handle.stat(), lease);
  assertPrivateStagingInfo(await lstat(lease.path), lease);
  await readStagingHandle(lease);
  assertPrivateStagingInfo(await lease.handle.stat(), lease);
  assertPrivateStagingInfo(await lstat(lease.path), lease);
}

async function syncPrivateDirectory(lease: ConfigDirectoryLease): Promise<void> {
  await assertConfigDirectory(lease);
  const handle = await open(
    lease.path,
    constants.O_RDONLY |
      constants.O_DIRECTORY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
  );
  try {
    assertPrivateDirectoryInfo(await handle.stat(), lease, lease.path);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await assertConfigDirectory(lease);
}

async function createPrivateStagingFile(options: {
  path: string;
  text: string;
  directory: ConfigDirectoryLease;
  stateDir: string;
  guard: ProfileOperationGuard;
}): Promise<PrivateStagingFileLease> {
  await options.guard.assertHeldForStateDir(options.stateDir);
  await assertConfigDirectory(options.directory);
  const path = resolve(options.path);
  if (dirname(path) !== options.directory.path) {
    throw new Error(`config staging 必须位于已验证的 config parent directory：${path}`);
  }
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  let lease: PrivateStagingFileLease | null = null;
  try {
    const initial = await handle.stat();
    lease = {
      path,
      text: options.text,
      handle,
      dev: initial.dev,
      ino: initial.ino,
      directory: options.directory,
      state: "linked",
    };
    await handle.chmod(0o600);
    assertPrivateStagingInfo(await handle.stat(), lease);
    await handle.writeFile(options.text, "utf8");
    await handle.sync();
    await assertPrivateStagingFile(lease);
    await syncPrivateDirectory(options.directory);
    await options.guard.assertHeldForStateDir(options.stateDir);
    return lease;
  } catch (error) {
    if (lease) {
      await releasePrivateStagingFile(lease).catch(() => undefined);
    } else {
      await handle.close().catch(() => undefined);
    }
    throw error;
  }
}

async function commitPrivateStagingFile(options: {
  lease: PrivateStagingFileLease;
  configPath: string;
  stateDir: string;
  guard: ProfileOperationGuard;
}): Promise<void> {
  await options.guard.assertHeldForStateDir(options.stateDir);
  await assertPrivateStagingFile(options.lease);
  const destination = join(options.lease.directory.path, basename(options.configPath));
  await durableRename(options.lease.path, destination, {
    expectedSource: options.lease,
    syncDirectory: async (path) => {
      if (resolve(path) !== options.lease.directory.path) {
        throw new Error(`config durable rename 尝试同步未知目录：${path}`);
      }
      await syncPrivateDirectory(options.lease.directory);
    },
  });
  options.lease.state = "renamed";
  await options.guard.assertHeldForStateDir(options.stateDir);
}

async function releasePrivateStagingFile(lease: PrivateStagingFileLease): Promise<void> {
  if (lease.state === "released") return;
  let cleanupError: unknown;
  try {
    if (lease.state === "linked") {
      await assertPrivateStagingFile(lease);
      await unlink(lease.path);
      await syncPrivateDirectory(lease.directory);
    }
  } catch (error) {
    cleanupError = error;
  } finally {
    await lease.handle.close().catch(() => undefined);
    lease.state = "released";
  }
  if (cleanupError) throw cleanupError;
}

async function verifyProfileSelection(options: {
  configPath: string;
  configDirectory: ConfigDirectoryLease;
  expectedConfigIdentity: { dev: number; ino: number };
  rawStateDir: string;
  canonicalStateDir: string;
  expectedConfigText: string;
  expectedProfilePath: string;
  expectedProfileSha256: string;
  expectedProfileId: string;
}): Promise<void> {
  await assertStateDirAliasStillCanonical(options.rawStateDir, options.canonicalStateDir);
  await assertConfigDirectory(options.configDirectory);
  const configText = await readVerifiedPrivateText(
    options.configPath,
    "live config",
    options.expectedConfigIdentity,
  );
  if (configText !== options.expectedConfigText) {
    throw new Error("配置读回内容与预期完整字节不一致");
  }
  const config = parseRelayConfig(configText, options.configPath);
  await assertStateDirAliasStillCanonical(config.stateDir, options.canonicalStateDir);
  if (
    config.profile !== options.expectedProfilePath ||
    config.profileSha256 !== options.expectedProfileSha256
  ) {
    throw new Error("配置读回的 profile 路径或 SHA pin 与预期不一致");
  }
  const resolvedProfilePath = resolveProfilePath(config.profile, options.configPath);
  const profileText = await readVerifiedPrivateText(resolvedProfilePath, "active profile");
  if (sha256(profileText) !== config.profileSha256) {
    throw new Error("配置读回的 active profile 内容 SHA 不一致");
  }
  const profile = parseProtocolProfile(profileText, resolvedProfilePath);
  if (profile.id !== options.expectedProfileId) {
    throw new Error(`配置读回的 profile.id 不一致：${profile.id} != ${options.expectedProfileId}`);
  }
  await assertStateDirAliasStillCanonical(options.rawStateDir, options.canonicalStateDir);
}

async function compensateConfig(options: {
  configPath: string;
  configDirectory: ConfigDirectoryLease;
  currentText: string;
  failedTargetText: string;
  currentProfile: { path: string; sha256: string; id: string };
  stateDir: string;
  rawStateDir: string;
  operationId: string;
  guard: ProfileOperationGuard;
  hooks?: ProfileConfigTransactionHooks;
}): Promise<void> {
  await options.hooks?.beforeConfigCompensation?.({
    configPath: options.configPath,
    targetText: options.failedTargetText,
  });
  await options.guard.assertHeldForStateDir(options.stateDir);
  const liveText = await readVerifiedPrivateText(options.configPath, "live config");
  if (liveText !== options.currentText) {
    if (liveText !== options.failedTargetText) {
      throw new Error("失败补偿发现并发 config，拒绝覆盖，必须人工检查");
    }
    const stagingPath = join(
      options.configDirectory.path,
      `.${basename(options.configPath)}.${options.operationId}-${randomUUID()}.compensating`,
    );
    let stagingLease: PrivateStagingFileLease | null = null;
    try {
      stagingLease = await createPrivateStagingFile({
        path: stagingPath,
        text: options.currentText,
        directory: options.configDirectory,
        stateDir: options.stateDir,
        guard: options.guard,
      });
      await options.guard.assertHeldForStateDir(options.stateDir);
      if (
        await readVerifiedPrivateText(options.configPath, "live config") !==
          options.failedTargetText
      ) {
        throw new Error("失败补偿提交前发现并发 config，拒绝覆盖，必须人工检查");
      }
      await commitPrivateStagingFile({
        lease: stagingLease,
        configPath: options.configPath,
        stateDir: options.stateDir,
        guard: options.guard,
      });
    } finally {
      if (stagingLease) {
        await releasePrivateStagingFile(stagingLease).catch(() => undefined);
      }
    }
  }
  await options.guard.assertHeldForStateDir(options.stateDir);
  const restoredConfigInfo = await lstat(options.configPath);
  await verifyProfileSelection({
    configPath: options.configPath,
    configDirectory: options.configDirectory,
    expectedConfigIdentity: restoredConfigInfo,
    rawStateDir: options.rawStateDir,
    canonicalStateDir: options.stateDir,
    expectedConfigText: options.currentText,
    expectedProfilePath: options.currentProfile.path,
    expectedProfileSha256: options.currentProfile.sha256,
    expectedProfileId: options.currentProfile.id,
  });
}

function profileFileName(profileId: string): string {
  const slug = profileId.replace(/[^0-9A-Za-z._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("profile.id 无法转换为安全文件名");
  return `${slug}.json`;
}

export function validateProfileActivation(options: {
  activeProfile: ProtocolProfile;
  candidateProfile: ProtocolProfile;
  identity: RelayIdentity;
  liveSnapshot: UpstreamSnapshot;
}): void {
  const { activeProfile, candidateProfile, identity, liveSnapshot } = options;
  if (liveSnapshot.compatibility !== "supported" || liveSnapshot.matchedProfileId !== candidateProfile.id) {
    throw new Error("候选 profile 未通过当前上游的版本、URL、哈希和 marker 全量复核");
  }
  if (liveSnapshot.activeProfileId !== candidateProfile.id) {
    throw new Error("上游复核不是以候选 profile 为 active profile 执行");
  }
  if (!identity.agentId.startsWith(candidateProfile.wireIdentity.agentIdPrefix)) {
    throw new Error("候选 profile 的 agentIdPrefix 与现有 LiViS identity 不兼容");
  }
  if (!identity.deviceId.startsWith(candidateProfile.wireIdentity.deviceIdPrefix)) {
    throw new Error("候选 profile 的 deviceIdPrefix 与现有 LiViS identity 不兼容");
  }
  if (runtimeContractSha256(candidateProfile) !== runtimeContractSha256(activeProfile)) {
    throw new Error(
      "候选 profile 改变了 IDaaS/relay/OAuth/wire/timing 运行契约；当前 daemon 只允许兼容更新，契约变化必须随新版 daemon 审核发布",
    );
  }
  if (candidateProfile.id === activeProfile.id && candidateProfile.officialPluginVersion !== activeProfile.officialPluginVersion) {
    throw new Error("版本变化必须使用新的 profile.id，不能覆盖既有审核身份");
  }
}

export async function activateReviewedProfile(options: {
  configPath: string;
  expectedConfigText: string;
  config: RelayConfig;
  activeProfile: ProtocolProfile;
  candidateProfile: ProtocolProfile;
  candidateSourcePath: string;
  identity: RelayIdentity;
  liveSnapshot: UpstreamSnapshot;
  guard: ProfileOperationGuard;
  transactionHooks?: ProfileConfigTransactionHooks;
}): Promise<{ receipt: ProfileActivationReceipt; receiptPath: string; supportedProofPath: string }> {
  assertProfileStateDirOverrideAbsent();
  validateProfileActivation(options);
  await options.guard.assertHeldForStateDir(options.config.stateDir);
  const configDirectory = await acquireConfigDirectory(options.configPath);
  const activatedAt = new Date().toISOString();
  const operationId = `${activatedAt.replace(/[:.]/g, "-")}-${randomUUID()}`;
  const profileText = `${JSON.stringify(options.candidateProfile, null, 2)}\n`;
  const profileHash = sha256(profileText);
  const originalConfigText = await readVerifiedPrivateText(options.configPath, "live config");
  if (originalConfigText !== options.expectedConfigText) {
    throw new Error("配置在激活期间发生变化，拒绝覆盖");
  }
  const canonicalStateDir = await assertConfigStateDirBoundary({
    configPath: options.configPath,
    configText: originalConfigText,
    effectiveStateDir: options.config.stateDir,
    guard: options.guard,
  });
  const configRoot = parseJsonObject(originalConfigText, options.configPath);
  if (
    configRoot.profile !== options.config.profile ||
    configRoot.profileSha256 !== options.config.profileSha256
  ) {
    throw new Error("配置在激活期间发生变化，拒绝覆盖");
  }
  const activeProfilePath = resolveProfilePath(options.config.profile, options.configPath);
  const activeProfileText = await readVerifiedPrivateText(activeProfilePath, "当前 active profile");
  if (sha256(activeProfileText) !== options.config.profileSha256) {
    throw new Error("当前 active profile 内容 SHA 与配置不一致");
  }
  if (parseProtocolProfile(activeProfileText, activeProfilePath).id !== options.activeProfile.id) {
    throw new Error("当前 active profile 身份与激活上下文不一致");
  }

  await ensureManagedPrivateDirectories({
    paths: [
      join(canonicalStateDir, "protocol-profiles"),
      join(canonicalStateDir, "config-backups"),
      join(canonicalStateDir, "upstream"),
      join(canonicalStateDir, "upstream", "proofs"),
      join(canonicalStateDir, "upstream-approvals"),
    ],
    stateDir: canonicalStateDir,
    guard: options.guard,
    syncDirectory: options.transactionHooks?.syncManagedDirectory,
  });

  const installedProfilePath = join(
    canonicalStateDir,
    "protocol-profiles",
    profileFileName(options.candidateProfile.id),
  );
  const existingProfileText = await readOptionalPrivateFileText(
    installedProfilePath,
    "已安装候选 profile",
  );
  if (existingProfileText === null) {
    await writeDurableExact({
      path: installedProfilePath,
      text: profileText,
      stateDir: canonicalStateDir,
      guard: options.guard,
    });
  } else if (sha256(existingProfileText) !== profileHash) {
    throw new Error(`已存在同名但内容不同的审核 profile，拒绝覆盖：${installedProfilePath}`);
  }
  const installedProfileText = await readVerifiedPrivateText(
    installedProfilePath,
    "已安装候选 profile",
  );
  if (sha256(installedProfileText) !== profileHash) {
    throw new Error("安装后的候选 profile 内容 SHA 不一致");
  }
  const installedProfile = parseProtocolProfile(installedProfileText, installedProfilePath);
  if (installedProfile.id !== options.candidateProfile.id) {
    throw new Error("安装后的候选 profile 读回身份不一致");
  }

  configRoot.profile = installedProfilePath;
  configRoot.profileSha256 = profileHash;
  const activatedConfigText = `${JSON.stringify(configRoot, null, 2)}\n`;
  const activatedConfigSha256 = sha256(activatedConfigText);
  const backupConfigPath = join(canonicalStateDir, "config-backups", `${operationId}.json`);
  await writeDurableExact({
    path: backupConfigPath,
    text: originalConfigText,
    stateDir: canonicalStateDir,
    guard: options.guard,
  });

  const receipt: ProfileActivationReceipt = {
    schemaVersion: 1,
    activatedAt,
    configPath: resolve(options.configPath),
    sourceProfilePath: resolve(options.candidateSourcePath),
    backupConfigPath,
    configCommitSha256: activatedConfigSha256,
    previous: {
      profileId: options.activeProfile.id,
      profilePath: options.config.profile,
      profileSha256: options.config.profileSha256,
    },
    activated: {
      profileId: options.candidateProfile.id,
      profilePath: installedProfilePath,
      profileSha256: profileHash,
    },
    upstream: options.liveSnapshot,
    restartRequired: true,
  };
  const receiptPath = join(
    canonicalStateDir,
    "upstream-approvals",
    `${operationId}-${profileFileName(options.candidateProfile.id)}`,
  );
  const proofPath = supportedProofPath(canonicalStateDir, profileHash);
  const proofAliasPath = supportedProofPath(canonicalStateDir);
  const managedSnapshots = new Map<string, PrivateFileSnapshot>();
  for (const path of [proofPath, proofAliasPath, receiptPath]) {
    managedSnapshots.set(path, { path, text: await readOptionalText(path) });
  }
  const writtenFiles: WrittenPrivateFile[] = [];
  const stagingPath = join(
    configDirectory.path,
    `.${basename(options.configPath)}.${operationId}.staged`,
  );
  let stagingLease: PrivateStagingFileLease | null = null;
  let configCommitAttempted = false;

  try {
    const supportedProof = await saveSupportedProof({
      stateDir: canonicalStateDir,
      profile: options.candidateProfile,
      profileSha256: profileHash,
      snapshot: options.liveSnapshot,
      testHooks: {
        syncManagedDirectory: options.transactionHooks?.syncManagedDirectory,
      },
    }, options.guard);
    const proofText = `${JSON.stringify(supportedProof.proof, null, 2)}\n`;
    writtenFiles.push(
      { snapshot: managedSnapshots.get(proofPath)!, writtenText: proofText },
      { snapshot: managedSnapshots.get(proofAliasPath)!, writtenText: proofText },
    );

    const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;
    writtenFiles.push({ snapshot: managedSnapshots.get(receiptPath)!, writtenText: receiptText });
    await writeDurableExact({
      path: receiptPath,
      text: receiptText,
      stateDir: canonicalStateDir,
      guard: options.guard,
    });
    stagingLease = await createPrivateStagingFile({
      path: stagingPath,
      text: activatedConfigText,
      directory: configDirectory,
      stateDir: canonicalStateDir,
      guard: options.guard,
    });

    await options.transactionHooks?.beforeConfigRename?.({
      stagingPath,
      targetText: activatedConfigText,
    });
    await options.guard.assertHeldForStateDir(canonicalStateDir);
    await assertStateDirAliasStillCanonical(options.config.stateDir, canonicalStateDir);
    if (await readVerifiedPrivateText(options.configPath, "live config") !== originalConfigText) {
      throw new Error("配置在激活提交前发生变化，拒绝覆盖");
    }
    if (
      sha256(await readVerifiedPrivateText(installedProfilePath, "已安装候选 profile")) !==
        profileHash
    ) {
      throw new Error("候选 profile 在 config 提交前发生变化");
    }
    configCommitAttempted = true;
    await commitPrivateStagingFile({
      lease: stagingLease,
      configPath: options.configPath,
      stateDir: canonicalStateDir,
      guard: options.guard,
    });
    await options.transactionHooks?.afterConfigRename?.({
      configPath: options.configPath,
      targetText: activatedConfigText,
    });
    await options.guard.assertHeldForStateDir(canonicalStateDir);
    await verifyProfileSelection({
      configPath: options.configPath,
      configDirectory,
      expectedConfigIdentity: stagingLease,
      rawStateDir: options.config.stateDir,
      canonicalStateDir,
      expectedConfigText: activatedConfigText,
      expectedProfilePath: installedProfilePath,
      expectedProfileSha256: profileHash,
      expectedProfileId: options.candidateProfile.id,
    });
    return { receipt, receiptPath, supportedProofPath: supportedProof.path };
  } catch (activationError) {
    const rollbackFailures: unknown[] = [];
    let configCompensationFailed = false;
    if (configCommitAttempted) {
      try {
        await compensateConfig({
          configPath: options.configPath,
          configDirectory,
          currentText: originalConfigText,
          failedTargetText: activatedConfigText,
          currentProfile: {
            path: options.config.profile,
            sha256: options.config.profileSha256,
            id: options.activeProfile.id,
          },
          stateDir: canonicalStateDir,
          rawStateDir: options.config.stateDir,
          operationId,
          guard: options.guard,
          hooks: options.transactionHooks,
        });
      } catch (compensationError) {
        configCompensationFailed = true;
        rollbackFailures.push(compensationError);
      }
    } else if (writtenFiles.length > 0) {
      // 本操作尚未 rename，但不接入 guard 的外部 writer 可能已经把 config
      // 切到同一候选 profile。此时不能撤掉候选 proof/回执而制造无证据状态。
      try {
        const liveRoot = parseJsonObject(
          await readVerifiedPrivateText(options.configPath, "live config"),
          options.configPath,
        );
        if (
          liveRoot.profile === installedProfilePath &&
          liveRoot.profileSha256 === profileHash
        ) {
          configCompensationFailed = true;
          rollbackFailures.push(new Error("提交前发现外部 config 已指向候选 profile，保留前置证据并拒绝覆盖"));
        }
      } catch (inspectionError) {
        configCompensationFailed = true;
        rollbackFailures.push(new Error("提交前失败后无法判定 live config，保留前置证据", {
          cause: inspectionError,
        }));
      }
    }

    // live config 无法确认已恢复时保留候选 proof/审批回执，避免把可能已提交的
    // candidate config 进一步拆成缺少审计证据的状态。
    if (!configCompensationFailed) {
      for (const file of [...writtenFiles].reverse()) {
        try {
          await restoreWrittenPrivateFile({
            file,
            stateDir: canonicalStateDir,
            guard: options.guard,
          });
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      }
    }
    if (rollbackFailures.length > 0) {
      throw new ProfileActivationRollbackError(activationError, rollbackFailures, backupConfigPath);
    }
    if (configCommitAttempted) {
      throw new Error(
        `profile 激活失败，已精确恢复旧配置；配置备份：${backupConfigPath}；原因：${errorMessage(activationError)}`,
        { cause: activationError },
      );
    }
    throw activationError;
  } finally {
    if (stagingLease) {
      await releasePrivateStagingFile(stagingLease).catch(() => undefined);
    }
  }
}

export async function rollbackProfileConfig(options: {
  configPath: string;
  expectedConfigText: string;
  currentConfig: RelayConfig;
  currentProfile: ProtocolProfile;
  backupConfigPath: string;
  guard: ProfileOperationGuard;
  transactionHooks?: ProfileConfigTransactionHooks;
}): Promise<{
  restoredProfile: { id: string; path: string; sha256: string };
  preRollbackBackupPath: string;
  restartRequired: true;
}> {
  assertProfileStateDirOverrideAbsent();
  await options.guard.assertHeldForStateDir(options.currentConfig.stateDir);
  const configDirectory = await acquireConfigDirectory(options.configPath);
  const currentText = await readVerifiedPrivateText(options.configPath, "live config");
  if (currentText !== options.expectedConfigText) {
    throw new Error("配置在回滚期间发生变化，拒绝覆盖");
  }
  const canonicalStateDir = await assertConfigStateDirBoundary({
    configPath: options.configPath,
    configText: currentText,
    effectiveStateDir: options.currentConfig.stateDir,
    guard: options.guard,
  });
  const currentRoot = parseJsonObject(currentText, options.configPath);
  if (
    currentRoot.profile !== options.currentConfig.profile ||
    currentRoot.profileSha256 !== options.currentConfig.profileSha256
  ) {
    throw new Error("配置在回滚期间发生变化，拒绝覆盖");
  }

  const backupDirectoryPath = join(canonicalStateDir, "config-backups");
  const backupDirectory = await requirePrivateDirectory(
    backupDirectoryPath,
    "profile rollback backup directory",
  );
  if (backupDirectory !== backupDirectoryPath) {
    throw new Error("config-backups 不能包含 symlink 祖先");
  }
  const backupPath = resolve(options.backupConfigPath);
  if (dirname(backupPath) !== backupDirectory) {
    throw new Error("只允许从当前 stateDir/config-backups 恢复配置");
  }
  const backupText = await readVerifiedPrivateText(backupPath, "profile rollback 配置备份");
  const backupConfig = parseRelayConfig(backupText, options.configPath);
  if (
    await requirePrivateDirectory(backupConfig.stateDir, "配置备份 stateDir") !==
      canonicalStateDir
  ) {
    throw new Error("备份配置属于不同 stateDir，拒绝恢复");
  }
  const restoredProfilePath = resolveProfilePath(backupConfig.profile, options.configPath);
  const restoredProfileInfo = await lstat(restoredProfilePath);
  const restoredProfileIdentity = {
    dev: restoredProfileInfo.dev,
    ino: restoredProfileInfo.ino,
  };
  const restoredProfileText = await readVerifiedPrivateText(
    restoredProfilePath,
    "待恢复 profile",
    restoredProfileIdentity,
  );
  if (sha256(restoredProfileText) !== backupConfig.profileSha256) {
    throw new Error("待恢复 profile 内容 SHA 与配置备份不一致");
  }
  const restoredProfile = parseProtocolProfile(restoredProfileText, restoredProfilePath);
  currentRoot.profile = backupConfig.profile;
  currentRoot.profileSha256 = backupConfig.profileSha256;
  const rollbackConfigText = `${JSON.stringify(currentRoot, null, 2)}\n`;

  const operationId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  await ensureManagedPrivateDirectories({
    paths: [join(canonicalStateDir, "config-backups")],
    stateDir: canonicalStateDir,
    guard: options.guard,
    syncDirectory: options.transactionHooks?.syncManagedDirectory,
  });
  const preRollbackBackupPath = join(
    canonicalStateDir,
    "config-backups",
    `${operationId}-pre-rollback.json`,
  );
  await writeDurableExact({
    path: preRollbackBackupPath,
    text: currentText,
    stateDir: canonicalStateDir,
    guard: options.guard,
  });
  const stagingPath = join(
    configDirectory.path,
    `.${basename(options.configPath)}.${operationId}.rollback-staged`,
  );
  let stagingLease: PrivateStagingFileLease | null = null;
  let configCommitAttempted = false;
  try {
    stagingLease = await createPrivateStagingFile({
      path: stagingPath,
      text: rollbackConfigText,
      directory: configDirectory,
      stateDir: canonicalStateDir,
      guard: options.guard,
    });
    await options.transactionHooks?.beforeConfigRename?.({
      stagingPath,
      targetText: rollbackConfigText,
    });
    await options.guard.assertHeldForStateDir(canonicalStateDir);
    await assertStateDirAliasStillCanonical(
      options.currentConfig.stateDir,
      canonicalStateDir,
    );
    if (await readVerifiedPrivateText(options.configPath, "live config") !== currentText) {
      throw new Error("配置在回滚提交前发生变化，拒绝覆盖");
    }
    const commitRestoredProfileText = await readVerifiedPrivateText(
      restoredProfilePath,
      "待恢复 profile",
      restoredProfileIdentity,
    );
    if (
      sha256(commitRestoredProfileText) !== backupConfig.profileSha256 ||
      parseProtocolProfile(commitRestoredProfileText, restoredProfilePath).id !== restoredProfile.id
    ) {
      throw new Error("待恢复 profile 在回滚提交前发生变化，拒绝提交配置");
    }
    configCommitAttempted = true;
    await commitPrivateStagingFile({
      lease: stagingLease,
      configPath: options.configPath,
      stateDir: canonicalStateDir,
      guard: options.guard,
    });
    await options.transactionHooks?.afterConfigRename?.({
      configPath: options.configPath,
      targetText: rollbackConfigText,
    });
    await options.guard.assertHeldForStateDir(canonicalStateDir);
    await verifyProfileSelection({
      configPath: options.configPath,
      configDirectory,
      expectedConfigIdentity: stagingLease,
      rawStateDir: options.currentConfig.stateDir,
      canonicalStateDir,
      expectedConfigText: rollbackConfigText,
      expectedProfilePath: backupConfig.profile,
      expectedProfileSha256: backupConfig.profileSha256,
      expectedProfileId: restoredProfile.id,
    });
    return {
      restoredProfile: {
        id: restoredProfile.id,
        path: backupConfig.profile,
        sha256: backupConfig.profileSha256,
      },
      preRollbackBackupPath,
      restartRequired: true,
    };
  } catch (rollbackError) {
    if (configCommitAttempted) {
      try {
        await compensateConfig({
          configPath: options.configPath,
          configDirectory,
          currentText,
          failedTargetText: rollbackConfigText,
          currentProfile: {
            path: options.currentConfig.profile,
            sha256: options.currentConfig.profileSha256,
            id: options.currentProfile.id,
          },
          stateDir: canonicalStateDir,
          rawStateDir: options.currentConfig.stateDir,
          operationId,
          guard: options.guard,
          hooks: options.transactionHooks,
        });
      } catch (compensationError) {
        throw new ProfileRollbackCompensationError(
          rollbackError,
          compensationError,
          preRollbackBackupPath,
        );
      }
      throw new Error(
        `profile config 回滚失败，已精确恢复操作前配置；原因：${errorMessage(rollbackError)}`,
        { cause: rollbackError },
      );
    }
    throw rollbackError;
  } finally {
    if (stagingLease) {
      await releasePrivateStagingFile(stagingLease).catch(() => undefined);
    }
  }
}
