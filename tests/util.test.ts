import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  DurableCommitUncertainError,
  atomicWritePrivate,
  durableAtomicWritePrivate,
  durableMkdirPrivate,
  durableRename,
  durableUnlink,
  parseSemverTriplet,
  versionAtLeast,
  versionLessThan,
} from "../src/util.ts";
import { temporaryDirectory } from "./helpers.ts";

async function runBunEval(script: string, label: string): Promise<void> {
  const subprocess = Bun.spawn([process.execPath, "-e", script], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${label} 子进程失败（exit ${exitCode}）：${stderr.trim()}`);
  }
}

describe("semver 工具", () => {
  test("从版本输出中提取三段版本号", () => {
    expect(parseSemverTriplet("0.15.1")).toEqual([0, 15, 1]);
    expect(parseSemverTriplet("hermes 0.15.1")).toEqual([0, 15, 1]);
    expect(parseSemverTriplet("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemverTriplet("no version here")).toBeNull();
  });

  test("预发布版本不视为已审核版本，默认拒绝", () => {
    expect(parseSemverTriplet("0.15.1-beta")).toBeNull();
    expect(parseSemverTriplet("hermes 1.2.3-rc.1")).toBeNull();
  });

  test("版本区间比较", () => {
    expect(versionAtLeast([0, 15, 1], [0, 15, 1])).toBeTrue();
    expect(versionAtLeast([0, 15, 0], [0, 15, 1])).toBeFalse();
    expect(versionLessThan([0, 15, 1], [0, 15, 2])).toBeTrue();
    expect(versionLessThan([0, 15, 2], [0, 15, 2])).toBeFalse();
  });
});

describe("durable 文件提交", () => {
  test("极端 umask 下仍固定 0600 文件、0700 目录并可重试私有目录", async () => {
    const directory = await temporaryDirectory("livis-durable-umask-");
    const filePath = join(directory.path, "config.json");
    const createdDirectory = join(directory.path, "created-directory");
    const retryDirectory = join(directory.path, "retry-directory");
    try {
      const utilUrl = new URL("../src/util.ts", import.meta.url).href;
      await runBunEval(`
        import { mkdir } from "node:fs/promises";
        import { durableAtomicWritePrivate, durableMkdirPrivate } from ${JSON.stringify(utilUrl)};
        process.umask(0o777);
        await durableAtomicWritePrivate(${JSON.stringify(filePath)}, "private\\n");
        if (!await durableMkdirPrivate(${JSON.stringify(createdDirectory)})) {
          throw new Error("应创建新的 durable 私有目录");
        }
        // 模拟 mkdir 已发生、但显式 chmod 前退出留下的 owner 权限不足目录。
        await mkdir(${JSON.stringify(retryDirectory)}, { mode: 0o700 });
      `, "极端 umask durable 写入");

      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      expect(await readFile(filePath, "utf8")).toBe("private\n");
      expect((await stat(createdDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(retryDirectory)).mode & 0o777).toBe(0o000);
      expect(await durableMkdirPrivate(retryDirectory)).toBeFalse();
      expect((await stat(retryDirectory)).mode & 0o777).toBe(0o700);
    } finally {
      // 回归失败时也先恢复目录 owner 权限，避免清理留下 000 目录。
      await chmod(createdDirectory, 0o700).catch(() => undefined);
      await chmod(retryDirectory, 0o700).catch(() => undefined);
      await directory.cleanup();
    }
  });

  test("rename 后父目录 fsync 失败必须报告 durability 未确认", async () => {
    const directory = await temporaryDirectory("livis-durable-write-");
    try {
      const path = join(directory.path, "config.json");
      await expect(durableAtomicWritePrivate(path, "committed-but-not-confirmed\n", {
        syncParentDirectory: async () => {
          throw new Error("injected directory fsync failure");
        },
      })).rejects.toBeInstanceOf(DurableCommitUncertainError);
      expect(await readFile(path, "utf8")).toBe("committed-but-not-confirmed\n");
    } finally {
      await directory.cleanup();
    }
  });

  test("私有目录 fsync 失败保持 0700 且下次可安全重试", async () => {
    const directory = await temporaryDirectory("livis-durable-mkdir-retry-");
    try {
      const path = join(directory.path, "upstream");
      const synced: string[] = [];
      await expect(durableMkdirPrivate(path, {
        syncDirectory: async (candidate) => {
          synced.push(candidate);
          if (candidate === path) throw new Error("injected created directory fsync failure");
        },
      })).rejects.toThrow("injected created directory fsync failure");
      expect(synced).toEqual([directory.path, path]);
      expect((await stat(path)).mode & 0o777).toBe(0o700);
      expect(await durableMkdirPrivate(path)).toBeFalse();
      expect((await stat(path)).mode & 0o777).toBe(0o700);
    } finally {
      await directory.cleanup();
    }
  });

  test("补偿 unlink 后父目录 fsync 失败报告 durability 未确认", async () => {
    const directory = await temporaryDirectory("livis-durable-unlink-");
    try {
      const path = join(directory.path, "proof.json");
      await atomicWritePrivate(path, "proof evidence\n");
      await expect(durableUnlink(path, {
        syncParentDirectory: async (parent) => {
          expect(parent).toBe(directory.path);
          throw new Error("injected unlink parent fsync failure");
        },
      })).rejects.toBeInstanceOf(DurableCommitUncertainError);
      expect(await Bun.file(path).exists()).toBeFalse();
    } finally {
      await directory.cleanup();
    }
  });

  test("quarantine rename 后目录 fsync 失败同样报告 durability 未确认", async () => {
    const directory = await temporaryDirectory("livis-durable-rename-");
    try {
      const sourceDirectory = join(directory.path, "source");
      const destinationDirectory = join(directory.path, "destination");
      await mkdir(sourceDirectory, { mode: 0o700 });
      await mkdir(destinationDirectory, { mode: 0o700 });
      const source = join(sourceDirectory, "proof.json");
      const destination = join(destinationDirectory, "proof.json");
      await atomicWritePrivate(source, "proof evidence\n");
      await expect(durableRename(source, destination, {
        syncDirectory: async () => {
          throw new Error("injected quarantine directory fsync failure");
        },
      })).rejects.toBeInstanceOf(DurableCommitUncertainError);
      expect(await Bun.file(source).exists()).toBeFalse();
      expect(await readFile(destination, "utf8")).toBe("proof evidence\n");
    } finally {
      await directory.cleanup();
    }
  });
});
