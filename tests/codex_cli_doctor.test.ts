import { describe, expect, test } from "bun:test";
import { chmod, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { IdentityStore } from "../src/identity.ts";
import { SecretStore } from "../src/secrets.ts";
import { atomicWritePrivate, sha256 } from "../src/util.ts";
import { temporaryDirectory, testConfig, testProfile } from "./helpers.ts";

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
});
