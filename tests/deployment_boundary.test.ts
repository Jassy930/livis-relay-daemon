import { describe, expect, test } from "bun:test";
import { relative, resolve } from "node:path";
import {
  DEPLOYMENT_BACKENDS,
  DEPLOYMENT_SERVICE_MANAGERS,
  type DeploymentPlan,
} from "../src/install/deployment-contract.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "..");

async function deploymentRuntimeFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const pattern of ["src/install/**/*.ts", "scripts/*deploy*.ts"]) {
    const glob = new Bun.Glob(pattern);
    for await (const path of glob.scan({ cwd: PROJECT_ROOT, absolute: true, onlyFiles: true })) {
      files.push(path);
    }
  }
  return [...new Set(files)].sort();
}

describe("部署安装器安全边界", () => {
  test("契约覆盖三后端、无服务模式和显式零凭据处理", () => {
    expect([...DEPLOYMENT_BACKENDS]).toEqual(["hermes", "codex", "claude"]);
    expect([...DEPLOYMENT_SERVICE_MANAGERS]).toEqual(["launchd", "systemd", "none"]);
    const credentialBoundary = {
      credentialHandling: "native-state-unmanaged",
      credentialsReadOrMigrated: false,
    } satisfies Pick<DeploymentPlan, "credentialHandling" | "credentialsReadOrMigrated">;
    expect(credentialBoundary.credentialsReadOrMigrated).toBeFalse();
  });

  test("安装器不读取后端凭据、不调用登录命令且不复用 LiViS SecretStore", async () => {
    const forbidden: Array<{ label: string; pattern: RegExp }> = [
      { label: "Codex auth.json", pattern: /\.codex[/\\]auth\.json/i },
      { label: "Claude 凭据文件", pattern: /\.claude[/\\]\.credentials\.json/i },
      { label: "OpenAI API key 环境变量", pattern: /OPENAI_API_KEY/ },
      { label: "Anthropic API key 环境变量", pattern: /ANTHROPIC_API_KEY/ },
      { label: "Claude OAuth 环境变量", pattern: /CLAUDE_CODE_OAUTH_TOKEN/ },
      { label: "原生客户端认证命令", pattern: /\b(?:codex|claude|hermes)\s+(?:login|logout|auth)\b/i },
      { label: "macOS Keychain 读取", pattern: /find-generic-password/i },
      { label: "LiViS SecretStore", pattern: /from\s+["'][^"']*secrets\.ts["']/ },
      { label: "LiViS OAuth", pattern: /auth[/\\]idaas\.ts/ },
    ];
    const files = await deploymentRuntimeFiles();
    expect(files.length).toBeGreaterThan(1);
    for (const path of files) {
      const source = await Bun.file(path).text();
      for (const rule of forbidden) {
        expect(source, `${relative(PROJECT_ROOT, path)} 不得包含 ${rule.label}`).not.toMatch(rule.pattern);
      }
    }
  });

  test("服务控制器只有显式副作用方法，计划模型必须标记确认边界", async () => {
    const source = await Bun.file(resolve(
      PROJECT_ROOT,
      "src/install/deployment-contract.ts",
    )).text();
    expect(source).toContain("explicitAcknowledgementRequired: boolean");
    expect(source).toContain("manageService: boolean");
    expect(source).toContain("stop(): Promise<void>");
    expect(source).toContain("reload(): Promise<void>");
    expect(source).toContain("start(): Promise<void>");
  });
});
