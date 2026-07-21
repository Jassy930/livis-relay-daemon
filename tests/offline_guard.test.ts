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
import { DaemonOfflineGuard, ProfileOperationGuard } from "../src/state/offline-guard.ts";
import { temporaryDirectory } from "./helpers.ts";

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

  test("login 与 serve-start 也使用同一 profile operation guard 格式", async () => {
    for (const operation of ["login", "serve-start"] as const) {
      const guard = await ProfileOperationGuard.acquire(directory.path, operation);
      await guard.assertHeld();
      await guard.release();
    }
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

  test("release 遇到 inode 替换或 symlink 时拒绝删除替代文件", async () => {
    const replaced = await ProfileOperationGuard.acquire(
      directory.path,
      "protocol-profile-migration",
    );
    const copiedDocument = await readFile(replaced.path, "utf8");
    await rm(replaced.path);
    await writeFile(replaced.path, copiedDocument, { encoding: "utf8", mode: 0o600 });
    await expect(replaced.assertHeld()).rejects.toThrow("inode 已变化");
    await expect(replaced.release()).rejects.toThrow("inode 已变化");
    expect(await readFile(replaced.path, "utf8")).toBe(copiedDocument);
    await rm(replaced.path);

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
});
