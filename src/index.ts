#!/usr/bin/env bun

import { readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadRelayConfig, initializeConfig, DEFAULT_CONFIG_PATH } from "./config.ts";
import { RelayDaemon, DAEMON_VERSION } from "./daemon.ts";
import { IdaasClient } from "./auth/idaas.ts";
import { IdentityStore } from "./identity.ts";
import { Logger, errorMessage } from "./logger.ts";
import {
  loadProtocolProfile,
  parseProtocolProfile,
  parseProtocolProfileCatalogEntry,
  resolveProfilePath,
  type ProtocolProfile,
} from "./protocol/profile.ts";
import { SecretStore } from "./secrets.ts";
import {
  ProfileOperationGuard,
  rethrowAfterProfileOperationCleanup,
  rethrowAfterProfileOperationGuardRelease,
  withProfileOperationGuardRelease,
  type ProfileOperation,
} from "./state/offline-guard.ts";
import { JobStore } from "./state/store.ts";
import { UpstreamChecker, buildCandidateProfile } from "./upstream/checker.ts";
import {
  activateReviewedProfile,
  assertProfileStateDirOverrideAbsent,
  rollbackProfileConfig,
} from "./upstream/activation.ts";
import {
  requireFreshSupportedProof,
  saveSupportedProof,
  type SupportedUpstreamProof,
} from "./upstream/proof.ts";
import {
  applyProtocolProfileV2Migration,
  planProtocolProfileV2Migration,
  protocolProfileMigrationPlanSummary,
  rollbackProtocolProfileMigration,
} from "./upstream/profile-migration.ts";
import {
  atomicWritePrivate,
  atomicWritePrivateBytes,
  expandHome,
  parseSemverTriplet,
  versionAtLeast,
  versionLessThan,
  sha256,
} from "./util.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const BUILTIN_PROFILE_DIRECTORY = join(PROJECT_ROOT, "protocol-profiles");

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  if (index < 0) return undefined;
  if (args.indexOf(option, index + 1) >= 0) {
    throw new Error(`${option} 不能重复传入`);
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} 必须提供非空值`);
  }
  return value;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

async function loadContext(configPath?: string) {
  const loaded = await loadRelayConfig(configPath);
  const profile = await loadProtocolProfile(loaded.config.profile, loaded.path, loaded.config.profileSha256);
  const secrets = new SecretStore(loaded.config.stateDir);
  const secretValues = await secrets.load();
  const identityStore = new IdentityStore(loaded.config.stateDir, profile);
  const identity = await identityStore.load();
  return { ...loaded, profile, secrets, secretValues, identityStore, identity };
}

async function loadProfileOperationContext(
  args: string[],
  operation: ProfileOperation,
): Promise<{
  context: Awaited<ReturnType<typeof loadContext>>;
  guard: ProfileOperationGuard;
}> {
  const initial = await loadRelayConfig(optionValue(args, "--config"));
  const guard = await ProfileOperationGuard.acquire(initial.config.stateDir, operation);
  try {
    const context = await loadContext(initial.path);
    if (await realpath(context.config.stateDir) !== dirname(guard.path)) {
      throw new Error("config.stateDir 在 profile operation guard 获取期间发生变化");
    }
    return { context, guard };
  } catch (error) {
    return rethrowAfterProfileOperationGuardRelease(
      guard,
      `加载 ${operation} 上下文`,
      error,
    );
  }
}

interface ProfileCatalogEntry {
  path: string;
  profile: ProtocolProfile;
}

async function loadProfileCatalog(directories: string[]): Promise<ProfileCatalogEntry[]> {
  const profiles = new Map<string, ProfileCatalogEntry>();
  for (const directory of new Set(directories.map((item) => resolve(item)))) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(directory, entry.name);
      const profile = parseProtocolProfileCatalogEntry(await Bun.file(path).text(), path);
      if (!profile) continue;
      const existing = profiles.get(profile.id);
      if (existing && JSON.stringify(existing.profile) !== JSON.stringify(profile)) {
        throw new Error(`profile.id 冲突且内容不同：${profile.id}`);
      }
      profiles.set(profile.id, existing ?? { path, profile });
    }
  }
  return [...profiles.values()];
}

async function commandInit(args: string[]): Promise<void> {
  const configPath = optionValue(args, "--config") ?? process.env.LIVIS_RELAY_CONFIG;
  const profileSourcePath = optionValue(args, "--profile");
  if (!profileSourcePath) {
    throw new Error("公开发行版不附带 live profile；用法：init --profile /绝对路径/authorized-profile.json");
  }
  const acknowledgement = hasFlag(args, "--acknowledge-unofficial-protocol");
  const initialized = await initializeConfig({
    configPath,
    profileSourcePath: expandHome(profileSourcePath),
    acknowledgeUnofficialProtocol: acknowledgement,
    forbiddenStateRoot: PROJECT_ROOT,
  });
  const config = await loadRelayConfig(initialized.configPath);
  const profile = await loadProtocolProfile(config.config.profile, config.path, config.config.profileSha256);
  const secrets = new SecretStore(initialized.stateDir);
  await secrets.initialize();
  const identity = await new IdentityStore(initialized.stateDir, profile).initialize();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    configPath: initialized.configPath,
    stateDir: initialized.stateDir,
    connectorSocket: config.config.connector.socketPath,
    agentId: identity.agentId,
    unofficialProtocolAcknowledged: acknowledgement,
    next: acknowledgement
      ? "先执行 upstream check 生成近期 supported proof，再 login，并安装启用 hermes-plugin"
      : "先审阅 docs/SECURITY.md，再重新 init 或修改配置中的 acknowledgeUnofficialProtocol",
  }, null, 2)}\n`);
}

async function commandConnectorToken(args: string[]): Promise<void> {
  const context = await loadContext(optionValue(args, "--config"));
  process.stdout.write(`${context.secretValues.connectorToken}\n`);
}

async function refreshOrRequireSupportedProof(
  context: Awaited<ReturnType<typeof loadContext>>,
  guard: ProfileOperationGuard,
): Promise<SupportedUpstreamProof> {
  let snapshot;
  try {
    snapshot = await new UpstreamChecker().check(context.profile, [context.profile]);
  } catch (error) {
    const proof = await requireFreshSupportedProof({
      stateDir: context.config.stateDir,
      profile: context.profile,
      profileSha256: context.config.profileSha256,
    });
    new Logger("upstream.guard").warn("在线复核失败，临时使用未过期的已支持证明", {
      error: errorMessage(error),
      expiresAt: proof.expiresAt,
    });
    return proof;
  }
  if (snapshot.compatibility !== "supported") {
    throw new Error(`当前 active profile 未通过上游兼容门禁：${snapshot.compatibility}`);
  }
  return (await saveSupportedProof({
    stateDir: context.config.stateDir,
    profile: context.profile,
    profileSha256: context.config.profileSha256,
    snapshot,
  }, guard)).proof;
}

async function commandLogin(args: string[]): Promise<void> {
  const { context, guard } = await loadProfileOperationContext(args, "login");
  await withProfileOperationGuardRelease(guard, "login", async () => {
    if (!context.config.security.acknowledgeUnofficialProtocol) {
      throw new Error("登录前必须确认第三方兼容协议边界");
    }
    await refreshOrRequireSupportedProof(context, guard);
    const auth = new IdaasClient(context.profile, context.secrets);
    const deviceCode = await auth.requestDeviceCode(hasFlag(args, "--force"));
    process.stdout.write(`请在浏览器完成登录：\n${deviceCode.verification_uri_complete}\n`);
    if (!hasFlag(args, "--no-open") && process.platform === "darwin") {
      const child = Bun.spawn(["open", deviceCode.verification_uri_complete], {
        stdout: "ignore",
        stderr: "ignore",
      });
      child.unref();
    }
    await auth.pollForToken(deviceCode, {
      onPending: () => process.stdout.write("."),
    });
    process.stdout.write(`\n登录成功。LiViS Agent ID：${context.identity.agentId}\n`);
  });
}

async function commandLogout(args: string[]): Promise<void> {
  const context = await loadContext(optionValue(args, "--config"));
  await new IdaasClient(context.profile, context.secrets).revoke();
  process.stdout.write("已撤销并清除本地 refresh token。\n");
}

async function commandServe(args: string[]): Promise<void> {
  const { context, guard } = await loadProfileOperationContext(args, "serve-start");
  let daemon: RelayDaemon | null = null;
  try {
    const upstreamProof = await refreshOrRequireSupportedProof(context, guard);
    daemon = RelayDaemon.create({
      config: context.config,
      profile: context.profile,
      identity: context.identity,
      secrets: context.secrets,
      secretValues: context.secretValues,
      upstreamProofExpiresAt: Date.parse(upstreamProof.expiresAt),
    });
    daemon.start();
  } catch (primaryError) {
    return rethrowAfterProfileOperationCleanup(
      "serve 启动",
      primaryError,
      [
        ...(daemon
          ? [{ label: "daemon stop", run: () => daemon!.stop() }]
          : []),
        { label: "profile operation guard release", run: () => guard.release() },
      ],
    );
  }
  if (!daemon) throw new Error("daemon 启动状态异常");
  const runningDaemon = daemon;
  try {
    await guard.release();
  } catch (primaryError) {
    return rethrowAfterProfileOperationCleanup(
      "serve 启动阶段释放 profile operation guard",
      primaryError,
      [{ label: "daemon stop", run: () => runningDaemon.stop() }],
    );
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void runningDaemon.stop().then(resolvePromise, rejectPromise);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function commandUpstreamCheck(args: string[]): Promise<void> {
  const { context, guard } = await loadProfileOperationContext(args, "upstream-check");
  await withProfileOperationGuardRelease(guard, "upstream check", async () => {
    const profileDirectory = dirname(resolveProfilePath(context.config.profile, context.path));
    const catalog = await loadProfileCatalog([profileDirectory, BUILTIN_PROFILE_DIRECTORY]);
    const artifactDirectory = join(context.config.stateDir, "upstream-artifacts", "sha256");
    const snapshot = await new UpstreamChecker({
      artifactSink: async (_kind, _url, bytes) => {
        const path = join(artifactDirectory, sha256(bytes));
        if (!await Bun.file(path).exists()) await atomicWritePrivateBytes(path, bytes);
        return path;
      },
    }).check(context.profile, catalog.map((entry) => entry.profile));
    const candidateDirectory = join(context.config.stateDir, "upstream-candidates");
    const stamp = snapshot.checkedAt.replace(/[:.]/g, "-");
    const snapshotPath = join(candidateDirectory, `${stamp}-snapshot.json`);
    await atomicWritePrivate(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    const candidateProfile = buildCandidateProfile(context.profile, snapshot);
    const candidateProfilePath = candidateProfile
      ? join(candidateDirectory, `${stamp}-profile-draft.json`)
      : null;
    if (candidateProfile && candidateProfilePath) {
      await atomicWritePrivate(candidateProfilePath, `${JSON.stringify(candidateProfile, null, 2)}\n`);
    }
    const reviewedProfilePath = snapshot.matchedProfileId
      ? catalog.find((entry) => entry.profile.id === snapshot.matchedProfileId)?.path ?? null
      : null;
    const supportedProof = snapshot.compatibility === "supported"
      ? await saveSupportedProof({
        stateDir: context.config.stateDir,
        profile: context.profile,
        profileSha256: context.config.profileSha256,
        snapshot,
      }, guard)
      : null;
    process.stdout.write(`${JSON.stringify({
      ...snapshot,
      snapshotPath,
      candidateProfilePath,
      reviewedProfilePath,
      supportedProofPath: supportedProof?.path ?? null,
    }, null, 2)}\n`);
    if (snapshot.compatibility !== "supported") {
      process.exitCode = 2;
    }
  });
}

async function commandUpstreamActivate(args: string[]): Promise<void> {
  assertProfileStateDirOverrideAbsent();
  if (!hasFlag(args, "--acknowledge-reviewed-profile")) {
    throw new Error("激活前必须人工审阅 profile，并显式传入 --acknowledge-reviewed-profile");
  }
  const candidatePathRaw = optionValue(args, "--profile");
  if (!candidatePathRaw) throw new Error("用法：upstream activate --profile PATH --acknowledge-reviewed-profile");
  const candidatePath = expandHome(candidatePathRaw);
  const { context, guard } = await loadProfileOperationContext(args, "upstream-activate");
  const activated = await withProfileOperationGuardRelease(
    guard,
    "upstream activate",
    async () => {
      const candidateProfile = parseProtocolProfile(
        await Bun.file(candidatePath).text(),
        candidatePath,
      );
      const liveSnapshot = await new UpstreamChecker().check(candidateProfile, [candidateProfile]);
      return activateReviewedProfile({
        configPath: context.path,
        expectedConfigText: context.text,
        config: context.config,
        activeProfile: context.profile,
        candidateProfile,
        candidateSourcePath: candidatePath,
        identity: context.identity,
        liveSnapshot,
        guard,
      });
    },
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    activatedProfile: activated.receipt.activated,
    previousProfile: activated.receipt.previous,
    backupConfigPath: activated.receipt.backupConfigPath,
    receiptPath: activated.receiptPath,
    supportedProofPath: activated.supportedProofPath,
    restartRequired: true,
  }, null, 2)}\n`);
}

async function commandUpstreamRollback(args: string[]): Promise<void> {
  assertProfileStateDirOverrideAbsent();
  if (!hasFlag(args, "--acknowledge-rollback")) {
    throw new Error("回滚前必须确认服务将恢复旧 profile，并显式传入 --acknowledge-rollback");
  }
  const backupPath = optionValue(args, "--backup");
  if (!backupPath) throw new Error("用法：upstream rollback --backup PATH --acknowledge-rollback");
  const { context, guard } = await loadProfileOperationContext(args, "upstream-rollback");
  const result = await withProfileOperationGuardRelease(
    guard,
    "upstream rollback",
    () => rollbackProfileConfig({
      configPath: context.path,
      expectedConfigText: context.text,
      currentConfig: context.config,
      currentProfile: context.profile,
      backupConfigPath: expandHome(backupPath),
      guard,
    }),
  );
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
}

async function commandProfileMigrateV2(args: string[]): Promise<void> {
  const dryRun = hasFlag(args, "--dry-run");
  const apply = hasFlag(args, "--apply");
  if (dryRun === apply) {
    throw new Error("profile migrate-v2 必须且只能选择 --dry-run 或 --apply");
  }
  const wireContractRevision = optionValue(args, "--wire-contract-revision");
  const credentialMode = optionValue(args, "--credential-mode");
  if (!wireContractRevision || !credentialMode) {
    throw new Error("必须显式传入 --wire-contract-revision 和 --credential-mode");
  }
  const plan = await planProtocolProfileV2Migration({
    configPath: optionValue(args, "--config") ?? process.env.LIVIS_RELAY_CONFIG ?? DEFAULT_CONFIG_PATH,
    wireContractRevision,
    credentialMode,
    forbiddenStateRoot: PROJECT_ROOT,
  });
  if (dryRun) {
    process.stdout.write(`${JSON.stringify({
      ...protocolProfileMigrationPlanSummary(plan),
      dryRun: true,
      writes: [],
    }, null, 2)}\n`);
    return;
  }
  const result = await applyProtocolProfileV2Migration(plan, {
    acknowledgeReviewedWireContract: hasFlag(args, "--acknowledge-reviewed-wire-contract"),
    acknowledgeDaemonAndHermesStopped: hasFlag(args, "--acknowledge-daemon-and-hermes-stopped"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function commandProfileRollbackMigration(args: string[]): Promise<void> {
  if (!hasFlag(args, "--apply")) {
    throw new Error("profile rollback-migration 是写操作，必须显式传入 --apply");
  }
  const receiptPath = optionValue(args, "--receipt");
  if (!receiptPath) {
    throw new Error("用法：profile rollback-migration --receipt PATH --apply --acknowledge-daemon-and-hermes-stopped");
  }
  const result = await rollbackProtocolProfileMigration({
    configPath: optionValue(args, "--config") ?? process.env.LIVIS_RELAY_CONFIG ?? DEFAULT_CONFIG_PATH,
    receiptPath,
    acknowledgeDaemonAndHermesStopped: hasFlag(args, "--acknowledge-daemon-and-hermes-stopped"),
    forbiddenStateRoot: PROJECT_ROOT,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function commandDoctor(args: string[]): Promise<void> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  let context: Awaited<ReturnType<typeof loadContext>>;
  try {
    context = await loadContext(optionValue(args, "--config"));
    checks.push({ name: "config", ok: true, detail: context.path });
    checks.push({ name: "profile", ok: true, detail: context.profile.id });
    checks.push({
      name: "protocol_acknowledgement",
      ok: context.config.security.acknowledgeUnofficialProtocol,
      detail: String(context.config.security.acknowledgeUnofficialProtocol),
    });
  } catch (error) {
    checks.push({ name: "config", ok: false, detail: errorMessage(error) });
    process.stdout.write(`${JSON.stringify({ ok: false, checks }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  const hermesProcess = Bun.spawn([context.config.hermes.command, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [hermesStdout, hermesStderr, hermesExit] = await Promise.all([
    new Response(hermesProcess.stdout).text(),
    new Response(hermesProcess.stderr).text(),
    hermesProcess.exited,
  ]);
  const currentVersion = parseSemverTriplet(`${hermesStdout}\n${hermesStderr}`);
  const minimumVersion = parseSemverTriplet(context.config.hermes.minimumVersion);
  const maximumVersion = parseSemverTriplet(context.config.hermes.maximumExclusiveVersion);
  const hermesOkay = hermesExit === 0 &&
    currentVersion !== null &&
    minimumVersion !== null &&
    maximumVersion !== null &&
    versionAtLeast(currentVersion, minimumVersion) &&
    versionLessThan(currentVersion, maximumVersion);
  checks.push({
    name: "hermes_version",
    ok: hermesOkay,
    detail: `${hermesStdout}${hermesStderr}`.trim() +
      `\n审核范围：[${context.config.hermes.minimumVersion}, ${context.config.hermes.maximumExclusiveVersion})`,
  });
  const store = new JobStore(join(context.config.stateDir, "relay.db"), IdentityStore.scopeKey(context.identity));
  const integrity = store.integrityCheck();
  checks.push({ name: "sqlite_integrity", ok: integrity === "ok", detail: integrity });
  const quarantines = store.listQuarantinedSessions();
  checks.push({
    name: "session_quarantine",
    ok: quarantines.length === 0,
    detail: quarantines.length === 0 ? "none" : JSON.stringify(quarantines),
  });
  store.close();
  try {
    const proof = await requireFreshSupportedProof({
      stateDir: context.config.stateDir,
      profile: context.profile,
      profileSha256: context.config.profileSha256,
    });
    checks.push({ name: "upstream_supported_proof", ok: true, detail: proof.expiresAt });
  } catch (error) {
    checks.push({ name: "upstream_supported_proof", ok: false, detail: errorMessage(error) });
  }
  if (hasFlag(args, "--online")) {
    try {
      const catalog = await loadProfileCatalog([
        dirname(resolveProfilePath(context.config.profile, context.path)),
        BUILTIN_PROFILE_DIRECTORY,
      ]);
      const snapshot = await new UpstreamChecker().check(context.profile, catalog.map((entry) => entry.profile));
      checks.push({
        name: "upstream_compatibility",
        ok: snapshot.compatibility === "supported",
        detail: snapshot.compatibility,
      });
    } catch (error) {
      checks.push({ name: "upstream_compatibility", ok: false, detail: errorMessage(error) });
    }
  }
  const ok = checks.every((check) => check.ok);
  process.stdout.write(`${JSON.stringify({ ok, checks }, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

async function commandStatus(args: string[]): Promise<void> {
  const context = await loadContext(optionValue(args, "--config"));
  const response = await fetch("http://localhost/v1/status", {
    unix: context.config.connector.socketPath,
    headers: { Authorization: `Bearer ${context.secretValues.connectorToken}` },
  });
  process.stdout.write(`${await response.text()}\n`);
  if (!response.ok) process.exitCode = 1;
}

async function commandReleaseSession(args: string[]): Promise<void> {
  const sessionKey = args.find((arg) => !arg.startsWith("--") && arg !== "session" && arg !== "release");
  if (!sessionKey) {
    throw new Error("用法：session release <sessionKey>；执行前必须先重启专用 Hermes Gateway 并确认旧工具已退出");
  }
  const context = await loadContext(optionValue(args, "--config"));
  const store = new JobStore(join(context.config.stateDir, "relay.db"), IdentityStore.scopeKey(context.identity));
  const released = store.releaseSessionQuarantine(sessionKey);
  store.close();
  process.stdout.write(`${JSON.stringify({ released, sessionKey })}\n`);
  if (!released) process.exitCode = 1;
}

function printHelp(): void {
  process.stdout.write(`livis-relay-daemon ${DAEMON_VERSION}\n\n`);
  process.stdout.write("命令：\n");
  process.stdout.write("  init --profile PATH [--config PATH] [--acknowledge-unofficial-protocol]\n");
  process.stdout.write("  login [--force] [--no-open] [--config PATH]\n");
  process.stdout.write("  logout [--config PATH]\n");
  process.stdout.write("  serve [--config PATH]\n");
  process.stdout.write("  status [--config PATH]\n");
  process.stdout.write("  doctor [--online] [--config PATH]\n");
  process.stdout.write("  upstream check [--config PATH]\n");
  process.stdout.write("  upstream activate --profile PATH --acknowledge-reviewed-profile [--config PATH]\n");
  process.stdout.write("  upstream rollback --backup PATH --acknowledge-rollback [--config PATH]\n");
  process.stdout.write("  profile migrate-v2 --dry-run --wire-contract-revision REVISION --credential-mode MODE [--config PATH]\n");
  process.stdout.write("  profile migrate-v2 --apply --wire-contract-revision REVISION --credential-mode MODE --acknowledge-reviewed-wire-contract --acknowledge-daemon-and-hermes-stopped [--config PATH]\n");
  process.stdout.write("  profile rollback-migration --receipt PATH --apply --acknowledge-daemon-and-hermes-stopped [--config PATH]\n");
  process.stdout.write("  connector-token [--config PATH]\n");
  process.stdout.write("  session release <sessionKey> [--config PATH]\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [command, subcommand] = args;
  switch (command) {
    case "init":
      await commandInit(args);
      break;
    case "login":
      await commandLogin(args);
      break;
    case "logout":
      await commandLogout(args);
      break;
    case "serve":
      await commandServe(args);
      break;
    case "status":
      await commandStatus(args);
      break;
    case "doctor":
      await commandDoctor(args);
      break;
    case "upstream":
      if (subcommand === "check") await commandUpstreamCheck(args);
      else if (subcommand === "activate") await commandUpstreamActivate(args);
      else if (subcommand === "rollback") await commandUpstreamRollback(args);
      else throw new Error("只支持 upstream check / upstream activate / upstream rollback");
      break;
    case "profile":
      if (subcommand === "migrate-v2") await commandProfileMigrateV2(args);
      else if (subcommand === "rollback-migration") await commandProfileRollbackMigration(args);
      else throw new Error("只支持 profile migrate-v2 / profile rollback-migration");
      break;
    case "connector-token":
      await commandConnectorToken(args);
      break;
    case "session":
      if (subcommand !== "release") throw new Error("只支持 session release");
      await commandReleaseSession(args);
      break;
    case "version":
    case "--version":
      process.stdout.write(`${DAEMON_VERSION}\n`);
      break;
    case "help":
    case "--help":
    case undefined:
      printHelp();
      break;
    default:
      throw new Error(`未知命令：${command}`);
  }
}

await main().catch((error) => {
  new Logger("cli").error("命令失败", { error: errorMessage(error) });
  process.exitCode = 1;
});
