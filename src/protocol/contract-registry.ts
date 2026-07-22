import { asNonEmptyString, asPositiveInteger, asSha256 } from "../util.ts";

export const WIRE_CONTRACT_REGISTRY_PATH = "src/protocol/wire-contract-registry.json" as const;
export const SUPPORTED_CREDENTIAL_MODES = [
  "access-and-refresh-token",
  "access-token-only",
] as const;

export type WireContractRevision = string;
export type CredentialMode = typeof SUPPORTED_CREDENTIAL_MODES[number];

export interface WireContractDefinition {
  revision: WireContractRevision;
  credentialMode: CredentialMode;
  wireProtocolVersion: number;
  localProbeArtifactPath: string;
  localProbeArtifactSha256: string;
}

export interface WireContractRegistryDocument {
  schemaVersion: 1;
  currentRevision: WireContractRevision;
  contracts: readonly WireContractDefinition[];
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} 字段必须精确为：${wanted.join(", ")}`);
  }
}

function revisionValue(value: unknown, label: string): WireContractRevision {
  const revision = asNonEmptyString(value, label);
  if (!/^[a-z0-9][a-z0-9.-]{0,126}[a-z0-9]$/.test(revision)) {
    throw new Error(`${label} 只能包含小写字母、数字、点和连字符，且不能以标点开头或结尾`);
  }
  return revision;
}

function credentialModeValue(value: unknown, label: string): CredentialMode {
  if (!SUPPORTED_CREDENTIAL_MODES.includes(value as CredentialMode)) {
    throw new Error(`${label} 不受支持：${String(value)}`);
  }
  return value as CredentialMode;
}

export function parseWireContractRegistryDocument(
  value: unknown,
  label = "wire contract registry",
): WireContractRegistryDocument {
  const root = objectValue(value, label);
  exactKeys(root, ["schemaVersion", "currentRevision", "contracts"], label);
  if (root.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion 必须为 1`);
  }
  if (!Array.isArray(root.contracts) || root.contracts.length === 0) {
    throw new Error(`${label}.contracts 必须是非空数组`);
  }

  const revisions = new Set<string>();
  const artifactPaths = new Set<string>();
  const artifactShas = new Set<string>();
  const contracts = root.contracts.map((raw, index): WireContractDefinition => {
    const itemLabel = `${label}.contracts[${index}]`;
    const item = objectValue(raw, itemLabel);
    exactKeys(item, [
      "revision",
      "credentialMode",
      "wireProtocolVersion",
      "localProbeArtifactPath",
      "localProbeArtifactSha256",
    ], itemLabel);
    const revision = revisionValue(item.revision, `${itemLabel}.revision`);
    if (revisions.has(revision)) {
      throw new Error(`${label} 包含重复 revision：${revision}`);
    }
    revisions.add(revision);
    const expectedPath = `protocol-probes/local/${revision}.json`;
    const artifactPath = asNonEmptyString(item.localProbeArtifactPath, `${itemLabel}.localProbeArtifactPath`);
    if (artifactPath !== expectedPath) {
      throw new Error(`${itemLabel}.localProbeArtifactPath 必须精确为 ${expectedPath}`);
    }
    if (artifactPaths.has(artifactPath)) {
      throw new Error(`${label} 包含重复 artifact path：${artifactPath}`);
    }
    artifactPaths.add(artifactPath);
    const artifactSha256 = asSha256(
      item.localProbeArtifactSha256,
      `${itemLabel}.localProbeArtifactSha256`,
    );
    if (artifactShas.has(artifactSha256)) {
      throw new Error(`${label} 包含重复 artifact SHA-256：${artifactSha256}`);
    }
    artifactShas.add(artifactSha256);
    return Object.freeze({
      revision,
      credentialMode: credentialModeValue(item.credentialMode, `${itemLabel}.credentialMode`),
      wireProtocolVersion: asPositiveInteger(item.wireProtocolVersion, `${itemLabel}.wireProtocolVersion`),
      localProbeArtifactPath: artifactPath,
      localProbeArtifactSha256: artifactSha256,
    });
  });
  const currentRevision = revisionValue(root.currentRevision, `${label}.currentRevision`);
  if (!revisions.has(currentRevision)) {
    throw new Error(`${label}.currentRevision 未登记：${currentRevision}`);
  }
  return Object.freeze({
    schemaVersion: 1,
    currentRevision,
    contracts: Object.freeze(contracts),
  });
}

export function requireCurrentWireContract(
  document: WireContractRegistryDocument,
  input: {
    revision: unknown;
    credentialMode: unknown;
    wireProtocolVersion: number;
  },
): WireContractDefinition {
  if (typeof input.revision !== "string") {
    throw new Error(`不支持的 profile.wireContractRevision：${String(input.revision)}`);
  }
  const definition = document.contracts.find((item) => item.revision === input.revision);
  if (!definition) {
    throw new Error(`不支持的 profile.wireContractRevision：${input.revision}`);
  }
  if (input.revision !== document.currentRevision) {
    throw new Error(
      `profile.wireContractRevision=${input.revision} 仅作为历史账本保留；当前 runtime 只支持 ${document.currentRevision}`,
    );
  }
  if (input.credentialMode !== definition.credentialMode) {
    throw new Error(
      `profile.credentialMode 与 ${definition.revision} 不匹配：期望 ${definition.credentialMode}，收到 ${String(input.credentialMode)}`,
    );
  }
  if (input.wireProtocolVersion !== definition.wireProtocolVersion) {
    throw new Error(
      `profile.wireProtocolVersion 与 ${definition.revision} 不匹配：期望 ${definition.wireProtocolVersion}，收到 ${input.wireProtocolVersion}`,
    );
  }
  return definition;
}
