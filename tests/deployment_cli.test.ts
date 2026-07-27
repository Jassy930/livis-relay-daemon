import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dir, "..");

async function runCli(args: string[]) {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
    cwd: PROJECT_ROOT,
    env: {},
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("部署安装器 CLI", () => {
  test("help 暴露五个操作及显式确认参数", async () => {
    const result = await runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("deploy plan");
    expect(result.stdout).toContain("deploy install|upgrade");
    expect(result.stdout).toContain("deploy rollback");
    expect(result.stdout).toContain("deploy uninstall");
    expect(result.stdout).toContain("--acknowledge-service-restart");
  });

  test("plan 缺少固定 manifest 输入时失败且不降级到 checkout", async () => {
    const result = await runCli(["deploy", "plan"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("必须传入 --manifest 与 --manifest-sha256");
    expect(result.stdout).toBe("");
  });

  test("deploy 拒绝未知 backend 覆盖和拼写错误参数", async () => {
    const result = await runCli(["deploy", "plan", "--backend", "claude"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("未知参数：--backend");
  });

  test("rollback 与 uninstall 不接受缺失的显式写入确认", async () => {
    const rollback = await runCli(["deploy", "rollback"]);
    expect(rollback.exitCode).toBe(1);
    expect(rollback.stderr).toContain("必须传入 --receipt");

    const uninstall = await runCli(["deploy", "uninstall", "--install-root", "/definitely/missing"]);
    expect(uninstall.exitCode).toBe(1);
    expect(uninstall.stderr).toContain("必须显式传入 --apply");
  });
});
