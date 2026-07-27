import { describe, expect, test } from "bun:test";
import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLAUDE_NATIVE_REQUIRED_FLAGS,
  buildClaudeNativeEnvironment,
  buildClaudeNativeInvocationCommand,
  consumeClaudeNativeStream,
  prepareClaudeNativeCli,
} from "../src/backends/claude/native-cli.ts";
import { temporaryDirectory } from "./helpers.ts";

function stream(text: string): ReadableStream<Uint8Array> {
  return new Blob([text]).stream();
}

describe("Claude native CLI 安全协议", () => {
  test("能力探针只观察版本并按必需参数裁决兼容性", async () => {
    const state = await temporaryDirectory("livis-claude-probe-state-");
    const external = await temporaryDirectory("livis-claude-probe-external-");
    try {
      await chmod(state.path, 0o700);
      const runtimeTmpDir = join(state.path, "probe-tmp");
      await mkdir(runtimeTmpDir, { mode: 0o700 });
      const command = join(external.path, "claude");
      await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const calls: string[][] = [];
      const report = await prepareClaudeNativeCli({
        command,
        stateDir: state.path,
        runtimeTmpDir,
        cwd: external.path,
        requestTimeoutMs: 100,
        sourceEnv: { HOME: external.path, PATH: "/usr/bin", LANG: "zh_CN.UTF-8" },
        commandRunner: async (argv, options) => {
          calls.push([...argv]);
          expect(Object.keys(options.env).sort()).toEqual(["HOME", "LANG", "PATH", "TMPDIR"]);
          return argv.at(-1) === "--version"
            ? { exitCode: 0, stdout: "2.1.220 (Claude Code)\n", stderr: "" }
            : { exitCode: 0, stdout: CLAUDE_NATIVE_REQUIRED_FLAGS.join("\n"), stderr: "" };
        },
      });
      expect(calls.map((item) => item.at(-1))).toEqual(["--version", "--help"]);
      expect(report.report).toMatchObject({
        readiness: "ready",
        compatibilityBasis: "capability-probe",
        cliVersion: "2.1.220 (Claude Code)",
        versionsAreObservational: true,
        sentModelTurn: false,
        credentialStateInspected: false,
      });
      const invocation = buildClaudeNativeInvocationCommand(report.command, 0.05);
      expect(invocation).toContain("--safe-mode");
      expect(invocation).toContain("--no-session-persistence");
      expect(invocation).not.toContain("--bare");
      expect(invocation).not.toContain("--setting-sources");
    } finally {
      await Promise.all([state.cleanup(), external.cleanup()]);
    }
  });

  test("白名单环境不继承任意 daemon 变量", async () => {
    const state = await temporaryDirectory("livis-claude-env-state-");
    const external = await temporaryDirectory("livis-claude-env-external-");
    try {
      await chmod(state.path, 0o700);
      const runtimeTmpDir = join(state.path, "tmp");
      await mkdir(runtimeTmpDir, { mode: 0o700 });
      const environment = await buildClaudeNativeEnvironment({
        stateDir: state.path,
        runtimeTmpDir,
        source: {
          HOME: external.path,
          PATH: "/usr/bin:/path/that/does/not/exist",
          LANG: "C",
          UNREVIEWED_SECRET: "must-not-flow",
        },
      });
      expect(environment).toEqual({
        HOME: await realpath(external.path),
        TMPDIR: await realpath(runtimeTmpDir),
        PATH: "/usr/bin",
        LANG: "C",
      });
    } finally {
      await Promise.all([state.cleanup(), external.cleanup()]);
    }
  });

  test("stream-json 只接受安全 init 到唯一 result 的完整序列", async () => {
    const init = {
      type: "system",
      subtype: "init",
      session_id: "session-1",
      tools: [],
      mcp_servers: [],
      permissionMode: "dontAsk",
      skills: [],
      slash_commands: [],
    };
    const accepted: string[] = [];
    const result = await consumeClaudeNativeStream({
      stream: stream([
        JSON.stringify(init),
        JSON.stringify({
          type: "assistant",
          session_id: "session-1",
          message: { content: [{ type: "text", text: "中间文本" }] },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "session-1",
          result: "最终文本",
        }),
      ].join("\n") + "\n"),
      maxOutputChars: 100,
      onInit: async (sessionId) => { accepted.push(sessionId); },
    });
    expect(accepted).toEqual(["session-1"]);
    expect(result).toEqual({
      sessionId: "session-1",
      success: true,
      text: "最终文本",
      terminalSubtype: "success",
    });

    const catalogResult = await consumeClaudeNativeStream({
      stream: stream([
        JSON.stringify({
          ...init,
          plugins: [{ type: "catalog-entry" }],
          agents: [{ type: "catalog-entry" }],
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "session-1",
          result: "目录不可执行",
        }),
      ].join("\n") + "\n"),
      maxOutputChars: 100,
      onInit: async () => undefined,
    });
    expect(catalogResult.text).toBe("目录不可执行");

    await expect(consumeClaudeNativeStream({
      stream: stream([
        JSON.stringify({ ...init, tools: ["Bash"] }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "session-1",
          result: "不应接受",
        }),
      ].join("\n")),
      maxOutputChars: 100,
      onInit: async () => undefined,
    })).rejects.toThrow("未证明禁用可执行工具");

    await expect(consumeClaudeNativeStream({
      stream: stream([
        JSON.stringify(init),
        JSON.stringify({
          type: "assistant",
          session_id: "session-1",
          message: {
            stop_reason: "tool_use",
            content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: {} }],
          },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "session-1",
          result: "不应接受",
        }),
      ].join("\n")),
      maxOutputChars: 100,
      onInit: async () => undefined,
    })).rejects.toThrow("tool_use");

    await expect(consumeClaudeNativeStream({
      stream: stream([
        JSON.stringify(init),
        JSON.stringify({ type: "system", subtype: "hook_started" }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "session-1",
          result: "不应接受",
        }),
      ].join("\n")),
      maxOutputChars: 100,
      onInit: async () => undefined,
    })).rejects.toThrow("Hook");
  });
});
