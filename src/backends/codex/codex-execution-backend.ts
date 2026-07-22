import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Logger } from "../../logger.ts";
import { errorMessage } from "../../logger.ts";
import {
  CODEX_MAXIMUM_EXCLUSIVE_VERSION,
  CODEX_MINIMUM_VERSION,
} from "../../config.ts";
import type { JobStore } from "../../state/store.ts";
import type { StoredBackendSession, StoredJob } from "../../types.ts";
import {
  parseSemverTriplet,
  sha256,
  versionAtLeast,
  versionLessThan,
} from "../../util.ts";
import type {
  ExecutionBackend,
  ExecutionBackendHandlers,
  ExecutionSubmission,
} from "../execution-backend.ts";
import {
  CODEX_APP_SERVER_COMMAND,
  CODEX_0145_ALLOWED_ENABLED_FEATURES,
  CODEX_DISABLED_FEATURES,
  CodexAppServerClient,
  codexLocalEnvironment,
  CodexAppServerRequestTransportError,
  CodexAppServerTimeoutError,
  type CodexAppServerNotification,
  type CodexAppServerSpawn,
} from "./app-server-client.ts";
import {
  assertCodexRuntimeLayout,
  buildCodexEnvironment,
  codexRemoteConfig,
  CODEX_REMOTE_PERMISSION_PROFILE,
  ensureCodexRuntimeLayout,
  resolveCodexCommand,
  type CodexRuntimeLayout,
} from "./runtime-layout.ts";

const CODEX_BACKEND_KIND = "codex" as const;
const VERSION_OUTPUT_MAX_BYTES = 64 * 1024;
const CODEX_NOTIFICATION_BACKLOG_MAX_COUNT = 256;
const CODEX_NOTIFICATION_BACKLOG_MAX_BYTES = 8 * 1024 * 1024;
const CODEX_AGENT_MESSAGE_MAX_COUNT = 1_024;
const CODEX_AGENT_MESSAGE_ID_MAX_CHARS = 256;
const CODEX_AGENT_MESSAGE_HARD_MAX_CHARS = 4 * 1024 * 1024;
const CODEX_ROLLOUT_SESSION_META_MAX_BYTES = 1024 * 1024;
export const DEFAULT_CODEX_FRESH_THREAD_MATERIALIZATION_TIMEOUT_MS = 5_000;
const CODEX_FRESH_THREAD_MATERIALIZATION_POLL_INTERVAL_MS = 25;

class CodexThreadNotMaterializedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexThreadNotMaterializedError";
  }
}

export interface CodexExecutionBackendOptions {
  stateDir: string;
  scopeKey: string;
  sessionKey: string;
  /** 唯一获授权的远端设备节点；参与 sessionHash，禁止换设备复用旧 thread。 */
  remoteNodeId: string;
  command: string;
  model: string | null;
  maxOutputChars: number;
  requestTimeoutMs: number;
  /** 从 turn/start 发起前开始计算的整轮绝对时限。 */
  turnTimeoutMs: number;
  /** turn deadline 后等待 interrupt 收敛的固定宽限期。 */
  interruptGraceMs: number;
  shutdownTimeoutMs: number;
}

export interface CodexCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CodexCommandRunner = (
  command: readonly string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
  },
) => Promise<CodexCommandResult>;

export interface CodexExecutionBackendDependencies {
  store: JobStore;
  handlers: ExecutionBackendHandlers;
  logger?: Logger;
  /** 仅供测试注入 fake app-server；生产不得替换为 shell command。 */
  appServerSpawn?: CodexAppServerSpawn;
  /** 仅供测试注入版本探针；生产使用无 shell 的 argv spawn。 */
  commandRunner?: CodexCommandRunner;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

interface AgentMessage {
  id: string;
  text: string;
  phase: "commentary" | "final_answer" | null;
  sequence: number;
}

interface ActiveAttempt {
  jobId: string;
  leaseId: string;
  runGeneration: number;
  turnId: string | null;
  turnReady: Deferred<string>;
  bufferedNotifications: AdmittedNotification[];
  pendingNotificationCount: number;
  pendingNotificationBytes: number;
  messages: Map<string, AgentMessage>;
  agentMessageChars: number;
  nextMessageSequence: number;
  cancelRequested: boolean;
  cancelReported: boolean;
  interruptionOwner: "none" | "user" | "timeout";
  interruptPromise: Promise<void> | null;
  deadlineAt: number | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  deadlineCloseWait: {
    promise: Promise<void>;
    resolve(): void;
    reject(reason: unknown): void;
    timer: ReturnType<typeof setTimeout>;
  } | null;
  deadlineExpired: boolean;
  terminal: boolean;
  submissionAmbiguous: boolean;
}

interface AdmittedNotification {
  notification: CodexAppServerNotification;
  bytes: number;
}

type BackendState =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // cancel 可能永远不会等待 turnReady；先安装 observer，避免失败路径产生
  // unhandled rejection，同时仍允许显式 await 得到同一个 rejection。
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} 必须是非空字符串`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} 必须是对象`);
  return value;
}

function requestWasDefinitelyUnwritten(error: unknown): boolean {
  return (
    (error instanceof CodexAppServerTimeoutError ||
      error instanceof CodexAppServerRequestTransportError) &&
    !error.written
  );
}

async function boundedStreamText(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let keptBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (keptBytes >= maxBytes) continue;
      const remaining = maxBytes - keptBytes;
      const kept = value.byteLength <= remaining ? value : value.slice(0, remaining);
      chunks.push(kept);
      keptBytes += kept.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(keptBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export const runCodexCommand: CodexCommandRunner = async (command, options) => {
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill(9);
    } catch {
      // 进程可能刚好退出；exited 会完成最终收口。
    }
  }, options.timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      boundedStreamText(child.stdout, VERSION_OUTPUT_MAX_BYTES),
      boundedStreamText(child.stderr, VERSION_OUTPUT_MAX_BYTES),
      child.exited,
    ]);
    if (timedOut) throw new Error(`Codex CLI 版本探针超时（${options.timeoutMs} ms）`);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
};

export function validateCodexVersion(result: CodexCommandResult): string {
  if (result.exitCode !== 0) {
    throw new Error(`Codex CLI 版本探针失败（exit ${result.exitCode}）`);
  }
  const parsed = parseSemverTriplet(`${result.stdout}\n${result.stderr}`);
  const minimum = parseSemverTriplet(CODEX_MINIMUM_VERSION)!;
  const maximum = parseSemverTriplet(CODEX_MAXIMUM_EXCLUSIVE_VERSION)!;
  if (!parsed || !versionAtLeast(parsed, minimum) || !versionLessThan(parsed, maximum)) {
    throw new Error(
      `Codex CLI 版本不在已审核窗口 [${CODEX_MINIMUM_VERSION}, ${CODEX_MAXIMUM_EXCLUSIVE_VERSION})`,
    );
  }
  return parsed.join(".");
}

export interface CodexAccountInspection {
  requiresOpenaiAuth: boolean;
  accountType: string | null;
  accountSubjectSha256: string | null;
  identityStrength: "subject" | "type-only" | null;
}

export function inspectCodexAccountResponse(value: unknown): CodexAccountInspection {
  const response = requireRecord(value, "account/read response");
  if (typeof response.requiresOpenaiAuth !== "boolean") {
    throw new Error("account/read response.requiresOpenaiAuth 必须是布尔值");
  }
  if (response.account === null) {
    if (response.requiresOpenaiAuth !== true) {
      throw new Error("account/read 未登录状态必须要求 OpenAI 认证");
    }
    return {
      requiresOpenaiAuth: response.requiresOpenaiAuth,
      accountType: null,
      accountSubjectSha256: null,
      identityStrength: null,
    };
  }
  const account = requireRecord(response.account, "Codex 私有 CODEX_HOME account");
  const accountType = nonEmptyString(account.type, "Codex account.type");
  if (!["apiKey", "chatgpt", "amazonBedrock"].includes(accountType)) {
    throw new Error(`Codex account.type 未经审核：${accountType}`);
  }
  if (response.requiresOpenaiAuth !== false) {
    throw new Error("account/read 已有账号时不应继续要求 OpenAI 认证");
  }
  const normalizedEmail = accountType === "chatgpt" && typeof account.email === "string"
    ? account.email.trim().toLowerCase()
    : "";
  return {
    requiresOpenaiAuth: response.requiresOpenaiAuth,
    accountType,
    accountSubjectSha256: normalizedEmail
      ? sha256(JSON.stringify([accountType, normalizedEmail]))
      : null,
    identityStrength: normalizedEmail ? "subject" : "type-only",
  };
}

interface AuthenticatedCodexAccountInspection {
  accountType: string;
  accountSubjectSha256: string | null;
  identityStrength: "subject" | "type-only";
}

function validateAccountResponse(value: unknown): AuthenticatedCodexAccountInspection {
  const inspection = inspectCodexAccountResponse(value);
  if (inspection.accountType === null || inspection.identityStrength === null) {
    throw new Error("Codex 私有 CODEX_HOME account 必须是对象");
  }
  return {
    accountType: inspection.accountType,
    accountSubjectSha256: inspection.accountSubjectSha256,
    identityStrength: inspection.identityStrength,
  };
}

export function validatePermissionProfiles(value: unknown): void {
  const response = requireRecord(value, "permissionProfile/list response");
  if (!Array.isArray(response.data)) {
    throw new Error("permissionProfile/list response.data 必须是数组");
  }
  const profile = response.data.find(
    (candidate) => isRecord(candidate) && candidate.id === CODEX_REMOTE_PERMISSION_PROFILE,
  );
  if (!profile || profile.allowed !== true) {
    throw new Error(`Codex permission profile ${CODEX_REMOTE_PERMISSION_PROFILE} 不存在或不可用`);
  }
}

export function validateDisabledCodexFeatures(value: unknown, cliVersion: string): string {
  const parsedVersion = parseSemverTriplet(cliVersion);
  if (!parsedVersion || parsedVersion[0] !== 0 || parsedVersion[1] !== 145) {
    throw new Error(`Codex feature allowlist 尚未审核 CLI ${cliVersion}`);
  }
  const response = requireRecord(value, "experimentalFeature/list response");
  if (!Array.isArray(response.data) || response.nextCursor !== null) {
    throw new Error("Codex feature 列表必须在单页完整返回");
  }
  const features = new Map<string, {
    name: string;
    stage: string;
    enabled: boolean;
    defaultEnabled: boolean;
  }>();
  for (const candidate of response.data) {
    if (!isRecord(candidate) || typeof candidate.name !== "string" ||
        typeof candidate.stage !== "string" || typeof candidate.enabled !== "boolean" ||
        typeof candidate.defaultEnabled !== "boolean") {
      throw new Error("Codex feature 列表包含非法条目");
    }
    if (features.has(candidate.name)) {
      throw new Error(`Codex feature 列表包含重复名称：${candidate.name}`);
    }
    features.set(candidate.name, {
      name: candidate.name,
      stage: candidate.stage,
      enabled: candidate.enabled,
      defaultEnabled: candidate.defaultEnabled,
    });
  }
  for (const feature of CODEX_DISABLED_FEATURES) {
    if (CODEX_0145_ALLOWED_ENABLED_FEATURES.has(feature)) continue;
    if (features.get(feature)?.enabled !== false) {
      throw new Error(`Codex 高风险 feature 未禁用或未回读：${feature}`);
    }
  }
  const enabledNames = [...features.values()]
    .filter((feature) => feature.enabled)
    .map((feature) => feature.name)
    .sort();
  const allowedNames = [...CODEX_0145_ALLOWED_ENABLED_FEATURES.keys()].sort();
  if (JSON.stringify(enabledNames) !== JSON.stringify(allowedNames)) {
    throw new Error(
      `Codex enabled feature 集合未经审核：${enabledNames.join(",") || "<empty>"}`,
    );
  }
  for (const [name, expectedStage] of CODEX_0145_ALLOWED_ENABLED_FEATURES) {
    const feature = features.get(name);
    if (
      !feature || !feature.enabled || feature.defaultEnabled !== true ||
      feature.stage !== expectedStage
    ) {
      throw new Error(`Codex 允许 feature 的 stage/default 已漂移：${name}`);
    }
  }
  return sha256(JSON.stringify([...features.values()].sort((left, right) =>
    left.name.localeCompare(right.name)
  )));
}

export interface CodexInitializeInspection {
  userAgent: string;
  platformFamily: string;
  platformOs: string;
}

export function validateCodexInitializeResponse(
  value: unknown,
  layout: CodexRuntimeLayout,
  cliVersion: string,
): CodexInitializeInspection {
  const response = requireRecord(value, "initialize response");
  if (response.codexHome !== layout.codexHome) {
    throw new Error("Codex initialize.codexHome 未固定到 daemon 专用 CODEX_HOME");
  }
  const userAgent = nonEmptyString(response.userAgent, "Codex initialize.userAgent");
  const userAgentProduct = userAgent.split(" ", 1)[0];
  if (userAgentProduct !== `livis-relay-daemon/${cliVersion}`) {
    throw new Error("Codex initialize.userAgent 的 CLI 版本与版本探针不一致");
  }
  return {
    userAgent,
    platformFamily: nonEmptyString(
      response.platformFamily,
      "Codex initialize.platformFamily",
    ),
    platformOs: nonEmptyString(response.platformOs, "Codex initialize.platformOs"),
  };
}

export interface CodexThreadBindingInspection {
  threadId: string;
  effectiveModel: string;
  modelProvider: string;
}

export function inspectThreadResponse(
  value: unknown,
  layout: CodexRuntimeLayout,
  expectedThreadId: string | null,
): CodexThreadBindingInspection {
  const response = requireRecord(value, "Codex thread response");
  const thread = requireRecord(response.thread, "Codex thread response.thread");
  const threadId = nonEmptyString(thread.id, "Codex thread.id");
  if (expectedThreadId !== null && threadId !== expectedThreadId) {
    throw new Error("Codex thread/resume 返回了不同 threadId");
  }
  if (response.cwd !== layout.workspace || thread.cwd !== layout.workspace) {
    throw new Error("Codex thread cwd 回读未固定到 daemon workspace");
  }
  if (
    !Array.isArray(response.runtimeWorkspaceRoots) ||
    response.runtimeWorkspaceRoots.length !== 1 ||
    response.runtimeWorkspaceRoots[0] !== layout.workspace
  ) {
    throw new Error("Codex runtimeWorkspaceRoots 回读与 daemon workspace 不一致");
  }
  if (response.approvalPolicy !== "never") {
    throw new Error("Codex approvalPolicy 回读不是 never");
  }
  if (response.approvalsReviewer !== "user") {
    throw new Error("Codex approvalsReviewer 回读不是 user");
  }
  const activeProfile = requireRecord(
    response.activePermissionProfile,
    "Codex activePermissionProfile",
  );
  if (activeProfile.id !== CODEX_REMOTE_PERMISSION_PROFILE) {
    throw new Error("Codex active permission profile 回读不一致");
  }
  if (activeProfile.extends !== null) {
    throw new Error("Codex active permission profile 不应继承其他 profile");
  }
  const sandbox = requireRecord(response.sandbox, "Codex sandbox 回读");
  if (
    sandbox.type !== "workspaceWrite" ||
    sandbox.networkAccess !== false ||
    sandbox.excludeTmpdirEnvVar !== true ||
    sandbox.excludeSlashTmp !== true
  ) {
    throw new Error("Codex sandbox 回读未满足 workspace-only、无网络和隔离临时目录边界");
  }
  if (!Array.isArray(sandbox.writableRoots)) {
    throw new Error("Codex sandbox.writableRoots 回读必须是数组");
  }
  if (sandbox.writableRoots.length !== 0) {
    throw new Error("Codex sandbox 回读不应包含 runtime workspace 之外的额外 writable root");
  }
  return {
    threadId,
    effectiveModel: nonEmptyString(response.model, "Codex thread response.model"),
    modelProvider: nonEmptyString(
      response.modelProvider,
      "Codex thread response.modelProvider",
    ),
  };
}

export function validateThreadResponse(
  value: unknown,
  layout: CodexRuntimeLayout,
  expectedThreadId: string | null,
): string {
  return inspectThreadResponse(value, layout, expectedThreadId).threadId;
}

export interface CodexThreadTailInspection {
  threadStatus: "idle";
  turnId: string | null;
  turnStatus: "completed" | "failed" | "interrupted" | null;
  turnCount: number;
  turnsSha256: string;
}

function assertStoredThreadCheckpoint(
  stored: StoredBackendSession,
  actual: CodexThreadTailInspection,
): void {
  if (
    stored.checkpointTurnCount === null || stored.checkpointTurnsSha256 === null ||
    stored.checkpointedAt === null
  ) {
    throw new Error("Codex backend session 尚未完成 v6 thread checkpoint 绑定");
  }
  if (
    stored.checkpointTurnId !== actual.turnId ||
    stored.checkpointTurnStatus !== actual.turnStatus ||
    stored.checkpointTurnCount !== actual.turnCount ||
    stored.checkpointTurnsSha256 !== actual.turnsSha256
  ) {
    throw new Error("Codex thread tail 与持久 checkpoint 不一致，存在未归属 turn 或历史漂移");
  }
}

export function inspectCodexThreadTail(
  value: unknown,
  expectedThreadId: string,
): CodexThreadTailInspection {
  const response = requireRecord(value, "thread/read response");
  const thread = requireRecord(response.thread, "thread/read response.thread");
  const threadId = nonEmptyString(thread.id, "thread/read response.thread.id");
  if (threadId !== expectedThreadId) {
    throw new Error("Codex thread/read 返回了不同 threadId");
  }
  const status = requireRecord(thread.status, "thread/read response.thread.status");
  const statusType = nonEmptyString(status.type, "thread/read response.thread.status.type");
  if (statusType !== "idle") {
    throw new Error(`Codex thread 恢复时不是 idle：${statusType}`);
  }
  if (!Array.isArray(thread.turns)) {
    throw new Error("Codex thread/read turns 必须是数组");
  }
  const seen = new Set<string>();
  const turns = thread.turns.map((candidate, index) => {
    const turn = requireRecord(candidate, `thread/read turn[${index}]`);
    const id = nonEmptyString(turn.id, `thread/read turn[${index}].id`);
    if (seen.has(id)) throw new Error(`Codex thread/read 包含重复 turn ID：${id}`);
    seen.add(id);
    const turnStatus = nonEmptyString(turn.status, `thread/read turn[${index}].status`);
    if (turnStatus === "inProgress") {
      throw new Error(`Codex thread/read 包含未归属的活动 turn：${id}`);
    }
    if (turnStatus !== "completed" && turnStatus !== "failed" && turnStatus !== "interrupted") {
      throw new Error(`Codex thread/read 包含未知 turn 状态：${turnStatus}`);
    }
    return {
      id,
      status: turnStatus as "completed" | "failed" | "interrupted",
    };
  });
  const tail = turns.at(-1) ?? null;
  return {
    threadStatus: "idle",
    turnId: tail?.id ?? null,
    turnStatus: tail?.status ?? null,
    turnCount: turns.length,
    turnsSha256: sha256(JSON.stringify(turns)),
  };
}

function isWithinPath(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

/**
 * 校验 thread/read 返回的 rollout 是专用 CODEX_HOME 内、可恢复且属于同一 thread。
 * 文件读取有硬上限，并用 O_NOFOLLOW 与 inode 回读避免把 symlink 或竞态替换当成证据。
 */
export async function validatePersistedCodexThread(
  value: unknown,
  layout: CodexRuntimeLayout,
  expectedThreadId: string,
): Promise<string> {
  inspectCodexThreadTail(value, expectedThreadId);
  const response = requireRecord(value, "thread/read response");
  const thread = requireRecord(response.thread, "thread/read response.thread");
  const threadId = nonEmptyString(thread.id, "thread/read response.thread.id");
  if (threadId !== expectedThreadId) {
    throw new Error("Codex thread/read 返回了不同 threadId");
  }
  if (
    thread.path === null ||
    thread.path === undefined ||
    (typeof thread.path === "string" && thread.path.trim() === "")
  ) {
    throw new CodexThreadNotMaterializedError("Codex thread/read 尚未返回 rollout path");
  }
  const reportedPath = nonEmptyString(thread.path, "thread/read response.thread.path");
  if (!isAbsolute(reportedPath)) {
    throw new Error("Codex rollout path 必须是绝对路径");
  }
  const rolloutPath = resolve(reportedPath);
  const rolloutRoot = resolve(join(layout.codexHome, "sessions"));
  if (rolloutPath === rolloutRoot || !isWithinPath(rolloutRoot, rolloutPath)) {
    throw new Error("Codex rollout path 未位于专用 CODEX_HOME/sessions");
  }

  let pathInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    pathInfo = await lstat(rolloutPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new CodexThreadNotMaterializedError(
        `Codex rollout 尚未落盘：${rolloutPath}`,
        { cause: error },
      );
    }
    throw new Error(`Codex rollout path 不可读取：${rolloutPath}`, { cause: error });
  }
  if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
    throw new Error("Codex rollout 必须是普通非 symlink 文件");
  }
  let canonicalRolloutPath: string;
  try {
    canonicalRolloutPath = await realpath(rolloutPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new CodexThreadNotMaterializedError(
        `Codex rollout 在 realpath 前尚未稳定落盘：${rolloutPath}`,
        { cause: error },
      );
    }
    throw error;
  }
  if (canonicalRolloutPath !== rolloutPath) {
    throw new Error("Codex rollout realpath 与专用 CODEX_HOME 内路径不一致");
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(rolloutPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new CodexThreadNotMaterializedError(
        `Codex rollout 在打开前尚未稳定落盘：${rolloutPath}`,
        { cause: error },
      );
    }
    throw new Error(`Codex rollout 无法以 no-follow 模式打开：${rolloutPath}`, { cause: error });
  }
  try {
    const openedInfo = await handle.stat();
    if (
      !openedInfo.isFile() ||
      openedInfo.dev !== pathInfo.dev ||
      openedInfo.ino !== pathInfo.ino
    ) {
      throw new Error("Codex rollout 在校验期间被替换");
    }
    const buffer = new Uint8Array(CODEX_ROLLOUT_SESSION_META_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    const newline = buffer.indexOf(0x0a, 0);
    const firstLineBytes = newline >= 0 ? newline : bytesRead;
    if (
      firstLineBytes > CODEX_ROLLOUT_SESSION_META_MAX_BYTES ||
      (newline < 0 && bytesRead > CODEX_ROLLOUT_SESSION_META_MAX_BYTES)
    ) {
      throw new Error("Codex rollout 首条 session_meta 超过读取上限");
    }
    const lineEnd = firstLineBytes > 0 && buffer[firstLineBytes - 1] === 0x0d
      ? firstLineBytes - 1
      : firstLineBytes;
    if (lineEnd === 0) {
      throw new CodexThreadNotMaterializedError("Codex rollout 已创建但 session_meta 尚未写入");
    }
    let firstRecord: unknown;
    try {
      firstRecord = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, lineEnd)),
      );
    } catch (error) {
      throw new Error("Codex rollout 首行不是有效 UTF-8 JSON", { cause: error });
    }
    const sessionMeta = requireRecord(firstRecord, "Codex rollout 首条记录");
    const payload = requireRecord(sessionMeta.payload, "Codex rollout session_meta.payload");
    if (sessionMeta.type !== "session_meta" || payload.id !== expectedThreadId) {
      throw new Error("Codex rollout 首条 session_meta id 与 threadId 不一致");
    }
  } finally {
    await handle.close();
  }
  return rolloutPath;
}

/** Codex 0.145.0 的新 thread 需显式关闭 memory mode 才会在首个 turn 前落盘。 */
export async function materializeFreshCodexThread(
  client: CodexAppServerClient,
  layout: CodexRuntimeLayout,
  threadId: string,
  timeoutMs = DEFAULT_CODEX_FRESH_THREAD_MATERIALIZATION_TIMEOUT_MS,
): Promise<string> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Codex thread 物化 timeoutMs 必须是正整数");
  }
  await client.threadMemoryModeSet({ threadId, mode: "disabled" });
  const deadline = Date.now() + timeoutMs;
  let lastTransientError: CodexThreadNotMaterializedError | null = null;
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `Codex 新 thread 在 ${timeoutMs} ms 内未物化 rollout`,
        { cause: lastTransientError },
      );
    }
    const persisted = await client.threadRead(
      { threadId, includeTurns: true },
      remainingMs,
    );
    try {
      return await validatePersistedCodexThread(persisted, layout, threadId);
    } catch (error) {
      if (!(error instanceof CodexThreadNotMaterializedError)) throw error;
      lastTransientError = error;
    }
    const delayMs = Math.min(
      CODEX_FRESH_THREAD_MATERIALIZATION_POLL_INTERVAL_MS,
      deadline - Date.now(),
    );
    if (delayMs > 0) {
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, delayMs));
    }
  }
}

function buildAppServerCommand(command: string): readonly string[] {
  return [command, ...CODEX_APP_SERVER_COMMAND.slice(1)];
}

function relevantNotification(notification: CodexAppServerNotification): boolean {
  return (
    notification.method === "item/completed" ||
    notification.method === "turn/completed" ||
    notification.method === "error"
  );
}

function notificationThreadId(notification: CodexAppServerNotification): string | null {
  return isRecord(notification.params) && typeof notification.params.threadId === "string"
    ? notification.params.threadId
    : null;
}

function notificationTurnId(notification: CodexAppServerNotification): string | null {
  if (!isRecord(notification.params)) return null;
  if (typeof notification.params.turnId === "string") return notification.params.turnId;
  if (isRecord(notification.params.turn) && typeof notification.params.turn.id === "string") {
    return notification.params.turn.id;
  }
  return null;
}

/**
 * daemon 内部的 Codex app-server 执行后端。
 *
 * JobStore/lease/outbox 仍由 daemon 持有。本类只管理固定的 Codex 私有目录、
 * thread/turn RPC、执行侧事件归属和 fail-closed 断连；绝不自动重发 turn/start。
 */
export class CodexExecutionBackend implements ExecutionBackend {
  readonly kind = CODEX_BACKEND_KIND;

  private readonly store: JobStore;
  private readonly handlers: ExecutionBackendHandlers;
  private readonly logger?: Logger;
  private readonly appServerSpawn?: CodexAppServerSpawn;
  private readonly commandRunner: CodexCommandRunner;
  private state: BackendState = "idle";
  private layout: CodexRuntimeLayout | null = null;
  private client: CodexAppServerClient | null = null;
  private cliVersion: string | null = null;
  private accountType: string | null = null;
  private threadId: string | null = null;
  private _executionId: string | null = null;
  private activeAttempt: ActiveAttempt | null = null;
  private eventTail: Promise<void> = Promise.resolve();
  private disconnectPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private suppressProcessDisconnect = false;
  private readonly agentMessageMaxChars: number;

  constructor(
    private readonly options: CodexExecutionBackendOptions,
    dependencies: CodexExecutionBackendDependencies,
  ) {
    if (!options.command.trim()) throw new Error("Codex command 不能为空");
    if (!isAbsolute(options.command)) throw new Error("Codex command 必须是绝对路径");
    if (!options.remoteNodeId.trim()) throw new Error("Codex remoteNodeId 不能为空");
    if (!Number.isSafeInteger(options.maxOutputChars) || options.maxOutputChars <= 0) {
      throw new Error("Codex maxOutputChars 必须是正整数");
    }
    if (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0) {
      throw new Error("Codex requestTimeoutMs 必须是正整数");
    }
    if (!Number.isSafeInteger(options.turnTimeoutMs) || options.turnTimeoutMs <= 0) {
      throw new Error("Codex turnTimeoutMs 必须是正整数");
    }
    if (!Number.isSafeInteger(options.interruptGraceMs) || options.interruptGraceMs <= 0) {
      throw new Error("Codex interruptGraceMs 必须是正整数");
    }
    if (!Number.isSafeInteger(options.shutdownTimeoutMs) || options.shutdownTimeoutMs <= 0) {
      throw new Error("Codex shutdownTimeoutMs 必须是正整数");
    }
    this.store = dependencies.store;
    this.handlers = dependencies.handlers;
    this.logger = dependencies.logger;
    this.appServerSpawn = dependencies.appServerSpawn;
    this.commandRunner = dependencies.commandRunner ?? runCodexCommand;
    this.agentMessageMaxChars = Math.min(
      CODEX_AGENT_MESSAGE_HARD_MAX_CHARS,
      options.maxOutputChars * 4,
    );
  }

  get ready(): boolean {
    return this.state === "running" && this.client !== null && this.disconnectPromise === null;
  }

  get executionId(): string | null {
    return this._executionId;
  }

  async start(): Promise<void> {
    if (this.state !== "idle") throw new Error(`Codex backend 不能从 ${this.state} 状态启动`);
    this.state = "starting";
    let client: CodexAppServerClient | null = null;
    try {
      const layout = await ensureCodexRuntimeLayout({
        stateDir: this.options.stateDir,
        scopeKey: this.options.scopeKey,
        sessionKey: this.options.sessionKey,
        remoteNodeId: this.options.remoteNodeId,
      });
      await assertCodexRuntimeLayout(layout);
      const environment = await buildCodexEnvironment(layout);
      const command = this.appServerSpawn === undefined && this.commandRunner === runCodexCommand
        ? await resolveCodexCommand(layout, this.options.command)
        : this.options.command;
      const versionResult = await this.commandRunner([command, "--version"], {
        cwd: layout.workspace,
        env: environment,
        timeoutMs: this.options.requestTimeoutMs,
      });
      const cliVersion = validateCodexVersion(versionResult);
      const storedSession = this.store.getBackendSession(this.kind, this.options.sessionKey);
      if (
        storedSession &&
        (storedSession.sessionHash !== layout.sessionHash ||
          storedSession.cwd !== layout.workspace ||
          storedSession.cliVersion !== cliVersion)
      ) {
        throw new Error("Codex backend session 的目录、session hash 或 CLI 版本已漂移");
      }
      if (storedSession && (storedSession.recoveryRequired || storedSession.activeJobId !== null)) {
        throw new Error("Codex backend session 存在未人工释放的恢复证据，拒绝启动");
      }
      const quarantine = this.store.getSessionQuarantine(this.options.sessionKey);
      if (quarantine) {
        throw new Error(`Codex backend session 仍在 quarantine：${quarantine.reason}`);
      }

      client = await CodexAppServerClient.start({
        command: buildAppServerCommand(command),
        cwd: layout.workspace,
        env: environment,
        spawn: this.appServerSpawn,
        requestTimeoutMs: this.options.requestTimeoutMs,
        closeTimeoutMs: this.options.shutdownTimeoutMs,
        capabilities: { experimentalApi: true, requestAttestation: false },
        onNotification: (notification) => this.receiveNotification(notification),
        onApprovalRequest: (request) => {
          this.logger?.warn("Codex app-server 审批请求已默认拒绝", { method: request.method });
        },
      });
      this.client = client;
      void client.exited.then(
        (exitCode) => this.onProcessExit(exitCode),
        (error: unknown) => this.onProcessExit(null, error),
      );

      validateCodexInitializeResponse(client.initializeResult, layout, cliVersion);

      const account = validateAccountResponse(
        await client.request("account/read", { refreshToken: false }),
      );
      validatePermissionProfiles(
        await client.request("permissionProfile/list", { cwd: layout.workspace }),
      );
      const featureSnapshotSha256 = validateDisabledCodexFeatures(
        await client.request("experimentalFeature/list", { cursor: null, limit: 256 }),
        cliVersion,
      );
      await assertCodexRuntimeLayout(layout);
      const securityConfigSha256 = sha256(codexRemoteConfig(layout.workspace));
      if (storedSession?.accountType !== null && storedSession?.accountType !== undefined) {
        const immutablePreThreadMatches =
          storedSession.accountType === account.accountType &&
          storedSession.accountSubjectSha256 === account.accountSubjectSha256 &&
          storedSession.accountIdentityStrength === account.identityStrength &&
          storedSession.requestedModel === this.options.model &&
          storedSession.securityConfigSha256 === securityConfigSha256 &&
          storedSession.featureSnapshotSha256 === featureSnapshotSha256;
        if (!immutablePreThreadMatches) {
          this.store.quarantineSession(
            this.options.sessionKey,
            "Codex 账号、请求模型、安全配置或 feature snapshot 与持久 session 不一致",
          );
          throw new Error("Codex immutable session metadata 在 thread 恢复前已漂移");
        }
      }

      const commonThreadParams = {
        cwd: layout.workspace,
        runtimeWorkspaceRoots: [layout.workspace],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        permissions: CODEX_REMOTE_PERMISSION_PROFILE,
        ...(this.options.model === null ? {} : { model: this.options.model }),
      } as const;
      let threadResponse: unknown;
      try {
        if (storedSession?.threadId === null || storedSession === null) {
          threadResponse = await client.threadStart({
            ...commonThreadParams,
            environments: codexLocalEnvironment(layout.workspace),
            ephemeral: false,
          });
        } else {
          threadResponse = await client.threadResume({
            threadId: storedSession.threadId,
            ...commonThreadParams,
          });
        }
      } catch (error) {
        if (
          (error instanceof CodexAppServerTimeoutError ||
            error instanceof CodexAppServerRequestTransportError) &&
          error.written
        ) {
          this.store.quarantineSession(
            this.options.sessionKey,
            `Codex ${error.method} 结果不确定，禁止自动创建或恢复替代 thread`,
          );
        }
        throw error;
      }
      let threadId: string;
      let effectiveModel: string;
      let modelProvider: string;
      let threadTail: CodexThreadTailInspection;
      try {
        const threadInspection = inspectThreadResponse(
          threadResponse,
          layout,
          storedSession?.threadId ?? null,
        );
        threadId = threadInspection.threadId;
        effectiveModel = threadInspection.effectiveModel;
        modelProvider = threadInspection.modelProvider;
        if (this.options.model !== null && effectiveModel !== this.options.model) {
          throw new Error(
            `Codex 实际 model ${effectiveModel} 与请求 model ${this.options.model} 不一致`,
          );
        }
        if (
          storedSession?.effectiveModel !== null && storedSession?.effectiveModel !== undefined &&
          (storedSession.effectiveModel !== effectiveModel ||
            storedSession.modelProvider !== modelProvider)
        ) {
          throw new Error("Codex 实际 model/provider 与持久 session 不一致");
        }
        let persisted: unknown;
        if (storedSession?.threadId === null || storedSession === null) {
          await materializeFreshCodexThread(
            client,
            layout,
            threadId,
            this.options.requestTimeoutMs,
          );
          persisted = await client.threadRead({ threadId, includeTurns: true });
        } else {
          persisted = await client.threadRead({ threadId, includeTurns: true });
        }
        await validatePersistedCodexThread(persisted, layout, threadId);
        threadTail = inspectCodexThreadTail(persisted, threadId);
        const ensuredSession = this.store.ensureBackendSession({
          backend: this.kind,
          sessionKey: this.options.sessionKey,
          sessionHash: layout.sessionHash,
          cwd: layout.workspace,
          cliVersion,
          accountType: account.accountType,
          accountSubjectSha256: account.accountSubjectSha256,
          accountIdentityStrength: account.identityStrength,
          requestedModel: this.options.model,
          effectiveModel,
          modelProvider,
          securityConfigSha256,
          featureSnapshotSha256,
          checkpointTurnId: threadTail.turnId,
          checkpointTurnStatus: threadTail.turnStatus,
          checkpointTurnCount: threadTail.turnCount,
          checkpointTurnsSha256: threadTail.turnsSha256,
          checkpointedAt: Date.now(),
        });
        if (ensuredSession.threadId === null) {
          this.store.bindBackendThread(this.kind, this.options.sessionKey, threadId);
        } else if (ensuredSession.threadId !== threadId) {
          throw new Error("Codex backend session 已绑定不同 thread");
        }
        assertStoredThreadCheckpoint(
          this.store.getBackendSession(this.kind, this.options.sessionKey)!,
          threadTail,
        );
      } catch (error) {
        this.store.quarantineSession(
          this.options.sessionKey,
          `Codex thread 已返回但安全回读、rollout 物化或 SQLite bind 失败：${errorMessage(error)}`,
        );
        throw error;
      }
      await assertCodexRuntimeLayout(layout);

      this.layout = layout;
      this.cliVersion = cliVersion;
      this.accountType = account.accountType;
      this.threadId = threadId;
      this._executionId = `codex:${threadId}`;
      this.state = "running";
      try {
        await this.handlers.onReady({
          kind: this.kind,
          executionId: this._executionId,
          implementation: {
            name: "codex-app-server",
            version: cliVersion,
            accountType: account.accountType,
            accountIdentityStrength: account.identityStrength,
            effectiveModel,
            modelProvider,
            featureSnapshotSha256,
            permissionProfile: CODEX_REMOTE_PERMISSION_PROFILE,
          },
        });
      } catch (error) {
        await this.failClosed(`Codex ready handler 失败：${errorMessage(error)}`);
        throw error;
      }
      if (!this.ready) {
        throw new Error("Codex backend 在 ready handler 期间失效");
      }
      this.logger?.info("Codex app-server backend 已就绪", {
        executionId: this._executionId,
        cliVersion,
      });
    } catch (error) {
      this.state = "failed";
      this.suppressProcessDisconnect = true;
      this.client = null;
      if (client) {
        try {
          await client.close();
        } catch (closeError) {
          throw new AggregateError(
            [error, closeError],
            "Codex backend 启动失败且 app-server 进程组收口未确认",
          );
        }
      }
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    if (this.state === "stopped") return;
    if (this.disconnectPromise) {
      await this.disconnectPromise;
      this.state = "stopped";
      return;
    }
    const hadActiveAttempt = this.activeAttempt !== null && !this.activeAttempt.terminal;
    this.state = "stopping";
    if (hadActiveAttempt) {
      await this.failClosed("daemon 停止时 Codex turn 仍处于活动状态");
    } else {
      this.suppressProcessDisconnect = true;
    }
    await this.eventTail.catch(() => undefined);
    if (this.disconnectPromise) {
      await this.disconnectPromise;
      this.state = "stopped";
      return;
    }
    const client = this.client;
    this.client = null;
    if (client) await client.close();
    this.state = "stopped";
  }

  async dispatch(job: StoredJob): Promise<ExecutionSubmission> {
    if (!this.ready || !this.client || !this.layout || !this.threadId || !this._executionId) {
      return "not_sent";
    }
    if (
      this.activeAttempt !== null ||
      job.status !== "Dispatching" ||
      !job.leaseId ||
      job.connectorId !== this._executionId ||
      job.sessionKey !== this.options.sessionKey
    ) {
      return "not_sent";
    }
    const storedSession = this.store.getBackendSession(this.kind, this.options.sessionKey);
    if (
      !storedSession ||
      storedSession.threadId !== this.threadId ||
      storedSession.activeJobId !== job.jobId ||
      storedSession.activeLeaseId !== job.leaseId ||
      storedSession.activeRunGeneration !== job.runGeneration ||
      storedSession.activeTurnId !== null ||
      storedSession.recoveryRequired
    ) {
      return "not_sent";
    }

    const attempt: ActiveAttempt = {
      jobId: job.jobId,
      leaseId: job.leaseId,
      runGeneration: job.runGeneration,
      turnId: null,
      turnReady: deferred<string>(),
      bufferedNotifications: [],
      pendingNotificationCount: 0,
      pendingNotificationBytes: 0,
      messages: new Map(),
      agentMessageChars: 0,
      nextMessageSequence: 0,
      cancelRequested: false,
      cancelReported: false,
      interruptionOwner: "none",
      interruptPromise: null,
      deadlineAt: null,
      deadlineTimer: null,
      deadlineCloseWait: null,
      deadlineExpired: false,
      terminal: false,
      submissionAmbiguous: false,
    };
    this.activeAttempt = attempt;

    try {
      await assertCodexRuntimeLayout(this.layout);
      await this.assertStoredThreadTailBeforeDispatch();
    } catch (error) {
      attempt.turnReady.reject(error);
      this.activeAttempt = null;
      this.store.quarantineSession(
        this.options.sessionKey,
        `Codex turn/start 前 thread checkpoint 回读失败：${errorMessage(error)}`,
      );
      await this.disableBeforeSubmission(`Codex runtime 安全边界校验失败：${errorMessage(error)}`);
      return "not_sent";
    }

    if (
      this.activeAttempt !== attempt || attempt.terminal || this.disconnectPromise ||
      !this.ready || !this.client
    ) {
      attempt.turnReady.reject(new Error("Codex preflight 后 backend 已失效"));
      if (this.activeAttempt === attempt) this.activeAttempt = null;
      return "not_sent";
    }
    if (attempt.cancelRequested) {
      attempt.turnReady.reject(new Error("Codex turn/start 前已收到 cancel"));
      this.activeAttempt = null;
      return "not_sent";
    }

    this.armTurnDeadline(attempt);

    let response: unknown;
    try {
      response = await this.client.turnStart({
        threadId: this.threadId,
        input: [{ type: "text", text: job.text, text_elements: [] }],
        environments: codexLocalEnvironment(this.layout.workspace),
        cwd: this.layout.workspace,
        runtimeWorkspaceRoots: [this.layout.workspace],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        permissions: CODEX_REMOTE_PERMISSION_PROFILE,
        model: this.options.model,
      });
    } catch (error) {
      if (attempt.deadlineExpired) {
        attempt.submissionAmbiguous = true;
        attempt.turnReady.reject(error);
        return "submitted";
      }
      if (requestWasDefinitelyUnwritten(error)) {
        this.clearTurnDeadline(attempt);
        attempt.turnReady.reject(error);
        this.activeAttempt = null;
        await this.disableBeforeSubmission(
          `Codex turn/start 未写入且 transport 已不可继续：${errorMessage(error)}`,
        );
        return "not_sent";
      }
      attempt.submissionAmbiguous = true;
      attempt.turnReady.reject(error);
      await this.failClosed(`Codex turn/start 提交结果不确定：${errorMessage(error)}`);
      return "submitted";
    }

    let turnId: string;
    try {
      const turn = requireRecord(requireRecord(response, "turn/start response").turn, "turn");
      turnId = nonEmptyString(turn.id, "turn/start response.turn.id");
    } catch (error) {
      if (attempt.deadlineExpired) {
        attempt.submissionAmbiguous = true;
        attempt.turnReady.reject(error);
        return "submitted";
      }
      attempt.submissionAmbiguous = true;
      attempt.turnReady.reject(error);
      await this.failClosed(`Codex turn/start 响应无法绑定 turn：${errorMessage(error)}`);
      return "submitted";
    }

    attempt.turnId = turnId;
    attempt.turnReady.resolve(turnId);
    const accepted = this.enqueueEvent(async () => {
      await this.handlers.onAccepted(this.jobEvent(attempt));
    });
    const buffered = attempt.bufferedNotifications.splice(0);
    for (const notification of buffered) this.enqueueNotification(attempt, notification);
    try {
      await accepted;
    } catch {
      return "submitted";
    }
    return "submitted";
  }

  async cancel(job: StoredJob): Promise<ExecutionSubmission> {
    const attempt = this.activeAttempt;
    if (
      !attempt ||
      attempt.terminal ||
      job.jobId !== attempt.jobId ||
      job.leaseId !== attempt.leaseId ||
      job.runGeneration !== attempt.runGeneration
    ) {
      return "not_sent";
    }
    attempt.cancelRequested = true;
    if (
      attempt.deadlineExpired ||
      (attempt.deadlineAt !== null && Date.now() >= attempt.deadlineAt)
    ) {
      await this.handleTurnDeadline(attempt);
      return "submitted";
    }
    if (attempt.interruptionOwner === "timeout") {
      return "submitted";
    }
    if (attempt.interruptionOwner === "none") {
      attempt.interruptionOwner = "user";
    }
    let turnId: string;
    try {
      turnId = attempt.turnId ?? await attempt.turnReady.promise;
    } catch {
      return attempt.submissionAmbiguous ? "submitted" : "not_sent";
    }
    if (attempt.terminal) return "submitted";
    if (attempt.deadlineExpired || attempt.interruptionOwner !== "user") {
      return "submitted";
    }
    if (!this.ready || !this.client || !this.layout || !this.threadId) {
      await this.failClosed("Codex turn 已启动但 cancel 时 backend 不可用");
      return "submitted";
    }
    try {
      await assertCodexRuntimeLayout(this.layout);
    } catch (error) {
      await this.failClosed(`cancel 前 Codex runtime 安全边界校验失败：${errorMessage(error)}`);
      return "submitted";
    }
    try {
      attempt.interruptPromise ??= this.client
        .turnInterrupt({ threadId: this.threadId, turnId })
        .then(() => undefined);
      await attempt.interruptPromise;
      if (
        attempt.deadlineExpired ||
        (attempt.deadlineAt !== null && Date.now() >= attempt.deadlineAt)
      ) {
        await this.handleTurnDeadline(attempt);
        return "submitted";
      }
      if (attempt.terminal) return "submitted";
      // turn/interrupt 的 RPC response 只证明 app-server 接受请求，不是 terminal 真源。
      // 保持 Cancelling，等待权威 turn/completed 后先 checkpoint 实际 tail，再上报
      // CancelUnknown；若 terminal 永远不到，完整 turn deadline 会失败关闭。
      return "submitted";
    } catch (error) {
      if (attempt.cancelReported) return "submitted";
      if (requestWasDefinitelyUnwritten(error)) {
        // 这里只能证明 interrupt 没有离开 daemon，不能撤销已经取得 turnId 的
        // 原 turn。仍须按活动执行不确定性断连、隔离，禁止落成 Cancelled。
        await this.failClosed(
          `Codex turn/interrupt 未写入，但原 turn 已提交：${errorMessage(error)}`,
        );
        return "submitted";
      }
      await this.failClosed(`Codex turn/interrupt 结果不确定：${errorMessage(error)}`);
      return "submitted";
    }
  }

  status(): Record<string, unknown> {
    return {
      kind: this.kind,
      ready: this.ready,
      executionId: this.executionId,
      cliVersion: this.cliVersion,
      threadId: this.threadId,
      permissionProfile: CODEX_REMOTE_PERMISSION_PROFILE,
      workspace: this.layout?.workspace ?? null,
      active: this.activeAttempt
        ? {
            jobId: this.activeAttempt.jobId,
            runGeneration: this.activeAttempt.runGeneration,
            turnId: this.activeAttempt.turnId,
            cancelRequested: this.activeAttempt.cancelRequested,
          }
        : null,
    };
  }

  private jobEvent(attempt: ActiveAttempt): {
    kind: "codex";
    executionId: string;
    jobId: string;
    leaseId: string;
    runGeneration: number;
    turnId: string;
  } {
    if (!this._executionId || !attempt.turnId) {
      throw new Error("Codex attempt 尚未绑定 executionId/turnId");
    }
    return {
      kind: this.kind,
      executionId: this._executionId,
      jobId: attempt.jobId,
      leaseId: attempt.leaseId,
      runGeneration: attempt.runGeneration,
      turnId: attempt.turnId,
    };
  }

  private receiveNotification(notification: CodexAppServerNotification): void {
    if (!relevantNotification(notification)) return;
    const attempt = this.activeAttempt;
    if (!attempt || attempt.terminal || notificationThreadId(notification) !== this.threadId) return;
    const admitted = this.admitNotification(attempt, notification);
    if (!admitted) return;
    if (attempt.turnId === null) {
      attempt.bufferedNotifications.push(admitted);
      return;
    }
    this.enqueueNotification(attempt, admitted);
  }

  private enqueueNotification(attempt: ActiveAttempt, admitted: AdmittedNotification): void {
    void this.enqueueEvent(async () => {
      await this.processNotification(admitted.notification);
    }).finally(() => {
      this.releaseNotification(attempt, admitted);
    }).catch(() => undefined);
  }

  private admitNotification(
    attempt: ActiveAttempt,
    notification: CodexAppServerNotification,
  ): AdmittedNotification | null {
    const bytes = Buffer.byteLength(JSON.stringify(notification), "utf8");
    if (
      attempt.pendingNotificationCount + 1 > CODEX_NOTIFICATION_BACKLOG_MAX_COUNT ||
      attempt.pendingNotificationBytes + bytes > CODEX_NOTIFICATION_BACKLOG_MAX_BYTES
    ) {
      void this.failClosed("Codex notification backlog 超过有界 admission，已隔离 active attempt")
        .catch((error) => {
          this.logger?.error("Codex notification backlog 隔离失败", {
            error: errorMessage(error),
          });
        });
      return null;
    }
    attempt.pendingNotificationCount += 1;
    attempt.pendingNotificationBytes += bytes;
    return { notification, bytes };
  }

  private releaseNotification(attempt: ActiveAttempt, admitted: AdmittedNotification): void {
    attempt.pendingNotificationCount = Math.max(0, attempt.pendingNotificationCount - 1);
    attempt.pendingNotificationBytes = Math.max(0, attempt.pendingNotificationBytes - admitted.bytes);
  }

  private async processNotification(notification: CodexAppServerNotification): Promise<void> {
    const attempt = this.activeAttempt;
    if (!attempt || attempt.terminal || !attempt.turnId) return;
    if (
      notificationThreadId(notification) !== this.threadId ||
      notificationTurnId(notification) !== attempt.turnId
    ) {
      return;
    }
    if (
      attempt.deadlineExpired ||
      (attempt.deadlineAt !== null && Date.now() >= attempt.deadlineAt)
    ) {
      await this.handleTurnDeadline(attempt);
      return;
    }
    if (this.layout) await assertCodexRuntimeLayout(this.layout);
    if (
      this.activeAttempt !== attempt || attempt.terminal || this.disconnectPromise ||
      attempt.deadlineExpired ||
      (attempt.deadlineAt !== null && Date.now() >= attempt.deadlineAt)
    ) {
      if (
        this.activeAttempt === attempt && !attempt.terminal && !this.disconnectPromise &&
        (attempt.deadlineExpired ||
          (attempt.deadlineAt !== null && Date.now() >= attempt.deadlineAt))
      ) {
        await this.handleTurnDeadline(attempt);
      }
      return;
    }

    if (notification.method === "item/completed") {
      this.captureAgentMessage(attempt, notification.params);
      return;
    }
    if (notification.method === "error") {
      // error 通知可能伴随 willRetry；只有 turn/completed 才是 terminal 真源。
      return;
    }
    if (notification.method !== "turn/completed") return;

    const params = requireRecord(notification.params, "turn/completed params");
    const turn = requireRecord(params.turn, "turn/completed turn");
    const status = nonEmptyString(turn.status, "turn/completed turn.status");
    if (status === "inProgress") {
      throw new Error("turn/completed 携带了非 terminal inProgress 状态");
    }
    if (
      attempt.deadlineExpired ||
      (attempt.deadlineAt !== null && Date.now() >= attempt.deadlineAt)
    ) {
      await this.handleTurnDeadline(attempt);
      return;
    }
    if (status !== "completed" && status !== "failed" && status !== "interrupted") {
      throw new Error(`Codex turn/completed 返回未知状态：${status}`);
    }
    if (attempt.cancelRequested) {
      await this.checkpointTerminalThread(attempt, status);
      await this.reportCancellation(attempt);
      return;
    }
    if (status === "completed") {
      const terminalAgentMessageIds: string[] = [];
      if (Array.isArray(turn.items)) {
        for (const item of turn.items) {
          if (isRecord(item) && item.type === "agentMessage" && typeof item.id === "string") {
            terminalAgentMessageIds.push(item.id);
          }
          this.captureAgentMessage(attempt, { item });
        }
      }
      const text = this.finalText(attempt, terminalAgentMessageIds);
      if (
        attempt.deadlineExpired ||
        (attempt.deadlineAt !== null && Date.now() >= attempt.deadlineAt)
      ) {
        await this.handleTurnDeadline(attempt);
        return;
      }
      await this.checkpointTerminalThread(attempt, "completed");
      if (
        attempt.deadlineExpired ||
        (attempt.deadlineAt !== null && Date.now() >= attempt.deadlineAt)
      ) {
        await this.handleTurnDeadline(attempt);
        return;
      }
      this.clearTurnDeadline(attempt);
      attempt.terminal = true;
      await this.handlers.onResult({ ...this.jobEvent(attempt), text });
      this.activeAttempt = null;
      return;
    }
    if (status === "failed") {
      const turnError = isRecord(turn.error) ? turn.error : null;
      const failure =
        turnError && typeof turnError.message === "string" && turnError.message.trim()
          ? turnError.message
          : "Codex turn 执行失败";
      if (
        attempt.deadlineExpired ||
        (attempt.deadlineAt !== null && Date.now() >= attempt.deadlineAt)
      ) {
        await this.handleTurnDeadline(attempt);
        return;
      }
      await this.checkpointTerminalThread(attempt, "failed");
      if (
        attempt.deadlineExpired ||
        (attempt.deadlineAt !== null && Date.now() >= attempt.deadlineAt)
      ) {
        await this.handleTurnDeadline(attempt);
        return;
      }
      this.clearTurnDeadline(attempt);
      attempt.terminal = true;
      await this.handlers.onFailed({ ...this.jobEvent(attempt), error: failure, retryable: false });
      this.activeAttempt = null;
      return;
    }
    if (status === "interrupted") {
      throw new Error("Codex turn 未经本 daemon cancel 即被中断");
    }
    throw new Error(`Codex turn/completed 返回未知状态：${status}`);
  }

  private captureAgentMessage(attempt: ActiveAttempt, value: unknown): void {
    const params = requireRecord(value, "item/completed params");
    const item = requireRecord(params.item, "item/completed item");
    if (item.type !== "agentMessage") return;
    const id = nonEmptyString(item.id, "agentMessage.id");
    if (id.length > CODEX_AGENT_MESSAGE_ID_MAX_CHARS) {
      throw new Error("agentMessage.id 超过有界长度");
    }
    const text = typeof item.text === "string" ? item.text : null;
    if (text === null) throw new Error("agentMessage.text 必须是字符串");
    const phase = item.phase === "commentary" || item.phase === "final_answer"
      ? item.phase
      : item.phase === null || item.phase === undefined
        ? null
        : (() => {
            throw new Error("agentMessage.phase 未经审核");
          })();
    const existing = attempt.messages.get(id);
    if (existing) {
      if (existing.text !== text || existing.phase !== phase) {
        throw new Error("同一 agentMessage.id 收到冲突内容");
      }
      return;
    }
    if (
      attempt.messages.size + 1 > CODEX_AGENT_MESSAGE_MAX_COUNT ||
      attempt.agentMessageChars + id.length + text.length > this.agentMessageMaxChars
    ) {
      throw new Error("Codex agentMessage 累计内容超过有界 attempt 上限");
    }
    attempt.messages.set(id, {
      id,
      text,
      phase,
      sequence: attempt.nextMessageSequence++,
    });
    attempt.agentMessageChars += id.length + text.length;
  }

  private finalText(attempt: ActiveAttempt, terminalAgentMessageIds: readonly string[]): string {
    const messages = [...attempt.messages.values()].sort((left, right) => left.sequence - right.sequence);
    const terminalMessages = terminalAgentMessageIds.flatMap((id) => {
      const message = attempt.messages.get(id);
      return message ? [message] : [];
    });
    const terminalFinal = terminalMessages
      .filter((message) => message.phase === "final_answer")
      .at(-1);
    const observedFinal = messages.filter((message) => message.phase === "final_answer").at(-1);
    const terminalLegacy = terminalMessages.filter((message) => message.phase === null).at(-1);
    const observedLegacy = messages.filter((message) => message.phase === null).at(-1);
    const selected = terminalFinal ?? observedFinal ?? terminalLegacy ?? observedLegacy;
    if (!selected) {
      throw new Error("Codex turn completed 但没有 final_answer 或兼容期 phase=null agentMessage");
    }
    return selected.text;
  }

  private async reportCancellation(attempt: ActiveAttempt): Promise<void> {
    if (
      attempt.cancelReported || this.activeAttempt !== attempt || attempt.terminal ||
      this.disconnectPromise || attempt.deadlineExpired ||
      (attempt.deadlineAt !== null && Date.now() >= attempt.deadlineAt)
    ) {
      if (
        this.activeAttempt === attempt && !attempt.terminal && !this.disconnectPromise &&
        (attempt.deadlineExpired ||
          (attempt.deadlineAt !== null && Date.now() >= attempt.deadlineAt))
      ) {
        await this.handleTurnDeadline(attempt);
      }
      return;
    }
    this.clearTurnDeadline(attempt);
    attempt.cancelReported = true;
    attempt.terminal = true;
    await this.handlers.onCancelled(this.jobEvent(attempt));
    if (this.activeAttempt === attempt) this.activeAttempt = null;
    await this.disableAfterTerminal();
  }

  private async assertStoredThreadTailBeforeDispatch(): Promise<void> {
    if (!this.client || !this.layout || !this.threadId) {
      throw new Error("Codex thread checkpoint 回读时 backend 未完整就绪");
    }
    const persisted = await this.client.threadRead({
      threadId: this.threadId,
      includeTurns: true,
    });
    await validatePersistedCodexThread(persisted, this.layout, this.threadId);
    const actual = inspectCodexThreadTail(persisted, this.threadId);
    const stored = this.store.getBackendSession(this.kind, this.options.sessionKey);
    if (!stored || stored.threadId !== this.threadId || stored.recoveryRequired) {
      throw new Error("Codex backend session checkpoint 当前不可用于 dispatch");
    }
    assertStoredThreadCheckpoint(stored, actual);
  }

  private async checkpointTerminalThread(
    attempt: ActiveAttempt,
    expectedStatus: "completed" | "failed" | "interrupted",
  ): Promise<void> {
    if (!this.client || !this.layout || !this.threadId || !attempt.turnId) {
      throw new Error("Codex terminal checkpoint 时 backend/turn 未完整绑定");
    }
    const persisted = await this.client.threadRead({
      threadId: this.threadId,
      includeTurns: true,
    });
    await validatePersistedCodexThread(persisted, this.layout, this.threadId);
    const tail = inspectCodexThreadTail(persisted, this.threadId);
    if (tail.turnId !== attempt.turnId || tail.turnStatus !== expectedStatus) {
      throw new Error(
        `Codex terminal checkpoint 与通知不一致：${tail.turnId ?? "<empty>"}/${tail.turnStatus ?? "<empty>"}`,
      );
    }
    this.store.checkpointBackendThreadTail({
      backend: this.kind,
      sessionKey: this.options.sessionKey,
      threadId: this.threadId,
      checkpointTurnId: tail.turnId,
      checkpointTurnStatus: tail.turnStatus,
      checkpointTurnCount: tail.turnCount,
      checkpointTurnsSha256: tail.turnsSha256,
      checkpointedAt: Date.now(),
      fence: {
        kind: "active",
        jobId: attempt.jobId,
        leaseId: attempt.leaseId,
        runGeneration: attempt.runGeneration,
        turnId: attempt.turnId,
      },
    });
  }

  private armTurnDeadline(attempt: ActiveAttempt): void {
    if (attempt.deadlineAt !== null || attempt.deadlineTimer !== null) {
      throw new Error("Codex turn deadline 不得重复安装");
    }
    attempt.deadlineAt = Date.now() + this.options.turnTimeoutMs;
    const delayMs = this.options.turnTimeoutMs;
    attempt.deadlineTimer = setTimeout(() => {
      void this.handleTurnDeadline(attempt).catch((error) => {
        this.logger?.error("Codex turn deadline 收口失败", { error: errorMessage(error) });
      });
    }, delayMs);
  }

  private clearTurnDeadline(attempt: ActiveAttempt): void {
    if (attempt.deadlineTimer !== null) {
      clearTimeout(attempt.deadlineTimer);
      attempt.deadlineTimer = null;
    }
    if (attempt.deadlineCloseWait !== null) {
      clearTimeout(attempt.deadlineCloseWait.timer);
      attempt.deadlineCloseWait.resolve();
      attempt.deadlineCloseWait = null;
    }
  }

  private armDeadlineGraceClose(attempt: ActiveAttempt, reason: string): Promise<void> {
    if (attempt.deadlineCloseWait) return attempt.deadlineCloseWait.promise;
    if (attempt.deadlineAt === null) {
      throw new Error("Codex deadline grace 不得在绝对时限安装前启动");
    }
    const wait = deferred<void>();
    const remainingMs = Math.max(
      0,
      attempt.deadlineAt + this.options.interruptGraceMs - Date.now(),
    );
    const timer = setTimeout(() => {
      void (async () => {
        if (attempt.deadlineCloseWait?.timer === timer) {
          attempt.deadlineCloseWait = null;
        }
        try {
          if (this.activeAttempt === attempt && !attempt.terminal) {
            await this.failClosed(`${reason}；interrupt grace 已耗尽，执行结果一律不交付`);
          }
          wait.resolve();
        } catch (error) {
          wait.reject(error);
        }
      })();
    }, remainingMs);
    attempt.deadlineCloseWait = { ...wait, timer };
    return wait.promise;
  }

  private async handleTurnDeadline(attempt: ActiveAttempt): Promise<void> {
    if (this.activeAttempt !== attempt || attempt.terminal || attempt.deadlineAt === null) return;
    if (!attempt.deadlineExpired) {
      attempt.deadlineExpired = true;
      this.clearTurnDeadline(attempt);
    }
    const reason = attempt.turnId === null
      ? "Codex turn 超过绝对时限，turn/start 已发起但 turnId 仍未知"
      : `Codex turn ${attempt.turnId} 超过绝对时限`;

    if (attempt.turnId === null) {
      attempt.submissionAmbiguous = true;
      attempt.turnReady.reject(new Error(reason));
      await this.failClosed(reason);
      return;
    }

    const graceClose = this.armDeadlineGraceClose(attempt, reason);

    if (attempt.interruptionOwner === "none") {
      attempt.interruptionOwner = "timeout";
      const client = this.client;
      const layout = this.layout;
      const threadId = this.threadId;
      if (!this.ready || !client || !layout || !threadId) {
        await this.failClosed(`${reason}，但 backend 已不可用于 interrupt`);
        return;
      }
      try {
        await assertCodexRuntimeLayout(layout);
        if (
          this.activeAttempt !== attempt || attempt.terminal || this.disconnectPromise ||
          attempt.interruptionOwner !== "timeout"
        ) {
          await graceClose;
          return;
        }
        attempt.interruptPromise ??= client
          .turnInterrupt({ threadId, turnId: attempt.turnId })
          .then(() => undefined);
        void attempt.interruptPromise.catch((error) => {
          void this.failClosed(`${reason}，interrupt 失败：${errorMessage(error)}`).catch(
            (closeError) => {
              this.logger?.error("Codex timeout interrupt 失败后的收口失败", {
                error: errorMessage(closeError),
              });
            },
          );
        });
      } catch (error) {
        await this.failClosed(`${reason}，interrupt 前安全校验失败：${errorMessage(error)}`);
        return;
      }
    }
    await graceClose;
  }

  private enqueueEvent(operation: () => Promise<void>): Promise<void> {
    const run = this.eventTail.then(async () => {
      if (this.disconnectPromise) return;
      try {
        await operation();
      } catch (error) {
        await this.failClosed(`Codex 事件处理失败：${errorMessage(error)}`);
        throw error;
      }
    });
    this.eventTail = run.catch(() => undefined);
    return run;
  }

  private failClosed(reason: string): Promise<void> {
    if (this.disconnectPromise) return this.disconnectPromise;
    if (this.activeAttempt) {
      this.clearTurnDeadline(this.activeAttempt);
      this.activeAttempt.terminal = true;
    }
    this.state = this.state === "stopping" ? "stopping" : "failed";
    const executionId = this._executionId ?? `codex:${this.options.sessionKey}`;
    this.suppressProcessDisconnect = true;
    const client = this.client;
    this.client = null;
    this.disconnectPromise = (async () => {
      const closePromise = client?.close() ?? Promise.resolve();
      const persistencePromise = this.handlers.onDisconnected({
        kind: this.kind,
        executionId,
        reason,
      });
      const [close, persistence] = await Promise.allSettled([
        closePromise,
        persistencePromise,
      ]);
      const failures: unknown[] = [];
      if (persistence.status === "rejected") failures.push(persistence.reason);
      if (close.status === "rejected") failures.push(close.reason);
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `Codex fail-closed 持久化或进程组收口失败：${reason}`,
        );
      }
    })();
    return this.disconnectPromise;
  }

  private async disableBeforeSubmission(reason: string): Promise<void> {
    this.logger?.error("Codex backend 在请求写入前失效", { reason });
    this.state = "failed";
    this.suppressProcessDisconnect = true;
    const client = this.client;
    this.client = null;
    if (client) await client.close();
  }

  private async disableAfterTerminal(): Promise<void> {
    this.state = "failed";
    this.suppressProcessDisconnect = true;
    const client = this.client;
    this.client = null;
    if (client) await client.close();
  }

  private onProcessExit(exitCode: number | null, cause?: unknown): void {
    if (this.suppressProcessDisconnect || this.state === "stopped") return;
    const detail = cause ? errorMessage(cause) : `exit ${exitCode ?? "unknown"}`;
    void this.failClosed(`Codex app-server 意外退出（${detail}）`).catch((error) => {
      this.logger?.error("Codex app-server 断连持久化失败", { error: errorMessage(error) });
    });
  }
}
