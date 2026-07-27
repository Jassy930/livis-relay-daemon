import { describe, expect, test } from "bun:test";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClaudeNativeExecutionBackend } from "../src/backends/claude/native-execution-backend.ts";
import type { ExecutionBackendHandlers } from "../src/backends/execution-backend.ts";
import { JobStore } from "../src/state/store.ts";
import { incomingJob, temporaryDirectory } from "./helpers.ts";

const CLAUDE_HELP = [
  "--print --input-format --output-format --verbose --safe-mode --no-chrome",
  "--disable-slash-commands --strict-mcp-config --mcp-config --tools",
  "--permission-mode --no-session-persistence --prompt-suggestions",
  "--max-budget-usd --system-prompt",
].join(" ");

describe("Claude native-current ExecutionBackend", () => {
  test("以无状态安全 CLI 完成 submitted → accepted → result", async () => {
    const state = await temporaryDirectory("livis-claude-backend-state-");
    const external = await temporaryDirectory("livis-claude-backend-external-");
    try {
      await chmod(state.path, 0o700);
      const command = join(external.path, "claude");
      await writeFile(command, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' '2.1.220 (Claude Code)'
  exit 0
fi
if [ "$1" = "--help" ]; then
  printf '%s\\n' '${CLAUDE_HELP}'
  exit 0
fi
cat >/dev/null
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"claude-turn-1","tools":[],"mcp_servers":[],"permissionMode":"dontAsk","skills":[],"slash_commands":[]}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"claude-turn-1","result":"CLAUDE_OK"}'
`, { mode: 0o700 });
      const store = new JobStore(join(state.path, "relay.db"), "scope-claude-backend");
      const events: string[] = [];
      let resolveResult!: () => void;
      const resultSeen = new Promise<void>((resolvePromise) => { resolveResult = resolvePromise; });
      const handlers: ExecutionBackendHandlers = {
        onReady: async () => { events.push("ready"); },
        onAccepted: async (event) => {
          events.push(`accepted:${event.turnId}`);
        },
        onResult: async (event) => {
          events.push(`result:${event.text}`);
          resolveResult();
        },
        onFailed: async (event) => { events.push(`failed:${event.error}`); },
        onCancelled: async () => { events.push("cancelled"); },
        onDisconnected: async (event) => { events.push(`disconnected:${event.reason}`); },
      };
      const backend = new ClaudeNativeExecutionBackend({
        stateDir: state.path,
        scopeKey: "scope-claude-backend",
        sessionKey: "livis:claude-backend",
        remoteNodeId: "node-1",
        command,
        requestTimeoutMs: 1_000,
        turnTimeoutMs: 1_000,
        shutdownTimeoutMs: 1_000,
        maxOutputChars: 4_096,
        maxBudgetUsd: 0.05,
      }, {
        store,
        handlers,
        sourceEnv: { HOME: external.path, PATH: "/usr/bin", LANG: "C" },
      });
      await backend.start();
      expect(store.getBackendSession("claude", "livis:claude-backend")).toMatchObject({
        stateOwnership: "local-state-opaque",
        accountType: null,
        accountSubjectSha256: null,
        threadId: expect.stringContaining("claude-stateless:"),
        checkpointTurnCount: 0,
      });
      store.ingest(incomingJob("claude-job"), "livis:claude-backend", "claude");
      store.markAcked("claude-job");
      const claimed = store.claimForBackendDispatch(
        "claude-job",
        "claude",
        backend.executionId!,
        "lease-claude-job",
      );
      expect(claimed).not.toBeNull();
      const submission = await backend.dispatch(claimed!);
      expect(submission).toBe("submitted");
      expect(events).toEqual(["ready"]);
      await resultSeen;
      expect(events).toEqual(["ready", "accepted:claude-turn-1", "result:CLAUDE_OK"]);
      expect(backend.status()).toMatchObject({
        kind: "claude",
        mode: "native-current",
        ready: true,
        transport: "cli-stream-json",
        versionsAreObservational: true,
        sessionPersistence: false,
        credentialStateInspected: false,
      });
      await backend.stop();
      store.close();
    } finally {
      await Promise.all([state.cleanup(), external.cleanup()]);
    }
  });

  test("取消已 spawn 的执行会收口整个进程组并只上报 CancelledUnknown 语义事件", async () => {
    const state = await temporaryDirectory("livis-claude-cancel-state-");
    const external = await temporaryDirectory("livis-claude-cancel-external-");
    try {
      await chmod(state.path, 0o700);
      const command = join(external.path, "claude");
      await writeFile(command, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' '2.1.220 (Claude Code)'; exit 0; fi
if [ "$1" = "--help" ]; then printf '%s\\n' '${CLAUDE_HELP}'; exit 0; fi
cat >/dev/null
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"claude-cancel-turn","tools":[],"mcp_servers":[],"permissionMode":"dontAsk","skills":[],"slash_commands":[]}'
sleep 10
`, { mode: 0o700 });
      const store = new JobStore(join(state.path, "relay.db"), "scope-claude-cancel");
      let resolveAccepted!: () => void;
      let resolveCancelled!: () => void;
      const accepted = new Promise<void>((resolvePromise) => { resolveAccepted = resolvePromise; });
      const cancelled = new Promise<void>((resolvePromise) => { resolveCancelled = resolvePromise; });
      const events: string[] = [];
      const handlers: ExecutionBackendHandlers = {
        onReady: async () => undefined,
        onAccepted: async (event) => {
          events.push(`accepted:${event.turnId}`);
          resolveAccepted();
        },
        onResult: async () => { events.push("unexpected-result"); },
        onFailed: async () => { events.push("unexpected-failed"); },
        onCancelled: async (event) => {
          events.push(`cancelled:${event.turnId}`);
          resolveCancelled();
        },
        onDisconnected: async () => { events.push("unexpected-disconnected"); },
      };
      const backend = new ClaudeNativeExecutionBackend({
        stateDir: state.path,
        scopeKey: "scope-claude-cancel",
        sessionKey: "livis:claude-cancel",
        remoteNodeId: "node-1",
        command,
        requestTimeoutMs: 1_000,
        turnTimeoutMs: 10_000,
        shutdownTimeoutMs: 1_000,
        maxOutputChars: 4_096,
        maxBudgetUsd: 0.05,
      }, {
        store,
        handlers,
        sourceEnv: { HOME: external.path, PATH: "/usr/bin", LANG: "C" },
      });
      await backend.start();
      store.ingest(incomingJob("claude-cancel-job"), "livis:claude-cancel", "claude");
      store.markAcked("claude-cancel-job");
      const claimed = store.claimForBackendDispatch(
        "claude-cancel-job",
        "claude",
        backend.executionId!,
        "lease-claude-cancel",
      )!;
      expect(await backend.dispatch(claimed)).toBe("submitted");
      await accepted;
      expect(await backend.cancel(claimed)).toBe("submitted");
      await cancelled;
      expect(events).toEqual([
        "accepted:claude-cancel-turn",
        "cancelled:claude-cancel-turn",
      ]);
      await backend.stop();
      store.close();
    } finally {
      await Promise.all([state.cleanup(), external.cleanup()]);
    }
  });

  test("command 复核期间 cancel 获胜时可证明未 spawn", async () => {
    const state = await temporaryDirectory("livis-claude-submit-cancel-state-");
    const external = await temporaryDirectory("livis-claude-submit-cancel-external-");
    try {
      await chmod(state.path, 0o700);
      const command = join(external.path, "claude");
      await writeFile(command, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' '2.1.220 (Claude Code)'; exit 0; fi
if [ "$1" = "--help" ]; then printf '%s\\n' '${CLAUDE_HELP}'; exit 0; fi
exit 99
`, { mode: 0o700 });
      const store = new JobStore(join(state.path, "relay.db"), "scope-claude-submit-cancel");
      let releaseAssert!: () => void;
      let markAssertEntered!: () => void;
      const assertEntered = new Promise<void>((resolvePromise) => { markAssertEntered = resolvePromise; });
      const assertGate = new Promise<void>((resolvePromise) => { releaseAssert = resolvePromise; });
      let spawnCount = 0;
      const backend = new ClaudeNativeExecutionBackend({
        stateDir: state.path,
        scopeKey: "scope-claude-submit-cancel",
        sessionKey: "livis:claude-submit-cancel",
        remoteNodeId: "node-1",
        command,
        requestTimeoutMs: 1_000,
        turnTimeoutMs: 1_000,
        shutdownTimeoutMs: 1_000,
        maxOutputChars: 4_096,
        maxBudgetUsd: 0.05,
      }, {
        store,
        handlers: {
          onReady: async () => undefined,
          onAccepted: async () => undefined,
          onResult: async () => undefined,
          onFailed: async () => undefined,
          onCancelled: async () => undefined,
          onDisconnected: async () => undefined,
        },
        assertCommand: async () => {
          markAssertEntered();
          await assertGate;
        },
        spawn: () => {
          spawnCount += 1;
          throw new Error("不应 spawn");
        },
        sourceEnv: { HOME: external.path, PATH: "/usr/bin", LANG: "C" },
      });
      await backend.start();
      store.ingest(incomingJob("claude-submit-cancel-job"), "livis:claude-submit-cancel", "claude");
      store.markAcked("claude-submit-cancel-job");
      const claimed = store.claimForBackendDispatch(
        "claude-submit-cancel-job",
        "claude",
        backend.executionId!,
        "lease-claude-submit-cancel",
      )!;
      const dispatch = backend.dispatch(claimed);
      await assertEntered;
      expect(await backend.cancel(claimed)).toBe("not_sent");
      releaseAssert();
      expect(await dispatch).toBe("not_sent");
      expect(spawnCount).toBe(0);
      await backend.stop();
      store.close();
    } finally {
      await Promise.all([state.cleanup(), external.cleanup()]);
    }
  });

  test("terminal handler 失败时执行 fail-closed 并拒绝后续派发", async () => {
    const state = await temporaryDirectory("livis-claude-handler-failure-state-");
    const external = await temporaryDirectory("livis-claude-handler-failure-external-");
    try {
      await chmod(state.path, 0o700);
      const command = join(external.path, "claude");
      await writeFile(command, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' '2.1.220 (Claude Code)'; exit 0; fi
if [ "$1" = "--help" ]; then printf '%s\\n' '${CLAUDE_HELP}'; exit 0; fi
cat >/dev/null
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"claude-handler-turn","tools":[],"mcp_servers":[],"permissionMode":"dontAsk","skills":[],"slash_commands":[]}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"claude-handler-turn","result":"CLAUDE_HANDLER_OK"}'
`, { mode: 0o700 });
      const store = new JobStore(join(state.path, "relay.db"), "scope-claude-handler-failure");
      let resolveDisconnected!: () => void;
      const disconnected = new Promise<void>((resolvePromise) => { resolveDisconnected = resolvePromise; });
      const events: string[] = [];
      const backend = new ClaudeNativeExecutionBackend({
        stateDir: state.path,
        scopeKey: "scope-claude-handler-failure",
        sessionKey: "livis:claude-handler-failure",
        remoteNodeId: "node-1",
        command,
        requestTimeoutMs: 1_000,
        turnTimeoutMs: 1_000,
        shutdownTimeoutMs: 1_000,
        maxOutputChars: 4_096,
        maxBudgetUsd: 0.05,
      }, {
        store,
        handlers: {
          onReady: async () => undefined,
          onAccepted: async () => undefined,
          onResult: async () => {
            events.push("result");
            throw new Error("模拟 durable terminal handler 失败");
          },
          onFailed: async () => undefined,
          onCancelled: async () => undefined,
          onDisconnected: async () => {
            events.push("disconnected");
            resolveDisconnected();
          },
        },
        sourceEnv: { HOME: external.path, PATH: "/usr/bin", LANG: "C" },
      });
      await backend.start();
      store.ingest(incomingJob("claude-handler-failure-job"), "livis:claude-handler-failure", "claude");
      store.markAcked("claude-handler-failure-job");
      const claimed = store.claimForBackendDispatch(
        "claude-handler-failure-job",
        "claude",
        backend.executionId!,
        "lease-claude-handler-failure",
      )!;
      expect(await backend.dispatch(claimed)).toBe("submitted");
      await disconnected;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
      expect(events).toEqual(["result", "disconnected"]);
      expect(backend.ready).toBeFalse();
      expect(backend.status()).toMatchObject({
        ready: false,
        failed: true,
        activeJobId: null,
        lastFailure: "模拟 durable terminal handler 失败",
      });
      await backend.stop();
      store.close();
    } finally {
      await Promise.all([state.cleanup(), external.cleanup()]);
    }
  });
});
