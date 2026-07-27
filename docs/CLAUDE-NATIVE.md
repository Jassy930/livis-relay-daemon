# Claude Code 原生当前状态后端

本文记录 `execution.backend=claude` 的首版生产接线、安全边界和人工验收步骤。该能力当前为
`operator-only`：代码、离线状态机、doctor 和原子切换已实现，但尚未完成真实 LiViS App
消息闭环，因此不能标记为 `live-canary-verified`。

## 1. 状态所有权

- LiViS OAuth、job、lease、outbox 和投递 ACK 仍由 Relay daemon 持有。
- Claude Code 自己持有本机当前运行状态。Relay 不读取、复制、迁移、刷新或分类该状态。
- `HOME` 仅作为当前 runtime 选择器交给 Claude Code；Relay 从空环境构造白名单，不整体继承
  daemon 的进程环境。
- 本机未登录、状态过期、provider 错误或其他本地异常都直接交给 Claude Code 决定；Relay 不先
  检查、不执行登录，也不将错误识别为“凭据拒绝”。Claude 给出完整 terminal failure 时只记录
  普通 backend failed；若 spawn 后在安全 init/terminal 前退出，则因提交状态无法证明而进入
  Interrupted/quarantine，不会根据错误文本猜测账号状态。
- 不会静默回退到 Codex 或 Hermes。

JobStore 中的 `claude-stateless:<hash>` 只是本地 durable fencing 锚点，不是 Claude 原生会话。
账号字段保持 `NULL`，`state_ownership=local-state-opaque`。每次任务返回的
`system/init.session_id` 只绑定当前 attempt 的 `provider_operation_id`；首版不保存或恢复 Claude
对话。

## 2. 首版执行面

每个 LiViS job 启动一个 Relay 自己持有的独立 POSIX 进程组，并固定使用以下非交互边界：

```text
--print
--input-format text
--output-format stream-json
--verbose
--safe-mode
--no-chrome
--disable-slash-commands
--strict-mcp-config
--mcp-config {"mcpServers":{}}
--tools ""
--permission-mode dontAsk
--no-session-persistence
--prompt-suggestions false
--max-budget-usd <显式上限>
--system-prompt <固定最小提示>
```

`--bare` 不在允许参数中，因为它会绕过当前本地 OAuth/keychain 状态；`--setting-sources ''`
也不使用，因为实测会切断本机当前设置来源。`--safe-mode` 保留 Claude Code 自己读取当前状态的
能力，同时禁用插件、Hook 和自定义组件执行。Relay 还会验证 `system/init` 回读的
`tools`、`mcp_servers`、`skills` 和 `slash_commands` 均为空，`permissionMode` 必须为
`dontAsk`。当前实测版本（Claude Code 2.1.220）即使在 safe mode 下仍会通过 `plugins` 和
`agents` 返回目录；
这些目录不等于可执行 plugin 或 Agent tool，因此 Relay 只验证两者在出现时仍为数组，不要求
为空。后续 stream 一旦出现 Hook、`tool_use`、`tool_result`、MCP tool 或用户回注事件同样
失败关闭，不能只凭启动参数或目录字段宣称工具已禁用。

首版因此只支持单次纯文本问答，不支持 Claude 工具调用、编码工具、MCP、Chrome、skills、
slash command、Hook、resume 或跨 job 上下文。

## 3. 兼容性与提交状态

版本字符串只作观察，不设固定版本窗口。`doctor` 和启动门禁执行 `--version + --help`，以必需
安全参数是否存在裁决兼容性，不发送模型 turn。执行期再以
`system/init → result` 的有界 `stream-json` 序列裁决协议。

- spawn 失败或 command 在探针后漂移：`not_sent`，daemon 可以安全撤销本次 reservation。
- command 复核尚未完成时若 cancel/stop 先获胜：保证不 spawn，再返回 `not_sent`。
- 子进程一旦 spawn：保守视为 `submitted`，不得自动重发。
- 安全 `system/init` 持久化后：job 进入 `Running`。
- 完整成功 result 且进程组确认收口：唯一 final 进入 outbox。
- terminal error：普通 `Failed`，不分类本地账号状态。
- 超时、无完整 result、协议漂移、进程组无法确认收口：`Interrupted` 或
  `CancelUnknown`，并 quarantine session；不会自动重试。
- terminal 持久化 handler 若异常，adapter 保持 attempt 占用直到执行 fail-closed，随后按
  `executionId` 进入断连隔离；不会在持久化结果未确认时接收下一任务。

## 4. 配置与只读探针

目标配置必须显式选择 `native-current`、绝对 command、单一 node allowlist 和远程执行确认：

```json
{
  "execution": { "backend": "claude" },
  "claude": {
    "mode": "native-current",
    "command": "/绝对路径/claude",
    "requestTimeoutMs": 30000,
    "turnTimeoutMs": 900000,
    "shutdownTimeoutMs": 5000,
    "maxBudgetUsd": 0.05,
    "acknowledgeRemoteExecution": true
  }
}
```

不得配置 model、provider、toolchain 或任意账号字段。停服前可运行只读能力探针：

```bash
bun run src/index.ts claude probe-native-cli \
  --command /绝对路径/claude \
  --state-dir /绝对路径/已有私有状态目录
```

成功报告必须包含 `compatibilityBasis=capability-probe`、`sentModelTurn=false` 和
`credentialStateInspected=false`。

## 5. 原子切换

先确认当前服务无非终态 backlog 和 quarantine，并完整备份 state directory、SQLite WAL/SHM。
当前健康 backend 在所有离线门禁通过前保持运行。准备好后先做零写入计划：

```bash
bun run src/index.ts backend switch claude \
  --mode native-current \
  --command /绝对路径/claude \
  --config /绝对路径/config.json
```

停掉 Relay 和当前 backend 所需常驻服务后执行：

```bash
bun run src/index.ts backend switch claude \
  --mode native-current \
  --command /绝对路径/claude \
  --apply \
  --acknowledge-daemon-stopped \
  --acknowledge-remote-execution \
  --config /绝对路径/config.json
```

dry-run 与 apply 的 `configSha256` 必须一致；PREPARED 收据必须包含
`credentialsReadOrMigrated=false`。切换命令拒绝任意 backend 的非终态 backlog、不兼容 Claude
session anchor 和全部 quarantine，并在提交后读回目标 backend/mode。

## 6. 启动与人工 canary

配置提交后，在 daemon 仍停止时运行：

```bash
bun run src/index.ts doctor --online --config /绝对路径/config.json
```

通过后只启动 `livis-relayd`。Claude 模式不需要 Hermes Gateway，也不会连接或修改 Codex
Desktop daemon。`status` 至少应显示：

- `execution.kind=claude`、`mode=native-current`、`ready=true`；
- `transport=cli-stream-json`、`compatibilityBasis=capability-probe`；
- `stateOwnership=local-state-opaque`、`sessionPersistence=false`；
- `credentialStateInspected=false`；
- backend backlog 与 quarantine 均为空。

这些只证明服务就绪。真实闭环必须由操作者从 LiViS App 发送唯一文本 canary，并对同一 job
同时确认 `Succeeded`、outbox `Delivered`、LiViS ACK 和 App 唯一回显。完成前能力保持
`operator-only`，文档不得写成真实消息链路已验证。

## 7. 当前未验证项

- 真实 LiViS App 文本 canary；
- Claude 本地错误状态经完整 Relay 链路的表现；
- 用户取消、deadline、进程崩溃和长时运行的真实 canary；
- 工具/编码能力、原生会话恢复与跨 job 上下文；
- 多设备、同一 daemon 在线多后端路由或静默 fallback。

离线门禁覆盖见
[`claude_native_cli.test.ts`](../tests/claude_native_cli.test.ts)、
[`claude_native_execution_backend.test.ts`](../tests/claude_native_execution_backend.test.ts)、
[`daemon_execution_backend.test.ts`](../tests/daemon_execution_backend.test.ts)、
[`backend_switch.test.ts`](../tests/backend_switch.test.ts) 和
[`auth_boundary.test.ts`](../tests/auth_boundary.test.ts)。
