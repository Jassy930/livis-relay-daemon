# Hermes 实网 canary

本文记录一期 Hermes bridge 的最小实网验收顺序与已知边界。所有账号、Agent ID、node ID、token 和完整业务消息都不得提交到仓库。

本文是 canary 操作与历史结果，不是服务端规范。各步骤能证明和不能证明的协议事实，以[LiViS 服务端协议证据与支持边界](LIVIS-RELAY-PROTOCOL-BOUNDARY.md)为准。

## 验收前提

- 使用隔离的 `HERMES_HOME`，不得复用或升级用户的默认 Hermes profile。
- 使用干净、路径稳定且精确锁定已审阅提交的部署 checkout；记录 commit，不能只记录分支名。
- active LiViS protocol profile 必须是当前支持的 schema v2；Hermes runtime 固定在 `[0.15.1, 0.15.2)`，bridge 位于配置审核范围。未来 Hermes runtime 或 connector protocol 设计不能自动扩大本 canary 的支持窗口。
- daemon 与 Hermes 两侧使用同一个且只包含唯一 `node_id` 的显式 allowlist；一期暂将该值视为本次 canary 的设备来源标识。`allowAllNodes` 和 `LIVIS_ALLOW_ALL_USERS` 都必须为 `false`。
- 专用 profile 的 `.env` 已在本地把 `LIVIS_HOME_CHANNEL` 固定为 `livis:<当前 identity.json.agentId>`，`config.yaml` 已设置 `livis.gateway_restart_notification: false`；不得通过远程 `/sethome` 初始化。
- Hermes 平台配置保持非流式、关闭 tool progress、中间消息、reasoning 和长任务通知。
- `bun run probe:protocol:check` 与 `bun run src/index.ts doctor --online` 全部通过；`status` 显示预期的 wire revision/mode、relay handshake 与 connector ready。

本 canary 只证明单个来源设备的闭环，不证明多设备接入、跨设备会话、设备 ID 轮换或状态迁移；不要在同一 config/state directory 中加入第二个 `node_id` 进行扩展测试。

## 首次会话顺序

Hermes 0.15.1 只在对应 `*_HOME_CHANNEL` 环境变量缺失时生成一次 home-channel 提示。当前 bridge 把有效的本地 `LIVIS_HOME_CHANNEL` 设为启动硬门禁，因此正常 canary 不应再出现该提示，也不需要先消耗一个远程 job。若变量缺失、格式错误或与 runtime platform config 冲突，bridge 必须拒绝连接；不得用远程命令补救。

首次绑定后按以下顺序测试：

1. 在理想同学 App 的“我的 Agent”核对当前 Agent ID，并确认 App 已更新到支持个人 Agent 的版本。
2. 在本机从当前 state directory 的 `identity.json.agentId` 重新计算 `livis:<agent_id>`，逐字读回专用 profile `.env` 的 `LIVIS_HOME_CHANNEL`；真实 ID 只留在私有验收记录中。
3. 启动专用 Gateway，确认没有 home-channel 或 gateway restart 主动通知，并确认 connector ready。
4. 发送唯一 canary，例如 `请只回复：Hermes 联调成功 <随机后缀>`。
5. 确认 App 收到模型纯文本答复。
6. 读回 daemon 状态，确认同一 job 为 `Succeeded`、outbox 为 `Delivered`，且 Hermes 日志没有 home-channel 提示、第二个 final、fallback send、远程命令或权限错误。

不要在 canary 中发送 `/sethome`、`/restart`、`/approve`、`/yolo` 或任何其他斜杠命令。bridge 会在建立映射、发送 `accepted` 和进入 Hermes dispatcher 前用当前 connector v1 `failed` 拒绝；active session、blocking approval 或状态不可读时也执行相同失败关闭。daemon 为 cancel 合成的内部 `/stop` 仍是独立控制路径。一期仍不支持 cron/cross-platform 主动推送、附件、审批、流式输出或远程管理命令。

## 历史证据，不是当前验收

### 2026-07-18 前台纯文本摘要

旧基线 `708b857` 曾记录隔离 profile 使用 Hermes 0.15.1、bridge 0.1.0 与私有 LiViS v2.0.0 profile 完成前台纯文本闭环的高层人工摘要：当时的远程 `/sethome` 与后续普通文本 job 到达 `Succeeded`，durable outbox 到达 `Delivered`。远程 `/sethome` 现已被安全门禁废止，该旧步骤不得用于当前验收。

该记录没有符合当前要求的字段级 receipt，且早于 protocol profile v2、一期单设备文档边界、Relay 资源门禁、connector replacement 代际结算和 JobStore v3。当前代码不能继承它作为通过门禁；它只说明旧版本组合在当时曾完成过高层路径。

### 历史 LaunchAgent 摘要

旧 PR #17 的 head `72efad0` 曾写入两个独立用户级 LaunchAgent 的服务存活、online doctor、Relay handshake 与 connector ready 高层摘要，并明确当时的稳定 checkout 仍是 `708b857`。该来源仍只是旧提交中的自述：目标普通文本没有进入 daemon 数据库或 Hermes 日志，因此没有同一常驻 job 的 `Succeeded`、outbox `Delivered`、Hermes inbound/response 或 App 回显证据。旧 head 的固定测试数量和旧 CI 也不适用于当前 main。

所以，该历史记录最多证明“服务与连接就绪”，不是 launchd 消息闭环。本文和运行手册提供的是当前复验步骤；本次文档与模板修改没有操作真实 `launchctl`，也没有执行新的 LiViS canary。

## 当前 launchd canary 记录要求

先按[运行手册的 macOS LaunchAgent 章节](OPERATIONS.md#macos-launchagent)完成静态部署、双服务启动和 JobStore v8 备份/升级边界。随后记录：

1. daemon 精确 commit、protocol profile ID/SHA、wire revision/mode 与 supported proof 时间；
2. Hermes runtime 0.15.1、bridge 版本、隔离 profile 与两个 LaunchAgent label；
3. 唯一获准 `node_id` 的双侧单元素 allowlist 已读回一致，本地 `LIVIS_HOME_CHANNEL` 与当前 `identity.json.agentId` 也已逐字核对，但不记录真实 ID；
4. `plutil -lint`、online doctor、Relay handshake、connector ready、SQLite integrity 和 quarantine 状态；
5. 带随机后缀的唯一消息在 App、Hermes 和 daemon 三侧的脱敏关联结果，以及同一 job 的 `Succeeded` 与 outbox `Delivered`。

只完成前四项时，结论必须写“服务与连接就绪，消息闭环未验证”。看见 PID、`state=running`、WebSocket 握手或 connector ready 都不能写成 canary 通过。

### 2026-07-24 服务与连接就绪回执

本机在停服窗口将稳定部署 checkout 从旧基线升级并固定到 `eea85c9`。升级前完整备份了
state directory；稳定 checkout 随后通过 `bun run check`，其中包括 451 个 Bun 测试和
59 个 Hermes bridge 测试。隔离 `livis-test` profile 的 bridge 已由原子安装器从 `0.1.0`
升级到 `0.1.1`，Hermes runtime 保持 `0.15.1`。

存量 protocol profile 已通过受控迁移从 schema v1 升级到 schema v2，目标 SHA-256 为
`c8f40fb6c132b363be8695ea4e6ef9116f928c5ff2d3c02070f668ff40c11e61`，wire revision 为
`livis-relay-v1-access-only-r2`，credential mode 为 `access-token-only`。迁移后重新执行
upstream check，LiViS v2.0.0 bundle 与当前 profile 精确匹配；online doctor 的配置、profile、
Hermes 版本、SQLite integrity、quarantine、backend backlog、supported proof 和 upstream
compatibility 全部通过。

随后按 Relay → Hermes 顺序启动两个独立 LaunchAgent。最终二读确认 Relay daemon `0.1.1`
已与 LiViS 完成握手，Hermes bridge `0.1.1` 已通过本地 connector 鉴权，`execution.ready` 与
`connector.ready` 均为 `true`，且无 backend backlog 或 quarantined session。

截至该次 2026-07-24 回执，没有从 App 发送新的随机后缀消息，因此结论严格保持为：
**服务与连接就绪，消息闭环未验证**。
旧 job 的 `Succeeded/Delivered` 只能说明历史执行结果，不能替代当前版本组合的消息 canary。

### 2026-07-25 launchd 普通文本闭环回执

在上述双 LaunchAgent 未重启、部署 checkout 仍固定为 `eea85c9` 的现场，操作者从 App
重发唯一 canary `请只回复：Hermes 联调成功 0725-1147`。Relay 将其持久化为 job
`20260725115349-f255bc14-61a6-4ace-8a7a-24f4bacb8c2b`，目标 backend 为 `hermes`。

Hermes 专用 Gateway 日志只记录一次对应 inbound、一次 response ready 和一次 send：11:53:55
收到消息，4.1 秒后生成纯文本 `Hermes 联调成功 0725-1147`。daemon 随后把同一 job
结算为 `Succeeded`，durable outbox 在 11:53:59 到达 `Delivered` 并取得 Relay ACK；持久化
结果与 Hermes 输出逐字一致。操作者随后在 App 端确认收到该纯文本回显。

同一时段的二读状态继续显示 daemon `0.1.1`、Hermes runtime `0.15.1`、bridge `0.1.1`，
Relay 已连接并完成握手，`execution.ready` 与 `connector.ready` 均为 `true`，无 backend
backlog 或 quarantined session；supported proof 有效至 `2026-07-26T01:13:50.137Z`。
上游还先释放并成功交付了此前排队的旧随机后缀 canary，但它不替代上述新 job 的关联证据。

因此，`eea85c9`、protocol profile schema v2、`livis-relay-v1-access-only-r2`、
`access-token-only`、Hermes runtime `0.15.1` 与 bridge `0.1.1` 这一精确组合已完成本轮
launchd 普通文本闭环。该结论只覆盖本文定义的单设备、非流式纯文本路径，不扩大到附件、
审批、远程管理命令、多设备或其他 backend。

## 升级后复验

LiViS 官方 bundle、protocol profile、Hermes runtime 或 bridge 任一项变化后，都必须重新执行：

```bash
bun run src/index.ts upstream check
bun run src/index.ts doctor --online
bun run src/index.ts status
```

当前 daemon 首次打开旧数据库时还可能执行 JobStore v8 迁移；因此升级前必须停掉 Relay/Hermes 并完整备份 state directory，不能把数据库迁移成功等同于消息验收。若 v4 仍有待派发 job，还必须先确认并显式声明其原始 backend，不能借迁移切换 provider；准备切换 backend 时还必须先排空原 backend 的全部非终态 job，并确认 `doctor.execution_backend_backlog` 通过。

只有 supported proof、Relay handshake、connector ready、普通文本 `Succeeded`、outbox `Delivered`、Hermes inbound/response 与 App 纯文本回显同时成立，才能把精确版本组合加入审核范围。未知版本、缺少最终 ACK、只完成服务级检查或没有当前 head 的脱敏记录时必须失败关闭。
