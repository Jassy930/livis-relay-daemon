import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { lstat, mkdir, readFile, readdir, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadRelayConfig } from "../src/config.ts";
import { parseProtocolProfile } from "../src/protocol/profile.ts";
import { ProfileOperationGuard } from "../src/state/offline-guard.ts";
import { supportedProofPath } from "../src/upstream/proof.ts";
import {
  applyProtocolProfileV2Migration,
  LEGACY_V1_CREDENTIAL_MODE,
  LEGACY_V1_WIRE_CONTRACT_REVISION,
  planProtocolProfileV2Migration,
  protocolProfileMigrationPlanSummary,
  rollbackProtocolProfileMigration,
} from "../src/upstream/profile-migration.ts";
import { atomicWritePrivate, sha256 } from "../src/util.ts";
import { temporaryDirectory, testConfig, testProfile } from "./helpers.ts";

const originalStateOverride = process.env.LIVIS_RELAY_STATE_DIR;

afterEach(() => {
  if (originalStateOverride === undefined) delete process.env.LIVIS_RELAY_STATE_DIR;
  else process.env.LIVIS_RELAY_STATE_DIR = originalStateOverride;
});

async function legacyDeployment() {
  const directory = await temporaryDirectory("livis-profile-migration-");
  const v2 = await testProfile();
  const {
    wireContractRevision: _wireContractRevision,
    credentialMode: _credentialMode,
    ...legacyFields
  } = v2;
  const legacy = { ...legacyFields, schemaVersion: 1 };
  const profileText = `${JSON.stringify(legacy, null, 2)}\n`;
  const profilePath = join(directory.path, "protocol-profiles", "legacy-private.json");
  await atomicWritePrivate(profilePath, profileText);
  const config = {
    ...testConfig(directory.path),
    profile: profilePath,
    profileSha256: sha256(profileText),
  };
  const configText = `${JSON.stringify(config, null, 2)}\n`;
  const configPath = join(directory.path, "config.json");
  await atomicWritePrivate(configPath, configText);
  const databasePath = join(directory.path, "relay.db");
  const database = new Database(databasePath);
  database.exec("PRAGMA user_version=27");
  database.close();
  return {
    directory,
    config,
    configPath,
    configText,
    profilePath,
    profileText,
    profileSha256: sha256(profileText),
    databasePath,
    v2,
  };
}

function migrationOptions(configPath: string) {
  return {
    configPath,
    wireContractRevision: LEGACY_V1_WIRE_CONTRACT_REVISION,
    credentialMode: LEGACY_V1_CREDENTIAL_MODE,
  };
}

async function userVersion(path: string): Promise<number> {
  const database = new Database(path, { readonly: true });
  try {
    return database.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
  } finally {
    database.close();
  }
}

async function runCli(configPath: string, args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const environment: Record<string, string | undefined> = {
    ...process.env,
    LIVIS_RELAY_CONFIG: configPath,
  };
  delete environment.LIVIS_RELAY_STATE_DIR;
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
    cwd: resolve(import.meta.dir, ".."),
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("protocol profile schema v1→v2 迁移", () => {
  test("dry-run 只增加固定 contract 字段且零写入、零 SQLite 变化", async () => {
    const deployment = await legacyDeployment();
    try {
      const plan = await planProtocolProfileV2Migration(migrationOptions(deployment.configPath));
      expect(plan.status).toBe("migration-required");
      expect(plan.sourceSchemaVersion).toBe(1);
      expect(plan.targetProfile.schemaVersion).toBe(2);
      expect(plan.targetProfile.wireContractRevision).toBe(LEGACY_V1_WIRE_CONTRACT_REVISION);
      expect(plan.targetProfile.credentialMode).toBe(LEGACY_V1_CREDENTIAL_MODE);
      expect(plan.targetProfilePath).toContain(`${join("protocol-profiles-v2", "")}`);

      const source = JSON.parse(deployment.profileText) as Record<string, unknown>;
      const target = JSON.parse(plan.targetProfileText) as Record<string, unknown>;
      delete source.schemaVersion;
      delete target.schemaVersion;
      delete target.wireContractRevision;
      delete target.credentialMode;
      expect(target).toEqual(source);

      const summary = JSON.stringify(protocolProfileMigrationPlanSummary(plan));
      expect(summary).not.toContain(deployment.v2.endpoints.idaasBaseUrl);
      expect(summary).not.toContain(deployment.v2.oauth.clientId);
      expect(summary).not.toContain(deployment.config.security.allowedNodeIds[0]!);
      expect(await Bun.file(join(deployment.directory.path, "profile-migrations")).exists()).toBeFalse();
      expect(await Bun.file(plan.targetProfilePath).exists()).toBeFalse();
      expect(await userVersion(deployment.databasePath)).toBe(27);
      expect(await readFile(deployment.configPath, "utf8")).toBe(deployment.configText);
      expect(await readFile(deployment.profilePath, "utf8")).toBe(deployment.profileText);
    } finally {
      await deployment.directory.cleanup();
    }
  });

  test("apply 原子重锁 config、隔离全部 proof，并可精确回滚", async () => {
    const deployment = await legacyDeployment();
    try {
      const plan = await planProtocolProfileV2Migration(migrationOptions(deployment.configPath));
      for (const [path, marker] of [
        [supportedProofPath(deployment.directory.path, plan.sourceProfileSha256), "old-proof-private"],
        [supportedProofPath(deployment.directory.path, plan.targetProfileSha256), "new-proof-private"],
        [supportedProofPath(deployment.directory.path), "last-proof-private"],
      ] as const) {
        await atomicWritePrivate(path, `${JSON.stringify({ marker })}\n`);
      }

      const applied = await applyProtocolProfileV2Migration(plan, {
        acknowledgeReviewedWireContract: true,
        acknowledgeDaemonAndHermesStopped: true,
      });
      expect(applied.changed).toBeTrue();
      expect(applied.sqliteTouched).toBeFalse();
      expect(applied.quarantinedProofs).toEqual(["old-profile", "new-profile", "last-supported"]);
      expect(await userVersion(deployment.databasePath)).toBe(27);
      expect(await readFile(deployment.profilePath, "utf8")).toBe(deployment.profileText);

      const loaded = await loadRelayConfig(deployment.configPath);
      expect(loaded.config.profileSha256).toBe(plan.targetProfileSha256);
      expect(loaded.config.profile).toBe(plan.targetProfilePath);
      expect(parseProtocolProfile(await readFile(plan.targetProfilePath, "utf8")).schemaVersion).toBe(2);
      for (const path of [
        supportedProofPath(deployment.directory.path, plan.sourceProfileSha256),
        supportedProofPath(deployment.directory.path, plan.targetProfileSha256),
        supportedProofPath(deployment.directory.path),
      ]) {
        expect(await Bun.file(path).exists()).toBeFalse();
      }

      const receiptPath = String(applied.receiptPath);
      const receiptText = await readFile(receiptPath, "utf8");
      expect(receiptText).not.toContain(deployment.v2.endpoints.idaasBaseUrl);
      expect(receiptText).not.toContain(deployment.v2.oauth.clientId);
      expect(receiptText).not.toContain(deployment.config.security.allowedNodeIds[0]!);
      for (const path of [
        receiptPath,
        String(applied.configBackupPath),
        String(applied.profileBackupPath),
        plan.targetProfilePath,
      ]) {
        expect((await lstat(path)).mode & 0o777).toBe(0o600);
      }
      expect((await lstat(join(receiptPath, ".."))).mode & 0o777).toBe(0o700);

      const rolledBack = await rollbackProtocolProfileMigration({
        configPath: deployment.configPath,
        receiptPath,
        acknowledgeDaemonAndHermesStopped: true,
      });
      expect(rolledBack.changed).toBeTrue();
      expect(rolledBack.exactConfigBytes).toBeTrue();
      expect(rolledBack.requiresOldDaemon).toBeTrue();
      expect(await readFile(deployment.configPath, "utf8")).toBe(deployment.configText);
      expect(await readFile(deployment.profilePath, "utf8")).toBe(deployment.profileText);
      expect(await userVersion(deployment.databasePath)).toBe(27);

      const repeated = await rollbackProtocolProfileMigration({
        configPath: deployment.configPath,
        receiptPath,
        acknowledgeDaemonAndHermesStopped: true,
      });
      expect(repeated.changed).toBeFalse();
      expect(repeated.alreadyRolledBack).toBeTrue();

      for (const [path, marker] of [
        [supportedProofPath(deployment.directory.path, plan.sourceProfileSha256), "rebuilt-old-proof"],
        [supportedProofPath(deployment.directory.path, plan.targetProfileSha256), "stale-new-proof"],
        [supportedProofPath(deployment.directory.path), "rebuilt-alias-proof"],
      ] as const) {
        await atomicWritePrivate(path, `${JSON.stringify({ marker })}\n`);
      }
      const proofCleanup = await rollbackProtocolProfileMigration({
        configPath: deployment.configPath,
        receiptPath,
        acknowledgeDaemonAndHermesStopped: true,
      });
      expect(proofCleanup.changed).toBeTrue();
      expect(proofCleanup.quarantinedProofs).toEqual([
        "old-profile",
        "new-profile",
        "last-supported",
      ]);
      expect(await readFile(deployment.configPath, "utf8")).toBe(deployment.configText);

      const afterCleanup = await rollbackProtocolProfileMigration({
        configPath: deployment.configPath,
        receiptPath,
        acknowledgeDaemonAndHermesStopped: true,
      });
      expect(afterCleanup.changed).toBeFalse();
      expect(afterCleanup.alreadyRolledBack).toBeTrue();
    } finally {
      await deployment.directory.cleanup();
    }
  });

  test("rollback 在原 v1 文件丢失时使用私有 profile backup", async () => {
    const deployment = await legacyDeployment();
    try {
      const plan = await planProtocolProfileV2Migration(migrationOptions(deployment.configPath));
      const applied = await applyProtocolProfileV2Migration(plan, {
        acknowledgeReviewedWireContract: true,
        acknowledgeDaemonAndHermesStopped: true,
      });
      await rm(deployment.profilePath);
      const rolledBack = await rollbackProtocolProfileMigration({
        configPath: deployment.configPath,
        receiptPath: String(applied.receiptPath),
        acknowledgeDaemonAndHermesStopped: true,
      });
      expect(rolledBack.exactConfigBytes).toBeFalse();
      const restored = await loadRelayConfig(deployment.configPath);
      expect(restored.config.profile).toContain("protocol-profiles-v1-rollback");
      expect(sha256(await readFile(restored.config.profile, "utf8"))).toBe(deployment.profileSha256);
      const repeated = await rollbackProtocolProfileMigration({
        configPath: deployment.configPath,
        receiptPath: String(applied.receiptPath),
        acknowledgeDaemonAndHermesStopped: true,
      });
      expect(repeated.changed).toBeFalse();
      expect(repeated.exactConfigBytes).toBeFalse();
    } finally {
      await deployment.directory.cleanup();
    }
  });

  test("exact-source 已回滚后即使 v1 与 target 都被清理，也会从备份自愈", async () => {
    const deployment = await legacyDeployment();
    try {
      const plan = await planProtocolProfileV2Migration(migrationOptions(deployment.configPath));
      const applied = await applyProtocolProfileV2Migration(plan, {
        acknowledgeReviewedWireContract: true,
        acknowledgeDaemonAndHermesStopped: true,
      });
      await rollbackProtocolProfileMigration({
        configPath: deployment.configPath,
        receiptPath: String(applied.receiptPath),
        acknowledgeDaemonAndHermesStopped: true,
      });
      await rm(deployment.profilePath);
      await rm(plan.targetProfilePath);

      const repaired = await rollbackProtocolProfileMigration({
        configPath: deployment.configPath,
        receiptPath: String(applied.receiptPath),
        acknowledgeDaemonAndHermesStopped: true,
      });
      expect(repaired.changed).toBeTrue();
      expect(repaired.repairedInvalidProfile).toBeTrue();
      expect(repaired.exactConfigBytes).toBeFalse();
      const restored = await loadRelayConfig(deployment.configPath);
      expect(restored.config.profile).toContain("protocol-profiles-v1-rollback");
      expect(sha256(await readFile(restored.config.profile, "utf8"))).toBe(deployment.profileSha256);

      const repeated = await rollbackProtocolProfileMigration({
        configPath: deployment.configPath,
        receiptPath: String(applied.receiptPath),
        acknowledgeDaemonAndHermesStopped: true,
      });
      expect(repeated.changed).toBeFalse();
      expect(repeated.alreadyRolledBack).toBeTrue();
    } finally {
      await deployment.directory.cleanup();
    }
  });

  test("fallback 已生效后文件缺失或损坏时从已验证备份重建并保留坏文件", async () => {
    const deployment = await legacyDeployment();
    try {
      const plan = await planProtocolProfileV2Migration(migrationOptions(deployment.configPath));
      const applied = await applyProtocolProfileV2Migration(plan, {
        acknowledgeReviewedWireContract: true,
        acknowledgeDaemonAndHermesStopped: true,
      });
      await rm(deployment.profilePath);
      const firstRollback = await rollbackProtocolProfileMigration({
        configPath: deployment.configPath,
        receiptPath: String(applied.receiptPath),
        acknowledgeDaemonAndHermesStopped: true,
      });
      const fallbackPath = String(firstRollback.restoredProfilePath);
      await rm(plan.targetProfilePath);

      await rm(fallbackPath);
      const recreated = await rollbackProtocolProfileMigration({
        configPath: deployment.configPath,
        receiptPath: String(applied.receiptPath),
        acknowledgeDaemonAndHermesStopped: true,
      });
      expect(recreated.changed).toBeTrue();
      expect(sha256(await readFile(fallbackPath, "utf8"))).toBe(deployment.profileSha256);

      await atomicWritePrivate(fallbackPath, "damaged fallback\n");
      const repaired = await rollbackProtocolProfileMigration({
        configPath: deployment.configPath,
        receiptPath: String(applied.receiptPath),
        acknowledgeDaemonAndHermesStopped: true,
      });
      expect(repaired.changed).toBeTrue();
      expect(repaired.repairedInvalidProfile).toBeTrue();
      expect(sha256(await readFile(fallbackPath, "utf8"))).toBe(deployment.profileSha256);
      const receiptDirectory = join(String(applied.receiptPath), "..");
      const quarantined = (await readdir(receiptDirectory)).filter((name) =>
        name.startsWith("invalid-fallback-")
      );
      expect(quarantined).toHaveLength(1);
      expect(await readFile(join(receiptDirectory, quarantined[0]!), "utf8")).toBe(
        "damaged fallback\n",
      );
    } finally {
      await deployment.directory.cleanup();
    }
  });

  test("fallback 修复不会因原 v1 恢复而切换提交点或改回 source config", async () => {
    const deployment = await legacyDeployment();
    try {
      const plan = await planProtocolProfileV2Migration(migrationOptions(deployment.configPath));
      const applied = await applyProtocolProfileV2Migration(plan, {
        acknowledgeReviewedWireContract: true,
        acknowledgeDaemonAndHermesStopped: true,
      });
      await rm(deployment.profilePath);
      const firstRollback = await rollbackProtocolProfileMigration({
        configPath: deployment.configPath,
        receiptPath: String(applied.receiptPath),
        acknowledgeDaemonAndHermesStopped: true,
      });
      const fallbackConfigText = await readFile(deployment.configPath, "utf8");
      const fallbackPath = String(firstRollback.restoredProfilePath);

      await atomicWritePrivate(deployment.profilePath, deployment.profileText);
      await atomicWritePrivate(fallbackPath, "damaged while source is valid\n");
      const repaired = await rollbackProtocolProfileMigration({
        configPath: deployment.configPath,
        receiptPath: String(applied.receiptPath),
        acknowledgeDaemonAndHermesStopped: true,
      });

      expect(repaired.changed).toBeTrue();
      expect(repaired.exactConfigBytes).toBeFalse();
      expect(repaired.repairedInvalidProfile).toBeTrue();
      expect(await readFile(deployment.configPath, "utf8")).toBe(fallbackConfigText);
      expect(sha256(await readFile(fallbackPath, "utf8"))).toBe(deployment.profileSha256);
      const prepared = JSON.parse(
        await readFile(String(repaired.rollbackPreparedPath), "utf8"),
      ) as Record<string, unknown>;
      expect(prepared.commitPoint).toBe("fallback-profile-durable-rename");
    } finally {
      await deployment.directory.cleanup();
    }
  });

  test("target profile 的中间目录 symlink 即使仍在 stateDir 内也失败关闭", async () => {
    const deployment = await legacyDeployment();
    try {
      const plan = await planProtocolProfileV2Migration(migrationOptions(deployment.configPath));
      const applied = await applyProtocolProfileV2Migration(plan, {
        acknowledgeReviewedWireContract: true,
        acknowledgeDaemonAndHermesStopped: true,
      });
      const targetDirectory = join(plan.targetProfilePath, "..");
      const externalDirectory = join(deployment.directory.path, "relocated-v2-profile");
      await rm(targetDirectory, { recursive: true });
      await mkdir(externalDirectory, { mode: 0o700 });
      await atomicWritePrivate(
        join(externalDirectory, `${plan.targetProfileSha256}.json`),
        plan.targetProfileText,
      );
      await symlink(externalDirectory, targetDirectory);

      await expect(rollbackProtocolProfileMigration({
        configPath: deployment.configPath,
        receiptPath: String(applied.receiptPath),
        acknowledgeDaemonAndHermesStopped: true,
      })).rejects.toThrow("target profile directory 必须是目录且不能是 symlink");
      expect(sha256(await readFile(deployment.configPath, "utf8"))).toBe(plan.targetConfigSha256);
    } finally {
      await deployment.directory.cleanup();
    }
  });

  test("receipt 与另一组 source backups 混配时无法通过 source→target 闭环", async () => {
    const deployment = await legacyDeployment();
    try {
      const plan = await planProtocolProfileV2Migration(migrationOptions(deployment.configPath));
      const applied = await applyProtocolProfileV2Migration(plan, {
        acknowledgeReviewedWireContract: true,
        acknowledgeDaemonAndHermesStopped: true,
      });
      const receiptPath = String(applied.receiptPath);
      const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
      const source = receipt.source as Record<string, unknown>;

      const mixedProfile = JSON.parse(deployment.profileText) as Record<string, unknown>;
      mixedProfile.id = "mixed-source-profile";
      const mixedProfileText = `${JSON.stringify(mixedProfile, null, 2)}\n`;
      const mixedProfileSha256 = sha256(mixedProfileText);
      const mixedConfig = JSON.parse(deployment.configText) as Record<string, unknown>;
      mixedConfig.profileSha256 = mixedProfileSha256;
      (mixedConfig.relay as Record<string, unknown>).nodeName = "来自另一迁移的 source";
      const mixedConfigText = `${JSON.stringify(mixedConfig, null, 2)}\n`;

      source.profileSha256 = mixedProfileSha256;
      source.configSha256 = sha256(mixedConfigText);
      const receiptDirectory = join(receiptPath, "..");
      await atomicWritePrivate(join(receiptDirectory, "profile.before.json"), mixedProfileText);
      await atomicWritePrivate(join(receiptDirectory, "config.before.json"), mixedConfigText);
      await atomicWritePrivate(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

      await expect(rollbackProtocolProfileMigration({
        configPath: deployment.configPath,
        receiptPath,
        acknowledgeDaemonAndHermesStopped: true,
      })).rejects.toThrow("无法重建同一次 source→target profile 迁移");
      expect(sha256(await readFile(deployment.configPath, "utf8"))).toBe(plan.targetConfigSha256);
    } finally {
      await deployment.directory.cleanup();
    }
  });

  test("空 upstream/proofs symlink 也会在 config 提交前失败关闭", async () => {
    const deployment = await legacyDeployment();
    try {
      const plan = await planProtocolProfileV2Migration(migrationOptions(deployment.configPath));
      const upstreamDirectory = join(deployment.directory.path, "upstream");
      const externalDirectory = join(deployment.directory.path, "external-proofs");
      await mkdir(upstreamDirectory, { mode: 0o700 });
      await mkdir(externalDirectory, { mode: 0o700 });
      await symlink(externalDirectory, join(upstreamDirectory, "proofs"));

      await expect(applyProtocolProfileV2Migration(plan, {
        acknowledgeReviewedWireContract: true,
        acknowledgeDaemonAndHermesStopped: true,
      })).rejects.toThrow("upstream keyed proof directory 必须是目录且不能是 symlink");
      expect(await readFile(deployment.configPath, "utf8")).toBe(deployment.configText);
      expect((await lstat(join(upstreamDirectory, "proofs"))).isSymbolicLink()).toBeTrue();
      expect(await Bun.file(join(deployment.directory.path, "profile-operation.guard")).exists()).toBeFalse();
      expect(await Bun.file(deployment.config.connector.socketPath).exists()).toBeFalse();
    } finally {
      await deployment.directory.cleanup();
    }
  });

  test("dry-run 即拒绝 stateDir 外的 connector socket 父目录", async () => {
    const deployment = await legacyDeployment();
    const external = await temporaryDirectory("livis-external-socket-");
    try {
      const root = JSON.parse(deployment.configText) as Record<string, unknown>;
      (root.connector as Record<string, unknown>).socketPath = join(external.path, "connector.sock");
      await atomicWritePrivate(deployment.configPath, `${JSON.stringify(root, null, 2)}\n`);
      await expect(planProtocolProfileV2Migration(
        migrationOptions(deployment.configPath),
      )).rejects.toThrow("connector socket parent directory 必须位于私有 stateDir 内");
      expect(await Bun.file(join(deployment.directory.path, "profile-operation.guard")).exists()).toBeFalse();
      expect(await Bun.file(join(deployment.directory.path, "profile-migrations")).exists()).toBeFalse();
    } finally {
      await external.cleanup();
      await deployment.directory.cleanup();
    }
  });

  test("proof writer 在加载 profile 前先获取 operation guard", async () => {
    const deployment = await legacyDeployment();
    const guard = await ProfileOperationGuard.acquire(
      deployment.directory.path,
      "protocol-profile-migration",
    );
    try {
      const result = await runCli(deployment.configPath, ["upstream", "check"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("profile operation guard 已存在");
      expect(result.stderr).not.toContain("旧 profile 必须显式迁移");
      expect(await Bun.file(supportedProofPath(deployment.directory.path)).exists()).toBeFalse();
    } finally {
      await guard.release();
      await deployment.directory.cleanup();
    }
  });

  test("完整 config CAS、profile CAS 与 connector path guard 均失败关闭", async () => {
    const configDrift = await legacyDeployment();
    try {
      const plan = await planProtocolProfileV2Migration(migrationOptions(configDrift.configPath));
      const changed = JSON.parse(configDrift.configText) as Record<string, unknown>;
      (changed.relay as Record<string, unknown>).nodeName = "并发修改";
      const changedText = `${JSON.stringify(changed, null, 2)}\n`;
      await atomicWritePrivate(configDrift.configPath, changedText);
      await expect(applyProtocolProfileV2Migration(plan, {
        acknowledgeReviewedWireContract: true,
        acknowledgeDaemonAndHermesStopped: true,
      })).rejects.toThrow("config 在 dry-run/prepare 后发生变化");
      expect(await readFile(configDrift.configPath, "utf8")).toBe(changedText);
      expect(await Bun.file(join(configDrift.directory.path, "profile-migrations")).exists()).toBeFalse();
    } finally {
      await configDrift.directory.cleanup();
    }

    const profileDrift = await legacyDeployment();
    try {
      const plan = await planProtocolProfileV2Migration(migrationOptions(profileDrift.configPath));
      await atomicWritePrivate(profileDrift.profilePath, `${profileDrift.profileText} `);
      await expect(applyProtocolProfileV2Migration(plan, {
        acknowledgeReviewedWireContract: true,
        acknowledgeDaemonAndHermesStopped: true,
      })).rejects.toThrow("active protocol profile 在 dry-run/prepare 后发生变化");
    } finally {
      await profileDrift.directory.cleanup();
    }

    const socketOccupied = await legacyDeployment();
    try {
      const plan = await planProtocolProfileV2Migration(migrationOptions(socketOccupied.configPath));
      await atomicWritePrivate(socketOccupied.config.connector.socketPath, "occupied\n");
      await expect(applyProtocolProfileV2Migration(plan, {
        acknowledgeReviewedWireContract: true,
        acknowledgeDaemonAndHermesStopped: true,
      })).rejects.toThrow("connector socket 路径已存在");
      expect(await Bun.file(join(socketOccupied.directory.path, "profile-operation.guard")).exists()).toBeFalse();
      expect(await Bun.file(join(socketOccupied.directory.path, "profile-migrations")).exists()).toBeFalse();
    } finally {
      await socketOccupied.directory.cleanup();
    }
  });

  test("拒绝错误 contract、环境 stateDir 覆盖与 schema v1 伪造字段", async () => {
    const deployment = await legacyDeployment();
    try {
      await expect(planProtocolProfileV2Migration({
        ...migrationOptions(deployment.configPath),
        wireContractRevision: "future-revision",
      })).rejects.toThrow("必须显式为");
      await expect(planProtocolProfileV2Migration({
        ...migrationOptions(deployment.configPath),
        credentialMode: "access-token-only",
      })).rejects.toThrow("必须显式为");

      process.env.LIVIS_RELAY_STATE_DIR = join(deployment.directory.path, "override");
      await expect(planProtocolProfileV2Migration(migrationOptions(deployment.configPath))).rejects.toThrow(
        "禁止使用 LIVIS_RELAY_STATE_DIR",
      );
      delete process.env.LIVIS_RELAY_STATE_DIR;

      const root = JSON.parse(deployment.profileText) as Record<string, unknown>;
      root.wireContractRevision = LEGACY_V1_WIRE_CONTRACT_REVISION;
      const forgedText = `${JSON.stringify(root, null, 2)}\n`;
      await atomicWritePrivate(deployment.profilePath, forgedText);
      const configRoot = JSON.parse(deployment.configText) as Record<string, unknown>;
      configRoot.profileSha256 = sha256(forgedText);
      await atomicWritePrivate(deployment.configPath, `${JSON.stringify(configRoot, null, 2)}\n`);
      await expect(planProtocolProfileV2Migration(migrationOptions(deployment.configPath))).rejects.toThrow(
        "已包含 v2 contract 字段",
      );
    } finally {
      await deployment.directory.cleanup();
    }
  });

  test("CLI 通过 LIVIS_RELAY_CONFIG 完成 dry-run→apply→rollback 且输出脱敏", async () => {
    const deployment = await legacyDeployment();
    try {
      const contractArgs = [
        "--wire-contract-revision",
        LEGACY_V1_WIRE_CONTRACT_REVISION,
        "--credential-mode",
        LEGACY_V1_CREDENTIAL_MODE,
      ];
      const missingConfigValue = await runCli(deployment.configPath, [
        "profile",
        "migrate-v2",
        ...contractArgs,
        "--dry-run",
        "--config",
      ]);
      expect(missingConfigValue.exitCode).toBe(1);
      expect(missingConfigValue.stderr).toContain("--config 必须提供非空值");
      expect(await readFile(deployment.configPath, "utf8")).toBe(deployment.configText);

      const explicitConfig = await runCli(join(deployment.directory.path, "missing-config.json"), [
        "profile",
        "migrate-v2",
        ...contractArgs,
        "--dry-run",
        "--config",
        deployment.configPath,
      ]);
      expect(explicitConfig.exitCode).toBe(0);
      expect(explicitConfig.stderr).toBe("");

      const dryRun = await runCli(deployment.configPath, [
        "profile",
        "migrate-v2",
        ...contractArgs,
        "--dry-run",
      ]);
      expect(dryRun.exitCode).toBe(0);
      expect(dryRun.stderr).toBe("");
      expect(JSON.parse(dryRun.stdout).dryRun).toBeTrue();
      expect(await readFile(deployment.configPath, "utf8")).toBe(deployment.configText);
      expect(await readFile(deployment.profilePath, "utf8")).toBe(deployment.profileText);
      expect(await Bun.file(join(deployment.directory.path, "profile-migrations")).exists()).toBeFalse();
      expect(await userVersion(deployment.databasePath)).toBe(27);

      const apply = await runCli(deployment.configPath, [
        "profile",
        "migrate-v2",
        ...contractArgs,
        "--apply",
        "--acknowledge-reviewed-wire-contract",
        "--acknowledge-daemon-and-hermes-stopped",
      ]);
      expect(apply.exitCode).toBe(0);
      expect(apply.stderr).toBe("");
      const applied = JSON.parse(apply.stdout) as Record<string, unknown>;
      expect(applied.changed).toBeTrue();
      expect(applied.sqliteTouched).toBeFalse();
      const migrated = await loadRelayConfig(deployment.configPath);
      expect(parseProtocolProfile(await readFile(migrated.config.profile, "utf8")).schemaVersion).toBe(2);
      expect(await userVersion(deployment.databasePath)).toBe(27);

      const rollback = await runCli(deployment.configPath, [
        "profile",
        "rollback-migration",
        "--receipt",
        String(applied.receiptPath),
        "--apply",
        "--acknowledge-daemon-and-hermes-stopped",
      ]);
      expect(rollback.exitCode).toBe(0);
      expect(rollback.stderr).toBe("");
      const rolledBack = JSON.parse(rollback.stdout) as Record<string, unknown>;
      expect(rolledBack.changed).toBeTrue();
      expect(rolledBack.requiresOldDaemon).toBeTrue();
      expect(rolledBack.sqliteTouched).toBeFalse();
      expect(await readFile(deployment.configPath, "utf8")).toBe(deployment.configText);
      expect(await userVersion(deployment.databasePath)).toBe(27);
      for (const output of [explicitConfig.stdout, dryRun.stdout, apply.stdout, rollback.stdout]) {
        expect(output).not.toContain(deployment.v2.endpoints.idaasBaseUrl);
        expect(output).not.toContain(deployment.v2.oauth.clientId);
        expect(output).not.toContain(deployment.config.security.allowedNodeIds[0]!);
      }
    } finally {
      await deployment.directory.cleanup();
    }
  });
});
