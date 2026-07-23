import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  asNonEmptyString,
  asPositiveInteger,
  asSha256,
  atomicWritePrivate,
  expandHome,
  parseJsonObject,
  parseSemverTriplet,
  sha256,
  versionLessThan,
} from "./util.ts";
import type {
  CodexProviderConfig,
  ExecutionBackendKind,
  LegacyV4JobBackendKind,
} from "./types.ts";

export interface RelayConfig {
  schemaVersion: 1;
  profile: string;
  profileSha256: string;
  stateDir: string;
  relay: {
    nodeName: string;
    handshakeTimeoutMs: number;
    reconnectMaxMs: number;
    maxFrameBytes: number;
  };
  execution: {
    backend: ExecutionBackendKind;
    /**
     * 仅用于含待派发 job 的 SQLite v4→v5 一次性迁移。必须填写这些旧 job
     * 实际入库时使用的后端，不能用切换后的目标后端猜测。
     */
    legacyV4JobBackend?: LegacyV4JobBackendKind | null;
  };
  connector: {
    socketPath: string;
    helloTimeoutMs: number;
    resultStoreTimeoutMs: number;
    maxFrameBytes: number;
  };
  security: {
    acknowledgeUnofficialProtocol: boolean;
    allowAllNodes: boolean;
    allowedNodeIds: string[];
    maxInputChars: number;
    maxOutputChars: number;
    unauthorizedMessage: string;
  };
  hermes: {
    command: string;
    minimumVersion: string;
    maximumExclusiveVersion: string;
    bridgeImplementation: string;
    bridgeMinimumVersion: string;
    bridgeMaximumExclusiveVersion: string;
  };
  codex: {
    command: string;
    /**
     * 显式暴露给远程工具沙箱的只读工具链目录。它们会加入 PATH，但绝不会
     * 成为 writable root；空数组保持现有最小系统工具边界。
     */
    toolchainReadRoots: string[];
    model: string | null;
    provider: CodexProviderConfig;
    requestTimeoutMs: number;
    turnTimeoutMs: number;
    interruptGraceMs: number;
    shutdownTimeoutMs: number;
    acknowledgeRemoteExecution: boolean;
  };
}

export const DEFAULT_CONFIG_PATH = "~/.livis-relay/config.json";
export const DEFAULT_RELAY_MAX_FRAME_BYTES = 1_048_576;
export const MAX_RELAY_MAX_FRAME_BYTES = 16_777_216;
export const CODEX_MINIMUM_VERSION = "0.145.0";
export const CODEX_MAXIMUM_EXCLUSIVE_VERSION = "0.146.0";
export const DEFAULT_CODEX_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_CODEX_TURN_TIMEOUT_MS = 15 * 60 * 1_000;
export const DEFAULT_CODEX_INTERRUPT_GRACE_MS = 5_000;
export const DEFAULT_CODEX_SHUTDOWN_TIMEOUT_MS = 5_000;

function relayMaxFrameBytes(value: unknown): number {
  const parsed = asPositiveInteger(value, "config.relay.maxFrameBytes");
  if (parsed > MAX_RELAY_MAX_FRAME_BYTES) {
    throw new Error(`config.relay.maxFrameBytes 不能超过 ${MAX_RELAY_MAX_FRAME_BYTES}`);
  }
  return parsed;
}

function objectAt(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`config.${key} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function optionalObjectAt(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  if (parent[key] === undefined) return undefined;
  return objectAt(parent, key);
}

function optionalNonEmptyString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return asNonEmptyString(value, label);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`${label} 必须是非空字符串数组`);
  }
  return [...value] as string[];
}

function parseCodexProvider(codex: Record<string, unknown> | undefined): CodexProviderConfig {
  const value = codex?.provider;
  if (value === undefined) return { type: "openai" };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("config.codex.provider 必须是对象");
  }
  const provider = value as Record<string, unknown>;
  const type = asNonEmptyString(provider.type, "config.codex.provider.type");
  if (type === "openai") {
    const unexpected = Object.keys(provider).filter((key) => key !== "type");
    if (unexpected.length > 0) {
      throw new Error(`config.codex.provider(openai) 包含未审核字段：${unexpected.sort().join(",")}`);
    }
    return { type: "openai" };
  }
  if (type !== "custom") {
    throw new Error("config.codex.provider.type 只支持 openai 或 custom");
  }
  const unexpected = Object.keys(provider).filter((key) =>
    !["type", "baseUrl", "acknowledgeApiKeyTransmission"].includes(key)
  );
  if (unexpected.length > 0) {
    throw new Error(`config.codex.provider(custom) 包含未审核字段：${unexpected.sort().join(",")}`);
  }
  if (provider.acknowledgeApiKeyTransmission !== true) {
    throw new Error(
      "自定义 Codex provider 必须设置 acknowledgeApiKeyTransmission=true，明确确认 API key 将发送到该端点",
    );
  }
  const rawBaseUrl = asNonEmptyString(provider.baseUrl, "config.codex.provider.baseUrl");
  if (rawBaseUrl !== rawBaseUrl.trim() || rawBaseUrl.length > 2048) {
    throw new Error("config.codex.provider.baseUrl 必须是长度不超过 2048 的无首尾空白 HTTPS URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new Error("config.codex.provider.baseUrl 必须是有效 HTTPS URL");
  }
  if (
    parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" ||
    parsed.search !== "" || parsed.hash !== ""
  ) {
    throw new Error(
      "config.codex.provider.baseUrl 必须是无用户名、密码、query 与 fragment 的 HTTPS URL",
    );
  }
  return {
    type: "custom",
    baseUrl: parsed.toString(),
    acknowledgeApiKeyTransmission: true,
  };
}

export function parseRelayConfig(text: string, configPath: string): RelayConfig {
  const root = parseJsonObject(text, configPath);
  if (root.schemaVersion !== 1) {
    throw new Error("只支持 schemaVersion=1 的配置");
  }
  const relay = objectAt(root, "relay");
  const execution = optionalObjectAt(root, "execution");
  const connector = objectAt(root, "connector");
  const security = objectAt(root, "security");
  const hermes = objectAt(root, "hermes");
  const codex = optionalObjectAt(root, "codex");
  const executionBackend = execution?.backend ?? "hermes";
  if (executionBackend !== "hermes" && executionBackend !== "codex" && executionBackend !== "claude") {
    throw new Error("config.execution.backend 只支持 hermes、codex 或 claude");
  }
  const legacyV4JobBackend = execution?.legacyV4JobBackend ?? null;
  if (
    legacyV4JobBackend !== null &&
    legacyV4JobBackend !== "hermes" &&
    legacyV4JobBackend !== "codex"
  ) {
    throw new Error("config.execution.legacyV4JobBackend 只支持 v4 已实现的 hermes 或 codex");
  }
  if (codex?.acknowledgeRemoteExecution !== undefined &&
      typeof codex.acknowledgeRemoteExecution !== "boolean") {
    throw new Error("config.codex.acknowledgeRemoteExecution 必须是布尔值");
  }
  if (typeof security.acknowledgeUnofficialProtocol !== "boolean") {
    throw new Error("config.security.acknowledgeUnofficialProtocol 必须是布尔值");
  }
  if (typeof security.allowAllNodes !== "boolean") {
    throw new Error("config.security.allowAllNodes 必须是布尔值");
  }
  const allowAllNodes = security.allowAllNodes;
  const allowedNodeIds = stringArray(security.allowedNodeIds, "config.security.allowedNodeIds");
  const codexCommand = codex?.command === undefined
    ? "codex"
    : asNonEmptyString(codex.command, "config.codex.command");
  const codexToolchainReadRootsRaw = stringArray(
    codex?.toolchainReadRoots ?? [],
    "config.codex.toolchainReadRoots",
  );
  const codexToolchainReadRoots = codexToolchainReadRootsRaw.map((path) => expandHome(path));
  const codexModel = optionalNonEmptyString(codex?.model, "config.codex.model");
  const codexProvider = parseCodexProvider(codex);
  if (executionBackend === "codex" && (allowAllNodes || allowedNodeIds.length !== 1)) {
    throw new Error(
      "Codex backend 只支持单设备：config.security.allowAllNodes 必须为 false，且 allowedNodeIds 必须恰好包含一个 nodeId",
    );
  }
  if (executionBackend === "codex" && !isAbsolute(codexCommand)) {
    throw new Error("Codex backend 的 config.codex.command 必须是绝对路径");
  }
  if (
    executionBackend === "codex" &&
    codexToolchainReadRoots.some((path, index) =>
      (!isAbsolute(codexToolchainReadRootsRaw[index]!) &&
        !codexToolchainReadRootsRaw[index]!.startsWith("~/")) ||
      resolve(path) === dirname(resolve(path))
    )
  ) {
    throw new Error("Codex backend 的 config.codex.toolchainReadRoots 必须是绝对非根目录路径");
  }
  if (executionBackend === "codex" && codexProvider.type === "custom" && codexModel === null) {
    throw new Error("Codex custom provider 必须显式设置 config.codex.model");
  }
  const stateDirRaw = asNonEmptyString(root.stateDir, "config.stateDir");
  const hermesMinimumVersion = asNonEmptyString(hermes.minimumVersion, "config.hermes.minimumVersion");
  const hermesMaximumVersion = asNonEmptyString(
    hermes.maximumExclusiveVersion,
    "config.hermes.maximumExclusiveVersion",
  );
  const bridgeMinimumVersion = asNonEmptyString(
    hermes.bridgeMinimumVersion,
    "config.hermes.bridgeMinimumVersion",
  );
  const bridgeMaximumVersion = asNonEmptyString(
    hermes.bridgeMaximumExclusiveVersion,
    "config.hermes.bridgeMaximumExclusiveVersion",
  );
  const hermesMinimum = parseSemverTriplet(hermesMinimumVersion);
  const hermesMaximum = parseSemverTriplet(hermesMaximumVersion);
  const bridgeMinimum = parseSemverTriplet(bridgeMinimumVersion);
  const bridgeMaximum = parseSemverTriplet(bridgeMaximumVersion);
  if (!hermesMinimum || !hermesMaximum || !versionLessThan(hermesMinimum, hermesMaximum)) {
    throw new Error("config.hermes runtime 版本范围必须是有效的 [minimum, maximumExclusive)");
  }
  if (!bridgeMinimum || !bridgeMaximum || !versionLessThan(bridgeMinimum, bridgeMaximum)) {
    throw new Error("config.hermes bridge 版本范围必须是有效的 [minimum, maximumExclusive)");
  }
  return {
    schemaVersion: 1,
    profile: asNonEmptyString(root.profile, "config.profile"),
    profileSha256: asSha256(root.profileSha256, "config.profileSha256"),
    stateDir: expandHome(stateDirRaw),
    relay: {
      nodeName: asNonEmptyString(relay.nodeName, "config.relay.nodeName"),
      handshakeTimeoutMs: asPositiveInteger(relay.handshakeTimeoutMs, "config.relay.handshakeTimeoutMs"),
      reconnectMaxMs: asPositiveInteger(relay.reconnectMaxMs, "config.relay.reconnectMaxMs"),
      maxFrameBytes: relay.maxFrameBytes === undefined
        ? DEFAULT_RELAY_MAX_FRAME_BYTES
        : relayMaxFrameBytes(relay.maxFrameBytes),
    },
    execution: {
      backend: executionBackend,
      legacyV4JobBackend,
    },
    connector: {
      socketPath: expandHome(asNonEmptyString(connector.socketPath, "config.connector.socketPath")),
      helloTimeoutMs: asPositiveInteger(connector.helloTimeoutMs, "config.connector.helloTimeoutMs"),
      resultStoreTimeoutMs: asPositiveInteger(
        connector.resultStoreTimeoutMs,
        "config.connector.resultStoreTimeoutMs",
      ),
      maxFrameBytes: asPositiveInteger(connector.maxFrameBytes, "config.connector.maxFrameBytes"),
    },
    security: {
      acknowledgeUnofficialProtocol: security.acknowledgeUnofficialProtocol,
      allowAllNodes,
      allowedNodeIds,
      maxInputChars: asPositiveInteger(security.maxInputChars, "config.security.maxInputChars"),
      maxOutputChars: asPositiveInteger(security.maxOutputChars, "config.security.maxOutputChars"),
      unauthorizedMessage: asNonEmptyString(
        security.unauthorizedMessage,
        "config.security.unauthorizedMessage",
      ),
    },
    hermes: {
      command: asNonEmptyString(hermes.command, "config.hermes.command"),
      minimumVersion: hermesMinimumVersion,
      maximumExclusiveVersion: hermesMaximumVersion,
      bridgeImplementation: asNonEmptyString(
        hermes.bridgeImplementation,
        "config.hermes.bridgeImplementation",
      ),
      bridgeMinimumVersion,
      bridgeMaximumExclusiveVersion: bridgeMaximumVersion,
    },
    codex: {
      command: codexCommand,
      toolchainReadRoots: codexToolchainReadRoots,
      model: codexModel,
      provider: codexProvider,
      requestTimeoutMs: codex?.requestTimeoutMs === undefined
        ? DEFAULT_CODEX_REQUEST_TIMEOUT_MS
        : asPositiveInteger(codex.requestTimeoutMs, "config.codex.requestTimeoutMs"),
      turnTimeoutMs: codex?.turnTimeoutMs === undefined
        ? DEFAULT_CODEX_TURN_TIMEOUT_MS
        : asPositiveInteger(codex.turnTimeoutMs, "config.codex.turnTimeoutMs"),
      interruptGraceMs: codex?.interruptGraceMs === undefined
        ? DEFAULT_CODEX_INTERRUPT_GRACE_MS
        : asPositiveInteger(codex.interruptGraceMs, "config.codex.interruptGraceMs"),
      shutdownTimeoutMs: codex?.shutdownTimeoutMs === undefined
        ? DEFAULT_CODEX_SHUTDOWN_TIMEOUT_MS
        : asPositiveInteger(codex.shutdownTimeoutMs, "config.codex.shutdownTimeoutMs"),
      acknowledgeRemoteExecution: codex?.acknowledgeRemoteExecution === true,
    },
  };
}

export async function loadRelayConfig(path = process.env.LIVIS_RELAY_CONFIG ?? DEFAULT_CONFIG_PATH): Promise<{
  path: string;
  text: string;
  config: RelayConfig;
}> {
  const resolvedPath = expandHome(path);
  const text = await Bun.file(resolvedPath).text();
  const config = parseRelayConfig(text, resolvedPath);
  if (process.env.LIVIS_RELAY_STATE_DIR) {
    config.stateDir = expandHome(process.env.LIVIS_RELAY_STATE_DIR);
  }
  return { path: resolvedPath, text, config };
}

export async function initializeConfig(options: {
  configPath?: string;
  profileSourcePath: string;
  acknowledgeUnofficialProtocol: boolean;
  forbiddenStateRoot?: string;
}): Promise<{ configPath: string; stateDir: string }> {
  const configPath = expandHome(options.configPath ?? DEFAULT_CONFIG_PATH);
  const stateDir = resolve(dirname(configPath));
  if (options.forbiddenStateRoot) {
    const relativeState = relative(resolve(options.forbiddenStateRoot), stateDir);
    if (relativeState === "" || (!relativeState.startsWith("..") && !isAbsolute(relativeState))) {
      throw new Error("配置和 stateDir 必须位于项目仓库之外，避免提交 live profile、token 或消息数据库");
    }
  }
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const profileSourcePath = resolve(options.profileSourcePath);
  const sourceText = await Bun.file(profileSourcePath).text();
  const profileText = sourceText.endsWith("\n") ? sourceText : `${sourceText}\n`;
  const installedProfile = join(stateDir, "protocol-profiles", basename(profileSourcePath));
  await atomicWritePrivate(installedProfile, profileText);
  const config: RelayConfig = {
    schemaVersion: 1,
    profile: installedProfile,
    profileSha256: sha256(profileText),
    stateDir,
    relay: {
      nodeName: "我的电脑",
      handshakeTimeoutMs: 15_000,
      reconnectMaxMs: 60_000,
      maxFrameBytes: DEFAULT_RELAY_MAX_FRAME_BYTES,
    },
    execution: {
      backend: "hermes",
      legacyV4JobBackend: null,
    },
    connector: {
      socketPath: resolve(stateDir, "connector.sock"),
      helloTimeoutMs: 10_000,
      resultStoreTimeoutMs: 5_000,
      maxFrameBytes: 1_048_576,
    },
    security: {
      acknowledgeUnofficialProtocol: options.acknowledgeUnofficialProtocol,
      allowAllNodes: false,
      allowedNodeIds: [],
      maxInputChars: 32_768,
      maxOutputChars: 1_048_576,
      unauthorizedMessage: "当前 LiViS 节点未获授权。",
    },
    hermes: {
      command: "hermes",
      minimumVersion: "0.15.1",
      maximumExclusiveVersion: "0.15.2",
      bridgeImplementation: "livis-hermes-bridge",
      bridgeMinimumVersion: "0.1.0",
      bridgeMaximumExclusiveVersion: "0.2.0",
    },
    codex: {
      command: "codex",
      toolchainReadRoots: [],
      model: null,
      provider: { type: "openai" },
      requestTimeoutMs: DEFAULT_CODEX_REQUEST_TIMEOUT_MS,
      turnTimeoutMs: DEFAULT_CODEX_TURN_TIMEOUT_MS,
      interruptGraceMs: DEFAULT_CODEX_INTERRUPT_GRACE_MS,
      shutdownTimeoutMs: DEFAULT_CODEX_SHUTDOWN_TIMEOUT_MS,
      acknowledgeRemoteExecution: false,
    },
  };
  await atomicWritePrivate(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { configPath, stateDir };
}
