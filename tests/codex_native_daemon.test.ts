import { describe, expect, test } from "bun:test";
import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import type { CodexAppServerClientOptions } from "../src/backends/codex/app-server-client.ts";
import type { CodexCommandRunner } from "../src/backends/codex/codex-execution-backend.ts";
import {
  assertPinnedCodexNativeDaemonSocket,
  buildCodexNativeManagementEnvironment,
  buildCodexNativeProxyEnvironment,
  parseCodexNativeDaemonVersionReport,
  pinCodexNativeDaemonSocket,
  probeCodexNativeDaemon,
  type PinnedCodexNativeSocket,
} from "../src/backends/codex/native-daemon.ts";
import type { PinnedCodexCommand } from "../src/backends/codex/runtime-layout.ts";
import { atomicWritePrivate } from "../src/util.ts";
import { temporaryDirectory, testConfig } from "./helpers.ts";

const PROJECT_ROOT = join(import.meta.dir, "..");

const COMMAND_PIN: PinnedCodexCommand = {
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
};

const SOCKET_PIN: PinnedCodexNativeSocket = {
  path: "/Users/test/.codex/app-server-control/app-server-control.sock",
  parentPath: "/Users/test/.codex/app-server-control",
  socket: { dev: 1, ino: 3, mode: 0o140600, nlink: 1, uid: 501, gid: 20 },
  parent: { dev: 1, ino: 4, mode: 0o40700, nlink: 2, uid: 501, gid: 20 },
};

function commandRunnerFor(appServerVersion = "0.145.0", cliVersion = "0.145.0") {
  const calls: Array<{ command: readonly string[]; env: Record<string, string> }> = [];
  const runner: CodexCommandRunner = async (command, options) => {
    calls.push({ command, env: options.env });
    if (command.length === 2 && command[1] === "--version") {
      return { exitCode: 0, stdout: `codex-cli ${cliVersion}\n`, stderr: "" };
    }
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({
        status: "running",
        managedCodexPath: "/opt/codex/bin/codex",
        managedCodexVersion: null,
        socketPath: SOCKET_PIN.path,
        cliVersion,
        appServerVersion,
      })}\n`,
      stderr: "",
    };
  };
  return { runner, calls };
}

function probeOptions() {
  return {
    command: COMMAND_PIN,
    socketPath: SOCKET_PIN.path,
    stateDir: "/private/livis-state",
    cwd: "/private/livis-workspace",
    sourceEnv: {
      HOME: "/Users/test",
      CODEX_HOME: "/Users/test/.codex",
      LANG: "zh_CN.UTF-8",
      OPENAI_API_KEY: "must-not-reach-proxy",
      LIVIS_RELAY_CONFIG: "must-not-reach-child",
      UNRELATED_SECRET: "must-not-reach-child",
    },
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000,
    clientVersion: "0.1.1",
  } as const;
}

describe("Codex 原生 daemon 只读兼容性探针", () => {
  test("管理命令与 proxy 使用不同环境白名单", () => {
    const source = probeOptions().sourceEnv;
    expect(buildCodexNativeManagementEnvironment(source)).toEqual({
      HOME: "/Users/test",
      CODEX_HOME: "/Users/test/.codex",
      LANG: "zh_CN.UTF-8",
    });
    expect(buildCodexNativeProxyEnvironment(source)).toEqual({
      LANG: "zh_CN.UTF-8",
    });
  });

  test("daemon version 必须运行中、socket 精确匹配，版本只观测不裁决兼容性", () => {
    const base = {
      cliVersion: "0.145.0",
      socketPath: SOCKET_PIN.path,
    };
    expect(parseCodexNativeDaemonVersionReport({
      exitCode: 0,
      stdout: JSON.stringify({
        status: "running",
        socketPath: SOCKET_PIN.path,
        cliVersion: "0.145.0",
        appServerVersion: "0.145.0",
      }),
      stderr: "",
    }, base)).toMatchObject({ appServerVersion: "0.145.0" });

    expect(parseCodexNativeDaemonVersionReport({
      exitCode: 0,
      stdout: JSON.stringify({
        status: "running",
        socketPath: SOCKET_PIN.path,
        cliVersion: "0.145.0",
        appServerVersion: "0.144.1",
      }),
      stderr: "",
    }, base)).toMatchObject({ appServerVersion: "0.144.1" });
    expect(parseCodexNativeDaemonVersionReport({
      exitCode: 0,
      stdout: JSON.stringify({
        status: "running",
        socketPath: SOCKET_PIN.path,
        cliVersion: "0.145.0",
        appServerVersion: "0.146.0-alpha.3.1",
      }),
      stderr: "",
    }, base)).toMatchObject({ appServerVersion: "0.146.0-alpha.3.1" });
    expect(() => parseCodexNativeDaemonVersionReport({
      exitCode: 0,
      stdout: JSON.stringify({
        status: "running",
        socketPath: SOCKET_PIN.path,
        cliVersion: "0.145.0",
        appServerVersion: "unknown",
      }),
      stderr: "",
    }, base)).toThrow("有界 semver");
    expect(() => parseCodexNativeDaemonVersionReport({
      exitCode: 0,
      stdout: JSON.stringify({
        status: "stopped",
        socketPath: SOCKET_PIN.path,
        cliVersion: "0.145.0",
        appServerVersion: "0.145.0",
      }),
      stderr: "",
    }, base)).toThrow("不会代替操作者启动或重启");
  });

  test("socket 必须由当前用户通过 0700 父目录持有且自身为 0600", async () => {
    const root = await temporaryDirectory("livis-codex-native-socket-");
    const parent = join(await realpath(root.path), "control");
    const socket = join(parent, "control.sock");
    await mkdir(parent, { mode: 0o700 });
    await chmod(parent, 0o700);
    const server = createServer();
    try {
      await new Promise<void>((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(socket, () => resolvePromise());
      });
      await chmod(socket, 0o600);
      const pin = await pinCodexNativeDaemonSocket(socket);
      await assertPinnedCodexNativeDaemonSocket(pin);
      await chmod(parent, 0o755);
      await expect(assertPinnedCodexNativeDaemonSocket(pin)).rejects.toMatchObject({
        code: "native_daemon_socket_insecure",
      });
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      await root.cleanup();
    }
  });

  test("成功探针只完成 initialize，不读取账号或启动 daemon、thread、模型 turn", async () => {
    const { runner, calls } = commandRunnerFor();
    const observedClientOptions: CodexAppServerClientOptions[] = [];
    let closed = false;
    const report = await probeCodexNativeDaemon(probeOptions(), {
      commandRunner: runner,
      commandPinAsserter: async () => undefined,
      socketPinResolver: async () => SOCKET_PIN,
      socketPinAsserter: async () => undefined,
      clientStart: async (options) => {
        observedClientOptions.push(options);
        return {
          initializeResult: {
            codexHome: "/Users/test/.codex",
            userAgent: "livis-relay-native-probe/0.1.1 (test)",
            platformFamily: "unix",
            platformOs: "macos",
          },
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
      transport: "app-server-daemon-proxy",
      compatibilityBasis: "protocol-handshake",
      versionRelation: "same",
      cliVersion: "0.145.0",
      appServerVersion: "0.145.0",
      startedNativeDaemon: false,
      sentModelTurn: false,
      productionReady: false,
      verified: ["native-daemon-transport"],
      unverified: [
        "native-backend-execution-state",
        "server-config-isolation",
        "thread-turn-lifecycle",
        "session-resume",
        "concurrent-desktop-cli",
      ],
    });
    expect(closed).toBeTrue();
    expect(observedClientOptions[0]?.command).toEqual([
      COMMAND_PIN.path,
      "app-server",
      "proxy",
      "--sock",
      SOCKET_PIN.path,
    ]);
    expect(observedClientOptions[0]?.env).toEqual({ LANG: "zh_CN.UTF-8" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.env).toEqual({
      HOME: "/Users/test",
      CODEX_HOME: "/Users/test/.codex",
      LANG: "zh_CN.UTF-8",
    });
  });

  test("运行中 app-server 版本不同仍继续 proxy，并由 initialize 协议裁决", async () => {
    const { runner } = commandRunnerFor("0.144.1", "0.146.0-alpha.3.1");
    let started = false;
    let closed = false;
    const report = await probeCodexNativeDaemon(probeOptions(), {
      commandRunner: runner,
      commandPinAsserter: async () => undefined,
      socketPinResolver: async () => SOCKET_PIN,
      socketPinAsserter: async () => undefined,
      clientStart: async () => {
        started = true;
        return {
          initializeResult: {
            codexHome: "/Users/test/.codex",
            userAgent: "livis-relay-native-probe/0.1.1 (test)",
            platformFamily: "unix",
            platformOs: "macos",
          },
          close: async () => {
            closed = true;
          },
        };
      },
    });
    expect(report).toMatchObject({
      readiness: "ready",
      compatibilityBasis: "protocol-handshake",
      versionRelation: "different",
      cliVersion: "0.146.0-alpha.3.1",
      appServerVersion: "0.144.1",
    });
    expect(started).toBeTrue();
    expect(closed).toBeTrue();
  });

  test("版本不同不会削弱 initialize 响应结构门禁，失败后仍关闭自有 proxy", async () => {
    const { runner } = commandRunnerFor("0.144.1");
    let closed = false;
    await expect(probeCodexNativeDaemon(probeOptions(), {
      commandRunner: runner,
      commandPinAsserter: async () => undefined,
      socketPinResolver: async () => SOCKET_PIN,
      socketPinAsserter: async () => undefined,
      clientStart: async () => ({
        initializeResult: {
          codexHome: probeOptions().stateDir,
          userAgent: "livis-relay-native-probe/0.1.1 (test)",
          platformFamily: "unix",
          platformOs: "macos",
        },
        close: async () => {
          closed = true;
        },
      }),
    })).rejects.toMatchObject({ code: "native_initialize_incompatible" });
    expect(closed).toBeTrue();
  });

  test("CLI 不因 app-server 版本不同短路，仍执行 socket 身份门禁", async () => {
    const state = await temporaryDirectory("livis-codex-native-cli-state-");
    const external = await temporaryDirectory("livis-codex-native-cli-command-");
    try {
      await chmod(state.path, 0o700);
      const socketPath = join(external.path, "not-created.sock");
      const command = join(external.path, "codex");
      const daemonReport = JSON.stringify({
        status: "running",
        socketPath,
        cliVersion: "0.145.0",
        appServerVersion: "0.144.1",
      });
      await writeFile(command, [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then",
        "  printf 'codex-cli 0.145.0\\n'",
        "else",
        `  printf '%s\\n' ${JSON.stringify(daemonReport)}`,
        "fi",
        "",
      ].join("\n"), { mode: 0o700 });
      const configPath = join(state.path, "config.json");
      const config = testConfig(state.path);
      config.codex.command = command;
      await atomicWritePrivate(configPath, `${JSON.stringify(config, null, 2)}\n`);

      const child = Bun.spawn([
        process.execPath,
        "run",
        "src/index.ts",
        "codex",
        "probe-native-daemon",
        "--socket",
        socketPath,
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
      expect(exitCode).toBe(1);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toMatchObject({
        ok: false,
        probeCompleted: false,
        readiness: "incompatible",
        compatibilityBasis: "protocol-handshake",
        reasonCode: "native_daemon_socket_insecure",
        startedNativeDaemon: false,
        sentModelTurn: false,
        productionReady: false,
      });
    } finally {
      await Promise.all([state.cleanup(), external.cleanup()]);
    }
  });

  test("CLI 显式 command/stateDir 模式不加载 Relay/Hermes 配置", async () => {
    const state = await temporaryDirectory("livis-codex-native-explicit-state-");
    const external = await temporaryDirectory("livis-codex-native-explicit-command-");
    try {
      await chmod(state.path, 0o700);
      const socketPath = join(external.path, "not-created.sock");
      const command = join(external.path, "codex");
      const daemonReport = JSON.stringify({
        status: "running",
        socketPath,
        cliVersion: "0.145.0",
        appServerVersion: "0.144.1",
      });
      await writeFile(command, [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then",
        "  printf 'codex-cli 0.145.0\\n'",
        "else",
        `  printf '%s\\n' ${JSON.stringify(daemonReport)}`,
        "fi",
        "",
      ].join("\n"), { mode: 0o700 });

      const child = Bun.spawn([
        process.execPath,
        "run",
        "src/index.ts",
        "codex",
        "probe-native-daemon",
        "--socket",
        socketPath,
        "--command",
        command,
        "--state-dir",
        state.path,
      ], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
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
      expect(exitCode).toBe(1);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toMatchObject({
        ok: false,
        probeCompleted: false,
        readiness: "incompatible",
        compatibilityBasis: "protocol-handshake",
        reasonCode: "native_daemon_socket_insecure",
        startedNativeDaemon: false,
        sentModelTurn: false,
        productionReady: false,
      });
    } finally {
      await Promise.all([state.cleanup(), external.cleanup()]);
    }
  });
});
