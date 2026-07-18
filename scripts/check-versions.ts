import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const packageJson = await Bun.file(resolve(root, "package.json")).json() as { version?: unknown };
if (typeof packageJson.version !== "string" || packageJson.version === "") {
  throw new Error("package.json.version 缺失");
}

const expected = packageJson.version;
const checks: Array<{ path: string; pattern: RegExp; label: string }> = [
  {
    path: "src/daemon.ts",
    pattern: /DAEMON_VERSION\s*=\s*"([^"]+)"/,
    label: "DAEMON_VERSION",
  },
  {
    path: "hermes-plugin/adapter.py",
    pattern: /PLUGIN_VERSION\s*=\s*"([^"]+)"/,
    label: "PLUGIN_VERSION",
  },
  {
    path: "hermes-plugin/plugin.yaml",
    pattern: /^version:\s*([^\s]+)$/m,
    label: "plugin.yaml version",
  },
  {
    path: "hermes-plugin/pyproject.toml",
    pattern: /^version\s*=\s*"([^"]+)"$/m,
    label: "pyproject version",
  },
];

const mismatches: string[] = [];
for (const check of checks) {
  const text = await Bun.file(resolve(root, check.path)).text();
  const actual = text.match(check.pattern)?.[1];
  if (actual !== expected) {
    mismatches.push(`${check.label}: ${actual ?? "missing"} != ${expected}`);
  }
}

if (mismatches.length > 0) {
  throw new Error(`版本不一致：\n${mismatches.join("\n")}`);
}

process.stdout.write(`版本一致：${expected}\n`);
