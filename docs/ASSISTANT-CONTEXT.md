# 个人助手上下文与文件记忆

本文定义 Codex `native-current` 与 Claude `native-current` 共用的长期个人助手上下文。该能力默认
关闭；启用后，Relay 只读取操作者维护的文件，不自动写回记忆，也不读取或管理任何后端账号、凭据
或认证状态。

## 1. 状态所有权

`assistantContext.contextDir` 直接指向一个独立的 assistant scope。这个目录是长期真源，必须位于
Relay `stateDir` 之外；Codex/Claude workspace 只保存可恢复执行快照，不能作为唯一记忆来源。

```text
<contextDir>/
├── AGENTS.md                   # 必需，稳定行为指令
└── memory/                     # 可选
    ├── USER.md                 # 用户事实
    ├── PREFERENCES.md          # 交互与表达偏好
    ├── LONG_TERM.md            # 长期目标和稳定知识
    ├── PROJECTS/
    │   └── <project-id>.md     # 按文件名稳定排序
    └── RECENT.md               # 最近事项，最后装配
```

需要多个个人助手时，为每个 scope 使用不同的 `contextDir`；首版不在同一配置中动态选择 scope，远端
消息也不能改变目录。canonical context 永远只读。Relay 不创建、修改或迁移其中的文件；编辑和版本
管理仍由操作者负责。

## 2. 配置

旧配置或 `assistantContext: null` 保持原行为。启用时只能使用以下字段：

```json
{
  "assistantContext": {
    "mode": "read-only-files",
    "contextDir": "/绝对/canonical/assistant-scope",
    "maxPromptChars": 20000
  }
}
```

- `contextDir` 必须是已存在、无 symlink 的 canonical 绝对目录，权限为 `0700` 或更严格；它与
  `stateDir` 不能互相包含。
- `AGENTS.md` 必须存在。所有被读取的 Markdown 文件必须是 `0600`、单 hardlink、非 symlink 的
  UTF-8 普通文件。
- 只读取上节列出的固定文件与 `PROJECTS/*.md`；项目文件按名称做与 locale 无关的稳定排序。
- 最多读取 64 个文件，单文件最多 64000 字符。装配后的完整上下文不得超过
  `maxPromptChars`；默认 20000、配置上限 100000。任何超限都失败关闭，不静默截断。
- 文件集合会连续读取两遍；只有两次确定性 manifest 完全一致时才接受，避免把编辑中的跨代内容
  组装成一次快照。

每个快照以文件相对路径、字符数和 SHA-256 生成内容确定的 `generation`。生成的
`.livis-context/MANIFEST.json` 只写入 backend 私有 workspace，不写回 canonical context，也不包含
动态时间戳或源目录绝对路径。

## 3. Codex 接入

Codex workspace 继续稳定为：

```text
<stateDir>/backends/codex/native-sessions/<session-hash>/workspace
```

启用 context 后，Relay 会在 app-server harness 启动前以及每个 job 派发前重新加载并物化：

- workspace 根目录的受控 `AGENTS.md`；
- `memory/*.md` 与 `memory/PROJECTS/*.md`；
- `.livis-context/MANIFEST.json`。

生成的 workspace `AGENTS.md` 包含操作者的稳定指令，并要求每轮按 manifest 读取当前 memory 文件。
thread 创建或恢复时还必须回读到该 workspace `AGENTS.md` instruction source；缺失时进入既有
thread policy 失败关闭。Codex 内建 memory 继续固定为
`thread/memoryMode/set(mode="disabled")`，不会与本项目的文件记忆混用。

Codex agent 对私有 workspace 仍有写权限，因此“只读”不是同 UID 下不可绕过的内核强制。边界是：

1. canonical context 位于 workspace/stateDir 外，且绝对路径不注入模型；
2. 每轮派发前恢复全部受控文件，并移除受控目录中的陈旧快照文件；
3. 模型不得修改 `AGENTS.md`、memory 或 manifest；自动记忆写回首版未开放。

memory 文件更新会在下一轮重新物化并由稳定 `AGENTS.md` 指令要求读取。为了避免持久 thread 继续
使用旧的基础行为指令，修改 canonical `AGENTS.md` 后应停服、审阅并按现有 session release 流程退役
旧 Codex thread，再重新启动；不要把 workspace 中的临时修改当作长期记忆。

## 4. Claude 接入

Claude workspace 继续稳定为：

```text
<stateDir>/backends/claude/native-sessions/<session-hash>/workspace
```

Claude `--safe-mode` 不依赖 `CLAUDE.md` 或 auto-memory 自动发现。本实现会在每个 job spawn 前重新
加载同一 canonical snapshot，把固定 LiViS 纯文本安全提示、`AGENTS.md` 和全部有界 memory section
显式装配到 `--system-prompt`，同时把快照物化到 workspace 供审计。

这不会改变 Claude 的首版执行边界：仍是每 job 新会话、`--no-session-persistence`、空 tools/MCP/
skills/slash commands、无 Chrome、无 Hook、无自动写回。context 加载失败发生在 spawn 之前，adapter
返回 `not_sent`，不会把半个请求提交给 Claude。

## 5. 失败与运维边界

- 启动时 context 不存在、权限过宽、包含 symlink/hardlink、UTF-8 无效、目录重叠或超限：目标
  backend 启动失败，Codex harness/Claude 能力探针不会继续。
- 运行中 context 漂移或编辑未稳定：当前 job 在 backend 提交前返回 `not_sent`；修正源文件后可由
  既有调度语义重新尝试，不会自动切换后端。
- `status.execution.assistantContext` 只显示 enabled、mode、generation 和稳定的最近同步错误分类，
  不显示 `contextDir`、底层文件系统错误或文件正文。
- backend 切换只改变执行路由；根级 `assistantContext` 配置和 canonical 文件保持不变，不复制原生
  session，也不产生第二套认证状态。

这些文件会成为发给所选模型的上下文。不得在 `AGENTS.md` 或 memory 中保存 token、API key、cookie、
私钥、恢复码或不应发送给模型 provider 的内容；`0600` 只保护本机文件访问，不代表数据不会离开
本机。首版不提供内容脱敏器，也不会把疑似凭据解释为认证状态。

## 6. 自动化证据

- [`assistant_context.test.ts`](../tests/assistant_context.test.ts)：排序、generation、manifest、恢复与
  symlink/权限/hardlink/UTF-8/预算负向边界。
- [`codex_native_execution_backend.test.ts`](../tests/codex_native_execution_backend.test.ts)：harness
  前物化、每轮刷新、篡改恢复和失败时不派发。
- [`claude_native_execution_backend.test.ts`](../tests/claude_native_execution_backend.test.ts)：system
  prompt 装配和失败时不 spawn。
- [`auth_boundary.test.ts`](../tests/auth_boundary.test.ts)：context loader 与 backend 继续禁止读取原生
  凭据路径、认证环境变量或登录命令。

上述都是本机自动化门禁，不等于真实 LiViS 长期记忆 canary 已完成。正式启用后仍需用唯一、无敏感
信息的测试事实分别验证 Codex 和 Claude 输出，再核对同一 job 的 `Succeeded`、outbox `Delivered`、
LiViS ACK 与 App 唯一回显。
