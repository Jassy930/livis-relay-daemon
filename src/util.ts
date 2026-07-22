import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

export function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(path);
}

export async function atomicWritePrivate(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let renamed = false;
  try {
    await writeFile(temporaryPath, data, { encoding: "utf8", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    renamed = true;
    await chmod(path, 0o600);
  } finally {
    if (!renamed) await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function atomicWritePrivateBytes(path: string, data: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let renamed = false;
  try {
    await writeFile(temporaryPath, data, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    renamed = true;
    await chmod(path, 0o600);
  } finally {
    if (!renamed) await unlink(temporaryPath).catch(() => undefined);
  }
}

export class DurableCommitUncertainError extends Error {
  constructor(readonly path: string, cause: unknown) {
    super(`durable rename 已发生，但目录 fsync 未确认：${path}`, { cause });
    this.name = "DurableCommitUncertainError";
  }
}

/**
 * 用于迁移 commit point 的持久化替换：临时文件与父目录都执行 fsync，且
 * 0600 权限在 rename 前已经固定。调用方仍需在异常后按目标内容 SHA
 * readback；rename 后父目录 fsync 未确认会抛 DurableCommitUncertainError，
 * 不能仅凭当前可见 SHA 把它降级成成功。
 */
export async function durableAtomicWritePrivate(
  path: string,
  data: string,
  options: { syncParentDirectory?: (path: string) => Promise<void> } = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let renamed = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      // open 的 mode 会被进程 umask 掩码；必须在同一 fd 上固定并读回权限，
      // 避免把 000/0200 等不可读文件 rename 成正式配置或恢复证据。
      await handle.chmod(0o600);
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o777) !== 0o600) {
        throw new Error(`durable 临时文件权限未固定为 0600：${temporaryPath}`);
      }
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    renamed = true;
    try {
      if (options.syncParentDirectory) {
        await options.syncParentDirectory(dirname(path));
      } else {
        await syncDirectory(dirname(path));
      }
    } catch (error) {
      throw new DurableCommitUncertainError(path, error);
    }
  } finally {
    if (!renamed) await unlink(temporaryPath).catch(() => undefined);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** 创建单层 0700 目录并同步父目录中的新目录项；父目录必须已存在。 */
export async function durableMkdirPrivate(path: string): Promise<boolean> {
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const beforeChmod = await lstat(path);
  if (
    beforeChmod.isSymbolicLink() ||
    !beforeChmod.isDirectory() ||
    (beforeChmod.mode & 0o077) !== 0
  ) {
    throw new Error(`durable private directory 已存在但类型或权限不安全：${path}`);
  }

  // mkdir 的 mode 同样受 umask 影响。保留安全但 owner 权限不足的目录作为
  // 可重试状态；下一次 EEXIST 会重新固定 0700，而不会接管曾向组/其他用户开放的目录。
  await chmod(path, 0o700);
  const afterChmod = await lstat(path);
  if (
    afterChmod.isSymbolicLink() ||
    !afterChmod.isDirectory() ||
    (afterChmod.mode & 0o777) !== 0o700 ||
    afterChmod.dev !== beforeChmod.dev ||
    afterChmod.ino !== beforeChmod.ino
  ) {
    throw new Error(`durable private directory 权限未固定为 0700 或路径已变化：${path}`);
  }
  await syncDirectory(dirname(path));
  await syncDirectory(path);
  return created;
}

/**
 * 先同步普通源文件，再 rename；跨目录时先同步目标目录、后同步源目录，避免
 * 断电窗口中“源删除已持久化、目标新增尚未持久化”而丢失 quarantine 证据。
 */
export async function durableRename(
  source: string,
  destination: string,
  options: { syncDirectory?: (path: string) => Promise<void> } = {},
): Promise<void> {
  const sourceInfo = await lstat(source);
  if (sourceInfo.isFile() && !sourceInfo.isSymbolicLink()) {
    const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const openedInfo = await sourceHandle.stat();
      if (openedInfo.dev !== sourceInfo.dev || openedInfo.ino !== sourceInfo.ino) {
        throw new Error(`durable rename 源文件在 fsync 前发生变化：${source}`);
      }
      await sourceHandle.sync();
    } finally {
      await sourceHandle.close();
    }
  }
  const beforeRename = await lstat(source);
  if (beforeRename.dev !== sourceInfo.dev || beforeRename.ino !== sourceInfo.ino) {
    throw new Error(`durable rename 源路径在提交前发生变化：${source}`);
  }
  await rename(source, destination);
  const sourceDirectory = dirname(source);
  const destinationDirectory = dirname(destination);
  const sync = options.syncDirectory ?? syncDirectory;
  try {
    await sync(destinationDirectory);
    if (resolve(sourceDirectory) !== resolve(destinationDirectory)) {
      await sync(sourceDirectory);
    }
  } catch (error) {
    throw new DurableCommitUncertainError(destination, error);
  }
}

export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function parseJsonObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON`, { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }
  return parsed as Record<string, unknown>;
}

export function asNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} 必须是非空字符串`);
  }
  return value;
}

export function asPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} 必须是正整数`);
  }
  return value;
}

export function asSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} 必须是 64 位小写十六进制 SHA-256`);
  }
  return value;
}

export function parseSemverTriplet(text: string): [number, number, number] | null {
  // 预发布版本（1.2.3-beta 等）不视为已审核的 1.2.3，默认拒绝。
  const match = text.match(/(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?![-0-9])/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function versionAtLeast(
  current: [number, number, number],
  minimum: [number, number, number],
): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (current[index]! > minimum[index]!) return true;
    if (current[index]! < minimum[index]!) return false;
  }
  return true;
}

export function versionLessThan(
  current: [number, number, number],
  maximumExclusive: [number, number, number],
): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (current[index]! < maximumExclusive[index]!) return true;
    if (current[index]! > maximumExclusive[index]!) return false;
  }
  return false;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) {
    return;
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(resolvePromise, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      rejectPromise(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function withJitter(baseMilliseconds: number, ratio = 0.2): number {
  const spread = baseMilliseconds * ratio;
  return Math.max(0, Math.round(baseMilliseconds - spread + Math.random() * spread * 2));
}
