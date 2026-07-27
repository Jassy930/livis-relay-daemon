import { describe, expect, test } from "bun:test";
import {
  defaultServiceDefinitionPath,
  renderDeploymentServiceDefinition,
} from "../src/install/deployment-service.ts";

describe("部署服务定义渲染", () => {
  test("launchd 定义使用精确 release/config 并正确转义 XML", () => {
    const text = renderDeploymentServiceDefinition({
      manager: "launchd",
      bunPath: "/opt/homebrew/bin/bun",
      releasePath: "/Users/test/LiViS & Relay/release",
      configPath: "/Users/test/.livis-relay/config.json",
      stateDir: "/Users/test/.livis-relay",
      homeDirectory: "/Users/test",
      backend: "codex",
      nativeHomeAccess: true,
    });
    expect(text).toContain("com.local.livis-relayd");
    expect(text).toContain("/Users/test/LiViS &amp; Relay/release/src/index.ts");
    expect(text).toContain("/Users/test/.livis-relay/config.json");
    expect(text).not.toContain("__PROJECT_DIR__");
    expect(text).not.toContain("OPENAI_API_KEY");
  });

  test("systemd 定义转义 specifier 与变量符号并拒绝换行路径", () => {
    const text = renderDeploymentServiceDefinition({
      manager: "systemd",
      bunPath: "/usr/bin/bun",
      releasePath: "/home/test/relay%release$stable",
      configPath: "/home/test/.livis-relay/config.json",
      stateDir: "/home/test/.livis-relay",
      homeDirectory: "/home/test",
      backend: "claude",
      nativeHomeAccess: true,
    });
    expect(text).toContain("relay%%release$$stable");
    expect(text).toContain("ProtectHome=false");
    expect(text).toContain("LiViS 共享 Relay Daemon（claude backend）");
    const hermes = renderDeploymentServiceDefinition({
      manager: "systemd",
      bunPath: "/usr/bin/bun",
      releasePath: "/home/test/release",
      configPath: "/home/test/config.json",
      stateDir: "/home/test/state",
      homeDirectory: "/home/test",
      backend: "hermes",
      nativeHomeAccess: false,
    });
    expect(hermes).toContain("ProtectHome=read-only");
    expect(() => renderDeploymentServiceDefinition({
      manager: "systemd",
      bunPath: "/usr/bin/bun",
      releasePath: "/home/test/release\nInjected=true",
      configPath: "/home/test/config.json",
      stateDir: "/home/test/state",
      homeDirectory: "/home/test",
      backend: "hermes",
      nativeHomeAccess: false,
    })).toThrow("不能包含 NUL 或换行符");
  });

  test("默认定义路径只落在当前用户级服务目录", () => {
    expect(defaultServiceDefinitionPath("launchd", "/Users/test"))
      .toBe("/Users/test/Library/LaunchAgents/com.local.livis-relayd.plist");
    expect(defaultServiceDefinitionPath("systemd", "/home/test"))
      .toBe("/home/test/.config/systemd/user/livis-relayd.service");
    expect(defaultServiceDefinitionPath("none", "/Users/test")).toBeNull();
  });
});
