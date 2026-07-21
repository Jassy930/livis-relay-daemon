import { dirname, isAbsolute, resolve } from "node:path";
import { asNonEmptyString, asPositiveInteger, asSha256, parseJsonObject, sha256 } from "../util.ts";
import {
  requireSupportedWireContract,
  type CredentialMode,
  type WireContractRevision,
} from "./contract.ts";

export interface ProtocolProfile {
  schemaVersion: 2;
  id: string;
  officialPluginVersion: string;
  wireProtocolVersion: number;
  wireContractRevision: WireContractRevision;
  credentialMode: CredentialMode;
  endpoints: {
    idaasBaseUrl: string;
    relayWebSocketUrl: string;
    relayHttpUrl: string;
  };
  oauth: {
    clientId: string;
    audience: string;
    scope: string;
    logoutRedirectUri: string;
  };
  wireIdentity: {
    client: string;
    agentIdPrefix: string;
    deviceIdPrefix: string;
    nodeType: string;
  };
  timing: {
    heartbeatIntervalMs: number;
    pongTimeoutMs: number;
    resultAckTimeoutMs: number;
    resultMaxRetries: number;
    tokenRefreshAckTimeoutMs: number;
    tokenRefreshMaxFailures: number;
  };
  upstream: {
    setupUrl: string;
    setupSha256: string;
    installPluginUrl: string;
    installPluginSha256: string;
    packageUrl: string;
    packageSha256: string;
    requiredBundleMarkers: string[];
  };
}

export function runtimeContractSha256(profile: ProtocolProfile): string {
  const wireContract = requireSupportedWireContract({
    revision: profile.wireContractRevision,
    credentialMode: profile.credentialMode,
    wireProtocolVersion: profile.wireProtocolVersion,
  });
  return sha256(JSON.stringify({
    wireProtocolVersion: profile.wireProtocolVersion,
    wireContractRevision: profile.wireContractRevision,
    credentialMode: profile.credentialMode,
    localProbeArtifactPath: wireContract.localProbeArtifactPath,
    localProbeArtifactSha256: wireContract.localProbeArtifactSha256,
    endpoints: profile.endpoints,
    oauth: profile.oauth,
    wireIdentity: profile.wireIdentity,
    timing: profile.timing,
  }));
}

function objectAt(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`profile.${key} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function httpsUrl(value: unknown, label: string, allowWebSocket = false): string {
  const parsed = new URL(asNonEmptyString(value, label));
  const allowed = allowWebSocket ? ["https:", "wss:"] : ["https:"];
  if (!allowed.includes(parsed.protocol)) {
    throw new Error(`${label} 必须使用 ${allowWebSocket ? "https/wss" : "https"}`);
  }
  return parsed.toString().replace(/\/$/, "");
}

export function parseProtocolProfile(text: string, label = "protocol profile"): ProtocolProfile {
  const root = parseJsonObject(text, label);
  if (root.schemaVersion !== 2) {
    throw new Error("只支持 schemaVersion=2 的 protocol profile；旧 profile 必须显式迁移 wire contract 后重新锁定 SHA-256");
  }
  const endpoints = objectAt(root, "endpoints");
  const oauth = objectAt(root, "oauth");
  const wireIdentity = objectAt(root, "wireIdentity");
  const timing = objectAt(root, "timing");
  const upstream = objectAt(root, "upstream");
  if (!Array.isArray(upstream.requiredBundleMarkers) || upstream.requiredBundleMarkers.some((item) => typeof item !== "string")) {
    throw new Error("profile.upstream.requiredBundleMarkers 必须是字符串数组");
  }
  const wireProtocolVersion = asPositiveInteger(root.wireProtocolVersion, "profile.wireProtocolVersion");
  if (wireProtocolVersion !== 1) {
    throw new Error(`当前 daemon 只支持 LiViS wireProtocolVersion=1，收到 ${wireProtocolVersion}`);
  }
  const wireContract = requireSupportedWireContract({
    revision: root.wireContractRevision,
    credentialMode: root.credentialMode,
    wireProtocolVersion,
  });
  if (
    upstream.requiredBundleMarkers.length === 0 ||
    upstream.requiredBundleMarkers.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    throw new Error("profile.upstream.requiredBundleMarkers 必须包含非空字符串");
  }
  return {
    schemaVersion: 2,
    id: asNonEmptyString(root.id, "profile.id"),
    officialPluginVersion: asNonEmptyString(root.officialPluginVersion, "profile.officialPluginVersion"),
    wireProtocolVersion,
    wireContractRevision: wireContract.revision,
    credentialMode: wireContract.credentialMode,
    endpoints: {
      idaasBaseUrl: httpsUrl(endpoints.idaasBaseUrl, "profile.endpoints.idaasBaseUrl"),
      relayWebSocketUrl: httpsUrl(endpoints.relayWebSocketUrl, "profile.endpoints.relayWebSocketUrl", true),
      relayHttpUrl: httpsUrl(endpoints.relayHttpUrl, "profile.endpoints.relayHttpUrl"),
    },
    oauth: {
      clientId: asNonEmptyString(oauth.clientId, "profile.oauth.clientId"),
      audience: asNonEmptyString(oauth.audience, "profile.oauth.audience"),
      scope: asNonEmptyString(oauth.scope, "profile.oauth.scope"),
      logoutRedirectUri: httpsUrl(oauth.logoutRedirectUri, "profile.oauth.logoutRedirectUri"),
    },
    wireIdentity: {
      client: asNonEmptyString(wireIdentity.client, "profile.wireIdentity.client"),
      agentIdPrefix: asNonEmptyString(wireIdentity.agentIdPrefix, "profile.wireIdentity.agentIdPrefix"),
      deviceIdPrefix: asNonEmptyString(wireIdentity.deviceIdPrefix, "profile.wireIdentity.deviceIdPrefix"),
      nodeType: asNonEmptyString(wireIdentity.nodeType, "profile.wireIdentity.nodeType"),
    },
    timing: {
      heartbeatIntervalMs: asPositiveInteger(timing.heartbeatIntervalMs, "profile.timing.heartbeatIntervalMs"),
      pongTimeoutMs: asPositiveInteger(timing.pongTimeoutMs, "profile.timing.pongTimeoutMs"),
      resultAckTimeoutMs: asPositiveInteger(timing.resultAckTimeoutMs, "profile.timing.resultAckTimeoutMs"),
      resultMaxRetries: asPositiveInteger(timing.resultMaxRetries, "profile.timing.resultMaxRetries"),
      tokenRefreshAckTimeoutMs: asPositiveInteger(
        timing.tokenRefreshAckTimeoutMs,
        "profile.timing.tokenRefreshAckTimeoutMs",
      ),
      tokenRefreshMaxFailures: asPositiveInteger(
        timing.tokenRefreshMaxFailures,
        "profile.timing.tokenRefreshMaxFailures",
      ),
    },
    upstream: {
      setupUrl: httpsUrl(upstream.setupUrl, "profile.upstream.setupUrl"),
      setupSha256: asSha256(upstream.setupSha256, "profile.upstream.setupSha256"),
      installPluginUrl: httpsUrl(upstream.installPluginUrl, "profile.upstream.installPluginUrl"),
      installPluginSha256: asSha256(
        upstream.installPluginSha256,
        "profile.upstream.installPluginSha256",
      ),
      packageUrl: httpsUrl(upstream.packageUrl, "profile.upstream.packageUrl"),
      packageSha256: asSha256(upstream.packageSha256, "profile.upstream.packageSha256"),
      requiredBundleMarkers: [...upstream.requiredBundleMarkers] as string[],
    },
  };
}

export async function loadProtocolProfile(
  profilePath: string,
  configPath: string,
  expectedSha256?: string,
): Promise<ProtocolProfile> {
  const resolvedPath = isAbsolute(profilePath) ? profilePath : resolve(dirname(configPath), profilePath);
  const text = await Bun.file(resolvedPath).text();
  if (expectedSha256 && sha256(text) !== expectedSha256) {
    throw new Error(`active protocol profile SHA-256 与配置锁定值不一致：${resolvedPath}`);
  }
  return parseProtocolProfile(text, resolvedPath);
}

export function resolveProfilePath(profilePath: string, configPath: string): string {
  return isAbsolute(profilePath) ? profilePath : resolve(dirname(configPath), profilePath);
}
