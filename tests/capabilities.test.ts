import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { validateCapabilityManifest } from "../src/capabilities.ts";

const root = resolve(import.meta.dir, "..");

describe("机器可读能力契约", () => {
  test("当前 manifest 通过严格 schema 和引用检查", async () => {
    const result = await validateCapabilityManifest(root);
    expect(result.manifest.package.version).toBe("0.1.1");
    expect(result.manifest.package.phase).toBe("phase1-multi-backend");
    expect(result.manifest.topology.relayStateOwner).toBe("livis-relayd");
    expect(result.referencedPaths).toContain("docs/HERMES-CANARY.md");
    expect(result.referencedPaths).toContain("docs/CODEX-E2E-CANARY.md");
  });

  test("拒绝 schema 之外的字段", async () => {
    const manifest = await Bun.file(resolve(root, "capabilities.json")).json() as Record<string, unknown>;
    const invalid = structuredClone(manifest);
    invalid.unreviewed = true;
    await expect(validateCapabilityManifest(root, invalid)).rejects.toThrow("不符合 JSON Schema");
  });

  test("离线已验证能力必须绑定测试", async () => {
    const manifest = await Bun.file(resolve(root, "capabilities.json")).json() as {
      capabilities: Array<Record<string, unknown>>;
    };
    const invalid = structuredClone(manifest);
    const entry = invalid.capabilities.find((item) => item.status === "offline-verified")!;
    entry.testRefs = [];
    await expect(validateCapabilityManifest(root, invalid)).rejects.toThrow("没有 testRefs");
  });

  test("拒绝不存在的证据路径", async () => {
    const manifest = await Bun.file(resolve(root, "capabilities.json")).json() as {
      capabilities: Array<Record<string, unknown>>;
    };
    const invalid = structuredClone(manifest);
    invalid.capabilities[0]!.evidenceRefs = ["docs/NOT-FOUND.md"];
    await expect(validateCapabilityManifest(root, invalid)).rejects.toThrow("能力契约引用不存在");
  });
});
