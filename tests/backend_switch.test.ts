import { describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { switchBackend } from "../src/backend/switch.ts";
import { loadRelayConfig } from "../src/config.ts";
import { JobStore } from "../src/state/store.ts";
import { atomicWritePrivate, sha256 } from "../src/util.ts";
import { incomingJob, temporaryDirectory, testConfig } from "./helpers.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const CODEX_COMMAND = "/opt/homebrew/bin/codex";

async function fixture(prefix: string): Promise<{
  state: Awaited<ReturnType<typeof temporaryDirectory>>;
  configPath: string;
  initialText: string;
}> {
  const state = await temporaryDirectory(prefix);
  await chmod(state.path, 0o700);
  const configPath = join(state.path, "config.json");
  const initialText = `${JSON.stringify(testConfig(state.path), null, 2)}\n`;
  await atomicWritePrivate(configPath, initialText);
  new JobStore(join(state.path, "relay.db"), "scope-backend-switch").close();
  return { state, configPath, initialText };
}

async function runCli(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      LIVIS_RELAY_CONFIG: undefined,
      LIVIS_RELAY_STATE_DIR: undefined,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("backend switch 原子切换", () => {
  test("切换到 Codex 时拒绝相对 command 且不写配置", async () => {
    const current = await fixture("livis-backend-switch-relative-command-");
    try {
      const result = await runCli([
        "backend",
        "switch",
        "codex",
        "--mode",
        "native-current",
        "--command",
        "codex",
        "--config",
        current.configPath,
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--command 绝对路径");
      expect(await Bun.file(current.configPath).text()).toBe(current.initialText);
    } finally {
      await current.state.cleanup();
    }
  });

  test("CLI dry-run 不写配置，apply 生成备份、PREPARED 与提交 marker", async () => {
    const current = await fixture("livis-backend-switch-apply-");
    try {
      const dryRun = await runCli([
        "backend",
        "switch",
        "codex",
        "--mode",
        "native-current",
        "--command",
        CODEX_COMMAND,
        "--config",
        current.configPath,
      ]);
      expect(dryRun.exitCode).toBe(0);
      expect(dryRun.stderr).toBe("");
      expect(JSON.parse(dryRun.stdout)).toMatchObject({
        ok: true,
        applied: false,
        changed: true,
        previousBackend: "hermes",
        targetBackend: "codex",
        codexMode: "native-current",
        database: { schemaVersion: 8, backlog: [] },
      });
      expect(await Bun.file(current.configPath).text()).toBe(current.initialText);

      const applied = await runCli([
        "backend",
        "switch",
        "codex",
        "--mode",
        "native-current",
        "--command",
        CODEX_COMMAND,
        "--apply",
        "--acknowledge-daemon-stopped",
        "--acknowledge-remote-execution",
        "--config",
        current.configPath,
      ]);
      expect(applied.exitCode).toBe(0);
      expect(applied.stderr).toBe("");
      const result = JSON.parse(applied.stdout) as {
        backupConfigPath: string;
        receiptPath: string;
        commitMarkerPath: string | null;
        configSha256: string;
      };
      expect(await Bun.file(result.backupConfigPath).text()).toBe(current.initialText);
      expect(await Bun.file(result.receiptPath).json()).toMatchObject({
        status: "prepared",
        previousBackend: "hermes",
        targetBackend: "codex",
        credentialsReadOrMigrated: false,
      });
      expect(result.commitMarkerPath).not.toBeNull();
      expect(await Bun.file(result.commitMarkerPath!).json()).toMatchObject({
        kind: "livis-relay-backend-switch-commit",
        configSha256: result.configSha256,
      });
      const loaded = await loadRelayConfig(current.configPath);
      expect(loaded.config.execution.backend).toBe("codex");
      expect(loaded.config.codex).toMatchObject({
        mode: "native-current",
        command: CODEX_COMMAND,
        acknowledgeRemoteExecution: true,
      });
      expect(loaded.text).not.toContain("provider");
      expect(loaded.text).not.toContain("toolchainReadRoots");
      expect(await Bun.file(join(current.state.path, "connector.sock")).exists()).toBeFalse();
      expect(await Bun.file(join(current.state.path, "profile-operation.guard")).exists())
        .toBeFalse();
    } finally {
      await current.state.cleanup();
    }
  });

  test("非终态 backlog、account-bound session 与 quarantine 均拒绝 apply", async () => {
    for (const blockedBy of ["backlog", "account-bound", "quarantine"] as const) {
      const current = await fixture(`livis-backend-switch-${blockedBy}-`);
      try {
        const store = new JobStore(
          join(current.state.path, "relay.db"),
          `scope-${blockedBy}`,
        );
        if (blockedBy === "backlog") {
          store.ingest(incomingJob("pending-job"), "session-hermes", "hermes");
          store.markAcked("pending-job");
        } else if (blockedBy === "account-bound") {
          store.ensureBackendSession({
            backend: "codex",
            sessionKey: "session-private",
            sessionHash: "a".repeat(64),
            cwd: join(current.state.path, "private-workspace"),
            cliVersion: "0.145.0",
            accountType: "apiKey",
            accountSubjectSha256: null,
            accountIdentityStrength: "type-only",
            requestedModel: null,
            effectiveModel: "gpt-test",
            modelProvider: "openai",
            securityConfigSha256: "b".repeat(64),
            featureSnapshotSha256: "c".repeat(64),
            checkpointTurnId: null,
            checkpointTurnStatus: null,
            checkpointTurnCount: 0,
            checkpointTurnsSha256: sha256("[]"),
            checkpointedAt: 1,
          });
        } else {
          store.quarantineSession("session-quarantined", "保留测试证据");
        }
        store.close();

        await expect(switchBackend({
          configPath: current.configPath,
          targetBackend: "codex",
          codexMode: "native-current",
          codexCommand: CODEX_COMMAND,
          apply: true,
          acknowledgeDaemonStopped: true,
          acknowledgeRemoteExecution: true,
        })).rejects.toThrow(
          blockedBy === "backlog"
            ? "存在非终态 backend backlog"
            : blockedBy === "account-bound"
              ? "account-bound Codex session"
              : "quarantined session",
        );
        if (blockedBy === "quarantine") {
          await expect(switchBackend({
            configPath: current.configPath,
            targetBackend: "hermes",
            apply: true,
            acknowledgeDaemonStopped: true,
            acknowledgeRemoteExecution: false,
          })).rejects.toThrow("quarantined session");
        }
        expect(await Bun.file(current.configPath).text()).toBe(current.initialText);
        expect(await Bun.file(join(current.state.path, "connector.sock")).exists()).toBeFalse();
        expect(await Bun.file(join(current.state.path, "profile-operation.guard")).exists())
          .toBeFalse();
      } finally {
        await current.state.cleanup();
      }
    }
  });

  test("connector socket 路径被占用时失败关闭且不覆盖文件", async () => {
    const current = await fixture("livis-backend-switch-offline-guard-");
    const socketPath = join(current.state.path, "connector.sock");
    try {
      await atomicWritePrivate(socketPath, "daemon-or-guard-present\n");
      await expect(switchBackend({
        configPath: current.configPath,
        targetBackend: "codex",
        codexMode: "native-current",
        codexCommand: CODEX_COMMAND,
        apply: true,
        acknowledgeDaemonStopped: true,
        acknowledgeRemoteExecution: true,
      })).rejects.toThrow("connector socket 路径已存在");
      expect(await Bun.file(socketPath).text()).toBe("daemon-or-guard-present\n");
      expect(await Bun.file(current.configPath).text()).toBe(current.initialText);
      expect(await Bun.file(join(current.state.path, "profile-operation.guard")).exists())
        .toBeFalse();
    } finally {
      await current.state.cleanup();
    }
  });
});
