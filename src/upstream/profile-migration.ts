import { randomUUID } from "node:crypto";
import {
  lstat,
  readFile,
  realpath,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseRelayConfig, type RelayConfig } from "../config.ts";
import {
  CURRENT_CREDENTIAL_MODE,
  CURRENT_WIRE_CONTRACT_REVISION,
  type CredentialMode,
  type WireContractRevision,
} from "../protocol/contract.ts";
import {
  parseProtocolProfile,
  resolveProfilePath,
  runtimeContractSha256,
  type ProtocolProfile,
} from "../protocol/profile.ts";
import { DaemonOfflineGuard, ProfileOperationGuard } from "../state/offline-guard.ts";
import { requireFreshSupportedProof, supportedProofPath } from "./proof.ts";
import {
  asNonEmptyString,
  asSha256,
  DurableCommitUncertainError,
  durableAtomicWritePrivate,
  durableMkdirPrivate,
  durableRename,
  expandHome,
  parseJsonObject,
  sha256,
} from "../util.ts";

export const LEGACY_V1_WIRE_CONTRACT_REVISION = "livis-relay-v1-access-refresh-r1" as const;
export const LEGACY_V1_CREDENTIAL_MODE = "access-and-refresh-token" as const;

type MigrationStatus = "migration-required" | "already-current";

class UnsafePrivatePathError extends Error {}

export interface ProtocolProfileMigrationPlan {
  status: MigrationStatus;
  configPath: string;
  stateDir: string;
  config: RelayConfig;
  sourceConfigText: string;
  sourceConfigSha256: string;
  sourceProfilePath: string;
  sourceProfileText: string;
  sourceProfileSha256: string;
  sourceSchemaVersion: 1 | 2;
  targetConfigText: string;
  targetConfigSha256: string;
  targetProfilePath: string;
  targetProfileText: string;
  targetProfileSha256: string;
  targetProfile: ProtocolProfile;
  wireContractRevision: typeof LEGACY_V1_WIRE_CONTRACT_REVISION;
  credentialMode: typeof LEGACY_V1_CREDENTIAL_MODE;
  runtimeContractSha256: string;
}

export interface ProtocolProfileMigrationReceipt {
  schemaVersion: 1;
  kind: "protocol-profile-v1-to-v2";
  migrationId: string;
  preparedAt: string;
  source: {
    configSha256: string;
    profileSha256: string;
    profileSchemaVersion: 1;
  };
  target: {
    configSha256: string;
    profileRelativePath: string;
    profileSha256: string;
    profileSchemaVersion: 2;
    wireContractRevision: typeof LEGACY_V1_WIRE_CONTRACT_REVISION;
    credentialMode: typeof LEGACY_V1_CREDENTIAL_MODE;
    runtimeContractSha256: string;
  };
  backups: {
    configRelativePath: "config.before.json";
    profileRelativePath: "profile.before.json";
  };
  proofPolicy: {
    quarantineRelativeDirectory: "proof-quarantine";
    regenerateRequired: true;
  };
  commitPoint: "config-durable-rename";
}

function isWithin(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

async function requirePrivateRegularFile(path: string, label: string): Promise<string> {
  const absolute = resolve(path);
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new UnsafePrivatePathError(`${label} 必须是普通文件且不能是 symlink：${absolute}`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new UnsafePrivatePathError(
      `${label} 权限过宽：${(info.mode & 0o777).toString(8)}，必须是 0600 或更严格`,
    );
  }
  return realpath(absolute);
}

async function requirePrivateDirectory(path: string, label: string): Promise<string> {
  const absolute = resolve(path);
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new UnsafePrivatePathError(`${label} 必须是目录且不能是 symlink：${absolute}`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new UnsafePrivatePathError(
      `${label} 权限过宽：${(info.mode & 0o777).toString(8)}，必须是 0700 或更严格`,
    );
  }
  return realpath(absolute);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  // 统一经过 durable helper：除创建新目录外，也会修复上次进程在
  // mkdir 与显式 chmod 之间退出所遗留的 000/owner 权限不足目录。
  // 直接用 requirePrivateDirectory 会把 000 误当作“0700 或更严格”，
  // 导致后续创建文件时 EACCES，破坏崩溃后的可重试性。
  await durableMkdirPrivate(path);
  await requirePrivateDirectory(path, path);
}

async function requireOptionalPrivateDirectory(path: string, label: string): Promise<void> {
  try {
    await requirePrivateDirectory(path, label);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function assertFrozenLegacyMapping(
  revision: string,
  mode: string,
): asserts revision is typeof LEGACY_V1_WIRE_CONTRACT_REVISION {
  if (
    CURRENT_WIRE_CONTRACT_REVISION !== LEGACY_V1_WIRE_CONTRACT_REVISION ||
    CURRENT_CREDENTIAL_MODE !== LEGACY_V1_CREDENTIAL_MODE
  ) {
    throw new Error(
      "当前 registry 已离开 legacy v1 的固定 wire contract；必须新增专用迁移，不能沿用本命令",
    );
  }
  if (revision !== LEGACY_V1_WIRE_CONTRACT_REVISION) {
    throw new Error(`--wire-contract-revision 必须显式为 ${LEGACY_V1_WIRE_CONTRACT_REVISION}`);
  }
  if (mode !== LEGACY_V1_CREDENTIAL_MODE) {
    throw new Error(`--credential-mode 必须显式为 ${LEGACY_V1_CREDENTIAL_MODE}`);
  }
}

function assertLegacyProjectionPreserved(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
): void {
  const sourceProjection = { ...source };
  const targetProjection = { ...target };
  delete sourceProjection.schemaVersion;
  delete targetProjection.schemaVersion;
  delete targetProjection.wireContractRevision;
  delete targetProjection.credentialMode;
  if (JSON.stringify(sourceProjection) !== JSON.stringify(targetProjection)) {
    throw new Error("protocol profile v1→v2 迁移改变了 legacy 字段，拒绝继续");
  }
}

function buildMigratedProfile(
  sourceText: string,
  label: string,
  revision: typeof LEGACY_V1_WIRE_CONTRACT_REVISION,
  mode: typeof LEGACY_V1_CREDENTIAL_MODE,
): { text: string; profile: ProtocolProfile } {
  const sourceRoot = parseJsonObject(sourceText, label);
  if (sourceRoot.schemaVersion !== 1) {
    throw new Error(`${label} 不是 protocol profile schema v1`);
  }
  if (
    Object.hasOwn(sourceRoot, "wireContractRevision") ||
    Object.hasOwn(sourceRoot, "credentialMode")
  ) {
    throw new Error("schema v1 profile 已包含 v2 contract 字段，必须人工审阅，不能自动覆盖");
  }
  const targetRoot: Record<string, unknown> = {
    ...sourceRoot,
    schemaVersion: 2,
    wireContractRevision: revision,
    credentialMode: mode,
  };
  assertLegacyProjectionPreserved(sourceRoot, targetRoot);
  const text = `${JSON.stringify(targetRoot, null, 2)}\n`;
  return { text, profile: parseProtocolProfile(text, `${label} migrated v2`) };
}

function changedConfigText(
  sourceText: string,
  label: string,
  profilePath: string,
  profileSha256: string,
): string {
  const root = parseJsonObject(sourceText, label);
  root.profile = profilePath;
  root.profileSha256 = profileSha256;
  return `${JSON.stringify(root, null, 2)}\n`;
}

export async function planProtocolProfileV2Migration(options: {
  configPath: string;
  wireContractRevision: string;
  credentialMode: string;
  forbiddenStateRoot?: string;
}): Promise<ProtocolProfileMigrationPlan> {
  if (process.env.LIVIS_RELAY_STATE_DIR) {
    throw new Error("迁移期间禁止使用 LIVIS_RELAY_STATE_DIR 覆盖；必须以磁盘 config 的 stateDir 为准");
  }
  assertFrozenLegacyMapping(options.wireContractRevision, options.credentialMode);
  const configPath = await requirePrivateRegularFile(expandHome(options.configPath), "config");
  if (options.forbiddenStateRoot && isWithin(options.forbiddenStateRoot, configPath)) {
    throw new Error("config 必须位于项目仓库之外，禁止修改 Git 工作树中的 live 配置");
  }
  const sourceConfigText = await readFile(configPath, "utf8");
  const sourceConfigSha256 = sha256(sourceConfigText);
  const config = parseRelayConfig(sourceConfigText, configPath);
  const stateDir = await requirePrivateDirectory(config.stateDir, "stateDir");
  if (options.forbiddenStateRoot && isWithin(options.forbiddenStateRoot, stateDir)) {
    throw new Error("stateDir 必须位于项目仓库之外，禁止把私有迁移备份写入 Git 工作树");
  }
  const connectorSocketDirectory = await requirePrivateDirectory(
    dirname(config.connector.socketPath),
    "connector socket parent directory",
  );
  if (!isWithin(stateDir, connectorSocketDirectory)) {
    throw new Error("connector socket parent directory 必须位于私有 stateDir 内");
  }
  const sourceProfilePath = await requirePrivateRegularFile(
    resolveProfilePath(config.profile, configPath),
    "active protocol profile",
  );
  const sourceProfileText = await readFile(sourceProfilePath, "utf8");
  const sourceProfileSha256 = sha256(sourceProfileText);
  if (sourceProfileSha256 !== config.profileSha256) {
    throw new Error("active protocol profile 原始字节 SHA-256 与 config pin 不一致");
  }

  const sourceRoot = parseJsonObject(sourceProfileText, sourceProfilePath);
  if (sourceRoot.schemaVersion === 2) {
    const targetProfile = parseProtocolProfile(sourceProfileText, sourceProfilePath);
    return {
      status: "already-current",
      configPath,
      stateDir,
      config,
      sourceConfigText,
      sourceConfigSha256,
      sourceProfilePath,
      sourceProfileText,
      sourceProfileSha256,
      sourceSchemaVersion: 2,
      targetConfigText: sourceConfigText,
      targetConfigSha256: sourceConfigSha256,
      targetProfilePath: sourceProfilePath,
      targetProfileText: sourceProfileText,
      targetProfileSha256: sourceProfileSha256,
      targetProfile,
      wireContractRevision: LEGACY_V1_WIRE_CONTRACT_REVISION,
      credentialMode: LEGACY_V1_CREDENTIAL_MODE,
      runtimeContractSha256: runtimeContractSha256(targetProfile),
    };
  }
  if (sourceRoot.schemaVersion !== 1) {
    throw new Error(`不支持的 protocol profile schemaVersion：${String(sourceRoot.schemaVersion)}`);
  }

  const migrated = buildMigratedProfile(
    sourceProfileText,
    sourceProfilePath,
    LEGACY_V1_WIRE_CONTRACT_REVISION,
    LEGACY_V1_CREDENTIAL_MODE,
  );
  const targetProfileText = migrated.text;
  const targetProfileSha256 = sha256(targetProfileText);
  if (targetProfileSha256 === sourceProfileSha256) {
    throw new Error("迁移后 profile SHA 未变化，拒绝继续");
  }
  const targetProfilePath = join(stateDir, "protocol-profiles-v2", `${targetProfileSha256}.json`);
  const targetConfigText = changedConfigText(
    sourceConfigText,
    configPath,
    targetProfilePath,
    targetProfileSha256,
  );
  const targetConfig = parseRelayConfig(targetConfigText, configPath);
  if (resolve(targetConfig.stateDir) !== resolve(config.stateDir)) {
    throw new Error("迁移后的 config 改变了 stateDir，拒绝继续");
  }
  return {
    status: "migration-required",
    configPath,
    stateDir,
    config,
    sourceConfigText,
    sourceConfigSha256,
    sourceProfilePath,
    sourceProfileText,
    sourceProfileSha256,
    sourceSchemaVersion: 1,
    targetConfigText,
    targetConfigSha256: sha256(targetConfigText),
    targetProfilePath,
    targetProfileText,
    targetProfileSha256,
    targetProfile: migrated.profile,
    wireContractRevision: LEGACY_V1_WIRE_CONTRACT_REVISION,
    credentialMode: LEGACY_V1_CREDENTIAL_MODE,
    runtimeContractSha256: runtimeContractSha256(migrated.profile),
  };
}

export function protocolProfileMigrationPlanSummary(plan: ProtocolProfileMigrationPlan): Record<string, unknown> {
  return {
    ok: true,
    status: plan.status,
    sourceSchemaVersion: plan.sourceSchemaVersion,
    targetSchemaVersion: 2,
    wireContractRevision: plan.wireContractRevision,
    credentialMode: plan.credentialMode,
    sourceConfigSha256: plan.sourceConfigSha256,
    targetConfigSha256: plan.targetConfigSha256,
    sourceProfileSha256: plan.sourceProfileSha256,
    targetProfileSha256: plan.targetProfileSha256,
    runtimeContractSha256: plan.runtimeContractSha256,
    targetProfilePath: plan.targetProfilePath,
    changes: plan.status === "migration-required"
      ? ["schemaVersion:1→2", "wireContractRevision", "credentialMode", "config.profile", "config.profileSha256"]
      : [],
    daemonAndHermesStopRequired: plan.status === "migration-required",
    disableServiceAutoRestartRequired: plan.status === "migration-required",
    proofRegenerationRequired: plan.status === "migration-required" ? true : null,
    proofStatus: plan.status === "migration-required" ? "will-be-quarantined-on-apply" : "unchecked",
    sqliteTouched: false,
  };
}

async function readbackSha(path: string): Promise<string> {
  const canonical = await requirePrivateRegularFile(path, path);
  return sha256(await readFile(canonical, "utf8"));
}

async function assertPlanInputsUnchanged(plan: ProtocolProfileMigrationPlan): Promise<void> {
  if (await readbackSha(plan.configPath) !== plan.sourceConfigSha256) {
    throw new Error("config 在 dry-run/prepare 后发生变化，拒绝覆盖");
  }
  if (await readbackSha(plan.sourceProfilePath) !== plan.sourceProfileSha256) {
    throw new Error("active protocol profile 在 dry-run/prepare 后发生变化，拒绝覆盖");
  }
}

async function createMigrationDirectory(stateDir: string): Promise<{ id: string; path: string }> {
  const root = join(stateDir, "profile-migrations");
  await ensurePrivateDirectory(root);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
    const path = join(root, id);
    try {
      const created = await durableMkdirPrivate(path);
      if (!created) continue;
      return { id, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("无法创建唯一 migration 目录");
}

async function writeOrVerifyPrivate(path: string, text: string): Promise<void> {
  try {
    const canonical = await requirePrivateRegularFile(path, path);
    if (sha256(await readFile(canonical, "utf8")) !== sha256(text)) {
      throw new Error(`已存在内容不同的迁移文件，拒绝覆盖：${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await durableAtomicWritePrivate(path, text);
  }
}

async function quarantineProofs(options: {
  stateDir: string;
  directory: string;
  oldProfileSha256: string;
  newProfileSha256: string;
}): Promise<string[]> {
  await ensurePrivateDirectory(options.directory);
  await requireOptionalPrivateDirectory(
    join(options.stateDir, "upstream"),
    "upstream proof directory",
  );
  await requireOptionalPrivateDirectory(
    join(options.stateDir, "upstream", "proofs"),
    "upstream keyed proof directory",
  );
  const candidates = migrationProofCandidates(options);
  const quarantined: string[] = [];
  for (const candidate of candidates) {
    try {
      const source = await requirePrivateRegularFile(candidate.path, `${candidate.label} proof`);
      if (!isWithin(join(options.stateDir, "upstream"), source)) {
        throw new Error(`${candidate.label} proof 通过 symlink 或路径逃逸到 stateDir/upstream 之外`);
      }
      const destination = join(options.directory, `${candidate.label}.json`);
      try {
        await lstat(destination);
        throw new Error(`proof quarantine 目标已存在：${destination}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await durableRename(source, destination);
      quarantined.push(candidate.label);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return quarantined;
}

function migrationProofCandidates(options: {
  stateDir: string;
  oldProfileSha256: string;
  newProfileSha256: string;
}): Array<{ label: string; path: string }> {
  return [
    { label: "old-profile", path: supportedProofPath(options.stateDir, options.oldProfileSha256) },
    { label: "new-profile", path: supportedProofPath(options.stateDir, options.newProfileSha256) },
    { label: "last-supported", path: supportedProofPath(options.stateDir) },
  ];
}

async function hasAnyMigrationProof(options: {
  stateDir: string;
  oldProfileSha256: string;
  newProfileSha256: string;
}): Promise<boolean> {
  await requireOptionalPrivateDirectory(
    join(options.stateDir, "upstream"),
    "upstream proof directory",
  );
  await requireOptionalPrivateDirectory(
    join(options.stateDir, "upstream", "proofs"),
    "upstream keyed proof directory",
  );
  for (const candidate of migrationProofCandidates(options)) {
    try {
      await lstat(candidate.path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return false;
}

function migrationReceipt(
  plan: ProtocolProfileMigrationPlan,
  migration: { id: string; path: string },
): ProtocolProfileMigrationReceipt {
  const targetRelativePath = relative(plan.stateDir, plan.targetProfilePath);
  if (!isWithin(plan.stateDir, plan.targetProfilePath) || targetRelativePath.startsWith("..")) {
    throw new Error("迁移目标 profile 逃逸 stateDir，拒绝继续");
  }
  return {
    schemaVersion: 1,
    kind: "protocol-profile-v1-to-v2",
    migrationId: migration.id,
    preparedAt: new Date().toISOString(),
    source: {
      configSha256: plan.sourceConfigSha256,
      profileSha256: plan.sourceProfileSha256,
      profileSchemaVersion: 1,
    },
    target: {
      configSha256: plan.targetConfigSha256,
      profileRelativePath: targetRelativePath,
      profileSha256: plan.targetProfileSha256,
      profileSchemaVersion: 2,
      wireContractRevision: plan.wireContractRevision,
      credentialMode: plan.credentialMode,
      runtimeContractSha256: plan.runtimeContractSha256,
    },
    backups: {
      configRelativePath: "config.before.json",
      profileRelativePath: "profile.before.json",
    },
    proofPolicy: {
      quarantineRelativeDirectory: "proof-quarantine",
      regenerateRequired: true,
    },
    commitPoint: "config-durable-rename",
  };
}

async function validateCommittedMigration(plan: ProtocolProfileMigrationPlan): Promise<void> {
  if (await readbackSha(plan.configPath) !== plan.targetConfigSha256) {
    throw new Error("config commit readback SHA 不一致");
  }
  const loaded = parseRelayConfig(await readFile(plan.configPath, "utf8"), plan.configPath);
  const profilePath = resolveProfilePath(loaded.profile, plan.configPath);
  await requirePrivateDirectory(dirname(profilePath), "committed target profile directory");
  const canonicalProfilePath = await requirePrivateRegularFile(
    profilePath,
    "committed target profile",
  );
  if (
    resolve(canonicalProfilePath) !== resolve(plan.targetProfilePath) ||
    !isWithin(plan.stateDir, canonicalProfilePath)
  ) {
    throw new Error("config commit readback profile path 不一致");
  }
  const profileText = await readFile(canonicalProfilePath, "utf8");
  if (sha256(profileText) !== plan.targetProfileSha256) {
    throw new Error("config commit readback profile SHA 不一致");
  }
  const profile = parseProtocolProfile(profileText, canonicalProfilePath);
  if (runtimeContractSha256(profile) !== plan.runtimeContractSha256) {
    throw new Error("config commit readback runtime contract SHA 不一致");
  }
  for (const path of [
    supportedProofPath(plan.stateDir, plan.sourceProfileSha256),
    supportedProofPath(plan.stateDir, plan.targetProfileSha256),
    supportedProofPath(plan.stateDir),
  ]) {
    try {
      await lstat(path);
      throw new Error(`迁移后仍存在可复用 supported proof：${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function applyProtocolProfileV2Migration(
  plan: ProtocolProfileMigrationPlan,
  options: {
    acknowledgeReviewedWireContract: boolean;
    acknowledgeDaemonAndHermesStopped: boolean;
  },
): Promise<Record<string, unknown>> {
  if (plan.status === "already-current") {
    let proofStatus = "missing-or-invalid";
    try {
      await requireFreshSupportedProof({
        stateDir: plan.stateDir,
        profile: plan.targetProfile,
        profileSha256: plan.targetProfileSha256,
      });
      proofStatus = "fresh";
    } catch {
      // 不向 stdout 暴露 proof 内部或私有 profile 内容；只返回门禁状态。
    }
    return {
      ...protocolProfileMigrationPlanSummary(plan),
      changed: false,
      dryRun: false,
      proofStatus,
      proofRegenerationRequired: proofStatus !== "fresh",
    };
  }
  if (!options.acknowledgeReviewedWireContract) {
    throw new Error("apply 前必须显式确认已审阅固定 wire contract");
  }
  if (!options.acknowledgeDaemonAndHermesStopped) {
    throw new Error("apply 前必须停止 daemon、Hermes，并禁用服务管理器自动拉起");
  }

  let retainGuardsForManualRecovery = false;
  const operationGuard = await ProfileOperationGuard.acquire(plan.stateDir, "protocol-profile-migration");
  try {
    const offlineGuard = await DaemonOfflineGuard.acquire(
      plan.config.connector.socketPath,
      plan.stateDir,
      "protocol-profile-migration",
    );
    try {
      await assertPlanInputsUnchanged(plan);
      const targetDirectory = dirname(plan.targetProfilePath);
      await ensurePrivateDirectory(targetDirectory);
      const migration = await createMigrationDirectory(plan.stateDir);
      const receipt = migrationReceipt(plan, migration);
      const configBackupPath = join(migration.path, receipt.backups.configRelativePath);
      const profileBackupPath = join(migration.path, receipt.backups.profileRelativePath);
      const receiptPath = join(migration.path, "PREPARED.json");
      await durableAtomicWritePrivate(configBackupPath, plan.sourceConfigText);
      await durableAtomicWritePrivate(profileBackupPath, plan.sourceProfileText);
      await writeOrVerifyPrivate(plan.targetProfilePath, plan.targetProfileText);
      await durableAtomicWritePrivate(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      const quarantinedProofs = await quarantineProofs({
        stateDir: plan.stateDir,
        directory: join(migration.path, receipt.proofPolicy.quarantineRelativeDirectory),
        oldProfileSha256: plan.sourceProfileSha256,
        newProfileSha256: plan.targetProfileSha256,
      });
      await assertPlanInputsUnchanged(plan);
      await operationGuard.assertHeld();
      await offlineGuard.assertHeld();

      await durableAtomicWritePrivate(plan.configPath, plan.targetConfigText);

      try {
        await validateCommittedMigration(plan);
      } catch (error) {
        const liveSha = await readbackSha(plan.configPath).catch(() => "unreadable");
        if (liveSha === plan.targetConfigSha256) {
          await durableAtomicWritePrivate(plan.configPath, plan.sourceConfigText);
        } else if (liveSha !== plan.sourceConfigSha256) {
          throw new Error("迁移验证失败后发现并发 config，拒绝覆盖，必须人工检查", {
            cause: error,
          });
        }
        if (await readbackSha(plan.configPath) !== plan.sourceConfigSha256) {
          throw new Error("迁移验证失败且自动恢复 config 未通过 readback，必须人工恢复", { cause: error });
        }
        await durableAtomicWritePrivate(join(migration.path, "AUTO_ROLLED_BACK.json"), `${JSON.stringify({
          schemaVersion: 1,
          rolledBackAt: new Date().toISOString(),
          reason: "post-commit validation failed",
          sourceConfigSha256: plan.sourceConfigSha256,
        }, null, 2)}\n`);
        throw new Error("迁移提交后验证失败，已自动恢复原 config；supported proof 仍保持隔离", {
          cause: error,
        });
      }

      let configCommittedMarkerWritten = true;
      let proofRebuildMarkerWritten = true;
      try {
        await durableAtomicWritePrivate(join(migration.path, "CONFIG_COMMITTED.json"), `${JSON.stringify({
          schemaVersion: 1,
          committedAt: new Date().toISOString(),
          configSha256: plan.targetConfigSha256,
        }, null, 2)}\n`);
      } catch {
        configCommittedMarkerWritten = false;
      }
      try {
        await durableAtomicWritePrivate(join(migration.path, "PROOF_REBUILD_REQUIRED.json"), `${JSON.stringify({
          schemaVersion: 1,
          requiredAt: new Date().toISOString(),
          profileSha256: plan.targetProfileSha256,
        }, null, 2)}\n`);
      } catch {
        proofRebuildMarkerWritten = false;
      }
      return {
        ok: true,
        changed: true,
        dryRun: false,
        receiptPath,
        configBackupPath,
        profileBackupPath,
        targetProfilePath: plan.targetProfilePath,
        sourceConfigSha256: plan.sourceConfigSha256,
        targetConfigSha256: plan.targetConfigSha256,
        sourceProfileSha256: plan.sourceProfileSha256,
        targetProfileSha256: plan.targetProfileSha256,
        runtimeContractSha256: plan.runtimeContractSha256,
        wireContractRevision: plan.wireContractRevision,
        credentialMode: plan.credentialMode,
        quarantinedProofs,
        configCommittedMarkerWritten,
        proofRebuildMarkerWritten,
        proofRegenerationRequired: true,
        next: ["upstream check", "doctor --online", "启动 daemon 与 Hermes"],
        sqliteTouched: false,
      };
    } catch (error) {
      if (error instanceof DurableCommitUncertainError) {
        retainGuardsForManualRecovery = true;
      }
      throw error;
    } finally {
      if (!retainGuardsForManualRecovery) await offlineGuard.release();
    }
  } finally {
    if (!retainGuardsForManualRecovery) await operationGuard.release();
  }
}

function receiptObjectAt(
  root: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, unknown> {
  const value = root[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}.${key} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function parseMigrationReceipt(text: string, label: string): ProtocolProfileMigrationReceipt {
  const root = parseJsonObject(text, label);
  const source = receiptObjectAt(root, "source", label);
  const target = receiptObjectAt(root, "target", label);
  const backups = receiptObjectAt(root, "backups", label);
  const proofPolicy = receiptObjectAt(root, "proofPolicy", label);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "protocol-profile-v1-to-v2" ||
    root.commitPoint !== "config-durable-rename" ||
    source.profileSchemaVersion !== 1 ||
    target.profileSchemaVersion !== 2 ||
    target.wireContractRevision !== LEGACY_V1_WIRE_CONTRACT_REVISION ||
    target.credentialMode !== LEGACY_V1_CREDENTIAL_MODE ||
    backups.configRelativePath !== "config.before.json" ||
    backups.profileRelativePath !== "profile.before.json" ||
    proofPolicy.quarantineRelativeDirectory !== "proof-quarantine" ||
    proofPolicy.regenerateRequired !== true
  ) {
    throw new Error(`${label} 不是受支持的 protocol profile migration receipt`);
  }
  return {
    schemaVersion: 1,
    kind: "protocol-profile-v1-to-v2",
    migrationId: asNonEmptyString(root.migrationId, `${label}.migrationId`),
    preparedAt: asNonEmptyString(root.preparedAt, `${label}.preparedAt`),
    source: {
      configSha256: asSha256(source.configSha256, `${label}.source.configSha256`),
      profileSha256: asSha256(source.profileSha256, `${label}.source.profileSha256`),
      profileSchemaVersion: 1,
    },
    target: {
      configSha256: asSha256(target.configSha256, `${label}.target.configSha256`),
      profileRelativePath: asNonEmptyString(
        target.profileRelativePath,
        `${label}.target.profileRelativePath`,
      ),
      profileSha256: asSha256(target.profileSha256, `${label}.target.profileSha256`),
      profileSchemaVersion: 2,
      wireContractRevision: LEGACY_V1_WIRE_CONTRACT_REVISION,
      credentialMode: LEGACY_V1_CREDENTIAL_MODE,
      runtimeContractSha256: asSha256(
        target.runtimeContractSha256,
        `${label}.target.runtimeContractSha256`,
      ),
    },
    backups: {
      configRelativePath: "config.before.json",
      profileRelativePath: "profile.before.json",
    },
    proofPolicy: {
      quarantineRelativeDirectory: "proof-quarantine",
      regenerateRequired: true,
    },
    commitPoint: "config-durable-rename",
  };
}

interface RestoredConfigPlan {
  text: string;
  profilePath: string;
  exactConfigBytes: boolean;
}

async function planRestoredConfig(options: {
  configPath: string;
  stateDir: string;
  backupConfigText: string;
  sourceProfileSha256: string;
  forceFallback: boolean;
}): Promise<RestoredConfigPlan> {
  const config = parseRelayConfig(options.backupConfigText, options.configPath);
  const originalProfilePath = resolveProfilePath(config.profile, options.configPath);
  if (
    !options.forceFallback &&
    await legacyProfileIsValid(originalProfilePath, options.sourceProfileSha256)
  ) {
    const canonical = await requirePrivateRegularFile(originalProfilePath, "rollback source profile");
    return { text: options.backupConfigText, profilePath: canonical, exactConfigBytes: true };
  }
  const fallbackDirectory = join(options.stateDir, "protocol-profiles-v1-rollback");
  const fallbackProfilePath = join(fallbackDirectory, `${options.sourceProfileSha256}.json`);
  const root = parseJsonObject(options.backupConfigText, options.configPath);
  root.profile = fallbackProfilePath;
  root.profileSha256 = options.sourceProfileSha256;
  return {
    text: `${JSON.stringify(root, null, 2)}\n`,
    profilePath: fallbackProfilePath,
    exactConfigBytes: false,
  };
}

async function materializeRestoredProfile(options: {
  plan: RestoredConfigPlan;
  repairDirectory: string;
  backupProfileText: string;
  sourceProfileSha256: string;
}): Promise<{ repaired: boolean; quarantinedPath: string | null }> {
  if (options.plan.exactConfigBytes) {
    if (!await legacyProfileIsValid(options.plan.profilePath, options.sourceProfileSha256)) {
      throw new Error("rollback source profile 在提交前发生变化，拒绝继续");
    }
    return { repaired: false, quarantinedPath: null };
  }

  const fallbackDirectory = dirname(options.plan.profilePath);
  await ensurePrivateDirectory(fallbackDirectory);
  if (await legacyProfileIsValid(options.plan.profilePath, options.sourceProfileSha256)) {
    return { repaired: false, quarantinedPath: null };
  }

  let quarantinedPath: string | null = null;
  try {
    const info = await lstat(options.plan.profilePath);
    if (!info.isFile() && !info.isSymbolicLink()) {
      throw new Error(`rollback fallback 不是可隔离的普通文件或 symlink：${options.plan.profilePath}`);
    }
    quarantinedPath = join(
      options.repairDirectory,
      `invalid-fallback-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`,
    );
    await durableRename(options.plan.profilePath, quarantinedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await durableAtomicWritePrivate(options.plan.profilePath, options.backupProfileText);
  if (!await legacyProfileIsValid(options.plan.profilePath, options.sourceProfileSha256)) {
    throw new Error("rollback fallback 写入后未通过 schema/SHA/权限 readback");
  }
  return { repaired: true, quarantinedPath };
}

async function legacyProfileIsValid(path: string, expectedSha256: string): Promise<boolean> {
  let canonical: string;
  try {
    canonical = await requirePrivateRegularFile(path, "rolled-back legacy profile");
  } catch (error) {
    if (
      error instanceof UnsafePrivatePathError ||
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
  let text: string;
  try {
    text = await readFile(canonical, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (sha256(text) !== expectedSha256) return false;
  try {
    return parseJsonObject(text, canonical).schemaVersion === 1;
  } catch {
    return false;
  }
}

function fallbackRollbackConfig(options: {
  configPath: string;
  stateDir: string;
  backupConfigText: string;
  sourceProfileSha256: string;
}): { text: string; profilePath: string; sha256: string } {
  const profilePath = join(
    options.stateDir,
    "protocol-profiles-v1-rollback",
    `${options.sourceProfileSha256}.json`,
  );
  const root = parseJsonObject(options.backupConfigText, options.configPath);
  root.profile = profilePath;
  root.profileSha256 = options.sourceProfileSha256;
  const text = `${JSON.stringify(root, null, 2)}\n`;
  return { text, profilePath, sha256: sha256(text) };
}

export async function rollbackProtocolProfileMigration(options: {
  configPath: string;
  receiptPath: string;
  acknowledgeDaemonAndHermesStopped: boolean;
  forbiddenStateRoot?: string;
}): Promise<Record<string, unknown>> {
  if (!options.acknowledgeDaemonAndHermesStopped) {
    throw new Error("rollback 前必须停止 daemon、Hermes，并禁用服务管理器自动拉起");
  }
  if (process.env.LIVIS_RELAY_STATE_DIR) {
    throw new Error("rollback 期间禁止使用 LIVIS_RELAY_STATE_DIR 覆盖");
  }
  const configPath = await requirePrivateRegularFile(expandHome(options.configPath), "config");
  if (options.forbiddenStateRoot && isWithin(options.forbiddenStateRoot, configPath)) {
    throw new Error("config 必须位于项目仓库之外，禁止修改 Git 工作树中的 live 配置");
  }
  const currentConfigText = await readFile(configPath, "utf8");
  const currentConfig = parseRelayConfig(currentConfigText, configPath);
  const stateDir = await requirePrivateDirectory(currentConfig.stateDir, "stateDir");
  if (options.forbiddenStateRoot && isWithin(options.forbiddenStateRoot, stateDir)) {
    throw new Error("stateDir 必须位于项目仓库之外，禁止把私有回滚状态写入 Git 工作树");
  }
  const receiptPath = await requirePrivateRegularFile(expandHome(options.receiptPath), "migration receipt");
  const allowedReceiptRoot = `${resolve(stateDir, "profile-migrations")}${sep}`;
  if (!receiptPath.startsWith(allowedReceiptRoot)) {
    throw new Error("只允许使用当前 stateDir/profile-migrations 下的 receipt");
  }
  const receiptDirectory = dirname(receiptPath);
  await requirePrivateDirectory(receiptDirectory, "migration receipt directory");
  const receipt = parseMigrationReceipt(await readFile(receiptPath, "utf8"), receiptPath);
  if (receipt.migrationId !== receiptDirectory.slice(receiptDirectory.lastIndexOf(sep) + 1)) {
    throw new Error("receipt migrationId 与所在目录不一致");
  }
  const configBackupPath = join(receiptDirectory, receipt.backups.configRelativePath);
  const profileBackupPath = join(receiptDirectory, receipt.backups.profileRelativePath);
  const backupConfigText = await readFile(
    await requirePrivateRegularFile(configBackupPath, "config backup"),
    "utf8",
  );
  const backupProfileText = await readFile(
    await requirePrivateRegularFile(profileBackupPath, "profile backup"),
    "utf8",
  );
  if (sha256(backupConfigText) !== receipt.source.configSha256) {
    throw new Error("config backup SHA 与 receipt 不一致");
  }
  if (sha256(backupProfileText) !== receipt.source.profileSha256) {
    throw new Error("profile backup SHA 与 receipt 不一致");
  }
  if (parseJsonObject(backupProfileText, profileBackupPath).schemaVersion !== 1) {
    throw new Error("profile backup 不是 schema v1");
  }
  const backupConfig = parseRelayConfig(backupConfigText, configBackupPath);
  if (backupConfig.profileSha256 !== receipt.source.profileSha256) {
    throw new Error("config/profile backup 的 source SHA 不一致");
  }
  const backupStateDir = await requirePrivateDirectory(
    backupConfig.stateDir,
    "config backup stateDir",
  );
  if (resolve(backupStateDir) !== resolve(stateDir)) {
    throw new Error("config backup 不属于当前 stateDir");
  }
  const rebuiltTarget = buildMigratedProfile(
    backupProfileText,
    profileBackupPath,
    LEGACY_V1_WIRE_CONTRACT_REVISION,
    LEGACY_V1_CREDENTIAL_MODE,
  );
  const rebuiltTargetProfileSha256 = sha256(rebuiltTarget.text);
  const expectedTargetRelativePath = join(
    "protocol-profiles-v2",
    `${rebuiltTargetProfileSha256}.json`,
  );
  if (
    receipt.target.profileSha256 !== rebuiltTargetProfileSha256 ||
    receipt.target.runtimeContractSha256 !== runtimeContractSha256(rebuiltTarget.profile) ||
    receipt.target.profileRelativePath !== expectedTargetRelativePath
  ) {
    throw new Error("receipt/backups 无法重建同一次 source→target profile 迁移");
  }
  const targetProfilePath = resolve(stateDir, expectedTargetRelativePath);
  if (!isWithin(stateDir, targetProfilePath)) {
    throw new Error("receipt target profile path 逃逸 stateDir");
  }
  const rebuiltTargetConfigText = changedConfigText(
    backupConfigText,
    configBackupPath,
    targetProfilePath,
    rebuiltTargetProfileSha256,
  );
  if (sha256(rebuiltTargetConfigText) !== receipt.target.configSha256) {
    throw new Error("receipt/backups 无法重建同一次 source→target config 迁移");
  }
  const currentSha = sha256(currentConfigText);
  const fallback = fallbackRollbackConfig({
    configPath,
    stateDir,
    backupConfigText,
    sourceProfileSha256: receipt.source.profileSha256,
  });
  let rollbackMode:
    | "target"
    | "source-verify"
    | "source-repair"
    | "source-proof-cleanup"
    | "fallback-verify"
    | "fallback-repair"
    | "fallback-proof-cleanup";
  if (currentSha === receipt.source.configSha256) {
    rollbackMode = "source-verify";
  } else if (currentSha === fallback.sha256) {
    rollbackMode = "fallback-verify";
  } else if (currentSha === receipt.target.configSha256) {
    rollbackMode = "target";
  } else {
    throw new Error("当前 config 既不是 receipt source 也不是 target，拒绝覆盖并发修改");
  }

  let retainGuardsForManualRecovery = false;
  const operationGuard = await ProfileOperationGuard.acquire(
    stateDir,
    "protocol-profile-migration-rollback",
  );
  try {
    const offlineGuard = await DaemonOfflineGuard.acquire(
      currentConfig.connector.socketPath,
      stateDir,
      "protocol-profile-migration-rollback",
    );
    try {
      if (await readbackSha(configPath) !== currentSha) {
        throw new Error("config 在 rollback prepare 后发生变化，拒绝覆盖");
      }
      if (rollbackMode === "source-verify" || rollbackMode === "fallback-verify") {
        const exactConfigBytes = rollbackMode === "source-verify";
        const activeProfilePath = exactConfigBytes
          ? resolveProfilePath(currentConfig.profile, configPath)
          : fallback.profilePath;
        const activeProfileValid = await legacyProfileIsValid(
          activeProfilePath,
          receipt.source.profileSha256,
        );
        const proofExists = await hasAnyMigrationProof({
          stateDir,
          oldProfileSha256: receipt.source.profileSha256,
          newProfileSha256: receipt.target.profileSha256,
        });
        if (activeProfileValid && !proofExists) {
          return {
            ok: true,
            changed: false,
            alreadyRolledBack: true,
            exactConfigBytes,
            requiresOldDaemon: true,
            proofRegenerationRequired: true,
            sqliteTouched: false,
          };
        }
        rollbackMode = activeProfileValid
          ? exactConfigBytes ? "source-proof-cleanup" : "fallback-proof-cleanup"
          : exactConfigBytes ? "source-repair" : "fallback-repair";
      }
      if (rollbackMode === "target") {
        if (
          resolve(resolveProfilePath(currentConfig.profile, configPath)) !== resolve(targetProfilePath) ||
          currentConfig.profileSha256 !== receipt.target.profileSha256
        ) {
          throw new Error("target config 的 profile path/SHA 与 receipt 不一致");
        }
        // live target profile 可能正是回滚要恢复的故障点，不把它当作信任输入。
        // source backups 已重建 target profile/config/runtime digest，且 live config
        // 的完整 SHA 已精确命中该 target；回滚不读取、不修复也不覆盖坏 target。
      }
      const restored = await planRestoredConfig({
        configPath,
        stateDir,
        backupConfigText,
        sourceProfileSha256: receipt.source.profileSha256,
        forceFallback: rollbackMode === "fallback-repair" || rollbackMode === "fallback-proof-cleanup",
      });
      if (rollbackMode === "source-proof-cleanup" && !restored.exactConfigBytes) {
        rollbackMode = "source-repair";
      } else if (
        rollbackMode === "fallback-proof-cleanup" &&
        !await legacyProfileIsValid(restored.profilePath, receipt.source.profileSha256)
      ) {
        rollbackMode = "fallback-repair";
      } else if (
        (rollbackMode === "source-repair" && restored.exactConfigBytes) ||
        (rollbackMode === "fallback-repair" &&
          await legacyProfileIsValid(restored.profilePath, receipt.source.profileSha256))
      ) {
        const proofExists = await hasAnyMigrationProof({
          stateDir,
          oldProfileSha256: receipt.source.profileSha256,
          newProfileSha256: receipt.target.profileSha256,
        });
        if (!proofExists) {
          return {
            ok: true,
            changed: false,
            alreadyRolledBack: true,
            exactConfigBytes: restored.exactConfigBytes,
            requiresOldDaemon: true,
            proofRegenerationRequired: true,
            sqliteTouched: false,
          };
        }
        rollbackMode = restored.exactConfigBytes
          ? "source-proof-cleanup"
          : "fallback-proof-cleanup";
      }
      const rollbackId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
      const restoredConfigSha256 = sha256(restored.text);
      const rollbackPreparedPath = join(receiptDirectory, `ROLLBACK_PREPARED-${rollbackId}.json`);
      await durableAtomicWritePrivate(rollbackPreparedPath, `${JSON.stringify({
        schemaVersion: 1,
        kind: "protocol-profile-migration-rollback-prepared",
        preparedAt: new Date().toISOString(),
        migrationId: receipt.migrationId,
        rollbackMode,
        targetConfigSha256: receipt.target.configSha256,
        restoredConfigSha256,
        sourceProfileSha256: receipt.source.profileSha256,
        commitPoint: rollbackMode === "fallback-repair"
          ? "fallback-profile-durable-rename"
          : rollbackMode === "source-proof-cleanup" || rollbackMode === "fallback-proof-cleanup"
            ? "proof-quarantine"
            : "config-durable-rename",
        proofRegenerationRequired: true,
      }, null, 2)}\n`);
      const preRollbackPath = join(receiptDirectory, `config.pre-rollback-${rollbackId}.json`);
      await durableAtomicWritePrivate(preRollbackPath, currentConfigText);
      const rollbackProofDirectory = join(receiptDirectory, `proof-quarantine-rollback-${rollbackId}`);
      const quarantinedProofs = await quarantineProofs({
        stateDir,
        directory: rollbackProofDirectory,
        oldProfileSha256: receipt.source.profileSha256,
        newProfileSha256: receipt.target.profileSha256,
      });
      if (
        (rollbackMode === "source-proof-cleanup" || rollbackMode === "fallback-proof-cleanup") &&
        quarantinedProofs.length === 0
      ) {
        throw new Error("rollback proof cleanup 期间 proof 状态发生变化，拒绝虚假报告成功");
      }
      if (await readbackSha(configPath) !== currentSha) {
        throw new Error("config 在 rollback proof 隔离期间发生变化，拒绝继续");
      }
      await operationGuard.assertHeld();
      await offlineGuard.assertHeld();
      const proofCleanupOnly =
        rollbackMode === "source-proof-cleanup" || rollbackMode === "fallback-proof-cleanup";
      let profileMaterialization: { repaired: boolean; quarantinedPath: string | null };
      if (proofCleanupOnly) {
        if (!await legacyProfileIsValid(restored.profilePath, receipt.source.profileSha256)) {
          throw new Error("active v1 profile 在 proof cleanup 期间发生变化；proof 已隔离，请重试修复");
        }
        profileMaterialization = { repaired: false, quarantinedPath: null };
      } else {
        profileMaterialization = await materializeRestoredProfile({
          plan: restored,
          repairDirectory: receiptDirectory,
          backupProfileText,
          sourceProfileSha256: receipt.source.profileSha256,
        });
      }
      if (await readbackSha(configPath) !== currentSha) {
        throw new Error("config 在 rollback profile 准备期间发生变化，拒绝继续");
      }
      await operationGuard.assertHeld();
      await offlineGuard.assertHeld();
      if (restoredConfigSha256 !== currentSha) {
        await durableAtomicWritePrivate(configPath, restored.text);
      }
      let restoredProfilePath: string;
      try {
        if (await readbackSha(configPath) !== restoredConfigSha256) {
          throw new Error("rollback config readback SHA 不一致");
        }
        const restoredConfig = parseRelayConfig(await readFile(configPath, "utf8"), configPath);
        const configuredProfilePath = resolveProfilePath(restoredConfig.profile, configPath);
        const canonicalConfiguredProfilePath = await requirePrivateRegularFile(
          configuredProfilePath,
          "rollback profile readback",
        );
        if (
          resolve(canonicalConfiguredProfilePath) !== resolve(restored.profilePath) ||
          restoredConfig.profileSha256 !== receipt.source.profileSha256 ||
          !await legacyProfileIsValid(canonicalConfiguredProfilePath, receipt.source.profileSha256)
        ) {
          throw new Error("rollback profile readback path/SHA/schema/权限不一致");
        }
        restoredProfilePath = canonicalConfiguredProfilePath;
      } catch (error) {
        const liveSha = await readbackSha(configPath).catch(() => "unreadable");
        if (liveSha === restoredConfigSha256 && liveSha !== currentSha) {
          await durableAtomicWritePrivate(configPath, currentConfigText);
        } else if (liveSha !== currentSha) {
          throw new Error("rollback 验证失败后发现并发 config，拒绝覆盖，必须人工检查", {
            cause: error,
          });
        }
        if (await readbackSha(configPath) !== currentSha) {
          throw new Error("rollback 验证失败且恢复操作前 config 未通过 readback，必须人工恢复", {
            cause: error,
          });
        }
        throw new Error("rollback 提交后验证失败，已恢复操作前 config；supported proof 保持隔离", {
          cause: error,
        });
      }
      const rollbackReceiptPath = join(receiptDirectory, `ROLLED_BACK-${rollbackId}.json`);
      let rollbackReceiptWritten = true;
      try {
        await durableAtomicWritePrivate(rollbackReceiptPath, `${JSON.stringify({
        schemaVersion: 1,
        kind: "protocol-profile-migration-rollback",
        rolledBackAt: new Date().toISOString(),
        migrationId: receipt.migrationId,
        rollbackMode,
        restoredConfigSha256,
          sourceProfileSha256: receipt.source.profileSha256,
          exactConfigBytes: restored.exactConfigBytes,
          repairedInvalidProfile: profileMaterialization.repaired,
          quarantinedInvalidProfilePath: profileMaterialization.quarantinedPath,
          proofRegenerationRequired: true,
          requiresOldDaemon: true,
        }, null, 2)}\n`);
      } catch {
        rollbackReceiptWritten = false;
      }
      return {
        ok: true,
        changed: true,
        rollbackReceiptPath: rollbackReceiptWritten ? rollbackReceiptPath : null,
        rollbackReceiptWritten,
        preRollbackPath,
        rollbackPreparedPath,
        restoredConfigSha256,
        restoredProfilePath,
        exactConfigBytes: restored.exactConfigBytes,
        repairedInvalidProfile: profileMaterialization.repaired,
        quarantinedInvalidProfilePath: profileMaterialization.quarantinedPath,
        quarantinedProofs,
        proofRegenerationRequired: true,
        requiresOldDaemon: true,
        sqliteTouched: false,
      };
    } catch (error) {
      if (error instanceof DurableCommitUncertainError) {
        retainGuardsForManualRecovery = true;
      }
      throw error;
    } finally {
      if (!retainGuardsForManualRecovery) await offlineGuard.release();
    }
  } finally {
    if (!retainGuardsForManualRecovery) await operationGuard.release();
  }
}

// 让 receipt 的公开类型显式固定当前兼容值，避免未来错误放宽成任意字符串。
const _receiptTypeGuards: [WireContractRevision, CredentialMode] = [
  LEGACY_V1_WIRE_CONTRACT_REVISION,
  LEGACY_V1_CREDENTIAL_MODE,
];
void _receiptTypeGuards;
