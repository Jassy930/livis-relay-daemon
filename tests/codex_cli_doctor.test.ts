import { describe, expect, test } from "bun:test";
import { chmod, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { IdentityStore } from "../src/identity.ts";
import { SecretStore } from "../src/secrets.ts";
import { JobStore } from "../src/state/store.ts";
import { atomicWritePrivate, sha256 } from "../src/util.ts";
import { incomingJob, temporaryDirectory, testConfig, testProfile } from "./helpers.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "..");

describe("Codex doctor 启动前安全门禁", () => {
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
        .toContain("Codex command realpath 不能位于 daemon stateDir 内");
      expect(await Bun.file(sentinel).exists()).toBeFalse();
    } finally {
      await Promise.all([state.cleanup(), external.cleanup()]);
    }
  });

  test("Claude 可配置但 doctor 与 serve 都清晰失败关闭", async () => {
    const state = await temporaryDirectory("livis-claude-unimplemented-state-");
    try {
      await chmod(state.path, 0o700);
      const profile = await testProfile();
      const profileText = `${JSON.stringify(profile, null, 2)}\n`;
      const profilePath = join(state.path, "protocol-profiles", "active.json");
      await atomicWritePrivate(profilePath, profileText);
      await new SecretStore(state.path).initialize();
      await new IdentityStore(state.path, profile).initialize();
      const configPath = join(state.path, "config.json");
      await atomicWritePrivate(configPath, `${JSON.stringify({
        ...testConfig(state.path),
        profile: profilePath,
        profileSha256: sha256(profileText),
        execution: { backend: "claude" },
      }, null, 2)}\n`);

      const run = async (command: "doctor" | "serve") => {
        const child = Bun.spawn([
          process.execPath,
          "run",
          "src/index.ts",
          command,
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
        return { stdout, stderr, exitCode };
      };

      const doctor = await run("doctor");
      expect(doctor.exitCode).toBe(1);
      expect(doctor.stderr).toBe("");
      const report = JSON.parse(doctor.stdout) as {
        ok: boolean;
        checks: Array<{ name: string; ok: boolean; detail: string }>;
      };
      expect(report.ok).toBeFalse();
      expect(report.checks.find((check) => check.name === "execution_backend"))
        .toMatchObject({ ok: false });
      expect(report.checks.find((check) => check.name === "execution_backend")?.detail)
        .toContain("尚未实现");

      const serve = await run("serve");
      expect(serve.exitCode).toBe(1);
      expect(serve.stdout).toBe("");
      expect(serve.stderr).toContain("Claude backend 尚未实现");
      expect(serve.stderr).toContain("不会退回 Hermes 或 Codex");
    } finally {
      await state.cleanup();
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
