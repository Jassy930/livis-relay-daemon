import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { initializeConfig, loadRelayConfig, parseRelayConfig } from "../src/config.ts";
import { loadProtocolProfile, parseProtocolProfile } from "../src/protocol/profile.ts";
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
    expect(profile.wireIdentity.nodeType).toBe("personal-device");
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
