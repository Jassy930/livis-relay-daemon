#!/usr/bin/env bun

import { resolve } from "node:path";
import {
  installHermesBridge,
  listHermesInstallReceipts,
  rollbackHermesBridge,
} from "../src/install/hermes.ts";

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(): string {
  return [
    "用法：",
    "  bun run install:hermes -- install --hermes-home /绝对路径",
    "  bun run install:hermes -- receipts --hermes-home /绝对路径",
    "  bun run install:hermes -- rollback --hermes-home /绝对路径 --receipt /绝对路径 --acknowledge-rollback",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2).filter((value) => value !== "--");
  const command = args[0];
  const hermesHome = optionValue(args, "--hermes-home");
  if (!hermesHome) throw new Error(`必须显式传入 --hermes-home\n${usage()}`);
  if (command === "install") {
    const receipt = await installHermesBridge({
      hermesHome: resolve(hermesHome),
      sourceDirectory: resolve(import.meta.dir, "../hermes-plugin"),
    });
    process.stdout.write(`${JSON.stringify({
      status: receipt.status,
      pluginVersion: receipt.pluginVersion,
      receiptPath: receipt.receiptPath,
      restartPerformed: false,
      next: "人工检查专用 profile 配置后，再由操作者重启 Hermes Gateway",
    }, null, 2)}\n`);
    return;
  }
  if (command === "receipts") {
    process.stdout.write(`${JSON.stringify({ receipts: await listHermesInstallReceipts(hermesHome) }, null, 2)}\n`);
    return;
  }
  if (command === "rollback") {
    const receiptPath = optionValue(args, "--receipt");
    if (!receiptPath) throw new Error(`rollback 必须传入 --receipt\n${usage()}`);
    const receipt = await rollbackHermesBridge({
      hermesHome: resolve(hermesHome),
      receiptPath: resolve(receiptPath),
      acknowledgeRollback: args.includes("--acknowledge-rollback"),
    });
    process.stdout.write(`${JSON.stringify({
      status: receipt.status,
      receiptPath: receipt.receiptPath,
      preRollbackBackupPath: receipt.preRollbackBackupPath,
      restartPerformed: false,
      next: "人工核对回滚结果后，再由操作者重启 Hermes Gateway",
    }, null, 2)}\n`);
    return;
  }
  throw new Error(usage());
}

await main().catch((error: unknown) => {
  process.stderr.write(`Hermes bridge 安装操作失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
