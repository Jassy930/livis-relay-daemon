import { describe, expect, test } from "bun:test";
import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { IdentityStore } from "../src/identity.ts";
import { SecretStore } from "../src/secrets.ts";
import { JobStore } from "../src/state/store.ts";
import { atomicWritePrivate, sha256 } from "../src/util.ts";
import { incomingJob, temporaryDirectory, testConfig, testProfile } from "./helpers.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "..");

describe("Codex doctor 启动前安全门禁", () => {
  test("native-current 以 initialize 握手裁决兼容性，不受固定版本窗阻断", async () => {
    const state = await temporaryDirectory("livis-codex-native-doctor-state-");
    const external = await temporaryDirectory("livis-codex-native-doctor-command-");
    const nativeHome = await temporaryDirectory("livis-codex-native-doctor-home-");
    try {
      await chmod(state.path, 0o700);
      const profile = await testProfile();
      const profileText = `${JSON.stringify(profile, null, 2)}\n`;
      const profilePath = join(state.path, "protocol-profiles", "active.json");
      await atomicWritePrivate(profilePath, profileText);
      await new SecretStore(state.path).initialize();
      await new IdentityStore(state.path, profile).initialize();
      const canonicalNativeHome = await realpath(nativeHome.path);
      const codexHome = join(canonicalNativeHome, ".codex");
      await mkdir(codexHome, { mode: 0o700 });
      const command = join(external.path, "codex");
      await writeFile(command, [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then",
        "  printf 'codex-cli 99.0.0\\n'",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"app-server\" ] && [ \"$2\" = \"--stdio\" ]; then",
        "  IFS= read -r request || exit 1",
        `  printf '%s\\n' '${JSON.stringify({
          id: 1,
          result: {
            codexHome,
            userAgent: "livis-relay-native-stdio-probe/0.1.0 (fake)",
            platformFamily: "unix",
            platformOs: "macos",
          },
        })}'`,
        "  IFS= read -r initialized || exit 0",
        "  while IFS= read -r message; do :; done",
        "  exit 0",
        "fi",
        "exit 2",
        "",
      ].join("\n"), { mode: 0o700 });

      const base = testConfig(state.path);
      const configPath = join(state.path, "config.json");
      await atomicWritePrivate(configPath, `${JSON.stringify({
        ...base,
        profile: profilePath,
        profileSha256: sha256(profileText),
        execution: { backend: "codex" },
        codex: {
          mode: "native-current",
          command,
          requestTimeoutMs: 1_000,
          turnTimeoutMs: 2_000,
          shutdownTimeoutMs: 1_000,
          acknowledgeRemoteExecution: true,
        },
      }, null, 2)}\n`);

      const child = Bun.spawn([
        process.execPath,
        "run",
        "src/index.ts",
        "doctor",
        "--config",
        configPath,
      ], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          HOME: canonicalNativeHome,
          CODEX_HOME: codexHome,
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
      expect(exitCode).toBe(1);
      expect(stderr).toBe("");
      const report = JSON.parse(stdout) as {
        checks: Array<{ name: string; ok: boolean; detail: string }>;
      };
      const native = report.checks.find((check) => check.name === "codex_native_app_server");
      expect(native).toMatchObject({ ok: true });
      expect(JSON.parse(native!.detail)).toMatchObject({
        compatibilityBasis: "protocol-handshake",
        versionRelation: "different",
        cliVersion: "99.0.0",
        appServerVersion: "0.1.0",
        touchedDesktopDaemon: false,
        sentModelTurn: false,
      });
      expect(report.checks.some((check) => check.name === "codex_version")).toBeFalse();
    } finally {
      await Promise.all([state.cleanup(), external.cleanup(), nativeHome.cleanup()]);
    }
  });

  test("stateDir 内的 Codex command 在执行前被拒绝", async () => {
    const state = await temporaryDirectory("livis-codex-doctor-state-");
    const external = await temporaryDirectory("livis-codex-doctor-external-");
    try {
      await chmod(state.path, 0o700);
      const profile = await testProfile();
      const profileText = `${JSON.stringify(profile, null, 2)}\n`;
      const profilePath = join(state.path, "protocol-profiles", "active.json");
      await atomicWritePrivate(profilePath, profileText);
      await new SecretStore(state.path).initialize();
      await new IdentityStore(state.path, profile).initialize();

      const sentinel = join(external.path, "executed");
      const command = join(state.path, "malicious-codex");
      await writeFile(command, [
        "#!/bin/sh",
        `printf executed > ${JSON.stringify(sentinel)}`,
        "printf 'codex-cli 0.145.0\\n'",
        "",
      ].join("\n"), { mode: 0o700 });

      const configPath = join(state.path, "config.json");
      const base = testConfig(state.path);
      await atomicWritePrivate(configPath, `${JSON.stringify({
        ...base,
        profile: profilePath,
        profileSha256: sha256(profileText),
        execution: { backend: "codex" },
        codex: {
          ...base.codex,
          command,
          acknowledgeRemoteExecution: true,
        },
      }, null, 2)}\n`);

      const child = Bun.spawn([
        process.execPath,
        "run",
        "src/index.ts",
        "doctor",
        "--config",
        configPath,
      ], {
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
      const report = JSON.parse(stdout) as {
        ok: boolean;
        checks: Array<{ name: string; ok: boolean; detail: string }>;
      };
      expect(exitCode).toBe(1);
      expect(stderr).toBe("");
      expect(report.ok).toBeFalse();
      expect(report.checks.find((check) => check.name === "codex_version")).toMatchObject({
        ok: false,
      });
      expect(report.checks.find((check) => check.name === "codex_version")?.detail)
        .toContain("不能位于 daemon stateDir 内");
      expect(await Bun.file(sentinel).exists()).toBeFalse();
    } finally {
      await Promise.all([state.cleanup(), external.cleanup()]);
    }
  });

  test("Claude doctor 只做 version/help 能力探针且不发送模型 turn", async () => {
    const state = await temporaryDirectory("livis-claude-doctor-state-");
    const external = await temporaryDirectory("livis-claude-doctor-external-");
    try {
      await chmod(state.path, 0o700);
      const profile = await testProfile();
      const profileText = `${JSON.stringify(profile, null, 2)}\n`;
      const profilePath = join(state.path, "protocol-profiles", "active.json");
      await atomicWritePrivate(profilePath, profileText);
      await new SecretStore(state.path).initialize();
      await new IdentityStore(state.path, profile).initialize();
      const command = join(external.path, "claude");
      const sentinel = join(external.path, "model-turn-sent");
      await writeFile(command, [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then",
        "  printf '%s\\n' '99.0.0 (Claude Code)'",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"--help\" ]; then",
        "  printf '%s\\n' '--print --input-format --output-format --verbose --safe-mode --no-chrome --disable-slash-commands --strict-mcp-config --mcp-config --tools --permission-mode --no-session-persistence --prompt-suggestions --max-budget-usd --system-prompt'",
        "  exit 0",
        "fi",
        `printf sent > ${JSON.stringify(sentinel)}`,
        "exit 2",
        "",
      ].join("\n"), { mode: 0o700 });
      const configPath = join(state.path, "config.json");
      await atomicWritePrivate(configPath, `${JSON.stringify({
        ...testConfig(state.path),
        profile: profilePath,
        profileSha256: sha256(profileText),
        execution: { backend: "claude" },
        claude: {
          mode: "native-current",
          command,
          requestTimeoutMs: 1_000,
          turnTimeoutMs: 2_000,
          shutdownTimeoutMs: 1_000,
          maxBudgetUsd: 0.05,
          acknowledgeRemoteExecution: true,
        },
      }, null, 2)}\n`);

      const run = async () => {
        const child = Bun.spawn([
          process.execPath,
          "run",
          "src/index.ts",
          "doctor",
          "--config",
          configPath,
        ], {
          cwd: PROJECT_ROOT,
          env: {
            ...process.env,
            HOME: external.path,
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
        return { stdout, stderr, exitCode };
      };

      const doctor = await run();
      expect(doctor.exitCode).toBe(1);
      expect(doctor.stderr).toBe("");
      const report = JSON.parse(doctor.stdout) as {
        ok: boolean;
        checks: Array<{ name: string; ok: boolean; detail: string }>;
      };
      expect(report.checks.find((check) => check.name === "execution_backend"))
        .toMatchObject({ ok: true, detail: "claude" });
      const native = report.checks.find((check) => check.name === "claude_native_cli");
      expect(native).toMatchObject({ ok: true });
      expect(JSON.parse(native!.detail)).toMatchObject({
        compatibilityBasis: "capability-probe",
        cliVersion: "99.0.0 (Claude Code)",
        versionsAreObservational: true,
        sentModelTurn: false,
        credentialStateInspected: false,
      });
      expect(await Bun.file(sentinel).exists()).toBeFalse();
    } finally {
      await Promise.all([state.cleanup(), external.cleanup()]);
    }
  });

  test("doctor 对异 backend 非终态 backlog 失败且报告可观测明细", async () => {
    const state = await temporaryDirectory("livis-codex-doctor-inactive-backlog-state-");
    const external = await temporaryDirectory("livis-codex-doctor-inactive-backlog-command-");
    try {
      await chmod(state.path, 0o700);
      const profile = await testProfile();
      const profileText = `${JSON.stringify(profile, null, 2)}\n`;
      const profilePath = join(state.path, "protocol-profiles", "active.json");
      await atomicWritePrivate(profilePath, profileText);
      await new SecretStore(state.path).initialize();
      const identity = await new IdentityStore(state.path, profile).initialize();

      const command = join(external.path, "codex");
      await writeFile(command, "#!/bin/sh\nprintf 'codex-cli 0.145.0\\n'\n", { mode: 0o700 });
      const configPath = join(state.path, "config.json");
      const base = testConfig(state.path);
      await atomicWritePrivate(configPath, `${JSON.stringify({
        ...base,
        profile: profilePath,
        profileSha256: sha256(profileText),
        execution: { backend: "codex" },
        codex: {
          ...base.codex,
          command,
          acknowledgeRemoteExecution: true,
        },
      }, null, 2)}\n`);

      const store = new JobStore(
        join(state.path, "relay.db"),
        IdentityStore.scopeKey(identity),
      );
      try {
        store.ingest(incomingJob("legacy-hermes-backlog"), "legacy-session", "hermes");
        store.markAcked("legacy-hermes-backlog");
      } finally {
        store.close();
      }

      const child = Bun.spawn([
        process.execPath,
        "run",
        "src/index.ts",
        "doctor",
        "--config",
        configPath,
      ], {
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
      const report = JSON.parse(stdout) as {
        ok: boolean;
        checks: Array<{ name: string; ok: boolean; detail: string }>;
      };
      expect(exitCode).toBe(1);
      expect(stderr).toBe("");
      expect(report.ok).toBeFalse();
      const backlogCheck = report.checks.find((check) =>
        check.name === "execution_backend_backlog"
      );
      expect(backlogCheck).toMatchObject({ ok: false });
      expect(JSON.parse(backlogCheck!.detail)).toEqual([{
        backend: "hermes",
        count: 1,
        oldestCreatedAt: expect.any(Number),
      }]);
    } finally {
      await Promise.all([state.cleanup(), external.cleanup()]);
    }
  });
});
