import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, platform as hostPlatform } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { loadRelayConfig } from "../config.ts";
import {
  auditReleaseArtifacts,
  loadReleaseManifest,
  type ReleaseArtifactRecord,
  type ReleaseManifest,
} from "../release/artifacts.ts";
import {
  durableAtomicWritePrivate,
  readPrivateFileText,
  readOptionalPrivateFileText,
  sha256,
} from "../util.ts";
import {
  DEPLOYMENT_SERVICE_MANAGERS,
  type DeploymentCommandRunner,
  type DeploymentOperation,
  type DeploymentPlan,
  type DeploymentPointer,
  type DeploymentReceipt,
  type DeploymentServiceController,
  type DeploymentServiceManager,
} from "./deployment-contract.ts";
import {
  createDeploymentServiceController,
  defaultServiceDefinitionPath,
  renderDeploymentServiceDefinition,
} from "./deployment-service.ts";
import {
  compensateHermesBridgeRollback,
  installHermesBridge,
  rollbackHermesBridge,
} from "./hermes.ts";

const CURRENT_POINTER_FILE = "current.json";
const RELEASE_METADATA_FILE = ".livis-release.json";
const DEPLOYMENT_LOCK_FILE = ".deployment.lock";

interface ReleaseMetadata {
  schemaVersion: 1;
  version: string;
  gitCommit: string;
  sourceArtifactSha256: string;
  releaseFilesSha256: string;
  installedTreeSha256: string;
}

export interface DeploymentPlanOptions {
  manifestPath: string;
  manifestSha256: string;
  configPath: string;
  installRoot: string;
  serviceManager: DeploymentServiceManager;
  manageService?: boolean;
  bunPath: string;
  hermesHome?: string;
  requestedOperation?: DeploymentOperation;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
}

export interface ApplyDeploymentOptions extends DeploymentPlanOptions {
  apply: boolean;
  acknowledgeDaemonStopped?: boolean;
  acknowledgeHermesStopped?: boolean;
  acknowledgeServiceRestart?: boolean;
  acknowledgeStateBackup?: boolean;
  serviceController?: DeploymentServiceController;
  commandRunner?: DeploymentCommandRunner;
  beforeCurrentCommit?: () => void | Promise<void>;
}

export interface RollbackDeploymentOptions {
  installRoot: string;
  receiptPath: string;
  apply: boolean;
  manageService?: boolean;
  acknowledgeDaemonStopped?: boolean;
  acknowledgeHermesStopped?: boolean;
  acknowledgeServiceRestart?: boolean;
  acknowledgeStateCompatibility?: boolean;
  serviceController?: DeploymentServiceController;
  transactionHooks?: {
    afterHermesRollback?: () => void | Promise<void>;
    afterServiceRollback?: () => void | Promise<void>;
    afterPointerCommit?: () => void | Promise<void>;
    beforeReceiptCommit?: () => void | Promise<void>;
  };
}

export interface UninstallDeploymentOptions {
  installRoot: string;
  apply: boolean;
  acknowledgeUninstall: boolean;
  manageService?: boolean;
  acknowledgeDaemonStopped?: boolean;
  acknowledgeServiceRestart?: boolean;
  serviceController?: DeploymentServiceController;
}

function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} 必须是小写 SHA-256`);
}

function assertStrictChild(parent: string, child: string, label: string): void {
  const value = relative(resolve(parent), resolve(child));
  if (!value || value === ".." || value.startsWith(`..${sep}`)) {
    throw new Error(`${label} 必须位于 ${resolve(parent)} 内：${resolve(child)}`);
  }
}

function pathsOverlap(first: string, second: string): boolean {
  const a = resolve(first);
  const b = resolve(second);
  const fromA = relative(a, b);
  const fromB = relative(b, a);
  return fromA === "" || (!fromA.startsWith(`..${sep}`) && fromA !== "..") ||
    (!fromB.startsWith(`..${sep}`) && fromB !== "..");
}

async function assertRegularSingleLink(path: string, label: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
    throw new Error(`${label} 必须是单 link 普通文件：${path}`);
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`部署目录必须是非符号链接目录：${path}`);
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(`部署目录不能向 group/other 开放：${path}`);
  }
  await chmod(path, 0o700);
}

async function canonicalTargetPath(pathValue: string): Promise<string> {
  const target = resolve(pathValue);
  if (await exists(target)) return realpath(target);
  const parent = dirname(target);
  if (parent === target) throw new Error(`无法解析目标路径：${target}`);
  return join(await canonicalTargetPath(parent), basename(target));
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function durableUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
    await syncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function parsePointer(text: string, path: string, installRoot: string): DeploymentPointer {
  const value = JSON.parse(text) as Partial<DeploymentPointer>;
  if (
    value.schemaVersion !== 1 ||
    typeof value.releasePath !== "string" ||
    typeof value.version !== "string" ||
    typeof value.gitCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.gitCommit) ||
    typeof value.sourceArtifactSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sourceArtifactSha256) ||
    !["hermes", "codex", "claude"].includes(String(value.backend)) ||
    typeof value.configPath !== "string" ||
    typeof value.receiptPath !== "string"
  ) {
    throw new Error(`部署指针格式无效：${path}`);
  }
  assertStrictChild(join(installRoot, "releases"), value.releasePath, "部署 releasePath");
  assertStrictChild(join(installRoot, "receipts"), value.receiptPath, "部署 receiptPath");
  return value as DeploymentPointer;
}

async function loadCurrentPointer(installRootValue: string): Promise<DeploymentPointer | null> {
  const installRoot = resolve(installRootValue);
  const path = join(installRoot, CURRENT_POINTER_FILE);
  const text = await readOptionalPrivateFileText(path, "当前部署指针");
  return text === null ? null : parsePointer(text, path, installRoot);
}

function parseReceipt(text: string, path: string, installRoot: string): DeploymentReceipt {
  const value = JSON.parse(text) as Partial<DeploymentReceipt>;
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "livis-relay-deployment" ||
    typeof value.operationId !== "string" ||
    !["install", "upgrade"].includes(String(value.operation)) ||
    !["prepared", "installed", "upgraded", "rolled-back", "uninstalled"].includes(String(value.status)) ||
    typeof value.receiptPath !== "string" ||
    value.credentialsReadOrMigrated !== false ||
    value.plan === undefined ||
    value.plan === null ||
    typeof value.plan !== "object" ||
    value.installedDeployment === undefined ||
    value.installedDeployment === null ||
    typeof value.installedDeployment !== "object"
  ) {
    throw new Error(`部署收据格式无效：${path}`);
  }
  if (resolve(value.receiptPath) !== resolve(path)) {
    throw new Error(`部署收据路径与内容不一致：${path}`);
  }
  assertStrictChild(join(installRoot, "receipts"), path, "部署收据");
  if (
    resolve(value.plan.installRoot) !== resolve(installRoot) ||
    value.plan.credentialsReadOrMigrated !== false ||
    value.plan.credentialHandling !== "native-state-unmanaged" ||
    value.installedDeployment.receiptPath !== value.receiptPath
  ) {
    throw new Error(`部署收据的路径或认证边界无效：${path}`);
  }
  assertStrictChild(join(installRoot, "releases"), value.plan.releasePath, "收据 releasePath");
  assertStrictChild(join(installRoot, "releases"), value.installedDeployment.releasePath, "收据部署 releasePath");
  return value as DeploymentReceipt;
}

async function loadDeploymentReceipt(pathValue: string, installRoot: string): Promise<DeploymentReceipt> {
  const path = resolve(pathValue);
  assertStrictChild(join(installRoot, "receipts"), path, "部署收据");
  return parseReceipt(await readPrivateFileText(path, "部署收据"), path, installRoot);
}

async function writeReceipt(receipt: DeploymentReceipt): Promise<void> {
  await durableAtomicWritePrivate(receipt.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const readback = await readPrivateFileText(receipt.receiptPath, "部署收据读回");
  const parsed = JSON.parse(readback) as { status?: unknown; operationId?: unknown };
  if (parsed.status !== receipt.status || parsed.operationId !== receipt.operationId) {
    throw new Error(`部署收据写入后读回不一致：${receipt.receiptPath}`);
  }
}

async function writePointer(path: string, pointer: DeploymentPointer): Promise<void> {
  await durableAtomicWritePrivate(path, `${JSON.stringify(pointer, null, 2)}\n`);
  const readback = parsePointer(await readPrivateFileText(path, "部署指针读回"), path, dirname(path));
  if (JSON.stringify(readback) !== JSON.stringify(pointer)) {
    throw new Error(`部署指针写入后读回不一致：${path}`);
  }
}

function sourceArtifact(manifest: ReleaseManifest): ReleaseArtifactRecord {
  const artifact = manifest.artifacts.find((item) => item.kind === "source-tarball");
  if (!artifact) throw new Error("release manifest 缺少源码归档");
  return artifact;
}

function bridgeArtifact(manifest: ReleaseManifest): ReleaseArtifactRecord {
  const artifact = manifest.artifacts.find((item) => item.kind === "hermes-bridge-tarball");
  if (!artifact) throw new Error("release manifest 缺少 Hermes bridge 归档");
  return artifact;
}

async function verifiedManifest(options: DeploymentPlanOptions): Promise<{
  path: string;
  manifest: ReleaseManifest;
}> {
  assertSha256(options.manifestSha256, "--manifest-sha256");
  const path = await realpath(resolve(options.manifestPath));
  await assertRegularSingleLink(path, "release manifest");
  const bytes = await readFile(path);
  if (sha256(bytes) !== options.manifestSha256) {
    throw new Error("release manifest SHA-256 与操作者固定值不一致");
  }
  const manifest = await loadReleaseManifest(path);
  if (manifest.sourceTree !== "clean-git" || manifest.gitCommit === null) {
    throw new Error("正式部署只接受 clean-git 且绑定完整 commit 的 release manifest");
  }
  for (const artifact of manifest.artifacts) {
    if (basename(artifact.file) !== artifact.file) {
      throw new Error(`release artifact 只允许同目录文件名：${artifact.file}`);
    }
    await assertRegularSingleLink(
      join(dirname(path), artifact.file),
      `release artifact ${artifact.file}`,
    );
  }
  const audit = await auditReleaseArtifacts(path);
  if (audit.findings.length > 0) {
    const first = audit.findings[0]!;
    throw new Error(`发布产物审计失败：${first.rule} ${first.path} ${first.message}`);
  }
  return { path, manifest };
}

async function canonicalExecutable(pathValue: string): Promise<string> {
  const canonical = await realpath(resolve(pathValue));
  const stats = await lstat(canonical);
  if (!stats.isFile() || (stats.mode & 0o111) === 0) {
    throw new Error(`Bun runtime 必须是可执行普通文件：${canonical}`);
  }
  return canonical;
}

function expectedManagerForPlatform(platform: NodeJS.Platform): DeploymentServiceManager {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  return "none";
}

export async function planDeployment(options: DeploymentPlanOptions): Promise<DeploymentPlan> {
  if (!(DEPLOYMENT_SERVICE_MANAGERS as readonly string[]).includes(options.serviceManager)) {
    throw new Error("--service-manager 只支持 launchd、systemd 或 none");
  }
  const platform = options.platform ?? hostPlatform();
  const expectedManager = expectedManagerForPlatform(platform);
  if (options.serviceManager !== "none" && options.serviceManager !== expectedManager) {
    throw new Error(`${platform} 只允许 ${expectedManager} 或 none 服务模式`);
  }
  const installRoot = await canonicalTargetPath(options.installRoot);
  const homeDirectory = await realpath(resolve(options.homeDirectory ?? homedir()));
  const bunPath = await canonicalExecutable(options.bunPath);
  const { manifest } = await verifiedManifest(options);
  const loaded = await loadRelayConfig(resolve(options.configPath));
  const configPath = await realpath(loaded.path);
  const stateDir = await realpath(loaded.config.stateDir);
  if (pathsOverlap(installRoot, stateDir)) {
    throw new Error("installRoot 与 stateDir 必须完全分离，不能互相包含");
  }
  const current = await loadCurrentPointer(installRoot);
  if (current) await loadVerifiedCurrentReceipt(current, installRoot);
  const operation: DeploymentOperation = current === null ? "install" : "upgrade";
  if (options.requestedOperation && options.requestedOperation !== operation) {
    throw new Error(operation === "install"
      ? "当前没有活动部署，只能执行 install"
      : "当前已有活动部署，只能执行 upgrade");
  }
  const source = sourceArtifact(manifest);
  const bridge = bridgeArtifact(manifest);
  if (current?.sourceArtifactSha256 === source.sha256) {
    throw new Error("目标源码归档与当前部署完全相同，拒绝无变化 upgrade");
  }
  const releasePath = join(installRoot, "releases", `${manifest.version}-${manifest.gitCommit!.slice(0, 12)}`);
  let hermesHome: string | null = null;
  if (loaded.config.execution.backend === "hermes") {
    if (!options.hermesHome) throw new Error("Hermes backend 部署必须显式传入 --hermes-home");
    hermesHome = await realpath(resolve(options.hermesHome));
    const stats = await lstat(hermesHome);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`HERMES_HOME 必须是非符号链接目录：${hermesHome}`);
    }
  } else if (options.hermesHome) {
    throw new Error(`${loaded.config.execution.backend} backend 不接受 --hermes-home`);
  }
  const definitionPath = defaultServiceDefinitionPath(options.serviceManager, homeDirectory);
  const nativeHomeAccess =
    (loaded.config.execution.backend === "codex" && loaded.config.codex.mode === "native-current") ||
    (loaded.config.execution.backend === "claude" && loaded.config.claude.mode === "native-current");
  const definitionText = options.serviceManager === "none" ? null : renderDeploymentServiceDefinition({
    manager: options.serviceManager,
    bunPath,
    releasePath,
    configPath,
    stateDir,
    homeDirectory,
    backend: loaded.config.execution.backend,
    nativeHomeAccess,
  });
  const manageService = options.manageService ?? false;
  if (manageService && options.serviceManager === "none") {
    throw new Error("service-manager=none 时不能启用 --manage-service");
  }
  return {
    schemaVersion: 1,
    operation,
    backend: loaded.config.execution.backend,
    installRoot,
    releasePath,
    configPath,
    stateDir,
    bunPath,
    artifacts: {
      manifestSha256: options.manifestSha256,
      sourceArtifactSha256: source.sha256,
      bridgeArtifactSha256: bridge.sha256,
      version: manifest.version,
      gitCommit: manifest.gitCommit!,
    },
    service: {
      manager: options.serviceManager,
      definitionPath,
      definitionSha256: definitionText === null ? null : sha256(definitionText),
      manageService,
      stopRequired: operation === "upgrade",
      reloadRequired: manageService,
      startRequired: manageService,
      nativeHomeAccess,
      explicitAcknowledgementRequired: options.serviceManager !== "none",
    },
    hermesHome,
    credentialHandling: "native-state-unmanaged",
    credentialsReadOrMigrated: false,
  };
}

async function copyBundleFile(source: string, target: string, label: string): Promise<void> {
  await assertRegularSingleLink(source, label);
  await copyFile(source, target, constants.COPYFILE_EXCL);
  await chmod(target, 0o600);
  const handle = await open(target, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function snapshotReleaseBundle(
  options: DeploymentPlanOptions,
  receiptRoot: string,
): Promise<{ manifest: ReleaseManifest; manifestPath: string }> {
  const original = await verifiedManifest(options);
  const bundleRoot = join(receiptRoot, "release-bundle");
  await ensurePrivateDirectory(bundleRoot);
  const manifestPath = join(bundleRoot, "release-manifest.json");
  await copyBundleFile(original.path, manifestPath, "release manifest");
  for (const artifact of original.manifest.artifacts) {
    await copyBundleFile(
      join(dirname(original.path), artifact.file),
      join(bundleRoot, artifact.file),
      `release artifact ${artifact.file}`,
    );
  }
  if (sha256(await readFile(manifestPath)) !== options.manifestSha256) {
    throw new Error("私有发布快照的 manifest SHA-256 读回不一致");
  }
  const report = await auditReleaseArtifacts(manifestPath);
  if (report.findings.length > 0) {
    const first = report.findings[0]!;
    throw new Error(`私有发布快照审计失败：${first.rule} ${first.path} ${first.message}`);
  }
  return { manifest: original.manifest, manifestPath };
}

async function runRaw(command: readonly string[], cwd?: string): Promise<void> {
  const child = Bun.spawn([...command], {
    cwd,
    env: {},
    stdin: "ignore",
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
}

async function releaseFilesDigest(root: string, current = root): Promise<string> {
  const parts: Uint8Array[] = [];
  const encoder = new TextEncoder();
  for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (current === root && (entry.name === "node_modules" || entry.name === RELEASE_METADATA_FILE)) continue;
    const path = join(current, entry.name);
    const relativePath = relative(root, path).replaceAll("\\", "/");
    if (entry.isSymbolicLink()) throw new Error(`部署 release 包含符号链接：${relativePath}`);
    if (entry.isDirectory()) {
      parts.push(encoder.encode(`d\0${relativePath}\0`));
      parts.push(encoder.encode(await releaseFilesDigest(root, path)));
    } else if (entry.isFile()) {
      const stats = await lstat(path);
      if (stats.nlink !== 1) throw new Error(`部署 release 包含多 link 文件：${relativePath}`);
      parts.push(encoder.encode(`f\0${relativePath}\0`), await readFile(path), encoder.encode("\0"));
    } else {
      throw new Error(`部署 release 包含不支持的文件类型：${relativePath}`);
    }
  }
  const total = parts.reduce((sum, value) => sum + value.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return sha256(bytes);
}

function parseReleaseMetadata(text: string, path: string): ReleaseMetadata {
  const value = JSON.parse(text) as Partial<ReleaseMetadata>;
  if (
    value.schemaVersion !== 1 ||
    typeof value.version !== "string" ||
    typeof value.gitCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.gitCommit) ||
    typeof value.sourceArtifactSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sourceArtifactSha256) ||
    typeof value.releaseFilesSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.releaseFilesSha256) ||
    typeof value.installedTreeSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.installedTreeSha256)
  ) {
    throw new Error(`部署 release 元数据无效：${path}`);
  }
  return value as ReleaseMetadata;
}

async function installedTreeDigest(root: string, current = root): Promise<string> {
  const parts: Uint8Array[] = [];
  const encoder = new TextEncoder();
  for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (current === root && entry.name === RELEASE_METADATA_FILE) continue;
    const path = join(current, entry.name);
    const relativePath = relative(root, path).replaceAll("\\", "/");
    if (entry.isSymbolicLink()) {
      const target = await readlink(path);
      const resolvedTarget = resolve(dirname(path), target);
      assertStrictChild(root, resolvedTarget, `部署依赖符号链接 ${relativePath}`);
      parts.push(encoder.encode(`l\0${relativePath}\0${target}\0`));
    } else if (entry.isDirectory()) {
      parts.push(encoder.encode(`d\0${relativePath}\0`));
      parts.push(encoder.encode(await installedTreeDigest(root, path)));
    } else if (entry.isFile()) {
      const stats = await lstat(path);
      if (stats.nlink !== 1) throw new Error(`部署 release 包含多 link 文件：${relativePath}`);
      parts.push(encoder.encode(`f\0${relativePath}\0`), await readFile(path), encoder.encode("\0"));
    } else {
      throw new Error(`部署 release 包含不支持的文件类型：${relativePath}`);
    }
  }
  const total = parts.reduce((sum, value) => sum + value.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return sha256(bytes);
}

async function verifyInstalledRelease(path: string, plan: DeploymentPlan): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`部署 release 必须是非符号链接目录：${path}`);
  }
  const metadataPath = join(path, RELEASE_METADATA_FILE);
  const metadata = parseReleaseMetadata(
    await readPrivateFileText(metadataPath, "部署 release 元数据"),
    metadataPath,
  );
  if (
    metadata.version !== plan.artifacts.version ||
    metadata.gitCommit !== plan.artifacts.gitCommit ||
    metadata.sourceArtifactSha256 !== plan.artifacts.sourceArtifactSha256
  ) {
    throw new Error(`既有部署 release 身份与计划不一致：${path}`);
  }
  if (await releaseFilesDigest(path) !== metadata.releaseFilesSha256) {
    throw new Error(`部署 release 文件在安装后发生变化：${path}`);
  }
  const modules = await lstat(join(path, "node_modules"));
  if (modules.isSymbolicLink() || !modules.isDirectory()) {
    throw new Error(`部署 release 缺少普通 node_modules 目录：${path}`);
  }
  if (await installedTreeDigest(path) !== metadata.installedTreeSha256) {
    throw new Error(`部署 release 或依赖在安装后发生变化：${path}`);
  }
}

class IsolatedBunCommandRunner implements DeploymentCommandRunner {
  constructor(private readonly home: string, private readonly bunPath: string) {}

  async run(command: readonly string[], options: { cwd?: string }): Promise<void> {
    const child = Bun.spawn([...command], {
      cwd: options.cwd,
      env: {
        HOME: this.home,
        PATH: `${dirname(this.bunPath)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
        LANG: "C.UTF-8",
        BUN_INSTALL_CACHE_DIR: join(this.home, "bun-cache"),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`${basename(command[0] ?? "command")} 执行失败（exit ${exitCode}）：${stderr.trim() || stdout.trim()}`);
    }
  }
}

async function prepareRelease(options: {
  plan: DeploymentPlan;
  snapshotManifestPath: string;
  receiptRoot: string;
  commandRunner: DeploymentCommandRunner;
}): Promise<void> {
  if (await exists(options.plan.releasePath)) {
    await verifyInstalledRelease(options.plan.releasePath, options.plan);
    return;
  }
  const releasesRoot = dirname(options.plan.releasePath);
  const extractionRoot = join(releasesRoot, `.extract-${crypto.randomUUID()}`);
  await ensurePrivateDirectory(extractionRoot);
  try {
    const manifest = await loadReleaseManifest(options.snapshotManifestPath);
    const artifact = sourceArtifact(manifest);
    await runRaw([
      "tar",
      "-xzf",
      join(dirname(options.snapshotManifestPath), artifact.file),
      "-C",
      extractionRoot,
    ]);
    const sourceRoot = join(extractionRoot, artifact.root);
    const sourceStats = await lstat(sourceRoot);
    if (sourceStats.isSymbolicLink() || !sourceStats.isDirectory()) {
      throw new Error("源码归档解包后缺少普通唯一根目录");
    }
    if (await exists(join(sourceRoot, RELEASE_METADATA_FILE))) {
      throw new Error(`源码归档不得预置 ${RELEASE_METADATA_FILE}`);
    }
    if (await exists(join(sourceRoot, "node_modules"))) {
      throw new Error("源码归档不得预置 node_modules");
    }
    const before = await releaseFilesDigest(sourceRoot);
    await options.commandRunner.run(
      [
        options.plan.bunPath,
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--backend=copyfile",
      ],
      { cwd: sourceRoot },
    );
    await options.commandRunner.run([options.plan.bunPath, "run", "version:check"], { cwd: sourceRoot });
    await options.commandRunner.run([options.plan.bunPath, "run", "capabilities:check"], { cwd: sourceRoot });
    const after = await releaseFilesDigest(sourceRoot);
    if (after !== before) throw new Error("依赖安装或部署自检改写了发布文件，拒绝提交 release");
    const metadata: ReleaseMetadata = {
      schemaVersion: 1,
      version: options.plan.artifacts.version,
      gitCommit: options.plan.artifacts.gitCommit,
      sourceArtifactSha256: options.plan.artifacts.sourceArtifactSha256,
      releaseFilesSha256: after,
      installedTreeSha256: await installedTreeDigest(sourceRoot),
    };
    await durableAtomicWritePrivate(
      join(sourceRoot, RELEASE_METADATA_FILE),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    await rename(sourceRoot, options.plan.releasePath);
    await syncDirectory(releasesRoot);
    await verifyInstalledRelease(options.plan.releasePath, options.plan);
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}

async function extractBridge(snapshotManifestPath: string, receiptRoot: string): Promise<string> {
  const manifest = await loadReleaseManifest(snapshotManifestPath);
  const artifact = bridgeArtifact(manifest);
  const extractionRoot = join(receiptRoot, "bridge-extracted");
  await ensurePrivateDirectory(extractionRoot);
  await runRaw([
    "tar",
    "-xzf",
    join(dirname(snapshotManifestPath), artifact.file),
    "-C",
    extractionRoot,
  ]);
  const bridgeRoot = join(extractionRoot, artifact.root);
  const stats = await lstat(bridgeRoot);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Hermes bridge 归档解包后缺少普通唯一根目录");
  }
  return bridgeRoot;
}

async function controllerForPlan(
  plan: DeploymentPlan,
  injected?: DeploymentServiceController,
): Promise<DeploymentServiceController | null> {
  if (plan.service.manager === "none") return null;
  if (!plan.service.definitionPath) throw new Error("部署计划缺少服务定义路径");
  const controller = injected ?? createDeploymentServiceController({
    manager: plan.service.manager,
    definitionPath: plan.service.definitionPath,
  });
  if (
    controller.manager !== plan.service.manager ||
    resolve(controller.definitionPath) !== resolve(plan.service.definitionPath)
  ) {
    throw new Error("注入的服务控制器与部署计划不一致");
  }
  return controller;
}

function serviceDefinitionForPlan(plan: DeploymentPlan, homeDirectory: string): string | null {
  if (plan.service.manager === "none") return null;
  return renderDeploymentServiceDefinition({
    manager: plan.service.manager,
    bunPath: plan.bunPath,
    releasePath: plan.releasePath,
    configPath: plan.configPath,
    stateDir: plan.stateDir,
    homeDirectory,
    backend: plan.backend,
    nativeHomeAccess: plan.service.nativeHomeAccess,
  });
}

async function withDeploymentLock<T>(installRoot: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = join(installRoot, DEPLOYMENT_LOCK_FILE);
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`发现部署锁 ${lockPath}；确认没有其他部署进程后再人工处理`);
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    await handle.sync();
    return await operation();
  } finally {
    await handle.close();
    await durableUnlink(lockPath);
  }
}

function assertApplyAcknowledgements(options: ApplyDeploymentOptions, plan: DeploymentPlan): void {
  if (!options.apply) throw new Error(`${plan.operation} 是写操作，必须显式传入 --apply`);
  if (plan.service.manageService) {
    if (!options.acknowledgeServiceRestart) {
      throw new Error("安装器管理服务需要 --acknowledge-service-restart");
    }
  } else if (plan.service.manager !== "none" && !options.acknowledgeDaemonStopped) {
    throw new Error("不由安装器管理服务时必须确认 daemon 已停止：--acknowledge-daemon-stopped");
  }
  if (plan.backend === "hermes" && !options.acknowledgeHermesStopped) {
    throw new Error("Hermes bridge 变更前必须确认专用 Gateway 已停止：--acknowledge-hermes-stopped");
  }
  if (plan.operation === "upgrade" && !options.acknowledgeStateBackup) {
    throw new Error("upgrade 不复制 stateDir；必须先完成外部备份并传入 --acknowledge-state-backup");
  }
}

async function restoreService(options: {
  controller: DeploymentServiceController | null;
  previousDefinition: string | null;
  previousActive: boolean;
  manageService: boolean;
}): Promise<void> {
  if (!options.controller) return;
  if (options.manageService) await options.controller.stop();
  if (options.previousDefinition === null) await options.controller.removeDefinition();
  else await options.controller.writeDefinition(options.previousDefinition);
  if (options.manageService) {
    await options.controller.reload();
    if (options.previousActive && options.previousDefinition !== null) await options.controller.start();
  }
}

async function loadVerifiedCurrentReceipt(
  pointer: DeploymentPointer,
  installRoot: string,
): Promise<DeploymentReceipt> {
  const receipt = await loadDeploymentReceipt(pointer.receiptPath, installRoot);
  if (!["installed", "upgraded"].includes(receipt.status)) {
    throw new Error(`当前部署收据不是活动终态：${receipt.status}`);
  }
  assertPointerMatchesReceipt(pointer, receipt);
  await verifyInstalledRelease(pointer.releasePath, receipt.plan);
  return receipt;
}

function assertCurrentServiceDefinition(
  receipt: DeploymentReceipt,
  definitionText: string | null,
): void {
  const expected = receipt.plan.service.definitionSha256;
  const actual = definitionText === null ? null : sha256(definitionText);
  if (actual !== expected) {
    throw new Error("当前服务定义已在部署后发生变化，拒绝覆盖或删除");
  }
}

export async function applyDeployment(options: ApplyDeploymentOptions): Promise<DeploymentReceipt> {
  const plan = await planDeployment(options);
  assertApplyAcknowledgements(options, plan);
  await ensurePrivateDirectory(plan.installRoot);
  await ensurePrivateDirectory(join(plan.installRoot, "releases"));
  await ensurePrivateDirectory(join(plan.installRoot, "receipts"));
  return withDeploymentLock(plan.installRoot, async () => {
    const current = await loadCurrentPointer(plan.installRoot);
    if ((plan.operation === "install") !== (current === null)) {
      throw new Error("部署状态在 plan 后发生变化，拒绝继续");
    }
    if (current && current.sourceArtifactSha256 === plan.artifacts.sourceArtifactSha256) {
      throw new Error("目标源码归档与当前部署完全相同");
    }
    const currentReceipt = current === null
      ? null
      : await loadVerifiedCurrentReceipt(current, plan.installRoot);
    if (
      currentReceipt &&
      (currentReceipt.plan.service.manager !== plan.service.manager ||
        currentReceipt.plan.service.definitionPath !== plan.service.definitionPath)
    ) {
      throw new Error("upgrade 不支持同时迁移 service manager 或服务定义路径");
    }
    const controller = await controllerForPlan(plan, options.serviceController);
    const serviceBefore = controller === null
      ? { installed: false, active: false, definitionText: null }
      : await controller.inspect();
    if (!plan.service.manageService && serviceBefore.active) {
      throw new Error("精确 daemon 服务仍处于加载/活动状态，拒绝仅凭确认参数覆盖");
    }
    if (currentReceipt) assertCurrentServiceDefinition(currentReceipt, serviceBefore.definitionText);
    const operationId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
    const receiptRoot = join(plan.installRoot, "receipts", operationId);
    await ensurePrivateDirectory(receiptRoot);
    const snapshot = await snapshotReleaseBundle(options, receiptRoot);
    if (
      sourceArtifact(snapshot.manifest).sha256 !== plan.artifacts.sourceArtifactSha256 ||
      bridgeArtifact(snapshot.manifest).sha256 !== plan.artifacts.bridgeArtifactSha256
    ) {
      throw new Error("发布输入在 plan 与私有快照之间发生变化");
    }
    const receiptPath = join(receiptRoot, "receipt.json");
    const installedDeployment: DeploymentPointer = {
      schemaVersion: 1,
      releasePath: plan.releasePath,
      version: plan.artifacts.version,
      gitCommit: plan.artifacts.gitCommit,
      sourceArtifactSha256: plan.artifacts.sourceArtifactSha256,
      backend: plan.backend,
      configPath: plan.configPath,
      receiptPath,
    };
    let serviceBackupPath: string | null = null;
    if (serviceBefore.definitionText !== null) {
      serviceBackupPath = join(receiptRoot, "service.before");
      await durableAtomicWritePrivate(serviceBackupPath, serviceBefore.definitionText);
    }
    let receipt: DeploymentReceipt = {
      schemaVersion: 1,
      kind: "livis-relay-deployment",
      operationId,
      operation: plan.operation,
      status: "prepared",
      createdAt: new Date().toISOString(),
      completedAt: null,
      plan,
      previousDeployment: current,
      installedDeployment,
      previousServiceDefinitionSha256: serviceBefore.definitionText === null
        ? null
        : sha256(serviceBefore.definitionText),
      previousServiceDefinitionBackupPath: serviceBackupPath,
      previousServiceActive: serviceBefore.active,
      hermesInstallReceiptPath: null,
      serviceRestartPerformed: false,
      credentialsReadOrMigrated: false,
      receiptPath,
    };
    await writeReceipt(receipt);

    const isolatedHome = join(receiptRoot, "installer-home");
    await ensurePrivateDirectory(isolatedHome);
    const commandRunner = options.commandRunner ?? new IsolatedBunCommandRunner(isolatedHome, plan.bunPath);
    let hermesReceiptPath: string | null = null;
    let serviceTouched = false;
    let pointerCommitted = false;
    try {
      await prepareRelease({
        plan,
        snapshotManifestPath: snapshot.manifestPath,
        receiptRoot,
        commandRunner,
      });
      if (plan.backend === "hermes") {
        const bridgeRoot = await extractBridge(snapshot.manifestPath, receiptRoot);
        const hermesReceipt = await installHermesBridge({
          hermesHome: plan.hermesHome!,
          sourceDirectory: bridgeRoot,
        });
        hermesReceiptPath = hermesReceipt.receiptPath;
        receipt = { ...receipt, hermesInstallReceiptPath: hermesReceiptPath };
        await writeReceipt(receipt);
      }
      const homeDirectory = await realpath(resolve(options.homeDirectory ?? homedir()));
      const definition = serviceDefinitionForPlan(plan, homeDirectory);
      if (definition !== null && sha256(definition) !== plan.service.definitionSha256) {
        throw new Error("服务定义在 plan 与 apply 之间发生变化");
      }
      if (controller && plan.service.manageService && serviceBefore.active) {
        await controller.stop();
        serviceTouched = true;
      }
      if (controller && definition !== null) {
        serviceTouched = true;
        await controller.writeDefinition(definition);
        const serviceReadback = await controller.inspect();
        if (serviceReadback.definitionText !== definition) throw new Error("服务定义写入后读回不一致");
      }
      if (controller && plan.service.manageService) {
        await controller.reload();
        await controller.start();
      }
      await options.beforeCurrentCommit?.();
      await writePointer(join(plan.installRoot, CURRENT_POINTER_FILE), installedDeployment);
      pointerCommitted = true;
      receipt = {
        ...receipt,
        status: plan.operation === "install" ? "installed" : "upgraded",
        completedAt: new Date().toISOString(),
        serviceRestartPerformed: plan.service.manageService,
      };
      await writeReceipt(receipt);
      return receipt;
    } catch (error) {
      const compensationErrors: unknown[] = [];
      if (pointerCommitted) {
        try {
          if (current) await writePointer(join(plan.installRoot, CURRENT_POINTER_FILE), current);
          else await durableUnlink(join(plan.installRoot, CURRENT_POINTER_FILE));
        } catch (compensationError) {
          compensationErrors.push(compensationError);
        }
      }
      if (serviceTouched) {
        try {
          await restoreService({
            controller,
            previousDefinition: serviceBefore.definitionText,
            previousActive: serviceBefore.active,
            manageService: plan.service.manageService,
          });
        } catch (compensationError) {
          compensationErrors.push(compensationError);
        }
      }
      if (hermesReceiptPath && plan.hermesHome) {
        try {
          await rollbackHermesBridge({
            hermesHome: plan.hermesHome,
            receiptPath: hermesReceiptPath,
            acknowledgeRollback: true,
          });
        } catch (compensationError) {
          compensationErrors.push(compensationError);
        }
      }
      if (compensationErrors.length > 0) {
        throw new AggregateError([error, ...compensationErrors], "部署失败且补偿未完整完成；保留 prepared 收据人工恢复");
      }
      throw error;
    } finally {
      await rm(isolatedHome, { recursive: true, force: true });
      await rm(join(receiptRoot, "bridge-extracted"), { recursive: true, force: true });
    }
  });
}

async function readServiceBackup(receipt: DeploymentReceipt): Promise<string | null> {
  if (receipt.previousServiceDefinitionBackupPath === null) return null;
  const path = resolve(receipt.previousServiceDefinitionBackupPath);
  assertStrictChild(dirname(receipt.receiptPath), path, "服务定义备份");
  const text = await readPrivateFileText(path, "服务定义备份");
  if (sha256(text) !== receipt.previousServiceDefinitionSha256) {
    throw new Error("服务定义备份 SHA-256 不一致");
  }
  return text;
}

function assertPointerMatchesReceipt(pointer: DeploymentPointer, receipt: DeploymentReceipt): void {
  if (JSON.stringify(pointer) !== JSON.stringify(receipt.installedDeployment)) {
    throw new Error("当前部署指针与指定收据不一致");
  }
}

function assertLifecycleAcknowledgements(options: {
  manageService?: boolean;
  acknowledgeDaemonStopped?: boolean;
  acknowledgeServiceRestart?: boolean;
}, manager: DeploymentServiceManager): void {
  if (options.manageService) {
    if (!options.acknowledgeServiceRestart) {
      throw new Error("安装器管理服务需要 --acknowledge-service-restart");
    }
  } else if (manager !== "none" && !options.acknowledgeDaemonStopped) {
    throw new Error("不由安装器管理服务时必须传入 --acknowledge-daemon-stopped");
  }
}

export async function rollbackDeployment(options: RollbackDeploymentOptions): Promise<DeploymentReceipt> {
  if (!options.apply) throw new Error("rollback 是写操作，必须显式传入 --apply");
  if (!options.acknowledgeStateCompatibility) {
    throw new Error("代码回滚不回滚 stateDir；必须确认旧版本兼容当前 state：--acknowledge-state-compatibility");
  }
  const installRoot = await canonicalTargetPath(options.installRoot);
  const receipt = await loadDeploymentReceipt(options.receiptPath, installRoot);
  if (!["installed", "upgraded"].includes(receipt.status)) {
    throw new Error(`只有 installed/upgraded 收据可以回滚，当前为 ${receipt.status}`);
  }
  assertLifecycleAcknowledgements(options, receipt.plan.service.manager);
  if (receipt.plan.backend === "hermes" && !options.acknowledgeHermesStopped) {
    throw new Error("Hermes 回滚前必须传入 --acknowledge-hermes-stopped");
  }
  return withDeploymentLock(installRoot, async () => {
    const pointer = await loadCurrentPointer(installRoot);
    if (!pointer) throw new Error("当前没有活动部署");
    assertPointerMatchesReceipt(pointer, receipt);
    await verifyInstalledRelease(receipt.plan.releasePath, receipt.plan);
    const controller = await controllerForPlan(receipt.plan, options.serviceController);
    const serviceState = controller === null
      ? { installed: false, active: false, definitionText: null }
      : await controller.inspect();
    if (!options.manageService && serviceState.active) {
      throw new Error("精确 daemon 服务仍处于加载/活动状态，拒绝回滚");
    }
    assertCurrentServiceDefinition(receipt, serviceState.definitionText);
    const previousDefinition = await readServiceBackup(receipt);
    const pointerPath = join(installRoot, CURRENT_POINTER_FILE);
    const updated: DeploymentReceipt = {
      ...receipt,
      status: "rolled-back",
      rolledBackAt: new Date().toISOString(),
      serviceRestartPerformed: Boolean(options.manageService),
    };
    let serviceTouched = false;
    let hermesRollbackCommitted = false;
    let pointerTouched = false;
    let receiptTouched = false;
    try {
      if (controller && options.manageService && serviceState.active) {
        serviceTouched = true;
        await controller.stop();
      }
      if (receipt.hermesInstallReceiptPath && receipt.plan.hermesHome) {
        await rollbackHermesBridge({
          hermesHome: receipt.plan.hermesHome,
          receiptPath: receipt.hermesInstallReceiptPath,
          acknowledgeRollback: true,
        });
        hermesRollbackCommitted = true;
        await options.transactionHooks?.afterHermesRollback?.();
      }
      if (controller) {
        serviceTouched = true;
        if (previousDefinition === null) await controller.removeDefinition();
        else await controller.writeDefinition(previousDefinition);
        if (options.manageService) {
          await controller.reload();
          if (receipt.previousServiceActive && previousDefinition !== null) await controller.start();
        }
      }
      await options.transactionHooks?.afterServiceRollback?.();
      pointerTouched = true;
      if (receipt.previousDeployment) await writePointer(pointerPath, receipt.previousDeployment);
      else await durableUnlink(pointerPath);
      await options.transactionHooks?.afterPointerCommit?.();
      receiptTouched = true;
      await options.transactionHooks?.beforeReceiptCommit?.();
      await writeReceipt(updated);
      return updated;
    } catch (error) {
      const compensationErrors: unknown[] = [];
      const rollbackCompensationIncomplete = error instanceof AggregateError;
      if (receiptTouched) {
        try {
          await writeReceipt(receipt);
        } catch (compensationError) {
          compensationErrors.push(compensationError);
        }
      }
      if (pointerTouched) {
        try {
          await writePointer(pointerPath, pointer);
        } catch (compensationError) {
          compensationErrors.push(compensationError);
        }
      }
      if (hermesRollbackCommitted && receipt.hermesInstallReceiptPath && receipt.plan.hermesHome) {
        try {
          await compensateHermesBridgeRollback({
            hermesHome: receipt.plan.hermesHome,
            receiptPath: receipt.hermesInstallReceiptPath,
            acknowledgeCompensation: true,
          });
        } catch (compensationError) {
          compensationErrors.push(compensationError);
        }
      }
      if (serviceTouched) {
        try {
          await restoreService({
            controller,
            previousDefinition: serviceState.definitionText,
            previousActive: serviceState.active,
            manageService: Boolean(options.manageService),
          });
        } catch (compensationError) {
          compensationErrors.push(compensationError);
        }
      }
      if (rollbackCompensationIncomplete || compensationErrors.length > 0) {
        throw new AggregateError(
          [error, ...compensationErrors],
          `部署回滚失败且补偿未完整完成；保留部署收据人工恢复：${receipt.receiptPath}`,
        );
      }
      throw new Error(`部署回滚失败，已精确恢复操作前状态：${String(error)}`, { cause: error });
    }
  });
}

export async function uninstallDeployment(options: UninstallDeploymentOptions): Promise<DeploymentReceipt> {
  if (!options.apply) throw new Error("uninstall 是写操作，必须显式传入 --apply");
  if (!options.acknowledgeUninstall) {
    throw new Error("uninstall 必须显式传入 --acknowledge-uninstall");
  }
  const installRoot = await canonicalTargetPath(options.installRoot);
  const pointer = await loadCurrentPointer(installRoot);
  if (!pointer) throw new Error("当前没有活动部署");
  const receipt = await loadDeploymentReceipt(pointer.receiptPath, installRoot);
  assertPointerMatchesReceipt(pointer, receipt);
  await verifyInstalledRelease(pointer.releasePath, receipt.plan);
  assertLifecycleAcknowledgements(options, receipt.plan.service.manager);
  return withDeploymentLock(installRoot, async () => {
    const current = await loadCurrentPointer(installRoot);
    if (!current) throw new Error("当前部署在 uninstall 前消失");
    assertPointerMatchesReceipt(current, receipt);
    const controller = await controllerForPlan(receipt.plan, options.serviceController);
    const serviceState = controller === null
      ? { installed: false, active: false, definitionText: null }
      : await controller.inspect();
    if (!options.manageService && serviceState.active) {
      throw new Error("精确 daemon 服务仍处于加载/活动状态，拒绝卸载");
    }
    assertCurrentServiceDefinition(receipt, serviceState.definitionText);
    if (controller && options.manageService && serviceState.active) await controller.stop();
    if (controller) {
      await controller.removeDefinition();
      if (options.manageService) await controller.reload();
    }
    await durableUnlink(join(installRoot, CURRENT_POINTER_FILE));
    const updated: DeploymentReceipt = {
      ...receipt,
      status: "uninstalled",
      uninstalledAt: new Date().toISOString(),
      serviceRestartPerformed: Boolean(options.manageService),
    };
    await writeReceipt(updated);
    return updated;
  });
}
