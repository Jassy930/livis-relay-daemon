import { describe, expect, test } from "bun:test";
import { chmod, realpath, writeFile } from "node:fs/promises";
import {
  CodexExecutionBackend,
  type CodexCommandRunner,
} from "../src/backends/codex/codex-execution-backend.ts";
import type {
  ExecutionBackendHandlers,
  ExecutionJobEvent,
} from "../src/backends/execution-backend.ts";
import type {
  CodexAppServerProcess,
  CodexAppServerSpawn,
  CodexAppServerSpawnOptions,
} from "../src/backends/codex/app-server-client.ts";
import { ensureCodexRuntimeLayout } from "../src/backends/codex/runtime-layout.ts";
import { serializeResult } from "../src/protocol/livis.ts";
import { JobStore } from "../src/state/store.ts";
import type { StoredJob } from "../src/types.ts";
import { incomingJob, temporaryDirectory } from "./helpers.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`等待 ${label} 超时`);
    await Bun.sleep(2);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class FakeCodexAppServer {
  readonly messages: Array<Record<string, unknown>> = [];
  readonly process: CodexAppServerProcess;
  readonly spawn: CodexAppServerSpawn;
  command: readonly string[] | null = null;
  spawnOptions: CodexAppServerSpawnOptions | null = null;
  workspace = "";
  threadId = "019f-thread-1";
  account: Record<string, unknown> | null = { type: "chatgpt", email: null, planType: "plus" };
  permissionAllowed = true;
  threadReadbackOverride: Record<string, unknown> = {};
  failWriteMethod: string | null = null;
  blockWriteResponseId: number | null = null;
  holdTurnStart = false;
  readonly heldTurnStart = deferred<Record<string, unknown>>();
  readonly heldWrite = deferred<void>();

  private readonly stdout = new TransformStream<Uint8Array, Uint8Array>();
  private readonly stderr = new TransformStream<Uint8Array, Uint8Array>();
  private readonly stdoutWriter = this.stdout.writable.getWriter();
  private readonly stderrWriter = this.stderr.writable.getWriter();
  private readonly exit = deferred<number>();
  private inputBuffer = "";
  private stopped = false;

  constructor() {
    this.process = {
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
              if (message.method === this.failWriteMethod) throw new Error("synthetic write failure");
              this.messages.push(message);
              if (
                message.id === this.blockWriteResponseId &&
                typeof message.method !== "string"
              ) {
                await this.heldWrite.promise;
              }
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
      kill: () => {
        void this.stop(0);
      },
    };
    this.spawn = (command, options) => {
      this.command = command;
      this.spawnOptions = options;
      this.workspace = options.cwd ?? "";
      return this.process;
    };
  }

  async onMessage(message: Record<string, unknown>): Promise<void> {
    if (typeof message.id !== "number" || typeof message.method !== "string") return;
    if (message.method === "initialize") {
      await this.respond(message.id, {});
      return;
    }
    if (message.method === "account/read") {
      await this.respond(message.id, { account: this.account, requiresOpenaiAuth: true });
      return;
    }
    if (message.method === "permissionProfile/list") {
      await this.respond(message.id, {
        data: [{ id: "livis-remote", description: "test", allowed: this.permissionAllowed }],
        nextCursor: null,
      });
      return;
    }
    if (message.method === "thread/start" || message.method === "thread/resume") {
      const response = this.threadResponse();
      await this.respond(message.id, response);
      return;
    }
    if (message.method === "turn/start") {
      if (this.holdTurnStart) {
        void this.heldTurnStart.promise
          .then((response) => this.respond(message.id as number, response))
          .catch(() => undefined);
        return;
      }
      await this.respond(message.id, { turn: { id: "019f-turn-1", status: "inProgress" } });
      return;
    }
    if (message.method === "turn/interrupt" || message.method === "thread/unsubscribe") {
      await this.respond(message.id, {});
      return;
    }
    await this.respond(message.id, {});
  }

  threadResponse(): Record<string, unknown> {
    return {
      thread: { id: this.threadId, cwd: this.workspace },
      cwd: this.workspace,
      runtimeWorkspaceRoots: [this.workspace],
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
      ...this.threadReadbackOverride,
    };
  }

  async respond(id: number, result: unknown): Promise<void> {
    await this.send({ id, result });
  }

  async send(message: Record<string, unknown>): Promise<void> {
    await this.stdoutWriter.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
  }

  async stop(exitCode: number): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await Promise.allSettled([this.stdoutWriter.close(), this.stderrWriter.close()]);
    this.exit.resolve(exitCode);
  }
}

interface Harness {
  directory: Awaited<ReturnType<typeof temporaryDirectory>>;
  store: JobStore;
  fake: FakeCodexAppServer;
  backend: CodexExecutionBackend;
  events: string[];
  results: string[];
  failures: string[];
  disconnects: string[];
  cleanup(): Promise<void>;
}

const successfulVersion: CodexCommandRunner = async () => ({
  exitCode: 0,
  stdout: "codex-cli 0.145.0\n",
  stderr: "",
});

function requireCodexAttempt(event: ExecutionJobEvent & { turnId?: string | null }): {
  runGeneration: number;
  turnId: string;
} {
  if (!event.runGeneration || !event.turnId) throw new Error("test Codex event 缺少 fencing");
  return { runGeneration: event.runGeneration, turnId: event.turnId };
}

async function createHarness(options: {
  start?: boolean;
  requestTimeoutMs?: number;
  configureFake?: (fake: FakeCodexAppServer) => void;
  commandRunner?: CodexCommandRunner;
  existingThreadId?: string;
  maxOutputChars?: number;
  acceptedGate?: Promise<void>;
} = {}): Promise<Harness> {
  const directory = await temporaryDirectory("livis-codex-backend-");
  await chmod(directory.path, 0o700);
  const scopeKey = "scope-test";
  const sessionKey = "livis:agent-test";
  const store = new JobStore(`${directory.path}/relay.db`, scopeKey);
  const fake = new FakeCodexAppServer();
  options.configureFake?.(fake);
  if (options.existingThreadId) {
    const layout = await ensureCodexRuntimeLayout({
      stateDir: directory.path,
      scopeKey,
      sessionKey,
      remoteNodeId: "node-1",
    });
    store.ensureBackendSession({
      backend: "codex",
      sessionKey,
      sessionHash: layout.sessionHash,
      cwd: layout.workspace,
      cliVersion: "0.145.0",
    });
    store.bindBackendThread("codex", sessionKey, options.existingThreadId);
    fake.threadId = options.existingThreadId;
  }
  const events: string[] = [];
  const results: string[] = [];
  const failures: string[] = [];
  const disconnects: string[] = [];

  const handlers: ExecutionBackendHandlers = {
    onReady: async () => {
      events.push("ready");
    },
    onAccepted: async (event) => {
      events.push(`accepted:${event.jobId}`);
      const { runGeneration, turnId } = requireCodexAttempt(event);
      const running = store.markBackendRunning(
        event.jobId,
        "codex",
        event.leaseId,
        runGeneration,
        turnId,
      );
      if (running) {
        await options.acceptedGate;
        return;
      }
      const current = store.get(event.jobId);
      if (current?.status === "Cancelling") {
        store.markBackendCancelUnknown(
          event.jobId,
          "codex",
          event.leaseId,
          runGeneration,
          turnId,
          "test cancel race",
        );
        await options.acceptedGate;
        return;
      }
      throw new Error("test accepted fencing failed");
    },
    onResult: async (event) => {
      events.push(`result:${event.jobId}`);
      results.push(event.text);
      const { runGeneration, turnId } = requireCodexAttempt(event);
      const finished = store.finishBackendSuccess(
        event.jobId,
        "codex",
        event.leaseId,
        runGeneration,
        turnId,
        serializeResult(event.text),
      );
      if (!finished) throw new Error("test result fencing failed");
    },
    onFailed: async (event) => {
      events.push(`failed:${event.jobId}`);
      failures.push(event.error);
      const { runGeneration, turnId } = requireCodexAttempt(event);
      const finished = store.finishBackendFailure(
        event.jobId,
        "codex",
        event.leaseId,
        runGeneration,
        turnId,
        serializeResult("Codex failed"),
        event.error,
      );
      if (!finished) throw new Error("test failure fencing failed");
    },
    onCancelled: async (event) => {
      events.push(`cancelled:${event.jobId}`);
      if (!event.runGeneration) throw new Error("test cancel 缺 runGeneration");
      store.markBackendCancelUnknown(
        event.jobId,
        "codex",
        event.leaseId,
        event.runGeneration,
        event.turnId ?? null,
        "test interrupt accepted",
      );
    },
    onDisconnected: async (event) => {
      events.push("disconnected");
      disconnects.push(event.reason ?? "unknown");
      store.markBackendDisconnected("codex", event.executionId, event.reason ?? "test disconnect");
    },
  };
  const backend = new CodexExecutionBackend({
    stateDir: directory.path,
    scopeKey,
    sessionKey,
    remoteNodeId: "node-1",
    command: "/test/bin/codex",
    model: null,
    maxOutputChars: options.maxOutputChars ?? 1_048_576,
    requestTimeoutMs: options.requestTimeoutMs ?? 100,
    shutdownTimeoutMs: 100,
  }, {
    store,
    handlers,
    appServerSpawn: fake.spawn,
    commandRunner: options.commandRunner ?? successfulVersion,
  });

  if (options.start !== false) {
    await backend.start();
  }

  let cleaned = false;
  return {
    directory,
    store,
    fake,
    backend,
    events,
    results,
    failures,
    disconnects,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await backend.stop().catch(() => undefined);
      store.close();
      await directory.cleanup();
    },
  };
}

function claimJob(harness: Harness, jobId: string, text = "请处理"): StoredJob {
  const ingested = harness.store.ingest(incomingJob(jobId, text), "livis:agent-test");
  harness.store.markAcked(ingested.job.jobId);
  const executionId = harness.backend.executionId;
  if (!executionId) throw new Error("backend 尚未 ready");
  const claimed = harness.store.claimForBackendDispatch(jobId, "codex", executionId, `lease-${jobId}`);
  if (!claimed) throw new Error("test job claim 失败");
  return claimed;
}

describe("CodexExecutionBackend", () => {
  test("固定版本窗口、私有环境、认证/profile 与 thread 安全回读后才 ready", async () => {
    const versionProbes: Array<Parameters<CodexCommandRunner>[1]> = [];
    const harness = await createHarness({
      commandRunner: async (_command, options) => {
        versionProbes.push(options);
        return { exitCode: 0, stdout: "codex-cli 0.145.0", stderr: "" };
      },
    });
    try {
      expect(harness.backend.ready).toBeTrue();
      expect(harness.events).toEqual(["ready"]);
      expect(harness.fake.command).toEqual([
        "/test/bin/codex",
        "app-server",
        "--strict-config",
        "--stdio",
        "--disable",
        "plugins",
        "--disable",
        "remote_plugin",
        "--disable",
        "apps",
      ]);
      const canonicalStateDir = await realpath(harness.directory.path);
      expect(harness.fake.spawnOptions?.env?.CODEX_HOME).toStartWith(canonicalStateDir);
      expect(harness.fake.spawnOptions?.env?.HOME).toStartWith(canonicalStateDir);
      expect(harness.fake.spawnOptions?.env?.OPENAI_API_KEY).toBeUndefined();
      expect(versionProbes[0]?.env.CODEX_HOME).toBe(harness.fake.spawnOptions?.env?.CODEX_HOME);

      const initialize = harness.fake.messages.find((message) => message.method === "initialize");
      expect(initialize).toMatchObject({
        params: {
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
      });
      expect(harness.fake.messages.find((message) => message.method === "account/read")?.params)
        .toEqual({ refreshToken: false });
      const threadStart = harness.fake.messages.find((message) => message.method === "thread/start");
      expect(threadStart?.params).toMatchObject({
        cwd: harness.fake.workspace,
        runtimeWorkspaceRoots: [harness.fake.workspace],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        permissions: "livis-remote",
        environments: [],
        ephemeral: false,
      });
      const stored = harness.store.getBackendSession("codex", "livis:agent-test");
      expect(stored?.threadId).toBe(harness.fake.threadId);
      expect(stored?.cwd).toBe(harness.fake.workspace);
      expect(stored?.cliVersion).toBe("0.145.0");
    } finally {
      await harness.cleanup();
    }
  });

  test("拒绝窗口外版本且不会启动 app-server", async () => {
    const harness = await createHarness({
      start: false,
      commandRunner: async () => ({ exitCode: 0, stdout: "codex-cli 0.146.0", stderr: "" }),
    });
    try {
      await expect(harness.backend.start()).rejects.toThrow("不在已审核窗口");
      expect(harness.fake.command).toBeNull();
      expect(harness.backend.ready).toBeFalse();
    } finally {
      await harness.cleanup();
    }
  });

  test("已有 SQLite thread 只允许按原 id resume 并重新施加安全参数", async () => {
    const harness = await createHarness({ existingThreadId: "019f-existing-thread" });
    try {
      expect(harness.fake.messages.some((message) => message.method === "thread/start")).toBeFalse();
      const resume = harness.fake.messages.find((message) => message.method === "thread/resume");
      expect(resume?.params).toMatchObject({
        threadId: "019f-existing-thread",
        cwd: harness.fake.workspace,
        runtimeWorkspaceRoots: [harness.fake.workspace],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        permissions: "livis-remote",
      });
      expect((resume?.params as Record<string, unknown>).environments).toBeUndefined();
      expect(harness.backend.executionId).toBe("codex:019f-existing-thread");
    } finally {
      await harness.cleanup();
    }
  });

  test("私有 CODEX_HOME 未登录时 fail-closed，不创建 thread", async () => {
    const harness = await createHarness({
      start: false,
      configureFake: (fake) => {
        fake.account = null;
      },
    });
    try {
      await expect(harness.backend.start()).rejects.toThrow(
        "Codex 私有 CODEX_HOME account 必须是对象",
      );
      expect(harness.fake.messages.some((message) => message.method === "thread/start")).toBeFalse();
    } finally {
      await harness.cleanup();
    }
  });

  test("thread 安全回读漂移会 quarantine session", async () => {
    const harness = await createHarness({
      start: false,
      configureFake: (fake) => {
        fake.threadReadbackOverride = {
          sandbox: {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: true,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          },
        };
      },
    });
    try {
      await expect(harness.backend.start()).rejects.toThrow("sandbox 回读未满足");
      expect(harness.store.getSessionQuarantine("livis:agent-test")?.reason).toContain("安全回读");
    } finally {
      await harness.cleanup();
    }
  });

  test("thread 安全回读拒绝 runtime workspace 之外的额外 writable root", async () => {
    const harness = await createHarness({
      start: false,
      configureFake: (fake) => {
        fake.threadReadbackOverride = {
          sandbox: {
            type: "workspaceWrite",
            writableRoots: [`${fake.workspace}-extra`],
            networkAccess: false,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          },
        };
      },
    });
    try {
      await expect(harness.backend.start()).rejects.toThrow("额外 writable root");
      expect(harness.store.getSessionQuarantine("livis:agent-test")?.reason).toContain("安全回读");
    } finally {
      await harness.cleanup();
    }
  });

  test("accepted 先持久化，terminal 后只返回 final_answer agent message", async () => {
    const harness = await createHarness();
    try {
      const job = claimJob(harness, "job-final", "执行任务");
      expect(await harness.backend.dispatch(job)).toBe("submitted");
      expect(harness.store.require(job.jobId).status).toBe("Running");
      expect(harness.fake.messages.find((message) => message.method === "turn/start")?.params)
        .toMatchObject({
          cwd: harness.fake.workspace,
          runtimeWorkspaceRoots: [harness.fake.workspace],
          approvalPolicy: "never",
          approvalsReviewer: "user",
          permissions: "livis-remote",
          environments: [],
        });

      await harness.fake.send({
        method: "item/completed",
        params: {
          threadId: harness.fake.threadId,
          turnId: "019f-turn-1",
          item: { type: "agentMessage", id: "m1", text: "中间说明", phase: "commentary" },
        },
      });
      await harness.fake.send({
        method: "item/completed",
        params: {
          threadId: harness.fake.threadId,
          turnId: "019f-turn-1",
          item: { type: "reasoning", id: "secret", summary: ["不要返回"] },
        },
      });
      await harness.fake.send({
        method: "item/completed",
        params: {
          threadId: harness.fake.threadId,
          turnId: "019f-turn-1",
          item: { type: "agentMessage", id: "m2", text: "最终答案", phase: "final_answer" },
        },
      });
      await harness.fake.send({
        method: "item/completed",
        params: {
          threadId: harness.fake.threadId,
          turnId: "019f-turn-1",
          item: { type: "agentMessage", id: "m3", text: "尾部 commentary", phase: "commentary" },
        },
      });
      await harness.fake.send({
        method: "turn/completed",
        params: {
          threadId: harness.fake.threadId,
          turn: { id: "019f-turn-1", status: "completed", items: [] },
        },
      });

      await waitFor(() => harness.store.require(job.jobId).status === "Succeeded", "Codex terminal");
      expect(harness.results).toEqual(["最终答案"]);
      expect(harness.events).toEqual(["ready", "accepted:job-final", "result:job-final"]);
      expect(harness.backend.status().active).toBeNull();
      expect(harness.store.require(job.jobId).outbox?.resultJson).toBe(serializeResult("最终答案"));
    } finally {
      await harness.cleanup();
    }
  });

  test("item/completed 缺失时从 terminal turn.items 提取并兼容最后一条 phase=null agentMessage", async () => {
    const harness = await createHarness();
    try {
      const job = claimJob(harness, "job-fallback");
      await harness.backend.dispatch(job);
      await harness.fake.send({
        method: "turn/completed",
        params: {
          threadId: harness.fake.threadId,
          turn: {
            id: "019f-turn-1",
            status: "completed",
            items: [
              { type: "reasoning", id: "r1", summary: ["不返回"] },
              { type: "agentMessage", id: "m1", text: "第一条", phase: null },
              { type: "commandExecution", id: "c1", aggregatedOutput: "不返回" },
              { type: "agentMessage", id: "m2", text: "第二条", phase: null },
            ],
          },
        },
      });
      await waitFor(() => harness.results.length === 1, "fallback final");
      expect(harness.results).toEqual(["第二条"]);
    } finally {
      await harness.cleanup();
    }
  });

  test("turn/start 前安全校验失败返回 not_sent；已写入超时则断连并 quarantine", async () => {
    const unwritten = await createHarness();
    try {
      const job = claimJob(unwritten, "job-unwritten");
      const configPath = `${unwritten.fake.spawnOptions?.env?.CODEX_HOME}/config.toml`;
      await writeFile(configPath, "approval_policy = \"never\"\n", { mode: 0o600 });
      const turnStartsBefore = unwritten.fake.messages
        .filter((message) => message.method === "turn/start").length;
      expect(await unwritten.backend.dispatch(job)).toBe("not_sent");
      expect(unwritten.disconnects).toEqual([]);
      expect(unwritten.backend.ready).toBeFalse();
      expect(unwritten.fake.messages.filter((message) => message.method === "turn/start"))
        .toHaveLength(turnStartsBefore);
      expect(unwritten.store.resetUnsentBackendDispatch(
        job.jobId,
        "codex",
        job.leaseId!,
        job.runGeneration,
      )).toBeTrue();
    } finally {
      await unwritten.cleanup();
    }

    const ambiguous = await createHarness({
      requestTimeoutMs: 20,
      configureFake: (fake) => {
        fake.holdTurnStart = true;
      },
    });
    try {
      const job = claimJob(ambiguous, "job-ambiguous");
      expect(await ambiguous.backend.dispatch(job)).toBe("submitted");
      await waitFor(() => ambiguous.disconnects.length === 1, "ambiguous disconnect");
      expect(ambiguous.store.require(job.jobId).status).toBe("Interrupted");
      expect(ambiguous.store.getBackendSession("codex", "livis:agent-test")?.recoveryRequired)
        .toBeTrue();
      expect(ambiguous.store.getSessionQuarantine("livis:agent-test")).not.toBeNull();
    } finally {
      ambiguous.fake.heldTurnStart.resolve({ turn: { id: "late-turn" } });
      await ambiguous.cleanup();
    }
  });

  test("cancel 可早于 turn/start response，绑定后自行 interrupt 且不返回 final", async () => {
    const harness = await createHarness({
      configureFake: (fake) => {
        fake.holdTurnStart = true;
      },
      requestTimeoutMs: 200,
    });
    try {
      const claimed = claimJob(harness, "job-cancel-race");
      const dispatch = harness.backend.dispatch(claimed);
      await waitFor(
        () => harness.fake.messages.some((message) => message.method === "turn/start"),
        "turn/start request",
      );
      const cancelling = harness.store.requestCancel(claimed.jobId);
      if (!cancelling) throw new Error("test cancel job missing");
      const cancel = harness.backend.cancel(cancelling);
      harness.fake.heldTurnStart.resolve({ turn: { id: "019f-turn-1", status: "inProgress" } });
      expect(await dispatch).toBe("submitted");
      expect(await cancel).toBe("submitted");
      expect(harness.fake.messages.some((message) => message.method === "turn/interrupt")).toBeTrue();
      expect(harness.store.require(claimed.jobId).status).toBe("CancelUnknown");

      await waitFor(() => harness.events.includes("cancelled:job-cancel-race"), "cancel terminal");
      expect(harness.results).toEqual([]);
      expect(harness.backend.ready).toBeFalse();
    } finally {
      await harness.cleanup();
    }
  });

  test("原 turn 已提交后即使 interrupt 可证明未写入也必须 CancelUnknown", async () => {
    const harness = await createHarness({ requestTimeoutMs: 20 });
    try {
      const job = claimJob(harness, "job-interrupt-unwritten");
      await harness.backend.dispatch(job);
      expect(harness.store.require(job.jobId).status).toBe("Running");

      harness.fake.blockWriteResponseId = 999;
      const approval = harness.fake.send({
        id: 999,
        method: "item/permissions/requestApproval",
        params: { permissions: { network: ["example.com"] } },
      }).catch(() => undefined);
      await waitFor(
        () => harness.fake.messages.some(
          (message) => message.id === 999 && typeof message.method !== "string",
        ),
        "阻塞 approval response write",
      );

      const cancelling = harness.store.requestCancel(job.jobId);
      if (!cancelling) throw new Error("test cancel job missing");
      const cancel = harness.backend.cancel(cancelling);
      await waitFor(() => harness.disconnects.length === 1, "interrupt unwritten disconnect");
      harness.fake.heldWrite.resolve();
      expect(await cancel).toBe("submitted");
      await approval;

      expect(harness.fake.messages.some((message) => message.method === "turn/interrupt")).toBeFalse();
      expect(harness.store.require(job.jobId).status).toBe("CancelUnknown");
      expect(harness.store.getBackendSession("codex", "livis:agent-test")?.recoveryRequired)
        .toBeTrue();
    } finally {
      harness.fake.heldWrite.resolve();
      await harness.cleanup();
    }
  });

  test("活动 turn 中 app-server 退出会断连、Interrupted 并保留 recovery evidence", async () => {
    const harness = await createHarness();
    try {
      const job = claimJob(harness, "job-exit");
      await harness.backend.dispatch(job);
      await harness.fake.stop(23);
      await waitFor(() => harness.disconnects.length === 1, "process exit disconnect");
      expect(harness.store.require(job.jobId).status).toBe("Interrupted");
      const session = harness.store.getBackendSession("codex", "livis:agent-test");
      expect(session?.activeTurnId).toBe("019f-turn-1");
      expect(session?.recoveryRequired).toBeTrue();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal failed 只通过 failed handler 结算，不把中间消息当结果", async () => {
    const harness = await createHarness();
    try {
      const job = claimJob(harness, "job-failed");
      await harness.backend.dispatch(job);
      await harness.fake.send({
        method: "item/completed",
        params: {
          threadId: harness.fake.threadId,
          turnId: "019f-turn-1",
          item: { type: "agentMessage", id: "m1", text: "未完成内容", phase: "commentary" },
        },
      });
      await harness.fake.send({
        method: "turn/completed",
        params: {
          threadId: harness.fake.threadId,
          turn: {
            id: "019f-turn-1",
            status: "failed",
            error: { message: "synthetic model failure" },
            items: [],
          },
        },
      });
      await waitFor(() => harness.store.require(job.jobId).status === "Failed", "failed terminal");
      expect(harness.failures).toEqual(["synthetic model failure"]);
      expect(harness.results).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal 只有 commentary 时拒绝伪装成 final 并 fail-closed", async () => {
    const harness = await createHarness();
    try {
      const job = claimJob(harness, "job-commentary-only");
      await harness.backend.dispatch(job);
      await harness.fake.send({
        method: "turn/completed",
        params: {
          threadId: harness.fake.threadId,
          turn: {
            id: "019f-turn-1",
            status: "completed",
            items: [
              {
                type: "agentMessage",
                id: "m-commentary",
                text: "这只是中间进度",
                phase: "commentary",
              },
            ],
          },
        },
      });
      await waitFor(() => harness.disconnects.length === 1, "commentary-only disconnect");
      expect(harness.results).toEqual([]);
      expect(harness.store.require(job.jobId).status).toBe("Interrupted");
    } finally {
      await harness.cleanup();
    }
  });

  test("未知 agentMessage phase 使活动 attempt fail-closed", async () => {
    const harness = await createHarness();
    try {
      const job = claimJob(harness, "job-bad-event");
      await harness.backend.dispatch(job);
      await harness.fake.send({
        method: "item/completed",
        params: {
          threadId: harness.fake.threadId,
          turnId: "019f-turn-1",
          item: { type: "agentMessage", id: "m1", text: "未知", phase: "new-phase" },
        },
      });
      await waitFor(() => harness.disconnects.length === 1, "bad event disconnect");
      expect(harness.store.require(job.jobId).status).toBe("Interrupted");
      expect(harness.store.getBackendSession("codex", "livis:agent-test")?.recoveryRequired)
        .toBeTrue();
    } finally {
      await harness.cleanup();
    }
  });

  test("累计 agentMessage 超过 attempt 字符预算时 fail-closed", async () => {
    const harness = await createHarness({ maxOutputChars: 4 });
    try {
      const job = claimJob(harness, "job-message-budget");
      await harness.backend.dispatch(job);
      for (const [id, text] of [
        ["m1", "1234567890"],
        ["m2", "abcdefghij"],
      ]) {
        await harness.fake.send({
          method: "item/completed",
          params: {
            threadId: harness.fake.threadId,
            turnId: "019f-turn-1",
            item: { type: "agentMessage", id, text, phase: null },
          },
        });
      }
      await waitFor(() => harness.disconnects.length === 1, "message budget disconnect");
      expect(harness.results).toEqual([]);
      expect(harness.store.require(job.jobId).status).toBe("Interrupted");
    } finally {
      await harness.cleanup();
    }
  });

  test("agentMessage 标识长度与累计标识预算均有界", async () => {
    const oversized = await createHarness();
    try {
      const job = claimJob(oversized, "job-message-id-too-long");
      await oversized.backend.dispatch(job);
      await oversized.fake.send({
        method: "item/completed",
        params: {
          threadId: oversized.fake.threadId,
          turnId: "019f-turn-1",
          item: { type: "agentMessage", id: "x".repeat(257), text: "", phase: null },
        },
      });
      await waitFor(() => oversized.disconnects.length === 1, "oversized message id disconnect");
      expect(oversized.store.require(job.jobId).status).toBe("Interrupted");
    } finally {
      await oversized.cleanup();
    }

    const cumulative = await createHarness({ maxOutputChars: 4 });
    try {
      const job = claimJob(cumulative, "job-message-id-budget");
      await cumulative.backend.dispatch(job);
      for (const id of ["123456789", "abcdefghi"]) {
        await cumulative.fake.send({
          method: "item/completed",
          params: {
            threadId: cumulative.fake.threadId,
            turnId: "019f-turn-1",
            item: { type: "agentMessage", id, text: "", phase: null },
          },
        });
      }
      await waitFor(() => cumulative.disconnects.length === 1, "message id budget disconnect");
      expect(cumulative.store.require(job.jobId).status).toBe("Interrupted");
    } finally {
      await cumulative.cleanup();
    }
  });

  test("turnId 已知后的 notification backlog admission 有界", async () => {
    const acceptedGate = deferred<void>();
    const harness = await createHarness({ acceptedGate: acceptedGate.promise });
    try {
      const job = claimJob(harness, "job-notification-backlog");
      const dispatch = harness.backend.dispatch(job);
      await waitFor(() => harness.store.require(job.jobId).status === "Running", "accepted gate");
      for (let index = 0; index < 257; index += 1) {
        await harness.fake.send({
          method: "error",
          params: {
            threadId: harness.fake.threadId,
            turnId: "019f-turn-1",
            error: { message: `synthetic-${index}` },
            willRetry: true,
          },
        }).catch(() => undefined);
      }
      await waitFor(() => harness.disconnects.length === 1, "notification backlog disconnect");
      acceptedGate.resolve();
      expect(await dispatch).toBe("submitted");
      expect(harness.store.require(job.jobId).status).toBe("Interrupted");
    } finally {
      acceptedGate.resolve();
      await harness.cleanup();
    }
  });

  test("idle app-server 退出会撤销 ready，但不会凭空 quarantine session", async () => {
    const harness = await createHarness();
    try {
      await harness.fake.stop(17);
      await waitFor(() => harness.disconnects.length === 1, "idle process exit");
      expect(harness.backend.ready).toBeFalse();
      expect(harness.store.getSessionQuarantine("livis:agent-test")).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  test("stop 在活动 turn 上有界收口并持久化 Interrupted", async () => {
    const harness = await createHarness();
    try {
      const job = claimJob(harness, "job-stop");
      await harness.backend.dispatch(job);
      await Promise.race([
        harness.backend.stop(),
        Bun.sleep(500).then(() => {
          throw new Error("backend.stop deadlock");
        }),
      ]);
      expect(harness.store.require(job.jobId).status).toBe("Interrupted");
      expect(harness.backend.ready).toBeFalse();
    } finally {
      await harness.cleanup();
    }
  });
});
