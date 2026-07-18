import { Database } from "bun:sqlite";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { delay } from "../util.ts";

const lockBrand: unique symbol = Symbol("upstream-state-lock");
const LOCK_WAIT_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MS = 20;

export interface UpstreamStateLock {
  readonly stateDir: string;
  readonly [lockBrand]: true;
}

function isBusy(error: unknown): boolean {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "SQLITE_BUSY";
}

async function prepareLockDatabase(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "a", 0o600);
  await handle.close();
  await chmod(path, 0o600);
}

export function assertUpstreamStateLock(lock: UpstreamStateLock, stateDir: string): void {
  if (lock[lockBrand] !== true || lock.stateDir !== resolve(stateDir)) {
    throw new Error("upstream state lock 与目标 stateDir 不一致");
  }
}

export async function withUpstreamStateLock<T>(
  stateDir: string,
  operation: (lock: UpstreamStateLock) => Promise<T>,
): Promise<T> {
  const resolvedStateDir = resolve(stateDir);
  const lockPath = join(resolvedStateDir, "upstream", ".state-lock.sqlite");
  await prepareLockDatabase(lockPath);
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;

  while (true) {
    const database = new Database(lockPath, { create: true, strict: true });
    try {
      database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    } catch (error) {
      database.close();
      if (!isBusy(error) || Date.now() >= deadline) {
        if (isBusy(error)) {
          throw new Error(`等待 upstream state lock 超时：${lockPath}`, { cause: error });
        }
        throw error;
      }
      await delay(LOCK_RETRY_MS);
      continue;
    }

    const lock: UpstreamStateLock = {
      stateDir: resolvedStateDir,
      [lockBrand]: true,
    };
    try {
      return await operation(lock);
    } finally {
      try {
        database.exec("ROLLBACK");
      } finally {
        database.close();
      }
    }
  }
}
