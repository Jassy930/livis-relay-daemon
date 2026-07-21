import rawRegistry from "./wire-contract-registry.json";
import {
  parseWireContractRegistryDocument,
  requireCurrentWireContract,
  type CredentialMode,
  type WireContractDefinition,
  type WireContractRevision,
} from "./contract-registry.ts";

export type {
  CredentialMode,
  WireContractDefinition,
  WireContractRevision,
} from "./contract-registry.ts";

const registryDocument = parseWireContractRegistryDocument(rawRegistry);

export const CURRENT_WIRE_CONTRACT_REVISION = registryDocument.currentRevision;
export const WIRE_CONTRACT_REGISTRY: Readonly<Record<WireContractRevision, WireContractDefinition>> = Object.freeze(
  Object.fromEntries(registryDocument.contracts.map((definition) => [definition.revision, definition])),
);
export const CURRENT_CREDENTIAL_MODE = WIRE_CONTRACT_REGISTRY[CURRENT_WIRE_CONTRACT_REVISION]!.credentialMode;

export function requireSupportedWireContract(input: {
  revision: unknown;
  credentialMode: unknown;
  wireProtocolVersion: number;
}): WireContractDefinition {
  return requireCurrentWireContract(registryDocument, input);
}
