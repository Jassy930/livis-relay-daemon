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
  ExecutionReadyEvent,
  ExecutionSubmission,
} from "../execution-backend.ts";
import {
  CODEX_APP_SERVER_COMMAND,
  CODEX_0145_ALLOWED_ENABLED_FEATURES,
  CODEX_DISABLED_FEATURES,
  CodexAppServerClient,
  codexLocalEnvironment,
  CodexAppServerProcessOwnershipUnconfirmedError,
  CodexAppServerRpcError,
  CodexAppServerRequestTransportError,
  CodexAppServerStartCloseUnconfirmedError,
  CodexAppServerTimeoutError,
  type CodexAppServerNotification,
  type CodexAppServerSpawn,
} from "./app-server-client.ts";
import {
  assertPinnedCodexCommand,
  assertCodexRuntimeLayout,
  buildCodexEnvironment,
  codexSecurityBindingSha256,
  CODEX_REMOTE_PERMISSION_PROFILE,
  ensureCodexRuntimeLayout,
  pinCodexCommand,
  type CodexRuntimeLayout,
  type PinnedCodexCommand,
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
export const CODEX_IDLE_RECOVERY_DELAYS_MS = [250, 1_000, 5_000] as const;

class CodexIdleRecoveryDriftError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexIdleRecoveryDriftError";
  }
}

class CodexIdleRecoveryCloseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexIdleRecoveryCloseError";
  }
}

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

export type CodexCommandPinResolver = (
  layout: CodexRuntimeLayout,
  command: string,
) => Promise<PinnedCodexCommand>;

export type CodexCommandPinAsserter = (command: PinnedCodexCommand) => Promise<void>;

export interface CodexExecutionBackendDependencies {
  store: JobStore;
  handlers: ExecutionBackendHandlers;
  logger?: Logger;
  /** 仅供测试注入 fake app-server；生产不得替换为 shell command。 */
  appServerSpawn?: CodexAppServerSpawn;
  /** 仅供测试注入版本探针；生产使用无 shell 的 argv spawn。 */
  commandRunner?: CodexCommandRunner;
  /** 仅供测试构造可验证的 fake executable identity；生产始终使用真实 fd/hash pin。 */
  commandPinResolver?: CodexCommandPinResolver;
  /** 仅供测试注入 command 漂移；生产始终重新读取并核对真实 fd/hash pin。 */
  commandPinAsserter?: CodexCommandPinAsserter;
  /** 仅供测试缩短退避；生产固定使用 CODEX_IDLE_RECOVERY_DELAYS_MS。 */
  recoveryDelaysMs?: readonly number[];
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
  clientEpoch: number;
}

function backendSessionRecoveryAnchor(session: StoredBackendSession): string {
  return sha256(JSON.stringify([
    session.scopeKey,
    session.backend,
    session.sessionKey,
    session.sessionHash,
    session.threadId,
    session.cwd,
    session.cliVersion,
    session.accountType,
    session.accountSubjectSha256,
    session.accountIdentityStrength,
    session.requestedModel,
    session.effectiveModel,
    session.modelProvider,
    session.securityConfigSha256,
    session.featureSnapshotSha256,
    session.checkpointTurnId,
    session.checkpointTurnStatus,
    session.checkpointTurnCount,
    session.checkpointTurnsSha256,
    session.checkpointedAt,
    session.createdAt,
  ]));
}

type BackendState =
  | "idle"
  | "starting"
  | "recovering"
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

const SAFE_CODEX_ERROR_LABELS = new Map<string, string>([
  ["contextWindowExceeded", "上下文窗口超限"],
  ["sessionBudgetExceeded", "会话预算已耗尽"],
  ["usageLimitExceeded", "账号使用额度已耗尽"],
  ["serverOverloaded", "provider 过载"],
  ["cyberPolicy", "请求被安全策略拒绝"],
  ["internalServerError", "provider 内部错误"],
  ["unauthorized", "provider 认证失败"],
  ["badRequest", "provider 拒绝了无效请求"],
  ["threadRollbackFailed", "thread 回滚失败"],
  ["sandboxError", "sandbox 执行失败"],
  ["other", "provider 返回未分类错误"],
]);

/**
 * provider message 可能包含 API key 的掩码片段或其他账号信息，不能直接进入
 * JobStore、Relay 或共享日志。这里只保留经过白名单审核的错误分类。
 */
interface SafeCodexTurnFailure {
  message: string;
  credentialRejected: boolean;
}

function safeCodexTurnFailure(value: unknown): SafeCodexTurnFailure {
  if (!isRecord(value)) {
    return { message: "Codex turn 执行失败", credentialRejected: false };
  }
  const message = typeof value.message === "string" ? value.message : "";
  if (/\binvalid_api_key\b/i.test(message) || /Incorrect API key provided/i.test(message)) {
    return {
      message: "Codex provider 认证失败（401 invalid_api_key）",
      credentialRejected: true,
    };
  }

  const errorInfo = value.codexErrorInfo;
  if (typeof errorInfo === "string") {
    const label = SAFE_CODEX_ERROR_LABELS.get(errorInfo);
    return {
      message: label ? `Codex ${label}` : "Codex turn 执行失败",
      credentialRejected: errorInfo === "unauthorized",
    };
  }
  if (isRecord(errorInfo)) {
    for (const [kind, detail] of Object.entries(errorInfo)) {
      if (![
        "httpConnectionFailed",
        "responseStreamConnectionFailed",
        "responseStreamDisconnected",
        "responseTooManyFailedAttempts",
      ].includes(kind)) {
        continue;
      }
      const status = isRecord(detail) && Number.isSafeInteger(detail.httpStatusCode) &&
          Number(detail.httpStatusCode) >= 100 && Number(detail.httpStatusCode) <= 599
        ? Number(detail.httpStatusCode)
        : null;
      return {
        message: status === null
          ? `Codex provider 连接失败（${kind}）`
          : `Codex provider 连接失败（${kind} HTTP ${status}）`,
        credentialRejected: status === 401,
      };
    }
  }
  return { message: "Codex turn 执行失败", credentialRejected: false };
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
  // requiresOpenaiAuth 描述当前 provider 是否依赖 OpenAI 认证，不描述登录是否缺失。
  // 官方协议明确允许 apiKey/chatgpt account 与 true，以及 null 与 false 的组合；
  // 生产启动是否已配置账号只由 account 是否为对象裁决。
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

interface CodexThreadTailCheckpoint {
  turnId: string | null;
  turnStatus: "completed" | "failed" | "interrupted" | null;
  turnCount: number;
  turnsSha256: string;
}

export interface CodexThreadTailInspection extends CodexThreadTailCheckpoint {
  threadStatus: "idle";
}

interface CodexCheckpointThreadTailInspection extends CodexThreadTailCheckpoint {
  threadStatus: "idle" | "systemError";
}

interface CodexSystemErrorDispatchMarker {
  threadStatus: "systemError";
  threadId: string;
  clientEpoch: number;
  turnId: string;
  turnStatus: "failed";
  turnCount: number;
  turnsSha256: string;
}

function assertStoredThreadCheckpoint(
  stored: StoredBackendSession,
  actual: CodexThreadTailCheckpoint,
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

function parseCodexThreadTail(
  value: unknown,
  expectedThreadId: string,
): CodexCheckpointThreadTailInspection {
  const response = requireRecord(value, "thread/read response");
  const thread = requireRecord(response.thread, "thread/read response.thread");
  const threadId = nonEmptyString(thread.id, "thread/read response.thread.id");
  if (threadId !== expectedThreadId) {
    throw new Error("Codex thread/read 返回了不同 threadId");
  }
  const status = requireRecord(thread.status, "thread/read response.thread.status");
  const statusType = nonEmptyString(status.type, "thread/read response.thread.status.type");
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
  if (statusType !== "idle" && statusType !== "systemError") {
    throw new Error(`Codex thread 当前不是稳定终态：${statusType}`);
  }
  if (statusType === "systemError" && tail?.status !== "failed") {
    throw new Error("Codex thread 的 systemError 没有对应 failed tail");
  }
  return {
    threadStatus: statusType,
    turnId: tail?.id ?? null,
    turnStatus: tail?.status ?? null,
    turnCount: turns.length,
    turnsSha256: sha256(JSON.stringify(turns)),
  };
}

export function inspectCodexThreadTail(
  value: unknown,
  expectedThreadId: string,
): CodexThreadTailInspection {
  const tail = parseCodexThreadTail(value, expectedThreadId);
  if (tail.threadStatus !== "idle") {
    throw new Error(`Codex thread 当前不是 idle：${tail.threadStatus}`);
  }
  return { ...tail, threadStatus: "idle" };
}

function inspectCodexCheckpointThreadTail(
  value: unknown,
  expectedThreadId: string,
): CodexCheckpointThreadTailInspection {
  return parseCodexThreadTail(value, expectedThreadId);
}

function inspectTerminalCodexThreadTail(
  value: unknown,
  expectedThreadId: string,
  expectedTurnId: string,
  expectedStatus: "completed" | "failed" | "interrupted",
): CodexCheckpointThreadTailInspection {
  const tail = parseCodexThreadTail(value, expectedThreadId);
  if (tail.turnId !== expectedTurnId || tail.turnStatus !== expectedStatus) {
    throw new Error(
      `Codex terminal checkpoint 与通知不一致：${tail.turnId ?? "<empty>"}/${tail.turnStatus ?? "<empty>"}`,
    );
  }
  if (tail.threadStatus === "systemError" && expectedStatus !== "failed") {
    throw new Error("Codex thread 的 systemError 只能对应 failed terminal");
  }
  return tail;
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
  return validatePersistedCodexRollout(value, layout, expectedThreadId);
}

async function inspectPersistedCodexCheckpointTail(
  value: unknown,
  layout: CodexRuntimeLayout,
  expectedThreadId: string,
): Promise<CodexCheckpointThreadTailInspection> {
  const tail = inspectCodexCheckpointThreadTail(value, expectedThreadId);
  await validatePersistedCodexRollout(value, layout, expectedThreadId);
  return tail;
}

async function validatePersistedCodexRollout(
  value: unknown,
  layout: CodexRuntimeLayout,
  expectedThreadId: string,
): Promise<string> {
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
  private readonly commandPinResolver: CodexCommandPinResolver;
  private readonly commandPinAsserter: CodexCommandPinAsserter;
  private state: BackendState = "idle";
  private layout: CodexRuntimeLayout | null = null;
  private client: CodexAppServerClient | null = null;
  private cliVersion: string | null = null;
  private accountType: string | null = null;
  private threadId: string | null = null;
  private recoveryAnchorSha256: string | null = null;
  private _executionId: string | null = null;
  private activeAttempt: ActiveAttempt | null = null;
  private eventTail: Promise<void> = Promise.resolve();
  private disconnectPromise: Promise<void> | null = null;
  private recoveryPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private startInProgress = false;
  private clientEpoch = 0;
  private systemErrorDispatchMarker: CodexSystemErrorDispatchMarker | null = null;
  private recoveryAttempts = 0;
  private recoveryNextAttemptAt: number | null = null;
  private recoveryLastError: string | null = null;
  private terminalCleanupError: unknown | null = null;
  private cancelRecoveryDelay: (() => void) | null = null;
  private readonly recoveryDelaysMs: readonly number[];
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
    this.commandPinResolver = dependencies.commandPinResolver ?? pinCodexCommand;
    this.commandPinAsserter = dependencies.commandPinAsserter ?? assertPinnedCodexCommand;
    this.recoveryDelaysMs = Object.freeze([
      ...(dependencies.recoveryDelaysMs ?? CODEX_IDLE_RECOVERY_DELAYS_MS),
    ]);
    if (
      this.recoveryDelaysMs.length !== CODEX_IDLE_RECOVERY_DELAYS_MS.length ||
      this.recoveryDelaysMs.some((delayMs) =>
        !Number.isSafeInteger(delayMs) || delayMs < 0
      )
    ) {
      throw new Error("Codex idle recovery 退避必须包含三个非负安全整数");
    }
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
    this.startInProgress = true;
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
      const commandPin = await this.commandPinResolver(layout, this.options.command);
      const command = commandPin.path;
      const securityConfigSha256 = codexSecurityBindingSha256(layout, commandPin);
      const storedSession = this.store.getBackendSession(this.kind, this.options.sessionKey);
      if (
        storedSession?.securityConfigSha256 !== null &&
        storedSession?.securityConfigSha256 !== undefined &&
        storedSession.securityConfigSha256 !== securityConfigSha256
      ) {
        this.store.quarantineSession(
          this.options.sessionKey,
          "Codex 安全配置或 command 文件身份与持久 session 不一致",
        );
        throw new Error("Codex 安全配置或 command 文件身份已漂移；必须人工 release session");
      }
      const versionResult = await this.commandRunner([command, "--version"], {
        cwd: layout.workspace,
        env: environment,
        timeoutMs: this.options.requestTimeoutMs,
      });
      await this.commandPinAsserter(commandPin);
      const cliVersion = validateCodexVersion(versionResult);
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

      this.systemErrorDispatchMarker = null;
      const clientEpoch = ++this.clientEpoch;
      await this.commandPinAsserter(commandPin);
      client = await CodexAppServerClient.start({
        command: buildAppServerCommand(command),
        cwd: layout.workspace,
        env: environment,
        spawn: this.appServerSpawn,
        requestTimeoutMs: this.options.requestTimeoutMs,
        closeTimeoutMs: this.options.shutdownTimeoutMs,
        capabilities: { experimentalApi: true, requestAttestation: false },
        onNotification: (notification) => this.receiveNotification(notification, clientEpoch),
        onApprovalRequest: (request) => {
          this.logger?.warn("Codex app-server 审批请求已默认拒绝", { method: request.method });
        },
      });
      this.client = client;
      void client.exited.then(
        (exitCode) => this.onProcessExit(client!, clientEpoch, exitCode),
        (error: unknown) => this.onProcessExit(client!, clientEpoch, null, error),
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
      await this.commandPinAsserter(commandPin);
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
        const boundSession = this.store.getBackendSession(this.kind, this.options.sessionKey)!;
        assertStoredThreadCheckpoint(boundSession, threadTail);
        this.recoveryAnchorSha256 = backendSessionRecoveryAnchor(boundSession);
      } catch (error) {
        this.store.quarantineSession(
          this.options.sessionKey,
          `Codex thread 已返回但安全回读、rollout 物化或 SQLite bind 失败：${errorMessage(error)}`,
        );
        throw error;
      }
      await assertCodexRuntimeLayout(layout);
      await this.commandPinAsserter(commandPin);

      this.layout = layout;
      this.cliVersion = cliVersion;
      this.accountType = account.accountType;
      this.threadId = threadId;
      this._executionId = `codex:${threadId}`;
      if (!client.running) {
        throw new Error("Codex app-server 在 ready 发布前已经退出");
      }
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
      if (!this.ready || !client.running) {
        throw new Error("Codex backend 在 ready handler 期间失效");
      }
      this.startInProgress = false;
      this.logger?.info("Codex app-server backend 已就绪", {
        executionId: this._executionId,
        cliVersion,
      });
    } catch (error) {
      this.startInProgress = false;
      this.state = "failed";
      this.client = null;
      if (
        error instanceof CodexAppServerStartCloseUnconfirmedError ||
        error instanceof CodexAppServerProcessOwnershipUnconfirmedError
      ) {
        this.terminalCleanupError ??= error;
        this.store.quarantineSession(
          this.options.sessionKey,
          `Codex backend 启动后无法确认进程组所有权或收口：${errorMessage(error)}`,
        );
      }
      if (client) {
        try {
          await client.close();
        } catch (closeError) {
          this.terminalCleanupError ??= closeError;
          this.store.quarantineSession(
            this.options.sessionKey,
            `Codex backend 启动失败且 app-server 进程组收口未确认：${errorMessage(closeError)}`,
          );
          throw new AggregateError(
            [error, closeError],
            "Codex backend 启动失败且 app-server 进程组收口未确认",
          );
        }
      }
      throw error;
    }
  }

  private recoveryEligibilityIssue(): string | null {
    if (this.activeAttempt !== null) return "内存中仍有 active attempt";
    if (!this.layout || !this.cliVersion || !this.threadId || !this.recoveryAnchorSha256) {
      return "运行时、thread 或 recovery anchor 未完整绑定";
    }
    const stored = this.store.getBackendSession(this.kind, this.options.sessionKey);
    if (!stored) return "持久 backend session 不存在";
    if (stored.threadId !== this.threadId) return "持久 threadId 已漂移";
    if (stored.recoveryRequired) return "持久 session 已要求人工 recovery";
    if (
      stored.activeJobId !== null || stored.activeLeaseId !== null ||
      stored.activeRunGeneration !== null || stored.activeTurnId !== null
    ) {
      return "SQLite 已存在 active attempt evidence";
    }
    if (backendSessionRecoveryAnchor(stored) !== this.recoveryAnchorSha256) {
      return "持久 metadata/checkpoint 已偏离最后一次 daemon anchor";
    }
    const quarantine = this.store.getSessionQuarantine(this.options.sessionKey);
    return quarantine ? `session 已在 quarantine：${quarantine.reason}` : null;
  }

  private isStopping(): boolean {
    return this.state === "stopping" || this.state === "stopped";
  }

  private requireRecoveryStoreFence(): StoredBackendSession {
    const issue = this.recoveryEligibilityIssue();
    if (issue) {
      throw new CodexIdleRecoveryDriftError(`Codex idle recovery Store fence 失败：${issue}`);
    }
    return this.store.getBackendSession(this.kind, this.options.sessionKey)!;
  }

  private recoveryDrift<T>(label: string, operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      throw new CodexIdleRecoveryDriftError(`${label}：${errorMessage(error)}`, { cause: error });
    }
  }

  private waitForRecoveryDelay(delayMs: number): Promise<boolean> {
    if (this.state !== "recovering") return Promise.resolve(false);
    this.recoveryNextAttemptAt = Date.now() + delayMs;
    return new Promise<boolean>((resolvePromise) => {
      let settled = false;
      const finish = (elapsed: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.cancelRecoveryDelay === cancel) this.cancelRecoveryDelay = null;
        this.recoveryNextAttemptAt = null;
        resolvePromise(elapsed);
      };
      const cancel = (): void => finish(false);
      const timer = setTimeout(() => finish(true), delayMs);
      this.cancelRecoveryDelay = cancel;
    });
  }

  private beginIdleRecovery(
    exitedClient: CodexAppServerClient,
    detail: string,
  ): void {
    if (this.recoveryPromise !== null || this.disconnectPromise !== null) return;
    this.state = "recovering";
    this.recoveryLastError = null;
    let tracked!: Promise<void>;
    tracked = this.recoverIdleAppServer(exitedClient, detail)
      .catch(async (error) => {
        if (this.isStopping()) throw error;
        if (this.disconnectPromise) {
          try {
            await this.disconnectPromise;
          } catch (disconnectError) {
            throw new AggregateError(
              [error, disconnectError],
              "Codex idle recovery 异常退出且 fail-closed 收口失败",
            );
          }
          if (error instanceof CodexIdleRecoveryCloseError) throw error;
          return;
        }
        await this.failIdleRecovery(
          `Codex idle recovery 异常退出：${errorMessage(error)}`,
          error,
          error instanceof CodexIdleRecoveryCloseError,
        );
        if (error instanceof CodexIdleRecoveryCloseError) throw error;
      })
      .finally(() => {
        if (this.recoveryPromise === tracked) {
          this.recoveryPromise = null;
          this.recoveryNextAttemptAt = null;
          this.cancelRecoveryDelay = null;
        }
      });
    this.recoveryPromise = tracked;
    void tracked.catch((error) => {
      this.logger?.error("Codex idle recovery 收口失败", { error: errorMessage(error) });
    });
  }

  private async closeRecoveryClient(
    client: CodexAppServerClient,
    label: string,
  ): Promise<void> {
    try {
      await client.close();
    } catch (error) {
      const closeError = new CodexIdleRecoveryCloseError(
        `${label}的进程组收口未确认：${errorMessage(error)}`,
        { cause: error },
      );
      this.terminalCleanupError ??= closeError;
      throw closeError;
    }
    if (this.client === client) this.client = null;
  }

  private async closeClientForStop(client: CodexAppServerClient): Promise<void> {
    try {
      await client.close();
    } catch (error) {
      this.terminalCleanupError ??= error;
      this.store.quarantineSession(
        this.options.sessionKey,
        `Codex stop 无法确认 app-server 进程组收口：${errorMessage(error)}`,
      );
      throw error;
    }
  }

  private async failIdleRecovery(
    reason: string,
    error: unknown,
    quarantine: boolean,
  ): Promise<void> {
    this.recoveryLastError = errorMessage(error);
    if (quarantine) {
      this.store.quarantineSession(this.options.sessionKey, reason);
    }
    try {
      await this.failClosed(reason);
    } catch (disconnectError) {
      throw new AggregateError(
        [error, disconnectError],
        `Codex idle recovery 失败且最终收口未确认：${reason}`,
      );
    }
  }

  private async recoverIdleAppServer(
    exitedClient: CodexAppServerClient,
    exitDetail: string,
  ): Promise<void> {
    try {
      await this.closeRecoveryClient(exitedClient, "退出的 Codex app-server");
    } catch (error) {
      if (this.state === "stopping") throw error;
      await this.failIdleRecovery(
        `Codex idle app-server 退出后旧进程组无法确认关闭（${exitDetail}）`,
        error,
        true,
      );
      throw error;
    }
    if (this.state !== "recovering") return;

    while (this.recoveryAttempts < this.recoveryDelaysMs.length) {
      const delayMs = this.recoveryDelaysMs[this.recoveryAttempts]!;
      if (!await this.waitForRecoveryDelay(delayMs) || this.state !== "recovering") return;
      this.recoveryAttempts += 1;

      let readyEvent: ExecutionReadyEvent;
      try {
        readyEvent = await this.recoverIdleAttempt();
      } catch (error) {
        this.recoveryLastError = errorMessage(error);
        const candidate = this.client;
        if (candidate) {
          try {
            await this.closeRecoveryClient(candidate, "失败的 Codex recovery candidate");
          } catch (closeError) {
            if (this.isStopping()) throw closeError;
            await this.failIdleRecovery(
              "Codex idle recovery candidate 的进程组收口未确认",
              closeError,
              true,
            );
            throw closeError;
          }
        }
        if (error instanceof CodexIdleRecoveryCloseError) {
          if (this.isStopping()) throw error;
          await this.failIdleRecovery(
            "Codex idle recovery candidate 在启动/initialize 阶段的进程组收口未确认",
            error,
            true,
          );
          throw error;
        }
        if (this.isStopping()) return;
        if (error instanceof CodexIdleRecoveryDriftError) {
          await this.failIdleRecovery(
            `Codex idle recovery 检测到 metadata/checkpoint/tail 漂移：${errorMessage(error)}`,
            error,
            true,
          );
          return;
        }
        if (this.recoveryAttempts >= this.recoveryDelaysMs.length) {
          await this.failIdleRecovery(
            `Codex idle recovery 已耗尽 ${this.recoveryAttempts} 次 daemon 生命周期预算：${errorMessage(error)}`,
            error,
            false,
          );
          return;
        }
        this.state = "recovering";
        continue;
      }

      const recoveredClient = this.client;
      if (
        this.state !== "recovering" || !recoveredClient || !recoveredClient.running ||
        this.activeAttempt !== null
      ) {
        if (recoveredClient) {
          await this.closeRecoveryClient(recoveredClient, "未能发布 ready 的 recovery candidate");
        }
        if (this.isStopping()) return;
        const error = new Error("Codex recovery candidate 在 ready 发布前失效");
        await this.failIdleRecovery(error.message, error, false);
        return;
      }

      // 必须先原子撤销 recovering/ready=false，daemon 的 onReady 才能看到可派发状态。
      // onReady 不进入 eventTail，避免 onReady→dispatch→onAccepted 与 eventTail 自死锁。
      this.state = "running";
      try {
        await this.handlers.onReady(readyEvent);
      } catch (error) {
        if (this.isStopping()) return;
        await this.failIdleRecovery(
          `Codex idle recovery ready handler 失败：${errorMessage(error)}`,
          error,
          false,
        );
        return;
      }
      if (this.isStopping()) return;
      if (!this.ready || this.client !== recoveredClient || !recoveredClient.running) {
        const error = new Error("Codex backend 在 recovery ready handler 期间失效");
        await this.failIdleRecovery(error.message, error, false);
        return;
      }
      this.logger?.info("Codex app-server idle recovery 已完成", {
        executionId: this._executionId,
        recoveryAttempts: this.recoveryAttempts,
      });
      return;
    }
  }

  private async recoverIdleAttempt(): Promise<ExecutionReadyEvent> {
    const layout = this.layout;
    const expectedCliVersion = this.cliVersion;
    const expectedThreadId = this.threadId;
    if (!layout || !expectedCliVersion || !expectedThreadId) {
      throw new CodexIdleRecoveryDriftError("Codex recovery anchor 未完整绑定");
    }
    this.requireRecoveryStoreFence();
    try {
      await assertCodexRuntimeLayout(layout);
    } catch (error) {
      throw new CodexIdleRecoveryDriftError(
        `Codex recovery runtime layout 已漂移：${errorMessage(error)}`,
        { cause: error },
      );
    }
    const environment = await buildCodexEnvironment(layout).catch((error) => {
      throw new CodexIdleRecoveryDriftError(
        `Codex recovery environment 无法重建：${errorMessage(error)}`,
        { cause: error },
      );
    });
    const commandPin = await this.commandPinResolver(layout, this.options.command)
      .catch((error) => {
          throw new CodexIdleRecoveryDriftError(
            `Codex recovery command 已漂移：${errorMessage(error)}`,
            { cause: error },
          );
        });
    const command = commandPin.path;
    const securityConfigSha256 = codexSecurityBindingSha256(layout, commandPin);
    const storedBeforeCommand = this.requireRecoveryStoreFence();
    if (storedBeforeCommand.securityConfigSha256 !== securityConfigSha256) {
      throw new CodexIdleRecoveryDriftError(
        "Codex recovery 安全配置或 command 文件身份与持久 session 不一致",
      );
    }
    const versionResult = await this.commandRunner([command, "--version"], {
      cwd: layout.workspace,
      env: environment,
      timeoutMs: this.options.requestTimeoutMs,
    });
    await this.commandPinAsserter(commandPin).catch((error) => {
      throw new CodexIdleRecoveryDriftError(
        `Codex recovery command 在版本探针后已漂移：${errorMessage(error)}`,
        { cause: error },
      );
    });
    const cliVersion = this.recoveryDrift(
      "Codex recovery CLI 版本无效",
      () => validateCodexVersion(versionResult),
    );
    if (cliVersion !== expectedCliVersion) {
      throw new CodexIdleRecoveryDriftError(
        `Codex recovery CLI 版本漂移：${expectedCliVersion} → ${cliVersion}`,
      );
    }
    this.requireRecoveryStoreFence();
    if (this.state !== "recovering") throw new Error("Codex recovery 已被停止");

    this.systemErrorDispatchMarker = null;
    const clientEpoch = ++this.clientEpoch;
    let client: CodexAppServerClient;
    try {
      await this.commandPinAsserter(commandPin);
      client = await CodexAppServerClient.start({
        command: buildAppServerCommand(command),
        cwd: layout.workspace,
        env: environment,
        spawn: this.appServerSpawn,
        requestTimeoutMs: this.options.requestTimeoutMs,
        closeTimeoutMs: this.options.shutdownTimeoutMs,
        capabilities: { experimentalApi: true, requestAttestation: false },
        onNotification: (notification) => this.receiveNotification(notification, clientEpoch),
        onApprovalRequest: (request) => {
          if (clientEpoch !== this.clientEpoch) return;
          this.logger?.warn("Codex recovery app-server 审批请求已默认拒绝", {
            method: request.method,
          });
        },
      });
    } catch (error) {
      if (
        error instanceof CodexAppServerStartCloseUnconfirmedError ||
        error instanceof CodexAppServerProcessOwnershipUnconfirmedError
      ) {
        const closeError = new CodexIdleRecoveryCloseError(
          `Codex recovery candidate 在启动/initialize 阶段的进程组收口未确认：${errorMessage(error)}`,
          { cause: error },
        );
        this.terminalCleanupError ??= closeError;
        throw closeError;
      }
      throw error;
    }
    this.client = client;
    void client.exited.then(
      (exitCode) => this.onProcessExit(client, clientEpoch, exitCode),
      (error: unknown) => this.onProcessExit(client, clientEpoch, null, error),
    );
    if (this.state !== "recovering") throw new Error("Codex recovery 已被停止");

    this.recoveryDrift(
      "Codex recovery initialize 回读漂移",
      () => validateCodexInitializeResponse(client.initializeResult, layout, cliVersion),
    );
    const accountResponse = await client.request("account/read", { refreshToken: false });
    const account = this.recoveryDrift(
      "Codex recovery account 回读漂移",
      () => validateAccountResponse(accountResponse),
    );
    const permissionProfiles = await client.request("permissionProfile/list", {
      cwd: layout.workspace,
    });
    this.recoveryDrift(
      "Codex recovery permission profile 漂移",
      () => validatePermissionProfiles(permissionProfiles),
    );
    const featureList = await client.request("experimentalFeature/list", {
      cursor: null,
      limit: 256,
    });
    const featureSnapshotSha256 = this.recoveryDrift(
      "Codex recovery feature snapshot 漂移",
      () => validateDisabledCodexFeatures(featureList, cliVersion),
    );
    try {
      await assertCodexRuntimeLayout(layout);
      await this.commandPinAsserter(commandPin);
    } catch (error) {
      throw new CodexIdleRecoveryDriftError(
        `Codex recovery 安全回读后 runtime layout 已漂移：${errorMessage(error)}`,
        { cause: error },
      );
    }
    const storedBeforeResume = this.requireRecoveryStoreFence();
    if (
      storedBeforeResume.accountType !== account.accountType ||
      storedBeforeResume.accountSubjectSha256 !== account.accountSubjectSha256 ||
      storedBeforeResume.accountIdentityStrength !== account.identityStrength ||
      storedBeforeResume.requestedModel !== this.options.model ||
      storedBeforeResume.securityConfigSha256 !== securityConfigSha256 ||
      storedBeforeResume.featureSnapshotSha256 !== featureSnapshotSha256
    ) {
      throw new CodexIdleRecoveryDriftError(
        "Codex recovery 账号、请求模型、安全配置或 feature snapshot 已漂移",
      );
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
      threadResponse = await client.threadResume({
        threadId: expectedThreadId,
        ...commonThreadParams,
      });
    } catch (error) {
      if (error instanceof CodexAppServerRpcError) {
        throw new CodexIdleRecoveryDriftError(
          `Codex recovery 无法 resume 已绑定 thread：${errorMessage(error)}`,
          { cause: error },
        );
      }
      throw error;
    }
    const threadInspection = this.recoveryDrift(
      "Codex recovery thread response 漂移",
      () => inspectThreadResponse(threadResponse, layout, expectedThreadId),
    );
    if (
      (this.options.model !== null && threadInspection.effectiveModel !== this.options.model) ||
      storedBeforeResume.effectiveModel !== threadInspection.effectiveModel ||
      storedBeforeResume.modelProvider !== threadInspection.modelProvider
    ) {
      throw new CodexIdleRecoveryDriftError("Codex recovery 实际 model/provider 已漂移");
    }
    const persisted = await client.threadRead({
      threadId: expectedThreadId,
      includeTurns: true,
    });
    try {
      await validatePersistedCodexThread(persisted, layout, expectedThreadId);
    } catch (error) {
      throw new CodexIdleRecoveryDriftError(
        `Codex recovery rollout/tail 回读漂移：${errorMessage(error)}`,
        { cause: error },
      );
    }
    const actualTail = this.recoveryDrift(
      "Codex recovery thread tail 漂移",
      () => inspectCodexThreadTail(persisted, expectedThreadId),
    );
    const storedAfterRead = this.requireRecoveryStoreFence();
    this.recoveryDrift(
      "Codex recovery checkpoint 漂移",
      () => assertStoredThreadCheckpoint(storedAfterRead, actualTail),
    );
    try {
      await assertCodexRuntimeLayout(layout);
    } catch (error) {
      throw new CodexIdleRecoveryDriftError(
        `Codex recovery 完成前 runtime layout 已漂移：${errorMessage(error)}`,
        { cause: error },
      );
    }
    this.requireRecoveryStoreFence();
    if (
      this.state !== "recovering" || this.client !== client ||
      clientEpoch !== this.clientEpoch || !client.running
    ) {
      throw new Error("Codex recovery candidate 在安全交接前退出");
    }

    this.accountType = account.accountType;
    return {
      kind: this.kind,
      executionId: `codex:${expectedThreadId}`,
      implementation: {
        name: "codex-app-server",
        version: cliVersion,
        accountType: account.accountType,
        accountIdentityStrength: account.identityStrength,
        effectiveModel: threadInspection.effectiveModel,
        modelProvider: threadInspection.modelProvider,
        featureSnapshotSha256,
        permissionProfile: CODEX_REMOTE_PERMISSION_PROFILE,
      },
    };
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    if (this.state === "stopped") return;
    const hadActiveAttempt = this.activeAttempt !== null && !this.activeAttempt.terminal;
    this.state = "stopping";
    this.cancelRecoveryDelay?.();

    const failures: unknown[] = [];
    const seen = new Set<Promise<unknown>>();
    const settle = async (promises: Array<Promise<unknown> | null>): Promise<void> => {
      const pending = promises.filter((promise): promise is Promise<unknown> => {
        if (!promise || seen.has(promise)) return false;
        seen.add(promise);
        return true;
      });
      const results = await Promise.allSettled(pending);
      for (const result of results) {
        if (result.status === "rejected") failures.push(result.reason);
      }
    };

    let stopDisconnect: Promise<void> | null = null;
    if (hadActiveAttempt) {
      stopDisconnect = this.failClosed("daemon 停止时 Codex turn 仍处于活动状态");
    } else {
      const client = this.client;
      this.client = null;
      if (client) {
        await settle([this.closeClientForStop(client)]);
      }
    }

    await settle([
      stopDisconnect,
      this.recoveryPromise,
      this.disconnectPromise,
      this.eventTail,
    ]);
    const lateClient = this.client;
    this.client = null;
    await settle([
      this.recoveryPromise,
      this.disconnectPromise,
      lateClient ? this.closeClientForStop(lateClient) : null,
      this.eventTail,
    ]);
    if (this.terminalCleanupError !== null) failures.push(this.terminalCleanupError);
    this.state = "stopped";
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Codex backend 停止期间存在未确认的进程组收口或清理错误",
      );
    }
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
    const stored = this.store.getBackendSession(this.kind, this.options.sessionKey);
    return {
      kind: this.kind,
      state: this.state,
      ready: this.ready,
      executionId: this.executionId,
      cliVersion: this.cliVersion,
      threadId: this.threadId,
      accountType: stored?.accountType ?? this.accountType,
      accountIdentityStrength: stored?.accountIdentityStrength ?? null,
      requestedModel: stored?.requestedModel ?? this.options.model,
      effectiveModel: stored?.effectiveModel ?? null,
      modelProvider: stored?.modelProvider ?? null,
      checkpoint: stored
        ? {
            turnId: stored.checkpointTurnId,
            turnStatus: stored.checkpointTurnStatus,
            turnCount: stored.checkpointTurnCount,
            checkpointedAt: stored.checkpointedAt,
          }
        : null,
      recovery: {
        inProgress: this.recoveryPromise !== null,
        attempts: this.recoveryAttempts,
        maxAttempts: this.recoveryDelaysMs.length,
        nextAttemptAt: this.recoveryNextAttemptAt,
        lastError: this.recoveryLastError,
      },
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

  private receiveNotification(
    notification: CodexAppServerNotification,
    clientEpoch: number,
  ): void {
    if (clientEpoch !== this.clientEpoch) return;
    if (!relevantNotification(notification)) return;
    const attempt = this.activeAttempt;
    if (!attempt || attempt.terminal || notificationThreadId(notification) !== this.threadId) return;
    const admitted = this.admitNotification(attempt, notification, clientEpoch);
    if (!admitted) return;
    if (attempt.turnId === null) {
      attempt.bufferedNotifications.push(admitted);
      return;
    }
    this.enqueueNotification(attempt, admitted);
  }

  private enqueueNotification(attempt: ActiveAttempt, admitted: AdmittedNotification): void {
    void this.enqueueEvent(async () => {
      if (admitted.clientEpoch !== this.clientEpoch) return;
      await this.processNotification(admitted.notification, admitted.clientEpoch);
    }).finally(() => {
      this.releaseNotification(attempt, admitted);
    }).catch(() => undefined);
  }

  private admitNotification(
    attempt: ActiveAttempt,
    notification: CodexAppServerNotification,
    clientEpoch: number,
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
    return { notification, bytes, clientEpoch };
  }

  private releaseNotification(attempt: ActiveAttempt, admitted: AdmittedNotification): void {
    attempt.pendingNotificationCount = Math.max(0, attempt.pendingNotificationCount - 1);
    attempt.pendingNotificationBytes = Math.max(0, attempt.pendingNotificationBytes - admitted.bytes);
  }

  private async processNotification(
    notification: CodexAppServerNotification,
    clientEpoch: number,
  ): Promise<void> {
    if (clientEpoch !== this.clientEpoch) return;
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
      const failure = safeCodexTurnFailure(turn.error);
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
      await this.handlers.onFailed({
        ...this.jobEvent(attempt),
        error: failure.message,
        retryable: false,
        ...(failure.credentialRejected
          ? { sessionDisposition: "credential_rejected" as const }
          : {}),
      });
      this.activeAttempt = null;
      if (failure.credentialRejected) {
        await this.disableAfterTerminal("Codex provider 拒绝凭据后");
      }
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
    const actual = await inspectPersistedCodexCheckpointTail(
      persisted,
      this.layout,
      this.threadId,
    );
    const stored = this.store.getBackendSession(this.kind, this.options.sessionKey);
    if (!stored || stored.threadId !== this.threadId || stored.recoveryRequired) {
      throw new Error("Codex backend session checkpoint 当前不可用于 dispatch");
    }
    assertStoredThreadCheckpoint(stored, actual);
    if (actual.threadStatus === "systemError") {
      const marker = this.systemErrorDispatchMarker;
      if (
        !marker || marker.clientEpoch !== this.clientEpoch ||
        marker.threadId !== this.threadId || marker.turnId !== actual.turnId ||
        marker.turnStatus !== actual.turnStatus || marker.turnCount !== actual.turnCount ||
        marker.turnsSha256 !== actual.turnsSha256
      ) {
        throw new Error(
          "Codex thread 的 systemError 未绑定到当前 app-server 进程实际观察到的 failed terminal",
        );
      }
    } else {
      // 同进程中若状态已回到 idle，旧 systemError marker 不得在之后再次复活。
      this.systemErrorDispatchMarker = null;
    }
  }

  private async checkpointTerminalThread(
    attempt: ActiveAttempt,
    expectedStatus: "completed" | "failed" | "interrupted",
  ): Promise<CodexCheckpointThreadTailInspection> {
    if (!this.client || !this.layout || !this.threadId || !attempt.turnId) {
      throw new Error("Codex terminal checkpoint 时 backend/turn 未完整绑定");
    }
    const persisted = await this.client.threadRead({
      threadId: this.threadId,
      includeTurns: true,
    });
    const tail = inspectTerminalCodexThreadTail(
      persisted,
      this.threadId,
      attempt.turnId,
      expectedStatus,
    );
    await validatePersistedCodexRollout(persisted, this.layout, this.threadId);
    const checkpointedSession = this.store.checkpointBackendThreadTail({
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
    this.recoveryAnchorSha256 = backendSessionRecoveryAnchor(checkpointedSession);
    if (tail.threadStatus === "systemError") {
      if (!tail.turnId || tail.turnStatus !== "failed") {
        throw new Error("Codex systemError terminal marker 缺少 failed turn 绑定");
      }
      this.systemErrorDispatchMarker = {
        ...tail,
        threadStatus: "systemError",
        threadId: this.threadId,
        clientEpoch: this.clientEpoch,
        turnId: tail.turnId,
        turnStatus: "failed",
      };
    } else {
      this.systemErrorDispatchMarker = null;
    }
    return tail;
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
    this.cancelRecoveryDelay?.();
    if (this.activeAttempt) {
      this.clearTurnDeadline(this.activeAttempt);
      this.activeAttempt.terminal = true;
    }
    this.state = this.state === "stopping" ? "stopping" : "failed";
    const executionId = this._executionId ?? `codex:${this.options.sessionKey}`;
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
      if (close.status === "rejected") {
        try {
          this.store.quarantineSession(
            this.options.sessionKey,
            `Codex fail-closed 进程组收口未确认：${reason}`,
          );
        } catch (quarantineError) {
          failures.push(quarantineError);
        }
        failures.push(close.reason);
      }
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
    this.state = this.state === "stopping" ? "stopping" : "failed";
    const client = this.client;
    this.client = null;
    if (client) await this.closeDetachedClient(client, "Codex 请求提交前");
  }

  private async disableAfterTerminal(label = "Codex terminal 后"): Promise<void> {
    this.state = this.state === "stopping" ? "stopping" : "failed";
    const client = this.client;
    this.client = null;
    if (!client) return;
    await this.closeDetachedClient(client, label);
  }

  private async closeDetachedClient(
    client: CodexAppServerClient,
    label: string,
  ): Promise<void> {
    try {
      await client.close();
    } catch (error) {
      const cleanupError = new Error(`${label}无法确认 app-server 进程组收口`, {
        cause: error,
      });
      this.terminalCleanupError ??= cleanupError;
      this.store.quarantineSession(
        this.options.sessionKey,
        `${label}无法确认 app-server 进程组收口；必须人工核对并 release session`,
      );
      throw cleanupError;
    }
  }

  private onProcessExit(
    sourceClient: CodexAppServerClient,
    clientEpoch: number,
    exitCode: number | null,
    cause?: unknown,
  ): void {
    if (
      sourceClient !== this.client || clientEpoch !== this.clientEpoch ||
      this.state === "stopped" || this.state === "stopping" || this.state === "failed"
    ) {
      return;
    }
    const detail = cause ? errorMessage(cause) : `exit ${exitCode ?? "unknown"}`;
    if (this.state === "starting" || this.state === "recovering") {
      // 启动/恢复 RPC 会观察 transport 终止并负责候选重试或失败关闭。
      return;
    }
    if (this.state !== "running") return;
    if (this.startInProgress) {
      // 初次 start() 尚未完成 ready 交接，由 start 自身的 client.running 与
      // 请求错误路径裁决；这里不得并发启动 recovery。
      return;
    }
    if (this.recoveryPromise !== null) {
      void this.failClosed(
        `Codex app-server 在 recovery ready 交接期间退出（${detail}）`,
      ).catch((error) => {
        this.logger?.error("Codex recovery ready 交接失败", { error: errorMessage(error) });
      });
      return;
    }
    const eligibilityIssue = this.recoveryEligibilityIssue();
    if (eligibilityIssue) {
      this.store.quarantineSession(
        this.options.sessionKey,
        `Codex app-server 退出时不满足 idle recovery fence：${eligibilityIssue}`,
      );
      void this.failClosed(
        `Codex app-server 意外退出且禁止自动恢复（${detail}；${eligibilityIssue}）`,
      ).catch((error) => {
        this.logger?.error("Codex app-server 断连持久化失败", { error: errorMessage(error) });
      });
      return;
    }
    if (this.recoveryAttempts >= this.recoveryDelaysMs.length) {
      void this.failClosed(
        `Codex app-server 意外退出且 daemon 生命周期恢复预算已耗尽（${detail}）`,
      ).catch((error) => {
        this.logger?.error("Codex app-server 恢复预算耗尽后的收口失败", {
          error: errorMessage(error),
        });
      });
      return;
    }
    this.beginIdleRecovery(sourceClient, detail);
  }
}
