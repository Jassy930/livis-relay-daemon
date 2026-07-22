import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { asNonEmptyString, asPositiveInteger, parseJsonObject } from "../util.ts";

interface GuardIdentity {
  dev: number;
  ino: number;
}

interface GuardFileLease {
  handle: FileHandle;
  identity: GuardIdentity;
  state: "linked" | "unlinked" | "released";
}

function isWithin(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

export async function requirePrivateDirectory(path: string, label: string): Promise<string> {
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
  const handle = await open(
    path,
    constants.O_RDONLY |
      constants.O_DIRECTORY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
  );
  try {
    if (!(await handle.stat()).isDirectory()) {
      throw new Error(`guard 待 fsync 路径不是目录：${path}`);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertOwnedGuardIdentity(
  info: Stats,
  identity: GuardIdentity,
  path: string,
): void {
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.nlink !== 1 ||
    info.dev !== identity.dev ||
    info.ino !== identity.ino
  ) {
    throw new Error(`guard 文件类型、权限或 inode 已变化，拒绝操作：${path}`);
  }
}

function assertOwnedGuardInfo(info: Stats, identity: GuardIdentity, path: string): void {
  assertOwnedGuardIdentity(info, identity, path);
  if ((info.mode & 0o777) !== 0o600) {
    throw new Error(`guard 文件类型、权限或 inode 已变化，拒绝操作：${path}`);
  }
}

async function assertLeaseLinked(
  lease: GuardFileLease,
  path: string,
  requireExactPermissions = true,
): Promise<void> {
  if (lease.state !== "linked") {
    throw new Error(`guard 文件已不再链接到原路径，拒绝操作：${path}`);
  }
  const parent = dirname(path);
  if (await requirePrivateDirectory(parent, "guard parent directory") !== parent) {
    throw new Error(`guard parent directory realpath 已变化，拒绝操作：${parent}`);
  }
  const info = await lease.handle.stat();
  if (requireExactPermissions) {
    assertOwnedGuardInfo(info, lease.identity, path);
  } else {
    assertOwnedGuardIdentity(info, lease.identity, path);
  }
}

async function unlinkIfOwned(
  path: string,
  lease: GuardFileLease,
  requireExactPermissions = true,
): Promise<boolean> {
  if (lease.state !== "linked") {
    throw new Error(`guard 文件状态无效，拒绝重复 unlink：${path}`);
  }
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await assertLeaseLinked(lease, path, requireExactPermissions);
  if (requireExactPermissions) {
    assertOwnedGuardInfo(info, lease.identity, path);
  } else {
    assertOwnedGuardIdentity(info, lease.identity, path);
  }
  await unlink(path);
  lease.state = "unlinked";
  return true;
}

async function finishGuardRelease(path: string, lease: GuardFileLease): Promise<void> {
  if (lease.state === "released") return;
  if (lease.state !== "unlinked") {
    throw new Error(`guard 文件仍链接在原路径，拒绝提前关闭句柄：${path}`);
  }
  const parent = dirname(path);
  if (await requirePrivateDirectory(parent, "guard parent directory") !== parent) {
    throw new Error(`guard parent directory realpath 已变化，拒绝完成 release：${parent}`);
  }
  await syncDirectory(parent);
  await lease.handle.close();
  lease.state = "released";
}

async function discardGuardFile(path: string, lease: GuardFileLease): Promise<void> {
  try {
    // 创建阶段可能尚未成功 fchmod；清理只放宽 mode 要求，仍核对父目录、
    // retained fd/path 的类型、link count 与 dev/inode，绝不删除替代文件。
    if (lease.state === "linked") await unlinkIfOwned(path, lease, false);
    if (lease.state === "unlinked") await syncDirectory(dirname(path));
  } finally {
    await lease.handle.close().catch(() => undefined);
    lease.state = "released";
  }
}

async function createGuardFile(
  path: string,
  text: string,
  existsMessage: string,
): Promise<GuardFileLease> {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(existsMessage);
    }
    throw error;
  }

  let lease: GuardFileLease | null = null;
  try {
    const info = await handle.stat();
    const identity = { dev: info.dev, ino: info.ino };
    lease = { handle, identity, state: "linked" };
    // open 的 mode 会被进程 umask 掩码；在创建 fd 上固定并精确读回 0600，
    // 再写入和 fsync，避免产生 acquire 成功但无法 assert/release 的 000 guard。
    await handle.chmod(0o600);
    assertOwnedGuardInfo(await handle.stat(), identity, path);
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } catch (error) {
    if (lease) await discardGuardFile(path, lease).catch(() => undefined);
    else await handle.close().catch(() => undefined);
    throw error;
  }
  if (!lease) {
    await handle.close().catch(() => undefined);
    throw new Error(`guard 文件创建后未取得句柄身份：${path}`);
  }
  try {
    await syncDirectory(dirname(path));
  } catch (error) {
    await discardGuardFile(path, lease).catch(() => undefined);
    throw error;
  }
  return lease;
}

async function readOwnedGuard(path: string, lease: GuardFileLease): Promise<string> {
  await assertLeaseLinked(lease, path);
  assertOwnedGuardInfo(await lstat(path), lease.identity, path);
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    assertOwnedGuardInfo(info, lease.identity, path);
    const text = await handle.readFile("utf8");
    await assertLeaseLinked(lease, path);
    assertOwnedGuardInfo(await lstat(path), lease.identity, path);
    return text;
  } finally {
    await handle.close();
  }
}

interface OfflineGuardDocument {
  schemaVersion: 1;
  kind: "livis-relay-offline-guard";
  operation:
    | "protocol-profile-migration"
    | "protocol-profile-migration-rollback"
    | "session-release";
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
    ![
      "protocol-profile-migration",
      "protocol-profile-migration-rollback",
      "session-release",
    ].includes(operation) ||
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
  private constructor(
    readonly path: string,
    readonly document: OfflineGuardDocument,
    private readonly lease: GuardFileLease,
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
    const lease = await createGuardFile(
      canonicalSocketPath,
      `${JSON.stringify(document, null, 2)}\n`,
      `connector socket 路径已存在：${canonicalSocketPath}；必须先停止 daemon，并人工确认没有遗留 socket/guard`,
    );
    return new DaemonOfflineGuard(canonicalSocketPath, document, lease);
  }

  async assertHeld(): Promise<void> {
    const current = parseOfflineGuard(await readOwnedGuard(this.path, this.lease), this.path);
    if (current.nonce !== this.document.nonce) {
      throw new Error("connector socket guard 所有权已变化");
    }
  }

  async release(): Promise<void> {
    if (this.lease.state === "released") return;
    if (this.lease.state === "linked") {
      await this.assertHeld();
      if (!await unlinkIfOwned(this.path, this.lease)) {
        throw new Error(`connector socket guard 已在 release 前消失：${this.path}`);
      }
    }
    await finishGuardRelease(this.path, this.lease);
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

export class ProfileOperationGuardBusyError extends Error {
  constructor(readonly path: string) {
    super(`profile operation guard 已存在：${path}；确认没有管理命令运行后再处理遗留 guard`);
    this.name = "ProfileOperationGuardBusyError";
  }
}

export class ProfileOperationGuardFinalizationError extends AggregateError {
  readonly guardPath: string;
  readonly primaryError: unknown;
  readonly releaseError: unknown;

  constructor(operation: string, guardPath: string, primaryError: unknown, releaseError: unknown) {
    const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
    const releaseMessage = releaseError instanceof Error ? releaseError.message : String(releaseError);
    super(
      [primaryError, releaseError],
      `${operation} 失败后无法释放 profile operation guard：${guardPath}；主错误：${primaryMessage}；释放错误：${releaseMessage}`,
      { cause: primaryError },
    );
    this.name = "ProfileOperationGuardFinalizationError";
    this.guardPath = guardPath;
    this.primaryError = primaryError;
    this.releaseError = releaseError;
  }
}

export class ProfileOperationCleanupError extends AggregateError {
  readonly primaryError: unknown;
  readonly cleanupFailures: ReadonlyArray<{ label: string; error: unknown }>;

  constructor(
    operation: string,
    primaryError: unknown,
    cleanupFailures: ReadonlyArray<{ label: string; error: unknown }>,
  ) {
    const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
    const cleanupMessage = cleanupFailures
      .map(({ label, error }) => `${label}：${error instanceof Error ? error.message : String(error)}`)
      .join("；");
    super(
      [primaryError, ...cleanupFailures.map(({ error }) => error)],
      `${operation} 失败，且清理未全部完成；主错误：${primaryMessage}；清理错误：${cleanupMessage}`,
      { cause: primaryError },
    );
    this.name = "ProfileOperationCleanupError";
    this.primaryError = primaryError;
    this.cleanupFailures = cleanupFailures;
  }
}

export async function rethrowAfterProfileOperationGuardRelease(
  guard: ProfileOperationGuard,
  operation: string,
  primaryError: unknown,
): Promise<never> {
  try {
    await guard.release();
  } catch (releaseError) {
    throw new ProfileOperationGuardFinalizationError(
      operation,
      guard.path,
      primaryError,
      releaseError,
    );
  }
  throw primaryError;
}

export async function withProfileOperationGuardRelease<T>(
  guard: ProfileOperationGuard,
  operation: string,
  work: () => Promise<T>,
): Promise<T> {
  let result: T;
  try {
    result = await work();
  } catch (primaryError) {
    return rethrowAfterProfileOperationGuardRelease(guard, operation, primaryError);
  }
  await guard.release();
  return result;
}

export async function rethrowAfterProfileOperationCleanup(
  operation: string,
  primaryError: unknown,
  cleanups: ReadonlyArray<{ label: string; run: () => void | Promise<void> }>,
): Promise<never> {
  const cleanupFailures: Array<{ label: string; error: unknown }> = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup.run();
    } catch (error) {
      cleanupFailures.push({ label: cleanup.label, error });
    }
  }
  if (cleanupFailures.length === 0) throw primaryError;
  throw new ProfileOperationCleanupError(operation, primaryError, cleanupFailures);
}

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
  private constructor(
    readonly path: string,
    readonly document: ProfileOperationGuardDocument,
    private readonly lease: GuardFileLease,
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
    const existsMessage = `profile operation guard 已存在：${path}；确认没有管理命令运行后再处理遗留 guard`;
    let lease: GuardFileLease;
    try {
      lease = await createGuardFile(path, `${JSON.stringify(document, null, 2)}\n`, existsMessage);
    } catch (error) {
      if (error instanceof Error && error.message === existsMessage) {
        throw new ProfileOperationGuardBusyError(path);
      }
      throw error;
    }
    return new ProfileOperationGuard(path, document, lease);
  }

  async assertHeld(): Promise<void> {
    const current = parseProfileOperationGuard(
      await readOwnedGuard(this.path, this.lease),
      this.path,
    );
    if (current.nonce !== this.document.nonce) {
      throw new Error("profile operation guard 所有权已变化");
    }
  }

  async assertHeldForStateDir(stateDir: string): Promise<void> {
    await this.assertHeld();
    const canonicalStateDir = await requirePrivateDirectory(stateDir, "profile operation stateDir");
    if (dirname(this.path) !== canonicalStateDir) {
      throw new Error("profile operation guard 不属于当前 stateDir");
    }
  }

  async release(): Promise<void> {
    if (this.lease.state === "released") return;
    if (this.lease.state === "linked") {
      await this.assertHeld();
      if (!await unlinkIfOwned(this.path, this.lease)) {
        throw new Error(`profile operation guard 已在 release 前消失：${this.path}`);
      }
    }
    await finishGuardRelease(this.path, this.lease);
  }
}
