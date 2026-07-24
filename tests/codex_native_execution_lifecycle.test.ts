import { describe, expect, test } from "bun:test";
import {
  CodexAppServerClient,
  CodexAppServerTimeoutError,
  type CodexAppServerNotification,
  type CodexAppServerProcess,
  type CodexAppServerSpawn,
  type CodexAppServerSpawnOptions,
} from "../src/backends/codex/app-server-client.ts";
import {
  CodexNativeClientEpochFence,
  type CodexNativeClientEpochReceipt,
} from "../src/backends/codex/native-client-epoch.ts";
import {
  CodexNativeExecutionLifecycle,
  type CodexNativeExecutionClient,
} from "../src/backends/codex/native-execution-lifecycle.ts";
import type {
  ExecutionBackendHandlers,
  ExecutionFailedEvent,
} from "../src/backends/execution-backend.ts";
import type { StoredJob } from "../src/types.ts";

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

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`等待 ${label} 超时`);
    await Bun.sleep(2);
  }
}

function job(jobId = "native-job-1"): StoredJob {
  return {
    jobId,
    messageId: `message-${jobId}`,
    fromNodeId: "node-1",
    fromNodeType: "phone",
    text: "请给出最终答案",
    timestamp: 1_700_000_000_000,
    rawPayload: "{}",
    scopeKey: "scope-native",
    payloadHash: "a".repeat(64),
    targetBackend: "codex",
    status: "Dispatching",
    sessionKey: "livis:native-session",
    connectorId: "native-execution-1",
    leaseId: `lease-${jobId}`,
    runGeneration: 1,
    error: null,
    cancelRequested: false,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    outbox: null,
  };
}

class FakeNativeProxy {
  readonly messages: Array<Record<string, unknown>> = [];
  readonly spawn: CodexAppServerSpawn;
  readonly process: CodexAppServerProcess;
  readonly proxyKillSignals: Array<number | NodeJS.Signals | undefined> = [];
  spawnOptions: CodexAppServerSpawnOptions | null = null;
  nativeDaemonRunning = true;
  nativeDaemonStopCalls = 0;
  holdTurnStart = false;
  sendCompletedAfterStart = false;
  sendBackendFailureAfterStart = false;
  sendInterruptedAfterCancel = false;

  private readonly stdout = new TransformStream<Uint8Array, Uint8Array>();
  private readonly stderr = new TransformStream<Uint8Array, Uint8Array>();
  private readonly stdoutWriter = this.stdout.writable.getWriter();
  private readonly stderrWriter = this.stderr.writable.getWriter();
  private readonly exit = deferred<number>();
  private inputBuffer = "";
  private stopped = false;

  constructor() {
    this.process = {
      pid: 51_001,
      stdin: {
        write: async (chunk) => {
          const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
          this.inputBuffer += new TextDecoder().decode(bytes);
          let newline = this.inputBuffer.indexOf("\n");
          while (newline >= 0) {
            const line = this.inputBuffer.slice(0, newline);
            this.inputBuffer = this.inputBuffer.slice(newline + 1);
            if (line.trim()) {
              const message = JSON.parse(line) as Record<string, unknown>;
              this.messages.push(message);
              await this.onMessage(message);
            }
            newline = this.inputBuffer.indexOf("\n");
          }
          return bytes.byteLength;
        },
        flush: () => 0,
        end: () => 0,
      },
      stdout: this.stdout.readable,
      stderr: this.stderr.readable,
      exited: this.exit.promise,
      kill: (signal) => {
        this.proxyKillSignals.push(signal);
        void this.stopProxy(0);
      },
    };
    this.spawn = (_command, options) => {
      this.spawnOptions = options;
      return this.process;
    };
  }

  private async onMessage(message: Record<string, unknown>): Promise<void> {
    if (typeof message.id !== "number" || typeof message.method !== "string") return;
    if (message.method === "initialize") {
      await this.respond(message.id, {
        userAgent: "fake-native-proxy/0.145.0",
        codexHome: "/Users/test/.codex",
        platformFamily: "unix",
        platformOs: "test",
      });
      return;
    }
    if (message.method === "turn/start") {
      if (this.holdTurnStart) return;
      await this.respond(message.id, { turn: { id: "native-turn-1", status: "inProgress" } });
      if (this.sendCompletedAfterStart) await this.sendCompleted();
      if (this.sendBackendFailureAfterStart) await this.sendBackendFailure();
      return;
    }
    if (message.method === "turn/interrupt") {
      await this.respond(message.id, {});
      if (this.sendInterruptedAfterCancel) {
        await this.send({
          method: "turn/completed",
          params: {
            threadId: "native-thread-1",
            turn: { id: "native-turn-1", status: "interrupted", items: [] },
          },
        });
      }
      return;
    }
    await this.respond(message.id, {});
  }

  async sendCompleted(): Promise<void> {
    const item = {
      id: "final-message-1",
      type: "agentMessage",
      phase: "final_answer",
      text: "这是唯一 final",
    };
    await this.send({
      method: "item/completed",
      params: { threadId: "native-thread-1", turnId: "native-turn-1", item },
    });
    const terminal = {
      method: "turn/completed",
      params: {
        threadId: "native-thread-1",
        turn: { id: "native-turn-1", status: "completed", items: [item] },
      },
    };
    await this.send(terminal);
    await this.send(terminal);
  }

  async sendBackendFailure(): Promise<void> {
    await this.send({
      method: "turn/completed",
      params: {
        threadId: "native-thread-1",
        turn: {
          id: "native-turn-1",
          status: "failed",
          items: [],
          error: {
            codexErrorInfo: "unauthorized",
            message: "SENSITIVE_PROVIDER_DETAIL",
          },
        },
      },
    });
  }

  async exitProxy(exitCode: number): Promise<void> {
    await this.stopProxy(exitCode);
  }

  async stopProxy(exitCode: number): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await Promise.allSettled([this.stdoutWriter.close(), this.stderrWriter.close()]);
    this.exit.resolve(exitCode);
  }

  private async respond(id: number, result: unknown): Promise<void> {
    await this.send({ id, result });
  }

  private async send(message: Record<string, unknown>): Promise<void> {
    await this.stdoutWriter.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
  }
}

interface Harness {
  fake: FakeNativeProxy;
  client: CodexNativeExecutionClient;
  clientEpochFence: CodexNativeClientEpochFence;
  clientEpochReceipt: CodexNativeClientEpochReceipt;
  lifecycle: CodexNativeExecutionLifecycle;
  events: string[];
  results: string[];
  failures: ExecutionFailedEvent[];
  disconnects: string[];
  cancelled: string[];
  quarantines: string[];
  acceptedGate: Deferred<void> | null;
  cleanup(): Promise<void>;
}

async function createHarness(options: {
  fake?: FakeNativeProxy;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  gateAccepted?: boolean;
  clientEpochFence?: CodexNativeClientEpochFence;
} = {}): Promise<Harness> {
  const fake = options.fake ?? new FakeNativeProxy();
  const events: string[] = [];
  const results: string[] = [];
  const failures: ExecutionFailedEvent[] = [];
  const disconnects: string[] = [];
  const cancelled: string[] = [];
  const quarantines: string[] = [];
  const acceptedGate = options.gateAccepted ? deferred<void>() : null;
  const handlers: ExecutionBackendHandlers = {
    onReady: async () => undefined,
    onAccepted: async (event) => {
      events.push("accepted:begin");
      await acceptedGate?.promise;
      events.push(`accepted:end:${event.turnId}`);
    },
    onResult: async (event) => {
      events.push("result");
      results.push(event.text);
    },
    onFailed: async (event) => {
      events.push("failed");
      failures.push(event);
    },
    onCancelled: async (event) => {
      events.push("cancelled");
      cancelled.push(event.turnId ?? "missing");
    },
    onDisconnected: async (event) => {
      events.push("disconnected");
      disconnects.push(event.reason ?? "missing");
    },
  };

  let lifecycle: CodexNativeExecutionLifecycle | null = null;
  const pendingNotifications: CodexAppServerNotification[] = [];
  const client = await CodexAppServerClient.start({
    command: ["/test/codex", "app-server", "proxy", "--sock", "/test/native.sock"],
    cwd: "/test/native-workspace",
    env: { LANG: "zh_CN.UTF-8" },
    spawn: fake.spawn,
    requestTimeoutMs: options.requestTimeoutMs ?? 50,
    closeTimeoutMs: 50,
    onNotification: (notification) => {
      if (lifecycle) lifecycle.handleNotification(notification);
      else pendingNotifications.push(notification);
    },
  });
  const clientEpochFence = options.clientEpochFence ?? new CodexNativeClientEpochFence();
  const clientEpochReceipt = clientEpochFence.attach(client);
  lifecycle = new CodexNativeExecutionLifecycle({
    executionId: "native-execution-1",
    threadId: "native-thread-1",
    workspace: "/test/native-workspace",
    requestTimeoutMs: options.requestTimeoutMs ?? 50,
    turnTimeoutMs: options.turnTimeoutMs ?? 500,
    maxOutputChars: 4_096,
  }, {
    client,
    handlers,
    clientEpochFence,
    clientEpochReceipt,
    onSessionQuarantine: async (code) => {
      quarantines.push(code);
    },
  });
  for (const notification of pendingNotifications) lifecycle.handleNotification(notification);

  return {
    fake,
    client,
    clientEpochFence,
    clientEpochReceipt,
    lifecycle,
    events,
    results,
    failures,
    disconnects,
    cancelled,
    quarantines,
    acceptedGate,
    cleanup: () => lifecycle!.stop().catch(() => undefined),
  };
}

describe("Codex native proxy 离线执行生命周期", () => {
  test("accepted 持久化完成后才交付唯一 final，重复 terminal 不会重复结算", async () => {
    const fake = new FakeNativeProxy();
    fake.sendCompletedAfterStart = true;
    const harness = await createHarness({ fake, gateAccepted: true });
    try {
      expect(harness.lifecycle.status()).toMatchObject({
        implementation: "codex-native-execution-lifecycle-prototype",
        productionReady: false,
      });
      const dispatch = harness.lifecycle.dispatch(job());
      await waitFor(() => harness.events.includes("accepted:begin"), "accepted handler 进入");
      expect(harness.results).toEqual([]);
      harness.acceptedGate!.resolve();
      expect(await dispatch).toBe("submitted");
      await waitFor(() => harness.results.length === 1, "唯一 final");
      await harness.lifecycle.waitForIdle();
      expect(harness.events).toEqual([
        "accepted:begin",
        "accepted:end:native-turn-1",
        "result",
      ]);
      expect(harness.results).toEqual(["这是唯一 final"]);
      expect(harness.disconnects).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  test("turn/start 已写入后超时必须返回 submitted 并进入 ambiguous disconnect", async () => {
    const fake = new FakeNativeProxy();
    fake.holdTurnStart = true;
    const harness = await createHarness({ fake, requestTimeoutMs: 15 });
    try {
      expect(await harness.lifecycle.dispatch(job("ambiguous-start"))).toBe("submitted");
      await waitFor(() => harness.disconnects.length === 1, "ambiguous disconnect");
      expect(harness.events).toEqual(["disconnected"]);
      expect(fake.messages.some((message) => message.method === "turn/start")).toBeTrue();
      expect(harness.disconnects[0]).toContain("提交状态不确定");
    } finally {
      await harness.cleanup();
    }
  });

  test("可证明 turn/start 未写入时返回 not_sent 且不伪造 disconnect", async () => {
    const neverExit = new Promise<number>(() => undefined);
    let closed = false;
    const client: CodexNativeExecutionClient = {
      running: true,
      exited: neverExit,
      request: async <T = unknown>(): Promise<T> => {
        throw new CodexAppServerTimeoutError("turn/start", 1, 10, false);
      },
      close: async () => {
        closed = true;
      },
    };
    const clientEpochFence = new CodexNativeClientEpochFence();
    const clientEpochReceipt = clientEpochFence.attach(client);
    const disconnects: string[] = [];
    const handlers: ExecutionBackendHandlers = {
      onReady: async () => undefined,
      onAccepted: async () => undefined,
      onResult: async () => undefined,
      onFailed: async () => undefined,
      onCancelled: async () => undefined,
      onDisconnected: async (event) => {
        disconnects.push(event.reason ?? "missing");
      },
    };
    const lifecycle = new CodexNativeExecutionLifecycle({
      executionId: "native-unwritten",
      threadId: "native-thread-1",
      workspace: "/test/native-workspace",
      requestTimeoutMs: 10,
      turnTimeoutMs: 100,
      maxOutputChars: 1_024,
    }, {
      client,
      handlers,
      clientEpochFence,
      clientEpochReceipt,
      onSessionQuarantine: async () => undefined,
    });

    expect(await lifecycle.dispatch(job("unwritten"))).toBe("not_sent");
    expect(disconnects).toEqual([]);
    expect(lifecycle.status()).toMatchObject({ state: "running", active: false });
    await lifecycle.stop();
    expect(closed).toBeTrue();
  });

  test("本地后端错误按普通 failed 结算，不识别账号状态或隔离 session", async () => {
    const fake = new FakeNativeProxy();
    fake.sendBackendFailureAfterStart = true;
    const harness = await createHarness({ fake });
    try {
      expect(await harness.lifecycle.dispatch(job("local-backend-error"))).toBe("submitted");
      await waitFor(() => harness.failures.length === 1, "backend failed event");
      expect(harness.failures[0]?.sessionDisposition).toBeUndefined();
      expect(harness.failures[0]?.error).toBe("Codex native backend 执行失败");
      expect(JSON.stringify(harness.failures)).not.toContain("SENSITIVE_PROVIDER_DETAIL");
      expect(harness.quarantines).toEqual([]);
      expect(harness.disconnects).toEqual([]);
      expect(harness.lifecycle.ready).toBeTrue();

      fake.sendBackendFailureAfterStart = false;
      fake.sendCompletedAfterStart = true;
      expect(await harness.lifecycle.dispatch(job("after-local-state-change"))).toBe("submitted");
      await waitFor(() => harness.results.length === 1, "后续 job final");
      expect(harness.results).toEqual(["这是唯一 final"]);
    } finally {
      await harness.cleanup();
    }
  });

  test("权威 interrupted terminal 在本地 cancel 后只结算一次 cancelled", async () => {
    const fake = new FakeNativeProxy();
    fake.sendInterruptedAfterCancel = true;
    const harness = await createHarness({ fake });
    const current = job("cancelled");
    try {
      expect(await harness.lifecycle.dispatch(current)).toBe("submitted");
      expect(await harness.lifecycle.cancel(current)).toBe("submitted");
      await waitFor(() => harness.cancelled.length === 1, "cancelled event");
      expect(harness.cancelled).toEqual(["native-turn-1"]);
      expect(harness.disconnects).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  test("accepted 后 terminal 超时只做一次 interrupt 并按 ambiguous disconnect 收口", async () => {
    const harness = await createHarness({ turnTimeoutMs: 20 });
    try {
      expect(await harness.lifecycle.dispatch(job("terminal-timeout"))).toBe("submitted");
      await waitFor(() => harness.disconnects.length === 1, "terminal timeout disconnect");
      expect(harness.fake.messages.filter((message) => message.method === "turn/interrupt"))
        .toHaveLength(1);
      expect(harness.results).toEqual([]);
      expect(harness.failures).toEqual([]);
      expect(harness.cancelled).toEqual([]);
      expect(harness.disconnects[0]).toContain("执行结果不确定");
    } finally {
      await harness.cleanup();
    }
  });

  test("proxy 退出或本地 stop 只关闭 relay attach，不管理原生 daemon", async () => {
    const first = await createHarness();
    try {
      await first.fake.exitProxy(17);
      await waitFor(() => first.disconnects.length === 1, "proxy exit disconnect");
      expect(first.fake.nativeDaemonRunning).toBeTrue();
      expect(first.fake.nativeDaemonStopCalls).toBe(0);
    } finally {
      await first.cleanup();
    }

    const second = await createHarness();
    await second.lifecycle.stop();
    expect(second.fake.proxyKillSignals).toEqual(["SIGTERM"]);
    expect(second.fake.nativeDaemonRunning).toBeTrue();
    expect(second.fake.nativeDaemonStopCalls).toBe(0);
    expect(second.disconnects).toEqual([]);
  });

  test("旧 client epoch 的迟到 terminal、exit 和 timeout 不会影响新 epoch", async () => {
    const clientEpochFence = new CodexNativeClientEpochFence();
    const old = await createHarness({ clientEpochFence, turnTimeoutMs: 25 });
    expect(await old.lifecycle.dispatch(job("old-epoch"))).toBe("submitted");

    const currentFake = new FakeNativeProxy();
    currentFake.sendCompletedAfterStart = true;
    const current = await createHarness({ fake: currentFake, clientEpochFence });
    try {
      expect(old.clientEpochReceipt.clientEpoch).toBe(1);
      expect(current.clientEpochReceipt.clientEpoch).toBe(2);
      expect(old.lifecycle.ready).toBeFalse();

      await old.fake.sendCompleted();
      await old.fake.exitProxy(19);
      await Bun.sleep(35);
      expect(old.results).toEqual([]);
      expect(old.failures).toEqual([]);
      expect(old.cancelled).toEqual([]);
      expect(old.disconnects).toEqual([]);
      expect(old.fake.messages.filter((message) => message.method === "turn/interrupt"))
        .toHaveLength(0);

      expect(await current.lifecycle.dispatch(job("current-epoch"))).toBe("submitted");
      await waitFor(() => current.results.length === 1, "新 epoch final");
      expect(current.results).toEqual(["这是唯一 final"]);
      expect(current.disconnects).toEqual([]);
    } finally {
      await old.cleanup();
      await current.cleanup();
    }
  });
});
