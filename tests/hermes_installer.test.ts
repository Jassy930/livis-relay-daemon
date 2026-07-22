import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  HERMES_BRIDGE_FILES,
  installHermesBridge,
  listHermesInstallReceipts,
  rollbackHermesBridge,
} from "../src/install/hermes.ts";
import { temporaryDirectory } from "./helpers.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function profileFixture(): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const directory = await temporaryDirectory("livis-hermes-install-");
  cleanups.push(directory.cleanup);
  await mkdir(join(directory.path, "plugins"), { mode: 0o700 });
  await writeFile(
    join(directory.path, "config.yaml"),
    "# 保留此注释\nplugins:\n  enabled:\n    - existing-plugin\n",
    { mode: 0o600 },
  );
  return { home: directory.path, cleanup: directory.cleanup };
}

describe("Hermes bridge 原子安装", () => {
  test("安装插件、保留 YAML 注释并生成私有回滚收据", async () => {
    const { home } = await profileFixture();
    const receipt = await installHermesBridge({
      hermesHome: home,
      sourceDirectory: resolve(import.meta.dir, "../hermes-plugin"),
    });

    for (const file of HERMES_BRIDGE_FILES) {
      expect(await Bun.file(join(home, "plugins/livis-bridge", file)).exists()).toBeTrue();
    }
    const config = await readFile(join(home, "config.yaml"), "utf8");
    expect(config).toContain("# 保留此注释");
    expect(config).toContain("existing-plugin");
    expect(config).toContain("livis-bridge");
    expect((await Bun.file(receipt.backupConfigPath).text())).toContain("existing-plugin");
    expect((await lstat(receipt.receiptPath)).mode & 0o777).toBe(0o600);
    expect(receipt.priorPluginPresent).toBeFalse();
  });

  test("配置提交失败时恢复旧插件和原配置", async () => {
    const { home } = await profileFixture();
    const oldPlugin = join(home, "plugins/livis-bridge");
    await mkdir(oldPlugin, { mode: 0o700 });
    for (const file of HERMES_BRIDGE_FILES) {
      await writeFile(join(oldPlugin, file), `old-${file}\n`, { mode: 0o644 });
    }
    await writeFile(join(oldPlugin, "operator-note.txt"), "must survive rollback\n", { mode: 0o600 });
    const before = await readFile(join(home, "config.yaml"), "utf8");

    await expect(installHermesBridge({
      hermesHome: home,
      sourceDirectory: resolve(import.meta.dir, "../hermes-plugin"),
      beforeConfigCommit: () => {
        throw new Error("injected config failure");
      },
    })).rejects.toThrow("injected config failure");

    expect(await readFile(join(oldPlugin, "adapter.py"), "utf8")).toBe("old-adapter.py\n");
    expect(await readFile(join(oldPlugin, "operator-note.txt"), "utf8")).toBe("must survive rollback\n");
    expect(await readFile(join(home, "config.yaml"), "utf8")).toBe(before);
    expect(await listHermesInstallReceipts(home)).toEqual([]);
  });

  test("使用安装收据恢复旧插件和旧配置", async () => {
    const { home } = await profileFixture();
    const oldPlugin = join(home, "plugins/livis-bridge");
    await mkdir(oldPlugin, { mode: 0o700 });
    for (const file of HERMES_BRIDGE_FILES) {
      await writeFile(join(oldPlugin, file), `old-${file}\n`, { mode: 0o644 });
    }
    await writeFile(join(oldPlugin, "operator-note.txt"), "must survive rollback\n", { mode: 0o600 });
    const before = await readFile(join(home, "config.yaml"), "utf8");
    const receipt = await installHermesBridge({
      hermesHome: home,
      sourceDirectory: resolve(import.meta.dir, "../hermes-plugin"),
    });

    const rolledBack = await rollbackHermesBridge({
      hermesHome: home,
      receiptPath: receipt.receiptPath,
      acknowledgeRollback: true,
    });

    expect(rolledBack.status).toBe("rolled-back");
    expect(await readFile(join(oldPlugin, "plugin.yaml"), "utf8")).toBe("old-plugin.yaml\n");
    expect(await readFile(join(oldPlugin, "operator-note.txt"), "utf8")).toBe("must survive rollback\n");
    expect(await readFile(join(home, "config.yaml"), "utf8")).toBe(before);
    await expect(rollbackHermesBridge({
      hermesHome: home,
      receiptPath: receipt.receiptPath,
      acknowledgeRollback: true,
    })).rejects.toThrow("已经回滚");
  });

  test("安装后的人工改动会阻断回滚", async () => {
    const { home } = await profileFixture();
    const receipt = await installHermesBridge({
      hermesHome: home,
      sourceDirectory: resolve(import.meta.dir, "../hermes-plugin"),
    });
    const adapterPath = join(home, "plugins/livis-bridge/adapter.py");
    await writeFile(adapterPath, "changed-after-install\n");
    await chmod(adapterPath, 0o644);

    await expect(rollbackHermesBridge({
      hermesHome: home,
      receiptPath: receipt.receiptPath,
      acknowledgeRollback: true,
    })).rejects.toThrow("bridge 已在安装后发生变化");
  });
});
