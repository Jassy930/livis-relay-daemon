import { describe, expect, test } from "bun:test";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { loadRelayConfig } from "../src/config.ts";
import type { RelayIdentity } from "../src/identity.ts";
import { loadProtocolProfile } from "../src/protocol/profile.ts";
import {
  ProfileOperationGuard,
  ProfileOperationGuardBusyError,
} from "../src/state/offline-guard.ts";
import {
  activateReviewedProfile,
  ProfileActivationRollbackError,
  ProfileRollbackCompensationError,
  rollbackProfileConfig,
  validateProfileActivation,
  type ProfileConfigTransactionHooks,
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

async function prepareActivation(directoryPath: string, configDirectoryPath?: string) {
  directoryPath = await realpath(directoryPath);
  configDirectoryPath = configDirectoryPath
    ? await realpath(configDirectoryPath)
    : directoryPath;
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
  const configPath = join(configDirectoryPath, "config.json");
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
    configText,
    candidatePath,
    identity,
    liveSnapshot: supportedSnapshot(candidate),
  };
}

async function prepareAliasedStateActivation(rootPath: string) {
  const root = await realpath(rootPath);
  const stateParent = join(root, "state-parent-a");
  const redirectedStateParent = join(root, "state-parent-b");
  const stateDir = join(stateParent, "state");
  const redirectedStateDir = join(redirectedStateParent, "state");
  const stateDirAliasParent = join(root, "state-parent-link");
  const stateDirAlias = join(stateDirAliasParent, "state");
  await mkdir(stateParent, { mode: 0o700 });
  await mkdir(redirectedStateParent, { mode: 0o700 });
  await mkdir(stateDir, { mode: 0o700 });
  await mkdir(redirectedStateDir, { mode: 0o700 });
  await symlink(stateParent, stateDirAliasParent);
  const fixture = await prepareActivation(stateDir);
  fixture.config.stateDir = stateDirAlias;
  fixture.configText = `${JSON.stringify(fixture.config, null, 2)}\n`;
  await atomicWritePrivate(fixture.configPath, fixture.configText);
  return {
    fixture,
    stateDir,
    redirectedStateDir,
    stateDirAlias,
    stateDirAliasParent,
    redirectedStateParent,
  };
}

function activationOptions(
  fixture: Awaited<ReturnType<typeof prepareActivation>>,
  guard: ProfileOperationGuard,
  transactionHooks?: ProfileConfigTransactionHooks,
) {
  return {
    configPath: fixture.configPath,
    expectedConfigText: fixture.configText,
    config: fixture.config,
    activeProfile: fixture.active,
    candidateProfile: fixture.candidate,
    candidateSourcePath: fixture.candidatePath,
    identity: fixture.identity,
    liveSnapshot: fixture.liveSnapshot,
    guard,
    transactionHooks,
  };
}

async function expectOriginalProfileStillActive(
  fixture: Awaited<ReturnType<typeof prepareActivation>>,
): Promise<void> {
  const loaded = await loadRelayConfig(fixture.configPath);
  expect(loaded.text).toBe(fixture.configText);
  expect(loaded.config.profile).toBe(fixture.config.profile);
  expect(loaded.config.profileSha256).toBe(fixture.config.profileSha256);
  expect((await loadProtocolProfile(
    loaded.config.profile,
    loaded.path,
    loaded.config.profileSha256,
  )).id).toBe(fixture.active.id);
}

async function directoryEntries(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
    throw error;
  }
}

async function createFifo(path: string): Promise<void> {
  const subprocess = Bun.spawn(["mkfifo", path], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`mkfifo 失败（exit ${exitCode}）：${stderr.trim()}`);
  }
}

async function runCliWithStateOverride(
  stateDir: string,
  configPath: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
    cwd: resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      LIVIS_RELAY_CONFIG: configPath,
      LIVIS_RELAY_STATE_DIR: stateDir,
    },
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

describe("官方 profile 原子激活", () => {
  test("自动补偿失败会保留原错误、补偿错误和配置备份路径", () => {
    const error = new ProfileActivationRollbackError(
      new Error("approval failed"),
      [new Error("config restore failed")],
      "/state/config-backups/backup.json",
    );
    expect(error.errors).toHaveLength(2);
    expect(error.message).toContain("/state/config-backups/backup.json");
    expect(error.backupConfigPath).toBe("/state/config-backups/backup.json");
  });

  test("CLI 在加载 config、联网和获取 guard 前拒绝 stateDir 环境覆盖", async () => {
    const directory = await temporaryDirectory();
    try {
      const overrideStateDir = join(directory.path, "override");
      await mkdir(overrideStateDir, { mode: 0o700 });
      const missingConfigPath = join(directory.path, "missing-config.json");
      const activate = await runCliWithStateOverride(
        overrideStateDir,
        missingConfigPath,
        [
          "upstream",
          "activate",
          "--profile",
          join(directory.path, "missing-profile.json"),
          "--acknowledge-reviewed-profile",
        ],
      );
      expect(activate.exitCode).toBe(1);
      expect(activate.stderr).toContain("禁止使用 LIVIS_RELAY_STATE_DIR");

      const rollback = await runCliWithStateOverride(
        overrideStateDir,
        missingConfigPath,
        [
          "upstream",
          "rollback",
          "--backup",
          join(directory.path, "missing-backup.json"),
          "--acknowledge-rollback",
        ],
      );
      expect(rollback.exitCode).toBe(1);
      expect(rollback.stderr).toContain("禁止使用 LIVIS_RELAY_STATE_DIR");
      expect(await directoryEntries(overrideStateDir)).toEqual([]);
    } finally {
      await directory.cleanup();
    }
  });

  test("activation/rollback API 入口拒绝 stateDir 环境覆盖且零托管写入", async () => {
    const directory = await temporaryDirectory();
    const originalOverride = process.env.LIVIS_RELAY_STATE_DIR;
    try {
      const fixture = await prepareActivation(directory.path);
      const activationGuard = await ProfileOperationGuard.acquire(
        directory.path,
        "upstream-activate",
      );
      process.env.LIVIS_RELAY_STATE_DIR = join(directory.path, "override");
      try {
        await expect(activateReviewedProfile(activationOptions(fixture, activationGuard)))
          .rejects.toThrow("禁止使用 LIVIS_RELAY_STATE_DIR");
      } finally {
        if (originalOverride === undefined) delete process.env.LIVIS_RELAY_STATE_DIR;
        else process.env.LIVIS_RELAY_STATE_DIR = originalOverride;
        await activationGuard.release();
      }

      const rollbackGuard = await ProfileOperationGuard.acquire(
        directory.path,
        "upstream-rollback",
      );
      process.env.LIVIS_RELAY_STATE_DIR = join(directory.path, "override");
      try {
        await expect(rollbackProfileConfig({
          configPath: fixture.configPath,
          expectedConfigText: fixture.configText,
          currentConfig: fixture.config,
          currentProfile: fixture.active,
          backupConfigPath: join(directory.path, "missing-backup.json"),
          guard: rollbackGuard,
        })).rejects.toThrow("禁止使用 LIVIS_RELAY_STATE_DIR");
      } finally {
        if (originalOverride === undefined) delete process.env.LIVIS_RELAY_STATE_DIR;
        else process.env.LIVIS_RELAY_STATE_DIR = originalOverride;
        await rollbackGuard.release();
      }

      await expectOriginalProfileStillActive(fixture);
      expect(await directoryEntries(join(directory.path, "config-backups"))).toEqual([]);
      expect(await directoryEntries(join(directory.path, "upstream"))).toEqual([]);
      expect(await directoryEntries(join(directory.path, "upstream-approvals"))).toEqual([]);
    } finally {
      if (originalOverride === undefined) delete process.env.LIVIS_RELAY_STATE_DIR;
      else process.env.LIVIS_RELAY_STATE_DIR = originalOverride;
      await directory.cleanup();
    }
  });

  test("非环境 API stateDir 与磁盘 config 不一致时 activation/rollback 均零写拒绝", async () => {
    const directory = await temporaryDirectory();
    try {
      const fixture = await prepareActivation(directory.path);
      const effectiveStateDir = join(directory.path, "other-state");
      await mkdir(effectiveStateDir, { mode: 0o700 });
      const mismatchedConfig = { ...fixture.config, stateDir: effectiveStateDir };

      const activationGuard = await ProfileOperationGuard.acquire(
        effectiveStateDir,
        "upstream-activate",
      );
      try {
        await expect(activateReviewedProfile({
          ...activationOptions(fixture, activationGuard),
          config: mismatchedConfig,
        })).rejects.toThrow("拒绝隐式迁移");
      } finally {
        await activationGuard.release();
      }

      const rollbackGuard = await ProfileOperationGuard.acquire(
        effectiveStateDir,
        "upstream-rollback",
      );
      try {
        await expect(rollbackProfileConfig({
          configPath: fixture.configPath,
          expectedConfigText: fixture.configText,
          currentConfig: mismatchedConfig,
          currentProfile: fixture.active,
          backupConfigPath: join(directory.path, "missing-backup.json"),
          guard: rollbackGuard,
        })).rejects.toThrow("拒绝隐式迁移");
      } finally {
        await rollbackGuard.release();
      }

      await expectOriginalProfileStillActive(fixture);
      expect(await directoryEntries(effectiveStateDir)).toEqual([]);
      expect(await directoryEntries(join(directory.path, "config-backups"))).toEqual([]);
      expect(await directoryEntries(join(directory.path, "upstream-approvals"))).toEqual([]);
    } finally {
      await directory.cleanup();
    }
  });

  test("activation 提交后 stateDir alias 改指外部目录时失败且不向外部写入", async () => {
    const directory = await temporaryDirectory();
    try {
      const deployment = await prepareAliasedStateActivation(directory.path);
      const guard = await ProfileOperationGuard.acquire(
        deployment.stateDirAlias,
        "upstream-activate",
      );
      let failure: unknown;
      try {
        await activateReviewedProfile(activationOptions(deployment.fixture, guard, {
          afterConfigRename: async () => {
            await unlink(deployment.stateDirAliasParent);
            await symlink(
              deployment.redirectedStateParent,
              deployment.stateDirAliasParent,
            );
          },
        }));
      } catch (error) {
        failure = error;
      } finally {
        await guard.release();
      }

      expect(failure).toBeInstanceOf(ProfileActivationRollbackError);
      expect(await readFile(deployment.fixture.configPath, "utf8"))
        .toBe(deployment.fixture.configText);
      expect(await directoryEntries(deployment.redirectedStateDir)).toEqual([]);
      expect(await directoryEntries(join(deployment.stateDir, "upstream-approvals")))
        .toHaveLength(1);
    } finally {
      await directory.cleanup();
    }
  });

  test("rollback 提交后 stateDir alias 改指外部目录时失败且保留操作前配置", async () => {
    const directory = await temporaryDirectory();
    try {
      const deployment = await prepareAliasedStateActivation(directory.path);
      const activationGuard = await ProfileOperationGuard.acquire(
        deployment.stateDirAlias,
        "upstream-activate",
      );
      let activated;
      try {
        activated = await activateReviewedProfile(
          activationOptions(deployment.fixture, activationGuard),
        );
      } finally {
        await activationGuard.release();
      }
      const current = await loadRelayConfig(deployment.fixture.configPath);
      const rollbackGuard = await ProfileOperationGuard.acquire(
        deployment.stateDirAlias,
        "upstream-rollback",
      );
      let failure: unknown;
      try {
        await rollbackProfileConfig({
          configPath: deployment.fixture.configPath,
          expectedConfigText: current.text,
          currentConfig: current.config,
          currentProfile: deployment.fixture.candidate,
          backupConfigPath: activated!.receipt.backupConfigPath,
          guard: rollbackGuard,
          transactionHooks: {
            afterConfigRename: async () => {
              await unlink(deployment.stateDirAliasParent);
              await symlink(
                deployment.redirectedStateParent,
                deployment.stateDirAliasParent,
              );
            },
          },
        });
      } catch (error) {
        failure = error;
      } finally {
        await rollbackGuard.release();
      }

      expect(failure).toBeInstanceOf(ProfileRollbackCompensationError);
      expect(await readFile(deployment.fixture.configPath, "utf8")).toBe(current.text);
      expect(await directoryEntries(deployment.redirectedStateDir)).toEqual([]);
    } finally {
      await directory.cleanup();
    }
  });

  test("proof 与审批回执先落盘，live config durable rename 后可精确回滚", async () => {
    const directory = await temporaryDirectory();
    try {
      const fixture = await prepareActivation(directory.path);
      const guard = await ProfileOperationGuard.acquire(directory.path, "upstream-activate");
      let proofAndReceiptWereReady = false;
      let managedDirectoriesWerePrivate = false;
      let activated;
      try {
        activated = await activateReviewedProfile(activationOptions(fixture, guard, {
          beforeConfigRename: async () => {
            const managedDirectories = [
              join(directory.path, "protocol-profiles"),
              join(directory.path, "config-backups"),
              join(directory.path, "upstream"),
              join(directory.path, "upstream", "proofs"),
              join(directory.path, "upstream-approvals"),
            ];
            const directoryInfo = await Promise.all(managedDirectories.map((path) => lstat(path)));
            managedDirectoriesWerePrivate = directoryInfo.every((info) => (
              info.isDirectory() &&
              !info.isSymbolicLink() &&
              (info.mode & 0o777) === 0o700
            ));
            const approvals = await directoryEntries(join(directory.path, "upstream-approvals"));
            const candidateHash = sha256(`${JSON.stringify(fixture.candidate, null, 2)}\n`);
            proofAndReceiptWereReady =
              await Bun.file(supportedProofPath(directory.path, candidateHash)).exists() &&
              approvals.length === 1;
          },
        }));
      } finally {
        await guard.release();
      }

      expect(proofAndReceiptWereReady).toBeTrue();
      expect(managedDirectoriesWerePrivate).toBeTrue();
      const loaded = await loadRelayConfig(fixture.configPath);
      expect(loaded.config.profile).toContain("livis-community-v2.1.0.json");
      expect(loaded.config.profileSha256).not.toBe(fixture.config.profileSha256);
      expect((await loadProtocolProfile(
        loaded.config.profile,
        loaded.path,
        loaded.config.profileSha256,
      )).id).toBe(fixture.candidate.id);
      expect(sha256(loaded.text)).toBe(activated!.receipt.configCommitSha256);
      expect(await readFile(activated!.receipt.backupConfigPath, "utf8")).toBe(fixture.configText);
      expect(await Bun.file(activated!.receiptPath).exists()).toBeTrue();
      expect(await Bun.file(activated!.supportedProofPath).exists()).toBeTrue();
      expect(basename(activated!.receipt.backupConfigPath)).toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/,
      );

      const rollbackGuard = await ProfileOperationGuard.acquire(directory.path, "upstream-rollback");
      let rollback;
      try {
        rollback = await rollbackProfileConfig({
          configPath: fixture.configPath,
          expectedConfigText: loaded.text,
          currentConfig: loaded.config,
          currentProfile: fixture.candidate,
          backupConfigPath: activated!.receipt.backupConfigPath,
          guard: rollbackGuard,
        });
      } finally {
        await rollbackGuard.release();
      }
      const rolledBack = await loadRelayConfig(fixture.configPath);
      expect(rolledBack.text).toBe(fixture.configText);
      expect((await loadProtocolProfile(
        rolledBack.config.profile,
        rolledBack.path,
        rolledBack.config.profileSha256,
      )).id).toBe(fixture.active.id);
      expect(await readFile(rollback!.preRollbackBackupPath, "utf8")).toBe(loaded.text);
      expect(basename(rollback!.preRollbackBackupPath)).toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-pre-rollback\.json$/,
      );
    } finally {
      await directory.cleanup();
    }
  });

  test("config parent 路径含 symlink 祖先时 activation 与 rollback 均拒绝", async () => {
    const directory = await temporaryDirectory();
    try {
      const root = await realpath(directory.path);
      const realConfigRoot = join(root, "real-config-root");
      const realConfigDirectory = join(realConfigRoot, "private-config");
      const aliasConfigRoot = join(root, "alias-config-root");
      await mkdir(realConfigDirectory, { recursive: true, mode: 0o700 });
      await symlink(realConfigRoot, aliasConfigRoot, "dir");

      const fixture = await prepareActivation(root, realConfigDirectory);
      const aliasedConfigPath = join(aliasConfigRoot, "private-config", "config.json");
      const activationGuard = await ProfileOperationGuard.acquire(root, "upstream-activate");
      try {
        await expect(activateReviewedProfile({
          ...activationOptions(fixture, activationGuard),
          configPath: aliasedConfigPath,
        })).rejects.toThrow("不能包含 symlink 祖先");
      } finally {
        await activationGuard.release();
      }
      await expectOriginalProfileStillActive(fixture);

      const realActivationGuard = await ProfileOperationGuard.acquire(root, "upstream-activate");
      let activated;
      try {
        activated = await activateReviewedProfile(activationOptions(fixture, realActivationGuard));
      } finally {
        await realActivationGuard.release();
      }
      const current = await loadRelayConfig(fixture.configPath);
      const rollbackGuard = await ProfileOperationGuard.acquire(root, "upstream-rollback");
      try {
        await expect(rollbackProfileConfig({
          configPath: aliasedConfigPath,
          expectedConfigText: current.text,
          currentConfig: current.config,
          currentProfile: fixture.candidate,
          backupConfigPath: activated!.receipt.backupConfigPath,
          guard: rollbackGuard,
        })).rejects.toThrow("不能包含 symlink 祖先");
      } finally {
        await rollbackGuard.release();
      }
      expect(await readFile(fixture.configPath, "utf8")).toBe(current.text);
    } finally {
      await directory.cleanup();
    }
  });

  test("config parent 权限向 group 或 other 开放时在任何托管写入前拒绝", async () => {
    const directory = await temporaryDirectory();
    try {
      const root = await realpath(directory.path);
      const configDirectory = join(root, "unsafe-config");
      await mkdir(configDirectory, { mode: 0o700 });
      const fixture = await prepareActivation(root, configDirectory);
      await chmod(configDirectory, 0o755);

      const guard = await ProfileOperationGuard.acquire(root, "upstream-activate");
      try {
        await expect(activateReviewedProfile(activationOptions(fixture, guard)))
          .rejects.toThrow("config parent directory 权限过宽");
      } finally {
        await guard.release();
      }
      await expectOriginalProfileStillActive(fixture);
      expect(await directoryEntries(join(root, "upstream-approvals"))).toHaveLength(0);
    } finally {
      await directory.cleanup();
    }
  });

  for (const mutation of ["symlink", "hardlink", "0644 权限"] as const) {
    test(`已有同内容候选 profile 不是私有单链接普通文件时拒绝：${mutation}`, async () => {
      const directory = await temporaryDirectory();
      try {
        const fixture = await prepareActivation(directory.path);
        const installedProfilePath = join(
          directory.path,
          "protocol-profiles",
          "livis-community-v2.1.0.json",
        );
        const candidateText = `${JSON.stringify(fixture.candidate, null, 2)}\n`;
        const externalPath = join(directory.path, "candidate-external.json");
        await atomicWritePrivate(externalPath, candidateText);
        if (mutation === "symlink") {
          await symlink(externalPath, installedProfilePath);
        } else if (mutation === "hardlink") {
          await link(externalPath, installedProfilePath);
        } else {
          await atomicWritePrivate(installedProfilePath, candidateText);
          await chmod(installedProfilePath, 0o644);
        }

        const guard = await ProfileOperationGuard.acquire(
          directory.path,
          "upstream-activate",
        );
        try {
          await expect(activateReviewedProfile(activationOptions(fixture, guard)))
            .rejects.toThrow("已安装候选 profile 必须是 0600、单 link 的普通文件");
        } finally {
          await guard.release();
        }
        await expectOriginalProfileStillActive(fixture);
      } finally {
        await directory.cleanup();
      }
    });
  }

  test("当前 active profile 为同内容 symlink 时在任何托管写入前拒绝", async () => {
    const directory = await temporaryDirectory();
    try {
      const fixture = await prepareActivation(directory.path);
      const externalPath = join(directory.path, "active-external.json");
      const activeText = await readFile(fixture.config.profile, "utf8");
      await atomicWritePrivate(externalPath, activeText);
      await unlink(fixture.config.profile);
      await symlink(externalPath, fixture.config.profile);

      const guard = await ProfileOperationGuard.acquire(directory.path, "upstream-activate");
      try {
        await expect(activateReviewedProfile(activationOptions(fixture, guard)))
          .rejects.toThrow("当前 active profile 必须是 0600、单 link 的普通文件");
      } finally {
        await guard.release();
      }
      expect(await readFile(fixture.configPath, "utf8")).toBe(fixture.configText);
      expect(await directoryEntries(join(directory.path, "config-backups"))).toEqual([]);
      expect(await directoryEntries(join(directory.path, "upstream"))).toEqual([]);
      expect(await directoryEntries(join(directory.path, "upstream-approvals"))).toEqual([]);
    } finally {
      await directory.cleanup();
    }
  });

  test("托管目录 fsync 失败时不进入 config rename", async () => {
    const directory = await temporaryDirectory();
    try {
      const root = await realpath(directory.path);
      const fixture = await prepareActivation(root);
      const guard = await ProfileOperationGuard.acquire(root, "upstream-activate");
      let renameReached = false;
      let syncCalls = 0;
      try {
        await expect(activateReviewedProfile(activationOptions(fixture, guard, {
          syncManagedDirectory: async () => {
            syncCalls += 1;
            throw new Error("synthetic managed directory fsync failure");
          },
          beforeConfigRename: () => {
            renameReached = true;
          },
        }))).rejects.toThrow("synthetic managed directory fsync failure");
      } finally {
        await guard.release();
      }
      expect(syncCalls).toBeGreaterThan(0);
      expect(renameReached).toBeFalse();
      await expectOriginalProfileStillActive(fixture);
      expect(await directoryEntries(join(root, "upstream-approvals"))).toHaveLength(0);
    } finally {
      await directory.cleanup();
    }
  });

  test("proof 或审批回执失败时不提交 config，并精确恢复旧 proof", async () => {
    const proofFailure = await temporaryDirectory();
    try {
      const fixture = await prepareActivation(proofFailure.path);
      await writeFile(join(proofFailure.path, "upstream"), "阻断 proof 目录");
      const guard = await ProfileOperationGuard.acquire(proofFailure.path, "upstream-activate");
      try {
        await expect(activateReviewedProfile(activationOptions(fixture, guard))).rejects.toThrow();
      } finally {
        await guard.release();
      }
      await expectOriginalProfileStillActive(fixture);
      expect(await directoryEntries(join(proofFailure.path, "upstream-approvals"))).toHaveLength(0);
    } finally {
      await proofFailure.cleanup();
    }

    const receiptFailure = await temporaryDirectory();
    try {
      const fixture = await prepareActivation(receiptFailure.path);
      const previousAlias = "previous supported proof\n";
      await atomicWritePrivate(supportedProofPath(receiptFailure.path), previousAlias);
      await writeFile(join(receiptFailure.path, "upstream-approvals"), "阻断审批回执目录");
      const guard = await ProfileOperationGuard.acquire(receiptFailure.path, "upstream-activate");
      try {
        await expect(activateReviewedProfile(activationOptions(fixture, guard))).rejects.toThrow();
      } finally {
        await guard.release();
      }
      await expectOriginalProfileStillActive(fixture);
      const candidateHash = sha256(`${JSON.stringify(fixture.candidate, null, 2)}\n`);
      expect(await Bun.file(supportedProofPath(receiptFailure.path, candidateHash)).exists()).toBeFalse();
      expect(await readFile(supportedProofPath(receiptFailure.path), "utf8")).toBe(previousAlias);
    } finally {
      await receiptFailure.cleanup();
    }
  });

  test("既有 keyed proof 为 FIFO 时 activation 有界失败且不提交 config", async () => {
    const directory = await temporaryDirectory();
    try {
      const root = await realpath(directory.path);
      const fixture = await prepareActivation(root);
      const candidateHash = sha256(`${JSON.stringify(fixture.candidate, null, 2)}\n`);
      const proofPath = supportedProofPath(root, candidateHash);
      await mkdir(join(root, "upstream", "proofs"), { recursive: true, mode: 0o700 });
      await createFifo(proofPath);
      const guard = await ProfileOperationGuard.acquire(root, "upstream-activate");
      try {
        await expect(activateReviewedProfile(activationOptions(fixture, guard)))
          .rejects.toThrow("事务私有文件 必须是 0600、单 link 的普通文件");
      } finally {
        await guard.release();
      }
      await expectOriginalProfileStillActive(fixture);
      expect((await lstat(proofPath)).isFIFO()).toBeTrue();
      expect(await directoryEntries(join(root, "upstream-approvals"))).toEqual([]);
    } finally {
      await directory.cleanup();
    }
  }, 2_000);

  test("完整原始 config CAS 拒绝非 profile 字段并发修改", async () => {
    const directory = await temporaryDirectory();
    try {
      const fixture = await prepareActivation(directory.path);
      const changed = JSON.parse(fixture.configText) as Record<string, unknown>;
      (changed.relay as Record<string, unknown>).nodeName = "并发修改";
      const changedText = `${JSON.stringify(changed, null, 2)}\n`;
      await atomicWritePrivate(fixture.configPath, changedText);
      const guard = await ProfileOperationGuard.acquire(directory.path, "upstream-activate");
      try {
        await expect(activateReviewedProfile(activationOptions(fixture, guard))).rejects.toThrow(
          "配置在激活期间发生变化",
        );
      } finally {
        await guard.release();
      }
      expect(await readFile(fixture.configPath, "utf8")).toBe(changedText);
      expect(await directoryEntries(join(directory.path, "upstream-approvals"))).toHaveLength(0);
    } finally {
      await directory.cleanup();
    }
  });

  test("同一 ProfileOperationGuard 串行化 proof writer 与激活", async () => {
    const directory = await temporaryDirectory();
    try {
      await prepareActivation(directory.path);
      const guard = await ProfileOperationGuard.acquire(directory.path, "upstream-activate");
      try {
        await expect(ProfileOperationGuard.acquire(directory.path, "upstream-check"))
          .rejects.toBeInstanceOf(ProfileOperationGuardBusyError);
      } finally {
        await guard.release();
      }
    } finally {
      await directory.cleanup();
    }
  });

  for (const mutation of [
    "同内容新 inode",
    "symlink",
    "FIFO",
    "hardlink",
    "0644 权限",
  ] as const) {
    test(`activation 提交前拒绝被替换或放宽的 staging：${mutation}`, async () => {
      const directory = await temporaryDirectory();
      try {
        const root = await realpath(directory.path);
        const fixture = await prepareActivation(root);
        const guard = await ProfileOperationGuard.acquire(root, "upstream-activate");
        let stagingPath = "";
        let targetText = "";
        let externalTargetPath = "";
        let hardlinkPath = "";
        try {
          await expect(activateReviewedProfile(activationOptions(fixture, guard, {
            beforeConfigRename: async (context) => {
              stagingPath = context.stagingPath;
              targetText = context.targetText;
              switch (mutation) {
                case "同内容新 inode":
                  await unlink(stagingPath);
                  await writeFile(stagingPath, targetText, { encoding: "utf8", mode: 0o600 });
                  await chmod(stagingPath, 0o600);
                  break;
                case "symlink":
                  externalTargetPath = join(root, "external-staging-target.json");
                  await writeFile(externalTargetPath, targetText, { encoding: "utf8", mode: 0o600 });
                  await unlink(stagingPath);
                  await symlink(externalTargetPath, stagingPath);
                  break;
                case "FIFO": {
                  await unlink(stagingPath);
                  await createFifo(stagingPath);
                  break;
                }
                case "hardlink":
                  hardlinkPath = join(root, "staging-hardlink.json");
                  await link(stagingPath, hardlinkPath);
                  break;
                case "0644 权限":
                  await chmod(stagingPath, 0o644);
                  break;
              }
            },
          }))).rejects.toThrow("config staging");
        } finally {
          await guard.release();
        }

        await expectOriginalProfileStillActive(fixture);
        expect(stagingPath).not.toBe("");
        const replacementInfo = await lstat(stagingPath);
        switch (mutation) {
          case "同内容新 inode":
            expect(replacementInfo.isFile()).toBeTrue();
            expect(await readFile(stagingPath, "utf8")).toBe(targetText);
            break;
          case "symlink":
            expect(replacementInfo.isSymbolicLink()).toBeTrue();
            expect(await readFile(externalTargetPath, "utf8")).toBe(targetText);
            break;
          case "FIFO":
            expect(replacementInfo.isFIFO()).toBeTrue();
            break;
          case "hardlink":
            expect(replacementInfo.nlink).toBe(2);
            expect(await readFile(hardlinkPath, "utf8")).toBe(targetText);
            break;
          case "0644 权限":
            expect(replacementInfo.mode & 0o777).toBe(0o644);
            break;
        }
      } finally {
        await directory.cleanup();
      }
    });
  }

  test("config 提交失败或提交后读回失败都会恢复旧 config 与前置证据", async () => {
    for (const failure of ["commit", "readback"] as const) {
      const directory = await temporaryDirectory();
      try {
        const fixture = await prepareActivation(directory.path);
        const guard = await ProfileOperationGuard.acquire(directory.path, "upstream-activate");
        try {
          await expect(activateReviewedProfile(activationOptions(fixture, guard, failure === "commit"
            ? {
                beforeConfigRename: async ({ stagingPath }) => {
                  await unlink(stagingPath);
                },
              }
            : {
                afterConfigRename: () => {
                  throw new Error("synthetic config readback failure");
                },
              }))).rejects.toThrow();
        } finally {
          await guard.release();
        }
        await expectOriginalProfileStillActive(fixture);
        const candidateHash = sha256(`${JSON.stringify(fixture.candidate, null, 2)}\n`);
        expect(await Bun.file(supportedProofPath(directory.path, candidateHash)).exists()).toBeFalse();
        expect(await directoryEntries(join(directory.path, "upstream-approvals"))).toHaveLength(0);
      } finally {
        await directory.cleanup();
      }
    }
  });

  test("提交后 config 被换成同内容 symlink 时有界失败并保留审计证据", async () => {
    const directory = await temporaryDirectory();
    try {
      const fixture = await prepareActivation(directory.path);
      const externalConfigPath = join(directory.path, "external-config.json");
      const guard = await ProfileOperationGuard.acquire(directory.path, "upstream-activate");
      let failure: unknown;
      try {
        await activateReviewedProfile(activationOptions(fixture, guard, {
          afterConfigRename: async ({ configPath, targetText }) => {
            await atomicWritePrivate(externalConfigPath, targetText);
            await unlink(configPath);
            await symlink(externalConfigPath, configPath);
          },
        }));
      } catch (error) {
        failure = error;
      } finally {
        await guard.release();
      }
      expect(failure).toBeInstanceOf(ProfileActivationRollbackError);
      expect((await lstat(fixture.configPath)).isSymbolicLink()).toBeTrue();
      expect(await readFile(externalConfigPath, "utf8")).not.toBe(fixture.configText);
      expect(await directoryEntries(join(directory.path, "upstream-approvals"))).toHaveLength(1);
    } finally {
      await directory.cleanup();
    }
  });

  test("提交后 config 被换成 FIFO 时有界失败并保留审计证据", async () => {
    const directory = await temporaryDirectory();
    try {
      const fixture = await prepareActivation(directory.path);
      const guard = await ProfileOperationGuard.acquire(directory.path, "upstream-activate");
      let failure: unknown;
      try {
        await activateReviewedProfile(activationOptions(fixture, guard, {
          afterConfigRename: async ({ configPath }) => {
            await unlink(configPath);
            await createFifo(configPath);
          },
        }));
      } catch (error) {
        failure = error;
      } finally {
        await guard.release();
      }
      expect(failure).toBeInstanceOf(ProfileActivationRollbackError);
      expect((await lstat(fixture.configPath)).isFIFO()).toBeTrue();
      expect(await directoryEntries(join(directory.path, "upstream-approvals"))).toHaveLength(1);
    } finally {
      await directory.cleanup();
    }
  }, 2_000);

  test("提交后 active candidate 被换成同内容 symlink 时失败并恢复旧配置", async () => {
    const directory = await temporaryDirectory();
    try {
      const fixture = await prepareActivation(directory.path);
      const installedProfilePath = join(
        directory.path,
        "protocol-profiles",
        "livis-community-v2.1.0.json",
      );
      const externalProfilePath = join(directory.path, "external-candidate.json");
      const guard = await ProfileOperationGuard.acquire(directory.path, "upstream-activate");
      try {
        await expect(activateReviewedProfile(activationOptions(fixture, guard, {
          afterConfigRename: async () => {
            const candidateText = await readFile(installedProfilePath, "utf8");
            await atomicWritePrivate(externalProfilePath, candidateText);
            await unlink(installedProfilePath);
            await symlink(externalProfilePath, installedProfilePath);
          },
        }))).rejects.toThrow("active profile 必须是 0600、单 link 的普通文件");
      } finally {
        await guard.release();
      }
      await expectOriginalProfileStillActive(fixture);
      expect((await lstat(installedProfilePath)).isSymbolicLink()).toBeTrue();
    } finally {
      await directory.cleanup();
    }
  });

  test("补偿绝不覆盖提交后的并发 config，并保留 proof 与审批证据", async () => {
    const directory = await temporaryDirectory();
    try {
      const fixture = await prepareActivation(directory.path);
      const concurrentRoot = JSON.parse(fixture.configText) as Record<string, unknown>;
      (concurrentRoot.relay as Record<string, unknown>).nodeName = "提交后并发写入";
      const concurrentText = `${JSON.stringify(concurrentRoot, null, 2)}\n`;
      const guard = await ProfileOperationGuard.acquire(directory.path, "upstream-activate");
      let failure: unknown;
      try {
        await activateReviewedProfile(activationOptions(fixture, guard, {
          afterConfigRename: async ({ configPath }) => {
            await atomicWritePrivate(configPath, concurrentText);
          },
        }));
      } catch (error) {
        failure = error;
      } finally {
        await guard.release();
      }
      expect(failure).toBeInstanceOf(ProfileActivationRollbackError);
      expect(await readFile(fixture.configPath, "utf8")).toBe(concurrentText);
      const candidateHash = sha256(`${JSON.stringify(fixture.candidate, null, 2)}\n`);
      expect(await Bun.file(supportedProofPath(directory.path, candidateHash)).exists()).toBeTrue();
      expect(await directoryEntries(join(directory.path, "upstream-approvals"))).toHaveLength(1);
    } finally {
      await directory.cleanup();
    }
  });

  test("rollback 同样使用完整 config CAS，失败读回只恢复精确目标", async () => {
    const directory = await temporaryDirectory();
    try {
      const fixture = await prepareActivation(directory.path);
      const activationGuard = await ProfileOperationGuard.acquire(directory.path, "upstream-activate");
      let activated;
      try {
        activated = await activateReviewedProfile(activationOptions(fixture, activationGuard));
      } finally {
        await activationGuard.release();
      }
      const current = await loadRelayConfig(fixture.configPath);

      const rollbackGuard = await ProfileOperationGuard.acquire(directory.path, "upstream-rollback");
      try {
        await expect(rollbackProfileConfig({
          configPath: fixture.configPath,
          expectedConfigText: current.text,
          currentConfig: current.config,
          currentProfile: fixture.candidate,
          backupConfigPath: activated!.receipt.backupConfigPath,
          guard: rollbackGuard,
          transactionHooks: {
            afterConfigRename: () => {
              throw new Error("synthetic rollback readback failure");
            },
          },
        })).rejects.toThrow("已精确恢复操作前配置");
      } finally {
        await rollbackGuard.release();
      }
      expect(await readFile(fixture.configPath, "utf8")).toBe(current.text);

      const changedRoot = JSON.parse(current.text) as Record<string, unknown>;
      (changedRoot.relay as Record<string, unknown>).nodeName = "rollback 并发修改";
      const changedText = `${JSON.stringify(changedRoot, null, 2)}\n`;
      await atomicWritePrivate(fixture.configPath, changedText);
      const staleGuard = await ProfileOperationGuard.acquire(directory.path, "upstream-rollback");
      try {
        await expect(rollbackProfileConfig({
          configPath: fixture.configPath,
          expectedConfigText: current.text,
          currentConfig: current.config,
          currentProfile: fixture.candidate,
          backupConfigPath: activated!.receipt.backupConfigPath,
          guard: staleGuard,
        })).rejects.toThrow("配置在回滚期间发生变化");
      } finally {
        await staleGuard.release();
      }
      expect(await readFile(fixture.configPath, "utf8")).toBe(changedText);
    } finally {
      await directory.cleanup();
    }
  });

  test("rollback 只恢复旧 profile 两字段并保留当前其他配置", async () => {
    const directory = await temporaryDirectory();
    try {
      const fixture = await prepareActivation(directory.path);
      const activationGuard = await ProfileOperationGuard.acquire(
        directory.path,
        "upstream-activate",
      );
      let activated;
      try {
        activated = await activateReviewedProfile(activationOptions(fixture, activationGuard));
      } finally {
        await activationGuard.release();
      }

      const activatedConfig = await loadRelayConfig(fixture.configPath);
      const changedRoot = JSON.parse(activatedConfig.text) as Record<string, unknown>;
      (changedRoot.relay as Record<string, unknown>).nodeName = "回滚时必须保留的名称";
      (changedRoot.security as Record<string, unknown>).allowAllNodes = true;
      const changedText = `${JSON.stringify(changedRoot, null, 2)}\n`;
      await atomicWritePrivate(fixture.configPath, changedText);
      const changedConfig = await loadRelayConfig(fixture.configPath);

      const rollbackGuard = await ProfileOperationGuard.acquire(
        directory.path,
        "upstream-rollback",
      );
      try {
        await rollbackProfileConfig({
          configPath: fixture.configPath,
          expectedConfigText: changedConfig.text,
          currentConfig: changedConfig.config,
          currentProfile: fixture.candidate,
          backupConfigPath: activated!.receipt.backupConfigPath,
          guard: rollbackGuard,
        });
      } finally {
        await rollbackGuard.release();
      }

      const rolledBack = await loadRelayConfig(fixture.configPath);
      expect(rolledBack.config.profile).toBe(fixture.config.profile);
      expect(rolledBack.config.profileSha256).toBe(fixture.config.profileSha256);
      expect(rolledBack.config.relay.nodeName).toBe("回滚时必须保留的名称");
      expect(rolledBack.config.security.allowAllNodes).toBeTrue();
    } finally {
      await directory.cleanup();
    }
  });

  test("rollback 支持配置备份中的相对 profile 路径", async () => {
    const directory = await temporaryDirectory();
    try {
      const fixture = await prepareActivation(directory.path);
      fixture.config.profile = join("protocol-profiles", "active.json");
      fixture.configText = `${JSON.stringify(fixture.config, null, 2)}\n`;
      await atomicWritePrivate(fixture.configPath, fixture.configText);

      const activationGuard = await ProfileOperationGuard.acquire(
        directory.path,
        "upstream-activate",
      );
      let activated;
      try {
        activated = await activateReviewedProfile(activationOptions(fixture, activationGuard));
      } finally {
        await activationGuard.release();
      }
      const current = await loadRelayConfig(fixture.configPath);
      const rollbackGuard = await ProfileOperationGuard.acquire(
        directory.path,
        "upstream-rollback",
      );
      try {
        await rollbackProfileConfig({
          configPath: fixture.configPath,
          expectedConfigText: current.text,
          currentConfig: current.config,
          currentProfile: fixture.candidate,
          backupConfigPath: activated!.receipt.backupConfigPath,
          guard: rollbackGuard,
        });
      } finally {
        await rollbackGuard.release();
      }
      await expectOriginalProfileStillActive(fixture);
    } finally {
      await directory.cleanup();
    }
  });

  test("rollback 提交前再次验证待恢复 profile inode 且不提交 config", async () => {
    const directory = await temporaryDirectory();
    try {
      const root = await realpath(directory.path);
      const fixture = await prepareActivation(root);
      const activationGuard = await ProfileOperationGuard.acquire(
        root,
        "upstream-activate",
      );
      let activated;
      try {
        activated = await activateReviewedProfile(activationOptions(fixture, activationGuard));
      } finally {
        await activationGuard.release();
      }
      const current = await loadRelayConfig(fixture.configPath);
      const restoredProfilePath = fixture.config.profile;
      const restoredProfileText = await readFile(restoredProfilePath, "utf8");

      const rollbackGuard = await ProfileOperationGuard.acquire(root, "upstream-rollback");
      try {
        await expect(rollbackProfileConfig({
          configPath: fixture.configPath,
          expectedConfigText: current.text,
          currentConfig: current.config,
          currentProfile: fixture.candidate,
          backupConfigPath: activated!.receipt.backupConfigPath,
          guard: rollbackGuard,
          transactionHooks: {
            beforeConfigRename: async () => {
              await unlink(restoredProfilePath);
              await atomicWritePrivate(restoredProfilePath, restoredProfileText);
            },
          },
        })).rejects.toThrow("待恢复 profile");
      } finally {
        await rollbackGuard.release();
      }

      expect(await readFile(fixture.configPath, "utf8")).toBe(current.text);
    } finally {
      await directory.cleanup();
    }
  });

  test("rollback 拒绝 config-backups 内的 symlink 备份", async () => {
    const directory = await temporaryDirectory();
    try {
      const root = await realpath(directory.path);
      const fixture = await prepareActivation(root);
      const activationGuard = await ProfileOperationGuard.acquire(
        directory.path,
        "upstream-activate",
      );
      let activated;
      try {
        activated = await activateReviewedProfile(activationOptions(fixture, activationGuard));
      } finally {
        await activationGuard.release();
      }
      const current = await loadRelayConfig(fixture.configPath);
      const symlinkBackupPath = join(root, "config-backups", "symlink-backup.json");
      await symlink(activated!.receipt.backupConfigPath, symlinkBackupPath);

      const rollbackGuard = await ProfileOperationGuard.acquire(
        directory.path,
        "upstream-rollback",
      );
      try {
        await expect(rollbackProfileConfig({
          configPath: fixture.configPath,
          expectedConfigText: current.text,
          currentConfig: current.config,
          currentProfile: fixture.candidate,
          backupConfigPath: symlinkBackupPath,
          guard: rollbackGuard,
        })).rejects.toThrow("配置备份 必须是 0600、单 link 的普通文件");
      } finally {
        await rollbackGuard.release();
      }
      expect(await readFile(fixture.configPath, "utf8")).toBe(current.text);
    } finally {
      await directory.cleanup();
    }
  });

  test("rollback 提交前同样拒绝同内容新 inode staging 且不删除替代文件", async () => {
    const directory = await temporaryDirectory();
    try {
      const root = await realpath(directory.path);
      const fixture = await prepareActivation(root);
      const activationGuard = await ProfileOperationGuard.acquire(root, "upstream-activate");
      let activated;
      try {
        activated = await activateReviewedProfile(activationOptions(fixture, activationGuard));
      } finally {
        await activationGuard.release();
      }
      const current = await loadRelayConfig(fixture.configPath);
      const rollbackGuard = await ProfileOperationGuard.acquire(root, "upstream-rollback");
      let stagingPath = "";
      let targetText = "";
      try {
        await expect(rollbackProfileConfig({
          configPath: fixture.configPath,
          expectedConfigText: current.text,
          currentConfig: current.config,
          currentProfile: fixture.candidate,
          backupConfigPath: activated!.receipt.backupConfigPath,
          guard: rollbackGuard,
          transactionHooks: {
            beforeConfigRename: async (context) => {
              stagingPath = context.stagingPath;
              targetText = context.targetText;
              await unlink(stagingPath);
              await writeFile(stagingPath, targetText, { encoding: "utf8", mode: 0o600 });
              await chmod(stagingPath, 0o600);
            },
          },
        })).rejects.toThrow("config staging");
      } finally {
        await rollbackGuard.release();
      }

      expect(await readFile(fixture.configPath, "utf8")).toBe(current.text);
      expect((await lstat(stagingPath)).isFile()).toBeTrue();
      expect(await readFile(stagingPath, "utf8")).toBe(targetText);
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
