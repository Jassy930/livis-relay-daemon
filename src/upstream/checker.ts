import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProtocolProfile } from "../protocol/profile.ts";
import { sha256 } from "../util.ts";

export type UpstreamCompatibility =
  | "supported"
  | "reviewed-upgrade-available"
  | "drift"
  | "candidate-compatible"
  | "unknown-breaking";

export interface UpstreamSnapshot {
  checkedAt: string;
  activeProfileId: string;
  compatibility: UpstreamCompatibility;
  detectedVersion: string | null;
  setup: { url: string; sha256: string; sizeBytes?: number; artifactPath?: string | null };
  installPlugin: { url: string; sha256: string; sizeBytes?: number; artifactPath?: string | null };
  package: {
    url: string | null;
    sha256: string | null;
    sizeBytes?: number | null;
    artifactPath?: string | null;
  };
  bundleMarkers: Record<string, boolean>;
  matchedProfileId: string | null;
  reasons: string[];
}

function matchesSnapshot(
  profile: ProtocolProfile,
  detectedVersion: string | null,
  setupUrl: string,
  setupHash: string,
  installUrl: string,
  installHash: string,
  packageUrl: string | null,
  packageHash: string | null,
): boolean {
  return profile.officialPluginVersion === detectedVersion &&
    profile.upstream.setupUrl === setupUrl &&
    profile.upstream.setupSha256 === setupHash &&
    profile.upstream.installPluginUrl === installUrl &&
    profile.upstream.installPluginSha256 === installHash &&
    profile.upstream.packageUrl === packageUrl &&
    profile.upstream.packageSha256 === packageHash;
}

function candidateProfileId(activeProfile: ProtocolProfile, snapshot: UpstreamSnapshot): string {
  const versionSlug = (snapshot.detectedVersion ?? "unknown").replace(/[^0-9A-Za-z._-]+/g, "-");
  const base = `livis-community-v${versionSlug}`;
  if (snapshot.compatibility !== "drift" && snapshot.detectedVersion !== activeProfile.officialPluginVersion) return base;
  const revision = snapshot.checkedAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${base}-r${revision}`;
}

export function buildCandidateProfile(
  activeProfile: ProtocolProfile,
  snapshot: UpstreamSnapshot,
): ProtocolProfile | null {
  if (!["drift", "candidate-compatible"].includes(snapshot.compatibility)) return null;
  if (!snapshot.detectedVersion || !snapshot.package.url || !snapshot.package.sha256) return null;
  if (!activeProfile.upstream.requiredBundleMarkers.every((marker) => snapshot.bundleMarkers[marker] === true)) {
    return null;
  }
  return {
    ...activeProfile,
    id: candidateProfileId(activeProfile, snapshot),
    officialPluginVersion: snapshot.detectedVersion,
    upstream: {
      ...activeProfile.upstream,
      setupUrl: snapshot.setup.url,
      setupSha256: snapshot.setup.sha256,
      installPluginUrl: snapshot.installPlugin.url,
      installPluginSha256: snapshot.installPlugin.sha256,
      packageUrl: snapshot.package.url,
      packageSha256: snapshot.package.sha256,
    },
  };
}

export type UpstreamArtifactKind = "setup" | "install-plugin" | "package";

interface UpstreamCheckerOptions {
  fetch?: typeof fetch;
  bundleProbe?: (archive: Uint8Array, markers: string[]) => Promise<Record<string, boolean>>;
  artifactSink?: (kind: UpstreamArtifactKind, url: string, bytes: Uint8Array) => Promise<string | null>;
  fetchTimeoutMs?: number;
  maxScriptBytes?: number;
  maxPackageBytes?: number;
}

function extractAssignment(script: string, variable: string): string | null {
  const match = script.match(new RegExp(`^${variable}=["']([^"']+)["']`, "m"));
  return match?.[1] ?? null;
}

async function fetchBytes(
  fetchImplementation: typeof fetch,
  url: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<Uint8Array> {
  const response = await fetchImplementation(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`下载失败：${url} HTTP ${response.status}`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`下载超过大小上限：${url} ${declaredLength} > ${maxBytes}`);
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`下载超过大小上限：${url}`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("size limit exceeded");
        throw new Error(`下载超过大小上限：${url} > ${maxBytes}`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readProcessText(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  label: string,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("size limit exceeded");
        throw new Error(`${label} 超过大小上限 ${maxBytes}`);
      }
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } finally {
    reader.releaseLock();
  }
}

async function defaultBundleProbe(archive: Uint8Array, markers: string[]): Promise<Record<string, boolean>> {
  const directory = await mkdtemp(join(tmpdir(), "livis-upstream-check-"));
  const archivePath = join(directory, "plugin.tgz");
  try {
    await writeFile(archivePath, archive, { mode: 0o600 });
    const listingProcess = Bun.spawn(["tar", "-tzf", archivePath], { stdout: "pipe", stderr: "pipe" });
    const [listing, listingError, listingExit] = await Promise.all([
      readProcessText(listingProcess.stdout, 4 * 1024 * 1024, "tar 文件列表"),
      readProcessText(listingProcess.stderr, 256 * 1024, "tar 列表错误输出"),
      listingProcess.exited,
    ]);
    if (listingExit !== 0) {
      throw new Error(`官方包 tar 列表失败：${listingError.trim()}`);
    }
    const entries = listing.split(/\r?\n/).filter(Boolean);
    if (entries.length > 20_000) {
      throw new Error("官方包 tar 条目数量超过上限 20000");
    }
    if (entries.some((entry) => entry.startsWith("/") || entry.split("/").includes(".."))) {
      throw new Error("官方包包含绝对路径或目录穿越条目");
    }
    const bundleEntry = entries.find((entry) => entry === "./bundle.js" || entry === "bundle.js");
    if (!bundleEntry) {
      return Object.fromEntries(markers.map((marker) => [marker, false]));
    }
    const extractProcess = Bun.spawn(["tar", "-xOzf", archivePath, bundleEntry], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [bundle, extractError, extractExit] = await Promise.all([
      readProcessText(extractProcess.stdout, 16 * 1024 * 1024, "bundle.js"),
      readProcessText(extractProcess.stderr, 256 * 1024, "tar 解压错误输出"),
      extractProcess.exited,
    ]);
    if (extractExit !== 0) {
      throw new Error(`官方包 bundle.js 静态读取失败：${extractError.trim()}`);
    }
    return Object.fromEntries(markers.map((marker) => [marker, bundle.includes(marker)]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export class UpstreamChecker {
  private readonly fetchImplementation: typeof fetch;
  private readonly bundleProbe: (archive: Uint8Array, markers: string[]) => Promise<Record<string, boolean>>;
  private readonly artifactSink?: UpstreamCheckerOptions["artifactSink"];
  private readonly fetchTimeoutMs: number;
  private readonly maxScriptBytes: number;
  private readonly maxPackageBytes: number;

  constructor(options: UpstreamCheckerOptions = {}) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.bundleProbe = options.bundleProbe ?? defaultBundleProbe;
    this.artifactSink = options.artifactSink;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 30_000;
    this.maxScriptBytes = options.maxScriptBytes ?? 2 * 1024 * 1024;
    this.maxPackageBytes = options.maxPackageBytes ?? 64 * 1024 * 1024;
  }

  async check(activeProfile: ProtocolProfile, allProfiles: ProtocolProfile[] = [activeProfile]): Promise<UpstreamSnapshot> {
    const setupBytes = await fetchBytes(
      this.fetchImplementation,
      activeProfile.upstream.setupUrl,
      this.fetchTimeoutMs,
      this.maxScriptBytes,
    );
    const installBytes = await fetchBytes(
      this.fetchImplementation,
      activeProfile.upstream.installPluginUrl,
      this.fetchTimeoutMs,
      this.maxScriptBytes,
    );
    const setupArtifactPath = await this.artifactSink?.(
      "setup",
      activeProfile.upstream.setupUrl,
      setupBytes,
    ) ?? null;
    const installArtifactPath = await this.artifactSink?.(
      "install-plugin",
      activeProfile.upstream.installPluginUrl,
      installBytes,
    ) ?? null;
    const setupScript = new TextDecoder().decode(setupBytes);
    const installScript = new TextDecoder().decode(installBytes);
    const versionRaw = extractAssignment(installScript, "SCRIPT_VERSION");
    const detectedVersion = versionRaw?.replace(/^v/, "") ?? null;
    const packageUrl = extractAssignment(installScript, "OPENCLAW_PLUGIN_CDN_URL");
    const packageBytes = packageUrl
      ? await fetchBytes(this.fetchImplementation, packageUrl, this.fetchTimeoutMs, this.maxPackageBytes)
      : null;
    const packageArtifactPath = packageBytes && packageUrl
      ? await this.artifactSink?.("package", packageUrl, packageBytes) ?? null
      : null;
    const packageHash = packageBytes ? sha256(packageBytes) : null;
    const markerNames = [...new Set(
      [activeProfile, ...allProfiles].flatMap((profile) => profile.upstream.requiredBundleMarkers),
    )];
    const bundleMarkers = packageBytes
      ? await this.bundleProbe(packageBytes, markerNames)
      : Object.fromEntries(markerNames.map((marker) => [marker, false]));

    const setupHash = sha256(setupBytes);
    const installHash = sha256(installBytes);
    const markersMatch = (profile: ProtocolProfile) =>
      profile.upstream.requiredBundleMarkers.every((marker) => bundleMarkers[marker] === true);
    const activeArtifactMatches = matchesSnapshot(
      activeProfile,
      detectedVersion,
      activeProfile.upstream.setupUrl,
      setupHash,
      activeProfile.upstream.installPluginUrl,
      installHash,
      packageUrl,
      packageHash,
    );
    const activeMatches = activeArtifactMatches && markersMatch(activeProfile);
    const exactReviewedArtifact = allProfiles.find((profile) =>
      profile.id !== activeProfile.id && matchesSnapshot(
        profile,
        detectedVersion,
        activeProfile.upstream.setupUrl,
        setupHash,
        activeProfile.upstream.installPluginUrl,
        installHash,
        packageUrl,
        packageHash,
      )
    );
    const reviewedUpgrade = exactReviewedArtifact && markersMatch(exactReviewedArtifact)
      ? exactReviewedArtifact
      : undefined;
    const sameVersionProfile = allProfiles.find((profile) => profile.officialPluginVersion === detectedVersion);
    const markersCompatible = markersMatch(activeProfile);
    const reasons: string[] = [];
    let compatibility: UpstreamCompatibility;
    let matchedProfile: ProtocolProfile | undefined;
    if (activeMatches) {
      compatibility = "supported";
      matchedProfile = activeProfile;
      reasons.push("当前 active profile 的版本、来源 URL 和全部哈希均匹配上游");
    } else if (reviewedUpgrade) {
      compatibility = "reviewed-upgrade-available";
      matchedProfile = reviewedUpgrade;
      reasons.push(`上游已匹配已审核 profile ${reviewedUpgrade.id}，但当前 active profile 尚未显式切换`);
    } else if (activeArtifactMatches || exactReviewedArtifact) {
      compatibility = "unknown-breaking";
      const exactProfile = activeArtifactMatches ? activeProfile : exactReviewedArtifact!;
      reasons.push(`artifact 哈希虽匹配 ${exactProfile.id}，但该 profile 的关键 wire marker 缺失`);
    } else if (sameVersionProfile && markersCompatible) {
      compatibility = "drift";
      if (sameVersionProfile.upstream.setupSha256 !== setupHash) reasons.push("setup.sh 哈希漂移");
      if (sameVersionProfile.upstream.installPluginSha256 !== installHash) reasons.push("install-plugin.sh 哈希漂移");
      if (sameVersionProfile.upstream.packageSha256 !== packageHash) reasons.push("插件包哈希漂移");
    } else if (detectedVersion && markersCompatible) {
      compatibility = "candidate-compatible";
      reasons.push("发现新版本，关键 wire marker 仍存在；必须人工审阅并新增 profile 后才能运行");
    } else {
      compatibility = "unknown-breaking";
      const missingMarkers = markerNames.filter((marker) => bundleMarkers[marker] !== true);
      reasons.push("版本或关键 wire marker 不兼容，拒绝自动升级");
      if (missingMarkers.length > 0) reasons.push(`缺少关键 marker：${missingMarkers.join(", ")}`);
    }
    return {
      checkedAt: new Date().toISOString(),
      activeProfileId: activeProfile.id,
      compatibility,
      detectedVersion,
      setup: {
        url: activeProfile.upstream.setupUrl,
        sha256: setupHash,
        sizeBytes: setupBytes.byteLength,
        artifactPath: setupArtifactPath,
      },
      installPlugin: {
        url: activeProfile.upstream.installPluginUrl,
        sha256: installHash,
        sizeBytes: installBytes.byteLength,
        artifactPath: installArtifactPath,
      },
      package: {
        url: packageUrl,
        sha256: packageHash,
        sizeBytes: packageBytes?.byteLength ?? null,
        artifactPath: packageArtifactPath,
      },
      bundleMarkers,
      matchedProfileId: matchedProfile?.id ?? null,
      reasons,
    };
  }
}
