import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  assertCodexRuntimeLayout,
  buildCodexEnvironment,
  codexRemoteConfig,
  codexSessionHash,
  ensureCodexRuntimeLayout,
  resolveCodexCommand,
} from "../src/backends/codex/runtime-layout.ts";
import { temporaryDirectory } from "./helpers.ts";

describe("Codex daemon 托管目录", () => {
  test("使用 scope/backend/session 哈希创建固定 0700 workspace 和安全配置", async () => {
    const directory = await temporaryDirectory("livis-codex-layout-");
    try {
      await chmod(directory.path, 0o700);
      const layout = await ensureCodexRuntimeLayout({
        stateDir: directory.path,
        scopeKey: "scope-a",
        sessionKey: "livis:agent/../../secret",
        remoteNodeId: "node-a",
      });
      expect(layout.sessionHash).toMatch(/^[0-9a-f]{64}$/);
      expect(layout.sessionHash).toBe(
        codexSessionHash("scope-a", "livis:agent/../../secret", "node-a"),
      );
      expect(relative(layout.stateDir, layout.workspace).startsWith("..")).toBeFalse();
      expect(layout.workspace).not.toContain("agent");
      expect(layout.hostHome).toBe(join(layout.sessionRoot, "host-home"));
      expect(layout.hostTmpDir).toBe(join(layout.sessionRoot, "host-tmp"));
      expect(layout.agentHome).toBe(join(layout.workspace, ".agent-home"));
      expect(layout.agentTmpDir).toBe(join(layout.workspace, ".agent-tmp"));
      expect(relative(layout.workspace, layout.hostHome).startsWith("..")).toBeTrue();
      expect(relative(layout.workspace, layout.hostTmpDir).startsWith("..")).toBeTrue();
      expect(relative(layout.workspace, layout.agentHome).startsWith("..")).toBeFalse();
      expect(relative(layout.workspace, layout.agentTmpDir).startsWith("..")).toBeFalse();
      for (const path of [
        layout.sessionRoot,
        layout.workspace,
        layout.hostHome,
        layout.hostTmpDir,
        layout.agentHome,
        layout.agentTmpDir,
      ]) {
        const info = await lstat(path);
        expect(info.isDirectory()).toBeTrue();
        expect(info.isSymbolicLink()).toBeFalse();
        expect(info.mode & 0o777).toBe(0o700);
        expect(await realpath(path)).toBe(path);
        expect(layout.identities[path]).toEqual({ dev: info.dev, ino: info.ino });
      }
      const expectedConfig = codexRemoteConfig(layout.workspace);
      expect(await Bun.file(layout.configPath).text()).toBe(expectedConfig);
      expect(expectedConfig).toContain(`projects.${JSON.stringify(layout.workspace)}`);
      expect(expectedConfig).toContain('trust_level = "untrusted"');
      expect(expectedConfig).toContain('exclude = ["CODEX_HOME", "OPENAI_*", "LIVIS_*"]');
      expect(expectedConfig).toContain(
        `set = { HOME = ${JSON.stringify(layout.agentHome)}, TMPDIR = ${JSON.stringify(layout.agentTmpDir)} }`,
      );
      expect(expectedConfig).not.toContain(layout.hostHome);
      expect(expectedConfig).not.toContain(layout.hostTmpDir);
      expect(expectedConfig).toContain("[agents]\nenabled = false");
      expect(expectedConfig).toContain("[skills]\ninclude_instructions = false");
      expect(expectedConfig).toContain("[skills.bundled]\nenabled = false");
      expect(expectedConfig).toContain(`
":root" = "deny"
":minimal" = "read"
":workspace_roots" = "write"
`);
      await assertCodexRuntimeLayout(layout);
      const reopened = await ensureCodexRuntimeLayout({
        stateDir: directory.path,
        scopeKey: "scope-a",
        sessionKey: "livis:agent/../../secret",
        remoteNodeId: "node-a",
      });
      expect(reopened.workspace).toBe(layout.workspace);
      expect(codexSessionHash("scope-b", "livis:agent/../../secret", "node-a"))
        .not.toBe(layout.sessionHash);
      expect(codexSessionHash("scope-a", "livis:agent/../../secret", "node-b"))
        .not.toBe(layout.sessionHash);
    } finally {
      await directory.cleanup();
    }
  });

  test("只向 app-server 传最小环境，不继承 token 或 daemon 变量", async () => {
    const directory = await temporaryDirectory("livis-codex-env-");
    const external = await temporaryDirectory("livis-codex-env-external-");
    try {
      await chmod(directory.path, 0o700);
      const layout = await ensureCodexRuntimeLayout({
        stateDir: directory.path,
        scopeKey: "scope",
        sessionKey: "session",
        remoteNodeId: "node-a",
      });
      const safeBin = join(external.path, "safe-bin");
      const outsideLinkIntoState = join(external.path, "outside-link-into-state");
      await mkdir(safeBin, { mode: 0o700 });
      await symlink(layout.workspace, outsideLinkIntoState);
      const env = await buildCodexEnvironment(layout, {
        PATH: `${safeBin}::relative:${layout.workspace}:${outsideLinkIntoState}`,
        LANG: "zh_CN.UTF-8",
        HOME: "/Users/example",
        TMPDIR: "/private/inherited-tmp",
        OPENAI_API_KEY: "must-not-leak",
        CODEX_ACCESS_TOKEN: "must-not-leak",
        LIVIS_RELAY_CONFIG: "/secret/config.json",
      });
      expect(env).toEqual({
        PATH: await realpath(safeBin),
        LANG: "zh_CN.UTF-8",
        HOME: layout.hostHome,
        TMPDIR: layout.hostTmpDir,
        CODEX_HOME: layout.codexHome,
      });
      expect(env.HOME).not.toBe(layout.agentHome);
      expect(env.TMPDIR).not.toBe(layout.agentTmpDir);
    } finally {
      await Promise.all([directory.cleanup(), external.cleanup()]);
    }
  });

  test("Codex command 固定为 stateDir 外的 canonical 可执行文件", async () => {
    const state = await temporaryDirectory("livis-codex-command-state-");
    const binaries = await temporaryDirectory("livis-codex-command-bin-");
    try {
      await chmod(state.path, 0o700);
      const layout = await ensureCodexRuntimeLayout({
        stateDir: state.path,
        scopeKey: "scope",
        sessionKey: "session",
        remoteNodeId: "node-a",
      });
      const executable = join(binaries.path, "codex-real");
      const commandLink = join(binaries.path, "codex");
      await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      await symlink(executable, commandLink);
      expect(await resolveCodexCommand(layout, commandLink)).toBe(await realpath(executable));

      const workspaceCommand = join(layout.workspace, "codex");
      await writeFile(workspaceCommand, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      await expect(resolveCodexCommand(layout, workspaceCommand)).rejects.toThrow("stateDir");

      const outsideLinkToWorkspace = join(binaries.path, "workspace-codex");
      await symlink(workspaceCommand, outsideLinkToWorkspace);
      await expect(resolveCodexCommand(layout, outsideLinkToWorkspace)).rejects.toThrow("realpath");
    } finally {
      await Promise.all([state.cleanup(), binaries.cleanup()]);
    }
  });

  test("拒绝安全配置漂移", async () => {
    const directory = await temporaryDirectory("livis-codex-drift-");
    try {
      await chmod(directory.path, 0o700);
      const layout = await ensureCodexRuntimeLayout({
        stateDir: directory.path,
        scopeKey: "scope",
        sessionKey: "session",
        remoteNodeId: "node-a",
      });
      await writeFile(layout.configPath, "default_permissions = \":danger-full-access\"\n", { mode: 0o600 });
      await expect(assertCodexRuntimeLayout(layout)).rejects.toThrow("安全 config 已漂移");
    } finally {
      await directory.cleanup();
    }
  });

  test("运行中拒绝目录权限漂移与 inode 替换", async () => {
    const directory = await temporaryDirectory("livis-codex-identity-");
    try {
      await chmod(directory.path, 0o700);
      const layout = await ensureCodexRuntimeLayout({
        stateDir: directory.path,
        scopeKey: "scope",
        sessionKey: "session",
        remoteNodeId: "node-a",
      });
      await chmod(layout.hostHome, 0o755);
      await expect(assertCodexRuntimeLayout(layout)).rejects.toThrow("0700");

      await chmod(layout.hostHome, 0o700);
      await assertCodexRuntimeLayout(layout);
      await rm(layout.agentTmpDir, { recursive: true });
      await mkdir(layout.agentTmpDir, { mode: 0o700 });
      await expect(assertCodexRuntimeLayout(layout)).rejects.toThrow("固定 inode");
    } finally {
      await directory.cleanup();
    }
  });

  test("启动时拒绝 stateDir 与四类 HOME/TMPDIR 路径中的 symlink", async () => {
    const directory = await temporaryDirectory("livis-codex-symlink-");
    const external = await temporaryDirectory("livis-codex-symlink-external-");
    try {
      await chmod(directory.path, 0o700);
      const layout = await ensureCodexRuntimeLayout({
        stateDir: directory.path,
        scopeKey: "scope",
        sessionKey: "session",
        remoteNodeId: "node-a",
      });
      await rm(layout.hostTmpDir, { recursive: true });
      await symlink(layout.workspace, layout.hostTmpDir);
      await expect(ensureCodexRuntimeLayout({
        stateDir: directory.path,
        scopeKey: "scope",
        sessionKey: "session",
        remoteNodeId: "node-a",
      })).rejects.toThrow("类型或权限不安全");

      const stateLink = join(external.path, "state-link");
      await symlink(directory.path, stateLink);
      await expect(ensureCodexRuntimeLayout({
        stateDir: stateLink,
        scopeKey: "scope",
        sessionKey: "session",
        remoteNodeId: "node-a",
      })).rejects.toThrow("stateDir 必须是 0700 普通目录且不能是 symlink");
    } finally {
      await Promise.all([directory.cleanup(), external.cleanup()]);
    }
  });
});
