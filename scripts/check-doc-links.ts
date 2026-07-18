import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const markdown = new Bun.Glob("**/*.md");
const failures: string[] = [];
let checked = 0;

for await (const relativePath of markdown.scan({ cwd: root, onlyFiles: true })) {
  if (
    relativePath.startsWith("node_modules/") ||
    relativePath.startsWith("hermes-plugin/.venv/")
  ) {
    continue;
  }
  const text = await Bun.file(resolve(root, relativePath)).text();
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const rawTarget = match[1]!.trim().replace(/^<|>$/g, "");
    if (
      rawTarget === "" ||
      rawTarget.startsWith("#") ||
      /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)
    ) {
      continue;
    }
    const pathPart = rawTarget.split("#", 1)[0]!;
    const target = resolve(dirname(resolve(root, relativePath)), decodeURIComponent(pathPart));
    checked += 1;
    if (!existsSync(target) || (!statSync(target).isFile() && !statSync(target).isDirectory())) {
      failures.push(`${relativePath}: ${rawTarget}`);
    }
  }
}

if (failures.length > 0) {
  throw new Error(`文档相对链接失效：\n${failures.join("\n")}`);
}

process.stdout.write(`文档链接有效：${checked}\n`);
