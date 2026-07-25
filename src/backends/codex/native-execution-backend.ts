import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type {
  ExecutionBackend,
  ExecutionBackendHandlers,
  ExecutionSubmission,
} from "../execution-backend.ts";
import type { JobStore } from "../../state/store.ts";
import type { StoredJob } from "../../types.ts";
import { requirePrivateDirectory } from "../../state/offline-guard.ts";
import { durableMkdirPrivate } from "../../util.ts";
import {
  CodexNativeSessionHarness,
  type CodexNativeSessionHarnessOptions,
} from "./native-session-harness.ts";
import { CodexNativeClientEpochFence } from "./native-client-epoch.ts";
import {
  assertPinnedCodexCommand,
  codexSessionHash,
  pinCodexCommandForStateDir,
} from "./runtime-layout.ts";

export interface CodexNativeExecutionBackendOptions {
  stateDir: string;
  scopeKey: string;
  sessionKey: string;
  remoteNodeId: string;
  command: string;
  requestTimeoutMs: number;
  turnTimeoutMs: number;
  shutdownTimeoutMs: number;
  maxOutputChars: number;
  clientVersion: string;
}

interface NativeHarness {
  readonly executionId: string;
  readonly ready: boolean;
  dispatch(job: StoredJob): Promise<ExecutionSubmission>;
  cancel(job: StoredJob): Promise<ExecutionSubmission>;
  stop(): Promise<void>;
  status(): Record<string, unknown>;
}

export interface CodexNativeExecutionBackendDependencies {
  store: JobStore;
  handlers: ExecutionBackendHandlers;
  harnessStart?: (
    options: CodexNativeSessionHarnessOptions,
    dependencies: {
      store: JobStore;
      handlers: ExecutionBackendHandlers;
      clientEpochFence: CodexNativeClientEpochFence;
    },
  ) => Promise<NativeHarness>;
}

async function ensureNativeWorkspace(
  stateDir: string,
  sessionHash: string,
): Promise<{ stateDir: string; workspace: string }> {
  const canonicalStateDir = await requirePrivateDirectory(stateDir, "Codex native stateDir");
  const paths = [
    join(canonicalStateDir, "backends"),
    join(canonicalStateDir, "backends", "codex"),
    join(canonicalStateDir, "backends", "codex", "native-sessions"),
    join(canonicalStateDir, "backends", "codex", "native-sessions", sessionHash),
    join(canonicalStateDir, "backends", "codex", "native-sessions", sessionHash, "workspace"),
  ];
  for (const path of paths) await durableMkdirPrivate(path);
  const workspace = paths.at(-1)!;
  if (await realpath(workspace) !== workspace) {
    throw new Error("Codex native workspace realpath 已变化");
  }
  return { stateDir: canonicalStateDir, workspace };
}

/**
 * 生产 daemon 显式选择的原生当前状态 adapter。
 *
 * 它只启动并拥有独立 stdio app-server；HOME/CODEX_HOME 由 native transport 当作本地
 * runtime 选择器交给 Codex 自己解释。这里没有账号读取、登录、凭据复制或私有 backend fallback。
 */
export class CodexNativeExecutionBackend implements ExecutionBackend {
  readonly kind = "codex" as const;
  private harness: NativeHarness | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(
    private readonly options: CodexNativeExecutionBackendOptions,
    private readonly dependencies: CodexNativeExecutionBackendDependencies,
  ) {}

  get ready(): boolean {
    return this.harness?.ready ?? false;
  }

  get executionId(): string | null {
    return this.harness?.executionId ?? null;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.stopPromise) {
      return Promise.reject(new Error("Codex native backend 已进入停止流程，拒绝重新启动"));
    }
    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    if (this.harness) return;
    const sessionHash = codexSessionHash(
      this.options.scopeKey,
      this.options.sessionKey,
      this.options.remoteNodeId,
    );
    const layout = await ensureNativeWorkspace(this.options.stateDir, sessionHash);
    const command = await pinCodexCommandForStateDir(layout.stateDir, this.options.command);
    const harnessOptions: CodexNativeSessionHarnessOptions = {
      transport: {
        command,
        stateDir: layout.stateDir,
        cwd: layout.workspace,
        requestTimeoutMs: this.options.requestTimeoutMs,
        shutdownTimeoutMs: this.options.shutdownTimeoutMs,
        clientVersion: this.options.clientVersion,
      },
      session: {
        sessionKey: this.options.sessionKey,
        sessionHash,
        workspace: layout.workspace,
        requestedModel: null,
        expectedModelProvider: null,
        requestTimeoutMs: this.options.requestTimeoutMs,
        turnTimeoutMs: this.options.turnTimeoutMs,
        maxOutputChars: this.options.maxOutputChars,
      },
    };
    const start = this.dependencies.harnessStart ?? ((options, dependencies) =>
      CodexNativeSessionHarness.start(options, dependencies));
    const harness = await start(harnessOptions, {
      store: this.dependencies.store,
      handlers: this.dependencies.handlers,
      clientEpochFence: new CodexNativeClientEpochFence(),
    });
    try {
      await assertPinnedCodexCommand(command);
    } catch (error) {
      try {
        await harness.stop();
      } catch (stopError) {
        throw new AggregateError(
          [error, stopError],
          "Codex native command 漂移且自有 app-server 收口失败",
        );
      }
      throw error;
    }
    this.harness = harness;
  }

  dispatch(job: StoredJob): Promise<ExecutionSubmission> {
    return this.harness?.dispatch(job) ?? Promise.resolve("not_sent");
  }

  cancel(job: StoredJob): Promise<ExecutionSubmission> {
    return this.harness?.cancel(job) ?? Promise.resolve("not_sent");
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      await this.startPromise?.catch(() => undefined);
      const harness = this.harness;
      this.harness = null;
      if (harness) await harness.stop();
    })();
    return this.stopPromise;
  }

  status(): Record<string, unknown> {
    return {
      kind: this.kind,
      mode: "native-current",
      implementation: "codex-native-current",
      ready: this.ready,
      executionId: this.executionId,
      stateOwnership: "local-state-opaque",
      touchedDesktopDaemon: false,
      credentialStateInspected: false,
      experimental: true,
      ...(this.harness ? { harness: this.harness.status() } : {}),
    };
  }
}
