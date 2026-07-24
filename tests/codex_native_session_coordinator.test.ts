import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  CODEX_0145_ALLOWED_ENABLED_FEATURES,
  CODEX_DISABLED_FEATURES,
  type CodexAppServerNotification,
} from "../src/backends/codex/app-server-client.ts";
import { CodexNativeClientEpochFence } from "../src/backends/codex/native-client-epoch.ts";
import type { CodexNativeExecutionClient } from "../src/backends/codex/native-execution-lifecycle.ts";
import {
  CodexNativeSessionCoordinator,
  type CodexNativeSessionCoordinatorOptions,
} from "../src/backends/codex/native-session-coordinator.ts";
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

class FakeNativeCoordinatorClient implements CodexNativeExecutionClient {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly exit = deferred<number>();
  readonly exited = this.exit.promise;
  readonly turns: Array<{ id: string; status: "completed" | "failed" | "interrupted" }> = [];
  readonly threadId = "native-thread-1";
  closed = false;
  closeCalls = 0;
  nativeDaemonStopCalls = 0;
  nextTurn = 1;

  get running(): boolean {
    return !this.closed;
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "permissionProfile/list") {
      return { data: [{ id: "livis-native-stdio", allowed: true }], nextCursor: null } as T;
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
        activePermissionProfile: { id: "livis-native-stdio", extends: null },
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
    if (method === "thread/memoryMode/set" || method === "turn/interrupt") return {} as T;
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
    throw new Error(`fake native coordinator client 未覆盖 ${method}`);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.closed = true;
  }
}

function options(
  overrides: Partial<CodexNativeSessionCoordinatorOptions> = {},
): CodexNativeSessionCoordinatorOptions {
  return {
    sessionKey: "livis:native-session",
    sessionHash: "a".repeat(64),
    workspace: "/test/native-workspace",
    cliVersion: "0.145.0",
    requestedModel: "gpt-5.6-sol",
    expectedModelProvider: "openai",
    requestTimeoutMs: 100,
    turnTimeoutMs: 1_000,
    maxOutputChars: 4_096,
    ...overrides,
  };
}

function handlers(store: JobStore): ExecutionBackendHandlers {
  function fence(
    event: ExecutionResultEvent | ExecutionFailedEvent | ExecutionCancelledEvent,
  ): { runGeneration: number; turnId: string } {
    if (event.runGeneration === undefined || event.turnId === null || event.turnId === undefined) {
      throw new Error("测试 terminal 缺少 fence");
    }
    return { runGeneration: event.runGeneration, turnId: event.turnId };
  }

  return {
    onReady: async () => undefined,
    onAccepted: async (event) => {
      if (event.runGeneration === undefined || event.turnId === undefined) {
        throw new Error("测试 accepted 缺少 fence");
      }
      const running = store.markBackendRunning(
        event.jobId,
        "codex",
        event.leaseId,
        event.runGeneration,
        event.turnId,
      );
      if (!running) throw new Error("测试 accepted fence 失效");
    },
    onResult: async (event) => {
      const current = fence(event);
      const finished = store.finishBackendSuccess(
        event.jobId,
        "codex",
        event.leaseId,
        current.runGeneration,
        current.turnId,
        JSON.stringify({ text: event.text }),
      );
      if (!finished) throw new Error("测试 result fence 失效");
    },
    onFailed: async (event) => {
      const current = fence(event);
      const finished = store.finishBackendFailure(
        event.jobId,
        "codex",
        event.leaseId,
        current.runGeneration,
        current.turnId,
        JSON.stringify({ text: "backend failed" }),
        event.error,
      );
      if (!finished) throw new Error("测试 failed fence 失效");
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
      store.markBackendDisconnected("codex", event.executionId, event.reason ?? "disconnected");
    },
  };
}

function claim(
  store: JobStore,
  coordinator: CodexNativeSessionCoordinator,
  jobId: string,
): StoredJob {
  store.ingest(incomingJob(jobId), options().sessionKey, "codex");
  store.markAcked(jobId);
  const claimed = store.claimForBackendDispatch(
    jobId,
    "codex",
    coordinator.executionId,
    `lease-${jobId}`,
  );
  if (!claimed) throw new Error(`测试 job 未能 claim：${jobId}`);
  return claimed;
}

async function terminal(
  coordinator: CodexNativeSessionCoordinator,
  client: FakeNativeCoordinatorClient,
  turnId: string,
  status: "completed" | "failed" | "interrupted",
  text = "唯一 final",
): Promise<void> {
  client.turns.push({ id: turnId, status });
  if (status === "completed") {
    coordinator.handleNotification({
      method: "item/completed",
      params: {
        threadId: client.threadId,
        turnId,
        item: { id: `item-${turnId}`, type: "agentMessage", phase: "final_answer", text },
      },
    });
  }
  const notification: CodexAppServerNotification = {
    method: "turn/completed",
    params: {
      threadId: client.threadId,
      turn: {
        id: turnId,
        status,
        items: status === "completed"
          ? [{ id: `item-${turnId}`, type: "agentMessage", phase: "final_answer", text }]
          : [],
      },
    },
  };
  coordinator.handleNotification(notification);
  await coordinator.waitForIdle();
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Codex native 持久 session coordinator", () => {
  test("fresh session 原子绑定 thread/checkpoint，状态所有权保持本地不透明", async () => {
    const directory = await temporaryDirectory("livis-native-coordinator-fresh-");
    cleanups.push(directory.cleanup);
    const store = new JobStore(join(directory.path, "relay.db"), "scope-native");
    const client = new FakeNativeCoordinatorClient();
    const coordinator = await CodexNativeSessionCoordinator.start(options(), {
      store,
      client,
      handlers: handlers(store),
      clientEpochFence: new CodexNativeClientEpochFence(),
    });

    expect(store.getBackendSession("codex", options().sessionKey)).toMatchObject({
      stateOwnership: "local-state-opaque",
      threadId: "native-thread-1",
      checkpointTurnId: null,
      checkpointTurnCount: 0,
      activeJobId: null,
    });
    const stored = store.getBackendSession("codex", options().sessionKey)!;
    expect(stored.accountType).toBeNull();
    expect(stored.accountSubjectSha256).toBeNull();
    expect(stored.accountIdentityStrength).toBeNull();
    expect(coordinator.status()).toMatchObject({
      ready: true,
      stateOwnership: "local-state-opaque",
      productionReady: false,
    });
    expect(client.requests.map((request) => request.method)).toEqual([
      "permissionProfile/list",
      "experimentalFeature/list",
      "thread/start",
      "thread/memoryMode/set",
      "thread/read",
    ]);

    await coordinator.stop();
    expect(client.closeCalls).toBe(1);
    expect(client.nativeDaemonStopCalls).toBe(0);
    store.close();
  });

  test("terminal checkpoint 后跨 Store 重开精确 resume，attempt 审计不保存本地状态详情", async () => {
    const directory = await temporaryDirectory("livis-native-coordinator-resume-");
    cleanups.push(directory.cleanup);
    const databasePath = join(directory.path, "relay.db");
    const fence = new CodexNativeClientEpochFence();
    const firstStore = new JobStore(databasePath, "scope-native");
    const firstClient = new FakeNativeCoordinatorClient();
    const first = await CodexNativeSessionCoordinator.start(options(), {
      store: firstStore,
      client: firstClient,
      handlers: handlers(firstStore),
      clientEpochFence: fence,
    });
    const firstJob = claim(firstStore, first, "resume-source");
    expect(await first.dispatch(firstJob)).toBe("submitted");
    await terminal(first, firstClient, "native-turn-1", "completed");
    expect(firstStore.require(firstJob.jobId).status).toBe("Succeeded");
    expect(firstStore.listExecutionAttemptEvents(firstJob.jobId)).toMatchObject([
      { eventType: "reserved", stateOwnership: "local-state-opaque", accountType: null },
      { eventType: "accepted", stateOwnership: "local-state-opaque", accountType: null },
      { eventType: "succeeded", stateOwnership: "local-state-opaque", accountType: null },
    ]);
    await first.stop();
    firstStore.close();

    const reopened = new JobStore(databasePath, "scope-native");
    const secondClient = new FakeNativeCoordinatorClient();
    secondClient.turns.push({ id: "native-turn-1", status: "completed" });
    const second = await CodexNativeSessionCoordinator.start(options(), {
      store: reopened,
      client: secondClient,
      handlers: handlers(reopened),
      clientEpochFence: fence,
    });
    expect(secondClient.requests.some((request) => request.method === "thread/resume")).toBeTrue();
    expect(secondClient.requests.some((request) => request.method === "thread/start")).toBeFalse();
    expect(second.status()).toMatchObject({ clientEpoch: 2, ready: true });
    await second.stop();
    reopened.close();
  });

  test("普通 backend failed 只结算当前 job，下一 job 继续使用同一 session", async () => {
    const directory = await temporaryDirectory("livis-native-coordinator-failed-");
    cleanups.push(directory.cleanup);
    const store = new JobStore(join(directory.path, "relay.db"), "scope-native");
    const client = new FakeNativeCoordinatorClient();
    const coordinator = await CodexNativeSessionCoordinator.start(options(), {
      store,
      client,
      handlers: handlers(store),
      clientEpochFence: new CodexNativeClientEpochFence(),
    });

    const failedJob = claim(store, coordinator, "ordinary-failed");
    expect(await coordinator.dispatch(failedJob)).toBe("submitted");
    await terminal(coordinator, client, "native-turn-1", "failed");
    expect(store.require(failedJob.jobId).status).toBe("Failed");
    expect(store.getSessionQuarantine(options().sessionKey)).toBeNull();
    expect(store.getBackendSession("codex", options().sessionKey)).toMatchObject({
      activeJobId: null,
      recoveryRequired: false,
      checkpointTurnId: "native-turn-1",
      checkpointTurnStatus: "failed",
    });

    const nextJob = claim(store, coordinator, "after-failed");
    expect(await coordinator.dispatch(nextJob)).toBe("submitted");
    await terminal(coordinator, client, "native-turn-2", "completed", "失败后仍可成功");
    expect(store.require(nextJob.jobId).status).toBe("Succeeded");
    expect(coordinator.ready).toBeTrue();
    await coordinator.stop();
    store.close();
  });

  test("历史 active/recovery attempt 在任何 thread RPC 前进入 ambiguous quarantine", async () => {
    const directory = await temporaryDirectory("livis-native-coordinator-active-");
    cleanups.push(directory.cleanup);
    const store = new JobStore(join(directory.path, "relay.db"), "scope-native");
    store.createLocalOpaqueBackendSession({
      backend: "codex",
      sessionKey: options().sessionKey,
      sessionHash: options().sessionHash,
      threadId: "native-thread-1",
      cwd: options().workspace,
      cliVersion: options().cliVersion,
      requestedModel: options().requestedModel,
      effectiveModel: "gpt-5.6-sol",
      modelProvider: "openai",
      securityConfigSha256: "b".repeat(64),
      featureSnapshotSha256: "c".repeat(64),
      checkpointTurnId: null,
      checkpointTurnStatus: null,
      checkpointTurnCount: 0,
      checkpointTurnsSha256: "d".repeat(64),
      checkpointedAt: 1,
    });
    store.ingest(incomingJob("historical-active"), options().sessionKey, "codex");
    store.markAcked("historical-active");
    const claimed = store.claimForBackendDispatch(
      "historical-active",
      "codex",
      "codex-native:old-thread:1",
      "old-lease",
    )!;
    store.markBackendRunning(
      claimed.jobId,
      "codex",
      "old-lease",
      claimed.runGeneration,
      "old-turn",
    );
    const client = new FakeNativeCoordinatorClient();

    await expect(CodexNativeSessionCoordinator.start(options(), {
      store,
      client,
      handlers: handlers(store),
      clientEpochFence: new CodexNativeClientEpochFence(),
    })).rejects.toMatchObject({
      code: "native_session_active_attempt",
      sessionDisposition: "quarantine_required",
    });
    expect(client.requests).toEqual([]);
    expect(client.closeCalls).toBe(1);
    expect(store.require(claimed.jobId).status).toBe("Interrupted");
    expect(store.getBackendSession("codex", options().sessionKey)).toMatchObject({
      recoveryRequired: true,
      activeJobId: claimed.jobId,
    });
    expect(store.getSessionQuarantine(options().sessionKey)).not.toBeNull();
    store.close();
  });

  test("持久 metadata 漂移在 resume 前失败关闭，旧 epoch exit 不影响新实例", async () => {
    const directory = await temporaryDirectory("livis-native-coordinator-epoch-");
    cleanups.push(directory.cleanup);
    const store = new JobStore(join(directory.path, "relay.db"), "scope-native");
    const fence = new CodexNativeClientEpochFence();
    const oldClient = new FakeNativeCoordinatorClient();
    const old = await CodexNativeSessionCoordinator.start(options(), {
      store,
      client: oldClient,
      handlers: handlers(store),
      clientEpochFence: fence,
    });
    const newClient = new FakeNativeCoordinatorClient();
    const current = await CodexNativeSessionCoordinator.start(options(), {
      store,
      client: newClient,
      handlers: handlers(store),
      clientEpochFence: fence,
    });
    oldClient.exit.resolve(17);
    await Bun.sleep(5);
    expect(current.ready).toBeTrue();
    expect(store.getSessionQuarantine(options().sessionKey)).toBeNull();

    await current.stop();
    const driftClient = new FakeNativeCoordinatorClient();
    driftClient.turns.length = 0;
    await expect(CodexNativeSessionCoordinator.start(options({
      requestedModel: null,
    }), {
      store,
      client: driftClient,
      handlers: handlers(store),
      clientEpochFence: fence,
    })).rejects.toMatchObject({ code: "native_session_metadata_drift" });
    expect(driftClient.requests).toEqual([]);
    expect(store.getSessionQuarantine(options().sessionKey)).not.toBeNull();
    await old.stop();
    store.close();
  });
});
