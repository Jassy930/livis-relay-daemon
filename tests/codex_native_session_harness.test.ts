import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  CODEX_0145_ALLOWED_ENABLED_FEATURES,
  CODEX_DISABLED_FEATURES,
  CodexAppServerStartCloseUnconfirmedError,
  type CodexAppServerClientOptions,
  type CodexAppServerNotification,
} from "../src/backends/codex/app-server-client.ts";
import { CodexNativeClientEpochFence } from "../src/backends/codex/native-client-epoch.ts";
import {
  CodexNativeSessionHarness,
  type CodexNativeSessionHarnessOptions,
} from "../src/backends/codex/native-session-harness.ts";
import type {
  ExecutionBackendHandlers,
  ExecutionCancelledEvent,
  ExecutionFailedEvent,
  ExecutionResultEvent,
} from "../src/backends/execution-backend.ts";
import { JobStore } from "../src/state/store.ts";
import type { StoredJob } from "../src/types.ts";
import { incomingJob, temporaryDirectory } from "./helpers.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function featureSnapshot(): Array<Record<string, unknown>> {
  const features = new Map<string, Record<string, unknown>>();
  for (const name of CODEX_DISABLED_FEATURES) {
    features.set(name, {
      name,
      stage: "experimental",
      enabled: false,
      defaultEnabled: false,
    });
  }
  for (const [name, stage] of CODEX_0145_ALLOWED_ENABLED_FEATURES) {
    features.set(name, {
      name,
      stage,
      enabled: true,
      defaultEnabled: true,
    });
  }
  return [...features.values()];
}

class FakeAttachedProxyClient {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly turns: Array<{ id: string; status: "completed" | "failed" | "interrupted" }> = [];
  readonly exit = deferred<number>();
  readonly exited = this.exit.promise;
  initializeResult: unknown = {
    codexHome: "/Users/test/.codex",
    userAgent: "livis-relay-native-attach/0.1.1 (fake)",
    platformFamily: "unix",
    platformOs: "macos",
  };
  notificationHandler: CodexAppServerClientOptions["onNotification"];
  running = true;
  closeCalls = 0;
  interruptCalls = 0;
  nativeDaemonRunning = true;
  nativeDaemonStopCalls = 0;
  failPreflight = false;
  failClose = false;
  nextTurn = 1;

  constructor(readonly threadId: string) {}

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (this.failPreflight && method === "permissionProfile/list") {
      throw new Error("fake preflight unavailable");
    }
    if (method === "permissionProfile/list") {
      return { data: [{ id: "livis-remote", allowed: true }], nextCursor: null } as T;
    }
    if (method === "experimentalFeature/list") {
      return { data: featureSnapshot(), nextCursor: null } as T;
    }
    if (method === "thread/start" || method === "thread/resume") {
      return {
        thread: { id: this.threadId, cwd: "/test/native-workspace" },
        cwd: "/test/native-workspace",
        runtimeWorkspaceRoots: ["/test/native-workspace"],
        instructionSources: [],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        activePermissionProfile: { id: "livis-remote", extends: null },
        sandbox: {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
        model: "gpt-5.6-sol",
        modelProvider: "openai",
      } as T;
    }
    if (method === "thread/memoryMode/set") return {} as T;
    if (method === "thread/read") {
      return {
        thread: {
          id: this.threadId,
          status: { type: "idle" },
          turns: this.turns.map((turn) => ({ ...turn })),
        },
      } as T;
    }
    if (method === "turn/start") {
      return { turn: { id: `native-turn-${this.nextTurn++}`, status: "inProgress" } } as T;
    }
    if (method === "turn/interrupt") {
      this.interruptCalls += 1;
      return {} as T;
    }
    throw new Error(`fake attached proxy 未覆盖 ${method}`);
  }

  async emit(notification: CodexAppServerNotification): Promise<void> {
    await this.notificationHandler?.(notification);
  }

  async complete(turnId: string, text = "组合 harness 唯一 final"): Promise<void> {
    this.turns.push({ id: turnId, status: "completed" });
    await this.emit({
      method: "item/completed",
      params: {
        threadId: this.threadId,
        turnId,
        item: { id: `item-${turnId}`, type: "agentMessage", phase: "final_answer", text },
      },
    });
    await this.emit({
      method: "turn/completed",
      params: {
        threadId: this.threadId,
        turn: {
          id: turnId,
          status: "completed",
          items: [{
            id: `item-${turnId}`,
            type: "agentMessage",
            phase: "final_answer",
            text,
          }],
        },
      },
    });
  }

  exitProxy(code: number): void {
    if (!this.running) return;
    this.running = false;
    this.exit.resolve(code);
  }

  async close(): Promise<void> {
    if (!this.running) return;
    this.closeCalls += 1;
    if (this.failClose) throw new Error("fake proxy close unconfirmed");
    this.running = false;
    this.exit.resolve(0);
  }
}

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

const SOCKET_PIN = {
  path: "/Users/test/.codex/app-server-control/app-server-control.sock",
  parentPath: "/Users/test/.codex/app-server-control",
  socket: { dev: 1, ino: 3, mode: 0o140600, nlink: 1, uid: 501, gid: 20 },
  parent: { dev: 1, ino: 4, mode: 0o40700, nlink: 2, uid: 501, gid: 20 },
} as const;

function harnessOptions(
  sessionKey = "livis:native-harness",
  sessionHash = "a".repeat(64),
  overrides: Partial<CodexNativeSessionHarnessOptions["session"]> = {},
): CodexNativeSessionHarnessOptions {
  return {
    transport: {
      command: COMMAND_PIN,
      socketPath: SOCKET_PIN.path,
      stateDir: "/private/livis-state",
      cwd: "/test/native-workspace",
      sourceEnv: {
        HOME: "/Users/test",
        CODEX_HOME: "/Users/test/.codex",
        LANG: "zh_CN.UTF-8",
        OPENAI_API_KEY: "must-not-reach-proxy",
        CLAUDE_CODE_OAUTH_TOKEN: "must-not-reach-proxy",
      },
      minimumVersion: "0.145.0",
      maximumExclusiveVersion: "0.146.0",
      requestTimeoutMs: 100,
      shutdownTimeoutMs: 100,
      clientVersion: "0.1.1",
    },
    session: {
      sessionKey,
      sessionHash,
      workspace: "/test/native-workspace",
      requestedModel: "gpt-5.6-sol",
      expectedModelProvider: "openai",
      requestTimeoutMs: 100,
      turnTimeoutMs: 1_000,
      maxOutputChars: 4_096,
      ...overrides,
    },
  };
}

function attachDependencies(
  fake: FakeAttachedProxyClient,
  observedOptions: CodexAppServerClientOptions[] = [],
) {
  return {
    commandRunner: async (command: readonly string[]) => command[1] === "--version"
      ? { exitCode: 0, stdout: "codex-cli 0.145.0\n", stderr: "" }
      : {
          exitCode: 0,
          stdout: `${JSON.stringify({
            status: "running",
            socketPath: SOCKET_PIN.path,
            cliVersion: "0.145.0",
            appServerVersion: "0.145.0",
          })}\n`,
          stderr: "",
        },
    commandPinAsserter: async () => undefined,
    socketPinResolver: async () => SOCKET_PIN,
    socketPinAsserter: async () => undefined,
    clientStart: async (options: CodexAppServerClientOptions) => {
      observedOptions.push(options);
      fake.notificationHandler = options.onNotification;
      await fake.emit({ method: "native/fake-initialize-notification", params: {} });
      return fake;
    },
  };
}

interface HandlerObservations {
  ready: number;
  disconnectReasons: string[];
}

function handlers(store: JobStore, observed: HandlerObservations): ExecutionBackendHandlers {
  function fence(
    event: ExecutionResultEvent | ExecutionFailedEvent | ExecutionCancelledEvent,
  ): { runGeneration: number; turnId: string } {
    if (event.runGeneration === undefined || event.turnId === null || event.turnId === undefined) {
      throw new Error("测试 terminal 缺少 fence");
    }
    return { runGeneration: event.runGeneration, turnId: event.turnId };
  }
  return {
    onReady: async () => {
      observed.ready += 1;
    },
    onAccepted: async (event) => {
      if (event.runGeneration === undefined || event.turnId === undefined) {
        throw new Error("测试 accepted 缺少 fence");
      }
      if (!store.markBackendRunning(
        event.jobId,
        "codex",
        event.leaseId,
        event.runGeneration,
        event.turnId,
      )) throw new Error("测试 accepted fence 失效");
    },
    onResult: async (event) => {
      const current = fence(event);
      if (!store.finishBackendSuccess(
        event.jobId,
        "codex",
        event.leaseId,
        current.runGeneration,
        current.turnId,
        JSON.stringify({ text: event.text }),
      )) throw new Error("测试 result fence 失效");
    },
    onFailed: async (event) => {
      const current = fence(event);
      if (!store.finishBackendFailure(
        event.jobId,
        "codex",
        event.leaseId,
        current.runGeneration,
        current.turnId,
        JSON.stringify({ text: "failed" }),
        event.error,
      )) throw new Error("测试 failed fence 失效");
    },
    onCancelled: async (event) => {
      const current = fence(event);
      store.markBackendCancelUnknown(
        event.jobId,
        "codex",
        event.leaseId,
        current.runGeneration,
        current.turnId,
        "cancel result unknown",
      );
    },
    onDisconnected: async (event) => {
      observed.disconnectReasons.push(event.reason ?? "missing");
      store.markBackendDisconnected("codex", event.executionId, event.reason ?? "disconnected");
    },
  };
}

function claim(
  store: JobStore,
  harness: CodexNativeSessionHarness,
  sessionKey: string,
  jobId: string,
): StoredJob {
  store.ingest(incomingJob(jobId), sessionKey, "codex");
  store.markAcked(jobId);
  const claimed = store.claimForBackendDispatch(
    jobId,
    "codex",
    harness.executionId,
    `lease-${jobId}`,
  );
  if (!claimed) throw new Error(`测试 job 未能 claim：${jobId}`);
  return claimed;
}

async function waitFor(
  condition: () => boolean,
  label: string,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`等待超时：${label}`);
    await Bun.sleep(5);
  }
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Codex native transport + coordinator 受控组合 harness", () => {
  test("initialize 后 notification 固定绑定 coordinator epoch，成功执行仍不透传凭据环境", async () => {
    const directory = await temporaryDirectory("livis-native-harness-success-");
    cleanups.push(directory.cleanup);
    const store = new JobStore(join(directory.path, "relay.db"), "scope-native-harness");
    const fake = new FakeAttachedProxyClient("native-thread-success");
    const observedClientOptions: CodexAppServerClientOptions[] = [];
    const observed: HandlerObservations = { ready: 0, disconnectReasons: [] };
    const options = harnessOptions();
    const harness = await CodexNativeSessionHarness.start(options, {
      store,
      handlers: handlers(store, observed),
      clientEpochFence: new CodexNativeClientEpochFence(),
      attachDependencies: attachDependencies(fake, observedClientOptions),
    });

    expect(harness.status()).toMatchObject({
      ready: true,
      transport: "app-server-daemon-proxy",
      startedNativeDaemon: false,
      notificationBinding: {
        bound: true,
        clientEpoch: 1,
        unboundNotificationCount: 1,
      },
      productionReady: false,
    });
    expect(observed.ready).toBe(1);
    expect(observedClientOptions[0]?.env).toEqual({ LANG: "zh_CN.UTF-8" });
    expect(JSON.stringify(observedClientOptions[0]?.env)).not.toContain("API_KEY");
    expect(JSON.stringify(observedClientOptions[0]?.env)).not.toContain("OAUTH_TOKEN");

    const job = claim(store, harness, options.session.sessionKey, "harness-success");
    expect(await harness.dispatch(job)).toBe("submitted");
    await fake.complete("native-turn-1");
    await harness.waitForIdle();
    expect(store.require(job.jobId).status).toBe("Succeeded");
    expect(store.getBackendSession("codex", options.session.sessionKey)).toMatchObject({
      stateOwnership: "local-state-opaque",
      checkpointTurnId: "native-turn-1",
      recoveryRequired: false,
    });
    expect(store.getSessionQuarantine(options.session.sessionKey)).toBeNull();

    await harness.stop();
    expect(fake.closeCalls).toBe(1);
    expect(fake.nativeDaemonRunning).toBeTrue();
    expect(fake.nativeDaemonStopCalls).toBe(0);
    store.close();
  });

  test("attach 校验失败与 coordinator preflight 失败都确认关闭已取得所有权的 proxy", async () => {
    const firstDirectory = await temporaryDirectory("livis-native-harness-attach-fail-");
    cleanups.push(firstDirectory.cleanup);
    const firstStore = new JobStore(join(firstDirectory.path, "relay.db"), "scope-attach-fail");
    const invalid = new FakeAttachedProxyClient("native-thread-invalid");
    invalid.initializeResult = { codexHome: "/private/livis-state/nested" };
    await expect(CodexNativeSessionHarness.start(harnessOptions(), {
      store: firstStore,
      handlers: handlers(firstStore, { ready: 0, disconnectReasons: [] }),
      clientEpochFence: new CodexNativeClientEpochFence(),
      attachDependencies: attachDependencies(invalid),
    })).rejects.toMatchObject({ code: "native_initialize_incompatible" });
    expect(invalid.closeCalls).toBe(1);
    expect(invalid.nativeDaemonStopCalls).toBe(0);

    const unconfirmed = new FakeAttachedProxyClient("native-thread-unconfirmed");
    await expect(CodexNativeSessionHarness.start(harnessOptions(), {
      store: firstStore,
      handlers: handlers(firstStore, { ready: 0, disconnectReasons: [] }),
      clientEpochFence: new CodexNativeClientEpochFence(),
      attachDependencies: {
        ...attachDependencies(unconfirmed),
        clientStart: async () => {
          throw new CodexAppServerStartCloseUnconfirmedError(
            new Error("fake initialize failed"),
            new Error("fake close unconfirmed"),
          );
        },
      },
    })).rejects.toMatchObject({ code: "native_proxy_close_unconfirmed" });
    firstStore.close();

    const secondDirectory = await temporaryDirectory("livis-native-harness-start-fail-");
    cleanups.push(secondDirectory.cleanup);
    const secondStore = new JobStore(join(secondDirectory.path, "relay.db"), "scope-start-fail");
    const incompatible = new FakeAttachedProxyClient("native-thread-preflight");
    incompatible.failPreflight = true;
    await expect(CodexNativeSessionHarness.start(harnessOptions(), {
      store: secondStore,
      handlers: handlers(secondStore, { ready: 0, disconnectReasons: [] }),
      clientEpochFence: new CodexNativeClientEpochFence(),
      attachDependencies: attachDependencies(incompatible),
    })).rejects.toMatchObject({ code: "native_thread_preflight_incompatible" });
    expect(incompatible.closeCalls).toBe(1);
    expect(incompatible.nativeDaemonStopCalls).toBe(0);
    secondStore.close();
  });

  test("active attempt 的 proxy exit 与 terminal timeout 都进入持久 recovery/quarantine", async () => {
    for (const mode of ["exit", "timeout"] as const) {
      const directory = await temporaryDirectory(`livis-native-harness-${mode}-`);
      cleanups.push(directory.cleanup);
      const store = new JobStore(join(directory.path, "relay.db"), `scope-${mode}`);
      const fake = new FakeAttachedProxyClient(`native-thread-${mode}`);
      const observed: HandlerObservations = { ready: 0, disconnectReasons: [] };
      const options = harnessOptions(
        `livis:native-${mode}`,
        (mode === "exit" ? "b" : "c").repeat(64),
        { turnTimeoutMs: 25 },
      );
      const harness = await CodexNativeSessionHarness.start(options, {
        store,
        handlers: handlers(store, observed),
        clientEpochFence: new CodexNativeClientEpochFence(),
        attachDependencies: attachDependencies(fake),
      });
      const job = claim(store, harness, options.session.sessionKey, `active-${mode}`);
      expect(await harness.dispatch(job)).toBe("submitted");
      if (mode === "exit") fake.exitProxy(17);
      await waitFor(() => store.require(job.jobId).status === "Interrupted", `${mode} recovery`);

      expect(store.getBackendSession("codex", options.session.sessionKey)).toMatchObject({
        activeJobId: job.jobId,
        recoveryRequired: true,
      });
      expect(store.getSessionQuarantine(options.session.sessionKey)).not.toBeNull();
      expect(observed.disconnectReasons).toHaveLength(1);
      expect(fake.interruptCalls).toBe(mode === "timeout" ? 1 : 0);
      expect(fake.nativeDaemonStopCalls).toBe(0);
      await harness.stop();
      store.close();
    }
  });

  test("idle proxy 断开只降低 transport readiness，不错误隔离 session", async () => {
    const directory = await temporaryDirectory("livis-native-harness-idle-exit-");
    cleanups.push(directory.cleanup);
    const store = new JobStore(join(directory.path, "relay.db"), "scope-idle-exit");
    const fake = new FakeAttachedProxyClient("native-thread-idle");
    const observed: HandlerObservations = { ready: 0, disconnectReasons: [] };
    const options = harnessOptions("livis:native-idle", "d".repeat(64));
    const harness = await CodexNativeSessionHarness.start(options, {
      store,
      handlers: handlers(store, observed),
      clientEpochFence: new CodexNativeClientEpochFence(),
      attachDependencies: attachDependencies(fake),
    });

    fake.exitProxy(23);
    await waitFor(() => observed.disconnectReasons.length === 1, "idle disconnect");
    expect(harness.ready).toBeFalse();
    expect(store.getBackendSession("codex", options.session.sessionKey)).toMatchObject({
      activeJobId: null,
      recoveryRequired: false,
    });
    expect(store.getSessionQuarantine(options.session.sessionKey)).toBeNull();
    expect(fake.nativeDaemonRunning).toBeTrue();
    expect(fake.nativeDaemonStopCalls).toBe(0);
    await harness.stop();
    store.close();
  });

  test("旧 proxy 的 exit、超时和迟到 notification 不影响新 epoch", async () => {
    const oldDirectory = await temporaryDirectory("livis-native-harness-old-epoch-");
    const currentDirectory = await temporaryDirectory("livis-native-harness-current-epoch-");
    cleanups.push(oldDirectory.cleanup, currentDirectory.cleanup);
    const oldStore = new JobStore(join(oldDirectory.path, "relay.db"), "scope-old-epoch");
    const currentStore = new JobStore(
      join(currentDirectory.path, "relay.db"),
      "scope-current-epoch",
    );
    const fence = new CodexNativeClientEpochFence();

    const oldOptions = harnessOptions("livis:native-old", "e".repeat(64), { turnTimeoutMs: 30 });
    const oldFake = new FakeAttachedProxyClient("native-thread-old");
    const oldObserved: HandlerObservations = { ready: 0, disconnectReasons: [] };
    const old = await CodexNativeSessionHarness.start(oldOptions, {
      store: oldStore,
      handlers: handlers(oldStore, oldObserved),
      clientEpochFence: fence,
      attachDependencies: attachDependencies(oldFake),
    });
    const oldJob = claim(oldStore, old, oldOptions.session.sessionKey, "old-epoch-active");
    expect(await old.dispatch(oldJob)).toBe("submitted");

    const currentOptions = harnessOptions("livis:native-current", "f".repeat(64));
    const currentFake = new FakeAttachedProxyClient("native-thread-current");
    const currentObserved: HandlerObservations = { ready: 0, disconnectReasons: [] };
    const current = await CodexNativeSessionHarness.start(currentOptions, {
      store: currentStore,
      handlers: handlers(currentStore, currentObserved),
      clientEpochFence: fence,
      attachDependencies: attachDependencies(currentFake),
    });
    expect(old.clientEpoch).toBe(1);
    expect(current.clientEpoch).toBe(2);
    expect(old.ready).toBeFalse();

    await oldFake.complete("native-turn-1", "不得结算的旧 final");
    oldFake.exitProxy(19);
    await Bun.sleep(45);
    expect(oldStore.require(oldJob.jobId).status).toBe("Running");
    expect(oldObserved.disconnectReasons).toEqual([]);
    expect(oldFake.interruptCalls).toBe(0);
    expect(currentStore.getSessionQuarantine(currentOptions.session.sessionKey)).toBeNull();

    const currentJob = claim(
      currentStore,
      current,
      currentOptions.session.sessionKey,
      "current-epoch-success",
    );
    expect(await current.dispatch(currentJob)).toBe("submitted");
    await currentFake.complete("native-turn-1", "新 epoch final");
    await current.waitForIdle();
    expect(currentStore.require(currentJob.jobId).status).toBe("Succeeded");
    expect(current.ready).toBeTrue();
    expect(currentObserved.disconnectReasons).toEqual([]);

    await old.stop();
    await current.stop();
    expect(oldFake.nativeDaemonStopCalls).toBe(0);
    expect(currentFake.nativeDaemonStopCalls).toBe(0);
    oldStore.close();
    currentStore.close();
  });

  test("组合 harness 保持在生产入口之外", async () => {
    const harnessSource = await Bun.file(join(
      import.meta.dir,
      "../src/backends/codex/native-session-harness.ts",
    )).text();
    for (const forbidden of ["../../daemon.ts", "../../index.ts", "../../config.ts"]) {
      expect(harnessSource).not.toContain(forbidden);
    }
    for (const productionFile of ["daemon.ts", "index.ts", "config.ts"]) {
      const source = await Bun.file(join(import.meta.dir, "../src", productionFile)).text();
      expect(source).not.toContain("native-session-harness");
    }
  });
});
