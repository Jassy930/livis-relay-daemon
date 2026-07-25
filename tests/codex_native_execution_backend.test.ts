import { describe, expect, test } from "bun:test";
import { chmod, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CodexNativeExecutionBackend } from "../src/backends/codex/native-execution-backend.ts";
import type { ExecutionBackendHandlers } from "../src/backends/execution-backend.ts";
import { codexSessionHash } from "../src/backends/codex/runtime-layout.ts";
import { JobStore } from "../src/state/store.ts";
import { temporaryDirectory } from "./helpers.ts";

const handlers: ExecutionBackendHandlers = {
  onReady: async () => undefined,
  onAccepted: async () => undefined,
  onResult: async () => undefined,
  onFailed: async () => undefined,
  onCancelled: async () => undefined,
  onDisconnected: async () => undefined,
};

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
});
