import { describe, expect, test } from "bun:test";
import { relative, resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dir, "..");

async function backendRuntimeFiles(): Promise<string[]> {
  const files = [
    resolve(PROJECT_ROOT, "src/daemon.ts"),
    resolve(PROJECT_ROOT, "src/connector/server.ts"),
  ];
  for (const pattern of ["src/backend/**/*.ts", "src/backends/**/*.ts"]) {
    const glob = new Bun.Glob(pattern);
    for await (const path of glob.scan({ cwd: PROJECT_ROOT, absolute: true, onlyFiles: true })) {
      files.push(path);
    }
  }
  return [...new Set(files)].sort();
}

describe("本地后端认证所有权边界", () => {
  test("daemon 与 backend adapter 不读取原生凭据库或调用登录命令", async () => {
    const forbidden: Array<{ label: string; pattern: RegExp }> = [
      { label: "Codex auth.json", pattern: /\.codex[/\\]auth\.json/i },
      { label: "Claude 凭据文件", pattern: /\.claude[/\\]\.credentials\.json/i },
      { label: "Claude Keychain 条目", pattern: /Claude Code-credentials/i },
      { label: "OpenAI API key 环境变量", pattern: /OPENAI_API_KEY/ },
      { label: "Anthropic API key 环境变量", pattern: /ANTHROPIC_API_KEY/ },
      { label: "Claude OAuth 环境变量", pattern: /CLAUDE_CODE_OAUTH_TOKEN/ },
      { label: "原生客户端认证命令", pattern: /\b(?:codex|claude|hermes)\s+(?:login|logout|auth)\b/i },
      { label: "macOS Keychain 读取", pattern: /find-generic-password/i },
    ];

    const files = await backendRuntimeFiles();
    expect(files.length).toBeGreaterThan(4);
    for (const path of files) {
      const source = await Bun.file(path).text();
      for (const rule of forbidden) {
        expect(source, `${relative(PROJECT_ROOT, path)} 不得包含 ${rule.label}`).not.toMatch(rule.pattern);
      }
    }
  });

  test("backend adapter 不能复用 LiViS OAuth 或 daemon SecretStore", async () => {
    const forbiddenImports = [/auth[/\\]idaas\.ts/, /from\s+["'][^"']*secrets\.ts["']/];
    for (const globPattern of ["src/backend/**/*.ts", "src/backends/**/*.ts"]) {
      const glob = new Bun.Glob(globPattern);
      for await (const path of glob.scan({ cwd: PROJECT_ROOT, absolute: true, onlyFiles: true })) {
        const source = await Bun.file(path).text();
        for (const pattern of forbiddenImports) {
          expect(source, `${relative(PROJECT_ROOT, path)} 不得跨越 LiViS 认证边界`).not.toMatch(pattern);
        }
      }
    }
  });

  test("native 执行原型在能力 unsupported 期间不得进入生产 serve", async () => {
    for (const path of ["src/daemon.ts", "src/index.ts", "src/config.ts"]) {
      const source = await Bun.file(resolve(PROJECT_ROOT, path)).text();
      expect(source, `${path} 不得导入 native 执行原型`).not.toMatch(
        /native-(?:execution-lifecycle|thread-policy)/,
      );
    }
    const manifest = await Bun.file(resolve(PROJECT_ROOT, "capabilities.json")).json() as {
      capabilities: Array<{ id: string; status: string }>;
      safetyDefaults: { nativeBackendCredentialReuse?: boolean };
    };
    expect(manifest.capabilities.find((entry) => entry.id === "codex_native_auth_reuse")?.status)
      .toBe("unsupported");
    expect(manifest.safetyDefaults.nativeBackendCredentialReuse).toBeFalse();
  });
});
