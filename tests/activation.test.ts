import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadRelayConfig } from "../src/config.ts";
import type { RelayIdentity } from "../src/identity.ts";
import { loadProtocolProfile } from "../src/protocol/profile.ts";
import {
  activateReviewedProfile,
  rollbackProfileConfig,
  validateProfileActivation,
} from "../src/upstream/activation.ts";
import type { UpstreamSnapshot } from "../src/upstream/checker.ts";
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

describe("官方 profile 原子激活", () => {
  test("复核后复制 profile、更新 pin，并保留配置备份和审批回执", async () => {
    const directory = await temporaryDirectory();
    try {
      const active = await testProfile();
      const candidate = {
        ...active,
        id: "livis-community-v2.1.0",
        officialPluginVersion: "2.1.0",
      };
      const activeText = `${JSON.stringify(active, null, 2)}\n`;
      const activePath = join(directory.path, "protocol-profiles", "active.json");
      await atomicWritePrivate(activePath, activeText);
      const config = {
        ...testConfig(directory.path),
        profile: activePath,
        profileSha256: sha256(activeText),
      };
      const configPath = join(directory.path, "config.json");
      await atomicWritePrivate(configPath, `${JSON.stringify(config, null, 2)}\n`);
      const candidatePath = join(directory.path, "candidate.json");
      await atomicWritePrivate(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
      const identity: RelayIdentity = {
        schemaVersion: 1,
        accountId: "account",
        agentId: `${candidate.wireIdentity.agentIdPrefix}agent`,
        deviceId: `${candidate.wireIdentity.deviceIdPrefix}device`,
        createdAt: "2026-07-18T00:00:00.000Z",
      };

      const activated = await activateReviewedProfile({
        configPath,
        config,
        activeProfile: active,
        candidateProfile: candidate,
        candidateSourcePath: candidatePath,
        identity,
        liveSnapshot: supportedSnapshot(candidate),
      });

      const loaded = await loadRelayConfig(configPath);
      expect(loaded.config.profile).toContain("livis-community-v2.1.0.json");
      expect(loaded.config.profileSha256).not.toBe(config.profileSha256);
      expect((await loadProtocolProfile(
        loaded.config.profile,
        loaded.path,
        loaded.config.profileSha256,
      )).id).toBe(candidate.id);
      expect(await Bun.file(activated.receipt.backupConfigPath).exists()).toBeTrue();
      expect(await Bun.file(activated.receiptPath).exists()).toBeTrue();
      expect(activated.receipt.previous.profileId).toBe(active.id);
      expect(activated.receipt.restartRequired).toBeTrue();

      const rollback = await rollbackProfileConfig({
        configPath,
        currentConfig: loaded.config,
        backupConfigPath: activated.receipt.backupConfigPath,
      });
      const rolledBack = await loadRelayConfig(configPath);
      expect((await loadProtocolProfile(
        rolledBack.config.profile,
        rolledBack.path,
        rolledBack.config.profileSha256,
      )).id).toBe(active.id);
      expect(await Bun.file(rollback.preRollbackBackupPath).exists()).toBeTrue();
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
