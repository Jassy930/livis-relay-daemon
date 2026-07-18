import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  auditRepository,
  auditTrackedPath,
  auditTrackedText,
} from "../scripts/check-public-release.ts";

const temporaryDirectories: string[] = [];

async function temporaryRepository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "livis-release-gate-"));
  temporaryDirectories.push(root);
  const initialized = Bun.spawnSync({ cmd: ["git", "init", "-q", root], stdout: "pipe", stderr: "pipe" });
  expect(initialized.success).toBeTrue();
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await Bun.write(absolute, content);
  }
  const added = Bun.spawnSync({ cmd: ["git", "-C", root, "add", "--all"], stdout: "pipe", stderr: "pipe" });
  expect(added.success).toBeTrue();
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("公开发布 tracked-files 门禁", () => {
  test("覆盖必须拒绝的文件名与状态目录", () => {
    const forbidden = [
      "protocol-profiles/live.local.json",
      "relay.db",
      "relay.db-wal",
      "relay.db-shm",
      "daemon.log",
      "client.pem",
      "private.key",
      ".env",
      ".env.production",
      "vendor/bundle.js",
      "release.tar.gz",
      "release.zip",
      "upstream-artifacts/package.bin",
      "livis-pc-kit-tokens.json",
      "state.json",
      "state/relay.data",
    ];
    for (const path of forbidden) {
      expect(auditTrackedPath(path).length, path).toBeGreaterThan(0);
    }
    expect(auditTrackedPath(".env.example")).toEqual([]);
    expect(auditTrackedPath("src/upstream/checker.ts")).toEqual([]);
  });

  test("只审核 git ls-files 的 index blob，不扫描未 tracked 本地文件", async () => {
    const root = await temporaryRepository({
      "README.md": "# 测试\n",
      "src/config.ts": "export const endpoint = 'https://relay.example.invalid';\n",
    });
    const productionHost = ["li-center", "lixiang", "com"].join(".");
    await Bun.write(join(root, ".env"), `TOKEN=local-only\nHOST=${productionHost}\n`);
    const report = await auditRepository(root);
    expect(report.trackedFiles).toBe(2);
    expect(report.findings).toEqual([]);
  });

  test("生产域名拒绝运行时文件，但允许安全文档说明", () => {
    const host = ["li-center", "lixiang", "com"].join(".");
    expect(auditTrackedText("src/config.ts", `const host = '${host}';`)
      .some((item) => item.rule === "production-domain")).toBeTrue();
    expect(auditTrackedText("docs/SECURITY.md", `禁止连接 ${host}`)
      .some((item) => item.rule === "production-domain")).toBeFalse();
  });

  test("用 SHA-256 指纹识别 OAuth client identity，不需要保存原值", () => {
    const fakeIdentity = "fixture-only-oauth-client";
    const fingerprint = new Bun.CryptoHasher("sha256").update(fakeIdentity).digest("hex");
    const findings = auditTrackedText(
      "config/profile.json",
      JSON.stringify({ oauth: { clientId: fakeIdentity } }),
      { oauthClientFingerprints: new Set([fingerprint]) },
    );
    expect(findings.some((item) => item.rule === "official-oauth-client")).toBeTrue();
  });

  test("未初始化仓库给出可理解失败", async () => {
    const root = await mkdtemp(join(tmpdir(), "livis-release-gate-uninitialized-"));
    temporaryDirectories.push(root);
    await expect(auditRepository(root)).rejects.toThrow("不是 Git 仓库");
  });
});
