import { describe, expect, test } from "bun:test";
import {
  CURRENT_WIRE_CONTRACT_REVISION,
  WIRE_CONTRACT_REGISTRY,
} from "../src/protocol/contract.ts";
import { sha256 } from "../src/util.ts";
import { resolve } from "node:path";
import {
  assertPublicProbeTextSafe,
  canonicalLocalProtocolProbeText,
  LOCAL_PROBE_ARTIFACT_PATH,
} from "../scripts/probe-protocol-local.ts";

describe("本地 protocol probe artifact", () => {
  test("生成结果与 tracked artifact 及 wire registry SHA-256 一致", async () => {
    const generated = await canonicalLocalProtocolProbeText();
    expect(await Bun.file(LOCAL_PROBE_ARTIFACT_PATH).text()).toBe(generated);
    const definition = WIRE_CONTRACT_REGISTRY[CURRENT_WIRE_CONTRACT_REVISION]!;
    expect(LOCAL_PROBE_ARTIFACT_PATH).toBe(resolve(import.meta.dir, "..", definition.localProbeArtifactPath));
    expect(sha256(generated)).toBe(definition.localProbeArtifactSha256);
  });

  test("固定凭据哨兵或 URL 进入公开 artifact 时失败关闭", () => {
    expect(() => assertPublicProbeTextSafe('{"token":"probe-access-token-v1"}\n')).toThrow("未完成脱敏");
    expect(() => assertPublicProbeTextSafe('{"endpoint":"https://relay.example.invalid"}\n')).toThrow("未完成脱敏");
  });
});
