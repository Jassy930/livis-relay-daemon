import { describe, expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  readFile,
  realpath,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  ASSISTANT_CONTEXT_MAX_FILE_CHARS,
  assistantContextFailureStatus,
  loadAssistantContextSnapshot,
  materializeAssistantContextSnapshot,
} from "../src/context/assistant-context.ts";
import { temporaryDirectory } from "./helpers.ts";

async function privateFile(path: string, text: string | Uint8Array): Promise<void> {
  await writeFile(path, text, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function contextFixture(prefix: string): Promise<{
  context: Awaited<ReturnType<typeof temporaryDirectory>>;
  state: Awaited<ReturnType<typeof temporaryDirectory>>;
  workspace: Awaited<ReturnType<typeof temporaryDirectory>>;
}> {
  const context = await temporaryDirectory(`${prefix}-context-`);
  const state = await temporaryDirectory(`${prefix}-state-`);
  const workspace = await temporaryDirectory(`${prefix}-workspace-`);
  context.path = await realpath(context.path);
  state.path = await realpath(state.path);
  workspace.path = await realpath(workspace.path);
  await Promise.all([
    chmod(context.path, 0o700),
    chmod(state.path, 0o700),
    chmod(workspace.path, 0o700),
  ]);
  await privateFile(join(context.path, "AGENTS.md"), "永远使用中文回答。\n");
  return { context, state, workspace };
}

function config(contextDir: string, maxPromptChars = 20_000) {
  return { mode: "read-only-files" as const, contextDir, maxPromptChars };
}

describe("assistant context 只读快照", () => {
  test("公开失败分类不包含 canonical 路径或正文", () => {
    const failure = assistantContextFailureStatus(new Error(
      "assistant context AGENTS.md 必须是 0600、单 link 的普通文件且 inode 不得变化：/private/context/AGENTS.md",
    ));
    expect(failure).toBe("assistant_context_file_metadata_invalid");
    expect(failure).not.toContain("/private/context");
  });

  test("按固定分层和项目名稳定排序，并生成无时间戳的内容哈希", async () => {
    const fixture = await contextFixture("livis-assistant-order");
    try {
      const memory = join(fixture.context.path, "memory");
      const projects = join(memory, "PROJECTS");
      await mkdir(memory, { mode: 0o700 });
      await mkdir(projects, { mode: 0o700 });
      await privateFile(join(memory, "USER.md"), "用户：Jassy\n");
      await privateFile(join(memory, "PREFERENCES.md"), "偏好：证据先行\n");
      await privateFile(join(memory, "LONG_TERM.md"), "长期目标\n");
      await privateFile(join(projects, "zeta.md"), "Z 项目\n");
      await privateFile(join(projects, "alpha.md"), "A 项目\n");
      await privateFile(join(memory, "RECENT.md"), "最近事项\n");

      const first = await loadAssistantContextSnapshot({
        config: config(fixture.context.path),
        stateDir: fixture.state.path,
      });
      const second = await loadAssistantContextSnapshot({
        config: config(fixture.context.path),
        stateDir: fixture.state.path,
      });
      expect(first.generation).toBe(second.generation);
      expect(first.manifestText).toBe(second.manifestText);
      expect(first.files.map((file) => file.path)).toEqual([
        "AGENTS.md",
        "memory/USER.md",
        "memory/PREFERENCES.md",
        "memory/LONG_TERM.md",
        "memory/PROJECTS/alpha.md",
        "memory/PROJECTS/zeta.md",
        "memory/RECENT.md",
      ]);
      expect(first.manifestText).not.toMatch(/createdAt|updatedAt|timestamp/);
      expect(first.prompt).toContain(`generation=${first.generation}`);
      expect(first.prompt).toContain("memory/PROJECTS/alpha.md（只读记忆资料）");

      await materializeAssistantContextSnapshot(first, fixture.workspace.path);
      expect(await readFile(join(fixture.workspace.path, "memory", "USER.md"), "utf8"))
        .toBe("用户：Jassy\n");
      const workspaceAgents = await readFile(join(fixture.workspace.path, "AGENTS.md"), "utf8");
      expect(workspaceAgents).toContain("每轮回答前");
      expect(workspaceAgents).toContain("永远使用中文回答");
      expect(workspaceAgents).not.toContain("用户：Jassy");
      expect(JSON.parse(await readFile(
        join(fixture.workspace.path, ".livis-context", "MANIFEST.json"),
        "utf8",
      )).generation).toBe(first.generation);

      await privateFile(join(fixture.workspace.path, "memory", "USER.md"), "被篡改\n");
      await privateFile(join(fixture.workspace.path, "memory", "STALE.md"), "陈旧\n");
      await unlink(join(fixture.context.path, "memory", "RECENT.md"));
      const refreshed = await loadAssistantContextSnapshot({
        config: config(fixture.context.path),
        stateDir: fixture.state.path,
      });
      await materializeAssistantContextSnapshot(refreshed, fixture.workspace.path);
      expect(await readFile(join(fixture.workspace.path, "memory", "USER.md"), "utf8"))
        .toBe("用户：Jassy\n");
      expect(Bun.file(join(fixture.workspace.path, "memory", "STALE.md")).exists()).resolves.toBeFalse();
      expect(Bun.file(join(fixture.workspace.path, "memory", "RECENT.md")).exists()).resolves.toBeFalse();
    } finally {
      await Promise.all([
        fixture.context.cleanup(),
        fixture.state.cleanup(),
        fixture.workspace.cleanup(),
      ]);
    }
  });

  test("拒绝 symlink、宽权限、hardlink、无效 UTF-8 与超限文件", async () => {
    for (const variant of ["symlink", "permissions", "hardlink", "utf8", "oversize"] as const) {
      const fixture = await contextFixture(`livis-assistant-invalid-${variant}`);
      try {
        const agents = join(fixture.context.path, "AGENTS.md");
        if (variant === "symlink") {
          const target = join(fixture.context.path, "target.md");
          await privateFile(target, "目标\n");
          await unlink(agents);
          await symlink(target, agents);
        } else if (variant === "permissions") {
          await chmod(agents, 0o644);
        } else if (variant === "hardlink") {
          await link(agents, join(fixture.context.path, "AGENTS-copy.md"));
        } else if (variant === "utf8") {
          await privateFile(agents, new Uint8Array([0xff, 0xfe]));
        } else {
          await privateFile(agents, "x".repeat(ASSISTANT_CONTEXT_MAX_FILE_CHARS + 1));
        }
        await expect(loadAssistantContextSnapshot({
          config: config(fixture.context.path, 100_000),
          stateDir: fixture.state.path,
        })).rejects.toThrow();
      } finally {
        await Promise.all([
          fixture.context.cleanup(),
          fixture.state.cleanup(),
          fixture.workspace.cleanup(),
        ]);
      }
    }
  });

  test("拒绝 contextDir 与 stateDir 重叠、父路径 symlink 和静默截断", async () => {
    const fixture = await contextFixture("livis-assistant-boundary");
    const links = await temporaryDirectory("livis-assistant-link-parent-");
    try {
      links.path = await realpath(links.path);
      const nested = join(fixture.state.path, "assistant");
      await mkdir(nested, { mode: 0o700 });
      await privateFile(join(nested, "AGENTS.md"), "嵌套\n");
      await expect(loadAssistantContextSnapshot({
        config: config(nested),
        stateDir: fixture.state.path,
      })).rejects.toThrow("互不包含");

      const nestedState = join(fixture.context.path, "nested-state");
      await mkdir(nestedState, { mode: 0o700 });
      await expect(loadAssistantContextSnapshot({
        config: config(fixture.context.path),
        stateDir: nestedState,
      })).rejects.toThrow("互不包含");

      const linkedContext = join(links.path, "linked-context");
      await symlink(fixture.context.path, linkedContext);
      await expect(loadAssistantContextSnapshot({
        config: config(linkedContext),
        stateDir: fixture.state.path,
      })).rejects.toThrow("symlink");

      await expect(loadAssistantContextSnapshot({
        config: config(fixture.context.path, 10),
        stateDir: fixture.state.path,
      })).rejects.toThrow("拒绝静默截断");
    } finally {
      await Promise.all([
        fixture.context.cleanup(),
        fixture.state.cleanup(),
        fixture.workspace.cleanup(),
        links.cleanup(),
      ]);
    }
  });
});
