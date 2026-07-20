import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { parseRelayConfig, type RelayConfig } from "../config.ts";
import type { RelayIdentity } from "../identity.ts";
import {
  loadProtocolProfile,
  runtimeContractSha256,
  type ProtocolProfile,
} from "../protocol/profile.ts";
import { atomicWritePrivate, parseJsonObject, sha256 } from "../util.ts";
import type { UpstreamSnapshot } from "./checker.ts";
import { saveSupportedProof, supportedProofPath } from "./proof.ts";
import { type UpstreamStateLock, withUpstreamStateLock } from "./state-lock.ts";

export interface ProfileActivationReceipt {
  schemaVersion: 1;
  activatedAt: string;
  configPath: string;
  sourceProfilePath: string;
  backupConfigPath: string;
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

export class ProfileActivationRollbackError extends AggregateError {
  readonly backupConfigPath: string;

  constructor(activationError: unknown, rollbackError: unknown, backupConfigPath: string) {
    super(
      [activationError, rollbackError],
      `profile 激活失败，且自动恢复旧状态失败；请使用配置备份人工恢复：${backupConfigPath}`,
    );
    this.name = "ProfileActivationRollbackError";
    this.backupConfigPath = backupConfigPath;
  }
}

interface PrivateFileSnapshot {
  path: string;
  text: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function snapshotPrivateFile(path: string): Promise<PrivateFileSnapshot> {
  return {
    path,
    text: existsSync(path) ? await Bun.file(path).text() : null,
  };
}

async function restorePrivateFile(snapshot: PrivateFileSnapshot): Promise<void> {
  if (snapshot.text !== null) {
    await atomicWritePrivate(snapshot.path, snapshot.text);
    return;
  }
  if (existsSync(snapshot.path)) {
    await unlink(snapshot.path);
  }
}

async function restorePrivateFiles(snapshots: PrivateFileSnapshot[]): Promise<void> {
  const failures: unknown[] = [];
  for (const snapshot of [...snapshots].reverse()) {
    try {
      await restorePrivateFile(snapshot);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "无法恢复 profile 激活写入的 proof 或审批回执");
  }
}

async function verifyProfileSelection(options: {
  configPath: string;
  expectedProfilePath: string;
  expectedProfileSha256: string;
  expectedProfileId: string;
  expectedConfigText?: string;
}): Promise<void> {
  const configText = await Bun.file(options.configPath).text();
  if (options.expectedConfigText !== undefined && configText !== options.expectedConfigText) {
    throw new Error("恢复后的配置内容与激活前备份不一致");
  }
  const config = parseRelayConfig(configText, options.configPath);
  if (
    config.profile !== options.expectedProfilePath ||
    config.profileSha256 !== options.expectedProfileSha256
  ) {
    throw new Error("配置读回的 profile 路径或 SHA pin 与预期不一致");
  }
  const profile = await loadProtocolProfile(
    config.profile,
    options.configPath,
    config.profileSha256,
  );
  if (profile.id !== options.expectedProfileId) {
    throw new Error(`配置读回的 profile.id 不一致：${profile.id} != ${options.expectedProfileId}`);
  }
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

interface ReviewedProfileActivationOptions {
  configPath: string;
  expectedConfigText: string;
  config: RelayConfig;
  activeProfile: ProtocolProfile;
  candidateProfile: ProtocolProfile;
  candidateSourcePath: string;
  identity: RelayIdentity;
  liveSnapshot: UpstreamSnapshot;
}

interface ReviewedProfileActivationResult {
  receipt: ProfileActivationReceipt;
  receiptPath: string;
  supportedProofPath: string;
}

async function activateReviewedProfileLocked(
  options: ReviewedProfileActivationOptions,
  lock: UpstreamStateLock,
): Promise<ReviewedProfileActivationResult> {
  const activatedAt = new Date().toISOString();
  const stamp = activatedAt.replace(/[:.]/g, "-");
  const activationId = `${stamp}-${crypto.randomUUID()}`;
  const profileText = `${JSON.stringify(options.candidateProfile, null, 2)}\n`;
  const profileHash = sha256(profileText);
  const originalConfigText = await Bun.file(options.configPath).text();
  if (originalConfigText !== options.expectedConfigText) {
    throw new Error("配置在激活期间发生变化，拒绝覆盖");
  }
  const configRoot = parseJsonObject(originalConfigText, options.configPath);
  if (
    configRoot.profile !== options.config.profile ||
    configRoot.profileSha256 !== options.config.profileSha256
  ) {
    throw new Error("配置在激活期间发生变化，拒绝覆盖");
  }
  const installedProfilePath = join(
    options.config.stateDir,
    "protocol-profiles",
    profileFileName(options.candidateProfile.id),
  );
  if (existsSync(installedProfilePath)) {
    const existingHash = sha256(await Bun.file(installedProfilePath).text());
    if (existingHash !== profileHash) {
      throw new Error(`已存在同名但内容不同的审核 profile，拒绝覆盖：${installedProfilePath}`);
    }
  } else {
    await atomicWritePrivate(installedProfilePath, profileText);
  }

  const backupConfigPath = join(options.config.stateDir, "config-backups", `${activationId}.json`);
  await atomicWritePrivate(backupConfigPath, originalConfigText);

  const receipt: ProfileActivationReceipt = {
    schemaVersion: 1,
    activatedAt,
    configPath: resolve(options.configPath),
    sourceProfilePath: resolve(options.candidateSourcePath),
    backupConfigPath,
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
    options.config.stateDir,
    "upstream-approvals",
    `${activationId}-${profileFileName(options.candidateProfile.id)}`,
  );
  const proofPath = supportedProofPath(options.config.stateDir, profileHash);
  const fileSnapshots = await Promise.all([
    snapshotPrivateFile(proofPath),
    snapshotPrivateFile(supportedProofPath(options.config.stateDir)),
    snapshotPrivateFile(receiptPath),
  ]);
  let configSwitchAttempted = false;
  configRoot.profile = installedProfilePath;
  configRoot.profileSha256 = profileHash;
  const activatedConfigText = `${JSON.stringify(configRoot, null, 2)}\n`;

  try {
    const supportedProof = await saveSupportedProof({
      stateDir: options.config.stateDir,
      profile: options.candidateProfile,
      profileSha256: profileHash,
      snapshot: options.liveSnapshot,
    }, lock);
    // 审批回执与 proof 都是 config 切换的前置条件。这样即使进程在
    // config 原子 rename 后立即退出，active profile 也已有完整审计记录。
    await atomicWritePrivate(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

    const currentConfigText = await Bun.file(options.configPath).text();
    if (currentConfigText !== originalConfigText) {
      throw new Error("配置在激活期间发生变化，拒绝覆盖");
    }
    configSwitchAttempted = true;
    await atomicWritePrivate(options.configPath, activatedConfigText);
    await verifyProfileSelection({
      configPath: options.configPath,
      expectedProfilePath: installedProfilePath,
      expectedProfileSha256: profileHash,
      expectedProfileId: options.candidateProfile.id,
    });
    return { receipt, receiptPath, supportedProofPath: supportedProof.path };
  } catch (activationError) {
    const rollbackFailures: unknown[] = [];
    let configRollbackFailed = false;
    if (configSwitchAttempted) {
      try {
        const currentConfigText = await Bun.file(options.configPath).text();
        if (currentConfigText === activatedConfigText) {
          await atomicWritePrivate(options.configPath, originalConfigText);
        } else if (currentConfigText !== originalConfigText) {
          throw new Error("配置在激活失败后又被更新，拒绝自动覆盖并发修改");
        }
        await verifyProfileSelection({
          configPath: options.configPath,
          expectedProfilePath: options.config.profile,
          expectedProfileSha256: options.config.profileSha256,
          expectedProfileId: options.activeProfile.id,
          expectedConfigText: originalConfigText,
        });
      } catch (rollbackError) {
        configRollbackFailed = true;
        rollbackFailures.push(rollbackError);
      }
    }
    // 若 live config 无法确认已恢复，保留候选 proof/receipt，避免把可能仍
    // 指向候选 profile 的配置进一步拆成缺 proof 的状态。
    if (!configRollbackFailed) {
      try {
        await restorePrivateFiles(fileSnapshots);
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    }
    if (rollbackFailures.length > 0) {
      const rollbackError = rollbackFailures.length === 1
        ? rollbackFailures[0]
        : new AggregateError(rollbackFailures, "profile 激活补偿回滚存在多项失败");
      throw new ProfileActivationRollbackError(activationError, rollbackError, backupConfigPath);
    }
    if (configSwitchAttempted) {
      throw new Error(
        `profile 激活失败，已自动恢复旧配置；配置备份：${backupConfigPath}；原因：${errorMessage(activationError)}`,
        { cause: activationError },
      );
    }
    throw activationError;
  }
}

export async function activateReviewedProfile(
  options: ReviewedProfileActivationOptions,
): Promise<ReviewedProfileActivationResult> {
  validateProfileActivation(options);
  return withUpstreamStateLock(
    options.config.stateDir,
    (lock) => activateReviewedProfileLocked(options, lock),
  );
}

interface ProfileConfigRollbackOptions {
  configPath: string;
  currentConfig: RelayConfig;
  backupConfigPath: string;
}

interface ProfileConfigRollbackResult {
  restoredProfile: { id: string; path: string; sha256: string };
  preRollbackBackupPath: string;
  restartRequired: true;
}

async function rollbackProfileConfigLocked(
  options: ProfileConfigRollbackOptions,
): Promise<ProfileConfigRollbackResult> {
  const backupPath = resolve(options.backupConfigPath);
  const allowedDirectory = `${resolve(options.currentConfig.stateDir, "config-backups")}${sep}`;
  if (!backupPath.startsWith(allowedDirectory)) {
    throw new Error("只允许从当前 stateDir/config-backups 恢复配置");
  }
  const backupText = await Bun.file(backupPath).text();
  const backupConfig = parseRelayConfig(backupText, options.configPath);
  if (resolve(backupConfig.stateDir) !== resolve(options.currentConfig.stateDir)) {
    throw new Error("备份配置属于不同 stateDir，拒绝恢复");
  }
  const restoredProfile = await loadProtocolProfile(
    backupConfig.profile,
    options.configPath,
    backupConfig.profileSha256,
  );
  const currentText = await Bun.file(options.configPath).text();
  const currentRoot = parseJsonObject(currentText, options.configPath);
  if (
    currentRoot.profile !== options.currentConfig.profile ||
    currentRoot.profileSha256 !== options.currentConfig.profileSha256
  ) {
    throw new Error("配置在回滚期间发生变化，拒绝覆盖");
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const preRollbackBackupPath = join(
    options.currentConfig.stateDir,
    "config-backups",
    `${stamp}-${crypto.randomUUID()}-pre-rollback.json`,
  );
  await atomicWritePrivate(preRollbackBackupPath, currentText);
  await atomicWritePrivate(options.configPath, backupText.endsWith("\n") ? backupText : `${backupText}\n`);
  return {
    restoredProfile: {
      id: restoredProfile.id,
      path: backupConfig.profile,
      sha256: backupConfig.profileSha256,
    },
    preRollbackBackupPath,
    restartRequired: true,
  };
}

export async function rollbackProfileConfig(
  options: ProfileConfigRollbackOptions,
): Promise<ProfileConfigRollbackResult> {
  return withUpstreamStateLock(
    options.currentConfig.stateDir,
    () => rollbackProfileConfigLocked(options),
  );
}
