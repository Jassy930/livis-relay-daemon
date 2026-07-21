import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  parseWireContractRegistryDocument,
  WIRE_CONTRACT_REGISTRY_PATH,
  type WireContractDefinition,
} from "../src/protocol/contract-registry.ts";

export interface AuditFinding {
  path: string;
  rule: string;
  message: string;
}

export interface AuditOptions {
  oauthClientFingerprints?: ReadonlySet<string>;
  productionHosts?: readonly string[];
}

export interface AuditReport {
  root: string;
  trackedFiles: number;
  scannedTextFiles: number;
  skippedBinaryFiles: number;
  findings: AuditFinding[];
}

interface IndexEntry {
  mode: string;
  hash: string;
  stage: string;
}

interface GitResult {
  success: boolean;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

const decoder = new TextDecoder();
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

// 只保存官方 oauth.clientId 的 SHA-256 指纹，不保存或输出原值。
export const OFFICIAL_OAUTH_CLIENT_FINGERPRINTS: ReadonlySet<string> = new Set([
  "3c42d481cb82aa4a1085c3854a870efe7a24a3d52305685b3c9e20412b310efc", // pragma: allowlist secret
]);

// 避免门禁脚本自身包含连续的生产域名文本。
export const PRODUCTION_LIVIS_HOSTS: readonly string[] = [
  ["id", "lixiang", "com"].join("."),
  ["li-center", "lixiang", "com"].join("."),
  ["livis-pc-kit-gateway", "livis", "com"].join("."),
];

const documentationNames = new Set([
  "agents.md",
  "changelog.md",
  "code_of_conduct.md",
  "contributing.md",
  "license",
  "license.md",
  "notice",
  "notice.md",
  "readme",
  "readme.md",
  "security.md",
]);

function finding(path: string, rule: string, message: string): AuditFinding {
  return { path, rule, message };
}

function pathParts(path: string): string[] {
  return path.toLowerCase().split("/").filter(Boolean);
}

export function auditTrackedPath(
  path: string,
  registeredProbeArtifactPaths: ReadonlySet<string> = new Set(),
): AuditFinding[] {
  const normalized = path.replaceAll("\\", "/");
  const lower = normalized.toLowerCase();
  const name = basename(lower);
  const parts = pathParts(normalized);
  const findings: AuditFinding[] = [];

  if (/\.local\.json$/.test(name)) {
    findings.push(finding(normalized, "local-profile", "禁止发布 *.local.json 本地授权 profile"));
  }
  if (/\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/.test(name) || /-(?:wal|shm)$/.test(name)) {
    findings.push(finding(normalized, "database-state", "禁止发布数据库及其 WAL/SHM 状态"));
  }
  if (/\.log(?:\.\d+)?$/.test(name)) {
    findings.push(finding(normalized, "runtime-log", "禁止发布运行日志"));
  }
  if (/\.(?:pem|key)$/.test(name)) {
    findings.push(finding(normalized, "private-key-file", "禁止发布 PEM 或 key 文件"));
  }
  if (/^\.env(?:\..+)?$/.test(name) && !/^\.env\.(?:example|sample|template)$/.test(name)) {
    findings.push(finding(normalized, "environment-file", "禁止发布 .env 及其本地变体"));
  }
  if (name === "bundle.js") {
    findings.push(finding(normalized, "official-bundle", "禁止发布官方 bundle.js"));
  }
  if (/\.(?:tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|zip|7z|rar)$/.test(name)) {
    findings.push(finding(normalized, "archive", "禁止把上游或发布归档提交到源码树"));
  }
  if (parts.includes("upstream-artifacts")) {
    findings.push(finding(normalized, "upstream-artifact", "禁止发布 upstream-artifacts/ 原始上游产物"));
  }
  if (parts[0] === "protocol-probes" && !registeredProbeArtifactPaths.has(path)) {
    findings.push(finding(
      normalized,
      "unregistered-probe-artifact",
      "protocol-probes/ 只允许 wire contract registry 精确登记的脱敏 S2 artifact",
    ));
  }
  if (parts.includes("node_modules") || parts.includes(".venv")) {
    findings.push(finding(normalized, "dependency-tree", "禁止发布本地依赖目录"));
  }
  if (
    parts[0] === ".state" ||
    parts[0] === ".livis-relay" ||
    parts[0] === "state" ||
    parts[0] === "upstream-candidates" ||
    parts[0] === "upstream-approvals" ||
    parts[0] === "config-backups" ||
    parts[0] === "upstream"
  ) {
    findings.push(finding(normalized, "runtime-state-directory", "禁止发布根级运行时状态目录"));
  }
  if (
    new Set([
      "access-token",
      "access-token.json",
      "access_token",
      "access_token.json",
      "config.json",
      "credentials.json",
      "identity.json",
      "livis-agent.id",
      "livis-pc-kit-tokens.json",
      "oauth.json",
      "refresh-token",
      "refresh-token.json",
      "refresh_token",
      "refresh_token.json",
      "secrets.json",
      "state.json",
      "token",
      "token.json",
      "tokens.json",
    ]).has(name) || /\.(?:token|tokens|sock|pid)$/.test(name)
  ) {
    findings.push(finding(normalized, "credential-or-state-file", "禁止发布常见 token、identity、secret 或 state 文件"));
  }

  return findings;
}

function isDocumentation(path: string): boolean {
  const name = basename(path).toLowerCase();
  return documentationNames.has(name) || /\.(?:md|mdx|rst|txt)$/.test(name);
}

function sha256(value: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function textCandidates(content: string): Set<string> {
  const candidates = new Set<string>();
  for (const match of content.matchAll(/["'`]([^"'`\r\n]{1,512})["'`]/g)) {
    candidates.add(match[1]!);
  }
  for (const match of content.matchAll(/[A-Za-z0-9][A-Za-z0-9._~+:\/=\-]{7,511}/g)) {
    candidates.add(match[0]);
  }
  return candidates;
}

export function auditTrackedText(
  path: string,
  content: string,
  options: AuditOptions = {},
): AuditFinding[] {
  const fingerprints = options.oauthClientFingerprints ?? OFFICIAL_OAUTH_CLIENT_FINGERPRINTS;
  const hosts = options.productionHosts ?? PRODUCTION_LIVIS_HOSTS;
  const findings: AuditFinding[] = [];
  const lowerContent = content.toLowerCase();

  // Markdown/纯文本文档可以说明生产域名；运行时代码、配置和数据不可以携带它。
  if (!isDocumentation(path)) {
    for (const host of hosts) {
      if (lowerContent.includes(host.toLowerCase())) {
        findings.push(finding(path, "production-domain", `运行时文件包含生产 LiViS 域名：${host}`));
      }
    }
  }

  for (const candidate of textCandidates(content)) {
    if (fingerprints.has(sha256(candidate))) {
      findings.push(finding(path, "official-oauth-client", "文件包含官方 OAuth client identity 指纹匹配值"));
      break;
    }
  }

  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(content)) {
    findings.push(finding(path, "private-key-content", "文件内容包含私钥头"));
  }

  return findings;
}

function runGit(root: string, args: string[]): GitResult {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", root, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return { success: result.success, stdout: result.stdout, stderr: result.stderr };
}

function gitError(result: GitResult): string {
  return decoder.decode(result.stderr).trim();
}

function splitNull(bytes: Uint8Array): string[] {
  return decoder.decode(bytes).split("\0").filter((value) => value.length > 0);
}

function readIndex(root: string): { paths: string[]; entries: Map<string, IndexEntry[]> } {
  const listed = runGit(root, ["ls-files", "--cached", "-z", "--"]);
  if (!listed.success) {
    throw new Error(`git ls-files 失败：${gitError(listed) || "未知错误"}`);
  }
  const staged = runGit(root, ["ls-files", "--cached", "--stage", "-z", "--"]);
  if (!staged.success) {
    throw new Error(`git ls-files --stage 失败：${gitError(staged) || "未知错误"}`);
  }

  const entries = new Map<string, IndexEntry[]>();
  for (const record of splitNull(staged.stdout)) {
    const separator = record.indexOf("\t");
    if (separator < 0) throw new Error("无法解析 Git index 条目");
    const [mode, hash, stage] = record.slice(0, separator).split(" ");
    const path = record.slice(separator + 1);
    if (!mode || !hash || !stage) throw new Error(`无法解析 Git index 元数据：${path}`);
    const values = entries.get(path) ?? [];
    values.push({ mode, hash, stage });
    entries.set(path, values);
  }
  return { paths: splitNull(listed.stdout), entries };
}

function readBlob(root: string, hash: string): Uint8Array {
  const result = runGit(root, ["cat-file", "blob", hash]);
  if (!result.success) {
    throw new Error(`无法读取 Git index blob ${hash.slice(0, 12)}：${gitError(result) || "未知错误"}`);
  }
  return result.stdout;
}

function regularIndexEntry(
  path: string,
  entries: ReadonlyMap<string, IndexEntry[]>,
  findings: AuditFinding[],
  rule: string,
): IndexEntry | null {
  const values = entries.get(path) ?? [];
  if (values.length !== 1 || values[0]!.stage !== "0") {
    findings.push(finding(path, rule, "必须是唯一 stage-0 Git index 条目"));
    return null;
  }
  const entry = values[0]!;
  if (entry.mode !== "100644") {
    findings.push(finding(path, rule, `必须是 mode 100644 的普通文件，收到 ${entry.mode}`));
    return null;
  }
  return entry;
}

function parseStrictJson(bytes: Uint8Array, label: string, requireCanonical = false): unknown {
  try {
    const text = strictUtf8Decoder.decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (requireCanonical && text !== `${JSON.stringify(parsed, null, 2)}\n`) {
      throw new Error(`${label} 必须使用 canonical JSON（2 空格缩进且末尾单换行）`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.includes("canonical JSON")) throw error;
    throw new Error(`${label} 必须是严格 UTF-8 JSON`, { cause: error });
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function auditRegisteredProbeArtifact(
  definition: WireContractDefinition,
  bytes: Uint8Array,
): AuditFinding[] {
  const path = definition.localProbeArtifactPath;
  const findings: AuditFinding[] = [];
  let parsed: unknown;
  try {
    parsed = parseStrictJson(bytes, path, true);
  } catch (error) {
    return [finding(path, "probe-artifact-format", error instanceof Error ? error.message : String(error))];
  }
  const root = objectValue(parsed);
  if (!root || !sameKeys(root, [
    "schemaVersion",
    "evidenceLevel",
    "disclaimer",
    "contract",
    "safety",
    "relay",
    "idaas",
    "unknowns",
  ])) {
    findings.push(finding(path, "probe-artifact-schema", "artifact 顶层字段不符合公开 S2 schema"));
    return findings;
  }
  const contract = objectValue(root.contract);
  if (
    !contract ||
    !sameKeys(contract, ["wireProtocolVersion", "wireContractRevision", "credentialMode"]) ||
    contract.wireProtocolVersion !== definition.wireProtocolVersion ||
    contract.wireContractRevision !== definition.revision ||
    contract.credentialMode !== definition.credentialMode
  ) {
    findings.push(finding(path, "probe-artifact-contract", "artifact contract 与 registry definition 不一致"));
  }
  const safety = objectValue(root.safety);
  if (
    root.schemaVersion !== 1 ||
    root.evidenceLevel !== "S2" ||
    typeof root.disclaimer !== "string" ||
    root.disclaimer.trim() === "" ||
    !safety ||
    !sameKeys(safety, ["network", "credentials", "liveProfileRead", "rawFramePersistence"]) ||
    safety.liveProfileRead !== false ||
    safety.rawFramePersistence !== false ||
    typeof safety.network !== "string" ||
    typeof safety.credentials !== "string" ||
    !objectValue(root.relay) ||
    !objectValue(root.idaas) ||
    !Array.isArray(root.unknowns) ||
    root.unknowns.some((item) => typeof item !== "string")
  ) {
    findings.push(finding(path, "probe-artifact-schema", "artifact 不是完整的脱敏 S2 报告"));
  }
  let text = "";
  try {
    text = strictUtf8Decoder.decode(bytes);
  } catch {
    // 前面的严格 JSON 解析已登记该错误。
  }
  if (/(?:https|wss?):\/\//i.test(text)) {
    findings.push(finding(path, "probe-artifact-url", "公开 probe artifact 禁止包含 URL"));
  }
  return findings;
}

function registeredProbeArtifacts(
  root: string,
  paths: readonly string[],
  entries: ReadonlyMap<string, IndexEntry[]>,
  blobCache: Map<string, Uint8Array>,
  findings: AuditFinding[],
): Map<string, WireContractDefinition> {
  const registered = new Map<string, WireContractDefinition>();
  const hasProbePaths = paths.some((path) => (
    path.toLowerCase().replaceAll("\\", "/").startsWith("protocol-probes/")
  ));
  if (!entries.has(WIRE_CONTRACT_REGISTRY_PATH)) {
    if (hasProbePaths) {
      findings.push(finding(
        WIRE_CONTRACT_REGISTRY_PATH,
        "probe-registry-missing",
        "存在 protocol-probes/ 文件时 registry 必须存在且有效",
      ));
    }
    return registered;
  }
  const registryEntry = regularIndexEntry(
    WIRE_CONTRACT_REGISTRY_PATH,
    entries,
    findings,
    "probe-registry-index",
  );
  if (!registryEntry) {
    if (hasProbePaths) {
      findings.push(finding(
        WIRE_CONTRACT_REGISTRY_PATH,
        "probe-registry-missing",
        "存在 protocol-probes/ 文件时 registry 必须存在且有效",
      ));
    }
    return registered;
  }

  let registryBytes = blobCache.get(registryEntry.hash);
  if (!registryBytes) {
    registryBytes = readBlob(root, registryEntry.hash);
    blobCache.set(registryEntry.hash, registryBytes);
  }
  let document;
  try {
    document = parseWireContractRegistryDocument(
      parseStrictJson(registryBytes, WIRE_CONTRACT_REGISTRY_PATH, true),
      "Git index wire contract registry",
    );
  } catch (error) {
    findings.push(finding(
      WIRE_CONTRACT_REGISTRY_PATH,
      "probe-registry-schema",
      error instanceof Error ? error.message : String(error),
    ));
    return registered;
  }

  for (const definition of document.contracts) {
    registered.set(definition.localProbeArtifactPath, definition);
    const artifactEntry = regularIndexEntry(
      definition.localProbeArtifactPath,
      entries,
      findings,
      "probe-artifact-index",
    );
    if (!artifactEntry) continue;
    let bytes = blobCache.get(artifactEntry.hash);
    if (!bytes) {
      bytes = readBlob(root, artifactEntry.hash);
      blobCache.set(artifactEntry.hash, bytes);
    }
    const actualSha256 = sha256(bytes);
    if (actualSha256 !== definition.localProbeArtifactSha256) {
      findings.push(finding(
        definition.localProbeArtifactPath,
        "probe-artifact-sha256",
        `registry SHA-256 ${definition.localProbeArtifactSha256} 与 index blob ${actualSha256} 不一致`,
      ));
      continue;
    }
    findings.push(...auditRegisteredProbeArtifact(definition, bytes));
  }
  return registered;
}

export async function auditRepository(rootPath: string, options: AuditOptions = {}): Promise<AuditReport> {
  const root = realpathSync(resolve(rootPath));
  const topLevelResult = runGit(root, ["rev-parse", "--show-toplevel"]);
  if (!topLevelResult.success) {
    throw new Error(
      `${root} 不是 Git 仓库。请先在项目根目录执行 git init，并在审计前用 git add 更新 index；门禁只审核 git ls-files 返回的 tracked files。`,
    );
  }
  const topLevel = realpathSync(decoder.decode(topLevelResult.stdout).trim());
  if (topLevel !== root) {
    throw new Error(`${root} 不是独立 Git 仓库顶层目录（当前顶层：${topLevel}）`);
  }

  const { paths, entries } = readIndex(root);
  const findings: AuditFinding[] = [];
  let scannedTextFiles = 0;
  let skippedBinaryFiles = 0;
  const blobCache = new Map<string, Uint8Array>();
  const registeredArtifacts = registeredProbeArtifacts(root, paths, entries, blobCache, findings);
  const registeredArtifactPaths = new Set(registeredArtifacts.keys());

  if (paths.length === 0) {
    findings.push(finding("(git index)", "empty-index", "Git index 没有 tracked files；请先 git add 再运行门禁"));
  }

  for (const path of paths) {
    const pathFindings = auditTrackedPath(path, registeredArtifactPaths);
    findings.push(...pathFindings);
    const indexEntries = entries.get(path) ?? [];
    if (indexEntries.length !== 1 || indexEntries[0]!.stage !== "0") {
      findings.push(finding(path, "unmerged-index", "Git index 存在未合并或不完整条目"));
      continue;
    }
    const entry = indexEntries[0]!;
    if (entry.mode === "120000" || entry.mode === "160000") {
      findings.push(finding(path, "indirect-content", "公开发布不接受 tracked symlink 或 submodule"));
      continue;
    }
    if (pathFindings.length > 0) continue;

    let bytes = blobCache.get(entry.hash);
    if (!bytes) {
      bytes = readBlob(root, entry.hash);
      blobCache.set(entry.hash, bytes);
    }
    if (bytes.includes(0)) {
      skippedBinaryFiles += 1;
      continue;
    }
    scannedTextFiles += 1;
    findings.push(...auditTrackedText(path, decoder.decode(bytes), options));
  }

  return { root, trackedFiles: paths.length, scannedTextFiles, skippedBinaryFiles, findings };
}

function usage(): string {
  return "用法：bun run scripts/check-public-release.ts [--root /path/to/repository]";
}

function parseRoot(args: string[]): string {
  let root = resolve(import.meta.dir, "..");
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (argument === "--root") {
      const value = args[index + 1];
      if (!value) throw new Error("--root 缺少路径参数");
      root = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`未知参数：${argument}\n${usage()}`);
  }
  return root;
}

async function main(): Promise<void> {
  const report = await auditRepository(parseRoot(Bun.argv.slice(2)));
  if (report.findings.length > 0) {
    process.stderr.write(`公开发布门禁失败（${report.findings.length} 项）：\n`);
    for (const item of report.findings) {
      process.stderr.write(`- [${item.rule}] ${item.path}: ${item.message}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `公开发布门禁通过：${report.trackedFiles} 个 tracked files，` +
    `${report.scannedTextFiles} 个文本 blob，${report.skippedBinaryFiles} 个二进制 blob\n`,
  );
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    process.stderr.write(`公开发布门禁无法运行：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
