import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkWireContractAppendOnly,
  resolveWireContractBaseRef,
} from "../scripts/check-wire-contract-append-only.ts";
import { WIRE_CONTRACT_REGISTRY_PATH } from "../src/protocol/contract-registry.ts";

interface TestContract {
  revision: string;
  credentialMode: "access-and-refresh-token" | "access-token-only";
  wireProtocolVersion: number;
  localProbeArtifactPath: string;
  localProbeArtifactSha256: string;
}

const temporaryDirectories: string[] = [];

function runGit(root: string, args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", root, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.success, new TextDecoder().decode(result.stderr)).toBeTrue();
  return new TextDecoder().decode(result.stdout).trim();
}

async function writeFiles(root: string, files: Record<string, string | null>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    if (content === null) {
      await rm(absolute, { force: true });
      continue;
    }
    await mkdir(dirname(absolute), { recursive: true });
    await Bun.write(absolute, content);
  }
}

async function repository(baseFiles: Record<string, string>): Promise<{ root: string; baseRef: string }> {
  const root = await mkdtemp(join(tmpdir(), "livis-wire-append-only-"));
  temporaryDirectories.push(root);
  runGit(root, ["init", "-q"]);
  runGit(root, ["config", "user.name", "Probe Test"]);
  runGit(root, ["config", "user.email", "probe@example.invalid"]);
  await writeFiles(root, baseFiles);
  runGit(root, ["add", "--all"]);
  runGit(root, ["commit", "-qm", "base"]);
  return { root, baseRef: runGit(root, ["rev-parse", "HEAD"]) };
}

function artifactText(
  revision: string,
  credentialMode: TestContract["credentialMode"],
  marker = "baseline",
): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    evidenceLevel: "S2",
    disclaimer: "仅用于 append-only 测试。",
    contract: { wireProtocolVersion: 1, wireContractRevision: revision, credentialMode },
    safety: {
      network: "loopback-only",
      credentials: "fixed-sentinel-only",
      liveProfileRead: false,
      rawFramePersistence: false,
    },
    relay: { marker },
    idaas: {},
    unknowns: [],
  }, null, 2)}\n`;
}

function contractFor(
  revision: string,
  credentialMode: TestContract["credentialMode"],
  artifact: string,
): TestContract {
  return {
    revision,
    credentialMode,
    wireProtocolVersion: 1,
    localProbeArtifactPath: `protocol-probes/local/${revision}.json`,
    localProbeArtifactSha256: new Bun.CryptoHasher("sha256").update(artifact).digest("hex"),
  };
}

function registryText(currentRevision: string, contracts: TestContract[]): string {
  return `${JSON.stringify({ schemaVersion: 1, currentRevision, contracts }, null, 2)}\n`;
}

function contractFiles(
  currentRevision: string,
  definitions: Array<{ revision: string; credentialMode: TestContract["credentialMode"]; artifact: string }>,
): Record<string, string> {
  const contracts = definitions.map((item) => contractFor(item.revision, item.credentialMode, item.artifact));
  return {
    [WIRE_CONTRACT_REGISTRY_PATH]: registryText(currentRevision, contracts),
    ...Object.fromEntries(contracts.map((contract, index) => [
      contract.localProbeArtifactPath,
      definitions[index]!.artifact,
    ])),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("wire contract append-only 门禁", () => {
  test("首次建立要求显式 bootstrap，且基线必须没有任何 protocol-probes 文件", async () => {
    const { root, baseRef } = await repository({ "README.md": "# base\n" });
    const artifact = artifactText("wire-r1", "access-and-refresh-token");
    await writeFiles(root, contractFiles("wire-r1", [
      { revision: "wire-r1", credentialMode: "access-and-refresh-token", artifact },
    ]));
    runGit(root, ["add", "--all"]);
    expect(() => checkWireContractAppendOnly(root, baseRef)).toThrow("--allow-bootstrap");
    expect(checkWireContractAppendOnly(root, baseRef, { allowBootstrap: true })).toMatchObject({
      bootstrap: true,
      inheritedRevisions: [],
      addedRevisions: ["wire-r1"],
    });

    const legacy = await repository({ "protocol-probes/local/legacy.json": "{}\n" });
    await writeFiles(legacy.root, contractFiles("wire-r1", [
      { revision: "wire-r1", credentialMode: "access-and-refresh-token", artifact },
    ]));
    runGit(legacy.root, ["add", "--all"]);
    expect(() => checkWireContractAppendOnly(legacy.root, legacy.baseRef, { allowBootstrap: true }))
      .toThrow("已存在 protocol-probes/ 文件");
  });

  test("完整保留旧 revision 时允许新增 revision 并切换 current 指针", async () => {
    const r1 = artifactText("wire-r1", "access-and-refresh-token");
    const baseFiles = contractFiles("wire-r1", [
      { revision: "wire-r1", credentialMode: "access-and-refresh-token", artifact: r1 },
    ]);
    const { root, baseRef } = await repository(baseFiles);
    const r2 = artifactText("wire-r2", "access-token-only", "new-revision");
    await writeFiles(root, contractFiles("wire-r2", [
      { revision: "wire-r1", credentialMode: "access-and-refresh-token", artifact: r1 },
      { revision: "wire-r2", credentialMode: "access-token-only", artifact: r2 },
    ]));
    runGit(root, ["add", "--all"]);
    expect(checkWireContractAppendOnly(root, baseRef)).toMatchObject({
      bootstrap: false,
      inheritedRevisions: ["wire-r1"],
      addedRevisions: ["wire-r2"],
    });
  });

  test("拒绝 dormant 新 artifact：bootstrap 只能一个，后续新增必须唯一且成为 current", async () => {
    const r1 = artifactText("wire-r1", "access-and-refresh-token");
    const r2 = artifactText("wire-r2", "access-token-only");
    const r3 = artifactText("wire-r3", "access-token-only", "dormant-private-payload");

    const bootstrap = await repository({ "README.md": "# base\n" });
    await writeFiles(bootstrap.root, contractFiles("wire-r1", [
      { revision: "wire-r1", credentialMode: "access-and-refresh-token", artifact: r1 },
      { revision: "wire-r2", credentialMode: "access-token-only", artifact: r2 },
    ]));
    runGit(bootstrap.root, ["add", "--all"]);
    expect(() => checkWireContractAppendOnly(bootstrap.root, bootstrap.baseRef, { allowBootstrap: true }))
      .toThrow("只能登记一个");

    const base = await repository(contractFiles("wire-r1", [
      { revision: "wire-r1", credentialMode: "access-and-refresh-token", artifact: r1 },
    ]));
    await writeFiles(base.root, contractFiles("wire-r1", [
      { revision: "wire-r1", credentialMode: "access-and-refresh-token", artifact: r1 },
      { revision: "wire-r2", credentialMode: "access-token-only", artifact: r2 },
    ]));
    runGit(base.root, ["add", "--all"]);
    expect(() => checkWireContractAppendOnly(base.root, base.baseRef)).toThrow("必须成为 current");

    await writeFiles(base.root, contractFiles("wire-r2", [
      { revision: "wire-r1", credentialMode: "access-and-refresh-token", artifact: r1 },
      { revision: "wire-r2", credentialMode: "access-token-only", artifact: r2 },
      { revision: "wire-r3", credentialMode: "access-token-only", artifact: r3 },
    ]));
    runGit(base.root, ["add", "--all"]);
    expect(() => checkWireContractAppendOnly(base.root, base.baseRef)).toThrow("最多新增一个");
  });

  test("没有新增 revision 时禁止把 current 指针切到既有历史 revision", async () => {
    const r1 = artifactText("wire-r1", "access-and-refresh-token");
    const r2 = artifactText("wire-r2", "access-token-only");
    const baseFiles = contractFiles("wire-r2", [
      { revision: "wire-r1", credentialMode: "access-and-refresh-token", artifact: r1 },
      { revision: "wire-r2", credentialMode: "access-token-only", artifact: r2 },
    ]);
    const { root, baseRef } = await repository(baseFiles);
    await writeFiles(root, {
      [WIRE_CONTRACT_REGISTRY_PATH]: registryText("wire-r1", [
        contractFor("wire-r1", "access-and-refresh-token", r1),
        contractFor("wire-r2", "access-token-only", r2),
      ]),
    });
    runGit(root, ["add", "--all"]);
    expect(() => checkWireContractAppendOnly(root, baseRef)).toThrow("禁止切换 currentRevision");
  });

  test("删除或原地修改旧 definition 均失败", async () => {
    const r1 = artifactText("wire-r1", "access-and-refresh-token");
    const r2 = artifactText("wire-r2", "access-token-only");
    const { root, baseRef } = await repository(contractFiles("wire-r1", [
      { revision: "wire-r1", credentialMode: "access-and-refresh-token", artifact: r1 },
    ]));

    await writeFiles(root, {
      ...contractFiles("wire-r2", [
        { revision: "wire-r2", credentialMode: "access-token-only", artifact: r2 },
      ]),
      "protocol-probes/local/wire-r1.json": null,
    });
    runGit(root, ["add", "--all"]);
    expect(() => checkWireContractAppendOnly(root, baseRef)).toThrow("禁止删除既有 wire contract revision");

    await writeFiles(root, contractFiles("wire-r1", [
      { revision: "wire-r1", credentialMode: "access-token-only", artifact: artifactText("wire-r1", "access-token-only") },
    ]));
    await rm(join(root, "protocol-probes/local/wire-r2.json"), { force: true });
    runGit(root, ["add", "--all"]);
    expect(() => checkWireContractAppendOnly(root, baseRef)).toThrow("禁止原地修改既有 wire contract definition");
  });

  test("旧 artifact 即使只改变空白也失败，未 staged 工作区变化不影响 index 审计", async () => {
    const r1 = artifactText("wire-r1", "access-and-refresh-token");
    const { root, baseRef } = await repository(contractFiles("wire-r1", [
      { revision: "wire-r1", credentialMode: "access-and-refresh-token", artifact: r1 },
    ]));
    runGit(root, ["add", "--all"]);
    await Bun.write(join(root, "protocol-probes/local/wire-r1.json"), `${r1}\n`);
    expect(checkWireContractAppendOnly(root, baseRef).inheritedRevisions).toEqual(["wire-r1"]);
    runGit(root, ["add", "--all"]);
    expect(() => checkWireContractAppendOnly(root, baseRef)).toThrow("SHA-256 不匹配");
  });

  test("新 artifact 缺失、contract 不匹配或 base ref 不可读时失败关闭", async () => {
    const r1 = artifactText("wire-r1", "access-and-refresh-token");
    const { root, baseRef } = await repository({ "README.md": "# base\n" });
    const files = contractFiles("wire-r1", [
      { revision: "wire-r1", credentialMode: "access-and-refresh-token", artifact: r1 },
    ]);
    delete files["protocol-probes/local/wire-r1.json"];
    await writeFiles(root, files);
    runGit(root, ["add", "--all"]);
    expect(() => checkWireContractAppendOnly(root, baseRef, { allowBootstrap: true })).toThrow("候选 artifact");

    const wrongContract = artifactText("wire-other", "access-and-refresh-token");
    await writeFiles(root, contractFiles("wire-r1", [
      { revision: "wire-r1", credentialMode: "access-and-refresh-token", artifact: wrongContract },
    ]));
    runGit(root, ["add", "--all"]);
    expect(() => checkWireContractAppendOnly(root, baseRef, { allowBootstrap: true }))
      .toThrow("artifact contract 与 registry 不一致");
    expect(() => checkWireContractAppendOnly(root, "missing-base", { allowBootstrap: true }))
      .toThrow("基线不是可读取的 commit");
  });

  test("base resolver 对显式空值、全零值和无 remote 仓库失败关闭", async () => {
    const { root } = await repository({ "README.md": "# base\n" });
    expect(() => resolveWireContractBaseRef(root, { WIRE_CONTRACT_BASE_REF: "" }))
      .toThrow("禁止为空");
    expect(() => resolveWireContractBaseRef(root, { WIRE_CONTRACT_BASE_REF: "0".repeat(40) }))
      .toThrow("全零");
    expect(() => resolveWireContractBaseRef(root, {})).toThrow("无法从 remote default branch");
  });
});
