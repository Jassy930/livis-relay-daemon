import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import { parseJsonObject, sha256 } from "../util.ts";

export const HERMES_BRIDGE_NAME = "livis-bridge";
export const HERMES_BRIDGE_FILES = ["plugin.yaml", "__init__.py", "adapter.py"] as const;

export interface HermesInstallReceipt {
  schemaVersion: 1;
  status: "prepared" | "installed" | "rolled-back";
  hermesHome: string;
  pluginName: typeof HERMES_BRIDGE_NAME;
  pluginVersion: string;
  installedAt: string;
  installedDigest: string;
  priorPluginPresent: boolean;
  backupPluginPath: string | null;
  backupConfigPath: string;
  configBeforeSha256: string;
  configAfterSha256: string;
  receiptPath: string;
  rolledBackAt?: string;
  preRollbackBackupPath?: string;
}

export interface InstallHermesBridgeOptions {
  hermesHome: string;
  sourceDirectory?: string;
  beforeConfigCommit?: () => void | Promise<void>;
}

export interface RollbackHermesBridgeOptions {
  hermesHome: string;
  receiptPath: string;
  acknowledgeRollback: boolean;
  beforeReceiptCommit?: () => void | Promise<void>;
}

export interface CompensateHermesBridgeRollbackOptions {
  hermesHome: string;
  receiptPath: string;
  acknowledgeCompensation: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} 必须是非符号链接目录：${path}`);
  }
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} 必须是普通文件：${path}`);
  }
}

function assertContained(parent: string, child: string, label: string): void {
  const value = relative(resolve(parent), resolve(child));
  if (value === "" || value === ".." || value.startsWith(`..${sep}`)) {
    throw new Error(`${label} 不在允许目录内：${child}`);
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

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
  await fsyncPath(path);
}

async function atomicWritePrivate(path: string, content: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`);
  await writePrivateFile(temporary, content);
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
    await fsyncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function copyPrivateFile(source: string, target: string): Promise<void> {
  await copyFile(source, target);
  await chmod(target, 0o600);
  await fsyncPath(target);
}

async function copyPluginFiles(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: false, mode: 0o700 });
  await chmod(target, 0o700);
  for (const file of HERMES_BRIDGE_FILES) {
    const sourcePath = join(source, file);
    await assertRegularFile(sourcePath, `Hermes bridge 源文件 ${file}`);
    const targetPath = join(target, file);
    await copyFile(sourcePath, targetPath);
    await chmod(targetPath, 0o644);
    await fsyncPath(targetPath);
  }
  await fsyncDirectory(target);
}

async function copyDirectoryTree(source: string, target: string): Promise<void> {
  await assertDirectory(source, "插件备份目录");
  await mkdir(target, { recursive: false, mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    const stats = await lstat(sourcePath);
    if (stats.isSymbolicLink()) throw new Error(`插件备份包含符号链接，拒绝恢复：${sourcePath}`);
    if (stats.isDirectory()) {
      await copyDirectoryTree(sourcePath, targetPath);
      continue;
    }
    if (!stats.isFile()) throw new Error(`插件备份包含不支持的文件类型：${sourcePath}`);
    await copyFile(sourcePath, targetPath);
    await chmod(targetPath, stats.mode & 0o777);
    await fsyncPath(targetPath);
  }
  await chmod(target, 0o700);
  await fsyncDirectory(target);
}

async function directoryDigestFromFiles(directory: string, files: readonly string[]): Promise<string> {
  const parts: Uint8Array[] = [];
  const encoder = new TextEncoder();
  for (const file of files) {
    const path = join(directory, file);
    await assertRegularFile(path, `已安装 Hermes bridge 文件 ${file}`);
    parts.push(encoder.encode(`${file}\0`), await readFile(path), encoder.encode("\0"));
  }
  const size = parts.reduce((total, item) => total + item.byteLength, 0);
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return sha256(joined);
}

async function directoryDigest(directory: string): Promise<string> {
  return directoryDigestFromFiles(directory, await digestFiles(directory));
}

async function bridgeDigest(directory: string): Promise<string> {
  const files = await digestFiles(directory);
  for (const file of HERMES_BRIDGE_FILES) {
    if (!files.includes(file)) throw new Error(`已安装 Hermes bridge 缺少文件：${file}`);
  }
  return directoryDigestFromFiles(directory, files);
}

async function digestFiles(root: string, current = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) continue;
    const path = join(current, entry.name);
    const relativePath = relative(root, path).replaceAll("\\", "/");
    if (entry.isSymbolicLink()) throw new Error(`Hermes bridge 包含符号链接：${relativePath}`);
    if (entry.isDirectory()) files.push(...await digestFiles(root, path));
    else if (entry.isFile()) files.push(relativePath);
    else throw new Error(`Hermes bridge 包含不支持的文件类型：${relativePath}`);
  }
  return files.sort();
}

function enablePlugin(configText: string, configPath: string): string {
  const document = parseDocument(configText, { keepSourceTokens: true });
  if (document.errors.length > 0) {
    throw new Error(`${configPath} 不是有效 YAML：${document.errors[0]!.message}`);
  }
  const value = document.toJS() as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${configPath} 顶层必须是 YAML mapping`);
  }
  const root = value as Record<string, unknown>;
  const pluginsValue = root.plugins;
  if (pluginsValue !== undefined && (pluginsValue === null || typeof pluginsValue !== "object" || Array.isArray(pluginsValue))) {
    throw new Error(`${configPath} 的 plugins 必须是 mapping`);
  }
  const plugins = (pluginsValue ?? {}) as Record<string, unknown>;
  const enabledValue = plugins.enabled;
  if (enabledValue !== undefined && (!Array.isArray(enabledValue) || enabledValue.some((item) => typeof item !== "string"))) {
    throw new Error(`${configPath} 的 plugins.enabled 必须是字符串数组`);
  }
  const enabled = [...(enabledValue as string[] | undefined ?? [])];
  if (!enabled.includes(HERMES_BRIDGE_NAME)) enabled.push(HERMES_BRIDGE_NAME);
  document.setIn(["plugins", "enabled"], enabled);
  return document.toString().endsWith("\n") ? document.toString() : `${document.toString()}\n`;
}

async function pluginVersion(sourceDirectory: string): Promise<string> {
  const text = await readFile(join(sourceDirectory, "plugin.yaml"), "utf8");
  const version = text.match(/^version:\s*([^\s]+)$/m)?.[1];
  if (!version) throw new Error("hermes-plugin/plugin.yaml 缺少 version");
  return version;
}

async function withInstallLock<T>(hermesHome: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = join(hermesHome, ".livis-bridge-install.lock");
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`发现安装锁 ${lockPath}；确认没有其他安装进程后再人工移除`);
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    await handle.sync();
    return await operation();
  } finally {
    await handle.close();
    await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function canonicalHermesHome(path: string): Promise<string> {
  const explicit = resolve(path);
  await assertDirectory(explicit, "HERMES_HOME");
  return realpath(explicit);
}

export async function installHermesBridge(
  options: InstallHermesBridgeOptions,
): Promise<HermesInstallReceipt> {
  const hermesHome = await canonicalHermesHome(options.hermesHome);
  const sourceDirectory = resolve(options.sourceDirectory ?? join(import.meta.dir, "../../hermes-plugin"));
  await assertDirectory(sourceDirectory, "Hermes bridge 源目录");
  const configPath = join(hermesHome, "config.yaml");
  await assertRegularFile(configPath, "Hermes profile config.yaml");
  const pluginParent = join(hermesHome, "plugins");
  await mkdir(pluginParent, { recursive: true, mode: 0o700 });
  await assertDirectory(pluginParent, "Hermes plugins 目录");
  const pluginPath = join(pluginParent, HERMES_BRIDGE_NAME);
  if (await exists(pluginPath)) await assertDirectory(pluginPath, "已安装 Hermes bridge");

  return withInstallLock(hermesHome, async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const transactionRoot = join(hermesHome, "backups", HERMES_BRIDGE_NAME, `${stamp}-${crypto.randomUUID()}`);
    await mkdir(transactionRoot, { recursive: true, mode: 0o700 });
    await chmod(transactionRoot, 0o700);
    const backupConfigPath = join(transactionRoot, "config.before.yaml");
    const configBefore = await readFile(configPath, "utf8");
    const configAfter = enablePlugin(configBefore, configPath);
    await copyPrivateFile(configPath, backupConfigPath);

    const priorPluginPresent = await exists(pluginPath);
    const backupPluginPath = priorPluginPresent ? join(transactionRoot, "plugin.before") : null;
    const stagingPath = join(pluginParent, `.${HERMES_BRIDGE_NAME}.staging-${crypto.randomUUID()}`);
    const configStagingPath = join(dirname(configPath), `.${basename(configPath)}.staging-${crypto.randomUUID()}`);
    await copyPluginFiles(sourceDirectory, stagingPath);
    const installedDigest = await bridgeDigest(stagingPath);
    await writePrivateFile(configStagingPath, configAfter);

    const receiptPath = join(transactionRoot, "receipt.json");
    const receipt: HermesInstallReceipt = {
      schemaVersion: 1,
      status: "prepared",
      hermesHome,
      pluginName: HERMES_BRIDGE_NAME,
      pluginVersion: await pluginVersion(sourceDirectory),
      installedAt: new Date().toISOString(),
      installedDigest,
      priorPluginPresent,
      backupPluginPath,
      backupConfigPath,
      configBeforeSha256: sha256(configBefore),
      configAfterSha256: sha256(configAfter),
      receiptPath,
    };
    await writePrivateFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

    let oldPluginMoved = false;
    let newPluginMoved = false;
    try {
      if (backupPluginPath) {
        await rename(pluginPath, backupPluginPath);
        oldPluginMoved = true;
      }
      await rename(stagingPath, pluginPath);
      newPluginMoved = true;
      await fsyncDirectory(pluginParent);
      await options.beforeConfigCommit?.();
      await rename(configStagingPath, configPath);
      await chmod(configPath, 0o600);
      await fsyncDirectory(dirname(configPath));
      const installedReceipt: HermesInstallReceipt = { ...receipt, status: "installed" };
      await atomicWritePrivate(receiptPath, `${JSON.stringify(installedReceipt, null, 2)}\n`);
      return installedReceipt;
    } catch (error) {
      if (newPluginMoved) await rm(pluginPath, { recursive: true, force: true });
      if (oldPluginMoved && backupPluginPath) await rename(backupPluginPath, pluginPath);
      await copyPrivateFile(backupConfigPath, configStagingPath).catch(() => undefined);
      if (await exists(configStagingPath)) await rename(configStagingPath, configPath);
      await fsyncDirectory(pluginParent).catch(() => undefined);
      await fsyncDirectory(dirname(configPath)).catch(() => undefined);
      await rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      await rm(stagingPath, { recursive: true, force: true });
      await rm(configStagingPath, { force: true });
    }
  });
}

function parseReceipt(text: string, path: string): HermesInstallReceipt {
  const root = parseJsonObject(text, path);
  if (
    root.schemaVersion !== 1 ||
    !["prepared", "installed", "rolled-back"].includes(String(root.status)) ||
    root.pluginName !== HERMES_BRIDGE_NAME ||
    typeof root.hermesHome !== "string" ||
    typeof root.installedDigest !== "string" ||
    typeof root.backupConfigPath !== "string" ||
    typeof root.configAfterSha256 !== "string"
  ) {
    throw new Error(`安装收据格式无效：${path}`);
  }
  return root as unknown as HermesInstallReceipt;
}

export async function rollbackHermesBridge(
  options: RollbackHermesBridgeOptions,
): Promise<HermesInstallReceipt> {
  if (!options.acknowledgeRollback) {
    throw new Error("回滚会替换当前 bridge 与 config.yaml，必须显式确认 --acknowledge-rollback");
  }
  const hermesHome = await canonicalHermesHome(options.hermesHome);
  const receiptPath = resolve(options.receiptPath);
  const backupRoot = join(hermesHome, "backups", HERMES_BRIDGE_NAME);
  assertContained(backupRoot, receiptPath, "安装收据");
  await assertRegularFile(receiptPath, "安装收据");
  const receipt = parseReceipt(await readFile(receiptPath, "utf8"), receiptPath);
  if (receipt.status !== "installed") throw new Error("该安装收据已经回滚，拒绝重复执行");
  if (resolve(receipt.hermesHome) !== hermesHome) throw new Error("安装收据属于不同 HERMES_HOME");
  if (resolve(receipt.receiptPath) !== receiptPath) throw new Error("安装收据路径与内容不一致");
  assertContained(backupRoot, receipt.backupConfigPath, "配置备份");
  if (receipt.backupPluginPath) assertContained(backupRoot, receipt.backupPluginPath, "插件备份");

  return withInstallLock(hermesHome, async () => {
    const pluginPath = join(hermesHome, "plugins", HERMES_BRIDGE_NAME);
    const configPath = join(hermesHome, "config.yaml");
    await assertDirectory(pluginPath, "当前 Hermes bridge");
    await assertRegularFile(configPath, "当前 Hermes config.yaml");
    if (await bridgeDigest(pluginPath) !== receipt.installedDigest) {
      throw new Error("当前 bridge 已在安装后发生变化，拒绝覆盖");
    }
    const currentConfig = await readFile(configPath, "utf8");
    if (sha256(currentConfig) !== receipt.configAfterSha256) {
      throw new Error("当前 config.yaml 已在安装后发生变化，拒绝覆盖");
    }
    await assertRegularFile(receipt.backupConfigPath, "配置备份");
    if (sha256(await readFile(receipt.backupConfigPath)) !== receipt.configBeforeSha256) {
      throw new Error("配置备份哈希不匹配，拒绝回滚");
    }
    if (receipt.priorPluginPresent) {
      if (!receipt.backupPluginPath) throw new Error("收据缺少旧插件备份路径");
      assertContained(backupRoot, receipt.backupPluginPath, "旧插件备份");
      await assertDirectory(receipt.backupPluginPath, "旧插件备份");
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const preRollbackRoot = join(backupRoot, `${stamp}-pre-rollback-${crypto.randomUUID()}`);
    await mkdir(preRollbackRoot, { recursive: true, mode: 0o700 });
    const currentPluginBackup = join(preRollbackRoot, "plugin.current");
    const currentConfigBackup = join(preRollbackRoot, "config.current.yaml");
    await copyPrivateFile(configPath, currentConfigBackup);
    const restoreStaging = join(dirname(pluginPath), `.${HERMES_BRIDGE_NAME}.rollback-${crypto.randomUUID()}`);
    if (receipt.priorPluginPresent && receipt.backupPluginPath) {
      await copyDirectoryTree(receipt.backupPluginPath, restoreStaging);
    }
    const configStaging = join(dirname(configPath), `.${basename(configPath)}.rollback-${crypto.randomUUID()}`);
    await copyPrivateFile(receipt.backupConfigPath, configStaging);

    let currentPluginMoved = false;
    let priorPluginRestored = false;
    try {
      await rename(pluginPath, currentPluginBackup);
      currentPluginMoved = true;
      if (receipt.priorPluginPresent) {
        await rename(restoreStaging, pluginPath);
        priorPluginRestored = true;
      }
      await rename(configStaging, configPath);
      await chmod(configPath, 0o600);
      await fsyncDirectory(dirname(pluginPath));
      await fsyncDirectory(dirname(configPath));
      const updated: HermesInstallReceipt = {
        ...receipt,
        status: "rolled-back",
        rolledBackAt: new Date().toISOString(),
        preRollbackBackupPath: preRollbackRoot,
      };
      await options.beforeReceiptCommit?.();
      await atomicWritePrivate(receiptPath, `${JSON.stringify(updated, null, 2)}\n`);
      return updated;
    } catch (error) {
      const compensationErrors: unknown[] = [];
      const configCompensationStaging = join(
        dirname(configPath),
        `.${basename(configPath)}.rollback-compensation-${crypto.randomUUID()}`,
      );
      try {
        if (priorPluginRestored) await rm(pluginPath, { recursive: true, force: true });
        if (currentPluginMoved) await rename(currentPluginBackup, pluginPath);
        await copyPrivateFile(currentConfigBackup, configCompensationStaging);
        await rename(configCompensationStaging, configPath);
        await chmod(configPath, 0o600);
        await fsyncDirectory(dirname(pluginPath));
        await fsyncDirectory(dirname(configPath));
      } catch (compensationError) {
        compensationErrors.push(compensationError);
      } finally {
        await rm(configCompensationStaging, { force: true }).catch(() => undefined);
      }
      try {
        await atomicWritePrivate(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      } catch (compensationError) {
        compensationErrors.push(compensationError);
      }
      if (compensationErrors.length > 0) {
        throw new AggregateError(
          [error, ...compensationErrors],
          `Hermes bridge 回滚失败且补偿未完整完成；保留操作前备份：${preRollbackRoot}`,
        );
      }
      throw new Error(`Hermes bridge 回滚失败，已精确恢复操作前状态：${String(error)}`, {
        cause: error,
      });
    } finally {
      await rm(restoreStaging, { recursive: true, force: true });
      await rm(configStaging, { force: true });
    }
  });
}

export async function compensateHermesBridgeRollback(
  options: CompensateHermesBridgeRollbackOptions,
): Promise<HermesInstallReceipt> {
  if (!options.acknowledgeCompensation) {
    throw new Error("撤销 Hermes bridge 回滚必须显式确认内部补偿");
  }
  const hermesHome = await canonicalHermesHome(options.hermesHome);
  const receiptPath = resolve(options.receiptPath);
  const backupRoot = join(hermesHome, "backups", HERMES_BRIDGE_NAME);
  assertContained(backupRoot, receiptPath, "安装收据");
  await assertRegularFile(receiptPath, "安装收据");

  return withInstallLock(hermesHome, async () => {
    const receipt = parseReceipt(await readFile(receiptPath, "utf8"), receiptPath);
    if (receipt.status !== "rolled-back" || !receipt.preRollbackBackupPath) {
      throw new Error("只有已完成的 Hermes bridge 回滚可以执行补偿");
    }
    if (resolve(receipt.hermesHome) !== hermesHome) throw new Error("安装收据属于不同 HERMES_HOME");
    if (resolve(receipt.receiptPath) !== receiptPath) throw new Error("安装收据路径与内容不一致");
    const preRollbackRoot = resolve(receipt.preRollbackBackupPath);
    assertContained(backupRoot, preRollbackRoot, "回滚前备份");
    await assertDirectory(preRollbackRoot, "回滚前备份");

    const pluginPath = join(hermesHome, "plugins", HERMES_BRIDGE_NAME);
    const configPath = join(hermesHome, "config.yaml");
    const installedPluginBackup = join(preRollbackRoot, "plugin.current");
    const installedConfigBackup = join(preRollbackRoot, "config.current.yaml");
    await assertDirectory(installedPluginBackup, "回滚前 bridge 备份");
    await assertRegularFile(installedConfigBackup, "回滚前 config 备份");
    if (await bridgeDigest(installedPluginBackup) !== receipt.installedDigest) {
      throw new Error("回滚前 bridge 备份哈希不匹配，拒绝补偿");
    }
    if (sha256(await readFile(installedConfigBackup)) !== receipt.configAfterSha256) {
      throw new Error("回滚前 config 备份哈希不匹配，拒绝补偿");
    }
    await assertRegularFile(configPath, "当前 Hermes config.yaml");
    if (sha256(await readFile(configPath)) !== receipt.configBeforeSha256) {
      throw new Error("Hermes config 在回滚后发生变化，拒绝自动补偿");
    }
    if (receipt.priorPluginPresent) {
      if (!receipt.backupPluginPath) throw new Error("收据缺少旧插件备份路径");
      assertContained(backupRoot, receipt.backupPluginPath, "旧插件备份");
      await assertDirectory(receipt.backupPluginPath, "旧插件备份");
      await assertDirectory(pluginPath, "当前已回滚 bridge");
      if (await directoryDigest(pluginPath) !== await directoryDigest(receipt.backupPluginPath)) {
        throw new Error("Hermes bridge 在回滚后发生变化，拒绝自动补偿");
      }
    } else if (await exists(pluginPath)) {
      throw new Error("Hermes bridge 在回滚后被重新创建，拒绝自动补偿");
    }

    const compensationRoot = join(preRollbackRoot, `compensation-${crypto.randomUUID()}`);
    await mkdir(compensationRoot, { recursive: false, mode: 0o700 });
    const rolledBackPluginBackup = join(compensationRoot, "plugin.rolled-back");
    const rolledBackConfigBackup = join(compensationRoot, "config.rolled-back.yaml");
    await copyPrivateFile(configPath, rolledBackConfigBackup);
    const pluginStaging = join(dirname(pluginPath), `.${HERMES_BRIDGE_NAME}.compensation-${crypto.randomUUID()}`);
    const configStaging = join(dirname(configPath), `.${basename(configPath)}.compensation-${crypto.randomUUID()}`);
    await copyDirectoryTree(installedPluginBackup, pluginStaging);
    await copyPrivateFile(installedConfigBackup, configStaging);

    let rolledBackPluginMoved = false;
    let installedPluginMoved = false;
    try {
      if (receipt.priorPluginPresent) {
        await rename(pluginPath, rolledBackPluginBackup);
        rolledBackPluginMoved = true;
      }
      await rename(pluginStaging, pluginPath);
      installedPluginMoved = true;
      await rename(configStaging, configPath);
      await chmod(configPath, 0o600);
      await fsyncDirectory(dirname(pluginPath));
      await fsyncDirectory(dirname(configPath));

      const restored: HermesInstallReceipt = { ...receipt, status: "installed" };
      delete restored.rolledBackAt;
      delete restored.preRollbackBackupPath;
      await atomicWritePrivate(receiptPath, `${JSON.stringify(restored, null, 2)}\n`);
      return restored;
    } catch (error) {
      const compensationErrors: unknown[] = [];
      const configRestoreStaging = join(
        dirname(configPath),
        `.${basename(configPath)}.compensation-restore-${crypto.randomUUID()}`,
      );
      try {
        if (installedPluginMoved) await rm(pluginPath, { recursive: true, force: true });
        if (rolledBackPluginMoved) await rename(rolledBackPluginBackup, pluginPath);
        await copyPrivateFile(rolledBackConfigBackup, configRestoreStaging);
        await rename(configRestoreStaging, configPath);
        await chmod(configPath, 0o600);
        await fsyncDirectory(dirname(pluginPath));
        await fsyncDirectory(dirname(configPath));
      } catch (compensationError) {
        compensationErrors.push(compensationError);
      } finally {
        await rm(configRestoreStaging, { force: true }).catch(() => undefined);
      }
      try {
        await atomicWritePrivate(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      } catch (compensationError) {
        compensationErrors.push(compensationError);
      }
      if (compensationErrors.length > 0) {
        throw new AggregateError(
          [error, ...compensationErrors],
          `Hermes bridge 回滚补偿失败且无法恢复已回滚状态；保留备份：${compensationRoot}`,
        );
      }
      throw error;
    } finally {
      await rm(pluginStaging, { recursive: true, force: true });
      await rm(configStaging, { force: true });
    }
  });
}

export async function listHermesInstallReceipts(hermesHomePath: string): Promise<string[]> {
  const hermesHome = await canonicalHermesHome(hermesHomePath);
  const root = join(hermesHome, "backups", HERMES_BRIDGE_NAME);
  if (!await exists(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const receipts: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(root, entry.name, "receipt.json");
    if (await exists(path)) receipts.push(path);
  }
  return receipts.sort().reverse();
}
