import { resolve } from "node:path";
import { validateCapabilityManifest } from "../src/capabilities.ts";

const root = resolve(import.meta.dir, "..");
const { manifest, referencedPaths } = await validateCapabilityManifest(root);
const packageJson = await Bun.file(resolve(root, "package.json")).json() as {
  name?: unknown;
  version?: unknown;
  license?: unknown;
};

const mismatches: string[] = [];
if (manifest.package.name !== packageJson.name) {
  mismatches.push(`package.name: ${manifest.package.name} != ${String(packageJson.name)}`);
}
if (manifest.package.version !== packageJson.version) {
  mismatches.push(`package.version: ${manifest.package.version} != ${String(packageJson.version)}`);
}
if (manifest.package.license !== packageJson.license) {
  mismatches.push(`package.license: ${manifest.package.license} != ${String(packageJson.license)}`);
}
if (mismatches.length > 0) {
  throw new Error(`能力契约与 package.json 不一致：\n${mismatches.join("\n")}`);
}

process.stdout.write(
  `能力契约通过：schemaVersion=${manifest.schemaVersion}，` +
  `${manifest.capabilities.length} 项能力，${referencedPaths.length} 个证据/测试引用\n`,
);
