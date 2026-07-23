import { describe, expect, test } from "bun:test";
import { chmod, link, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CODEX_IDLE_RECOVERY_DELAYS_MS,
  CodexExecutionBackend,
  type CodexCommandPinAsserter,
  type CodexCommandPinResolver,
  type CodexCommandRunner,
  type CodexExecutionBackendDependencies,
  inspectCodexAccountResponse,
  validateDisabledCodexFeatures,
} from "../src/backends/codex/codex-execution-backend.ts";
import type {
  ExecutionBackendHandlers,
  ExecutionJobEvent,
} from "../src/backends/execution-backend.ts";
import {
  CODEX_0145_ALLOWED_ENABLED_FEATURES,
  CODEX_DISABLED_FEATURES,
  CodexAppServerProcessOwnershipUnconfirmedError,
  type CodexAppServerProcess,
  type CodexAppServerSpawn,
  type CodexAppServerSpawnOptions,
} from "../src/backends/codex/app-server-client.ts";
import {
  codexSecurityBindingSha256,
  ensureCodexRuntimeLayout,
  type PinnedCodexCommand,
} from "../src/backends/codex/runtime-layout.ts";
import { runCodexAppServerLocalSmoke } from "../src/backends/codex/local-smoke.ts";
import { Logger, type LogLevel } from "../src/logger.ts";
import { serializeResult } from "../src/protocol/livis.ts";
import { JobStore } from "../src/state/store.ts";
import type { CodexProviderConfig, StoredJob } from "../src/types.ts";
import { sha256 } from "../src/util.ts";
import { incomingJob, temporaryDirectory } from "./helpers.ts";

const OPENAI_PROVIDER = { type: "openai" } as const satisfies CodexProviderConfig;
const CUSTOM_PROVIDER = {
  type: "custom",
  baseUrl: "https://provider.example.invalid/v1",
  acknowledgeApiKeyTransmission: true,
} as const satisfies CodexProviderConfig;
const CUSTOM_PROVIDER_ID = "livis-custom-responses";

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

class CapturingLogger extends Logger {
  readonly entries: string[] = [];

  constructor() {
    super("test.codex-backend-capture", "debug");
  }

  override debug(message: string, fields: Record<string, unknown> = {}): void {
    this.capture("debug", message, fields);
  }

  override info(message: string, fields: Record<string, unknown> = {}): void {
    this.capture("info", message, fields);
  }

  override warn(message: string, fields: Record<string, unknown> = {}): void {
    this.capture("warn", message, fields);
  }

  override error(message: string, fields: Record<string, unknown> = {}): void {
    this.capture("error", message, fields);
  }

  private capture(level: LogLevel, message: string, fields: Record<string, unknown>): void {
    this.entries.push(JSON.stringify({ level, message, fields }));
  }
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
  threadStatus: "idle" | "active" | "systemError" = "idle";
  failedTerminalThreadStatus: "idle" | "systemError" = "idle";
  completedTerminalThreadStatus: "idle" | "systemError" = "idle";
  legacyFailedTurnReadbackAsCompleted = false;
  cliVersion = "0.145.0";
  nextTurnId = "019f-turn-1";
  turns: Array<Record<string, unknown>> = [];
  account: Record<string, unknown> | null = { type: "apiKey" };
  requiresOpenaiAuth = true;
  permissionAllowed = true;
  enabledHighRiskFeature: string | null = null;
  featureListTransform: (
    features: FakeCodexFeature[],
  ) => FakeCodexFeature[] = (features) => features;
  threadReadbackOverride: Record<string, unknown> = {};
  materializationMode: "valid" | "missing" | "wrong-id" = "valid";
  effectiveModel = "gpt-5.6-sol";
  modelProvider = "openai";
  commandExecHandler: (
    params: Record<string, unknown>,
  ) => Promise<Record<string, unknown>> | Record<string, unknown> = () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
  materializationReadMisses = 0;
  rolloutPath: string | null = null;
  failWriteMethod: string | null = null;
  rpcErrorMethod: string | null = null;
  rpcError: Record<string, unknown> = { code: -32_000, message: "synthetic RPC failure" };
  blockWriteResponseId: number | null = null;
  holdTurnStart = false;
  holdTurnInterrupt = false;
  autoInterruptTerminal = true;
  holdMethod: string | null = null;
  ignoreKill = false;
  readonly heldTurnStart = deferred<Record<string, unknown>>();
  readonly heldTurnInterrupt = deferred<Record<string, unknown>>();
  readonly heldWrite = deferred<void>();
  readonly heldMethod = deferred<Record<string, unknown>>();

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
        if (!this.ignoreKill) void this.stop(0);
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
    if (message.method === this.holdMethod) {
      void this.heldMethod.promise
        .then((response) => this.respond(message.id as number, response))
        .catch(() => undefined);
      return;
    }
    if (message.method === this.rpcErrorMethod) {
      await this.send({ id: message.id, error: this.rpcError });
      return;
    }
    if (message.method === "initialize") {
      await this.respond(message.id, {
        userAgent: `livis-relay-daemon/${this.cliVersion} (test; test) unknown (livis-relay-daemon; 0.1.0)`,
        codexHome: this.spawnOptions?.env?.CODEX_HOME,
        platformFamily: "unix",
        platformOs: "test",
      });
      return;
    }
    if (message.method === "account/read") {
      await this.respond(message.id, {
        account: this.account,
        requiresOpenaiAuth: this.requiresOpenaiAuth,
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
    if (message.method === "command/exec") {
      const params = isRecord(message.params) ? message.params : {};
      await this.respond(message.id, await this.commandExecHandler(params));
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
      this.turns.push({ id: this.nextTurnId, status: "inProgress" });
      await this.respond(message.id, {
        turn: { id: this.nextTurnId, status: "inProgress" },
      });
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
      model: this.effectiveModel,
      modelProvider: this.modelProvider,
      ...this.threadReadbackOverride,
    };
  }

  private threadRecord(): Record<string, unknown> {
    return {
      id: this.threadId,
      sessionId: this.threadId,
      cwd: this.workspace,
      cliVersion: this.cliVersion,
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
        this.threadStatus = turn.status === "failed"
          ? this.failedTerminalThreadStatus
          : this.completedTerminalThreadStatus;
        const existing = this.turns.findIndex((candidate) => candidate.id === turn.id);
        const snapshot = {
          id: turn.id,
          status: turn.status === "failed" && this.legacyFailedTurnReadbackAsCompleted
            ? "completed"
            : turn.status,
        };
        if (existing >= 0) this.turns[existing] = snapshot;
        else this.turns.push(snapshot);
      }
    }
    await this.stdoutWriter.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
  }

  async writeStderr(text: string): Promise<void> {
    await this.stderrWriter.write(new TextEncoder().encode(text));
  }

  async stop(exitCode: number): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await Promise.allSettled([this.stdoutWriter.close(), this.stderrWriter.close()]);
    this.exit.resolve(exitCode);
  }

  exitWithoutClosingStreams(exitCode: number): void {
    this.exit.resolve(exitCode);
  }

  get isStopped(): boolean {
    return this.stopped;
  }
}

class FakeCodexAppServerSequence {
  readonly spawnTimes: number[] = [];
  private nextIndex = 0;

  constructor(
    readonly steps: ReadonlyArray<FakeCodexAppServer | Error>,
    private readonly beforeSpawn?: (index: number) => void,
  ) {
    if (!(steps[0] instanceof FakeCodexAppServer)) {
      throw new Error("fake app-server 序列首项必须可启动");
    }
  }

  get spawnCount(): number {
    return this.nextIndex;
  }

  readonly spawn: CodexAppServerSpawn = (command, options) => {
    const index = this.nextIndex++;
    this.spawnTimes.push(Date.now());
    this.beforeSpawn?.(index);
    const step = this.steps[index];
    if (!step) throw new Error(`fake app-server 序列已耗尽：${index}`);
    if (step instanceof Error) throw step;
    if (index > 0) {
      const initial = this.steps[0];
      if (!(initial instanceof FakeCodexAppServer)) {
        throw new Error("fake app-server 序列首项非法");
      }
      step.threadId = initial.threadId;
      step.rolloutPath = initial.rolloutPath;
    }
    return step.spawn(command, options);
  };
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
  logs: string[];
  cleanup(): Promise<void>;
}

const successfulVersion: CodexCommandRunner = async () => ({
  exitCode: 0,
  stdout: "codex-cli 0.145.0\n",
  stderr: "",
});

function fakeCommandPin(path = "/test/bin/codex"): PinnedCodexCommand {
  const contentSha256 = sha256("fake-codex-command");
  return {
    path,
    dev: 1,
    ino: 2,
    mode: 0o100700,
    nlink: 1,
    uid: 501,
    gid: 20,
    size: 18,
    mtimeMs: 1,
    ctimeMs: 1,
    contentSha256,
    identitySha256: sha256(JSON.stringify(["fake-codex-command-v1", path, contentSha256])),
  };
}

const fakeCommandPinResolver: CodexCommandPinResolver = async (_layout, command) =>
  fakeCommandPin(command);
const fakeCommandPinAsserter: CodexCommandPinAsserter = async () => undefined;

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
  commandPinResolver?: CodexCommandPinResolver;
  commandPinAsserter?: CodexCommandPinAsserter;
  existingThreadId?: string;
  existingRollout?: "valid" | "missing";
  maxOutputChars?: number;
  acceptedGate?: Promise<void>;
  readyGate?: Promise<void>;
  readyFailureAt?: number;
  fake?: FakeCodexAppServer;
  appServerSpawn?: CodexAppServerSpawn;
  recoveryDelaysMs?: readonly number[];
  shutdownTimeoutMs?: number;
  model?: string | null;
  provider?: CodexProviderConfig;
} = {}): Promise<Harness> {
  const directory = await temporaryDirectory("livis-codex-backend-");
  await chmod(directory.path, 0o700);
  const scopeKey = "scope-test";
  const sessionKey = "livis:agent-test";
  const model = options.model ?? null;
  const provider = options.provider ?? OPENAI_PROVIDER;
  const store = new JobStore(`${directory.path}/relay.db`, scopeKey);
  const fake = options.fake ?? new FakeCodexAppServer();
  fake.modelProvider = provider.type === "custom" ? CUSTOM_PROVIDER_ID : "openai";
  if (model !== null) fake.effectiveModel = model;
  options.configureFake?.(fake);
  if (options.existingThreadId) {
    const layout = await ensureCodexRuntimeLayout({
      stateDir: directory.path,
      scopeKey,
      sessionKey,
      remoteNodeId: "node-1",
      provider,
    });
    store.ensureBackendSession({
      backend: "codex",
      sessionKey,
      sessionHash: layout.sessionHash,
      cwd: layout.workspace,
      cliVersion: "0.145.0",
      accountType: "apiKey",
      accountSubjectSha256: null,
      accountIdentityStrength: "type-only",
      requestedModel: model,
      effectiveModel: fake.effectiveModel,
      modelProvider: fake.modelProvider,
      securityConfigSha256: codexSecurityBindingSha256(layout, fakeCommandPin()),
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
  const logger = new CapturingLogger();

  const handlers: ExecutionBackendHandlers = {
    onReady: async () => {
      events.push("ready");
      await options.readyGate;
      const readyCount = events.filter((event) => event === "ready").length;
      if (options.readyFailureAt === readyCount) {
        throw new Error(`synthetic ready failure ${readyCount}`);
      }
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
      const finished = event.sessionDisposition === "credential_rejected"
        ? store.finishBackendCredentialFailure(
            event.jobId,
            "codex",
            event.leaseId,
            runGeneration,
            turnId,
            serializeResult("Codex failed"),
            event.error,
            "Codex provider 拒绝当前隔离凭据；禁止继续发送 turn，需修复专用凭据并人工 release session",
          )
        : store.finishBackendFailure(
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
    model,
    provider,
    maxOutputChars: options.maxOutputChars ?? 1_048_576,
    requestTimeoutMs: options.requestTimeoutMs ?? 100,
    turnTimeoutMs: options.turnTimeoutMs ?? 5_000,
    interruptGraceMs: options.interruptGraceMs ?? 25,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 100,
  }, {
    store,
    handlers,
    logger,
    appServerSpawn: options.appServerSpawn ?? fake.spawn,
    commandRunner: options.commandRunner ?? successfulVersion,
    commandPinResolver: options.commandPinResolver ?? fakeCommandPinResolver,
    commandPinAsserter: options.commandPinAsserter ?? fakeCommandPinAsserter,
    ...(options.recoveryDelaysMs === undefined
      ? {}
      : { recoveryDelaysMs: options.recoveryDelaysMs }),
  } satisfies CodexExecutionBackendDependencies);

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
    logs: logger.entries,
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

type ReadIsolationScenario = {
  externalHardlink:
    | "denied"
    | "created"
    | "wrong-target"
    | "create-fails"
    | "denied-command-drift";
  network:
    | "eperm"
    | "eacces"
    | "connected"
    | "delayed-connected"
    | "other-errno"
    | "timeout"
    | "nc-unavailable"
    | "extra-stderr"
    | "host-control-fails"
    | "stdout-noise"
    | "wrong-endpoint";
  useDefaultStateDirAsserter?: boolean;
};

async function createReadIsolationSmokeHarness(scenario: ReadIsolationScenario): Promise<{
  run: () => ReturnType<typeof runCodexAppServerLocalSmoke>;
  stateDir: string;
  networkPort: () => number | null;
  loopbackStopped: () => boolean;
  createdCanaryPaths: () => readonly string[];
  cleanup: () => Promise<void>;
}> {
  const commandDirectory = await temporaryDirectory("livis-codex-smoke-command-");
  const stateParent = await temporaryDirectory("livis-codex-smoke-state-");
  const stateDir = join(await realpath(stateParent.path), "state");
  const command = join(commandDirectory.path, "codex");
  await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const freshFake = new FakeCodexAppServer();
  const resumedFake = new FakeCodexAppServer();
  freshFake.account = null;
  resumedFake.account = null;
  let observedNetworkPort: number | null = null;
  let loopbackAccepts = 0;
  let loopbackStopped = false;
  const createdCanaryPaths: string[] = [];
  freshFake.commandExecHandler = async (params) => {
    const argv = Array.isArray(params.command) && params.command.every((item) => typeof item === "string")
      ? params.command as string[]
      : [];
    const executable = argv[0];
    if (executable === "/bin/cat") {
      const path = argv[1] ?? "";
      if (path.startsWith(`${freshFake.workspace}/`)) {
        return { exitCode: 0, stdout: await readFile(path, "utf8"), stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "Operation not permitted" };
    }
    if (executable === "/usr/bin/touch") {
      const path = argv[1] ?? "";
      if (path.startsWith(`${freshFake.workspace}/`)) {
        await writeFile(path, "");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "Operation not permitted" };
    }
    if (executable === "/usr/bin/env") {
      if (scenario.externalHardlink === "create-fails") {
        const hostHome = join(dirname(freshFake.workspace), "host-home");
        await rm(hostHome, { recursive: true, force: true });
        await writeFile(hostHome, "blocks external canary creation\n", { mode: 0o600 });
      }
      return {
        exitCode: 0,
        stdout: `HOME=${join(freshFake.workspace, ".agent-home")}\n` +
          `TMPDIR=${join(freshFake.workspace, ".agent-tmp")}\n`,
        stderr: "",
      };
    }
    if (executable === "/bin/ln") {
      const source = argv[1] ?? "";
      const target = argv[2] ?? "";
      if (source.includes(".livis-hardlink-control-source-")) {
        await link(source, target);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (scenario.externalHardlink === "created") {
        await link(source, target);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (scenario.externalHardlink === "wrong-target") {
        await writeFile(target, "do-not-delete-replacement\n", { mode: 0o600 });
        return { exitCode: 1, stdout: "", stderr: "Operation not permitted" };
      }
      if (scenario.externalHardlink === "denied-command-drift") {
        await writeFile(command, "#!/bin/sh\necho drift\n", { mode: 0o700 });
      }
      return { exitCode: 1, stdout: "", stderr: "Operation not permitted" };
    }
    if (executable === "/usr/bin/nc") {
      if (
        JSON.stringify(argv.slice(0, -2)) !== JSON.stringify([
          "/usr/bin/nc",
          "-4",
          "-n",
          "-O",
          "-G",
          "1",
          "-v",
          "-z",
        ]) ||
        argv.at(-2) !== "127.0.0.1"
      ) {
        throw new Error(`fake app-server 收到不安全的 nc argv：${JSON.stringify(argv)}`);
      }
      observedNetworkPort = Number(argv.at(-1));
      if (scenario.network === "connected") {
        loopbackAccepts += 1;
        return { exitCode: 0, stdout: "", stderr: "Connection succeeded\n" };
      }
      if (scenario.network === "timeout") {
        return { exitCode: 124, stdout: "", stderr: "synthetic timeout" };
      }
      if (scenario.network === "nc-unavailable") {
        return { exitCode: 127, stdout: "", stderr: "/usr/bin/nc: not found\n" };
      }
      const errno = scenario.network === "eacces"
        ? 13
        : scenario.network === "other-errno"
          ? 61
          : 1;
      const outputPort = scenario.network === "wrong-endpoint"
        ? observedNetworkPort + 1
        : observedNetworkPort;
      const errorText = errno === 1
        ? "Operation not permitted"
        : errno === 13
          ? "Permission denied"
          : "Connection refused";
      let stderr =
        `nc: connect to 127.0.0.1 port ${outputPort} (tcp) failed: ${errorText}\n`;
      if (scenario.network === "extra-stderr") stderr += "unexpected extra output\n";
      return {
        exitCode: 1,
        stdout: scenario.network === "stdout-noise"
          ? `unexpected stdout\nerror = 0 ${errno} \n`
          : `error = 0 ${errno} \n`,
        stderr,
      };
    }
    throw new Error(`fake app-server 收到未覆盖的 command/exec：${JSON.stringify(argv)}`);
  };
  let spawnCount = 0;
  const smokeSpawn: CodexAppServerSpawn = (argv, options) => {
    const fake = spawnCount++ === 0 ? freshFake : resumedFake;
    if (fake === resumedFake) {
      resumedFake.threadId = freshFake.threadId;
      resumedFake.rolloutPath = freshFake.rolloutPath;
    }
    return fake.spawn(argv, options);
  };
  return {
    run: () => runCodexAppServerLocalSmoke({
      command,
      model: null,
      provider: OPENAI_PROVIDER,
      createStateDir: stateDir,
      verifyReadIsolation: true,
      requestTimeoutMs: 1_000,
      shutdownTimeoutMs: 1_000,
    }, {
      appServerSpawn: smokeSpawn,
      commandRunner: successfulVersion,
      ...(scenario.useDefaultStateDirAsserter === true
        ? {}
        : { readIsolationStateDirAsserter: async () => undefined }),
      loopbackProbeFactory: () => ({
        port: 43_123,
        acceptCount: () => loopbackAccepts,
        connectControl: async () => {
          if (scenario.network !== "host-control-fails") loopbackAccepts += 1;
        },
        waitForAcceptCount: async (expected) => {
          if (
            scenario.network === "delayed-connected" &&
            expected === 2 &&
            loopbackAccepts === 1
          ) {
            loopbackAccepts += 1;
          }
          return loopbackAccepts >= expected;
        },
        stop: () => {
          loopbackStopped = true;
        },
      }),
      canaryFileCreatedObserver: (path) => createdCanaryPaths.push(path),
    }),
    stateDir,
    networkPort: () => observedNetworkPort,
    loopbackStopped: () => loopbackStopped,
    createdCanaryPaths: () => createdCanaryPaths,
    cleanup: async () => {
      await Promise.all([freshFake.stop(0), resumedFake.stop(0)]);
      await Promise.all([commandDirectory.cleanup(), stateParent.cleanup()]);
    },
  };
}

async function listHardlinkCanaryFiles(stateDir: string): Promise<string[]> {
  const entries = await readdir(stateDir, { recursive: true });
  return entries
    .map(String)
    .filter((entry) => entry.includes(".livis-hardlink-"));
}

describe("CodexExecutionBackend", () => {
  test("account/read 区分上游账号类型，requiresOpenaiAuth 不是登录状态", () => {
    expect(inspectCodexAccountResponse({
      account: { type: "apiKey" },
      requiresOpenaiAuth: true,
    })).toEqual({
      requiresOpenaiAuth: true,
      accountType: "apiKey",
      accountSubjectSha256: null,
      identityStrength: "type-only",
    });
    expect(inspectCodexAccountResponse({
      account: { type: "chatgpt", email: " User@Example.COM " },
      requiresOpenaiAuth: true,
    })).toEqual({
      requiresOpenaiAuth: true,
      accountType: "chatgpt",
      accountSubjectSha256: sha256(JSON.stringify(["chatgpt", "user@example.com"])),
      identityStrength: "subject",
    });
    expect(inspectCodexAccountResponse({
      account: { type: "amazonBedrock", credentialSource: "awsManaged" },
      requiresOpenaiAuth: false,
    })).toEqual({
      requiresOpenaiAuth: false,
      accountType: "amazonBedrock",
      accountSubjectSha256: null,
      identityStrength: "type-only",
    });
    expect(inspectCodexAccountResponse({
      account: null,
      requiresOpenaiAuth: false,
    })).toEqual({
      requiresOpenaiAuth: false,
      accountType: null,
      accountSubjectSha256: null,
      identityStrength: null,
    });
    const sensitiveAccountType = "sensitive-account-type-must-not-leak";
    let unknownAccountError: unknown = null;
    try {
      inspectCodexAccountResponse({
        account: { type: sensitiveAccountType },
        requiresOpenaiAuth: true,
      });
    } catch (error) {
      unknownAccountError = error;
    }
    expect(unknownAccountError).toBeInstanceOf(Error);
    expect((unknownAccountError as Error).message).toBe("Codex account.type 未经审核");
    expect((unknownAccountError as Error).message).not.toContain(sensitiveAccountType);
    expect(() => inspectCodexAccountResponse({
      account: null,
      requiresOpenaiAuth: null,
    })).toThrow("requiresOpenaiAuth 必须是布尔值");
  });

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
        model: null,
        provider: OPENAI_PROVIDER,
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
        effectiveModel: "gpt-5.6-sol",
        modelProvider: "openai",
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

  test("smoke 显式 state 在创建 thread 前拒绝非 API key account", async () => {
    const commandDirectory = await temporaryDirectory("livis-codex-smoke-command-");
    const stateParent = await temporaryDirectory("livis-codex-smoke-account-policy-");
    const command = `${commandDirectory.path}/codex`;
    const stateDir = join(await realpath(stateParent.path), "state");
    await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const fake = new FakeCodexAppServer();
    fake.account = {
      type: "chatgpt",
      email: "sensitive-smoke-account-must-not-leak@example.invalid",
      planType: "plus",
    };
    try {
      await expect(runCodexAppServerLocalSmoke({
        command,
        model: null,
        provider: OPENAI_PROVIDER,
        createStateDir: stateDir,
        requestTimeoutMs: 1_000,
        shutdownTimeoutMs: 1_000,
      }, {
        appServerSpawn: fake.spawn,
        commandRunner: successfulVersion,
      })).rejects.toThrow("Codex smoke 只允许未登录或 API key account");
      expect(fake.messages.some((message) => message.method === "permissionProfile/list"))
        .toBeFalse();
      expect(fake.messages.some((message) => message.method === "thread/start")).toBeFalse();
      expect(fake.messages.some((message) => message.method === "turn/start")).toBeFalse();
    } finally {
      await fake.stop(0);
      await Promise.all([commandDirectory.cleanup(), stateParent.cleanup()]);
    }
  });

  for (const network of ["eperm", "eacces"] as const) {
    test(`读取隔离 smoke 接受 ${network.toUpperCase()} 并清理全部 hardlink 牺牲文件`, async () => {
      const harness = await createReadIsolationSmokeHarness({
        externalHardlink: "denied",
        network,
      });
      try {
        const report = await harness.run();
        expect(report.readIsolationCanary).toEqual({
          stateDirOutsideTemporaryRoots: true,
          workspaceRead: true,
          workspaceWrite: true,
          agentHomeWrite: true,
          agentTmpWrite: true,
          agentEnvironmentPinned: true,
          codexHomeReadDenied: true,
          codexHomeWriteDenied: true,
          hostHomeReadDenied: true,
          hostHomeWriteDenied: true,
          hostTmpReadDenied: true,
          hostTmpWriteDenied: true,
          sensitiveEnvironmentHidden: true,
          workspaceHardlinkControlPassed: true,
          externalFileHardlinkDenied: true,
          externalFileIdentityStable: true,
          commandIdentityStable: true,
          loopbackEndpointReachable: true,
          systemNcProbeAvailable: true,
          toolNetworkPermissionDenied: true,
        });
        expect(await listHardlinkCanaryFiles(harness.stateDir)).toEqual([]);
      } finally {
        await harness.cleanup();
      }
    });
  }

  test("读取隔离 smoke 拒绝已实际创建的外部 hardlink 并完整清理", async () => {
    const harness = await createReadIsolationSmokeHarness({
      externalHardlink: "created",
      network: "eperm",
    });
    try {
      await expect(harness.run()).rejects.toThrow("允许把 workspace 外文件 hardlink");
      expect(await listHardlinkCanaryFiles(harness.stateDir)).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  test("第二个牺牲文件创建失败时仍清理第一个 workspace source", async () => {
    const harness = await createReadIsolationSmokeHarness({
      externalHardlink: "create-fails",
      network: "eperm",
    });
    try {
      await expect(harness.run()).rejects.toThrow("ENOTDIR");
      expect(harness.createdCanaryPaths()).toHaveLength(1);
      expect(harness.createdCanaryPaths()[0]).toContain(".livis-hardlink-control-source-");
      expect(await listHardlinkCanaryFiles(harness.stateDir)).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  test("hardlink 探针期间 command identity 漂移会拒绝且仍完整清理", async () => {
    const harness = await createReadIsolationSmokeHarness({
      externalHardlink: "denied-command-drift",
      network: "eperm",
    });
    try {
      await expect(harness.run()).rejects.toThrow("文件身份或内容摘要已漂移");
      expect(await listHardlinkCanaryFiles(harness.stateDir)).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  test("读取隔离 smoke 在 target 身份漂移时不误删并上抛 cleanup 失败", async () => {
    const harness = await createReadIsolationSmokeHarness({
      externalHardlink: "wrong-target",
      network: "eperm",
    });
    try {
      await expect(harness.run()).rejects.toThrow("牺牲文件未完整清理");
      const residual = await listHardlinkCanaryFiles(harness.stateDir);
      expect(residual).toHaveLength(1);
      expect(residual[0]).toContain(".livis-hardlink-external-target-");
      expect(await readFile(join(harness.stateDir, residual[0]!), "utf8"))
        .toBe("do-not-delete-replacement\n");
    } finally {
      await harness.cleanup();
    }
  });

  test("读取隔离 smoke 拒绝 TCP 命中、延迟命中、普通 errno 与不完整 nc 输出", async () => {
    for (const network of [
      "connected",
      "delayed-connected",
      "other-errno",
      "timeout",
      "extra-stderr",
      "stdout-noise",
      "wrong-endpoint",
    ] as const) {
      const harness = await createReadIsolationSmokeHarness({
        externalHardlink: "denied",
        network,
      });
      try {
        await expect(harness.run()).rejects.toThrow("未得到明确 EPERM/EACCES");
        expect(harness.networkPort()).not.toBeNull();
        expect(harness.loopbackStopped()).toBeTrue();
        expect(await listHardlinkCanaryFiles(harness.stateDir)).toEqual([]);
      } finally {
        await harness.cleanup();
      }
    }
  });

  test("读取隔离 smoke 在系统 nc 不可用时拒绝裁决", async () => {
    const harness = await createReadIsolationSmokeHarness({
      externalHardlink: "denied",
      network: "nc-unavailable",
    });
    try {
      await expect(harness.run()).rejects.toThrow("未得到明确 EPERM/EACCES");
      expect(harness.loopbackStopped()).toBeTrue();
      expect(await listHardlinkCanaryFiles(harness.stateDir)).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  test("读取隔离 smoke 默认拒绝系统临时目录", async () => {
    const harness = await createReadIsolationSmokeHarness({
      externalHardlink: "denied",
      network: "eperm",
      useDefaultStateDirAsserter: true,
    });
    try {
      await expect(harness.run()).rejects.toThrow("不能位于系统临时目录");
      expect(harness.createdCanaryPaths()).toEqual([]);
      expect(await listHardlinkCanaryFiles(harness.stateDir)).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  test("读取隔离 smoke 在 host loopback 正向 control 失败时拒绝裁决并关闭 listener", async () => {
    const harness = await createReadIsolationSmokeHarness({
      externalHardlink: "denied",
      network: "host-control-fails",
    });
    try {
      await expect(harness.run()).rejects.toThrow("host TCP 正向 control 失败");
      expect(harness.networkPort()).toBeNull();
      expect(harness.loopbackStopped()).toBeTrue();
      expect(await listHardlinkCanaryFiles(harness.stateDir)).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  test("版本探针后 command identity 漂移时不启动 app-server", async () => {
    let versionProbeCompleted = false;
    let identityChecks = 0;
    const fake = new FakeCodexAppServer();
    const harness = await createHarness({
      start: false,
      fake,
      commandRunner: async () => {
        versionProbeCompleted = true;
        return { exitCode: 0, stdout: "codex-cli 0.145.0\n", stderr: "" };
      },
      commandPinAsserter: async () => {
        identityChecks += 1;
        if (versionProbeCompleted) throw new Error("synthetic command identity drift");
      },
    });
    try {
      await expect(harness.backend.start()).rejects.toThrow("command identity drift");
      expect(identityChecks).toBe(1);
      expect(fake.messages).toEqual([]);
      expect(harness.backend.ready).toBeFalse();
    } finally {
      await harness.cleanup();
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

  test("初次 start 的 ready 交接尚未完成时退出，不得并发启动 idle recovery", async () => {
    const readyGate = deferred<void>();
    const initial = new FakeCodexAppServer();
    const sequence = new FakeCodexAppServerSequence([
      initial,
      new FakeCodexAppServer(),
    ]);
    const harness = await createHarness({
      start: false,
      fake: initial,
      appServerSpawn: sequence.spawn,
      readyGate: readyGate.promise,
      recoveryDelaysMs: [0, 0, 0],
    });
    try {
      const startPromise = harness.backend.start();
      await waitFor(() => harness.events.includes("ready"), "initial ready handler");
      await initial.stop(38);
      readyGate.resolve();

      await expect(startPromise).rejects.toThrow(/ready handler 期间失效/);
      await Bun.sleep(10);
      expect(sequence.spawnCount).toBe(1);
      expect(harness.backend.status()).toMatchObject({ state: "failed", ready: false });
      expect(harness.disconnects).toEqual([]);
    } finally {
      readyGate.resolve();
      await harness.cleanup();
    }
  });

  test("初次 initialize 失败且进程组收口未确认时持久 quarantine", async () => {
    const initial = new FakeCodexAppServer();
    initial.holdMethod = "initialize";
    initial.ignoreKill = true;
    const harness = await createHarness({
      start: false,
      fake: initial,
      requestTimeoutMs: 20,
      shutdownTimeoutMs: 20,
    });
    try {
      const startPromise = harness.backend.start();
      await waitFor(
        () => initial.messages.some((message) => message.method === "initialize"),
        "initial initialize",
      );
      await expect(startPromise).rejects.toThrow(/初始化失败且进程组收口未确认/);
      expect(harness.store.getSessionQuarantine("livis:agent-test")).not.toBeNull();
      await expect(harness.backend.stop()).rejects.toThrow(/进程组收口|初始化/);
    } finally {
      initial.ignoreKill = false;
      initial.heldMethod.resolve({});
      await initial.stop(0);
      await harness.cleanup();
    }
  });

  test("初次 spawn 后无法取得进程组所有权时持久 quarantine", async () => {
    const harness = await createHarness({
      start: false,
      appServerSpawn: () => {
        throw new CodexAppServerProcessOwnershipUnconfirmedError();
      },
    });
    try {
      await expect(harness.backend.start()).rejects.toThrow(/进程组所有权/);
      expect(harness.store.getSessionQuarantine("livis:agent-test")).not.toBeNull();
      await expect(harness.backend.stop()).rejects.toThrow(/进程组收口|所有权/);
    } finally {
      await harness.cleanup();
    }
  });

  test("初次 ready 交接中 child 退出且进程组不收口时持久 quarantine", async () => {
    const readyGate = deferred<void>();
    const initial = new FakeCodexAppServer();
    initial.ignoreKill = true;
    const harness = await createHarness({
      start: false,
      fake: initial,
      readyGate: readyGate.promise,
      shutdownTimeoutMs: 20,
    });
    try {
      const startPromise = harness.backend.start();
      await waitFor(() => harness.events.includes("ready"), "initial ready close fence");
      initial.exitWithoutClosingStreams(41);
      readyGate.resolve();

      await expect(startPromise).rejects.toThrow(/进程组收口未确认/);
      expect(harness.store.getSessionQuarantine("livis:agent-test")).not.toBeNull();
      await expect(harness.backend.stop()).rejects.toThrow(/进程组收口/);
    } finally {
      readyGate.resolve();
      initial.ignoreKill = false;
      await initial.stop(0);
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
        provider: OPENAI_PROVIDER,
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
        commandPinResolver: fakeCommandPinResolver,
        commandPinAsserter: fakeCommandPinAsserter,
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

  test("daemon 重启时 command 持久安全绑定漂移会在版本探针前 quarantine", async () => {
    const harness = await createHarness();
    const resumedFake = new FakeCodexAppServer();
    let restarted: CodexExecutionBackend | null = null;
    let versionProbeCount = 0;
    try {
      await harness.backend.stop();
      const driftedPin = {
        ...fakeCommandPin(),
        contentSha256: sha256("drifted-fake-codex-command"),
        identitySha256: sha256("drifted-fake-codex-command-identity"),
      };
      restarted = new CodexExecutionBackend({
        stateDir: harness.directory.path,
        scopeKey: "scope-test",
        sessionKey: "livis:agent-test",
        remoteNodeId: "node-1",
        command: "/test/bin/codex",
        model: null,
        provider: OPENAI_PROVIDER,
        maxOutputChars: 1_048_576,
        requestTimeoutMs: 100,
        turnTimeoutMs: 5_000,
        interruptGraceMs: 25,
        shutdownTimeoutMs: 100,
      }, {
        store: harness.store,
        handlers: harness.handlers,
        appServerSpawn: resumedFake.spawn,
        commandRunner: async () => {
          versionProbeCount += 1;
          return successfulVersion([], { cwd: "", env: {}, timeoutMs: 1 });
        },
        commandPinResolver: async () => driftedPin,
        commandPinAsserter: fakeCommandPinAsserter,
      });

      await expect(restarted.start()).rejects.toThrow("release session");
      expect(versionProbeCount).toBe(0);
      expect(resumedFake.messages).toEqual([]);
      expect(harness.store.getSessionQuarantine("livis:agent-test")?.reason)
        .toContain("command 文件身份");
      expect(harness.store.releaseSessionRecovery("livis:agent-test")).toBeTrue();
      expect(harness.store.getBackendSession("codex", "livis:agent-test")).toBeNull();
    } finally {
      await restarted?.stop().catch(() => undefined);
      await resumedFake.stop(0);
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
        expected: "未归属的活动 turn",
      },
      {
        status: "idle" as const,
        turns: [{ id: "external-completed", status: "completed" }],
        expected: "持久 checkpoint 不一致",
      },
      {
        status: "systemError" as const,
        turns: [{ id: "external-failed", status: "failed" }],
        expected: "不是 idle",
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

  test("生产 backend 接受 API key account 与 requiresOpenaiAuth=true", async () => {
    const harness = await createHarness({
      configureFake: (fake) => {
        fake.account = { type: "apiKey" };
        fake.requiresOpenaiAuth = true;
      },
    });
    try {
      expect(harness.backend.ready).toBeTrue();
      expect(harness.store.getBackendSession("codex", "livis:agent-test")).toMatchObject({
        accountType: "apiKey",
        accountIdentityStrength: "type-only",
      });
      expect(harness.fake.messages.some((message) => message.method === "thread/start")).toBeTrue();
      expect(harness.fake.messages.some((message) => message.method === "turn/start")).toBeFalse();
    } finally {
      await harness.cleanup();
    }
  });

  test("生产 backend 拒绝 requiresOpenaiAuth=false 的 API key account", async () => {
    const harness = await createHarness({
      start: false,
      configureFake: (fake) => {
        fake.account = { type: "apiKey" };
        fake.requiresOpenaiAuth = false;
      },
    });
    try {
      await expect(harness.backend.start()).rejects.toThrow("requiresOpenaiAuth=true");
      expect(harness.fake.messages.some((message) => message.method === "permissionProfile/list"))
        .toBeFalse();
      expect(harness.fake.messages.some((message) => message.method === "thread/start"))
        .toBeFalse();
      expect(harness.fake.messages.some((message) => message.method === "thread/resume"))
        .toBeFalse();
      expect(harness.store.getBackendSession("codex", "livis:agent-test")).toBeNull();
      expect(harness.backend.ready).toBeFalse();
    } finally {
      await harness.cleanup();
    }
  });

  test("custom provider 首次启动只接受固定 provider ID 并回读 model", async () => {
    const harness = await createHarness({
      provider: CUSTOM_PROVIDER,
      model: "custom-model",
    });
    try {
      expect(harness.backend.status()).toMatchObject({
        ready: true,
        requestedModel: "custom-model",
        effectiveModel: "custom-model",
        modelProvider: CUSTOM_PROVIDER_ID,
      });
      expect(harness.store.getBackendSession("codex", "livis:agent-test")).toMatchObject({
        requestedModel: "custom-model",
        effectiveModel: "custom-model",
        modelProvider: CUSTOM_PROVIDER_ID,
      });
      expect(harness.fake.messages.find((message) => message.method === "thread/start")?.params)
        .toMatchObject({ model: "custom-model" });
      const config = await Bun.file(
        join(harness.directory.path, "backends", "codex", "home", "config.toml"),
      ).text();
      expect(config).toContain(`model_provider = "${CUSTOM_PROVIDER_ID}"`);
      expect(config).toContain(`base_url = ${JSON.stringify(CUSTOM_PROVIDER.baseUrl)}`);
    } finally {
      await harness.cleanup();
    }
  });

  test("custom provider 首次 thread 回读 provider 不匹配时 quarantine", async () => {
    const harness = await createHarness({
      start: false,
      provider: CUSTOM_PROVIDER,
      model: "custom-model",
      configureFake: (fake) => {
        fake.modelProvider = "openai";
      },
    });
    try {
      await expect(harness.backend.start()).rejects.toThrow("固定 provider");
      expect(harness.fake.messages.some((message) => message.method === "thread/start")).toBeTrue();
      expect(harness.fake.messages.some((message) => message.method === "turn/start")).toBeFalse();
      expect(harness.store.getSessionQuarantine("livis:agent-test")).not.toBeNull();
      expect(harness.backend.ready).toBeFalse();
    } finally {
      await harness.cleanup();
    }
  });

  for (const accountType of ["chatgpt", "amazonBedrock"] as const) {
    test(`生产 backend 在创建 thread 前拒绝非 API key account：${accountType}`, async () => {
      const sensitiveAccountField = `sensitive-${accountType}-field-must-not-leak`;
      const harness = await createHarness({
        start: false,
        configureFake: (fake) => {
          fake.account = accountType === "chatgpt"
            ? { type: accountType, email: sensitiveAccountField, planType: "plus" }
            : { type: accountType, credentialSource: sensitiveAccountField };
          fake.requiresOpenaiAuth = accountType === "chatgpt";
        },
      });
      try {
        await expect(harness.backend.start()).rejects.toThrow(
          "Codex 私有 CODEX_HOME 只允许 API key account",
        );
        expect(
          harness.fake.messages.some((message) => message.method === "permissionProfile/list"),
        ).toBeFalse();
        expect(harness.fake.messages.some((message) => message.method === "thread/start"))
          .toBeFalse();
        expect(harness.fake.messages.some((message) => message.method === "thread/resume"))
          .toBeFalse();
        expect(harness.fake.messages.some((message) => message.method === "turn/start"))
          .toBeFalse();
        expect(harness.store.getBackendSession("codex", "livis:agent-test")).toBeNull();
        expect(harness.events).toEqual([]);
        expect(harness.logs.join("\n")).not.toContain(sensitiveAccountField);
        expect(harness.backend.ready).toBeFalse();
      } finally {
        await harness.cleanup();
      }
    });
  }

  test("account=null 即使 requiresOpenaiAuth=false 仍拒绝生产启动", async () => {
    const harness = await createHarness({
      start: false,
      configureFake: (fake) => {
        fake.account = null;
        fake.requiresOpenaiAuth = false;
      },
    });
    try {
      await expect(harness.backend.start()).rejects.toThrow(
        "Codex 私有 CODEX_HOME account 必须是对象",
      );
      expect(harness.fake.messages.some((message) => message.method === "thread/start")).toBeFalse();
      expect(harness.fake.messages.some((message) => message.method === "thread/resume")).toBeFalse();
      expect(harness.fake.messages.some((message) => message.method === "turn/start")).toBeFalse();
      expect(harness.events).toEqual([]);
      expect(harness.store.getBackendSession("codex", "livis:agent-test")).toBeNull();
      expect(harness.backend.ready).toBeFalse();
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
        accountType: "apiKey",
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

  test("completed terminal 不得以 systemError thread 状态交付结果", async () => {
    const harness = await createHarness({
      configureFake: (fake) => {
        fake.completedTerminalThreadStatus = "systemError";
      },
    });
    try {
      const job = claimJob(harness, "job-completed-system-error");
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
                id: "m-invalid-system-error",
                text: "不得交付",
                phase: "final_answer",
              },
            ],
          },
        },
      });
      await waitFor(() => harness.disconnects.length === 1, "completed systemError disconnect");
      expect(harness.results).toEqual([]);
      expect(harness.store.require(job.jobId).status).toBe("Interrupted");
      expect(harness.store.getBackendSession("codex", "livis:agent-test")?.recoveryRequired)
        .toBeTrue();
      expect(harness.store.getSessionQuarantine("livis:agent-test")).not.toBeNull();
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

  test("dispatch 前 API key account policy 锚点漂移时隔离并关闭 backend", async () => {
    const harness = await createHarness();
    try {
      const job = claimJob(harness, "job-account-policy-drift");
      Object.assign(harness.backend, { accountType: "chatgpt" });

      expect(await harness.backend.dispatch(job)).toBe("not_sent");
      expect(harness.fake.messages.some((message) => message.method === "turn/start")).toBeFalse();
      expect(harness.store.require(job.jobId).status).toBe("Dispatching");
      expect(harness.store.getSessionQuarantine("livis:agent-test")?.reason)
        .toContain("API key account policy 锚点漂移");
      expect(harness.backend.ready).toBeFalse();
      expect(harness.backend.status().active).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  test("dispatch 前重新回读 account，运行中切换为 ChatGPT 时不发送 turn/start", async () => {
    const harness = await createHarness();
    const sensitiveAccountField = "runtime-account-drift-must-not-leak@example.invalid";
    try {
      const job = claimJob(harness, "job-runtime-account-policy-drift");
      harness.fake.account = {
        type: "chatgpt",
        email: sensitiveAccountField,
        planType: "plus",
      };

      expect(await harness.backend.dispatch(job)).toBe("not_sent");
      expect(harness.fake.messages.some((message) => message.method === "turn/start")).toBeFalse();
      expect(harness.store.require(job.jobId).status).toBe("Dispatching");
      expect(harness.store.getSessionQuarantine("livis:agent-test")?.reason)
        .toContain("API key account policy 回读失败");
      expect(harness.logs.join("\n")).not.toContain(sensitiveAccountField);
      expect(harness.backend.ready).toBeFalse();
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

  test("cancel 与 failed systemError 竞态保持 CancelUnknown 且不生成失败结果", async () => {
    const harness = await createHarness({
      configureFake: (fake) => {
        fake.autoInterruptTerminal = false;
        fake.failedTerminalThreadStatus = "systemError";
      },
    });
    try {
      const job = claimJob(harness, "job-cancel-failed-system-error");
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
            status: "failed",
            error: { message: "provider failed", codexErrorInfo: "other" },
            items: [],
          },
        },
      });
      await waitFor(
        () => harness.events.includes("cancelled:job-cancel-failed-system-error"),
        "cancel failed systemError terminal",
      );

      expect(harness.store.require(job.jobId).status).toBe("CancelUnknown");
      expect(harness.failures).toEqual([]);
      expect(harness.store.require(job.jobId).outbox).toBeNull();
      expect(harness.store.getBackendSession("codex", "livis:agent-test")).toMatchObject({
        checkpointTurnId: "019f-turn-1",
        checkpointTurnStatus: "failed",
        checkpointTurnCount: 1,
        recoveryRequired: true,
      });
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

  test("活动 turn 中 app-server 退出不会自动恢复，并保留 Interrupted recovery evidence", async () => {
    const initial = new FakeCodexAppServer();
    const sequence = new FakeCodexAppServerSequence([
      initial,
      new FakeCodexAppServer(),
    ]);
    const harness = await createHarness({
      fake: initial,
      appServerSpawn: sequence.spawn,
      recoveryDelaysMs: [0, 0, 0],
    });
    try {
      const job = claimJob(harness, "job-exit");
      await harness.backend.dispatch(job);
      await initial.stop(23);
      await waitFor(() => harness.disconnects.length === 1, "process exit disconnect");
      expect(harness.store.require(job.jobId).status).toBe("Interrupted");
      const session = harness.store.getBackendSession("codex", "livis:agent-test");
      expect(session?.activeTurnId).toBe("019f-turn-1");
      expect(session?.recoveryRequired).toBeTrue();
      await Bun.sleep(10);
      expect(sequence.spawnCount).toBe(1);
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal checkpoint transport 退出不会把 app-server stderr 写入 Store 或日志", async () => {
    const fake = new FakeCodexAppServer();
    const harness = await createHarness({ fake });
    const sensitiveStderr = "PROVIDER_STDERR_SECRET_SENTINEL";
    try {
      const job = claimJob(harness, "job-terminal-transport-sensitive");
      await harness.backend.dispatch(job);
      const threadReadsBefore = fake.messages
        .filter((message) => message.method === "thread/read").length;
      fake.holdMethod = "thread/read";
      await fake.send({
        method: "turn/completed",
        params: {
          threadId: fake.threadId,
          turn: {
            id: "019f-turn-1",
            status: "failed",
            error: { message: "provider failed", codexErrorInfo: "other" },
            items: [],
          },
        },
      });
      await waitFor(
        () => fake.messages.filter((message) => message.method === "thread/read").length >
          threadReadsBefore,
        "terminal checkpoint thread/read",
      );
      await fake.writeStderr(sensitiveStderr);
      fake.exitWithoutClosingStreams(47);

      await waitFor(() => harness.disconnects.length === 1, "sensitive transport disconnect");
      expect(harness.store.require(job.jobId).status).toBe("Interrupted");
      expect(harness.store.require(job.jobId).error).not.toContain(sensitiveStderr);
      expect(harness.disconnects.join("\n")).not.toContain(sensitiveStderr);
      expect(harness.logs.join("\n")).not.toContain(sensitiveStderr);
      expect(harness.store.listExecutionAttemptEvents(job.jobId)
        .some((event) => event.reason?.includes(sensitiveStderr))).toBeFalse();
      expect(harness.store.getSessionQuarantine("livis:agent-test")?.reason)
        .not.toContain(sensitiveStderr);
      for (const name of (await readdir(harness.directory.path))
        .filter((entry) => entry.startsWith("relay.db"))) {
        expect((await readFile(join(harness.directory.path, name))).includes(sensitiveStderr))
          .toBeFalse();
      }
    } finally {
      fake.heldMethod.resolve({ thread: fake.threadResponse({}).thread });
      await fake.stop(0);
      await harness.cleanup();
    }
  });

  test("terminal checkpoint RPC error 不会把 message/data 写入 Store 或日志", async () => {
    const fake = new FakeCodexAppServer();
    const harness = await createHarness({ fake });
    const messageSensitive = "RPC_MESSAGE_STORE_SENSITIVE_SENTINEL";
    const dataSensitive = "RPC_DATA_STORE_SENSITIVE_SENTINEL";
    try {
      const job = claimJob(harness, "job-terminal-rpc-sensitive");
      await harness.backend.dispatch(job);
      fake.rpcErrorMethod = "thread/read";
      fake.rpcError = {
        code: -32_001,
        message: messageSensitive,
        data: { detail: dataSensitive },
      };
      await fake.send({
        method: "turn/completed",
        params: {
          threadId: fake.threadId,
          turn: {
            id: "019f-turn-1",
            status: "failed",
            error: { message: "provider failed", codexErrorInfo: "other" },
            items: [],
          },
        },
      });

      await waitFor(() => harness.disconnects.length === 1, "sensitive RPC disconnect");
      expect(harness.store.require(job.jobId).status).toBe("Interrupted");
      expect(harness.store.require(job.jobId).error).not.toContain(messageSensitive);
      expect(harness.disconnects.join("\n")).not.toContain(messageSensitive);
      expect(harness.disconnects.join("\n")).not.toContain(dataSensitive);
      expect(harness.logs.join("\n")).not.toContain(messageSensitive);
      expect(harness.logs.join("\n")).not.toContain(dataSensitive);
      expect(harness.store.listExecutionAttemptEvents(job.jobId)
        .some((event) =>
          event.reason?.includes(messageSensitive) || event.reason?.includes(dataSensitive)
        )).toBeFalse();
      expect(harness.store.getSessionQuarantine("livis:agent-test")?.reason)
        .not.toContain(messageSensitive);
      for (const name of (await readdir(harness.directory.path))
        .filter((entry) => entry.startsWith("relay.db"))) {
        const bytes = await readFile(join(harness.directory.path, name));
        expect(bytes.includes(messageSensitive)).toBeFalse();
        expect(bytes.includes(dataSensitive)).toBeFalse();
      }
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
      expect(harness.failures).toEqual(["Codex turn 执行失败"]);
      expect(harness.results).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  test("failed + systemError 脱敏结算并阻断已被拒绝的隔离凭据副本", async () => {
    const harness = await createHarness({
      configureFake: (fake) => {
        fake.failedTerminalThreadStatus = "systemError";
        fake.legacyFailedTurnReadbackAsCompleted = true;
      },
    });
    try {
      const failedJob = claimJob(harness, "job-system-error", "触发 provider 失败");
      await harness.backend.dispatch(failedJob);
      const messageSensitive = "sk-message-sensitive-sentinel";
      const detailsSensitive = "account-details-sensitive-sentinel";
      await harness.fake.send({
        method: "turn/completed",
        params: {
          threadId: harness.fake.threadId,
          turn: {
            id: "019f-turn-1",
            status: "failed",
            error: {
              message: `unexpected status 401 Unauthorized: Incorrect API key provided: ${messageSensitive}; invalid_api_key`,
              codexErrorInfo: "other",
              additionalDetails: detailsSensitive,
            },
            items: [],
          },
        },
      });

      await waitFor(
        () => harness.store.require(failedJob.jobId).status === "Failed",
        "systemError failed terminal",
      );
      expect(harness.failures).toEqual([
        "Codex provider 认证失败（401 invalid_api_key）",
      ]);
      expect(harness.store.require(failedJob.jobId)).toMatchObject({
        status: "Failed",
        error: "Codex provider 认证失败（401 invalid_api_key）",
        outbox: { status: "Pending", resultJson: serializeResult("Codex failed") },
      });
      const attemptEvents = harness.store.listExecutionAttemptEvents(failedJob.jobId);
      expect(attemptEvents.map((event) => event.eventType))
        .toEqual(["reserved", "accepted", "failed"]);
      expect(attemptEvents.at(-1)?.reason).toBe("Codex provider 认证失败（401 invalid_api_key）");
      expect(harness.store.getBackendSession("codex", "livis:agent-test")).toMatchObject({
        activeJobId: null,
        recoveryRequired: false,
        checkpointTurnId: "019f-turn-1",
        checkpointTurnStatus: "failed",
        checkpointTurnCount: 1,
      });
      expect(harness.fake.turns).toEqual([{ id: "019f-turn-1", status: "completed" }]);
      expect(harness.store.getSessionQuarantine("livis:agent-test")?.reason)
        .toBe(
          "Codex provider 拒绝当前隔离凭据；禁止继续发送 turn，需修复专用凭据并人工 release session",
        );
      expect(harness.disconnects).toEqual([]);
      expect(harness.backend.ready).toBeFalse();
      expect(harness.logs.join("\n")).not.toContain(messageSensitive);
      expect(harness.logs.join("\n")).not.toContain(detailsSensitive);

      for (const name of (await readdir(harness.directory.path))
        .filter((entry) => entry.startsWith("relay.db"))) {
        const bytes = await readFile(join(harness.directory.path, name));
        expect(bytes.includes(messageSensitive)).toBeFalse();
        expect(bytes.includes(detailsSensitive)).toBeFalse();
      }
    } finally {
      await harness.cleanup();
    }
  });

  test("0.145 legacy completed tail 缺少 systemError 见证时仍失败关闭", async () => {
    const harness = await createHarness({
      configureFake: (fake) => {
        fake.failedTerminalThreadStatus = "idle";
        fake.legacyFailedTurnReadbackAsCompleted = true;
      },
    });
    try {
      const job = claimJob(harness, "job-legacy-failed-without-system-error");
      await harness.backend.dispatch(job);
      await harness.fake.send({
        method: "turn/completed",
        params: {
          threadId: harness.fake.threadId,
          turn: {
            id: "019f-turn-1",
            status: "failed",
            error: { message: "synthetic provider failure", codexErrorInfo: "other" },
            items: [],
          },
        },
      });

      await waitFor(() => harness.disconnects.length === 1, "legacy tail without systemError");
      expect(harness.failures).toEqual([]);
      expect(harness.store.require(job.jobId)).toMatchObject({
        status: "Interrupted",
        outbox: null,
      });
      expect(harness.store.getBackendSession("codex", "livis:agent-test")?.recoveryRequired)
        .toBeTrue();
      expect(harness.store.getSessionQuarantine("livis:agent-test")).not.toBeNull();
      expect(harness.fake.turns).toEqual([{ id: "019f-turn-1", status: "completed" }]);
    } finally {
      await harness.cleanup();
    }
  });

  test("0.145.1 不继承 0.145.0 的 legacy failed-tail 例外", async () => {
    const harness = await createHarness({
      commandRunner: async () => ({ exitCode: 0, stdout: "codex-cli 0.145.1", stderr: "" }),
      configureFake: (fake) => {
        fake.cliVersion = "0.145.1";
        fake.failedTerminalThreadStatus = "systemError";
        fake.legacyFailedTurnReadbackAsCompleted = true;
      },
    });
    try {
      const job = claimJob(harness, "job-legacy-projection-unreviewed-patch");
      await harness.backend.dispatch(job);
      await harness.fake.send({
        method: "turn/completed",
        params: {
          threadId: harness.fake.threadId,
          turn: {
            id: "019f-turn-1",
            status: "failed",
            error: { message: "synthetic provider failure", codexErrorInfo: "other" },
            items: [],
          },
        },
      });

      await waitFor(() => harness.disconnects.length === 1, "0.145.1 projection rejection");
      expect(harness.failures).toEqual([]);
      expect(harness.store.require(job.jobId)).toMatchObject({ status: "Interrupted", outbox: null });
      expect(harness.store.getBackendSession("codex", "livis:agent-test")?.recoveryRequired)
        .toBeTrue();
      expect(harness.store.getSessionQuarantine("livis:agent-test")).not.toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  test("凭据拒绝后的进程组收口失败会持久隔离并由 stop 传播", async () => {
    const fake = new FakeCodexAppServer();
    fake.failedTerminalThreadStatus = "systemError";
    const harness = await createHarness({ fake, shutdownTimeoutMs: 20 });
    try {
      fake.ignoreKill = true;
      const job = claimJob(harness, "job-credential-close-unconfirmed");
      await harness.backend.dispatch(job);
      await fake.send({
        method: "turn/completed",
        params: {
          threadId: fake.threadId,
          turn: {
            id: "019f-turn-1",
            status: "failed",
            error: { message: "invalid_api_key", codexErrorInfo: "unauthorized" },
            items: [],
          },
        },
      });
      await waitFor(
        () => harness.store.require(job.jobId).status === "Failed",
        "credential close failure terminal",
      );

      let stopError: unknown;
      try {
        await harness.backend.stop();
      } catch (error) {
        stopError = error;
      }
      expect(stopError).toBeInstanceOf(AggregateError);
      expect((stopError as Error).message).toContain("未确认的进程组收口");
      expect((stopError as AggregateError).errors.some((error) =>
        error instanceof Error && /凭据后无法确认.*进程组收口/.test(error.message)
      )).toBeTrue();
      expect(harness.store.getSessionQuarantine("livis:agent-test")).not.toBeNull();
      expect(harness.backend.ready).toBeFalse();
    } finally {
      fake.ignoreKill = false;
      await fake.stop(0);
      await harness.cleanup();
    }
  });

  for (const scenario of [
    {
      name: "structured unauthorized",
      error: { message: "provider rejected", codexErrorInfo: "unauthorized" },
      expected: "Codex provider 认证失败",
      credentialRejected: true,
    },
    {
      name: "HTTP 401 tagged object",
      error: {
        message: "provider rejected",
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
      },
      expected: "Codex provider 连接失败（httpConnectionFailed HTTP 401）",
      credentialRejected: true,
    },
    {
      name: "HTTP 503 tagged object",
      error: {
        message: "provider unavailable",
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
      },
      expected: "Codex provider 连接失败（httpConnectionFailed HTTP 503）",
      credentialRejected: false,
    },
    {
      name: "unknown structured error",
      error: { message: "provider details", codexErrorInfo: { futureKind: { code: 7 } } },
      expected: "Codex turn 执行失败",
      credentialRejected: false,
    },
  ] as const) {
    test(`failed 错误分类闭集：${scenario.name}`, async () => {
      const harness = await createHarness({
        configureFake: (fake) => {
          fake.failedTerminalThreadStatus = "systemError";
        },
      });
      try {
        const job = claimJob(harness, `job-classification-${scenario.name.replaceAll(" ", "-")}`);
        await harness.backend.dispatch(job);
        await harness.fake.send({
          method: "turn/completed",
          params: {
            threadId: harness.fake.threadId,
            turn: {
              id: "019f-turn-1",
              status: "failed",
              error: scenario.error,
              items: [],
            },
          },
        });
        await waitFor(
          () => harness.store.require(job.jobId).status === "Failed",
          `failed classification ${scenario.name}`,
        );
        expect(harness.failures).toEqual([scenario.expected]);
        expect(harness.store.require(job.jobId).error).toBe(scenario.expected);
        expect(harness.store.getSessionQuarantine("livis:agent-test") !== null)
          .toBe(scenario.credentialRejected);
        expect(harness.backend.ready).toBe(!scenario.credentialRejected);
      } finally {
        await harness.cleanup();
      }
    });
  }

  test("非认证 failed + systemError 仅在 checkpoint 精确一致时允许下一 turn", async () => {
    const harness = await createHarness({
      configureFake: (fake) => {
        fake.failedTerminalThreadStatus = "systemError";
        fake.legacyFailedTurnReadbackAsCompleted = true;
      },
    });
    try {
      const failedJob = claimJob(harness, "job-retryable-system-error");
      await harness.backend.dispatch(failedJob);
      await harness.fake.send({
        method: "turn/completed",
        params: {
          threadId: harness.fake.threadId,
          turn: {
            id: "019f-turn-1",
            status: "failed",
            error: { message: "synthetic provider failure", codexErrorInfo: "other" },
            items: [],
          },
        },
      });
      await waitFor(
        () => harness.store.require(failedJob.jobId).status === "Failed",
        "retryable systemError failed terminal",
      );
      expect(harness.failures).toEqual(["Codex provider 返回未分类错误"]);
      expect(harness.store.getSessionQuarantine("livis:agent-test")).toBeNull();
      expect(harness.backend.ready).toBeTrue();
      expect(harness.fake.turns).toEqual([{ id: "019f-turn-1", status: "completed" }]);

      harness.fake.nextTurnId = "019f-turn-2";
      const recoveredJob = claimJob(harness, "job-after-system-error", "继续执行");
      expect(await harness.backend.dispatch(recoveredJob)).toBe("submitted");
      await harness.fake.send({
        method: "turn/completed",
        params: {
          threadId: harness.fake.threadId,
          turn: {
            id: "019f-turn-2",
            status: "completed",
            items: [
              {
                type: "agentMessage",
                id: "m-after-system-error",
                text: "恢复成功",
                phase: "final_answer",
              },
            ],
          },
        },
      });
      await waitFor(
        () => harness.store.require(recoveredJob.jobId).status === "Succeeded",
        "systemError 后下一 turn",
      );
      expect(harness.results).toEqual(["恢复成功"]);
      expect(harness.fake.messages.filter((message) => message.method === "turn/start"))
        .toHaveLength(2);
      expect(harness.fake.threadStatus).toBe("idle");
    } finally {
      await harness.cleanup();
    }
  });

  for (const scenario of [
    { name: "completed→failed", initialLegacyProjection: true, changedStatus: "failed" },
    { name: "failed→completed", initialLegacyProjection: false, changedStatus: "completed" },
  ] as const) {
    test(`systemError marker 拒绝 raw tail status 漂移：${scenario.name}`, async () => {
      const harness = await createHarness({
        configureFake: (fake) => {
          fake.failedTerminalThreadStatus = "systemError";
          fake.legacyFailedTurnReadbackAsCompleted = scenario.initialLegacyProjection;
        },
      });
      try {
        const failedJob = claimJob(harness, `job-raw-status-${scenario.name}`);
        await harness.backend.dispatch(failedJob);
        await harness.fake.send({
          method: "turn/completed",
          params: {
            threadId: harness.fake.threadId,
            turn: {
              id: "019f-turn-1",
              status: "failed",
              error: { message: "synthetic provider failure", codexErrorInfo: "other" },
              items: [],
            },
          },
        });
        await waitFor(
          () => harness.store.require(failedJob.jobId).status === "Failed",
          `raw status baseline ${scenario.name}`,
        );

        harness.fake.turns[0] = { id: "019f-turn-1", status: scenario.changedStatus };
        harness.fake.nextTurnId = "019f-turn-2";
        const nextJob = claimJob(harness, `job-after-raw-status-${scenario.name}`);
        const turnStartsBefore = harness.fake.messages
          .filter((message) => message.method === "turn/start").length;
        expect(await harness.backend.dispatch(nextJob)).toBe("not_sent");
        expect(harness.fake.messages.filter((message) => message.method === "turn/start"))
          .toHaveLength(turnStartsBefore);
        expect(harness.store.getSessionQuarantine("livis:agent-test")).not.toBeNull();
        expect(harness.backend.ready).toBeFalse();
      } finally {
        await harness.cleanup();
      }
    });
  }

  test("failed terminal 实际为 idle 时拒绝后来无关的同 tail systemError", async () => {
    const harness = await createHarness();
    try {
      const failedJob = claimJob(harness, "job-idle-failed-tail");
      await harness.backend.dispatch(failedJob);
      await harness.fake.send({
        method: "turn/completed",
        params: {
          threadId: harness.fake.threadId,
          turn: {
            id: "019f-turn-1",
            status: "failed",
            error: { message: "synthetic failure", codexErrorInfo: "other" },
            items: [],
          },
        },
      });
      await waitFor(
        () => harness.store.require(failedJob.jobId).status === "Failed",
        "idle failed terminal",
      );
      expect(harness.fake.threadStatus).toBe("idle");
      expect(harness.backend.ready).toBeTrue();

      // 不追加 turn，只把 thread 状态外部改成 systemError；持久 tail 仍完全相同。
      harness.fake.threadStatus = "systemError";
      harness.fake.nextTurnId = "019f-turn-2";
      const nextJob = claimJob(harness, "job-unrelated-system-error");
      const turnStartsBefore = harness.fake.messages
        .filter((message) => message.method === "turn/start").length;
      expect(await harness.backend.dispatch(nextJob)).toBe("not_sent");
      expect(harness.fake.messages.filter((message) => message.method === "turn/start"))
        .toHaveLength(turnStartsBefore);
      expect(harness.store.getSessionQuarantine("livis:agent-test")?.reason)
        .toContain("systemError 未绑定");
      expect(harness.backend.ready).toBeFalse();
    } finally {
      await harness.cleanup();
    }
  });

  test("idle recovery 更换 client epoch 后不会复用旧 systemError marker", async () => {
    const initial = new FakeCodexAppServer();
    initial.failedTerminalThreadStatus = "systemError";
    const recovering = new FakeCodexAppServer();
    const sequence = new FakeCodexAppServerSequence(
      [initial, recovering],
      (index) => {
        if (index === 1) {
          recovering.turns = initial.turns.map((turn) => ({ ...turn }));
          recovering.threadStatus = "idle";
        }
      },
    );
    const harness = await createHarness({
      fake: initial,
      appServerSpawn: sequence.spawn,
      recoveryDelaysMs: [0, 0, 0],
    });
    try {
      const failedJob = claimJob(harness, "job-system-error-old-epoch");
      await harness.backend.dispatch(failedJob);
      await initial.send({
        method: "turn/completed",
        params: {
          threadId: initial.threadId,
          turn: {
            id: "019f-turn-1",
            status: "failed",
            error: { message: "synthetic failure", codexErrorInfo: "other" },
            items: [],
          },
        },
      });
      await waitFor(
        () => harness.store.require(failedJob.jobId).status === "Failed",
        "old epoch systemError terminal",
      );
      await initial.stop(44);
      await waitFor(
        () => sequence.spawnCount === 2 && harness.backend.ready,
        "new epoch idle recovery",
      );

      recovering.threadStatus = "systemError";
      recovering.nextTurnId = "019f-turn-2";
      const nextJob = claimJob(harness, "job-system-error-new-epoch");
      const turnStartsBefore = recovering.messages
        .filter((message) => message.method === "turn/start").length;
      expect(await harness.backend.dispatch(nextJob)).toBe("not_sent");
      expect(recovering.messages.filter((message) => message.method === "turn/start"))
        .toHaveLength(turnStartsBefore);
      expect(harness.store.getSessionQuarantine("livis:agent-test")?.reason)
        .toContain("systemError 未绑定");
    } finally {
      await harness.cleanup();
    }
  });

  test("0.145.0 legacy failed-tail 归一化不跨 idle recovery client epoch", async () => {
    const initial = new FakeCodexAppServer();
    initial.failedTerminalThreadStatus = "systemError";
    initial.legacyFailedTurnReadbackAsCompleted = true;
    const recovering = new FakeCodexAppServer();
    const sequence = new FakeCodexAppServerSequence(
      [initial, recovering],
      (index) => {
        if (index === 1) {
          recovering.turns = initial.turns.map((turn) => ({ ...turn }));
          recovering.threadStatus = "idle";
        }
      },
    );
    const harness = await createHarness({
      fake: initial,
      appServerSpawn: sequence.spawn,
      recoveryDelaysMs: [0, 0, 0],
    });
    try {
      const failedJob = claimJob(harness, "job-legacy-projection-old-epoch");
      await harness.backend.dispatch(failedJob);
      await initial.send({
        method: "turn/completed",
        params: {
          threadId: initial.threadId,
          turn: {
            id: "019f-turn-1",
            status: "failed",
            error: { message: "synthetic provider failure", codexErrorInfo: "other" },
            items: [],
          },
        },
      });
      await waitFor(
        () => harness.store.require(failedJob.jobId).status === "Failed",
        "legacy projection terminal before recovery",
      );
      expect(initial.turns).toEqual([{ id: "019f-turn-1", status: "completed" }]);

      await initial.stop(45);
      await waitFor(() => harness.disconnects.length === 1, "legacy projection recovery rejection");
      await Bun.sleep(10);

      expect(sequence.spawnCount).toBe(2);
      expect(harness.backend.status()).toMatchObject({ state: "failed", ready: false });
      expect(harness.store.getSessionQuarantine("livis:agent-test")).not.toBeNull();
      expect(recovering.messages.some((message) => message.method === "turn/start")).toBeFalse();
    } finally {
      await harness.cleanup();
    }
  });

  test("systemError tail 与持久 failed checkpoint 漂移时拒绝下一 turn", async () => {
    const harness = await createHarness({
      configureFake: (fake) => {
        fake.failedTerminalThreadStatus = "systemError";
      },
    });
    try {
      const failedJob = claimJob(harness, "job-system-error-drift");
      await harness.backend.dispatch(failedJob);
      await harness.fake.send({
        method: "turn/completed",
        params: {
          threadId: harness.fake.threadId,
          turn: {
            id: "019f-turn-1",
            status: "failed",
            error: { message: "synthetic failure", codexErrorInfo: "other" },
            items: [],
          },
        },
      });
      await waitFor(
        () => harness.store.require(failedJob.jobId).status === "Failed",
        "systemError drift baseline",
      );

      harness.fake.turns.push({ id: "external-failed", status: "failed" });
      harness.fake.nextTurnId = "019f-turn-2";
      const nextJob = claimJob(harness, "job-system-error-drift-next");
      const turnStartsBefore = harness.fake.messages
        .filter((message) => message.method === "turn/start").length;
      expect(await harness.backend.dispatch(nextJob)).toBe("not_sent");
      expect(harness.fake.messages.filter((message) => message.method === "turn/start"))
        .toHaveLength(turnStartsBefore);
      expect(harness.store.getSessionQuarantine("livis:agent-test")?.reason)
        .toContain("thread checkpoint");
      expect(harness.backend.ready).toBeFalse();
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

  test("idle 自动恢复默认固定三档退避，并暴露运行与 checkpoint 状态", async () => {
    expect(CODEX_IDLE_RECOVERY_DELAYS_MS).toEqual([250, 1_000, 5_000]);

    const initial = new FakeCodexAppServer();
    const recovered = new FakeCodexAppServer();
    const sequence = new FakeCodexAppServerSequence([initial, recovered], (index) => {
      if (index > 0 && !initial.isStopped) {
        throw new Error("旧 app-server stdio 尚未收口就启动了新 client");
      }
    });
    const harness = await createHarness({
      fake: initial,
      appServerSpawn: sequence.spawn,
      recoveryDelaysMs: [50, 0, 0],
    });
    try {
      const executionId = harness.backend.executionId;
      const threadId = initial.threadId;
      const initialStatus = harness.backend.status();
      expect(initialStatus).toMatchObject({
        state: "running",
        ready: true,
        executionId,
        threadId,
        accountType: "apiKey",
        accountIdentityStrength: "type-only",
        requestedModel: null,
        effectiveModel: "gpt-5.6-sol",
        modelProvider: "openai",
        recovery: {
          inProgress: false,
          attempts: 0,
          maxAttempts: 3,
          nextAttemptAt: null,
          lastError: null,
        },
        checkpoint: {
          turnId: null,
          turnStatus: null,
          turnCount: 0,
        },
      });
      const checkpoint = initialStatus.checkpoint;
      if (!isRecord(checkpoint)) throw new Error("status 缺 checkpoint");
      expect(checkpoint.checkpointedAt).toBeNumber();

      initial.exitWithoutClosingStreams(17);
      await waitFor(
        () => harness.backend.status().state === "recovering",
        "idle recovery state",
      );
      expect(harness.backend.ready).toBeFalse();
      expect(harness.backend.status()).toMatchObject({
        state: "recovering",
        recovery: { inProgress: true, attempts: 0, maxAttempts: 3 },
      });
      const recoveryStatus = harness.backend.status().recovery;
      if (!isRecord(recoveryStatus)) throw new Error("status 缺 recovery");
      expect(recoveryStatus.nextAttemptAt).toBeNumber();
      expect(harness.disconnects).toEqual([]);

      await waitFor(
        () => sequence.spawnCount === 2 && harness.backend.ready,
        "idle recovery success",
      );
      expect(harness.backend.executionId).toBe(executionId);
      expect(harness.backend.status()).toMatchObject({
        state: "running",
        ready: true,
        executionId,
        threadId,
        recovery: {
          inProgress: false,
          attempts: 1,
          maxAttempts: 3,
          nextAttemptAt: null,
          lastError: null,
        },
      });
      expect(harness.disconnects).toEqual([]);
      expect(harness.store.getSessionQuarantine("livis:agent-test")).toBeNull();
      expect(recovered.messages.filter((message) => message.method === "thread/resume"))
        .toHaveLength(1);
      expect(recovered.messages.filter((message) => message.method === "thread/read"))
        .toHaveLength(1);
      expect(recovered.messages.some((message) => message.method === "thread/start")).toBeFalse();
      expect(recovered.messages.some((message) => message.method === "thread/memoryMode/set"))
        .toBeFalse();
      expect(recovered.messages.some((message) => message.method === "turn/start")).toBeFalse();
    } finally {
      await harness.cleanup();
    }
  });

  test("idle 多次崩溃按 client epoch 恢复，旧 client 退出不会误伤新 client", async () => {
    const initial = new FakeCodexAppServer();
    const recoveredOnce = new FakeCodexAppServer();
    const recoveredTwice = new FakeCodexAppServer();
    const recoveredThrice = new FakeCodexAppServer();
    const sequence = new FakeCodexAppServerSequence([
      initial,
      recoveredOnce,
      recoveredTwice,
      recoveredThrice,
      new FakeCodexAppServer(),
    ]);
    const harness = await createHarness({
      fake: initial,
      appServerSpawn: sequence.spawn,
      recoveryDelaysMs: [0, 0, 0],
    });
    try {
      const executionId = harness.backend.executionId;
      await initial.stop(21);
      await waitFor(
        () => sequence.spawnCount === 2 && harness.backend.ready,
        "first epoch recovery",
      );
      await recoveredOnce.stop(22);
      await waitFor(
        () => sequence.spawnCount === 3 && harness.backend.ready,
        "second epoch recovery",
      );

      expect(harness.backend.executionId).toBe(executionId);
      expect(harness.backend.status()).toMatchObject({
        state: "running",
        recovery: { inProgress: false, attempts: 2, maxAttempts: 3 },
      });
      expect(harness.disconnects).toEqual([]);
      for (const fake of [recoveredOnce, recoveredTwice]) {
        expect(fake.messages.some((message) => message.method === "thread/start")).toBeFalse();
        expect(fake.messages.some((message) => message.method === "turn/start")).toBeFalse();
        expect(fake.messages.filter((message) => message.method === "thread/resume"))
          .toHaveLength(1);
      }

      // Promise exit callback 对同一旧进程至多结算一次；重复 stop 不得再消费恢复预算。
      await initial.stop(99);
      await Bun.sleep(10);
      expect(sequence.spawnCount).toBe(3);
      expect(harness.backend.ready).toBeTrue();

      await recoveredTwice.stop(23);
      await waitFor(
        () => sequence.spawnCount === 4 && harness.backend.ready,
        "third epoch recovery",
      );
      expect(harness.backend.status()).toMatchObject({
        state: "running",
        recovery: { inProgress: false, attempts: 3, maxAttempts: 3 },
      });
      expect(recoveredThrice.messages.some((message) => message.method === "thread/start"))
        .toBeFalse();
      expect(recoveredThrice.messages.some((message) => message.method === "turn/start"))
        .toBeFalse();

      await recoveredThrice.stop(24);
      await waitFor(() => harness.disconnects.length === 1, "recovery budget exhausted");
      expect(sequence.spawnCount).toBe(4);
      expect(harness.backend.status()).toMatchObject({
        state: "failed",
        ready: false,
        recovery: { inProgress: false, attempts: 3, maxAttempts: 3 },
      });
    } finally {
      await harness.cleanup();
    }
  });

  test("Store 已 claim 但 dispatch 尚未入场时退出，必须 fail-closed 而非误判 idle", async () => {
    const initial = new FakeCodexAppServer();
    const sequence = new FakeCodexAppServerSequence([
      initial,
      new FakeCodexAppServer(),
    ]);
    const harness = await createHarness({
      fake: initial,
      appServerSpawn: sequence.spawn,
      recoveryDelaysMs: [0, 0, 0],
    });
    try {
      const job = claimJob(harness, "job-claimed-before-dispatch");
      expect(harness.backend.status().active).toBeNull();
      expect(harness.store.require(job.jobId).status).toBe("Dispatching");

      await initial.stop(31);
      await waitFor(() => harness.disconnects.length === 1, "claimed job disconnect");

      expect(sequence.spawnCount).toBe(1);
      expect(harness.store.require(job.jobId).status).toBe("Interrupted");
      expect(harness.store.getBackendSession("codex", "livis:agent-test")?.recoveryRequired)
        .toBeTrue();
      expect(harness.backend.status()).toMatchObject({ state: "failed", ready: false });
    } finally {
      await harness.cleanup();
    }
  });

  test("quarantine 中的 idle session 不自动恢复", async () => {
    const initial = new FakeCodexAppServer();
    const sequence = new FakeCodexAppServerSequence([
      initial,
      new FakeCodexAppServer(),
    ]);
    const harness = await createHarness({
      fake: initial,
      appServerSpawn: sequence.spawn,
      recoveryDelaysMs: [0, 0, 0],
    });
    try {
      expect(harness.store.quarantineSession("livis:agent-test", "synthetic quarantine"))
        .toBeTrue();
      await initial.stop(32);
      await waitFor(() => harness.disconnects.length === 1, "quarantined idle disconnect");

      expect(sequence.spawnCount).toBe(1);
      expect(harness.backend.status()).toMatchObject({ state: "failed", ready: false });
      expect(harness.store.getSessionQuarantine("livis:agent-test")?.reason)
        .toBe("synthetic quarantine");
    } finally {
      await harness.cleanup();
    }
  });

  test("idle recovery 严格按三档退避尝试，第三次失败后才断连", async () => {
    const initial = new FakeCodexAppServer();
    const sequence = new FakeCodexAppServerSequence([
      initial,
      new Error("synthetic recovery failure 1"),
      new Error("synthetic recovery failure 2"),
      new Error("synthetic recovery failure 3"),
    ]);
    const delays = [20, 30, 40] as const;
    const harness = await createHarness({
      fake: initial,
      appServerSpawn: sequence.spawn,
      recoveryDelaysMs: delays,
    });
    try {
      const crashedAt = Date.now();
      await initial.stop(33);
      await waitFor(() => harness.disconnects.length === 1, "recovery attempts exhausted");

      expect(sequence.spawnCount).toBe(4);
      expect(sequence.spawnTimes[1]! - crashedAt).toBeGreaterThanOrEqual(delays[0] - 2);
      expect(sequence.spawnTimes[2]! - sequence.spawnTimes[1]!)
        .toBeGreaterThanOrEqual(delays[1] - 2);
      expect(sequence.spawnTimes[3]! - sequence.spawnTimes[2]!)
        .toBeGreaterThanOrEqual(delays[2] - 2);
      expect(harness.disconnects).toHaveLength(1);
      expect(harness.backend.status()).toMatchObject({
        state: "failed",
        ready: false,
        recovery: {
          inProgress: false,
          attempts: 3,
          maxAttempts: 3,
          nextAttemptAt: null,
          lastError: expect.stringContaining("synthetic recovery failure 3"),
        },
      });
      expect(harness.store.getSessionQuarantine("livis:agent-test")).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  for (const variant of ["account-policy", "model-provider", "checkpoint", "tail"] as const) {
    test(`idle recovery 发现 ${variant} 漂移会立即 quarantine 且停止重试`, async () => {
      const initial = new FakeCodexAppServer();
      const drifted = new FakeCodexAppServer();
      const sequence = new FakeCodexAppServerSequence([
        initial,
        drifted,
        new FakeCodexAppServer(),
      ]);
      const harness = await createHarness({
        fake: initial,
        appServerSpawn: sequence.spawn,
        recoveryDelaysMs: [0, 0, 0],
      });
      try {
        if (variant === "account-policy") {
          drifted.account = {
            type: "chatgpt",
            email: "other-account@example.com",
            planType: "plus",
          };
        } else if (variant === "model-provider") {
          drifted.modelProvider = "unexpected-provider";
        } else if (variant === "checkpoint") {
          harness.store.checkpointBackendThreadTail({
            backend: "codex",
            sessionKey: "livis:agent-test",
            threadId: initial.threadId,
            checkpointTurnId: "019f-checkpoint-drift",
            checkpointTurnStatus: "completed",
            checkpointTurnCount: 1,
            checkpointTurnsSha256: sha256("synthetic checkpoint drift"),
            checkpointedAt: Date.now(),
            fence: { kind: "idle" },
          });
        } else {
          drifted.turns = [{ id: "019f-external-tail", status: "completed" }];
        }

        await initial.stop(34);
        await waitFor(() => harness.disconnects.length === 1, `${variant} drift disconnect`);
        await Bun.sleep(10);

        const driftDetectedBeforeSpawn = variant === "checkpoint";
        expect(sequence.spawnCount).toBe(driftDetectedBeforeSpawn ? 1 : 2);
        expect(harness.backend.status()).toMatchObject({
          state: "failed",
          ready: false,
          recovery: {
            inProgress: false,
            attempts: driftDetectedBeforeSpawn ? 0 : 1,
            maxAttempts: 3,
          },
        });
        expect(harness.store.getSessionQuarantine("livis:agent-test")).not.toBeNull();
        if (variant === "account-policy") {
          expect(drifted.messages.some((message) => message.method === "thread/resume")).toBeFalse();
        }
        expect(drifted.messages.some((message) => message.method === "turn/start")).toBeFalse();
      } finally {
        await harness.cleanup();
      }
    });
  }

  test("idle recovery 发现 command 持久安全绑定漂移会在 spawn 前 quarantine", async () => {
    const initial = new FakeCodexAppServer();
    const sequence = new FakeCodexAppServerSequence([
      initial,
      new FakeCodexAppServer(),
    ]);
    let pinResolutionCount = 0;
    const harness = await createHarness({
      fake: initial,
      appServerSpawn: sequence.spawn,
      recoveryDelaysMs: [0, 0, 0],
      commandPinResolver: async () => {
        pinResolutionCount += 1;
        if (pinResolutionCount === 1) return fakeCommandPin();
        return {
          ...fakeCommandPin(),
          contentSha256: sha256("idle-recovery-command-drift"),
          identitySha256: sha256("idle-recovery-command-identity-drift"),
        };
      },
    });
    try {
      await initial.stop(35);
      await waitFor(() => harness.disconnects.length === 1, "command drift disconnect");
      await Bun.sleep(10);

      expect(pinResolutionCount).toBe(2);
      expect(sequence.spawnCount).toBe(1);
      expect(harness.backend.status()).toMatchObject({
        state: "failed",
        ready: false,
        recovery: { inProgress: false, attempts: 1, maxAttempts: 3 },
      });
      expect(harness.store.getSessionQuarantine("livis:agent-test")?.reason)
        .toContain("command 文件身份");
    } finally {
      await harness.cleanup();
    }
  });

  test("stop 会取消尚在退避的 idle recovery 并等待其收口", async () => {
    const initial = new FakeCodexAppServer();
    const sequence = new FakeCodexAppServerSequence([
      initial,
      new FakeCodexAppServer(),
    ]);
    const harness = await createHarness({
      fake: initial,
      appServerSpawn: sequence.spawn,
      recoveryDelaysMs: [100, 0, 0],
    });
    try {
      await initial.stop(35);
      await waitFor(
        () => harness.backend.status().state === "recovering",
        "recovery backoff before stop",
      );
      await Promise.race([
        harness.backend.stop(),
        Bun.sleep(300).then(() => {
          throw new Error("stop 未取消 recovery backoff");
        }),
      ]);

      expect(sequence.spawnCount).toBe(1);
      expect(harness.backend.status()).toMatchObject({
        state: "stopped",
        ready: false,
        recovery: { inProgress: false },
      });
      expect(harness.disconnects).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  test("stop 与 recovery client 初始化并发时 join，且传播进程组关闭失败", async () => {
    const initial = new FakeCodexAppServer();
    const recovering = new FakeCodexAppServer();
    recovering.holdMethod = "account/read";
    recovering.ignoreKill = true;
    const sequence = new FakeCodexAppServerSequence([
      initial,
      recovering,
      new FakeCodexAppServer(),
    ]);
    const harness = await createHarness({
      fake: initial,
      appServerSpawn: sequence.spawn,
      recoveryDelaysMs: [0, 0, 0],
      shutdownTimeoutMs: 20,
    });
    try {
      await initial.stop(36);
      await waitFor(
        () => recovering.messages.some((message) => message.method === "account/read"),
        "recovery account/read",
      );

      await expect(harness.backend.stop()).rejects.toThrow(/收口|关闭|SIGKILL/);
      expect(sequence.spawnCount).toBe(2);
      expect(harness.backend.ready).toBeFalse();
      expect(harness.store.getSessionQuarantine("livis:agent-test")).not.toBeNull();
    } finally {
      recovering.ignoreKill = false;
      recovering.heldMethod.resolve({});
      await recovering.stop(0);
      await harness.cleanup();
    }
  });

  test("recovery candidate 在 initialize 阶段收口未确认时立即隔离且不得启动下一候选", async () => {
    const initial = new FakeCodexAppServer();
    const recovering = new FakeCodexAppServer();
    recovering.holdMethod = "initialize";
    recovering.ignoreKill = true;
    const sequence = new FakeCodexAppServerSequence([
      initial,
      recovering,
      new FakeCodexAppServer(),
    ]);
    const harness = await createHarness({
      fake: initial,
      appServerSpawn: sequence.spawn,
      recoveryDelaysMs: [0, 0, 0],
      requestTimeoutMs: 20,
      shutdownTimeoutMs: 20,
    });
    try {
      await initial.stop(37);
      await waitFor(
        () => recovering.messages.some((message) => message.method === "initialize"),
        "recovery initialize",
      );
      await waitFor(
        () => harness.disconnects.length === 1,
        "initialize close-unconfirmed disconnect",
      );

      expect(sequence.spawnCount).toBe(2);
      expect(harness.backend.status()).toMatchObject({
        state: "failed",
        ready: false,
        recovery: { attempts: 1, maxAttempts: 3 },
      });
      expect(harness.store.getSessionQuarantine("livis:agent-test")).not.toBeNull();
      await expect(harness.backend.stop()).rejects.toThrow(/进程组收口|initialize/);
    } finally {
      recovering.ignoreKill = false;
      recovering.heldMethod.resolve({});
      await recovering.stop(0);
      await harness.cleanup();
    }
  });

  test("recovery candidate spawn 后无进程组所有权时立即隔离且不得重试", async () => {
    const initial = new FakeCodexAppServer();
    const sequence = new FakeCodexAppServerSequence([
      initial,
      new CodexAppServerProcessOwnershipUnconfirmedError(),
      new FakeCodexAppServer(),
    ]);
    const harness = await createHarness({
      fake: initial,
      appServerSpawn: sequence.spawn,
      recoveryDelaysMs: [0, 0, 0],
    });
    try {
      await initial.stop(39);
      await waitFor(
        () => harness.disconnects.length === 1,
        "process ownership unconfirmed disconnect",
      );

      expect(sequence.spawnCount).toBe(2);
      expect(harness.backend.status()).toMatchObject({
        state: "failed",
        ready: false,
        recovery: { attempts: 1, maxAttempts: 3 },
      });
      expect(harness.store.getSessionQuarantine("livis:agent-test")).not.toBeNull();
      await expect(harness.backend.stop()).rejects.toThrow(/进程组收口|所有权/);
    } finally {
      await harness.cleanup();
    }
  });

  test("recovery ready 失败且进程组收口未确认时必须持久 quarantine", async () => {
    const initial = new FakeCodexAppServer();
    const recovering = new FakeCodexAppServer();
    recovering.ignoreKill = true;
    const sequence = new FakeCodexAppServerSequence([
      initial,
      recovering,
      new FakeCodexAppServer(),
    ]);
    const harness = await createHarness({
      fake: initial,
      appServerSpawn: sequence.spawn,
      recoveryDelaysMs: [0, 0, 0],
      shutdownTimeoutMs: 20,
      readyFailureAt: 2,
    });
    try {
      await initial.stop(40);
      await waitFor(
        () => harness.store.getSessionQuarantine("livis:agent-test") !== null,
        "recovery ready close-unconfirmed quarantine",
      );
      await waitFor(
        () => harness.backend.status().recovery !== null &&
          (harness.backend.status().recovery as Record<string, unknown>).inProgress === false,
        "recovery ready close-unconfirmed settle",
      );

      expect(sequence.spawnCount).toBe(2);
      expect(harness.disconnects).toHaveLength(1);
      expect(harness.backend.status()).toMatchObject({ state: "failed", ready: false });
      await expect(harness.backend.stop()).rejects.toThrow(/进程组收口|ready/);
    } finally {
      recovering.ignoreKill = false;
      await recovering.stop(0);
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
