import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  DEFAULT_RELAY_MAX_FRAME_BYTES,
  initializeConfig,
  loadRelayConfig,
  MAX_RELAY_MAX_FRAME_BYTES,
  parseRelayConfig,
} from "../src/config.ts";
import {
  loadProtocolProfile,
  parseProtocolProfile,
  parseProtocolProfileCatalogEntry,
  runtimeContractSha256,
} from "../src/protocol/profile.ts";
import {
  CURRENT_CREDENTIAL_MODE,
  CURRENT_WIRE_CONTRACT_REVISION,
  WIRE_CONTRACT_REGISTRY,
} from "../src/protocol/contract.ts";
import {
  parseWireContractRegistryDocument,
  requireCurrentWireContract,
} from "../src/protocol/contract-registry.ts";
import { atomicWritePrivate } from "../src/util.ts";
import { temporaryDirectory, testConfig, testProfile } from "./helpers.ts";

describe("配置与协议 profile", () => {
  test("config.example 与随包 profile 的 SHA pin 一致", async () => {
    const configPath = resolve(import.meta.dir, "..", "config.example.json");
    const loaded = await loadRelayConfig(configPath);
    expect((await loadProtocolProfile(
      loaded.config.profile,
      loaded.path,
      loaded.config.profileSha256,
    )).id).toBe("livis-authorized-profile-example");
  });

  test("加载已审核 v2.0.0 profile", async () => {
    const profile = await testProfile();
    expect(profile.id).toBe("livis-test-v2.0.0");
    expect(profile.wireProtocolVersion).toBe(1);
    expect(profile.wireContractRevision).toBe(CURRENT_WIRE_CONTRACT_REVISION);
    expect(profile.credentialMode).toBe(CURRENT_CREDENTIAL_MODE);
    expect(WIRE_CONTRACT_REGISTRY[profile.wireContractRevision]!.localProbeArtifactSha256).toHaveLength(64);
    expect(runtimeContractSha256(profile)).toHaveLength(64);
    expect(profile.wireIdentity.nodeType).toBe("personal-device");
  });

  test("拒绝旧 schema、未知 revision 和不匹配的凭据模式", async () => {
    const profile = await testProfile();
    expect(() => parseProtocolProfile(JSON.stringify({ ...profile, schemaVersion: 1 }))).toThrow("旧 profile 必须显式迁移");
    expect(() => parseProtocolProfile(JSON.stringify({
      ...profile,
      wireContractRevision: "unknown-wire-contract",
    }))).toThrow("wireContractRevision");
    expect(() => parseProtocolProfile(JSON.stringify({
      ...profile,
      credentialMode: "access-token-only",
    }))).toThrow("credentialMode");
  });

  test("registry 旧 revision 只作历史账本，runtime 只接受 current", () => {
    const historical = {
      revision: "wire-r1",
      credentialMode: "access-and-refresh-token" as const,
      wireProtocolVersion: 1,
      localProbeArtifactPath: "protocol-probes/local/wire-r1.json",
      localProbeArtifactSha256: "1".repeat(64),
    };
    const current = {
      revision: "wire-r2",
      credentialMode: "access-token-only" as const,
      wireProtocolVersion: 1,
      localProbeArtifactPath: "protocol-probes/local/wire-r2.json",
      localProbeArtifactSha256: "2".repeat(64),
    };
    const registry = parseWireContractRegistryDocument({
      schemaVersion: 1,
      currentRevision: current.revision,
      contracts: [historical, current],
    });
    expect(() => requireCurrentWireContract(registry, {
      revision: historical.revision,
      credentialMode: historical.credentialMode,
      wireProtocolVersion: historical.wireProtocolVersion,
    })).toThrow("仅作为历史账本保留");
    expect(requireCurrentWireContract(registry, {
      revision: current.revision,
      credentialMode: current.credentialMode,
      wireProtocolVersion: current.wireProtocolVersion,
    })).toEqual(current);
  });

  test("catalog 只跳过明确 schema v1，损坏 JSON 与未知 schema 继续失败关闭", async () => {
    const profile = await testProfile();
    expect(parseProtocolProfileCatalogEntry(JSON.stringify({
      ...profile,
      schemaVersion: 1,
      wireContractRevision: undefined,
      credentialMode: undefined,
    }))).toBeNull();
    expect(() => parseProtocolProfileCatalogEntry("not-json", "broken-profile.json")).toThrow(
      "不是有效 JSON",
    );
    expect(() => parseProtocolProfileCatalogEntry(JSON.stringify({
      ...profile,
      schemaVersion: 3,
    }), "future-profile.json")).toThrow("未知 protocol profile schemaVersion");
  });

  test("拒绝非 TLS 的官方端点", async () => {
    const profile = await testProfile();
    const unsafe = { ...profile, endpoints: { ...profile.endpoints, idaasBaseUrl: "http://example.test" } };
    expect(() => parseProtocolProfile(JSON.stringify(unsafe))).toThrow("必须使用 https");
  });

  test("拒绝未知 wire protocol 和无效哈希", async () => {
    const profile = await testProfile();
    expect(() => parseProtocolProfile(JSON.stringify({ ...profile, wireProtocolVersion: 2 }))).toThrow(
      "只支持 LiViS wireProtocolVersion=1",
    );
    expect(() => parseProtocolProfile(JSON.stringify({
      ...profile,
      upstream: { ...profile.upstream, packageSha256: "not-a-sha" },
    }))).toThrow("64 位小写十六进制 SHA-256");
  });

  test("connector 只接受 Unix socket 配置", () => {
    const config = testConfig("/tmp/test-state");
    const parsed = parseRelayConfig(JSON.stringify(config), "/tmp/config.json");
    expect(parsed.connector.socketPath).toBe("/tmp/test-state/connector.sock");
    const invalid = { ...config, connector: { ...config.connector, socketPath: "" } };
    expect(() => parseRelayConfig(JSON.stringify(invalid), "/tmp/config.json")).toThrow("非空字符串");
    const invalidHermesRange = {
      ...config,
      hermes: { ...config.hermes, maximumExclusiveVersion: config.hermes.minimumVersion },
    };
    expect(() => parseRelayConfig(JSON.stringify(invalidHermesRange), "/tmp/config.json")).toThrow("版本范围");
  });

  test("旧配置默认使用 Hermes，Codex 配置失败关闭并使用固定版本窗", () => {
    const config = testConfig("/tmp/test-state");
    const legacy = structuredClone(config) as unknown as Record<string, unknown>;
    delete legacy.execution;
    delete legacy.codex;
    const parsedLegacy = parseRelayConfig(JSON.stringify(legacy), "/tmp/config.json");
    expect(parsedLegacy.execution.backend).toBe("hermes");
    expect(parsedLegacy.codex.acknowledgeRemoteExecution).toBeFalse();

    const codex = parseRelayConfig(JSON.stringify({
      ...config,
      execution: { backend: "codex" },
      codex: {
        command: "/opt/homebrew/bin/codex",
        model: "gpt-5.6-sol",
        requestTimeoutMs: 12_000,
        shutdownTimeoutMs: 4_000,
        acknowledgeRemoteExecution: true,
      },
    }), "/tmp/config.json");
    expect(codex.execution.backend).toBe("codex");
    expect(codex.codex).toEqual({
      command: "/opt/homebrew/bin/codex",
      model: "gpt-5.6-sol",
      requestTimeoutMs: 12_000,
      shutdownTimeoutMs: 4_000,
      acknowledgeRemoteExecution: true,
    });

    expect(() => parseRelayConfig(JSON.stringify({
      ...config,
      execution: { backend: "claude" },
    }), "/tmp/config.json")).toThrow("只支持 hermes 或 codex");
    expect(() => parseRelayConfig(JSON.stringify({
      ...config,
      execution: { backend: "codex" },
      codex: { ...config.codex, acknowledgeRemoteExecution: "yes" },
    }), "/tmp/config.json")).toThrow("必须是布尔值");
    for (const security of [
      { ...config.security, allowAllNodes: true },
      { ...config.security, allowedNodeIds: [] },
      { ...config.security, allowedNodeIds: ["node-1", "node-2"] },
    ]) {
      expect(() => parseRelayConfig(JSON.stringify({
        ...config,
        execution: { backend: "codex" },
        security,
      }), "/tmp/config.json")).toThrow("Codex backend 只支持单设备");
    }
    expect(() => parseRelayConfig(JSON.stringify({
      ...config,
      execution: { backend: "codex" },
      codex: { ...config.codex, command: "codex" },
    }), "/tmp/config.json")).toThrow("必须是绝对路径");
  });

  test("旧配置兼容 relay 帧默认上限，并拒绝无效或过大的显式值", () => {
    const config = testConfig("/tmp/test-state");
    const legacy = structuredClone(config) as unknown as Record<string, unknown>;
    delete (legacy.relay as Record<string, unknown>).maxFrameBytes;
    expect(parseRelayConfig(JSON.stringify(legacy), "/tmp/config.json").relay.maxFrameBytes)
      .toBe(DEFAULT_RELAY_MAX_FRAME_BYTES);

    expect(parseRelayConfig(JSON.stringify({
      ...config,
      relay: { ...config.relay, maxFrameBytes: 512 },
    }), "/tmp/config.json").relay.maxFrameBytes).toBe(512);
    for (const maxFrameBytes of [0, -1, MAX_RELAY_MAX_FRAME_BYTES + 1]) {
      expect(() => parseRelayConfig(JSON.stringify({
        ...config,
        relay: { ...config.relay, maxFrameBytes },
      }), "/tmp/config.json")).toThrow("maxFrameBytes");
    }
  });

  test("init 把已审核 profile 复制到状态目录并锁定 SHA-256", async () => {
    const directory = await temporaryDirectory();
    try {
      const configPath = join(directory.path, "relay", "config.json");
      await initializeConfig({
        configPath,
        profileSourcePath: resolve(import.meta.dir, "fixtures", "livis-test-v2.0.0.json"),
        acknowledgeUnofficialProtocol: true,
      });
      const loaded = await loadRelayConfig(configPath);
      expect(loaded.config.relay.maxFrameBytes).toBe(DEFAULT_RELAY_MAX_FRAME_BYTES);
      expect(loaded.config.profile).toStartWith(join(directory.path, "relay", "protocol-profiles"));
      expect((await loadProtocolProfile(
        loaded.config.profile,
        loaded.path,
        loaded.config.profileSha256,
      )).id).toBe("livis-test-v2.0.0");
      await atomicWritePrivate(loaded.config.profile, "{}\n");
      await expect(loadProtocolProfile(
        loaded.config.profile,
        loaded.path,
        loaded.config.profileSha256,
      )).rejects.toThrow("SHA-256 与配置锁定值不一致");
    } finally {
      await directory.cleanup();
    }
  });

  test("公开 CLI 可要求 stateDir 位于项目仓库外", async () => {
    const directory = await temporaryDirectory();
    try {
      await expect(initializeConfig({
        configPath: join(directory.path, "config.json"),
        profileSourcePath: resolve(import.meta.dir, "fixtures", "livis-test-v2.0.0.json"),
        acknowledgeUnofficialProtocol: true,
        forbiddenStateRoot: directory.path,
      })).rejects.toThrow("必须位于项目仓库之外");
    } finally {
      await directory.cleanup();
    }
  });
});
