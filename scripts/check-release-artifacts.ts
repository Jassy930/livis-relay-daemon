#!/usr/bin/env bun

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { auditReleaseArtifacts, buildReleaseArtifacts } from "../src/release/artifacts.ts";

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const explicitManifest = optionValue(Bun.argv, "--manifest");
  let temporary: string | null = null;
  let manifestPath: string;
  if (explicitManifest) {
    manifestPath = resolve(explicitManifest);
  } else {
    const projectRoot = resolve(optionValue(Bun.argv, "--source-root") ?? resolve(import.meta.dir, ".."));
    temporary = await mkdtemp(join(tmpdir(), "livis-release-self-check-"));
    manifestPath = (await buildReleaseArtifacts({ projectRoot, outputDirectory: temporary })).manifestPath;
  }
  try {
    const report = await auditReleaseArtifacts(manifestPath);
    if (report.findings.length > 0) {
      process.stderr.write(`发布产物审计失败（${report.findings.length} 项）：\n`);
      for (const finding of report.findings) {
        process.stderr.write(`- [${finding.rule}] ${finding.path}: ${finding.message}\n`);
      }
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `发布产物审计通过：${report.artifacts.length} 个归档，` +
      `${report.artifacts.reduce((total, item) => total + item.textFiles, 0)} 个文本文件，` +
      `${report.artifacts.reduce((total, item) => total + item.binaryFiles, 0)} 个二进制文件\n`,
    );
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`发布产物审计无法运行：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
