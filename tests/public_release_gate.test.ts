import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  auditRepository,
  auditTrackedPath,
  auditTrackedText,
} from "../scripts/check-public-release.ts";
import { WIRE_CONTRACT_REGISTRY_PATH } from "../src/protocol/contract-registry.ts";

const temporaryDirectories: string[] = [];
const TEST_REVISION = "test-wire-r1";
const TEST_ARTIFACT_PATH = `protocol-probes/local/${TEST_REVISION}.json`;

function publicProbeArtifact(revision = TEST_REVISION, credentialMode = "access-token-only"): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    evidenceLevel: "S2",
    disclaimer: "只证明固定假数据下的本地行为。",
    contract: {
      wireProtocolVersion: 1,
      wireContractRevision: revision,
      credentialMode,
    },
    safety: {
      network: "loopback-only",
      credentials: "fixed-sentinel-only",
      liveProfileRead: false,
      rawFramePersistence: false,
    },
    relay: {},
    idaas: {},
    unknowns: ["真实服务端行为"],
  }, null, 2)}\n`;
}

function registryText(artifact: string, overrides: Record<string, unknown> = {}): string {
  const definition = {
    revision: TEST_REVISION,
    credentialMode: "access-token-only",
    wireProtocolVersion: 1,
    localProbeArtifactPath: TEST_ARTIFACT_PATH,
    localProbeArtifactSha256: new Bun.CryptoHasher("sha256").update(artifact).digest("hex"),
    ...overrides,
  };
  return `${JSON.stringify({
    schemaVersion: 1,
    currentRevision: TEST_REVISION,
    contracts: [definition],
  }, null, 2)}\n`;
}

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
      "protocol-probes/receipts/probe.private.json",
      "protocol-probes/raw-frames.json",
      "protocol-probes/capture.pcapng",
      "protocol-probes/receipts/probe.json",
      "protocol-probes/local/extra.json",
      "protocol-probes/receipts/renamed-receipt.txt",
      "livis-pc-kit-tokens.json",
      "state.json",
      "state/relay.data",
    ];
    for (const path of forbidden) {
      expect(auditTrackedPath(path).length, path).toBeGreaterThan(0);
    }
    expect(auditTrackedPath(".env.example")).toEqual([]);
    expect(auditTrackedPath("src/upstream/checker.ts")).toEqual([]);
    const registeredPath = "protocol-probes/local/livis-relay-v1-access-refresh-r1.json";
    expect(auditTrackedPath(registeredPath).some((item) => item.rule === "unregistered-probe-artifact")).toBeTrue();
    expect(auditTrackedPath(registeredPath, new Set([registeredPath]))).toEqual([]);
    expect(auditTrackedPath("Protocol-Probes/local/livis-relay-v1-access-refresh-r1.json", new Set([registeredPath]))
      .some((item) => item.rule === "unregistered-probe-artifact")).toBeTrue();
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

  test("只允许 registry 精确登记且 SHA 与 contract 一致的公开 probe artifact", async () => {
    const artifact = publicProbeArtifact();
    const root = await temporaryRepository({
      [WIRE_CONTRACT_REGISTRY_PATH]: registryText(artifact),
      [TEST_ARTIFACT_PATH]: artifact,
    });
    const report = await auditRepository(root);
    expect(report.findings).toEqual([]);
  });

  test("registry 存在时仍拒绝任意未登记 JSON、receipt 和大小写伪装路径", async () => {
    const artifact = publicProbeArtifact();
    const root = await temporaryRepository({
      [WIRE_CONTRACT_REGISTRY_PATH]: registryText(artifact),
      [TEST_ARTIFACT_PATH]: artifact,
      "protocol-probes/local/extra.json": "{}\n",
      "protocol-probes/receipts/result.txt": "renamed receipt\n",
    });
    const report = await auditRepository(root);
    expect(report.findings.filter((item) => item.rule === "unregistered-probe-artifact")).toHaveLength(2);
  });

  test("registry SHA 或 artifact contract 不匹配时失败关闭", async () => {
    const artifact = publicProbeArtifact("wrong-revision");
    const root = await temporaryRepository({
      [WIRE_CONTRACT_REGISTRY_PATH]: registryText(artifact, {
        localProbeArtifactSha256: "0".repeat(64),
      }),
      [TEST_ARTIFACT_PATH]: artifact,
    });
    const report = await auditRepository(root);
    expect(report.findings.some((item) => item.rule === "probe-artifact-sha256")).toBeTrue();

    const matchingShaRoot = await temporaryRepository({
      [WIRE_CONTRACT_REGISTRY_PATH]: registryText(artifact),
      [TEST_ARTIFACT_PATH]: artifact,
    });
    const matchingShaReport = await auditRepository(matchingShaRoot);
    expect(matchingShaReport.findings.some((item) => item.rule === "probe-artifact-contract")).toBeTrue();
  });

  test("重复 revision、路径穿越或 registry 缺失时失败关闭", async () => {
    const artifact = publicProbeArtifact();
    const duplicate = JSON.parse(registryText(artifact)) as Record<string, unknown>;
    duplicate.contracts = [
      ...(duplicate.contracts as unknown[]),
      ...(duplicate.contracts as unknown[]),
    ];
    const duplicateRoot = await temporaryRepository({
      [WIRE_CONTRACT_REGISTRY_PATH]: `${JSON.stringify(duplicate)}\n`,
      [TEST_ARTIFACT_PATH]: artifact,
    });
    expect((await auditRepository(duplicateRoot)).findings.some((item) => item.rule === "probe-registry-schema")).toBeTrue();

    const traversalRoot = await temporaryRepository({
      [WIRE_CONTRACT_REGISTRY_PATH]: registryText(artifact, {
        localProbeArtifactPath: "protocol-probes/local/../receipt.json",
      }),
      [TEST_ARTIFACT_PATH]: artifact,
    });
    expect((await auditRepository(traversalRoot)).findings.some((item) => item.rule === "probe-registry-schema")).toBeTrue();

    const missingRoot = await temporaryRepository({ [TEST_ARTIFACT_PATH]: artifact });
    const missingReport = await auditRepository(missingRoot);
    expect(missingReport.findings.some((item) => item.rule === "probe-registry-missing")).toBeTrue();
  });

  test("未初始化仓库给出可理解失败", async () => {
    const root = await mkdtemp(join(tmpdir(), "livis-release-gate-uninitialized-"));
    temporaryDirectories.push(root);
    await expect(auditRepository(root)).rejects.toThrow("不是 Git 仓库");
  });
});
