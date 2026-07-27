import { describe, expect, test } from "bun:test";
import { relative, resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dir, "..");

async function backendRuntimeFiles(): Promise<string[]> {
  const files = [
    resolve(PROJECT_ROOT, "src/daemon.ts"),
    resolve(PROJECT_ROOT, "src/connector/server.ts"),
  ];
  for (const pattern of ["src/backend/**/*.ts", "src/backends/**/*.ts", "src/context/**/*.ts"]) {
    const glob = new Bun.Glob(pattern);
    for await (const path of glob.scan({ cwd: PROJECT_ROOT, absolute: true, onlyFiles: true })) {
      files.push(path);
    }
  }
  return [...new Set(files)].sort();
}

describe("本地后端认证所有权边界", () => {
  test("daemon、backend adapter 与 assistant context 不读取原生凭据库或调用登录命令", async () => {
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
    for (const globPattern of ["src/backend/**/*.ts", "src/backends/**/*.ts", "src/context/**/*.ts"]) {
      const glob = new Bun.Glob(globPattern);
      for await (const path of glob.scan({ cwd: PROJECT_ROOT, absolute: true, onlyFiles: true })) {
        const source = await Bun.file(path).text();
        for (const pattern of forbiddenImports) {
          expect(source, `${relative(PROJECT_ROOT, path)} 不得跨越 LiViS 认证边界`).not.toMatch(pattern);
        }
      }
    }
  });

  test("native 当前状态路径不读取或分类账号状态", async () => {
    for (const path of [
      "src/backends/codex/native-stdio.ts",
      "src/backends/codex/native-client-epoch.ts",
      "src/backends/codex/native-execution-lifecycle.ts",
      "src/backends/codex/native-thread-policy.ts",
      "src/backends/codex/native-session-coordinator.ts",
      "src/backends/codex/native-session-harness.ts",
      "src/backends/codex/native-execution-backend.ts",
      "src/backends/claude/native-cli.ts",
      "src/backends/claude/native-execution-backend.ts",
      "src/context/assistant-context.ts",
    ]) {
      const source = await Bun.file(resolve(PROJECT_ROOT, path)).text();
      expect(source, `${path} 不得读取或绑定账号状态`).not.toMatch(
        /account\/read|inspectCodexAccountResponse|accountSubject|identityStrength|credential_rejected/,
      );
    }
  });

  test("native 当前状态只能由显式模式接入且不回退到私有凭据路径", async () => {
    const daemon = await Bun.file(resolve(PROJECT_ROOT, "src/daemon.ts")).text();
    const config = await Bun.file(resolve(PROJECT_ROOT, "src/config.ts")).text();
    const adapter = await Bun.file(resolve(
      PROJECT_ROOT,
      "src/backends/codex/native-execution-backend.ts",
    )).text();
    const claudeAdapter = await Bun.file(resolve(
      PROJECT_ROOT,
      "src/backends/claude/native-execution-backend.ts",
    )).text();
    expect(daemon).toContain('dependencies.config.codex.mode === "native-current"');
    expect(daemon).toContain("new CodexNativeExecutionBackend");
    expect(daemon).toContain("new ClaudeNativeExecutionBackend");
    expect(config).toContain("禁止在 native-current 与 private-api-key 之间静默选择");
    expect(adapter).not.toMatch(/CodexExecutionBackend|ensureCodexRuntimeLayout|buildCodexEnvironment/);
    expect(adapter).not.toMatch(/account\/read|credential_rejected|apiKey/);
    expect(claudeAdapter).not.toMatch(/account\/read|credential_rejected|apiKey/);
    const manifest = await Bun.file(resolve(PROJECT_ROOT, "capabilities.json")).json() as {
      capabilities: Array<{ id: string; status: string }>;
      safetyDefaults: { nativeBackendCredentialReuse?: boolean };
    };
    expect(manifest.capabilities.find((entry) => entry.id === "codex_native_auth_reuse")?.status)
      .toBe("operator-only");
    expect(manifest.safetyDefaults.nativeBackendCredentialReuse).toBeFalse();
  });
});
