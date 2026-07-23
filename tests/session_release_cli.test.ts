import { describe, expect, test } from "bun:test";
import { chmod, mkdir, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { IdentityStore } from "../src/identity.ts";
import { SecretStore } from "../src/secrets.ts";
import { DaemonOfflineGuard } from "../src/state/offline-guard.ts";
import { JobStore } from "../src/state/store.ts";
import { atomicWritePrivate, sha256 } from "../src/util.ts";
import { temporaryDirectory, testConfig, testProfile } from "./helpers.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const SESSION_METADATA = {
  accountType: "apiKey",
  accountSubjectSha256: null,
  accountIdentityStrength: "type-only" as const,
  requestedModel: null,
  effectiveModel: "gpt-5.6-sol",
  modelProvider: "openai",
  securityConfigSha256: "c".repeat(64),
  featureSnapshotSha256: "d".repeat(64),
  checkpointTurnId: null,
  checkpointTurnStatus: null,
  checkpointTurnCount: 0,
  checkpointTurnsSha256: "e".repeat(64),
  checkpointedAt: 100,
};

async function releaseDeployment(sessionKey: string) {
  const directory = await temporaryDirectory("livis-session-release-cli-");
  await chmod(directory.path, 0o700);
  const realParent = join(directory.path, "real-parent");
  const realStateDir = join(realParent, "state");
  const aliasParent = join(directory.path, "alias-parent");
  await mkdir(realStateDir, { recursive: true, mode: 0o700 });
  await chmod(realParent, 0o700);
  await chmod(realStateDir, 0o700);
  await symlink("real-parent", aliasParent);
  const configuredStateDir = join(aliasParent, "state");
  const profile = await testProfile();
  const profileText = `${JSON.stringify(profile, null, 2)}\n`;
  const profilePath = join(configuredStateDir, "protocol-profiles", "active.json");
  await atomicWritePrivate(profilePath, profileText);
  await new SecretStore(configuredStateDir).initialize();
  const identity = await new IdentityStore(configuredStateDir, profile).initialize();
  const configPath = join(directory.path, "config.json");
  const config = {
    ...testConfig(configuredStateDir),
    profile: profilePath,
    profileSha256: sha256(profileText),
  };
  await atomicWritePrivate(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const store = new JobStore(
    join(configuredStateDir, "relay.db"),
    IdentityStore.scopeKey(identity),
  );
  store.ensureBackendSession({
    ...SESSION_METADATA,
    backend: "codex",
    sessionKey,
    sessionHash: "a".repeat(64),
    cwd: join(configuredStateDir, "sessions", "codex", "workspace"),
    cliVersion: "0.145.0",
  });
  store.bindBackendThread("codex", sessionKey, "thread-release-cli");
  store.quarantineSession(sessionKey, "command security binding drift");
  store.close();
  return {
    config,
    configPath,
    databasePath: join(configuredStateDir, "relay.db"),
    directory,
    scopeKey: IdentityStore.scopeKey(identity),
  };
}

async function runReleaseCli(args: string[], timeoutMs = 5_000) {
  const environment: Record<string, string | undefined> = {
    ...process.env,
    LIVIS_RELAY_CONFIG: undefined,
    LIVIS_RELAY_STATE_DIR: undefined,
  };
  const child = Bun.spawn([
    process.execPath,
    "run",
    "src/index.ts",
    "session",
    "release",
    ...args,
  ], {
    cwd: PROJECT_ROOT,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const completed = Promise.all([
    child.exited,
    stdout,
    stderr,
  ]);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const [exitCode, stdoutText, stderrText] = await Promise.race([
      completed,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`session release CLI ${timeoutMs}ms 内未退出`)),
          timeoutMs,
        );
      }),
    ]);
    return { exitCode, stdout: stdoutText, stderr: stderrText };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.allSettled([child.exited, stdout, stderr]);
  }
}

describe("session release CLI", () => {
  test("canonicalize connector 祖先别名并原子输出实际 Codex 退役回执", async () => {
    const sessionKey = "livis:release-option-first";
    const deployment = await releaseDeployment(sessionKey);
    try {
      const result = await runReleaseCli([
        "--config",
        deployment.configPath,
        sessionKey,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        released: true,
        retiredBackendSessions: ["codex"],
        releasedQuarantineWithoutBackendSession: false,
        sessionKey,
        codexBackendSessionRetired: true,
      });
      expect(await Bun.file(deployment.config.connector.socketPath).exists()).toBeFalse();

      const store = new JobStore(deployment.databasePath, deployment.scopeKey);
      try {
        expect(store.getBackendSession("codex", sessionKey)).toBeNull();
        expect(store.getSessionQuarantine(sessionKey)).toBeNull();
      } finally {
        store.close();
      }
    } finally {
      await deployment.directory.cleanup();
    }
  });

  test("已持有 offline guard 时拒绝 CLI 且保持数据库与 guard 所有权", async () => {
    const sessionKey = "livis:release-guard-busy";
    const deployment = await releaseDeployment(sessionKey);
    const guard = await DaemonOfflineGuard.acquire(
      deployment.config.connector.socketPath,
      deployment.config.stateDir,
      "session-release",
    );
    try {
      const result = await runReleaseCli([
        sessionKey,
        "--config",
        deployment.configPath,
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("connector socket 路径已存在");
      await guard.assertHeld();

      const store = new JobStore(deployment.databasePath, deployment.scopeKey);
      try {
        expect(store.getBackendSession("codex", sessionKey)).not.toBeNull();
        expect(store.getSessionQuarantine(sessionKey)).not.toBeNull();
      } finally {
        store.close();
      }
    } finally {
      await guard.release();
      await deployment.directory.cleanup();
    }
  });

  test("无可释放证据时输出 released=false、exit 1 并清理本次 guard", async () => {
    const existingSessionKey = "livis:release-no-evidence-existing";
    const missingSessionKey = "livis:release-no-evidence-missing";
    const deployment = await releaseDeployment(existingSessionKey);
    try {
      const result = await runReleaseCli([
        missingSessionKey,
        "--config",
        deployment.configPath,
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        released: false,
        retiredBackendSessions: [],
        releasedQuarantineWithoutBackendSession: false,
        sessionKey: missingSessionKey,
        codexBackendSessionRetired: false,
      });
      expect(await Bun.file(deployment.config.connector.socketPath).exists()).toBeFalse();

      const store = new JobStore(deployment.databasePath, deployment.scopeKey);
      try {
        expect(store.getBackendSession("codex", existingSessionKey)).not.toBeNull();
        expect(store.getSessionQuarantine(existingSessionKey)).not.toBeNull();
      } finally {
        store.close();
      }
    } finally {
      await deployment.directory.cleanup();
    }
  });

  test("缺少或多余 session key 时在任何释放前拒绝", async () => {
    const sessionKey = "livis:release-argument-guard";
    const deployment = await releaseDeployment(sessionKey);
    try {
      const missing = await runReleaseCli(["--config", deployment.configPath]);
      expect(missing.exitCode).toBe(1);
      expect(missing.stdout).toBe("");
      expect(missing.stderr).toContain("用法：session release <sessionKey>");

      const extra = await runReleaseCli([
        sessionKey,
        "another-session",
        "--config",
        deployment.configPath,
      ]);
      expect(extra.exitCode).toBe(1);
      expect(extra.stdout).toBe("");
      expect(extra.stderr).toContain("用法：session release <sessionKey>");

      const store = new JobStore(deployment.databasePath, deployment.scopeKey);
      try {
        expect(store.getBackendSession("codex", sessionKey)).not.toBeNull();
        expect(store.getSessionQuarantine(sessionKey)).not.toBeNull();
      } finally {
        store.close();
      }
    } finally {
      await deployment.directory.cleanup();
    }
  });
});
