import { describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProtocolProfile } from "../src/protocol/profile.ts";
import { ProfileOperationGuard } from "../src/state/offline-guard.ts";
import type { UpstreamSnapshot } from "../src/upstream/checker.ts";
import {
  requireFreshSupportedProof,
  saveSupportedProof,
  supportedProofPath,
  UPSTREAM_PROOF_MAX_AGE_MS,
} from "../src/upstream/proof.ts";
import { atomicWritePrivate, sha256 } from "../src/util.ts";
import { runtimeContractSha256 } from "../src/protocol/profile.ts";
import { temporaryDirectory, testProfile } from "./helpers.ts";

function snapshotFor(profile: ProtocolProfile): UpstreamSnapshot {
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

async function saveProof(options: Parameters<typeof saveSupportedProof>[0]) {
  const guard = await ProfileOperationGuard.acquire(options.stateDir, "upstream-check");
  try {
    return await saveSupportedProof(options, guard);
  } finally {
    await guard.release();
  }
}

describe("近期 upstream supported proof", () => {
  test("证明绑定 active profile SHA，过期或被改写后 fail closed", async () => {
    const directory = await temporaryDirectory();
    try {
      const profile = await testProfile();
      const profileSha256 = sha256(`${JSON.stringify(profile, null, 2)}\n`);
      const now = 1_700_000_000_000;
      const saved = await saveProof({
        stateDir: directory.path,
        profile,
        profileSha256,
        snapshot: snapshotFor(profile),
        now,
      });
      const savedText = await Bun.file(saved.path).text();
      expect(await Bun.file(supportedProofPath(directory.path)).text()).toBe(savedText);
      expect((await stat(join(directory.path, "upstream"))).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory.path, "upstream", "proofs"))).mode & 0o777).toBe(0o700);
      expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
      expect((await stat(supportedProofPath(directory.path))).mode & 0o777).toBe(0o600);
      const loaded = await requireFreshSupportedProof({
        stateDir: directory.path,
        profile,
        profileSha256,
        now: now + 1000,
      });
      expect(loaded.profileId).toBe(profile.id);
      expect(loaded.runtimeContractSha256).toBe(runtimeContractSha256(profile));
      expect(loaded.wireContractRevision).toBe(profile.wireContractRevision);
      expect(loaded.credentialMode).toBe(profile.credentialMode);
      await expect(requireFreshSupportedProof({
        stateDir: directory.path,
        profile,
        profileSha256,
        now: now + UPSTREAM_PROOF_MAX_AGE_MS,
      })).rejects.toThrow("已过期");
      await expect(requireFreshSupportedProof({
        stateDir: directory.path,
        profile,
        profileSha256,
        now: now + UPSTREAM_PROOF_MAX_AGE_MS + 1,
      })).rejects.toThrow("已过期");

      const tampered = JSON.parse(await Bun.file(saved.path).text()) as Record<string, unknown>;
      tampered.profileSha256 = "0".repeat(64);
      await atomicWritePrivate(saved.path, `${JSON.stringify(tampered)}\n`);
      await expect(requireFreshSupportedProof({
        stateDir: directory.path,
        profile,
        profileSha256,
        now: now + 1000,
      })).rejects.toThrow("未绑定当前 active profile");
    } finally {
      await directory.cleanup();
    }
  });

  test("旧 schema 或被篡改的 wire contract proof 会 fail closed", async () => {
    const directory = await temporaryDirectory();
    try {
      const profile = await testProfile();
      const profileSha256 = sha256(`${JSON.stringify(profile, null, 2)}\n`);
      const saved = await saveProof({
        stateDir: directory.path,
        profile,
        profileSha256,
        snapshot: snapshotFor(profile),
      });
      const proof = JSON.parse(await Bun.file(saved.path).text()) as Record<string, unknown>;
      proof.schemaVersion = 1;
      await atomicWritePrivate(saved.path, `${JSON.stringify(proof)}\n`);
      await expect(requireFreshSupportedProof({
        stateDir: directory.path,
        profile,
        profileSha256,
      })).rejects.toThrow("wire contract");

      proof.schemaVersion = 2;
      proof.wireContractRevision = "tampered";
      await atomicWritePrivate(saved.path, `${JSON.stringify(proof)}\n`);
      await expect(requireFreshSupportedProof({
        stateDir: directory.path,
        profile,
        profileSha256,
      })).rejects.toThrow("wire contract");
    } finally {
      await directory.cleanup();
    }
  });

  test("snapshot 缺少 active profile marker 时拒绝生成证明", async () => {
    const directory = await temporaryDirectory();
    try {
      const profile = await testProfile();
      const snapshot = snapshotFor(profile);
      snapshot.bundleMarkers[profile.upstream.requiredBundleMarkers[0]!] = false;
      await expect(saveProof({
        stateDir: directory.path,
        profile,
        profileSha256: sha256("profile"),
        snapshot,
      })).rejects.toThrow("与 active profile 不一致");
    } finally {
      await directory.cleanup();
    }
  });

  test("alias 写入后失败会按 alias、keyed 逆序恢复原始字节", async () => {
    const directory = await temporaryDirectory();
    try {
      const profile = await testProfile();
      const profileSha256 = sha256(`${JSON.stringify(profile, null, 2)}\n`);
      const keyedPath = supportedProofPath(directory.path, profileSha256);
      const aliasPath = supportedProofPath(directory.path);
      const oldKeyed = "旧 keyed proof\n";
      const oldAlias = "旧 alias proof\n";
      await atomicWritePrivate(keyedPath, oldKeyed);
      await atomicWritePrivate(aliasPath, oldAlias);
      const guard = await ProfileOperationGuard.acquire(directory.path, "upstream-check");
      try {
        await expect(saveSupportedProof({
          stateDir: directory.path,
          profile,
          profileSha256,
          snapshot: snapshotFor(profile),
          testHooks: {
            afterAliasWrite: () => {
              throw new Error("注入 alias 写后失败");
            },
          },
        }, guard)).rejects.toThrow("注入 alias 写后失败");
      } finally {
        await guard.release();
      }
      expect(await Bun.file(keyedPath).text()).toBe(oldKeyed);
      expect(await Bun.file(aliasPath).text()).toBe(oldAlias);
    } finally {
      await directory.cleanup();
    }
  });
});
