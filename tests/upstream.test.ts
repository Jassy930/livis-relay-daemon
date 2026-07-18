import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { UpstreamChecker, buildCandidateProfile } from "../src/upstream/checker.ts";
import { atomicWritePrivate, sha256 } from "../src/util.ts";
import { temporaryDirectory, testProfile } from "./helpers.ts";

function fetchMap(entries: Record<string, string | Uint8Array>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const value = entries[String(input)];
    if (value === undefined) return new Response("missing", { status: 404 });
    return new Response(typeof value === "string" ? value : Buffer.from(value));
  }) as typeof fetch;
}

describe("官方版本更新门禁", () => {
  test("已知版本和全部哈希匹配才是 supported", async () => {
    const base = await testProfile();
    const setup = "setup-v1";
    const install = `SCRIPT_VERSION="v2.0.0"\nOPENCLAW_PLUGIN_CDN_URL="https://cdn.test/plugin.tgz"\n`;
    const archive = new TextEncoder().encode("archive-v1");
    const profile = {
      ...base,
      upstream: {
        ...base.upstream,
        setupUrl: "https://cdn.test/setup.sh",
        installPluginUrl: "https://cdn.test/install.sh",
        packageUrl: "https://cdn.test/plugin.tgz",
        setupSha256: sha256(setup),
        installPluginSha256: sha256(install),
        packageSha256: sha256(archive),
      },
    };
    const checker = new UpstreamChecker({
      fetch: fetchMap({
        "https://cdn.test/setup.sh": setup,
        "https://cdn.test/install.sh": install,
        "https://cdn.test/plugin.tgz": archive,
      }),
      bundleProbe: async (_bytes, markers) => Object.fromEntries(markers.map((marker) => [marker, true])),
    });
    const snapshot = await checker.check(profile, [profile]);
    expect(snapshot.compatibility).toBe("supported");
    expect(snapshot.matchedProfileId).toBe(profile.id);
  });

  test("同版本哈希变化判 drift", async () => {
    const profile = await testProfile();
    const install = `SCRIPT_VERSION="v2.0.0"\nOPENCLAW_PLUGIN_CDN_URL="https://cdn.test/new.tgz"\n`;
    const checker = new UpstreamChecker({
      fetch: fetchMap({
        [profile.upstream.setupUrl]: "changed-setup",
        [profile.upstream.installPluginUrl]: install,
        "https://cdn.test/new.tgz": "changed-package",
      }),
      bundleProbe: async (_bytes, markers) => Object.fromEntries(markers.map((marker) => [marker, true])),
    });
    const snapshot = await checker.check(profile, [profile]);
    expect(snapshot.compatibility).toBe("drift");
    expect(snapshot.reasons.length).toBeGreaterThan(0);
  });

  test("新版本 marker 完整也只生成 candidate，不自动放行", async () => {
    const profile = await testProfile();
    const install = `SCRIPT_VERSION="v2.1.0"\nOPENCLAW_PLUGIN_CDN_URL="https://cdn.test/v2.1.tgz"\n`;
    const checker = new UpstreamChecker({
      fetch: fetchMap({
        [profile.upstream.setupUrl]: "new-setup",
        [profile.upstream.installPluginUrl]: install,
        "https://cdn.test/v2.1.tgz": "new-package",
      }),
      bundleProbe: async (_bytes, markers) => Object.fromEntries(markers.map((marker) => [marker, true])),
    });
    const snapshot = await checker.check(profile, [profile]);
    expect(snapshot.compatibility).toBe("candidate-compatible");
    expect(snapshot.detectedVersion).toBe("2.1.0");
    const candidate = buildCandidateProfile(profile, snapshot);
    expect(candidate?.officialPluginVersion).toBe("2.1.0");
    expect(candidate?.upstream.packageSha256).toBe(snapshot.package.sha256 ?? undefined);
    expect(candidate?.id).toBe("livis-community-v2.1.0");
  });

  test("旁路目录中的已审核新 profile 不能让旧 active profile 假装 supported", async () => {
    const active = await testProfile();
    const setup = "setup-v2.1";
    const install = `SCRIPT_VERSION="v2.1.0"\nOPENCLAW_PLUGIN_CDN_URL="https://cdn.test/v2.1.tgz"\n`;
    const archive = new TextEncoder().encode("archive-v2.1");
    const reviewed = {
      ...active,
      id: "livis-community-v2.1.0",
      officialPluginVersion: "2.1.0",
      upstream: {
        ...active.upstream,
        setupSha256: sha256(setup),
        installPluginSha256: sha256(install),
        packageUrl: "https://cdn.test/v2.1.tgz",
        packageSha256: sha256(archive),
      },
    };
    const checker = new UpstreamChecker({
      fetch: fetchMap({
        [active.upstream.setupUrl]: setup,
        [active.upstream.installPluginUrl]: install,
        "https://cdn.test/v2.1.tgz": archive,
      }),
      bundleProbe: async (_bytes, markers) => Object.fromEntries(markers.map((marker) => [marker, true])),
    });
    const snapshot = await checker.check(active, [active, reviewed]);
    expect(snapshot.compatibility).toBe("reviewed-upgrade-available");
    expect(snapshot.activeProfileId).toBe(active.id);
    expect(snapshot.matchedProfileId).toBe(reviewed.id);
  });

  test("缺关键 marker 判 unknown-breaking", async () => {
    const profile = await testProfile();
    const install = `SCRIPT_VERSION="v3.0.0"\nOPENCLAW_PLUGIN_CDN_URL="https://cdn.test/v3.tgz"\n`;
    const checker = new UpstreamChecker({
      fetch: fetchMap({
        [profile.upstream.setupUrl]: "new-setup",
        [profile.upstream.installPluginUrl]: install,
        "https://cdn.test/v3.tgz": "new-package",
      }),
      bundleProbe: async (_bytes, markers) => Object.fromEntries(markers.map((marker, index) => [marker, index !== 0])),
    });
    expect((await checker.check(profile, [profile])).compatibility).toBe("unknown-breaking");
  });

  test("同版本哈希漂移且缺 marker 也必须 fail closed", async () => {
    const profile = await testProfile();
    const install = `SCRIPT_VERSION="v2.0.0"\nOPENCLAW_PLUGIN_CDN_URL="https://cdn.test/hotfix.tgz"\n`;
    const checker = new UpstreamChecker({
      fetch: fetchMap({
        [profile.upstream.setupUrl]: "changed-setup",
        [profile.upstream.installPluginUrl]: install,
        "https://cdn.test/hotfix.tgz": "changed-package",
      }),
      bundleProbe: async (_bytes, markers) => Object.fromEntries(markers.map((marker, index) => [marker, index > 0])),
    });
    expect((await checker.check(profile, [profile])).compatibility).toBe("unknown-breaking");
  });

  test("artifact 哈希完全匹配但 marker 探测失败仍拒绝 supported", async () => {
    const base = await testProfile();
    const setup = "setup-known";
    const install = `SCRIPT_VERSION="v2.0.0"\nOPENCLAW_PLUGIN_CDN_URL="https://cdn.test/known.tgz"\n`;
    const archive = new TextEncoder().encode("known-package");
    const profile = {
      ...base,
      upstream: {
        ...base.upstream,
        setupUrl: "https://cdn.test/setup.sh",
        installPluginUrl: "https://cdn.test/install.sh",
        packageUrl: "https://cdn.test/known.tgz",
        setupSha256: sha256(setup),
        installPluginSha256: sha256(install),
        packageSha256: sha256(archive),
      },
    };
    const checker = new UpstreamChecker({
      fetch: fetchMap({
        "https://cdn.test/setup.sh": setup,
        "https://cdn.test/install.sh": install,
        "https://cdn.test/known.tgz": archive,
      }),
      bundleProbe: async (_bytes, markers) => Object.fromEntries(markers.map((marker) => [marker, false])),
    });
    expect((await checker.check(profile, [profile])).compatibility).toBe("unknown-breaking");
  });

  test("下载有硬大小上限，且候选原始 artifact 可按内容寻址留存", async () => {
    const profile = await testProfile();
    const tooLarge = new UpstreamChecker({
      fetch: fetchMap({
        [profile.upstream.setupUrl]: "12345",
        [profile.upstream.installPluginUrl]: "unused",
      }),
      maxScriptBytes: 4,
    });
    await expect(tooLarge.check(profile, [profile])).rejects.toThrow("大小上限");

    const install = `SCRIPT_VERSION="v2.1.0"\nOPENCLAW_PLUGIN_CDN_URL="https://cdn.test/artifact.tgz"\n`;
    const saved: string[] = [];
    const checker = new UpstreamChecker({
      fetch: fetchMap({
        [profile.upstream.setupUrl]: "setup",
        [profile.upstream.installPluginUrl]: install,
        "https://cdn.test/artifact.tgz": "package",
      }),
      bundleProbe: async (_bytes, markers) => Object.fromEntries(markers.map((marker) => [marker, true])),
      artifactSink: async (kind, _url, bytes) => {
        const path = `/artifacts/${kind}-${sha256(bytes)}`;
        saved.push(path);
        return path;
      },
    });
    const snapshot = await checker.check(profile, [profile]);
    expect(saved).toHaveLength(3);
    expect(snapshot.setup.artifactPath).toStartWith("/artifacts/setup-");
    expect(snapshot.package.artifactPath).toStartWith("/artifacts/package-");
  });

  test("默认 tar probe 在系统 tar 上静态读取 bundle.js", async () => {
    const directory = await temporaryDirectory();
    try {
      const base = await testProfile();
      const bundlePath = join(directory.path, "bundle.js");
      await atomicWritePrivate(bundlePath, base.upstream.requiredBundleMarkers.join("\n"));
      const archivePath = join(directory.path, "plugin.tgz");
      const tar = Bun.spawn(["tar", "-czf", archivePath, "-C", directory.path, "bundle.js"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const tarError = await new Response(tar.stderr).text();
      const tarExit = await tar.exited;
      if (tarExit !== 0) throw new Error(`创建合成 tar 失败：${tarError}`);
      const archive = new Uint8Array(await Bun.file(archivePath).arrayBuffer());
      const setup = "setup-system-tar";
      const install = `SCRIPT_VERSION="v2.0.0"\nOPENCLAW_PLUGIN_CDN_URL="https://cdn.test/system-tar.tgz"\n`;
      const profile = {
        ...base,
        upstream: {
          ...base.upstream,
          setupSha256: sha256(setup),
          installPluginSha256: sha256(install),
          packageUrl: "https://cdn.test/system-tar.tgz",
          packageSha256: sha256(archive),
        },
      };
      const checker = new UpstreamChecker({
        fetch: fetchMap({
          [profile.upstream.setupUrl]: setup,
          [profile.upstream.installPluginUrl]: install,
          [profile.upstream.packageUrl]: archive,
        }),
      });
      const snapshot = await checker.check(profile, [profile]);
      expect(snapshot.compatibility).toBe("supported");
      expect(Object.values(snapshot.bundleMarkers).every(Boolean)).toBeTrue();
    } finally {
      await directory.cleanup();
    }
  });
});
