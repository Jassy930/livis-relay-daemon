import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rmdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { auditTrackedPath, auditTrackedText, type AuditFinding } from "../../scripts/check-public-release.ts";
import { sha256 } from "../util.ts";

export type ReleaseArtifactKind = "source-tarball" | "hermes-bridge-tarball";

export interface ReleaseArtifactRecord {
  kind: ReleaseArtifactKind;
  file: string;
  root: string;
  sha256: string;
  sizeBytes: number;
  requiredPaths: string[];
}

export interface ReleaseManifest {
  schemaVersion: 1;
  package: "livis-relay-daemon";
  version: string;
  generatedAt: string;
  gitCommit: string | null;
  sourceTree: "clean-git" | "working-tree";
  artifacts: ReleaseArtifactRecord[];
}

export interface ReleaseArtifactAuditReport {
  manifestPath: string;
  artifacts: Array<{
    kind: ReleaseArtifactKind;
    file: string;
    entries: number;
    textFiles: number;
    binaryFiles: number;
  }>;
  findings: AuditFinding[];
}

const SOURCE_ROOT_FILES = [
  "AGENTS.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "NOTICE.md",
  "README.md",
  "SECURITY.md",
  "bun.lock",
  "capabilities.json",
  "config.example.json",
  "package.json",
  "tsconfig.json",
] as const;

const SOURCE_DIRECTORIES = [
  ".github",
  "docs",
  "hermes-plugin",
  "packaging",
  "protocol-profiles",
  "schemas",
  "scripts",
  "src",
  "tests",
] as const;

const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  "__pycache__",
  "coverage",
  "dist",
  "node_modules",
]);

export const SOURCE_REQUIRED_PATHS = [
  "capabilities.json",
  "schemas/capabilities.schema.json",
  "package.json",
  "bun.lock",
  "src/index.ts",
  "src/install/deployment.ts",
  "src/install/deployment-service.ts",
  "src/install/deployment-contract.ts",
  "src/release/artifacts.ts",
  "scripts/check-public-release.ts",
  "scripts/check-release-artifacts.ts",
  "hermes-plugin/plugin.yaml",
  "hermes-plugin/adapter.py",
  "docs/RELEASING.md",
  "docs/DEPLOYMENT-INSTALLER.md",
] as const;

export const BRIDGE_REQUIRED_PATHS = [
  "plugin.yaml",
  "__init__.py",
  "adapter.py",
  "README.md",
  "LICENSE",
  "NOTICE.md",
  "capabilities.json",
  "schemas/capabilities.schema.json",
] as const;

const BRIDGE_SOURCE_MAPPING: ReadonlyArray<{ source: string; target: string }> = [
  { source: "hermes-plugin/plugin.yaml", target: "plugin.yaml" },
  { source: "hermes-plugin/__init__.py", target: "__init__.py" },
  { source: "hermes-plugin/adapter.py", target: "adapter.py" },
  { source: "hermes-plugin/README.md", target: "README.md" },
  { source: "LICENSE", target: "LICENSE" },
  { source: "NOTICE.md", target: "NOTICE.md" },
  { source: "capabilities.json", target: "capabilities.json" },
  { source: "schemas/capabilities.schema.json", target: "schemas/capabilities.schema.json" },
];

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function fsyncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function copyReleaseFile(projectRoot: string, stagingRoot: string, relativePath: string): Promise<void> {
  const source = resolve(projectRoot, relativePath);
  const sourceStats = await lstat(source);
  if (sourceStats.isSymbolicLink() || !sourceStats.isFile()) {
    throw new Error(`发布输入必须是普通文件：${relativePath}`);
  }
  const target = resolve(stagingRoot, relativePath);
  await mkdir(dirname(target), { recursive: true, mode: 0o755 });
  await copyFile(source, target);
  await chmod(target, sourceStats.mode & 0o777);
  await fsyncPath(target);
}

async function collectDirectoryFiles(projectRoot: string, relativeDirectory: string): Promise<string[]> {
  const absolute = resolve(projectRoot, relativeDirectory);
  const stats = await lstat(absolute);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`发布输入必须是普通目录：${relativeDirectory}`);
  }
  const files: string[] = [];
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
    const relativePath = join(relativeDirectory, entry.name).replaceAll("\\", "/");
    if (entry.isSymbolicLink()) throw new Error(`发布输入包含符号链接：${relativePath}`);
    if (entry.isDirectory()) files.push(...await collectDirectoryFiles(projectRoot, relativePath));
    else if (entry.isFile()) files.push(relativePath);
    else throw new Error(`发布输入包含不支持的文件类型：${relativePath}`);
  }
  return files;
}

async function sourceReleasePaths(projectRoot: string): Promise<string[]> {
  const paths: string[] = [...SOURCE_ROOT_FILES];
  for (const directory of SOURCE_DIRECTORIES) {
    paths.push(...await collectDirectoryFiles(projectRoot, directory));
  }
  return [...new Set(paths)].sort();
}

async function runCommand(command: string[], cwd?: string): Promise<string> {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command[0]} 执行失败（exit ${exitCode}）：${stderr.trim() || stdout.trim()}`);
  }
  return stdout;
}

async function createTarball(stagingParent: string, rootName: string, outputPath: string): Promise<void> {
  await runCommand(["tar", "-czf", outputPath, "-C", stagingParent, rootName]);
}

async function gitState(projectRoot: string): Promise<{ commit: string | null; clean: boolean }> {
  try {
    const commitValue = await runCommand(["git", "rev-parse", "HEAD"], projectRoot);
    const status = await runCommand(["git", "status", "--porcelain", "--untracked-files=all"], projectRoot);
    const commit = /^[a-f0-9]{40}$/.test(commitValue.trim()) ? commitValue.trim() : null;
    return { commit, clean: Boolean(commit) && status.trim() === "" };
  } catch {
    return { commit: null, clean: false };
  }
}

async function artifactRecord(
  kind: ReleaseArtifactKind,
  path: string,
  root: string,
  requiredPaths: readonly string[],
): Promise<ReleaseArtifactRecord> {
  const content = await readFile(path);
  return {
    kind,
    file: basename(path),
    root,
    sha256: sha256(content),
    sizeBytes: content.byteLength,
    requiredPaths: [...requiredPaths],
  };
}

export async function buildReleaseArtifacts(options: {
  projectRoot: string;
  outputDirectory: string;
  requireCleanGit?: boolean;
}): Promise<{ manifest: ReleaseManifest; manifestPath: string }> {
  const projectRoot = resolve(options.projectRoot);
  const outputDirectory = resolve(options.outputDirectory);
  const packageJson = await Bun.file(resolve(projectRoot, "package.json")).json() as {
    name?: unknown;
    version?: unknown;
  };
  if (packageJson.name !== "livis-relay-daemon" || typeof packageJson.version !== "string") {
    throw new Error("package.json 名称或版本无效");
  }
  const version = packageJson.version;
  const sourceState = await gitState(projectRoot);
  if (options.requireCleanGit && !sourceState.clean) {
    throw new Error("正式发布只允许从没有 tracked/untracked 改动的干净 Git checkout 构建");
  }
  const sourceRoot = `livis-relay-daemon-${version}`;
  const bridgeRoot = `livis-hermes-bridge-${version}`;
  const sourceFile = `livis-relay-daemon-${version}.tar.gz`;
  const bridgeFile = `livis-hermes-bridge-${version}.tar.gz`;
  const manifestPath = join(outputDirectory, "release-manifest.json");
  await mkdir(outputDirectory, { recursive: true, mode: 0o755 });
  for (const path of [join(outputDirectory, sourceFile), join(outputDirectory, bridgeFile), manifestPath]) {
    if (await exists(path)) throw new Error(`拒绝覆盖已有发布产物：${path}`);
  }

  const temporary = await mkdtemp(join(tmpdir(), "livis-release-build-"));
  try {
    const sourceStage = join(temporary, sourceRoot);
    const bridgeStage = join(temporary, bridgeRoot);
    await mkdir(sourceStage, { mode: 0o755 });
    await mkdir(bridgeStage, { mode: 0o755 });
    for (const path of await sourceReleasePaths(projectRoot)) {
      await copyReleaseFile(projectRoot, sourceStage, path);
    }
    for (const mapping of BRIDGE_SOURCE_MAPPING) {
      await copyReleaseFile(projectRoot, bridgeStage, mapping.target === mapping.source ? mapping.source : mapping.source);
      if (mapping.target !== mapping.source) {
        const copied = join(bridgeStage, mapping.source);
        const target = join(bridgeStage, mapping.target);
        await mkdir(dirname(target), { recursive: true, mode: 0o755 });
        await renameWithinStage(copied, target);
        await removeEmptyParents(dirname(copied), bridgeStage);
      }
    }

    const sourcePath = join(outputDirectory, sourceFile);
    const bridgePath = join(outputDirectory, bridgeFile);
    await createTarball(temporary, sourceRoot, sourcePath);
    await createTarball(temporary, bridgeRoot, bridgePath);
    const manifest: ReleaseManifest = {
      schemaVersion: 1,
      package: "livis-relay-daemon",
      version,
      generatedAt: new Date().toISOString(),
      gitCommit: sourceState.clean ? sourceState.commit : null,
      sourceTree: sourceState.clean ? "clean-git" : "working-tree",
      artifacts: [
        await artifactRecord("source-tarball", sourcePath, sourceRoot, SOURCE_REQUIRED_PATHS),
        await artifactRecord("hermes-bridge-tarball", bridgePath, bridgeRoot, BRIDGE_REQUIRED_PATHS),
      ],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o644, flag: "wx" });
    return { manifest, manifestPath };
  } catch (error) {
    for (const path of [join(outputDirectory, sourceFile), join(outputDirectory, bridgeFile), manifestPath]) {
      await rm(path, { force: true });
    }
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function renameWithinStage(source: string, target: string): Promise<void> {
  const content = await readFile(source);
  await writeFile(target, content, { flag: "wx" });
  await rm(source, { force: true });
}

async function removeEmptyParents(start: string, stop: string): Promise<void> {
  let current = start;
  while (current !== stop) {
    const entries = await readdir(current);
    if (entries.length > 0) return;
    await rmdir(current);
    current = dirname(current);
  }
}

export function validateArchiveEntries(entries: string[], expectedRoot: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  if (entries.length > 20_000) {
    findings.push({ path: "(archive)", rule: "entry-limit", message: "归档条目超过 20000" });
  }
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/").replace(/\/$/, "");
    if (!normalized) continue;
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
      findings.push({ path: entry, rule: "archive-traversal", message: "归档包含绝对路径或目录穿越" });
      continue;
    }
    if (normalized !== expectedRoot && !normalized.startsWith(`${expectedRoot}/`)) {
      findings.push({ path: entry, rule: "archive-root", message: `归档条目不属于唯一根目录 ${expectedRoot}` });
    }
  }
  return findings;
}

export function validateArchiveTypes(lines: string[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const line of lines) {
    if (!line) continue;
    const type = line[0];
    if (type !== "-" && type !== "d") {
      findings.push({
        path: "(archive)",
        rule: "archive-entry-type",
        message: `归档包含不允许的条目类型 ${type ?? "unknown"}；只接受普通文件和目录`,
      });
    }
  }
  return findings;
}

async function walkExtracted(root: string, current = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const relativePath = relative(root, path).replaceAll("\\", "/");
    if (entry.isSymbolicLink()) throw new Error(`解包产物包含符号链接：${relativePath}`);
    if (entry.isDirectory()) files.push(...await walkExtracted(root, path));
    else if (entry.isFile()) files.push(relativePath);
    else throw new Error(`解包产物包含不支持的文件类型：${relativePath}`);
  }
  return files.sort();
}

export function parseReleaseManifest(value: unknown, path: string): ReleaseManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} 必须是 JSON object`);
  }
  const root = value as Record<string, unknown>;
  if (
    root.schemaVersion !== 1 ||
    root.package !== "livis-relay-daemon" ||
    typeof root.version !== "string" ||
    typeof root.generatedAt !== "string" ||
    (root.gitCommit !== null && (typeof root.gitCommit !== "string" || !/^[a-f0-9]{40}$/.test(root.gitCommit))) ||
    !["clean-git", "working-tree"].includes(String(root.sourceTree)) ||
    (root.sourceTree === "clean-git" && root.gitCommit === null) ||
    (root.sourceTree === "working-tree" && root.gitCommit !== null) ||
    !Array.isArray(root.artifacts) ||
    root.artifacts.length !== 2
  ) {
    throw new Error(`${path} 格式无效`);
  }
  return root as unknown as ReleaseManifest;
}

export async function loadReleaseManifest(manifestPathValue: string): Promise<ReleaseManifest> {
  const manifestPath = resolve(manifestPathValue);
  return parseReleaseManifest(JSON.parse(await readFile(manifestPath, "utf8")), manifestPath);
}

export async function auditReleaseArtifacts(manifestPathValue: string): Promise<ReleaseArtifactAuditReport> {
  const manifestPath = resolve(manifestPathValue);
  const manifest = await loadReleaseManifest(manifestPath);
  const findings: AuditFinding[] = [];
  const reports: ReleaseArtifactAuditReport["artifacts"] = [];
  const kinds = new Set<ReleaseArtifactKind>();
  for (const artifact of manifest.artifacts) {
    if (!(["source-tarball", "hermes-bridge-tarball"] as string[]).includes(artifact.kind)) {
      findings.push({ path: artifact.file, rule: "artifact-kind", message: `未知产物类型 ${artifact.kind}` });
      continue;
    }
    if (kinds.has(artifact.kind)) {
      findings.push({ path: artifact.file, rule: "artifact-kind", message: `重复产物类型 ${artifact.kind}` });
      continue;
    }
    kinds.add(artifact.kind);
    const expected = artifact.kind === "source-tarball"
      ? {
        file: `livis-relay-daemon-${manifest.version}.tar.gz`,
        root: `livis-relay-daemon-${manifest.version}`,
        requiredPaths: [...SOURCE_REQUIRED_PATHS],
      }
      : {
        file: `livis-hermes-bridge-${manifest.version}.tar.gz`,
        root: `livis-hermes-bridge-${manifest.version}`,
        requiredPaths: [...BRIDGE_REQUIRED_PATHS],
      };
    if (artifact.file !== expected.file || artifact.root !== expected.root) {
      findings.push({ path: artifact.file, rule: "artifact-identity", message: "产物文件名或唯一根目录与版本不一致" });
      continue;
    }
    if (
      !Array.isArray(artifact.requiredPaths) ||
      [...artifact.requiredPaths].sort().join("\0") !== expected.requiredPaths.sort().join("\0")
    ) {
      findings.push({ path: artifact.file, rule: "required-path-contract", message: "manifest 的必需路径集合与产物类型不一致" });
      continue;
    }
    if (
      typeof artifact.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.sizeBytes) ||
      artifact.sizeBytes <= 0
    ) {
      findings.push({ path: artifact.file, rule: "artifact-metadata", message: "产物大小或 SHA-256 格式无效" });
      continue;
    }
    if (basename(artifact.file) !== artifact.file) {
      findings.push({ path: artifact.file, rule: "artifact-path", message: "manifest 只允许同目录文件名" });
      continue;
    }
    const artifactPath = join(dirname(manifestPath), artifact.file);
    if (!await exists(artifactPath)) {
      findings.push({ path: artifact.file, rule: "artifact-missing", message: "发布产物不存在" });
      continue;
    }
    const content = await readFile(artifactPath);
    if (content.byteLength !== artifact.sizeBytes) {
      findings.push({ path: artifact.file, rule: "artifact-size", message: "发布产物大小与 manifest 不一致" });
    }
    if (sha256(content) !== artifact.sha256) {
      findings.push({ path: artifact.file, rule: "artifact-sha256", message: "发布产物 SHA-256 与 manifest 不一致" });
      continue;
    }
    const listing = await runCommand(["tar", "-tzf", artifactPath]);
    const entries = listing.split(/\r?\n/).filter(Boolean);
    const verboseListing = await runCommand(["tar", "-tvzf", artifactPath]);
    const findingCountBeforeEntries = findings.length;
    findings.push(...validateArchiveEntries(entries, artifact.root));
    findings.push(...validateArchiveTypes(verboseListing.split(/\r?\n/).filter(Boolean)));
    if (findings.length > findingCountBeforeEntries) continue;

    const extraction = await mkdtemp(join(tmpdir(), "livis-release-audit-"));
    try {
      await runCommand(["tar", "-xzf", artifactPath, "-C", extraction]);
      const rootPath = join(extraction, artifact.root);
      const rootStats = await lstat(rootPath);
      if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
        findings.push({ path: artifact.file, rule: "artifact-root", message: "解包后缺少普通根目录" });
        continue;
      }
      const files = await walkExtracted(rootPath);
      for (const required of expected.requiredPaths) {
        if (!files.includes(required)) {
          findings.push({ path: `${artifact.file}:${required}`, rule: "required-path", message: "发布产物缺少必需文件" });
        }
      }
      if (artifact.kind === "hermes-bridge-tarball") {
        const allowed = new Set(BRIDGE_REQUIRED_PATHS);
        for (const file of files) {
          if (!allowed.has(file as (typeof BRIDGE_REQUIRED_PATHS)[number])) {
            findings.push({ path: `${artifact.file}:${file}`, rule: "bridge-extra-path", message: "bridge 产物包含白名单外文件" });
          }
        }
      }
      const capabilityPath = join(rootPath, "capabilities.json");
      const capability = JSON.parse(await readFile(capabilityPath, "utf8")) as { package?: { version?: unknown } };
      if (capability.package?.version !== manifest.version) {
        findings.push({ path: `${artifact.file}:capabilities.json`, rule: "artifact-version", message: "能力契约版本与发布 manifest 不一致" });
      }
      const versionFile = artifact.kind === "source-tarball"
        ? join(rootPath, "package.json")
        : join(rootPath, "plugin.yaml");
      const versionText = await readFile(versionFile, "utf8");
      const packagedVersion = artifact.kind === "source-tarball"
        ? (JSON.parse(versionText) as { version?: unknown }).version
        : versionText.match(/^version:\s*([^\s]+)$/m)?.[1];
      if (packagedVersion !== manifest.version) {
        findings.push({ path: `${artifact.file}:${relative(rootPath, versionFile)}`, rule: "artifact-version", message: "包内版本与发布 manifest 不一致" });
      }
      let textFiles = 0;
      let binaryFiles = 0;
      for (const file of files) {
        const pathFindings = auditTrackedPath(file);
        findings.push(...pathFindings.map((item) => ({ ...item, path: `${artifact.file}:${item.path}` })));
        if (pathFindings.length > 0) continue;
        const bytes = await readFile(join(rootPath, file));
        if (bytes.includes(0)) {
          binaryFiles += 1;
          continue;
        }
        textFiles += 1;
        findings.push(...auditTrackedText(file, new TextDecoder().decode(bytes)).map((item) => ({
          ...item,
          path: `${artifact.file}:${item.path}`,
        })));
      }
      reports.push({ kind: artifact.kind, file: artifact.file, entries: entries.length, textFiles, binaryFiles });
    } finally {
      await rm(extraction, { recursive: true, force: true });
    }
  }
  for (const expected of ["source-tarball", "hermes-bridge-tarball"] as const) {
    if (!kinds.has(expected)) findings.push({ path: "release-manifest.json", rule: "artifact-kind", message: `缺少 ${expected}` });
  }
  return { manifestPath, artifacts: reports, findings };
}
