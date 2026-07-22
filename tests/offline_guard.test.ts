import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { ConnectorServer, type ConnectorServerHandlers } from "../src/connector/server.ts";
import { Logger } from "../src/logger.ts";
import {
  DaemonOfflineGuard,
  ProfileOperationCleanupError,
  ProfileOperationGuard,
  ProfileOperationGuardFinalizationError,
  rethrowAfterProfileOperationCleanup,
  withProfileOperationGuardRelease,
} from "../src/state/offline-guard.ts";
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

async function createFifo(path: string): Promise<void> {
  const subprocess = Bun.spawn(["mkfifo", path], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`mkfifo 失败（exit ${exitCode}）：${stderr.trim()}`);
  }
}

function connectorServer(socketPath: string): ConnectorServer {
  const handlers: ConnectorServerHandlers = {
    onReady: async () => {},
    onAccepted: async () => {},
    onResult: async () => {},
    onFailed: async () => {},
    onCancelled: async () => {},
    onDisconnected: async () => {},
    status: () => ({ test: true }),
  };
  return new ConnectorServer({
    socketPath,
    connectorToken: "x".repeat(43),
    helloTimeoutMs: 1_000,
    resultStoreTimeoutMs: 1_000,
    maxFrameBytes: 1024 * 1024,
    daemonVersion: "test",
    hermesMinimumVersion: "0.15.1",
    hermesMaximumExclusiveVersion: "0.15.2",
    bridgeImplementation: "livis-hermes-bridge",
    bridgeMinimumVersion: "0.1.0",
    bridgeMaximumExclusiveVersion: "0.2.0",
  }, handlers, new Logger("test.offline-guard", "error"));
}

describe("离线与 profile 操作 guard", () => {
  let directory: Awaited<ReturnType<typeof temporaryDirectory>>;

  beforeEach(async () => {
    directory = await temporaryDirectory("livis-offline-guard-test-");
  });

  afterEach(async () => {
    await directory.cleanup();
  });

  test("profile operation guard 独占、权限为 0600，且 release 删除自己的 guard", async () => {
    const guard = await ProfileOperationGuard.acquire(
      directory.path,
      "protocol-profile-migration",
    );

    expect(guard.path).toBe(join(await realpath(directory.path), "profile-operation.guard"));
    expect((await stat(guard.path)).mode & 0o777).toBe(0o600);
    await expect(ProfileOperationGuard.acquire(
      directory.path,
      "upstream-check",
    )).rejects.toThrow("profile operation guard 已存在");

    await guard.release();
    expect(await Bun.file(guard.path).exists()).toBeFalse();
    await guard.release();
  });

  test("极端 umask 下两种 guard 仍固定 0600 并可正常校验释放", async () => {
    const guardUrl = new URL("../src/state/offline-guard.ts", import.meta.url).href;
    await runBunEval(`
      import { chmod, open, rm, stat } from "node:fs/promises";
      import { join } from "node:path";
      import { DaemonOfflineGuard, ProfileOperationGuard } from ${JSON.stringify(guardUrl)};
      const stateDir = ${JSON.stringify(directory.path)};
      const previousUmask = process.umask(0o777);
      let profileGuard = null;
      let offlineGuard = null;
      try {
        profileGuard = await ProfileOperationGuard.acquire(
          stateDir,
          "protocol-profile-migration",
        );
        offlineGuard = await DaemonOfflineGuard.acquire(
          join(stateDir, "umask-connector.sock"),
          stateDir,
          "protocol-profile-migration",
        );
        if (((await stat(profileGuard.path)).mode & 0o777) !== 0o600) {
          throw new Error("profile guard 未固定为 0600");
        }
        if (((await stat(offlineGuard.path)).mode & 0o777) !== 0o600) {
          throw new Error("offline guard 未固定为 0600");
        }
        await profileGuard.assertHeld();
        await offlineGuard.assertHeld();

        await chmod(profileGuard.path, 0o400);
        let assertRejected = false;
        let releaseRejected = false;
        try {
          await profileGuard.assertHeld();
        } catch (error) {
          assertRejected = String(error).includes("类型、权限或 inode 已变化");
        }
        try {
          await profileGuard.release();
        } catch (error) {
          releaseRejected = String(error).includes("类型、权限或 inode 已变化");
        }
        if (!assertRejected || !releaseRejected || !await Bun.file(profileGuard.path).exists()) {
          throw new Error("guard 权限漂移未保持 fail closed");
        }
        await chmod(profileGuard.path, 0o600);

        await offlineGuard.release();
        await profileGuard.release();
        if (
          await Bun.file(offlineGuard.path).exists() ||
          await Bun.file(profileGuard.path).exists()
        ) {
          throw new Error("guard release 后仍残留文件");
        }

        const probePath = join(stateDir, "file-handle-prototype-probe");
        const probeHandle = await open(probePath, "wx", 0o600);
        const fileHandlePrototype = Object.getPrototypeOf(probeHandle);
        const originalChmod = fileHandlePrototype.chmod;
        await probeHandle.close();
        await rm(probePath);
        let injectedFailureObserved = false;
        try {
          fileHandlePrototype.chmod = async () => {
            throw new Error("injected guard fchmod failure");
          };
          await ProfileOperationGuard.acquire(stateDir, "upstream-check");
        } catch (error) {
          injectedFailureObserved = String(error).includes("injected guard fchmod failure");
        } finally {
          fileHandlePrototype.chmod = originalChmod;
        }
        if (
          !injectedFailureObserved ||
          await Bun.file(join(stateDir, "profile-operation.guard")).exists()
        ) {
          throw new Error("guard fchmod 失败后遗留了创建中的 guard");
        }
      } finally {
        process.umask(previousUmask);
        for (const guard of [offlineGuard, profileGuard]) {
          if (!guard) continue;
          await chmod(guard.path, 0o600).catch(() => undefined);
          await guard.release().catch(() => undefined);
          await rm(guard.path, { force: true }).catch(() => undefined);
        }
      }
    `, "极端 umask guard 生命周期");
  });

  test("login 与 serve-start 也使用同一 profile operation guard 格式", async () => {
    for (const operation of ["login", "serve-start"] as const) {
      const guard = await ProfileOperationGuard.acquire(directory.path, operation);
      await guard.assertHeld();
      await guard.release();
    }
  });

  test("work 与 guard release 同时失败时保留主错误、顺序和 fail-closed guard", async () => {
    const guard = await ProfileOperationGuard.acquire(directory.path, "upstream-activate");
    const primaryError = new Error(
      `profile 激活失败；配置备份：${join(directory.path, "config-backups", "backup.json")}`,
    );
    let failure: unknown;
    try {
      await withProfileOperationGuardRelease(guard, "upstream activate", async () => {
        await chmod(guard.path, 0o400);
        throw primaryError;
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ProfileOperationGuardFinalizationError);
    const aggregate = failure as ProfileOperationGuardFinalizationError;
    expect(aggregate.errors[0]).toBe(primaryError);
    expect(aggregate.errors[1]).toBeInstanceOf(Error);
    expect(aggregate.message).toContain(primaryError.message);
    expect(aggregate.message).toContain(guard.path);
    expect(aggregate.message).toContain("类型、权限或 inode 已变化");
    expect(await Bun.file(guard.path).exists()).toBeTrue();

    await chmod(guard.path, 0o600);
    await guard.release();
  });

  test("work 成功但 guard release 失败时原样报告 release 错误", async () => {
    const guard = await ProfileOperationGuard.acquire(directory.path, "upstream-rollback");
    let failure: unknown;
    try {
      await withProfileOperationGuardRelease(guard, "upstream rollback", async () => {
        await chmod(guard.path, 0o400);
        return "ok";
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ProfileOperationGuardFinalizationError);
    expect((failure as Error).message).toContain("类型、权限或 inode 已变化");
    expect(await Bun.file(guard.path).exists()).toBeTrue();

    await chmod(guard.path, 0o600);
    await guard.release();
  });

  test("serve 启动的同步 stop 与异步 guard release 失败按固定顺序聚合", async () => {
    const primaryError = new Error("synthetic serve startup failure");
    const stopError = new Error("synthetic synchronous daemon stop failure");
    const releaseError = new Error("synthetic asynchronous guard release failure");
    const cleanupOrder: string[] = [];
    let failure: unknown;
    try {
      await rethrowAfterProfileOperationCleanup("serve 启动", primaryError, [
        {
          label: "daemon stop",
          run: () => {
            cleanupOrder.push("daemon stop");
            throw stopError;
          },
        },
        {
          label: "profile operation guard release",
          run: async () => {
            cleanupOrder.push("profile operation guard release");
            throw releaseError;
          },
        },
      ]);
    } catch (error) {
      failure = error;
    }

    expect(cleanupOrder).toEqual(["daemon stop", "profile operation guard release"]);
    expect(failure).toBeInstanceOf(ProfileOperationCleanupError);
    const aggregate = failure as ProfileOperationCleanupError;
    expect(aggregate.errors).toEqual([primaryError, stopError, releaseError]);
    expect(aggregate.cleanupFailures.map(({ label }) => label)).toEqual([
      "daemon stop",
      "profile operation guard release",
    ]);
    expect(aggregate.message).toContain(primaryError.message);
  });

  test("serve 启动清理全部成功时原样抛出 primary error", async () => {
    const primaryError = new Error("synthetic primary only");
    let failure: unknown;
    try {
      await rethrowAfterProfileOperationCleanup("serve 启动", primaryError, [
        { label: "daemon stop", run: () => undefined },
        { label: "profile operation guard release", run: async () => undefined },
      ]);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBe(primaryError);
  });

  test("release 只删除 nonce 属于自己的 guard", async () => {
    const guard = await ProfileOperationGuard.acquire(
      directory.path,
      "protocol-profile-migration",
    );
    const replacement = JSON.parse(await readFile(guard.path, "utf8")) as Record<string, unknown>;
    replacement.nonce = "other-owner-nonce";
    await writeFile(guard.path, `${JSON.stringify(replacement, null, 2)}\n`, "utf8");

    await expect(guard.release()).rejects.toThrow("所有权已变化");
    expect(await Bun.file(guard.path).exists()).toBeTrue();
    expect(JSON.parse(await readFile(guard.path, "utf8")).nonce).toBe("other-owner-nonce");
  });

  test("崩溃遗留和被篡改的 guard 均保持 fail closed", async () => {
    const crashedGuard = await ProfileOperationGuard.acquire(
      directory.path,
      "protocol-profile-migration-rollback",
    );

    await expect(ProfileOperationGuard.acquire(
      directory.path,
      "protocol-profile-migration",
    )).rejects.toThrow("profile operation guard 已存在");
    expect(await Bun.file(crashedGuard.path).exists()).toBeTrue();

    await writeFile(crashedGuard.path, "not-a-valid-guard\n", "utf8");
    await expect(crashedGuard.release()).rejects.toThrow();
    expect(await Bun.file(crashedGuard.path).exists()).toBeTrue();
    await expect(ProfileOperationGuard.acquire(
      directory.path,
      "upstream-activate",
    )).rejects.toThrow("profile operation guard 已存在");
  });

  test("普通离线 guard 独占 socket 路径并阻止 ConnectorServer 启动", async () => {
    const socketPath = join(directory.path, "connector.sock");
    const guard = await DaemonOfflineGuard.acquire(
      socketPath,
      directory.path,
      "protocol-profile-migration",
    );

    expect((await lstat(socketPath)).isFile()).toBeTrue();
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    await expect(DaemonOfflineGuard.acquire(
      socketPath,
      directory.path,
      "protocol-profile-migration-rollback",
    )).rejects.toThrow("connector socket 路径已存在");

    const server = connectorServer(socketPath);
    expect(() => server.start()).toThrow("connector socket 路径已存在且不是 socket");
    expect(await Bun.file(socketPath).exists()).toBeTrue();

    await guard.assertHeld();
    await guard.release();
    expect(await Bun.file(socketPath).exists()).toBeFalse();
  });

  test("guard 父目录必须私有，connector socket 还必须位于 stateDir 内", async () => {
    const unsafeState = join(directory.path, "unsafe-state");
    await mkdir(unsafeState, { mode: 0o700 });
    await chmod(unsafeState, 0o777);
    await expect(ProfileOperationGuard.acquire(
      unsafeState,
      "protocol-profile-migration",
    )).rejects.toThrow("权限过宽");

    const externalDirectory = join(directory.path, "external-socket");
    await mkdir(externalDirectory, { mode: 0o700 });
    await expect(DaemonOfflineGuard.acquire(
      join(externalDirectory, "connector.sock"),
      unsafeState,
      "protocol-profile-migration",
    )).rejects.toThrow("offline guard stateDir 权限过宽");
    await chmod(unsafeState, 0o700);
    await expect(DaemonOfflineGuard.acquire(
      join(externalDirectory, "connector.sock"),
      unsafeState,
      "protocol-profile-migration",
    )).rejects.toThrow("必须位于私有 stateDir 内");

    const actualSocketDirectory = join(unsafeState, "actual-socket-directory");
    const linkedSocketDirectory = join(unsafeState, "linked-socket-directory");
    await mkdir(actualSocketDirectory, { mode: 0o700 });
    await symlink(actualSocketDirectory, linkedSocketDirectory);
    await expect(DaemonOfflineGuard.acquire(
      join(linkedSocketDirectory, "connector.sock"),
      unsafeState,
      "protocol-profile-migration",
    )).rejects.toThrow("connector socket parent directory 必须是目录且不能是 symlink");
  });

  test("获取后父目录权限漂移会在 assert 与 release 时失败关闭", async () => {
    const driftedState = join(directory.path, "drifted-state");
    await mkdir(driftedState, { mode: 0o700 });
    const guard = await ProfileOperationGuard.acquire(
      driftedState,
      "protocol-profile-migration",
    );

    await chmod(driftedState, 0o777);
    await expect(guard.assertHeld()).rejects.toThrow("guard parent directory 权限过宽");
    await expect(guard.release()).rejects.toThrow("guard parent directory 权限过宽");
    expect(await Bun.file(guard.path).exists()).toBeTrue();

    await chmod(driftedState, 0o700);
    await guard.release();
    expect(await Bun.file(guard.path).exists()).toBeFalse();
  });

  test("两种 guard 遇到 inode 替换或 symlink 时拒绝删除替代文件", async () => {
    const replaced = await ProfileOperationGuard.acquire(
      directory.path,
      "protocol-profile-migration",
    );
    const copiedDocument = await readFile(replaced.path, "utf8");
    // 刻意保留原 nonce：实现必须靠长持有的创建句柄固定 inode，而不是内容变化识别替换。
    await rm(replaced.path);
    await writeFile(replaced.path, copiedDocument, { encoding: "utf8", mode: 0o600 });
    await expect(replaced.assertHeld()).rejects.toThrow("inode 已变化");
    await expect(replaced.release()).rejects.toThrow("inode 已变化");
    expect(await readFile(replaced.path, "utf8")).toBe(copiedDocument);
    await rm(replaced.path);

    const socketPath = join(directory.path, "replaced-connector.sock");
    const offline = await DaemonOfflineGuard.acquire(
      socketPath,
      directory.path,
      "protocol-profile-migration",
    );
    const copiedOfflineDocument = await readFile(offline.path, "utf8");
    await rm(offline.path);
    await writeFile(offline.path, copiedOfflineDocument, { encoding: "utf8", mode: 0o600 });
    await expect(offline.assertHeld()).rejects.toThrow("inode 已变化");
    await expect(offline.release()).rejects.toThrow("inode 已变化");
    expect(await readFile(offline.path, "utf8")).toBe(copiedOfflineDocument);
    await rm(offline.path);

    const linked = await ProfileOperationGuard.acquire(
      directory.path,
      "protocol-profile-migration",
    );
    const target = join(directory.path, "replacement-target");
    await writeFile(target, "must survive\n", { encoding: "utf8", mode: 0o600 });
    await rm(linked.path);
    await symlink(target, linked.path);
    await expect(linked.release()).rejects.toThrow("类型、权限或 inode 已变化");
    expect(await readFile(target, "utf8")).toBe("must survive\n");
    expect((await lstat(linked.path)).isSymbolicLink()).toBeTrue();
  });

  test("profile guard 路径被换成 FIFO 时 assert/release 有界失败且不删除替代项", async () => {
    const guard = await ProfileOperationGuard.acquire(
      directory.path,
      "upstream-activate",
    );
    await rm(guard.path);
    await createFifo(guard.path);

    await expect(guard.assertHeld()).rejects.toThrow("类型、权限或 inode 已变化");
    await expect(guard.release()).rejects.toThrow("类型、权限或 inode 已变化");
    expect((await lstat(guard.path)).isFIFO()).toBeTrue();
    await rm(guard.path);
  }, 2_000);
});
