import { describe, expect, test } from "bun:test";
import { chmod, realpath, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CODEX_DISABLED_FEATURES,
  CodexAppServerStartCloseUnconfirmedError,
  type CodexAppServerClientOptions,
} from "../src/backends/codex/app-server-client.ts";
import {
  attachCodexNativeStdio,
  buildCodexNativeStdioCommand,
  buildCodexNativeStdioEnvironment,
  probeCodexNativeStdio,
  type CodexNativeStdioProbeOptions,
} from "../src/backends/codex/native-stdio.ts";
import { temporaryDirectory } from "./helpers.ts";
import { CODEX_NATIVE_PERMISSION_PROFILE } from "../src/backends/codex/runtime-layout.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "..");

const COMMAND_PIN = {
  path: "/opt/codex/bin/codex",
  dev: 1,
  ino: 2,
  mode: 0o100700,
  nlink: 1,
  uid: 501,
  gid: 20,
  size: 123,
  mtimeMs: 1,
  ctimeMs: 1,
  contentSha256: "a".repeat(64),
  identitySha256: "b".repeat(64),
} as const;

function probeOptions(
  overrides: Partial<CodexNativeStdioProbeOptions> = {},
): CodexNativeStdioProbeOptions {
  return {
    command: COMMAND_PIN,
    stateDir: "/private/livis-state",
    cwd: "/test/native-workspace",
    sourceEnv: {
      HOME: "/Users/test",
      CODEX_HOME: "/Users/test/.codex",
      LANG: "zh_CN.UTF-8",
      UNLISTED_SECRET: "must-not-reach-app-server",
    },
    requestTimeoutMs: 100,
    shutdownTimeoutMs: 100,
    clientVersion: "0.1.1",
    ...overrides,
  };
}

function initializeResult(
  clientName: "livis-relay-native-stdio-probe" | "livis-relay-native-stdio-attach",
  appServerVersion = "0.145.0",
): Record<string, unknown> {
  return {
    codexHome: "/Users/test/.codex",
    userAgent: `${clientName}/${appServerVersion} (fake) codex_cli_rs/${appServerVersion}`,
    platformFamily: "unix",
    platformOs: "macos",
  };
}

describe("Codex native stdio transport", () => {
  test("只传递本地 runtime 选择器与白名单环境，并使用直接 stdio 命令", async () => {
    const selection = await buildCodexNativeStdioEnvironment("/private/livis-state", {
      HOME: "/Users/test",
      CODEX_HOME: "/Users/test/.codex",
      PATH: "/usr/bin:relative:/private/livis-state/bin",
      TMPDIR: "/private/tmp/native-runtime",
      LANG: "zh_CN.UTF-8",
      UNLISTED_SECRET: "must-not-reach-app-server",
    });

    expect(selection).toEqual({
      codexHome: "/Users/test/.codex",
      environment: {
        HOME: "/Users/test",
        CODEX_HOME: "/Users/test/.codex",
        PATH: "/usr/bin",
        TMPDIR: "/private/tmp/native-runtime",
        LANG: "zh_CN.UTF-8",
      },
    });
    expect(buildCodexNativeStdioCommand(COMMAND_PIN.path)).toEqual([
      COMMAND_PIN.path,
      "app-server",
      "--stdio",
      "-c",
      `permissions.${CODEX_NATIVE_PERMISSION_PROFILE}={` +
        `description="LiViS native stdio workspace-only",` +
        `filesystem={":root"="deny",":minimal"="read",":workspace_roots"="write"},` +
        `network={enabled=false}}`,
      ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
    ]);
    expect(JSON.stringify(selection.environment)).not.toContain("UNLISTED_SECRET");
  });

  test("probe 只完成版本观测与 initialize，并确认关闭自有 app-server", async () => {
    const observedOptions: CodexAppServerClientOptions[] = [];
    const commands: readonly string[][] = [];
    let closed = false;
    const report = await probeCodexNativeStdio(probeOptions(), {
      commandRunner: async (command) => {
        (commands as string[][]).push([...command]);
        return {
          exitCode: 0,
          stdout: "codex-cli 0.145.0\n",
          stderr: "warning: local PATH alias unavailable\n",
        };
      },
      commandPinAsserter: async () => undefined,
      clientStart: async (options) => {
        observedOptions.push(options);
        return {
          initializeResult: initializeResult("livis-relay-native-stdio-probe"),
          close: async () => {
            closed = true;
          },
        };
      },
    });

    expect(report).toEqual({
      ok: true,
      probeCompleted: true,
      readiness: "ready",
      transport: "app-server-stdio",
      compatibilityBasis: "protocol-handshake",
      versionRelation: "same",
      cliVersion: "0.145.0",
      appServerVersion: "0.145.0",
      touchedDesktopDaemon: false,
      sentModelTurn: false,
      probeProcessClosed: true,
      productionReady: false,
      verified: ["native-stdio-transport", "desktop-daemon-not-targeted"],
      unverified: [
        "native-backend-execution-state",
        "thread-turn-lifecycle",
        "session-resume",
        "concurrent-desktop-cli",
      ],
    });
    expect(commands).toEqual([[COMMAND_PIN.path, "--version"]]);
    expect(observedOptions[0]?.command).toEqual([
      COMMAND_PIN.path,
      "app-server",
      "--stdio",
      "-c",
      `permissions.${CODEX_NATIVE_PERMISSION_PROFILE}={` +
        `description="LiViS native stdio workspace-only",` +
        `filesystem={":root"="deny",":minimal"="read",":workspace_roots"="write"},` +
        `network={enabled=false}}`,
      ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
    ]);
    expect(observedOptions[0]?.env).toEqual({
      HOME: "/Users/test",
      CODEX_HOME: "/Users/test/.codex",
      LANG: "zh_CN.UTF-8",
    });
    expect(observedOptions[0]?.capabilities).toEqual({
      experimentalApi: false,
      requestAttestation: false,
    });
    expect(closed).toBeTrue();
  });

  test("版本不同只记录观测结果，不取代 initialize 协议裁决", async () => {
    const report = await probeCodexNativeStdio(probeOptions(), {
      commandRunner: async () => ({
        exitCode: 0,
        stdout: "codex-cli 0.146.0-alpha.3.1\n",
        stderr: "",
      }),
      commandPinAsserter: async () => undefined,
      clientStart: async () => ({
        initializeResult: initializeResult("livis-relay-native-stdio-probe", "0.145.0"),
        close: async () => undefined,
      }),
    });
    expect(report).toMatchObject({
      readiness: "ready",
      versionRelation: "different",
      cliVersion: "0.146.0-alpha.3.1",
      appServerVersion: "0.145.0",
    });
  });

  test("initialize 必须回读当前 runtime，失败时仍关闭自有 app-server", async () => {
    let closed = false;
    await expect(probeCodexNativeStdio(probeOptions(), {
      commandRunner: async () => ({ exitCode: 0, stdout: "codex-cli 0.145.0\n", stderr: "" }),
      commandPinAsserter: async () => undefined,
      clientStart: async () => ({
        initializeResult: {
          ...initializeResult("livis-relay-native-stdio-probe"),
          codexHome: "/private/livis-state/codex-home",
        },
        close: async () => {
          closed = true;
        },
      }),
    })).rejects.toMatchObject({ code: "native_initialize_incompatible" });
    expect(closed).toBeTrue();
  });

  test("HOME/CODEX_HOME 不能指向 Relay stateDir", async () => {
    await expect(buildCodexNativeStdioEnvironment("/private/livis-state", {
      HOME: "/private/livis-state/home",
    })).rejects.toMatchObject({ code: "native_runtime_selector_invalid" });
    await expect(buildCodexNativeStdioEnvironment("/private/livis-state", {
      HOME: "/Users/test",
      CODEX_HOME: "/private/livis-state/codex-home",
    })).rejects.toMatchObject({ code: "native_runtime_selector_invalid" });

    const state = await temporaryDirectory("livis-native-selector-state-");
    const external = await temporaryDirectory("livis-native-selector-external-");
    try {
      const linkedCodexHome = join(external.path, "linked-codex-home");
      await symlink(state.path, linkedCodexHome);
      await expect(buildCodexNativeStdioEnvironment(state.path, {
        HOME: external.path,
        CODEX_HOME: linkedCodexHome,
      })).rejects.toMatchObject({ code: "native_runtime_selector_invalid" });
    } finally {
      await Promise.all([state.cleanup(), external.cleanup()]);
    }
  });

  test("attach 持有独立 stdio 进程，初始化收口不确定时失败关闭", async () => {
    const observedOptions: CodexAppServerClientOptions[] = [];
    const attached = await attachCodexNativeStdio(probeOptions(), {
      commandRunner: async () => ({ exitCode: 0, stdout: "codex-cli 0.145.0\n", stderr: "" }),
      commandPinAsserter: async () => undefined,
      clientStart: async (options) => {
        observedOptions.push(options);
        return {
          initializeResult: initializeResult("livis-relay-native-stdio-attach"),
          running: true,
          exited: new Promise<number>(() => undefined),
          request: async <T = unknown>() => ({} as T),
          close: async () => undefined,
        };
      },
    });
    expect(attached).toMatchObject({
      transport: "app-server-stdio",
      ownsAppServerProcess: true,
      touchedDesktopDaemon: false,
    });
    expect(observedOptions[0]?.capabilities).toEqual({
      experimentalApi: true,
      requestAttestation: false,
    });

    await expect(probeCodexNativeStdio(probeOptions(), {
      commandRunner: async () => ({ exitCode: 0, stdout: "codex-cli 0.145.0\n", stderr: "" }),
      commandPinAsserter: async () => undefined,
      clientStart: async () => {
        throw new CodexAppServerStartCloseUnconfirmedError(
          new Error("fake initialize failed"),
          new Error("fake close unconfirmed"),
        );
      },
    })).rejects.toMatchObject({ code: "native_app_server_close_unconfirmed" });
  });

  test("CLI 显式模式启动独立 app-server，且不加载 Relay/Hermes 配置", async () => {
    const state = await temporaryDirectory("livis-native-stdio-state-");
    const external = await temporaryDirectory("livis-native-stdio-external-");
    const nativeHome = await temporaryDirectory("livis-native-stdio-home-");
    try {
      await chmod(state.path, 0o700);
      const command = join(external.path, "codex");
      const canonicalNativeHome = await realpath(nativeHome.path);
      const codexHome = join(canonicalNativeHome, ".codex");
      await writeFile(command, [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then",
        "  printf 'codex-cli 0.145.0\\n'",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"app-server\" ] && [ \"$2\" = \"--stdio\" ]; then",
        "  IFS= read -r request || exit 1",
        `  printf '%s\\n' '${JSON.stringify({
          id: 1,
          result: {
            codexHome,
            userAgent: "livis-relay-native-stdio-probe/0.145.0 (fake) codex_cli_rs/0.145.0",
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

      const child = Bun.spawn([
        process.execPath,
        "run",
        "src/index.ts",
        "codex",
        "probe-native-app-server",
        "--command",
        command,
        "--state-dir",
        state.path,
      ], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          HOME: canonicalNativeHome,
          CODEX_HOME: codexHome,
          LIVIS_RELAY_CONFIG: join(external.path, "must-not-be-read.json"),
          LIVIS_RELAY_STATE_DIR: join(external.path, "must-not-be-used"),
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
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toMatchObject({
        ok: true,
        readiness: "ready",
        transport: "app-server-stdio",
        cliVersion: "0.145.0",
        appServerVersion: "0.145.0",
        touchedDesktopDaemon: false,
        sentModelTurn: false,
        probeProcessClosed: true,
        productionReady: false,
      });
    } finally {
      await Promise.all([state.cleanup(), external.cleanup(), nativeHome.cleanup()]);
    }
  });
});
