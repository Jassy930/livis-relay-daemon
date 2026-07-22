import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  auditReleaseArtifacts,
  buildReleaseArtifacts,
  validateArchiveEntries,
  validateArchiveTypes,
} from "../src/release/artifacts.ts";
import { temporaryDirectory } from "./helpers.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

describe("发布产物审计", () => {
  test("构建源码包和 bridge 包后解包审计通过", async () => {
    const output = await temporaryDirectory("livis-release-artifacts-");
    cleanups.push(output.cleanup);
    const built = await buildReleaseArtifacts({
      projectRoot: resolve(import.meta.dir, ".."),
      outputDirectory: output.path,
    });
    const report = await auditReleaseArtifacts(built.manifestPath);

    expect(report.findings).toEqual([]);
    expect(report.artifacts.map((item) => item.kind).sort()).toEqual([
      "hermes-bridge-tarball",
      "source-tarball",
    ]);
    if (built.manifest.sourceTree === "clean-git") {
      expect(built.manifest.gitCommit).toMatch(/^[a-f0-9]{40}$/);
    } else {
      expect(built.manifest.gitCommit).toBeNull();
    }
  });

  test("归档被修改后 SHA-256 门禁失败", async () => {
    const output = await temporaryDirectory("livis-release-tamper-");
    cleanups.push(output.cleanup);
    const built = await buildReleaseArtifacts({
      projectRoot: resolve(import.meta.dir, ".."),
      outputDirectory: output.path,
    });
    const source = built.manifest.artifacts.find((item) => item.kind === "source-tarball")!;
    await appendFile(join(output.path, source.file), "tampered");

    const report = await auditReleaseArtifacts(built.manifestPath);
    expect(report.findings.some((item) => item.rule === "artifact-sha256")).toBeTrue();
  });

  test("拒绝目录穿越和多根目录条目", () => {
    const findings = validateArchiveEntries([
      "livis-relay-daemon-0.1.0/README.md",
      "../secret",
      "other-root/file",
    ], "livis-relay-daemon-0.1.0");
    expect(findings.map((item) => item.rule)).toContain("archive-traversal");
    expect(findings.map((item) => item.rule)).toContain("archive-root");
    expect(validateArchiveTypes(["lrwxr-xr-x user/group 0 date link -> ../../outside"])[0]?.rule)
      .toBe("archive-entry-type");
  });

  test("manifest 不能缩减必需路径集合", async () => {
    const output = await temporaryDirectory("livis-release-manifest-");
    cleanups.push(output.cleanup);
    const built = await buildReleaseArtifacts({
      projectRoot: resolve(import.meta.dir, ".."),
      outputDirectory: output.path,
    });
    const manifest = JSON.parse(await readFile(built.manifestPath, "utf8")) as {
      artifacts: Array<{ requiredPaths: string[] }>;
    };
    manifest.artifacts[0]!.requiredPaths = [];
    await writeFile(built.manifestPath, `${JSON.stringify(manifest)}\n`);
    const report = await auditReleaseArtifacts(built.manifestPath);
    expect(report.findings.some((item) => item.rule === "required-path-contract")).toBeTrue();
  });
});
