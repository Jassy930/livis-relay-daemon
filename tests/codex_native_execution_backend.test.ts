import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CodexNativeExecutionBackend } from "../src/backends/codex/native-execution-backend.ts";
import type { ExecutionBackendHandlers } from "../src/backends/execution-backend.ts";
import { codexSessionHash } from "../src/backends/codex/runtime-layout.ts";
import { JobStore } from "../src/state/store.ts";
import type { StoredJob } from "../src/types.ts";
import { incomingJob, temporaryDirectory } from "./helpers.ts";

const handlers: ExecutionBackendHandlers = {
  onReady: async () => undefined,
  onAccepted: async () => undefined,
  onResult: async () => undefined,
  onFailed: async () => undefined,
  onCancelled: async () => undefined,
  onDisconnected: async () => undefined,
};

function dispatchedJob(jobId: string, sessionKey: string, leaseId: string): StoredJob {
  return {
    ...incomingJob(jobId),
    scopeKey: "scope-test",
    payloadHash: "0".repeat(64),
    targetBackend: "codex",
    status: "Dispatching",
    sessionKey,
    connectorId: "codex:test",
    leaseId,
    runGeneration: 1,
    error: null,
    cancelRequested: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
    outbox: null,
  };
}

describe("Codex native-current ExecutionBackend", () => {
  test("只建立私有 native workspace 并启动自有 harness", async () => {
    const state = await temporaryDirectory("livis-native-backend-state-");
    const external = await temporaryDirectory("livis-native-backend-command-");
    try {
      await chmod(state.path, 0o700);
      const command = join(external.path, "codex");
      await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const store = new JobStore(join(state.path, "relay.db"), "scope-native-backend");
      let observed: Parameters<NonNullable<ConstructorParameters<
        typeof CodexNativeExecutionBackend
      >[1]["harnessStart"]>>[0] | null = null;
      let stopped = 0;
      const backend = new CodexNativeExecutionBackend({
        stateDir: state.path,
        scopeKey: "scope-native-backend",
        sessionKey: "livis:native-backend",
        remoteNodeId: "node-1",
        command,
        requestTimeoutMs: 100,
        turnTimeoutMs: 1_000,
        shutdownTimeoutMs: 100,
        maxOutputChars: 4_096,
        clientVersion: "0.1.1",
      }, {
        store,
        handlers,
        harnessStart: async (options) => {
          observed = options;
          return {
            executionId: "codex:native-thread",
            ready: true,
            dispatch: async () => "submitted",
            cancel: async () => "submitted",
            stop: async () => { stopped += 1; },
            status: () => ({ transport: "fake-native-stdio" }),
          };
        },
      });

      await backend.start();
      const canonicalState = await realpath(state.path);
      const canonicalCommand = await realpath(command);
      const sessionHash = codexSessionHash(
        "scope-native-backend",
        "livis:native-backend",
        "node-1",
      );
      const expectedWorkspace = join(
        canonicalState,
        "backends",
        "codex",
        "native-sessions",
        sessionHash,
        "workspace",
      );
      expect(observed).not.toBeNull();
      expect(observed!.transport).toMatchObject({
        stateDir: canonicalState,
        cwd: expectedWorkspace,
        clientVersion: "0.1.1",
      });
      expect(observed!.transport.command.path).toBe(canonicalCommand);
      expect(observed!.session).toMatchObject({
        sessionKey: "livis:native-backend",
        sessionHash,
        workspace: expectedWorkspace,
        requestedModel: null,
        expectedModelProvider: null,
      });
      expect(backend.status()).toMatchObject({
        kind: "codex",
        mode: "native-current",
        ready: true,
        executionId: "codex:native-thread",
        stateOwnership: "local-state-opaque",
        touchedDesktopDaemon: false,
        credentialStateInspected: false,
      });
      await backend.stop();
      expect(stopped).toBe(1);
      store.close();
    } finally {
      await Promise.all([state.cleanup(), external.cleanup()]);
    }
  });

  test("harness 启动前物化 context，并在每轮派发前恢复最新快照", async () => {
    const state = await temporaryDirectory("livis-native-context-state-");
    const external = await temporaryDirectory("livis-native-context-command-");
    const context = await temporaryDirectory("livis-native-context-source-");
    try {
      state.path = await realpath(state.path);
      external.path = await realpath(external.path);
      context.path = await realpath(context.path);
      await Promise.all([chmod(state.path, 0o700), chmod(context.path, 0o700)]);
      const command = join(external.path, "codex");
      await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      await writeFile(join(context.path, "AGENTS.md"), "使用中文回答。\n", { mode: 0o600 });
      await mkdir(join(context.path, "memory"), { mode: 0o700 });
      const userMemory = join(context.path, "memory", "USER.md");
      await writeFile(userMemory, "第一代记忆\n", { mode: 0o600 });
      const store = new JobStore(join(state.path, "relay.db"), "scope-native-context");
      let workspace = "";
      let dispatchedMemory = "";
      let dispatchCount = 0;
      const backend = new CodexNativeExecutionBackend({
        stateDir: state.path,
        scopeKey: "scope-native-context",
        sessionKey: "livis:native-context",
        remoteNodeId: "node-1",
        command,
        requestTimeoutMs: 100,
        turnTimeoutMs: 1_000,
        shutdownTimeoutMs: 100,
        maxOutputChars: 4_096,
        clientVersion: "0.1.1",
        assistantContext: {
          mode: "read-only-files",
          contextDir: context.path,
          maxPromptChars: 20_000,
        },
      }, {
        store,
        handlers,
        harnessStart: async (options) => {
          workspace = options.session.workspace;
          expect(options.session.requiredInstructionSource).toBe(join(workspace, "AGENTS.md"));
          expect(await readFile(join(workspace, "AGENTS.md"), "utf8")).toContain("使用中文回答");
          expect(await readFile(join(workspace, "memory", "USER.md"), "utf8"))
            .toBe("第一代记忆\n");
          return {
            executionId: "codex:native-context",
            ready: true,
            dispatch: async () => {
              dispatchCount += 1;
              dispatchedMemory = await readFile(join(workspace, "memory", "USER.md"), "utf8");
              return "submitted";
            },
            cancel: async () => "submitted",
            stop: async () => undefined,
            status: () => ({}),
          };
        },
      });

      await backend.start();
      await writeFile(join(workspace, "memory", "USER.md"), "workspace 被篡改\n");
      await writeFile(userMemory, "第二代记忆\n");
      const claimed = dispatchedJob(
        "codex-context-job",
        "livis:native-context",
        "lease-codex-context",
      );
      expect(await backend.dispatch(claimed)).toBe("submitted");
      expect(dispatchCount).toBe(1);
      expect(dispatchedMemory).toBe("第二代记忆\n");
      expect(backend.status()).toMatchObject({
        assistantContext: {
          enabled: true,
          mode: "read-only-files",
          generation: expect.stringMatching(/^[0-9a-f]{64}$/),
          lastFailure: null,
        },
      });
      await backend.stop();
      store.close();
    } finally {
      await Promise.all([state.cleanup(), external.cleanup(), context.cleanup()]);
    }
  });

  test("context 无效时不启动 harness，运行期漂移时可证明未派发", async () => {
    for (const phase of ["start", "dispatch"] as const) {
      const state = await temporaryDirectory(`livis-native-context-${phase}-state-`);
      const external = await temporaryDirectory(`livis-native-context-${phase}-command-`);
      const context = await temporaryDirectory(`livis-native-context-${phase}-source-`);
      try {
        state.path = await realpath(state.path);
        external.path = await realpath(external.path);
        context.path = await realpath(context.path);
        await Promise.all([chmod(state.path, 0o700), chmod(context.path, 0o700)]);
        const command = join(external.path, "codex");
        await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
        const agents = join(context.path, "AGENTS.md");
        await writeFile(agents, "受控指令\n", { mode: 0o600 });
        if (phase === "start") await chmod(agents, 0o644);
        const store = new JobStore(join(state.path, "relay.db"), `scope-native-context-${phase}`);
        let harnessStartCount = 0;
        let dispatchCount = 0;
        const backend = new CodexNativeExecutionBackend({
          stateDir: state.path,
          scopeKey: `scope-native-context-${phase}`,
          sessionKey: `livis:native-context-${phase}`,
          remoteNodeId: "node-1",
          command,
          requestTimeoutMs: 100,
          turnTimeoutMs: 1_000,
          shutdownTimeoutMs: 100,
          maxOutputChars: 4_096,
          clientVersion: "0.1.1",
          assistantContext: {
            mode: "read-only-files",
            contextDir: context.path,
            maxPromptChars: 20_000,
          },
        }, {
          store,
          handlers,
          harnessStart: async () => {
            harnessStartCount += 1;
            return {
              executionId: `codex:${phase}`,
              ready: true,
              dispatch: async () => {
                dispatchCount += 1;
                return "submitted";
              },
              cancel: async () => "submitted",
              stop: async () => undefined,
              status: () => ({}),
            };
          },
        });
        if (phase === "start") {
          await expect(backend.start()).rejects.toThrow("0600");
          expect(harnessStartCount).toBe(0);
        } else {
          await backend.start();
          expect(harnessStartCount).toBe(1);
          await chmod(agents, 0o644);
          const claimed = dispatchedJob(
            "codex-context-invalid",
            `livis:native-context-${phase}`,
            "lease-codex-invalid",
          );
          expect(await backend.dispatch(claimed)).toBe("not_sent");
          expect(dispatchCount).toBe(0);
          expect(backend.status()).toMatchObject({
            assistantContext: {
              enabled: true,
              lastFailure: "assistant_context_file_metadata_invalid",
            },
          });
          expect(JSON.stringify(backend.status())).not.toContain(context.path);
          await backend.stop();
        }
        store.close();
      } finally {
        await Promise.all([state.cleanup(), external.cleanup(), context.cleanup()]);
      }
    }
  });
});
