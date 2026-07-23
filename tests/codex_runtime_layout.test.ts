import { describe, expect, test } from "bun:test";
import {
  chmod,
  link,
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import {
  assertPinnedCodexCommand,
  assertCodexRuntimeLayout,
  buildCodexEnvironment,
  codexRemoteConfig,
  codexSecurityBindingSha256,
  codexSessionHash,
  ensureCodexRuntimeLayout,
  pinCodexCommand,
  resolveCodexCommand,
} from "../src/backends/codex/runtime-layout.ts";
import type { CodexProviderConfig } from "../src/types.ts";
import { sha256 } from "../src/util.ts";
import { temporaryDirectory } from "./helpers.ts";

const OPENAI_PROVIDER = { type: "openai" } as const satisfies CodexProviderConfig;
const CUSTOM_PROVIDER = {
  type: "custom",
  baseUrl: "https://provider.example.invalid/v1",
  acknowledgeApiKeyTransmission: true,
} as const satisfies CodexProviderConfig;
const CUSTOM_PROVIDER_ID = "livis-custom-responses";

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
        provider: OPENAI_PROVIDER,
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
      expect(layout.expectedModelProvider).toBe("openai");
      const expectedConfig = codexRemoteConfig(layout.workspace, OPENAI_PROVIDER);
      expect(await Bun.file(layout.configPath).text()).toBe(expectedConfig);
      expect(expectedConfig).toContain(`projects.${JSON.stringify(layout.workspace)}`);
      expect(expectedConfig).toContain('trust_level = "untrusted"');
      expect(expectedConfig).toContain('cli_auth_credentials_store = "file"');
      expect(expectedConfig).toContain('forced_login_method = "api"');
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
        provider: OPENAI_PROVIDER,
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

  test("custom provider 固定为 Responses、API key auth、零重试且禁用 WebSocket", async () => {
    const directory = await temporaryDirectory("livis-codex-custom-provider-layout-");
    try {
      await chmod(directory.path, 0o700);
      const layout = await ensureCodexRuntimeLayout({
        stateDir: directory.path,
        scopeKey: "scope-custom",
        sessionKey: "livis:custom-agent",
        remoteNodeId: "node-custom",
        provider: CUSTOM_PROVIDER,
      });
      const expectedConfig = codexRemoteConfig(layout.workspace, CUSTOM_PROVIDER);
      expect(layout.expectedModelProvider).toBe(CUSTOM_PROVIDER_ID);
      expect(await Bun.file(layout.configPath).text()).toBe(expectedConfig);
      expect(expectedConfig).toContain(`model_provider = "${CUSTOM_PROVIDER_ID}"`);
      expect(expectedConfig).toContain('forced_login_method = "api"');
      expect(expectedConfig).toContain(`[model_providers.${CUSTOM_PROVIDER_ID}]`);
      expect(expectedConfig).toContain(`base_url = ${JSON.stringify(CUSTOM_PROVIDER.baseUrl)}`);
      expect(expectedConfig).toContain('wire_api = "responses"');
      expect(expectedConfig).toContain("requires_openai_auth = true");
      expect(expectedConfig).toContain("request_max_retries = 0");
      expect(expectedConfig).toContain("stream_max_retries = 0");
      expect(expectedConfig).toContain("supports_websockets = false");
      expect(expectedConfig).not.toContain("experimental_bearer_token");
      expect(expectedConfig).not.toContain("env_key");
      await assertCodexRuntimeLayout(layout);

      await expect(ensureCodexRuntimeLayout({
        stateDir: directory.path,
        scopeKey: "scope-custom",
        sessionKey: "livis:custom-agent",
        remoteNodeId: "node-custom",
        provider: OPENAI_PROVIDER,
      })).rejects.toThrow("安全 config 已漂移");
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
        provider: OPENAI_PROVIDER,
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

  test("显式工具链目录只读加入 permission profile 与 PATH，且拒绝 stateDir 祖先", async () => {
    const directory = await temporaryDirectory("livis-codex-toolchain-state-");
    const toolchain = await temporaryDirectory("livis-codex-toolchain-bin-");
    try {
      await chmod(directory.path, 0o700);
      const layout = await ensureCodexRuntimeLayout({
        stateDir: directory.path,
        scopeKey: "scope",
        sessionKey: "session",
        remoteNodeId: "node-a",
        provider: OPENAI_PROVIDER,
        toolchainReadRoots: [toolchain.path, toolchain.path],
      });
      const canonicalToolchain = await realpath(toolchain.path);
      expect(layout.toolchainReadRoots).toEqual([canonicalToolchain]);
      const toolchainInfo = await lstat(canonicalToolchain);
      expect(layout.toolchainIdentities[canonicalToolchain]).toEqual({
        dev: toolchainInfo.dev,
        ino: toolchainInfo.ino,
      });
      expect(await Bun.file(layout.configPath).text()).toContain(
        `${JSON.stringify(canonicalToolchain)} = "read"`,
      );
      const env = await buildCodexEnvironment(layout, { PATH: "/usr/bin" });
      expect(env.PATH?.split(":")[0]).toBe(canonicalToolchain);
      await assertCodexRuntimeLayout(layout);

      const movedToolchain = `${toolchain.path}-moved`;
      await rename(toolchain.path, movedToolchain);
      await mkdir(toolchain.path, { mode: 0o700 });
      await expect(assertCodexRuntimeLayout(layout)).rejects.toThrow("工具链只读根身份已漂移");
      await rm(toolchain.path, { recursive: true });
      await rename(movedToolchain, toolchain.path);

      const fresh = await temporaryDirectory("livis-codex-toolchain-ancestor-state-");
      try {
        await chmod(fresh.path, 0o700);
        await expect(ensureCodexRuntimeLayout({
          stateDir: fresh.path,
          scopeKey: "scope",
          sessionKey: "session",
          remoteNodeId: "node-a",
          provider: OPENAI_PROVIDER,
          toolchainReadRoots: [fresh.path],
        })).rejects.toThrow("stateDir");
      } finally {
        await fresh.cleanup();
      }
    } finally {
      await Promise.all([directory.cleanup(), toolchain.cleanup()]);
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
        provider: OPENAI_PROVIDER,
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

  test("Codex command 绑定单 link、完整内容摘要与持久安全摘要", async () => {
    const state = await temporaryDirectory("livis-codex-command-pin-state-");
    const binaries = await temporaryDirectory("livis-codex-command-pin-bin-");
    try {
      await chmod(state.path, 0o700);
      const layout = await ensureCodexRuntimeLayout({
        stateDir: state.path,
        scopeKey: "scope",
        sessionKey: "session",
        remoteNodeId: "node-a",
        provider: OPENAI_PROVIDER,
      });
      const bytes = "#!/bin/sh\nprintf 'codex-cli 0.145.0\\n'\n";
      const executable = join(binaries.path, "codex-real");
      const commandLink = join(binaries.path, "codex");
      await writeFile(executable, bytes, { mode: 0o700 });
      await symlink(executable, commandLink);

      const pin = await pinCodexCommand(layout, commandLink);
      expect(pin.path).toBe(await realpath(executable));
      expect(pin.nlink).toBe(1);
      expect(pin.contentSha256).toBe(sha256(bytes));
      expect(pin.identitySha256).toMatch(/^[0-9a-f]{64}$/);
      expect(codexSecurityBindingSha256(layout, pin)).toMatch(/^[0-9a-f]{64}$/);
      expect(codexSecurityBindingSha256(layout, pin))
        .not.toBe(sha256(codexRemoteConfig(layout.workspace, OPENAI_PROVIDER)));
      await assertPinnedCodexCommand(pin);

      const hardlink = join(binaries.path, "codex-hardlink");
      await link(executable, hardlink);
      await expect(pinCodexCommand(layout, commandLink)).rejects.toThrow("单 link");
      await unlink(hardlink);
      await expect(assertPinnedCodexCommand(pin)).rejects.toThrow("漂移");
    } finally {
      await Promise.all([state.cleanup(), binaries.cleanup()]);
    }
  });

  test("Codex command 拒绝原地内容修改、目录项换 inode 与宽松写权限", async () => {
    const state = await temporaryDirectory("livis-codex-command-drift-state-");
    const binaries = await temporaryDirectory("livis-codex-command-drift-bin-");
    try {
      await chmod(state.path, 0o700);
      const layout = await ensureCodexRuntimeLayout({
        stateDir: state.path,
        scopeKey: "scope",
        sessionKey: "session",
        remoteNodeId: "node-a",
        provider: OPENAI_PROVIDER,
      });
      const executable = join(binaries.path, "codex-real");
      await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const pin = await pinCodexCommand(layout, executable);

      await writeFile(executable, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      await expect(assertPinnedCodexCommand(pin)).rejects.toThrow("漂移");

      const repinned = await pinCodexCommand(layout, executable);
      const replacement = join(binaries.path, "replacement");
      await writeFile(replacement, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      await rename(replacement, executable);
      await expect(assertPinnedCodexCommand(repinned)).rejects.toThrow("漂移");

      await chmod(executable, 0o722);
      await expect(pinCodexCommand(layout, executable)).rejects.toThrow("group/other");
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
        provider: OPENAI_PROVIDER,
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
        provider: OPENAI_PROVIDER,
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
        provider: OPENAI_PROVIDER,
      });
      await rm(layout.hostTmpDir, { recursive: true });
      await symlink(layout.workspace, layout.hostTmpDir);
      await expect(ensureCodexRuntimeLayout({
        stateDir: directory.path,
        scopeKey: "scope",
        sessionKey: "session",
        remoteNodeId: "node-a",
        provider: OPENAI_PROVIDER,
      })).rejects.toThrow("类型或权限不安全");

      const stateLink = join(external.path, "state-link");
      await symlink(directory.path, stateLink);
      await expect(ensureCodexRuntimeLayout({
        stateDir: stateLink,
        scopeKey: "scope",
        sessionKey: "session",
        remoteNodeId: "node-a",
        provider: OPENAI_PROVIDER,
      })).rejects.toThrow("stateDir 必须是 0700 普通目录且不能是 symlink");
    } finally {
      await Promise.all([directory.cleanup(), external.cleanup()]);
    }
  });
});
