import { describe, expect, test } from "bun:test";
import { chmod, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CodexExecutionBackend,
  type CodexCommandRunner,
  validateDisabledCodexFeatures,
} from "../src/backends/codex/codex-execution-backend.ts";
import type {
  ExecutionBackendHandlers,
  ExecutionJobEvent,
} from "../src/backends/execution-backend.ts";
import {
  CODEX_0145_ALLOWED_ENABLED_FEATURES,
  CODEX_DISABLED_FEATURES,
  type CodexAppServerProcess,
  type CodexAppServerSpawn,
  type CodexAppServerSpawnOptions,
} from "../src/backends/codex/app-server-client.ts";
import {
  codexRemoteConfig,
  ensureCodexRuntimeLayout,
} from "../src/backends/codex/runtime-layout.ts";
import { runCodexAppServerLocalSmoke } from "../src/backends/codex/local-smoke.ts";
import { serializeResult } from "../src/protocol/livis.ts";
import { JobStore } from "../src/state/store.ts";
import type { StoredJob } from "../src/types.ts";
import { sha256 } from "../src/util.ts";
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

interface FakeCodexFeature {
  name: string;
  stage: string;
  enabled: boolean;
  defaultEnabled: boolean;
}

function codex0145FeatureSnapshot(): FakeCodexFeature[] {
  const features = new Map<string, FakeCodexFeature>();
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

class FakeCodexAppServer {
  readonly messages: Array<Record<string, unknown>> = [];
  readonly process: CodexAppServerProcess;
  readonly spawn: CodexAppServerSpawn;
  command: readonly string[] | null = null;
  spawnOptions: CodexAppServerSpawnOptions | null = null;
  workspace = "";
  threadId = "019f-thread-1";
  threadStatus: "idle" | "active" = "idle";
  turns: Array<Record<string, unknown>> = [];
  account: Record<string, unknown> | null = { type: "chatgpt", email: null, planType: "plus" };
  permissionAllowed = true;
  enabledHighRiskFeature: string | null = null;
  featureListTransform: (
    features: FakeCodexFeature[],
  ) => FakeCodexFeature[] = (features) => features;
  threadReadbackOverride: Record<string, unknown> = {};
  materializationMode: "valid" | "missing" | "wrong-id" = "valid";
  materializationReadMisses = 0;
  rolloutPath: string | null = null;
  failWriteMethod: string | null = null;
  blockWriteResponseId: number | null = null;
  holdTurnStart = false;
  holdTurnInterrupt = false;
  autoInterruptTerminal = true;
  readonly heldTurnStart = deferred<Record<string, unknown>>();
  readonly heldTurnInterrupt = deferred<Record<string, unknown>>();
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
      await this.respond(message.id, {
        userAgent: "livis-relay-daemon/0.145.0 (test; test) unknown (livis-relay-daemon; 0.1.0)",
        codexHome: this.spawnOptions?.env?.CODEX_HOME,
        platformFamily: "unix",
        platformOs: "test",
      });
      return;
    }
    if (message.method === "account/read") {
      await this.respond(message.id, {
        account: this.account,
        requiresOpenaiAuth: this.account === null,
      });
      return;
    }
    if (message.method === "permissionProfile/list") {
      await this.respond(message.id, {
        data: [{ id: "livis-remote", description: "test", allowed: this.permissionAllowed }],
        nextCursor: null,
      });
      return;
    }
    if (message.method === "experimentalFeature/list") {
      const features = codex0145FeatureSnapshot();
      if (this.enabledHighRiskFeature !== null) {
        const highRiskFeature = features.find(
          (feature) => feature.name === this.enabledHighRiskFeature,
        );
        if (highRiskFeature) highRiskFeature.enabled = true;
      }
      await this.respond(message.id, {
        data: this.featureListTransform(features),
        nextCursor: null,
      });
      return;
    }
    if (message.method === "thread/start" || message.method === "thread/resume") {
      const response = this.threadResponse(message);
      await this.respond(message.id, response);
      return;
    }
    if (message.method === "thread/memoryMode/set") {
      const params = isRecord(message.params) ? message.params : {};
      if (params.threadId !== this.threadId || params.mode !== "disabled") {
        throw new Error("fake app-server 收到错误的 thread memory mode");
      }
      if (this.materializationMode !== "missing") {
        const codexHome = this.spawnOptions?.env?.CODEX_HOME;
        if (!codexHome) throw new Error("fake app-server 缺少 CODEX_HOME");
        await this.prepareRollout(
          codexHome,
          true,
          this.materializationMode === "wrong-id" ? `${this.threadId}-other` : this.threadId,
        );
      }
      await this.respond(message.id, {});
      return;
    }
    if (message.method === "thread/read") {
      const params = isRecord(message.params) ? message.params : {};
      if (params.threadId !== this.threadId || params.includeTurns !== true) {
        throw new Error("fake app-server 收到错误的 thread/read 参数");
      }
      const thread = this.threadRecord();
      if (this.materializationReadMisses > 0) {
        this.materializationReadMisses -= 1;
        thread.path = null;
      }
      await this.respond(message.id, { thread });
      return;
    }
    if (message.method === "turn/start") {
      this.requireLocalEnvironment(message);
      if (this.holdTurnStart) {
        void this.heldTurnStart.promise
          .then((response) => this.respond(message.id as number, response))
          .catch(() => undefined);
        return;
      }
      this.threadStatus = "active";
      this.turns.push({ id: "019f-turn-1", status: "inProgress" });
      await this.respond(message.id, { turn: { id: "019f-turn-1", status: "inProgress" } });
      return;
    }
    if (message.method === "turn/interrupt" && this.holdTurnInterrupt) {
      void this.heldTurnInterrupt.promise
        .then((response) => this.respond(message.id as number, response))
        .catch(() => undefined);
      return;
    }
    if (message.method === "turn/interrupt") {
      await this.respond(message.id, {});
      if (this.autoInterruptTerminal) {
        const params = isRecord(message.params) ? message.params : {};
        const turnId = typeof params.turnId === "string" ? params.turnId : "019f-turn-1";
        await this.send({
          method: "turn/completed",
          params: {
            threadId: this.threadId,
            turn: { id: turnId, status: "interrupted", items: [] },
          },
        });
      }
      return;
    }
    if (message.method === "thread/unsubscribe") {
      await this.respond(message.id, {});
      return;
    }
    await this.respond(message.id, {});
  }

  private requireLocalEnvironment(message: Record<string, unknown>): void {
    const params = isRecord(message.params) ? message.params : {};
    const environments = params.environments;
    if (!Array.isArray(environments) || environments.length !== 1) {
      throw new Error("fake app-server 要求唯一 local environment");
    }
    const environment = environments[0];
    if (
      !isRecord(environment) ||
      environment.environmentId !== "local" ||
      environment.cwd !== this.workspace ||
      !Array.isArray(environment.runtimeWorkspaceRoots) ||
      environment.runtimeWorkspaceRoots.length !== 1 ||
      environment.runtimeWorkspaceRoots[0] !== this.workspace
    ) {
      throw new Error("fake app-server 收到错误的 local environment");
    }
  }

  threadResponse(message: Record<string, unknown>): Record<string, unknown> {
    const params = isRecord(message.params) ? message.params : {};
    const environments = params.environments;
    let runtimeWorkspaceRoots = Array.isArray(params.runtimeWorkspaceRoots)
      ? params.runtimeWorkspaceRoots
      : [];
    if (Array.isArray(environments)) {
      if (environments.length === 0) {
        // 与真实 app-server 一致：空选择会清空本地 runtime roots。
        runtimeWorkspaceRoots = [];
      } else {
        this.requireLocalEnvironment(message);
        const environment = environments[0] as Record<string, unknown>;
        runtimeWorkspaceRoots = environment.runtimeWorkspaceRoots as unknown[];
      }
    }
    return {
      thread: this.threadRecord(),
      cwd: this.workspace,
      runtimeWorkspaceRoots,
      instructionSources: [],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      activePermissionProfile: { id: "livis-remote", extends: null },
      sandbox: {
        type: runtimeWorkspaceRoots.length === 1 ? "workspaceWrite" : "readOnly",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      ...this.threadReadbackOverride,
    };
  }

  private threadRecord(): Record<string, unknown> {
    return {
      id: this.threadId,
      sessionId: this.threadId,
      cwd: this.workspace,
      cliVersion: "0.145.0",
      ephemeral: false,
      status: { type: this.threadStatus },
      turns: this.turns.map((turn) => ({ ...turn })),
      path: this.rolloutPath,
    };
  }

  async prepareRollout(
    codexHome: string,
    write: boolean,
    sessionMetaId = this.threadId,
  ): Promise<string> {
    const directory = join(codexHome, "sessions", "2026", "07", "22");
    this.rolloutPath = join(directory, `rollout-test-${this.threadId}.jsonl`);
    if (write) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        this.rolloutPath,
        `${JSON.stringify({
          timestamp: "2026-07-22T00:00:00.000Z",
          type: "session_meta",
          payload: { id: sessionMetaId, session_id: sessionMetaId },
        })}\n`,
        { mode: 0o600 },
      );
    }
    return this.rolloutPath;
  }

  async respond(id: number, result: unknown): Promise<void> {
    await this.send({ id, result });
  }

  async send(message: Record<string, unknown>): Promise<void> {
    if (message.method === "turn/completed" && isRecord(message.params)) {
      const turn = isRecord(message.params.turn) ? message.params.turn : null;
      if (turn && typeof turn.id === "string" && typeof turn.status === "string") {
        this.threadStatus = "idle";
        const existing = this.turns.findIndex((candidate) => candidate.id === turn.id);
        const snapshot = { id: turn.id, status: turn.status };
        if (existing >= 0) this.turns[existing] = snapshot;
        else this.turns.push(snapshot);
      }
    }
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
  handlers: ExecutionBackendHandlers;
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
  turnTimeoutMs?: number;
  interruptGraceMs?: number;
  configureFake?: (fake: FakeCodexAppServer) => void;
  commandRunner?: CodexCommandRunner;
  existingThreadId?: string;
  existingRollout?: "valid" | "missing";
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
      accountType: "chatgpt",
      accountSubjectSha256: null,
      accountIdentityStrength: "type-only",
      requestedModel: null,
      effectiveModel: "gpt-5.6-sol",
      modelProvider: "openai",
      securityConfigSha256: sha256(codexRemoteConfig(layout.workspace)),
      featureSnapshotSha256: validateDisabledCodexFeatures({
        data: codex0145FeatureSnapshot(),
        nextCursor: null,
      }, "0.145.0"),
      checkpointTurnId: null,
      checkpointTurnStatus: null,
      checkpointTurnCount: 0,
      checkpointTurnsSha256: sha256(JSON.stringify([])),
      checkpointedAt: Date.now(),
    });
    store.bindBackendThread("codex", sessionKey, options.existingThreadId);
    fake.threadId = options.existingThreadId;
    await fake.prepareRollout(
      layout.codexHome,
      options.existingRollout !== "missing",
    );
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
    turnTimeoutMs: options.turnTimeoutMs ?? 5_000,
    interruptGraceMs: options.interruptGraceMs ?? 25,
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
    handlers,
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
  const ingested = harness.store.ingest(incomingJob(jobId, text), "livis:agent-test", "codex");
  harness.store.markAcked(ingested.job.jobId);
  const executionId = harness.backend.executionId;
  if (!executionId) throw new Error("backend 尚未 ready");
  const claimed = harness.store.claimForBackendDispatch(jobId, "codex", executionId, `lease-${jobId}`);
  if (!claimed) throw new Error("test job claim 失败");
  return claimed;
}

describe("CodexExecutionBackend", () => {
  test("smoke 入口 fake 轨迹固定且绝不发送模型 turn", async () => {
    const commandDirectory = await temporaryDirectory("livis-codex-smoke-command-");
    const command = `${commandDirectory.path}/codex`;
    await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const freshFake = new FakeCodexAppServer();
    const resumedFake = new FakeCodexAppServer();
    freshFake.account = null;
    resumedFake.account = null;
    let spawnCount = 0;
    const smokeSpawn: CodexAppServerSpawn = (argv, options) => {
      const fake = spawnCount++ === 0 ? freshFake : resumedFake;
      if (fake === resumedFake) {
        resumedFake.threadId = freshFake.threadId;
        resumedFake.rolloutPath = freshFake.rolloutPath;
      }
      return fake.spawn(argv, options);
    };
    let smokeStateDir: string | null = null;
    try {
      const report = await runCodexAppServerLocalSmoke({
        command,
        requestTimeoutMs: 1_000,
        shutdownTimeoutMs: 1_000,
      }, {
        appServerSpawn: smokeSpawn,
        commandRunner: successfulVersion,
      });
      smokeStateDir = report.stateDir;
      expect(report).toMatchObject({
        ok: true,
        sentModelTurn: false,
        backendStartReady: false,
        cliVersion: "0.145.0",
        account: { authenticated: false, requiresOpenaiAuth: true, type: null },
        permissionProfile: "livis-remote",
        environmentId: "local",
        safety: {
          runtimeWorkspaceRootsMatch: true,
          sandboxType: "workspaceWrite",
          networkAccess: false,
        },
      });
      const messages = [...freshFake.messages, ...resumedFake.messages];
      expect(messages.map((message) => message.method).filter(Boolean)).toEqual([
        "initialize",
        "initialized",
        "account/read",
        "permissionProfile/list",
        "experimentalFeature/list",
        "thread/start",
        "thread/memoryMode/set",
        "thread/read",
        "initialize",
        "initialized",
        "account/read",
        "permissionProfile/list",
        "experimentalFeature/list",
        "thread/resume",
      ]);
      expect(messages.some((message) => message.method === "turn/start")).toBeFalse();
    } finally {
      await Promise.all([freshFake.stop(0), resumedFake.stop(0)]);
      if (smokeStateDir !== null) {
        await rm(smokeStateDir, { recursive: true, force: true });
      }
      await commandDirectory.cleanup();
    }
  });

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
        ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
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
        environments: [{
          environmentId: "local",
          cwd: harness.fake.workspace,
          runtimeWorkspaceRoots: [harness.fake.workspace],
        }],
        ephemeral: false,
      });
      const stored = harness.store.getBackendSession("codex", "livis:agent-test");
      expect(stored?.threadId).toBe(harness.fake.threadId);
      expect(stored?.cwd).toBe(harness.fake.workspace);
      expect(stored?.cliVersion).toBe("0.145.0");
      expect(harness.fake.messages.find(
        (message) => message.method === "thread/memoryMode/set",
      )?.params).toEqual({ threadId: harness.fake.threadId, mode: "disabled" });
      expect(harness.fake.messages.find((message) => message.method === "thread/read")?.params)
        .toEqual({ threadId: harness.fake.threadId, includeTurns: true });
      expect(harness.fake.rolloutPath).not.toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  test("新 thread 在首个 turn 前物化，daemon 无 turn 重启后可按原 id resume", async () => {
    const harness = await createHarness();
    let restarted: CodexExecutionBackend | null = null;
    try {
      const threadId = harness.fake.threadId;
      const rolloutPath = harness.fake.rolloutPath;
      if (!rolloutPath) throw new Error("test rollout 尚未物化");
      expect(harness.fake.messages.some((message) => message.method === "turn/start")).toBeFalse();

      await harness.backend.stop();
      const resumedFake = new FakeCodexAppServer();
      resumedFake.threadId = threadId;
      resumedFake.rolloutPath = rolloutPath;
      restarted = new CodexExecutionBackend({
        stateDir: harness.directory.path,
        scopeKey: "scope-test",
        sessionKey: "livis:agent-test",
        remoteNodeId: "node-1",
        command: "/test/bin/codex",
        model: null,
        maxOutputChars: 1_048_576,
        requestTimeoutMs: 100,
        turnTimeoutMs: 5_000,
        interruptGraceMs: 25,
        shutdownTimeoutMs: 100,
      }, {
        store: harness.store,
        handlers: harness.handlers,
        appServerSpawn: resumedFake.spawn,
        commandRunner: successfulVersion,
      });
      await restarted.start();

      expect(restarted.executionId).toBe(`codex:${threadId}`);
      expect(resumedFake.messages.some((message) => message.method === "thread/start")).toBeFalse();
      expect(resumedFake.messages.some(
        (message) => message.method === "thread/memoryMode/set",
      )).toBeFalse();
      expect(resumedFake.messages.find((message) => message.method === "thread/resume")?.params)
        .toMatchObject({ threadId });
      expect(resumedFake.messages.find((message) => message.method === "thread/read")?.params)
        .toEqual({ threadId, includeTurns: true });
      expect(resumedFake.messages.some((message) => message.method === "turn/start")).toBeFalse();
      expect(harness.events).toEqual(["ready", "ready"]);
    } finally {
      await restarted?.stop().catch(() => undefined);
      await harness.cleanup();
    }
  });

  test("新 thread 的 rollout path 延迟出现时仅在总时限内轮询 thread/read", async () => {
    const harness = await createHarness({
      configureFake: (fake) => {
        fake.materializationReadMisses = 2;
      },
    });
    try {
      expect(harness.backend.ready).toBeTrue();
      expect(harness.fake.messages.filter((message) => message.method === "thread/read"))
        .toHaveLength(4);
      expect(harness.store.getBackendSession("codex", "livis:agent-test")?.threadId)
        .toBe(harness.fake.threadId);
    } finally {
      await harness.cleanup();
    }
  });

  test("新 thread 物化失败时不 bind 且不触发 ready", async () => {
    const materializationTimeoutMs = 80;
    const harness = await createHarness({
      start: false,
      requestTimeoutMs: materializationTimeoutMs,
      configureFake: (fake) => {
        fake.materializationMode = "missing";
      },
    });
    try {
      const startedAt = Date.now();
      await expect(harness.backend.start()).rejects.toThrow(
        `在 ${materializationTimeoutMs} ms 内未物化 rollout`,
      );
      expect(Date.now() - startedAt)
        .toBeLessThan(materializationTimeoutMs + 500);
      expect(harness.fake.messages.filter((message) => message.method === "thread/read").length)
        .toBeGreaterThan(1);
      expect(harness.store.getBackendSession("codex", "livis:agent-test")).toBeNull();
      expect(harness.store.getSessionQuarantine("livis:agent-test")?.reason)
        .toContain("rollout 物化");
      expect(harness.events).toEqual([]);
      expect(harness.backend.ready).toBeFalse();
    } finally {
      await harness.cleanup();
    }
  });

  test("rollout session_meta 不匹配属于永久错误且不会轮询重试", async () => {
    const harness = await createHarness({
      start: false,
      configureFake: (fake) => {
        fake.materializationMode = "wrong-id";
      },
    });
    try {
      await expect(harness.backend.start()).rejects.toThrow(
        "session_meta id 与 threadId 不一致",
      );
      expect(harness.fake.messages.filter((message) => message.method === "thread/read"))
        .toHaveLength(1);
      expect(harness.store.getBackendSession("codex", "livis:agent-test")).toBeNull();
      expect(harness.events).toEqual([]);
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
      expect(harness.fake.messages.some(
        (message) => message.method === "thread/memoryMode/set",
      )).toBeFalse();
      expect(harness.fake.messages.find((message) => message.method === "thread/read")?.params)
        .toEqual({ threadId: "019f-existing-thread", includeTurns: true });
      expect(harness.backend.executionId).toBe("codex:019f-existing-thread");
    } finally {
      await harness.cleanup();
    }
  });

  test("已绑定 thread 的 rollout 缺失时 fail-closed 且不触发 ready", async () => {
    const harness = await createHarness({
      start: false,
      existingThreadId: "019f-existing-missing-rollout",
      existingRollout: "missing",
    });
    try {
      await expect(harness.backend.start()).rejects.toThrow("rollout 尚未落盘");
      expect(harness.fake.messages.some((message) => message.method === "thread/start")).toBeFalse();
      expect(harness.fake.messages.some(
        (message) => message.method === "thread/memoryMode/set",
      )).toBeFalse();
      expect(harness.fake.messages.some((message) => message.method === "thread/read")).toBeTrue();
      expect(harness.store.getBackendSession("codex", "livis:agent-test")?.threadId)
        .toBe("019f-existing-missing-rollout");
      expect(harness.store.getSessionQuarantine("livis:agent-test")?.reason)
        .toContain("rollout 物化");
      expect(harness.events).toEqual([]);
      expect(harness.backend.ready).toBeFalse();
    } finally {
      await harness.cleanup();
    }
  });

  test("恢复时拒绝未知活动 turn 和未记录的 completed tail", async () => {
    for (const scenario of [
      {
        status: "active" as const,
        turns: [{ id: "external-active", status: "inProgress" }],
        expected: "不是 idle",
      },
      {
        status: "idle" as const,
        turns: [{ id: "external-completed", status: "completed" }],
        expected: "持久 checkpoint 不一致",
      },
    ]) {
      const harness = await createHarness({
        start: false,
        existingThreadId: "019f-thread-existing",
        existingRollout: "valid",
        configureFake: (fake) => {
          fake.threadStatus = scenario.status;
          fake.turns = scenario.turns;
        },
      });
      try {
        await expect(harness.backend.start()).rejects.toThrow(scenario.expected);
        expect(harness.backend.ready).toBeFalse();
        expect(harness.store.getSessionQuarantine("livis:agent-test")).not.toBeNull();
      } finally {
        await harness.cleanup();
      }
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

  test("高风险 Codex feature 任一仍启用时 fail-closed，不创建 thread", async () => {
    const harness = await createHarness({
      start: false,
      configureFake: (fake) => {
        fake.enabledHighRiskFeature = "goals";
      },
    });
    try {
      await expect(harness.backend.start()).rejects.toThrow("高风险 feature 未禁用");
      expect(harness.fake.messages.some((message) => message.method === "thread/start")).toBeFalse();
      expect(harness.backend.ready).toBeFalse();
    } finally {
      await harness.cleanup();
    }
  });

  test("Codex feature 快照出现未知 enabled 项时 fail-closed，不创建 thread", async () => {
    const harness = await createHarness({
      start: false,
      configureFake: (fake) => {
        fake.featureListTransform = (features) => [...features, {
          name: "unreviewed_future_feature",
          stage: "experimental",
          enabled: true,
          defaultEnabled: false,
        }];
      },
    });
    try {
      await expect(harness.backend.start()).rejects.toThrow("enabled feature 集合未经审核");
      expect(harness.fake.messages.some((message) => message.method === "thread/start")).toBeFalse();
      expect(harness.backend.ready).toBeFalse();
    } finally {
      await harness.cleanup();
    }
  });

  test("Codex feature 快照出现重复名称时 fail-closed，不创建 thread", async () => {
    const harness = await createHarness({
      start: false,
      configureFake: (fake) => {
        fake.featureListTransform = (features) => {
          const duplicate = features.find((feature) => feature.name === "shell_tool");
          if (!duplicate) throw new Error("test feature fixture 缺少 shell_tool");
          return [...features, { ...duplicate }];
        };
      },
    });
    try {
      await expect(harness.backend.start()).rejects.toThrow("feature 列表包含重复名称");
      expect(harness.fake.messages.some((message) => message.method === "thread/start")).toBeFalse();
      expect(harness.backend.ready).toBeFalse();
    } finally {
      await harness.cleanup();
    }
  });

  test("Codex 允许 feature 的 stage 漂移时 fail-closed，不创建 thread", async () => {
    const harness = await createHarness({
      start: false,
      configureFake: (fake) => {
        fake.featureListTransform = (features) => features.map((feature) =>
          feature.name === "shell_tool"
            ? { ...feature, stage: "experimental" }
            : feature
        );
      },
    });
    try {
      await expect(harness.backend.start()).rejects.toThrow("允许 feature 的 stage/default 已漂移");
      expect(harness.fake.messages.some((message) => message.method === "thread/start")).toBeFalse();
      expect(harness.backend.ready).toBeFalse();
    } finally {
      await harness.cleanup();
    }
  });

  test("Codex feature 快照缺少允许项时 fail-closed，不创建 thread", async () => {
    const harness = await createHarness({
      start: false,
      configureFake: (fake) => {
        fake.featureListTransform = (features) => features.filter(
          (feature) => feature.name !== "shell_tool",
        );
      },
    });
    try {
      await expect(harness.backend.start()).rejects.toThrow("enabled feature 集合未经审核");
      expect(harness.fake.messages.some((message) => message.method === "thread/start")).toBeFalse();
      expect(harness.backend.ready).toBeFalse();
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
          environments: [{
            environmentId: "local",
            cwd: harness.fake.workspace,
            runtimeWorkspaceRoots: [harness.fake.workspace],
          }],
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
      expect(harness.store.getBackendSession("codex", "livis:agent-test")).toMatchObject({
        accountType: "chatgpt",
        accountIdentityStrength: "type-only",
        requestedModel: null,
        effectiveModel: "gpt-5.6-sol",
        modelProvider: "openai",
        checkpointTurnId: "019f-turn-1",
        checkpointTurnStatus: "completed",
        checkpointTurnCount: 1,
      });
    } finally {
      await harness.cleanup();
    }
  });

  test("dispatch 前发现外部追加 turn 时 quarantine，且绝不发送新的 turn/start", async () => {
    const harness = await createHarness();
    try {
      harness.fake.threadStatus = "idle";
      harness.fake.turns = [{ id: "external-completed", status: "completed" }];
      const job = claimJob(harness, "job-external-tail");
      const turnStartsBefore = harness.fake.messages
        .filter((message) => message.method === "turn/start").length;

      expect(await harness.backend.dispatch(job)).toBe("not_sent");
      expect(harness.fake.messages.filter((message) => message.method === "turn/start"))
        .toHaveLength(turnStartsBefore);
      expect(harness.backend.ready).toBeFalse();
      expect(harness.store.getSessionQuarantine("livis:agent-test")?.reason)
        .toContain("thread checkpoint");
      expect(harness.store.resetUnsentBackendDispatch(
        job.jobId,
        "codex",
        job.leaseId!,
        job.runGeneration,
      )).toBeTrue();
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

  test("preflight 尚未完成时收到 cancel 不得发 turn/start 或误判 deadline", async () => {
    const harness = await createHarness();
    try {
      const job = claimJob(harness, "job-cancel-during-preflight");
      const dispatch = harness.backend.dispatch(job);
      const cancelling = harness.store.requestCancel(job.jobId);
      if (!cancelling) throw new Error("test cancel job missing");
      const cancel = harness.backend.cancel(cancelling);

      expect(await dispatch).toBe("not_sent");
      expect(await cancel).toBe("not_sent");
      expect(harness.fake.messages.filter((message) => message.method === "turn/start"))
        .toHaveLength(0);
      expect(harness.disconnects).toEqual([]);
      expect(harness.store.getSessionQuarantine("livis:agent-test")).toBeNull();
      expect(harness.store.finishUnsentBackendCancellation(
        job.jobId,
        "codex",
        job.leaseId!,
        job.runGeneration,
      )?.status).toBe("Cancelled");
      expect(harness.store.require(job.jobId).status).toBe("Cancelled");
      expect(harness.backend.ready).toBeTrue();
      expect(harness.backend.status().active).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  test("完整 turn deadline 在 turnId 未知时直接失败关闭且绝不回报 not_sent", async () => {
    const harness = await createHarness({
      requestTimeoutMs: 500,
      turnTimeoutMs: 25,
      interruptGraceMs: 15,
      configureFake: (fake) => {
        fake.holdTurnStart = true;
      },
    });
    try {
      const job = claimJob(harness, "job-deadline-before-turn-id");
      expect(await harness.backend.dispatch(job)).toBe("submitted");
      await waitFor(() => harness.disconnects.length === 1, "unknown turn deadline disconnect");

      expect(harness.fake.messages.filter((message) => message.method === "turn/interrupt"))
        .toHaveLength(0);
      expect(harness.results).toEqual([]);
      expect(harness.store.require(job.jobId).status).toBe("Interrupted");
      expect(harness.store.getBackendSession("codex", "livis:agent-test")?.activeTurnId)
        .toBeNull();
      expect(harness.store.getSessionQuarantine("livis:agent-test")?.reason)
        .toContain("turnId 仍未知");
    } finally {
      harness.fake.heldTurnStart.resolve({ turn: { id: "late-turn", status: "inProgress" } });
      await harness.cleanup();
    }
  });

  test("完整 turn deadline 只 interrupt 一次，grace 后隔离并丢弃迟到 terminal", async () => {
    const harness = await createHarness({
      requestTimeoutMs: 500,
      turnTimeoutMs: 30,
      interruptGraceMs: 30,
    });
    try {
      const job = claimJob(harness, "job-deadline-known-turn");
      expect(await harness.backend.dispatch(job)).toBe("submitted");
      await waitFor(
        () => harness.fake.messages.some((message) => message.method === "turn/interrupt"),
        "timeout interrupt",
      );
      await harness.fake.send({
        method: "turn/completed",
        params: {
          threadId: harness.fake.threadId,
          turn: {
            id: "019f-turn-1",
            status: "completed",
            items: [{
              type: "agentMessage",
              id: "late-final",
              text: "不得交付的迟到结果",
              phase: "final_answer",
            }],
          },
        },
      });
      await waitFor(() => harness.disconnects.length === 1, "known turn deadline disconnect");

      expect(harness.fake.messages.filter((message) => message.method === "turn/interrupt"))
        .toHaveLength(1);
      expect(harness.results).toEqual([]);
      expect(harness.store.require(job.jobId).status).toBe("Interrupted");
      expect(harness.store.require(job.jobId).outbox).toBeNull();
      expect(harness.disconnects[0]).toContain("interrupt grace 已耗尽");
    } finally {
      await harness.cleanup();
    }
  });

  test("用户 cancel 与 turn deadline 竞争时只有一个 interrupt 且 timeout 不伪装为取消成功", async () => {
    const harness = await createHarness({
      requestTimeoutMs: 500,
      turnTimeoutMs: 35,
      interruptGraceMs: 25,
      configureFake: (fake) => {
        fake.holdTurnInterrupt = true;
      },
    });
    try {
      const job = claimJob(harness, "job-cancel-deadline-race");
      await harness.backend.dispatch(job);
      const cancelling = harness.store.requestCancel(job.jobId);
      if (!cancelling) throw new Error("test cancel job missing");
      const cancel = harness.backend.cancel(cancelling);
      await waitFor(
        () => harness.fake.messages.some((message) => message.method === "turn/interrupt"),
        "user interrupt",
      );
      await waitFor(() => harness.disconnects.length === 1, "cancel deadline disconnect");
      expect(await cancel).toBe("submitted");

      expect(harness.fake.messages.filter((message) => message.method === "turn/interrupt"))
        .toHaveLength(1);
      expect(harness.events).not.toContain("cancelled:job-cancel-deadline-race");
      expect(harness.store.require(job.jobId).status).toBe("CancelUnknown");
      expect(harness.results).toEqual([]);
    } finally {
      harness.fake.heldTurnInterrupt.resolve({});
      await harness.cleanup();
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
      await waitFor(() => harness.events.includes("cancelled:job-cancel-race"), "cancel terminal");
      expect(harness.store.require(claimed.jobId).status).toBe("CancelUnknown");
      const session = harness.store.getBackendSession("codex", "livis:agent-test");
      expect(session?.checkpointTurnId).toBe("019f-turn-1");
      expect(session?.checkpointTurnStatus).toBe("interrupted");
      expect(session?.checkpointTurnCount).toBe(1);
      expect(harness.results).toEqual([]);
      expect(harness.backend.ready).toBeFalse();
    } finally {
      await harness.cleanup();
    }
  });

  test("turn/interrupt response 不是 terminal，缺少 turn/completed 时保持 Cancelling 到 deadline", async () => {
    const harness = await createHarness({
      turnTimeoutMs: 45,
      interruptGraceMs: 20,
      configureFake: (fake) => {
        fake.autoInterruptTerminal = false;
      },
    });
    try {
      const job = claimJob(harness, "job-interrupt-without-terminal");
      await harness.backend.dispatch(job);
      const cancelling = harness.store.requestCancel(job.jobId);
      if (!cancelling) throw new Error("test cancel job missing");

      expect(await harness.backend.cancel(cancelling)).toBe("submitted");
      expect(harness.store.require(job.jobId).status).toBe("Cancelling");
      expect(harness.events).not.toContain("cancelled:job-interrupt-without-terminal");

      await waitFor(() => harness.disconnects.length === 1, "interrupt without terminal deadline");
      expect(harness.store.require(job.jobId).status).toBe("CancelUnknown");
      expect(harness.results).toEqual([]);
      expect(harness.store.getBackendSession("codex", "livis:agent-test")?.recoveryRequired)
        .toBeTrue();
    } finally {
      await harness.cleanup();
    }
  });

  test("cancel 与 completed 竞态按真实 terminal checkpoint，但不交付 final", async () => {
    const harness = await createHarness({
      configureFake: (fake) => {
        fake.autoInterruptTerminal = false;
      },
    });
    try {
      const job = claimJob(harness, "job-cancel-completed-race");
      await harness.backend.dispatch(job);
      const cancelling = harness.store.requestCancel(job.jobId);
      if (!cancelling) throw new Error("test cancel job missing");
      expect(await harness.backend.cancel(cancelling)).toBe("submitted");

      await harness.fake.send({
        method: "turn/completed",
        params: {
          threadId: harness.fake.threadId,
          turn: {
            id: "019f-turn-1",
            status: "completed",
            items: [{
              type: "agentMessage",
              id: "cancel-race-final",
              text: "不得交付的竞态结果",
              phase: "final_answer",
            }],
          },
        },
      });
      await waitFor(
        () => harness.events.includes("cancelled:job-cancel-completed-race"),
        "cancel completed race terminal",
      );

      const session = harness.store.getBackendSession("codex", "livis:agent-test");
      expect(session?.checkpointTurnId).toBe("019f-turn-1");
      expect(session?.checkpointTurnStatus).toBe("completed");
      expect(session?.checkpointTurnCount).toBe(1);
      expect(harness.store.require(job.jobId).status).toBe("CancelUnknown");
      expect(harness.results).toEqual([]);
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
