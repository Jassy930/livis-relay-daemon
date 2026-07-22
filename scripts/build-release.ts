#!/usr/bin/env bun

import { resolve } from "node:path";
import { buildReleaseArtifacts } from "../src/release/artifacts.ts";

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

const projectRoot = resolve(optionValue(Bun.argv, "--root") ?? resolve(import.meta.dir, ".."));
const outputDirectory = resolve(optionValue(Bun.argv, "--output") ?? resolve(projectRoot, "dist"));
const { manifest, manifestPath } = await buildReleaseArtifacts({
  projectRoot,
  outputDirectory,
  requireCleanGit: true,
});
process.stdout.write(`${JSON.stringify({ manifestPath, artifacts: manifest.artifacts }, null, 2)}\n`);
