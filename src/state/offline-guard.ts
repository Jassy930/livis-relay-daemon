import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { asNonEmptyString, asPositiveInteger, parseJsonObject } from "../util.ts";

interface GuardIdentity {
  dev: number;
  ino: number;
}

function isWithin(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

async function requirePrivateDirectory(path: string, label: string): Promise<string> {
  const absolute = resolve(path);
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} 必须是目录且不能是 symlink：${absolute}`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error(`${label} 权限过宽：${(info.mode & 0o777).toString(8)}，必须是 0700 或更严格`);
  }
  return realpath(absolute);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertOwnedGuardInfo(
  info: Stats,
  identity: GuardIdentity,
  path: string,
): void {
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    (info.mode & 0o077) !== 0 ||
    info.nlink !== 1 ||
    info.dev !== identity.dev ||
    info.ino !== identity.ino
  ) {
    throw new Error(`guard 文件类型、权限或 inode 已变化，拒绝操作：${path}`);
  }
}

async function unlinkIfOwned(path: string, identity: GuardIdentity): Promise<boolean> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  assertOwnedGuardInfo(info, identity, path);
  await unlink(path);
  await syncDirectory(dirname(path));
  return true;
}

async function createGuardFile(
  path: string,
  text: string,
  existsMessage: string,
): Promise<GuardIdentity> {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(existsMessage);
    }
    throw error;
  }

  let identity: GuardIdentity | null = null;
  try {
    const info = await handle.stat();
    identity = { dev: info.dev, ino: info.ino };
    assertOwnedGuardInfo(info, identity, path);
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (identity) await unlinkIfOwned(path, identity).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await syncDirectory(dirname(path));
  } catch (error) {
    await unlinkIfOwned(path, identity).catch(() => undefined);
    throw error;
  }
  return identity;
}

async function readOwnedGuard(path: string, identity: GuardIdentity): Promise<string> {
  assertOwnedGuardInfo(await lstat(path), identity, path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    assertOwnedGuardInfo(info, identity, path);
    const text = await handle.readFile("utf8");
    assertOwnedGuardInfo(await lstat(path), identity, path);
    return text;
  } finally {
    await handle.close();
  }
}

interface OfflineGuardDocument {
  schemaVersion: 1;
  kind: "livis-relay-offline-guard";
  operation: "protocol-profile-migration" | "protocol-profile-migration-rollback";
  pid: number;
  acquiredAt: string;
  nonce: string;
}

function parseOfflineGuard(text: string, path: string): OfflineGuardDocument {
  const root = parseJsonObject(text, path);
  const operation = asNonEmptyString(root.operation, `${path}.operation`);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "livis-relay-offline-guard" ||
    !["protocol-profile-migration", "protocol-profile-migration-rollback"].includes(operation) ||
    typeof root.acquiredAt !== "string"
  ) {
    throw new Error("connector socket guard 格式无效，拒绝删除非本次操作创建的文件");
  }
  return {
    schemaVersion: 1,
    kind: "livis-relay-offline-guard",
    operation: operation as OfflineGuardDocument["operation"],
    pid: asPositiveInteger(root.pid, `${path}.pid`),
    acquiredAt: root.acquiredAt,
    nonce: asNonEmptyString(root.nonce, `${path}.nonce`),
  };
}

/**
 * 在 connector Unix socket 原路径上创建普通文件。
 *
 * 运行中的 daemon 已占用该路径时 O_EXCL 会失败；guard 存在期间，旧版和
 * 新版 ConnectorServer 都会因路径不是 socket 而失败关闭，防止 service
 * manager 在 config 提交点前抢跑。父目录必须位于私有 stateDir；guard 文件和
 * 父目录项都会 fsync，并按 inode/nonce 复核。崩溃遗留 guard 也故意保持
 * fail closed。
 */
export class DaemonOfflineGuard {
  private released = false;

  private constructor(
    readonly path: string,
    readonly document: OfflineGuardDocument,
    private readonly identity: GuardIdentity,
  ) {}

  static async acquire(
    socketPath: string,
    stateDir: string,
    operation: OfflineGuardDocument["operation"],
  ): Promise<DaemonOfflineGuard> {
    const canonicalStateDir = await requirePrivateDirectory(stateDir, "offline guard stateDir");
    const requestedSocketPath = resolve(socketPath);
    const canonicalSocketDirectory = await requirePrivateDirectory(
      dirname(requestedSocketPath),
      "connector socket parent directory",
    );
    if (!isWithin(canonicalStateDir, canonicalSocketDirectory)) {
      throw new Error("connector socket parent directory 必须位于私有 stateDir 内");
    }
    const canonicalSocketPath = join(canonicalSocketDirectory, basename(requestedSocketPath));
    const document: OfflineGuardDocument = {
      schemaVersion: 1,
      kind: "livis-relay-offline-guard",
      operation,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      nonce: randomUUID(),
    };
    const identity = await createGuardFile(
      canonicalSocketPath,
      `${JSON.stringify(document, null, 2)}\n`,
      `connector socket 路径已存在：${canonicalSocketPath}；必须先停止 daemon，并人工确认没有遗留 socket/guard`,
    );
    return new DaemonOfflineGuard(canonicalSocketPath, document, identity);
  }

  async assertHeld(): Promise<void> {
    const current = parseOfflineGuard(await readOwnedGuard(this.path, this.identity), this.path);
    if (current.nonce !== this.document.nonce) {
      throw new Error("connector socket guard 所有权已变化");
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    await this.assertHeld();
    await unlinkIfOwned(this.path, this.identity);
    this.released = true;
  }
}

export type ProfileOperation =
  | "protocol-profile-migration"
  | "protocol-profile-migration-rollback"
  | "login"
  | "serve-start"
  | "upstream-check"
  | "upstream-activate"
  | "upstream-rollback";

interface ProfileOperationGuardDocument {
  schemaVersion: 1;
  kind: "livis-relay-profile-operation-guard";
  operation: ProfileOperation;
  pid: number;
  acquiredAt: string;
  nonce: string;
}

function parseProfileOperationGuard(text: string, path: string): ProfileOperationGuardDocument {
  const root = parseJsonObject(text, path);
  const operation = asNonEmptyString(root.operation, `${path}.operation`);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "livis-relay-profile-operation-guard" ||
    ![
      "protocol-profile-migration",
      "protocol-profile-migration-rollback",
      "login",
      "serve-start",
      "upstream-check",
      "upstream-activate",
      "upstream-rollback",
    ].includes(operation) ||
    typeof root.acquiredAt !== "string"
  ) {
    throw new Error("profile operation guard 格式无效，拒绝删除非本次操作创建的文件");
  }
  return {
    schemaVersion: 1,
    kind: "livis-relay-profile-operation-guard",
    operation: operation as ProfileOperation,
    pid: asPositiveInteger(root.pid, `${path}.pid`),
    acquiredAt: root.acquiredAt,
    nonce: asNonEmptyString(root.nonce, `${path}.nonce`),
  };
}

/** 串行化会切换 profile/config 或写 profile-bound proof 的显式 CLI。 */
export class ProfileOperationGuard {
  private released = false;

  private constructor(
    readonly path: string,
    readonly document: ProfileOperationGuardDocument,
    private readonly identity: GuardIdentity,
  ) {}

  static async acquire(stateDir: string, operation: ProfileOperation): Promise<ProfileOperationGuard> {
    const canonicalStateDir = await requirePrivateDirectory(stateDir, "profile operation stateDir");
    const path = join(canonicalStateDir, "profile-operation.guard");
    const document: ProfileOperationGuardDocument = {
      schemaVersion: 1,
      kind: "livis-relay-profile-operation-guard",
      operation,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      nonce: randomUUID(),
    };
    const identity = await createGuardFile(
      path,
      `${JSON.stringify(document, null, 2)}\n`,
      `profile operation guard 已存在：${path}；确认没有管理命令运行后再处理遗留 guard`,
    );
    return new ProfileOperationGuard(path, document, identity);
  }

  async assertHeld(): Promise<void> {
    const current = parseProfileOperationGuard(
      await readOwnedGuard(this.path, this.identity),
      this.path,
    );
    if (current.nonce !== this.document.nonce) {
      throw new Error("profile operation guard 所有权已变化");
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    await this.assertHeld();
    await unlinkIfOwned(this.path, this.identity);
    this.released = true;
  }
}
