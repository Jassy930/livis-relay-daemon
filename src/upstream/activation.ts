import { existsSync } from "node:fs";
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
  config: RelayConfig;
  activeProfile: ProtocolProfile;
  candidateProfile: ProtocolProfile;
  candidateSourcePath: string;
  identity: RelayIdentity;
  liveSnapshot: UpstreamSnapshot;
}): Promise<{ receipt: ProfileActivationReceipt; receiptPath: string }> {
  validateProfileActivation(options);
  const activatedAt = new Date().toISOString();
  const stamp = activatedAt.replace(/[:.]/g, "-");
  const profileText = `${JSON.stringify(options.candidateProfile, null, 2)}\n`;
  const profileHash = sha256(profileText);
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

  const originalConfigText = await Bun.file(options.configPath).text();
  const configRoot = parseJsonObject(originalConfigText, options.configPath);
  if (configRoot.profileSha256 !== options.config.profileSha256) {
    throw new Error("配置在激活期间发生变化，拒绝覆盖");
  }
  const backupConfigPath = join(options.config.stateDir, "config-backups", `${stamp}.json`);
  await atomicWritePrivate(backupConfigPath, originalConfigText);

  configRoot.profile = installedProfilePath;
  configRoot.profileSha256 = profileHash;
  await atomicWritePrivate(options.configPath, `${JSON.stringify(configRoot, null, 2)}\n`);

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
    `${stamp}-${profileFileName(options.candidateProfile.id)}`,
  );
  await atomicWritePrivate(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return { receipt, receiptPath };
}

export async function rollbackProfileConfig(options: {
  configPath: string;
  currentConfig: RelayConfig;
  backupConfigPath: string;
}): Promise<{
  restoredProfile: { id: string; path: string; sha256: string };
  preRollbackBackupPath: string;
  restartRequired: true;
}> {
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
  if (currentRoot.profileSha256 !== options.currentConfig.profileSha256) {
    throw new Error("配置在回滚期间发生变化，拒绝覆盖");
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const preRollbackBackupPath = join(
    options.currentConfig.stateDir,
    "config-backups",
    `${stamp}-pre-rollback.json`,
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
