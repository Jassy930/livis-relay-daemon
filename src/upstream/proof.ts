import { join } from "node:path";
import type { ProtocolProfile } from "../protocol/profile.ts";
import { asSha256, atomicWritePrivate, parseJsonObject } from "../util.ts";
import type { UpstreamSnapshot } from "./checker.ts";

export const UPSTREAM_PROOF_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const UPSTREAM_CHECKER_VERSION = 1;

export interface SupportedUpstreamProof {
  schemaVersion: 1;
  checkerVersion: typeof UPSTREAM_CHECKER_VERSION;
  profileId: string;
  profileSha256: string;
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

export async function saveSupportedProof(options: {
  stateDir: string;
  profile: ProtocolProfile;
  profileSha256: string;
  snapshot: UpstreamSnapshot;
  now?: number;
}): Promise<{ proof: SupportedUpstreamProof; path: string }> {
  assertSnapshotMatchesProfile(options.snapshot, options.profile);
  const now = options.now ?? Date.now();
  const proof: SupportedUpstreamProof = {
    schemaVersion: 1,
    checkerVersion: UPSTREAM_CHECKER_VERSION,
    profileId: options.profile.id,
    profileSha256: asSha256(options.profileSha256, "profileSha256"),
    checkedAt: options.snapshot.checkedAt,
    expiresAt: new Date(now + UPSTREAM_PROOF_MAX_AGE_MS).toISOString(),
    snapshot: options.snapshot,
  };
  const path = supportedProofPath(options.stateDir, proof.profileSha256);
  const text = `${JSON.stringify(proof, null, 2)}\n`;
  await atomicWritePrivate(path, text);
  await atomicWritePrivate(supportedProofPath(options.stateDir), text);
  return { proof, path };
}

export async function requireFreshSupportedProof(options: {
  stateDir: string;
  profile: ProtocolProfile;
  profileSha256: string;
  now?: number;
}): Promise<SupportedUpstreamProof> {
  const path = supportedProofPath(options.stateDir, options.profileSha256);
  const root = parseJsonObject(await Bun.file(path).text(), path);
  if (
    root.schemaVersion !== 1 ||
    root.checkerVersion !== UPSTREAM_CHECKER_VERSION ||
    root.profileId !== options.profile.id ||
    root.profileSha256 !== options.profileSha256 ||
    typeof root.checkedAt !== "string" ||
    typeof root.expiresAt !== "string" ||
    root.snapshot === null ||
    typeof root.snapshot !== "object" ||
    Array.isArray(root.snapshot)
  ) {
    throw new Error("upstream supported proof 格式无效或未绑定当前 active profile");
  }
  const expiresAt = Date.parse(root.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt < (options.now ?? Date.now())) {
    throw new Error("upstream supported proof 已过期；必须重新执行 upstream check");
  }
  const proof = root as unknown as SupportedUpstreamProof;
  assertSnapshotMatchesProfile(proof.snapshot, options.profile);
  return proof;
}
