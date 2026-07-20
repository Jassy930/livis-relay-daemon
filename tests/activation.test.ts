import { describe, expect, test } from "bun:test";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadRelayConfig } from "../src/config.ts";
import type { RelayIdentity } from "../src/identity.ts";
import { loadProtocolProfile } from "../src/protocol/profile.ts";
import {
  activateReviewedProfile,
  ProfileActivationRollbackError,
  rollbackProfileConfig,
  validateProfileActivation,
} from "../src/upstream/activation.ts";
import type { UpstreamSnapshot } from "../src/upstream/checker.ts";
import { supportedProofPath } from "../src/upstream/proof.ts";
import { atomicWritePrivate, sha256 } from "../src/util.ts";
import { temporaryDirectory, testConfig, testProfile } from "./helpers.ts";

function supportedSnapshot(profile: Awaited<ReturnType<typeof testProfile>>): UpstreamSnapshot {
  return {
    checkedAt: "2026-07-18T12:00:00.000Z",
    activeProfileId: profile.id,
    compatibility: "supported",
    detectedVersion: profile.officialPluginVersion,
    setup: { url: profile.upstream.setupUrl, sha256: profile.upstream.setupSha256 },
    installPlugin: {
      url: profile.upstream.installPluginUrl,
      sha256: profile.upstream.installPluginSha256,
    },
    package: { url: profile.upstream.packageUrl, sha256: profile.upstream.packageSha256 },
    bundleMarkers: Object.fromEntries(profile.upstream.requiredBundleMarkers.map((marker) => [marker, true])),
    matchedProfileId: profile.id,
    reasons: ["test"],
  };
}

async function prepareActivation(directoryPath: string) {
  const active = await testProfile();
  const candidate = {
    ...active,
    id: "livis-community-v2.1.0",
    officialPluginVersion: "2.1.0",
  };
  const activeText = `${JSON.stringify(active, null, 2)}\n`;
  const activePath = join(directoryPath, "protocol-profiles", "active.json");
  await atomicWritePrivate(activePath, activeText);
  const config = {
    ...testConfig(directoryPath),
    profile: activePath,
    profileSha256: sha256(activeText),
  };
  const configPath = join(directoryPath, "config.json");
  const configText = `${JSON.stringify(config, null, 2)}\n`;
  await atomicWritePrivate(configPath, configText);
  const candidatePath = join(directoryPath, "candidate.json");
  await atomicWritePrivate(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
  const identity: RelayIdentity = {
    schemaVersion: 1,
    accountId: "account",
    agentId: `${candidate.wireIdentity.agentIdPrefix}agent`,
    deviceId: `${candidate.wireIdentity.deviceIdPrefix}device`,
    createdAt: "2026-07-18T00:00:00.000Z",
  };
  return {
    active,
    candidate,
    config,
    configPath,
    options: {
      configPath,
      expectedConfigText: configText,
      config,
      activeProfile: active,
      candidateProfile: candidate,
      candidateSourcePath: candidatePath,
      identity,
      liveSnapshot: supportedSnapshot(candidate),
    },
  };
}

async function expectOriginalProfileStillActive(
  fixture: Awaited<ReturnType<typeof prepareActivation>>,
): Promise<void> {
  const loaded = await loadRelayConfig(fixture.configPath);
  expect(loaded.config.profile).toBe(fixture.config.profile);
  expect(loaded.config.profileSha256).toBe(fixture.config.profileSha256);
  expect((await loadProtocolProfile(
    loaded.config.profile,
    loaded.path,
    loaded.config.profileSha256,
  )).id).toBe(fixture.active.id);
}

describe("官方 profile 原子激活", () => {
  test("自动回滚失败时保留原错误、回滚错误和配置备份路径", () => {
    const error = new ProfileActivationRollbackError(
      new Error("approval failed"),
      new Error("config restore failed"),
      "/state/config-backups/backup.json",
    );
    expect(error.errors).toHaveLength(2);
    expect(error.message).toContain("/state/config-backups/backup.json");
    expect(error.backupConfigPath).toBe("/state/config-backups/backup.json");
  });

  test("复核后复制 profile、更新 pin，并保留配置备份和审批回执", async () => {
    const directory = await temporaryDirectory();
    try {
      const fixture = await prepareActivation(directory.path);
      const activated = await activateReviewedProfile(fixture.options);

      const loaded = await loadRelayConfig(fixture.configPath);
      expect(loaded.config.profile).toContain("livis-community-v2.1.0.json");
      expect(loaded.config.profileSha256).not.toBe(fixture.config.profileSha256);
      expect((await loadProtocolProfile(
        loaded.config.profile,
        loaded.path,
        loaded.config.profileSha256,
      )).id).toBe(fixture.candidate.id);
      expect(await Bun.file(activated.receipt.backupConfigPath).exists()).toBeTrue();
      expect(await Bun.file(activated.receiptPath).exists()).toBeTrue();
      expect(await Bun.file(activated.supportedProofPath).exists()).toBeTrue();
      expect((await stat(join(directory.path, "upstream", ".state-lock.sqlite"))).mode & 0o777)
        .toBe(0o600);
      expect(activated.receipt.previous.profileId).toBe(fixture.active.id);
      expect(activated.receipt.restartRequired).toBeTrue();

      const rollback = await rollbackProfileConfig({
        configPath: fixture.configPath,
        currentConfig: loaded.config,
        backupConfigPath: activated.receipt.backupConfigPath,
      });
      const rolledBack = await loadRelayConfig(fixture.configPath);
      expect((await loadProtocolProfile(
        rolledBack.config.profile,
        rolledBack.path,
        rolledBack.config.profileSha256,
      )).id).toBe(fixture.active.id);
      expect(await Bun.file(rollback.preRollbackBackupPath).exists()).toBeTrue();
    } finally {
      await directory.cleanup();
    }
  });

  test("审批回执路径不可写时自动恢复旧 profile 与 pin", async () => {
    const directory = await temporaryDirectory();
    try {
      const fixture = await prepareActivation(directory.path);
      const previousLastSupported = "previous supported proof\n";
      await atomicWritePrivate(supportedProofPath(directory.path), previousLastSupported);
      await writeFile(join(directory.path, "upstream-approvals"), "阻断审批回执目录");

      await expect(activateReviewedProfile(fixture.options)).rejects.toThrow();
      await expectOriginalProfileStillActive(fixture);
      const candidateHash = sha256(`${JSON.stringify(fixture.candidate, null, 2)}\n`);
      expect(await Bun.file(supportedProofPath(directory.path, candidateHash)).exists()).toBeFalse();
      expect(await Bun.file(supportedProofPath(directory.path)).text()).toBe(previousLastSupported);
    } finally {
      await directory.cleanup();
    }
  });

  test("supported proof 路径不可写时保持旧 profile 与 pin", async () => {
    const directory = await temporaryDirectory();
    try {
      const fixture = await prepareActivation(directory.path);
      await writeFile(join(directory.path, "upstream"), "阻断 supported proof 目录");

      await expect(activateReviewedProfile(fixture.options)).rejects.toThrow();
      await expectOriginalProfileStillActive(fixture);
    } finally {
      await directory.cleanup();
    }
  });

  test("并发激活串行化，落败操作不撤销成功操作的 proof", async () => {
    const directory = await temporaryDirectory();
    try {
      const fixture = await prepareActivation(directory.path);
      const results = await Promise.allSettled([
        activateReviewedProfile(fixture.options),
        activateReviewedProfile(fixture.options),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

      const loaded = await loadRelayConfig(fixture.configPath);
      expect((await loadProtocolProfile(
        loaded.config.profile,
        loaded.path,
        loaded.config.profileSha256,
      )).id).toBe(fixture.candidate.id);
      expect(await Bun.file(
        supportedProofPath(directory.path, loaded.config.profileSha256),
      ).exists()).toBeTrue();
    } finally {
      await directory.cleanup();
    }
  });

  test("完整配置 CAS 拒绝只修改 stateDir 的并发更新", async () => {
    const directory = await temporaryDirectory();
    try {
      const fixture = await prepareActivation(directory.path);
      const concurrentStateDir = join(directory.path, "moved-state");
      const concurrentConfigText = `${JSON.stringify({
        ...fixture.config,
        stateDir: concurrentStateDir,
      }, null, 2)}\n`;
      await atomicWritePrivate(fixture.configPath, concurrentConfigText);

      await expect(activateReviewedProfile(fixture.options)).rejects.toThrow(
        "配置在激活期间发生变化",
      );
      expect(await Bun.file(fixture.configPath).text()).toBe(concurrentConfigText);
      expect(await Bun.file(
        join(directory.path, "protocol-profiles", "livis-community-v2.1.0.json"),
      ).exists()).toBeFalse();
      expect(await Bun.file(
        join(concurrentStateDir, "protocol-profiles", "livis-community-v2.1.0.json"),
      ).exists()).toBeFalse();
    } finally {
      await directory.cleanup();
    }
  });

  test("候选未被当前上游精确匹配或 identity 前缀变化时拒绝", async () => {
    const active = await testProfile();
    const candidate = { ...active, id: "livis-community-v2.1.0", officialPluginVersion: "2.1.0" };
    const identity: RelayIdentity = {
      schemaVersion: 1,
      accountId: "account",
      agentId: `${active.wireIdentity.agentIdPrefix}agent`,
      deviceId: `${active.wireIdentity.deviceIdPrefix}device`,
      createdAt: "2026-07-18T00:00:00.000Z",
    };
    expect(() => validateProfileActivation({
      activeProfile: active,
      candidateProfile: candidate,
      identity,
      liveSnapshot: { ...supportedSnapshot(candidate), compatibility: "candidate-compatible" },
    })).toThrow("未通过当前上游");
    expect(() => validateProfileActivation({
      activeProfile: active,
      candidateProfile: {
        ...candidate,
        wireIdentity: { ...candidate.wireIdentity, agentIdPrefix: "new-prefix-" },
      },
      identity,
      liveSnapshot: supportedSnapshot(candidate),
    })).toThrow("agentIdPrefix");
    expect(() => validateProfileActivation({
      activeProfile: active,
      candidateProfile: {
        ...candidate,
        endpoints: { ...candidate.endpoints, idaasBaseUrl: "https://evil.example.test/api" },
      },
      identity,
      liveSnapshot: supportedSnapshot(candidate),
    })).toThrow("运行契约");
  });
});
