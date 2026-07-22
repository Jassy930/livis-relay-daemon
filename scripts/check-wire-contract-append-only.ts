import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseWireContractRegistryDocument,
  WIRE_CONTRACT_REGISTRY_PATH,
  type WireContractDefinition,
  type WireContractRegistryDocument,
} from "../src/protocol/contract-registry.ts";
import { sha256 } from "../src/util.ts";

interface GitResult {
  success: boolean;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

interface GitBlob {
  mode: string;
  path: string;
  bytes: Uint8Array;
}

export interface AppendOnlyReport {
  root: string;
  baseRef: string;
  inheritedRevisions: string[];
  addedRevisions: string[];
  bootstrap: boolean;
}

export interface AppendOnlyOptions {
  allowBootstrap?: boolean;
}

const decoder = new TextDecoder();
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

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

function requireGit(root: string, args: string[], label: string): GitResult {
  const result = runGit(root, args);
  if (!result.success) {
    throw new Error(`${label}：${gitError(result) || "未知 Git 错误"}`);
  }
  return result;
}

function readBlob(root: string, hash: string): Uint8Array {
  return requireGit(root, ["cat-file", "blob", hash], `无法读取 Git blob ${hash.slice(0, 12)}`).stdout;
}

function parseIndexRecord(record: string, expectedPath: string): { mode: string; hash: string } {
  const separator = record.indexOf("\t");
  if (separator < 0 || record.slice(separator + 1) !== expectedPath) {
    throw new Error(`无法解析候选 index 条目：${expectedPath}`);
  }
  const [mode, hash, stage] = record.slice(0, separator).split(" ");
  if (!mode || !hash || stage !== "0") {
    throw new Error(`候选 index 条目不是唯一 stage-0 文件：${expectedPath}`);
  }
  return { mode, hash };
}

function readIndexBlob(root: string, path: string): GitBlob | null {
  const result = requireGit(
    root,
    ["ls-files", "--cached", "--stage", "-z", "--", path],
    `无法读取候选 index：${path}`,
  );
  const records = decoder.decode(result.stdout).split("\0").filter(Boolean);
  if (records.length === 0) return null;
  if (records.length !== 1) {
    throw new Error(`候选 index 包含多个条目：${path}`);
  }
  const { mode, hash } = parseIndexRecord(records[0]!, path);
  return { mode, path, bytes: readBlob(root, hash) };
}

function readTreeBlob(root: string, ref: string, path: string): GitBlob | null {
  const result = requireGit(root, ["ls-tree", "-z", ref, "--", path], `无法读取基线 ${ref}:${path}`);
  const records = decoder.decode(result.stdout).split("\0").filter(Boolean);
  if (records.length === 0) return null;
  if (records.length !== 1) {
    throw new Error(`基线包含多个条目：${ref}:${path}`);
  }
  const record = records[0]!;
  const separator = record.indexOf("\t");
  if (separator < 0 || record.slice(separator + 1) !== path) {
    throw new Error(`无法解析基线条目：${ref}:${path}`);
  }
  const [mode, type, hash] = record.slice(0, separator).split(" ");
  if (!mode || type !== "blob" || !hash) {
    throw new Error(`基线条目不是普通 blob：${ref}:${path}`);
  }
  return { mode, path, bytes: readBlob(root, hash) };
}

function requireRegularJson(blob: GitBlob | null, label: string): GitBlob {
  if (!blob) throw new Error(`${label} 缺失`);
  if (blob.mode !== "100644") {
    throw new Error(`${label} 必须是 mode 100644 的普通文件，收到 ${blob.mode}`);
  }
  return blob;
}

function parseRegistry(bytes: Uint8Array, label: string): WireContractRegistryDocument {
  let parsed: unknown;
  let text: string;
  try {
    text = strictUtf8Decoder.decode(bytes);
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} 不是严格 UTF-8 JSON`, { cause: error });
  }
  if (text !== `${JSON.stringify(parsed, null, 2)}\n`) {
    throw new Error(`${label} 必须使用 canonical JSON（2 空格缩进且末尾单换行）`);
  }
  return parseWireContractRegistryDocument(parsed, label);
}

function definitionMap(document: WireContractRegistryDocument): Map<string, WireContractDefinition> {
  return new Map(document.contracts.map((definition) => [definition.revision, definition]));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function validateCandidateArtifacts(
  root: string,
  document: WireContractRegistryDocument,
): Map<string, GitBlob> {
  const artifacts = new Map<string, GitBlob>();
  for (const definition of document.contracts) {
    const artifact = requireRegularJson(
      readIndexBlob(root, definition.localProbeArtifactPath),
      `候选 artifact ${definition.localProbeArtifactPath}`,
    );
    const actualSha256 = sha256(artifact.bytes);
    if (actualSha256 !== definition.localProbeArtifactSha256) {
      throw new Error(
        `候选 artifact SHA-256 不匹配：${definition.localProbeArtifactPath} ` +
        `期望 ${definition.localProbeArtifactSha256}，收到 ${actualSha256}`,
      );
    }
    let parsed: unknown;
    let artifactText: string;
    try {
      artifactText = strictUtf8Decoder.decode(artifact.bytes);
      parsed = JSON.parse(artifactText);
    } catch (error) {
      throw new Error(`候选 artifact 不是严格 UTF-8 JSON：${definition.localProbeArtifactPath}`, { cause: error });
    }
    if (artifactText !== `${JSON.stringify(parsed, null, 2)}\n`) {
      throw new Error(`候选 artifact 不是 canonical JSON：${definition.localProbeArtifactPath}`);
    }
    const artifactRoot = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
    const contractValue = artifactRoot?.contract;
    const contract = contractValue !== null && typeof contractValue === "object" && !Array.isArray(contractValue)
      ? contractValue as Record<string, unknown>
      : null;
    if (
      artifactRoot?.schemaVersion !== 1 ||
      artifactRoot?.evidenceLevel !== "S2" ||
      contract?.wireContractRevision !== definition.revision ||
      contract?.credentialMode !== definition.credentialMode ||
      contract?.wireProtocolVersion !== definition.wireProtocolVersion
    ) {
      throw new Error(`候选 artifact contract 与 registry 不一致：${definition.localProbeArtifactPath}`);
    }
    artifacts.set(definition.revision, artifact);
  }
  return artifacts;
}

function verifyCommit(root: string, ref: string): void {
  const result = runGit(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!result.success) {
    throw new Error(`wire contract 基线不是可读取的 commit：${ref}`);
  }
}

function isZeroObjectId(value: string): boolean {
  return /^0{40,64}$/.test(value);
}

function mergeBase(root: string, ref: string): string | null {
  const result = runGit(root, ["merge-base", "HEAD", ref]);
  return result.success ? decoder.decode(result.stdout).trim() || null : null;
}

function baseProbePaths(root: string, ref: string): string[] {
  const result = requireGit(root, ["ls-tree", "-r", "--name-only", "-z", ref, "--", "protocol-probes"], (
    `无法枚举基线 ${ref}:protocol-probes/`
  ));
  return decoder.decode(result.stdout).split("\0").filter(Boolean);
}

export function resolveWireContractBaseRef(
  root: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configuredValue = environment.WIRE_CONTRACT_BASE_REF;
  const configured = configuredValue?.trim();
  if (configured && !isZeroObjectId(configured)) {
    verifyCommit(root, configured);
    return configured;
  }
  if (configuredValue !== undefined) {
    throw new Error("WIRE_CONTRACT_BASE_REF 禁止为空或使用全零 object ID");
  }

  const githubBaseBranch = environment.GITHUB_BASE_REF?.trim();
  if (githubBaseBranch) {
    const remoteRef = `refs/remotes/origin/${githubBaseBranch}`;
    const base = mergeBase(root, remoteRef);
    if (base) return base;
  }

  const symbolicDefault = runGit(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  const candidates = symbolicDefault.success
    ? [decoder.decode(symbolicDefault.stdout).trim(), "refs/remotes/origin/main", "refs/remotes/origin/master"]
    : ["refs/remotes/origin/main", "refs/remotes/origin/master"];
  for (const candidate of candidates.filter(Boolean)) {
    const base = mergeBase(root, candidate);
    if (base) return base;
  }

  throw new Error("无法从 remote default branch 确定 wire contract 基线；请传 --base-ref 或设置 WIRE_CONTRACT_BASE_REF");
}

export function checkWireContractAppendOnly(
  rootPath: string,
  baseRef?: string,
  options: AppendOnlyOptions = {},
): AppendOnlyReport {
  const root = realpathSync(resolve(rootPath));
  const topLevel = decoder.decode(requireGit(root, ["rev-parse", "--show-toplevel"], `${root} 不是 Git 仓库`).stdout).trim();
  if (realpathSync(topLevel) !== root) {
    throw new Error(`${root} 不是独立 Git 仓库顶层目录`);
  }
  const resolvedBase = baseRef ?? resolveWireContractBaseRef(root);
  verifyCommit(root, resolvedBase);
  const ancestor = runGit(root, ["merge-base", "--is-ancestor", resolvedBase, "HEAD"]);
  if (!ancestor.success) {
    throw new Error(`wire contract 基线不是当前 HEAD 的祖先：${resolvedBase}`);
  }

  const candidateRegistryBlob = requireRegularJson(
    readIndexBlob(root, WIRE_CONTRACT_REGISTRY_PATH),
    `候选 registry ${WIRE_CONTRACT_REGISTRY_PATH}`,
  );
  const candidateRegistry = parseRegistry(candidateRegistryBlob.bytes, "候选 wire contract registry");
  const candidateDefinitions = definitionMap(candidateRegistry);
  const candidateArtifacts = validateCandidateArtifacts(root, candidateRegistry);

  const baseRegistryBlob = readTreeBlob(root, resolvedBase, WIRE_CONTRACT_REGISTRY_PATH);
  if (!baseRegistryBlob) {
    const legacyProbePaths = baseProbePaths(root, resolvedBase);
    if (legacyProbePaths.length > 0) {
      throw new Error(
        `基线缺少 registry，但已存在 protocol-probes/ 文件：${legacyProbePaths.join(", ")}`,
      );
    }
    if (!options.allowBootstrap) {
      throw new Error("基线尚无 wire contract registry；首次建立必须显式传 --allow-bootstrap");
    }
    if (candidateRegistry.contracts.length !== 1) {
      throw new Error("首次 bootstrap 必须且只能登记一个 current wire contract revision");
    }
    return {
      root,
      baseRef: resolvedBase,
      inheritedRevisions: [],
      addedRevisions: [...candidateDefinitions.keys()].sort(),
      bootstrap: true,
    };
  }

  const baseRegistry = parseRegistry(
    requireRegularJson(baseRegistryBlob, `基线 registry ${resolvedBase}:${WIRE_CONTRACT_REGISTRY_PATH}`).bytes,
    "基线 wire contract registry",
  );
  const baseDefinitions = definitionMap(baseRegistry);
  for (const [revision, baseDefinition] of baseDefinitions) {
    const candidateDefinition = candidateDefinitions.get(revision);
    if (!candidateDefinition) {
      throw new Error(`禁止删除既有 wire contract revision：${revision}`);
    }
    if (JSON.stringify(candidateDefinition) !== JSON.stringify(baseDefinition)) {
      throw new Error(`禁止原地修改既有 wire contract definition：${revision}`);
    }
    const baseArtifact = requireRegularJson(
      readTreeBlob(root, resolvedBase, baseDefinition.localProbeArtifactPath),
      `基线 artifact ${resolvedBase}:${baseDefinition.localProbeArtifactPath}`,
    );
    const candidateArtifact = candidateArtifacts.get(revision)!;
    if (!sameBytes(baseArtifact.bytes, candidateArtifact.bytes)) {
      throw new Error(`禁止原地修改既有 wire contract artifact：${baseDefinition.localProbeArtifactPath}`);
    }
  }

  const addedRevisions = [...candidateDefinitions.keys()].filter((revision) => !baseDefinitions.has(revision)).sort();
  if (addedRevisions.length > 1) {
    throw new Error(`每次变更最多新增一个 wire contract revision：${addedRevisions.join(", ")}`);
  }
  if (addedRevisions.length === 1 && candidateRegistry.currentRevision !== addedRevisions[0]) {
    throw new Error(`新增 revision 必须成为 current，以接受 generator 校验：${addedRevisions[0]}`);
  }
  if (addedRevisions.length === 0 && candidateRegistry.currentRevision !== baseRegistry.currentRevision) {
    throw new Error("没有新增 revision 时禁止切换 currentRevision");
  }

  return {
    root,
    baseRef: resolvedBase,
    inheritedRevisions: [...baseDefinitions.keys()].sort(),
    addedRevisions,
    bootstrap: false,
  };
}

function usage(): string {
  return "用法：bun run scripts/check-wire-contract-append-only.ts [--root /path/to/repository] [--base-ref <commit>] [--allow-bootstrap]";
}

function parseArguments(args: string[]): { root: string; baseRef?: string; allowBootstrap: boolean } {
  let root = resolve(import.meta.dir, "..");
  let baseRef: string | undefined;
  let allowBootstrap = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (argument === "--allow-bootstrap") {
      allowBootstrap = true;
      continue;
    }
    if (argument === "--root" || argument === "--base-ref") {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} 缺少参数`);
      if (argument === "--root") root = resolve(value);
      else baseRef = value;
      index += 1;
      continue;
    }
    throw new Error(`未知参数：${argument}\n${usage()}`);
  }
  return { root, ...(baseRef ? { baseRef } : {}), allowBootstrap };
}

if (import.meta.main) {
  try {
    const options = parseArguments(Bun.argv.slice(2));
    const report = checkWireContractAppendOnly(
      options.root,
      options.baseRef,
      { allowBootstrap: options.allowBootstrap },
    );
    process.stdout.write(
      `wire contract append-only 门禁通过：基线 ${report.baseRef.slice(0, 12)}，` +
      `继承 ${report.inheritedRevisions.length}，新增 ${report.addedRevisions.length}` +
      `${report.bootstrap ? "（首次建立 registry）" : ""}\n`,
    );
  } catch (error) {
    process.stderr.write(`wire contract append-only 门禁失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
