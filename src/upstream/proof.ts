import { join } from "node:path";
import { runtimeContractSha256, type ProtocolProfile } from "../protocol/profile.ts";
import type { CredentialMode, WireContractRevision } from "../protocol/contract.ts";
import type { ProfileOperationGuard } from "../state/offline-guard.ts";
import {
  asSha256,
  durableAtomicWritePrivate,
  durableMkdirPrivate,
  durableUnlink,
  parseJsonObject,
  readOptionalPrivateFileText,
} from "../util.ts";
import type { UpstreamSnapshot } from "./checker.ts";

export const UPSTREAM_PROOF_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const UPSTREAM_CHECKER_VERSION = 2;

export interface SupportedUpstreamProof {
  schemaVersion: 2;
  checkerVersion: typeof UPSTREAM_CHECKER_VERSION;
  profileId: string;
  profileSha256: string;
  runtimeContractSha256: string;
  wireContractRevision: WireContractRevision;
  credentialMode: CredentialMode;
  checkedAt: string;
  expiresAt: string;
  snapshot: UpstreamSnapshot;
}

export function supportedProofPath(stateDir: string, profileSha256?: string): string {
  return profileSha256
    ? join(stateDir, "upstream", "proofs", `${profileSha256}.json`)
    : join(stateDir, "upstream", "last-supported.json");
}

function assertSnapshotMatchesProfile(snapshot: UpstreamSnapshot, profile: ProtocolProfile): void {
  if (
    snapshot.compatibility !== "supported" ||
    snapshot.activeProfileId !== profile.id ||
    snapshot.matchedProfileId !== profile.id ||
    snapshot.detectedVersion !== profile.officialPluginVersion ||
    snapshot.setup.url !== profile.upstream.setupUrl ||
    snapshot.setup.sha256 !== profile.upstream.setupSha256 ||
    snapshot.installPlugin.url !== profile.upstream.installPluginUrl ||
    snapshot.installPlugin.sha256 !== profile.upstream.installPluginSha256 ||
    snapshot.package.url !== profile.upstream.packageUrl ||
    snapshot.package.sha256 !== profile.upstream.packageSha256 ||
    !profile.upstream.requiredBundleMarkers.every((marker) => snapshot.bundleMarkers[marker] === true)
  ) {
    throw new Error("upstream supported proof 与 active profile 不一致");
  }
}

interface ProofFileSnapshot {
  path: string;
  text: string | null;
}

async function readOptionalText(path: string): Promise<string | null> {
  return readOptionalPrivateFileText(path, "upstream supported proof");
}

async function ensureSupportedProofDirectories(options: {
  stateDir: string;
  guard: ProfileOperationGuard;
  syncDirectory?: (path: string) => Promise<void>;
}): Promise<void> {
  for (const path of [
    join(options.stateDir, "upstream"),
    join(options.stateDir, "upstream", "proofs"),
  ]) {
    await options.guard.assertHeldForStateDir(options.stateDir);
    await durableMkdirPrivate(path, { syncDirectory: options.syncDirectory });
    await options.guard.assertHeldForStateDir(options.stateDir);
  }
}

async function writeProofFile(options: {
  path: string;
  text: string;
  stateDir: string;
  guard: ProfileOperationGuard;
}): Promise<void> {
  await options.guard.assertHeldForStateDir(options.stateDir);
  await durableAtomicWritePrivate(options.path, options.text);
  await options.guard.assertHeldForStateDir(options.stateDir);
  if (await readOptionalText(options.path) !== options.text) {
    throw new Error(`upstream supported proof 写后读回不一致：${options.path}`);
  }
}

async function restoreProofFile(options: {
  snapshot: ProofFileSnapshot;
  writtenText: string;
  stateDir: string;
  guard: ProfileOperationGuard;
}): Promise<void> {
  const current = await readOptionalText(options.snapshot.path);
  if (current === options.snapshot.text) return;
  if (current !== options.writtenText) {
    throw new Error(`supported proof 补偿期间检测到并发修改，拒绝覆盖：${options.snapshot.path}`);
  }
  await options.guard.assertHeldForStateDir(options.stateDir);
  if (options.snapshot.text === null) {
    await durableUnlink(options.snapshot.path);
  } else {
    await durableAtomicWritePrivate(options.snapshot.path, options.snapshot.text);
  }
  await options.guard.assertHeldForStateDir(options.stateDir);
  if (await readOptionalText(options.snapshot.path) !== options.snapshot.text) {
    throw new Error(`supported proof 补偿读回不一致：${options.snapshot.path}`);
  }
}

export async function saveSupportedProof(options: {
  stateDir: string;
  profile: ProtocolProfile;
  profileSha256: string;
  snapshot: UpstreamSnapshot;
  now?: number;
  /** 仅供故障注入测试；生产调用不传。 */
  testHooks?: {
    afterAliasWrite?: () => void | Promise<void>;
    syncManagedDirectory?: (path: string) => Promise<void>;
  };
}, guard: ProfileOperationGuard): Promise<{ proof: SupportedUpstreamProof; path: string }> {
  assertSnapshotMatchesProfile(options.snapshot, options.profile);
  await guard.assertHeldForStateDir(options.stateDir);
  await ensureSupportedProofDirectories({
    stateDir: options.stateDir,
    guard,
    syncDirectory: options.testHooks?.syncManagedDirectory,
  });
  const now = options.now ?? Date.now();
  const proof: SupportedUpstreamProof = {
    schemaVersion: 2,
    checkerVersion: UPSTREAM_CHECKER_VERSION,
    profileId: options.profile.id,
    profileSha256: asSha256(options.profileSha256, "profileSha256"),
    runtimeContractSha256: runtimeContractSha256(options.profile),
    wireContractRevision: options.profile.wireContractRevision,
    credentialMode: options.profile.credentialMode,
    checkedAt: options.snapshot.checkedAt,
    expiresAt: new Date(now + UPSTREAM_PROOF_MAX_AGE_MS).toISOString(),
    snapshot: options.snapshot,
  };
  const path = supportedProofPath(options.stateDir, proof.profileSha256);
  const aliasPath = supportedProofPath(options.stateDir);
  const text = `${JSON.stringify(proof, null, 2)}\n`;
  const snapshots: ProofFileSnapshot[] = [
    { path, text: await readOptionalText(path) },
    { path: aliasPath, text: await readOptionalText(aliasPath) },
  ];
  const attempted: ProofFileSnapshot[] = [];
  try {
    attempted.push(snapshots[0]!);
    await writeProofFile({ path, text, stateDir: options.stateDir, guard });
    attempted.push(snapshots[1]!);
    await writeProofFile({ path: aliasPath, text, stateDir: options.stateDir, guard });
    await options.testHooks?.afterAliasWrite?.();
    await guard.assertHeldForStateDir(options.stateDir);
    return { proof, path };
  } catch (writeError) {
    const rollbackFailures: unknown[] = [];
    for (const snapshot of [...attempted].reverse()) {
      try {
        await restoreProofFile({ snapshot, writtenText: text, stateDir: options.stateDir, guard });
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [writeError, ...rollbackFailures],
        "upstream supported proof 写入失败，且精确补偿未全部完成",
      );
    }
    throw writeError;
  }
}

export async function requireFreshSupportedProof(options: {
  stateDir: string;
  profile: ProtocolProfile;
  profileSha256: string;
  now?: number;
}): Promise<SupportedUpstreamProof> {
  const path = supportedProofPath(options.stateDir, options.profileSha256);
  const root = parseJsonObject(await Bun.file(path).text(), path);
  const expectedRuntimeContractSha256 = runtimeContractSha256(options.profile);
  if (
    root.schemaVersion !== 2 ||
    root.checkerVersion !== UPSTREAM_CHECKER_VERSION ||
    root.profileId !== options.profile.id ||
    root.profileSha256 !== options.profileSha256 ||
    root.runtimeContractSha256 !== expectedRuntimeContractSha256 ||
    root.wireContractRevision !== options.profile.wireContractRevision ||
    root.credentialMode !== options.profile.credentialMode ||
    typeof root.checkedAt !== "string" ||
    typeof root.expiresAt !== "string" ||
    root.snapshot === null ||
    typeof root.snapshot !== "object" ||
    Array.isArray(root.snapshot)
  ) {
    throw new Error("upstream supported proof 格式无效或未绑定当前 active profile / wire contract");
  }
  const expiresAt = Date.parse(root.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= (options.now ?? Date.now())) {
    throw new Error("upstream supported proof 已过期；必须重新执行 upstream check");
  }
  const proof = root as unknown as SupportedUpstreamProof;
  assertSnapshotMatchesProfile(proof.snapshot, options.profile);
  return proof;
}
