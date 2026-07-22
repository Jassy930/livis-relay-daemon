# 运行手册

以下命令都在项目根目录执行。示例使用默认配置 `~/.livis-relay/config.json`。配置与 state directory 必须位于 Git 仓库之外；CLI 会拒绝把 live profile、token 或数据库初始化到项目树内。

## 1. 安装开发依赖并自检

```bash
bun install --frozen-lockfile
bun run check
```

## 2. 准备获授权的 protocol profile

公开仓库只提供无效占位值的 [`protocol-profiles/livis-authorized.example.json`](../protocol-profiles/livis-authorized.example.json)。从有权管理相关服务的一方取得参数，将 profile 保存到仓库外的私有位置；不要直接使用 example 连接服务。

当前只接受 protocol profile schema v2，并要求 `wireContractRevision=livis-relay-v1-access-refresh-r1` 与 `credentialMode=access-and-refresh-token` 精确匹配代码 registry。两者描述当前仍向 Relay 发送 refresh token 的兼容基线，不代表服务端要求或目标安全策略。

## 3. 初始化

```bash
bun run src/index.ts init \
  --profile '/绝对路径/authorized-profile.json' \
  --acknowledge-unofficial-protocol
```

`init` 会把已审核 LiViS profile 复制到 state directory，并把该文件的 SHA-256 固定到配置。它不会登录、绑定或启动服务。

已有 schema v1 部署必须按[protocol profile v1→v2 迁移 runbook](UPSTREAM-UPGRADE.md#现有部署的-protocol-profile-schema-v1v2-迁移)处理：先确认 connector socket 父目录是 state directory 内的私有非 symlink 目录，再停止 daemon/Hermes 并禁用服务管理器自动拉起，执行零写入 dry-run，最后显式 apply。命令会保存原 config/profile 和 PREPARED receipt，以 config durable rename 为 apply 唯一提交点，隔离旧/新 supported proof，且不触碰 SQLite。迁移后必须重新执行 `upstream check` 与 `doctor --online` 才能启动；回滚 v1 后必须切回旧 daemon 并重新生成 proof，不得旁路校验。

随后编辑配置：

- 保持 `security.allowAllNodes=false`。
- 将唯一获准且稳定的 LiViS `node_id` 作为 `security.allowedNodeIds` 的唯一元素；不要填写多个值。
- `relay.maxFrameBytes` 控制远端 WebSocket 完整消息的 UTF-8 字节上限；默认 1048576，允许范围为 1 到 16777216。旧配置不含该字段时自动采用默认值。
- 不扩大 Hermes 审核版本范围，除非已按升级 runbook 验证。

一期暂将 `node_id` 视为设备来源标识，一套 daemon、config、state directory 和专用 Hermes profile 只支持该一个设备。配置解析器仍接受数组是格式兼容，不代表支持多设备；不得通过追加第二个 ID、开启 `allowAllNodes` 或直接替换原 ID 来接入另一设备。设备更换、跨设备会话和旧状态迁移均需另行设计与验收。

## 4. 生成近期 upstream 证明

```bash
bun run src/index.ts upstream check
```

只有输出 `compatibility: "supported"` 且 exit code 为 0，才会生成 active profile 的 supported proof。检查只下载并静态读取 artifact，不执行官方脚本。

CLI、`serve` 启动和 daemon 六小时周期复核都通过 state directory 中同一个
`profile-operation.guard` 写 proof。周期复核若恰逢激活、回滚或其他 proof writer
持锁，proof 尚未过期时会记录并跳过本轮；到达 proof 的绝对 `expiresAt` 后，daemon
会在 admission 与 dispatch 同步关闭门禁，即使 one-shot timer 延迟也不会继续接收、
ACK、claim 或 send。Relay 停止失败不会开放门禁，后续入站、派发或复核会重试停止。

不要为消除“guard 已存在”而删除文件；先确认是否有活跃命令，崩溃遗留 guard 按升级
runbook 的 inode/nonce 流程处理。`serve` 启动失败若同时发生 daemon stop 或 guard
release 错误，日志会按主错误、stop、release 顺序聚合；必须先处理最前面的主错误，
并保留无法安全释放的 guard 作为 fail-closed 证据。

## 5. 登录 LiViS

```bash
bun run src/index.ts login
```

完成 Device Flow 后，refresh token 保存在 daemon state directory。不要把 connector token 或 refresh token 粘贴到聊天、日志和 shell history。

### 安全登出与账号边界

`logout` 只负责向 IDaaS 撤销 refresh token 并在远端返回 2xx 后清除本地副本；它不是运行中 daemon 的控制通道。执行前应确认没有活跃 job 或待投递结果，再停止专用 Hermes Gateway 和 `livis-relayd`：

```bash
bun run src/index.ts logout
```

只有看到“已撤销并清除本地 refresh token”才表示远端确认成功。网络失败或远端非 2xx 时命令以失败退出，并故意保留本地 token，便于恢复网络后重试；不要为消除错误而手工删除凭据。

一期尚未把 OAuth 账号 subject 与 `identity.json`、SQLite job/outbox 做持久化绑定，因此不支持在同一个 state directory 中直接切换账号。需要使用另一账号时，应使用独立配置和独立 state directory；不得用 `login --force` 覆盖原账号 token 后继续复用旧 outbox。

## 6. 安装 Hermes plugin

先创建不复制默认凭据、skills、会话或 Gateway 状态的隔离 profile：

```bash
hermes profile create livis-test --no-skills --no-alias \
  --description "LiViS Relay 一期隔离测试 profile"
export LIVIS_HERMES_HOME="$HOME/.hermes/profiles/livis-test"
```

不要使用 `--clone` / `--clone-all`，也不要把插件启用到正在承载其他渠道的默认 Gateway。插件目录必须同时包含三个文件：

```text
$LIVIS_HERMES_HOME/plugins/livis-bridge/
├── plugin.yaml
├── __init__.py
└── adapter.py
```

从仓库根目录复制：

```bash
install -d -m 0700 "$LIVIS_HERMES_HOME/plugins/livis-bridge"
install -m 0644 \
  hermes-plugin/plugin.yaml \
  hermes-plugin/__init__.py \
  hermes-plugin/adapter.py \
  "$LIVIS_HERMES_HOME/plugins/livis-bridge/"
```

复制后显式启用：

```bash
HERMES_HOME="$LIVIS_HERMES_HOME" hermes plugins enable livis-bridge
```

在专用 Hermes profile 的 `.env` 中以 `0600` 权限设置：

```bash
LIVIS_RELAY_SOCKET=$HOME/.livis-relay/connector.sock
LIVIS_RELAY_TOKEN=<使用 connector-token 命令读取>
LIVIS_ALLOWED_USERS=<与 security.allowedNodeIds 完全相同的唯一 node_id>
LIVIS_PHASE1_READ_ONLY_ACK=true
```

启动前读回 daemon 与 Hermes 两处 allowlist，确认它们完全相同且都只有一个值。`LIVIS_ALLOWED_USERS` 的逗号列表语法不代表一期允许配置多个设备。

读取 connector token：

```bash
bun run src/index.ts connector-token
```

Hermes 显示配置必须关闭 streaming、tool progress 和 interim assistant messages；工具配置必须为只读，并使用独立工作区。不要在这条远程渠道中启用 manual approval，因为一期没有 approval control lane。

Hermes 0.15.1 建议为 LiViS 使用独立 profile，并在该 profile 的 `config.yaml` 中显式固定：

```yaml
platform_toolsets:
  livis:
    - no_mcp
display:
  streaming: false
  interim_assistant_messages: false
  platforms:
    livis:
      streaming: false
      tool_progress: "off"
      interim_assistant_messages: false
      long_running_notifications: false
      busy_ack_detail: false
      show_reasoning: false
streaming:
  enabled: false
gateway:
  strict: true
```

`tool_progress` 的关闭值是字符串 `"off"`，不是 `none` 或 YAML 布尔值；必须保留引号。`no_mcp` 让该平台即使以后配置了全局 MCP，也仍保持零工具面。所有 `hermes plugins` / `hermes gateway` 命令都必须带该 profile 的 `HERMES_HOME`，普通命令会误操作默认 profile。

该目录不是 wheel，也不能直接通过 monorepo 根执行 `hermes plugins install owner/repo`；开发、升级和卸载边界见 [`hermes-plugin/README.md`](../hermes-plugin/README.md)。

## 7. 启动顺序

1. 启动 `livis-relayd`。
2. 启动专用 Hermes Gateway。
3. 查看状态与日志。

```bash
bun run src/index.ts serve
bun run src/index.ts status
bun run src/index.ts doctor --online
```

生产运行可参考：

- `packaging/launchd/com.local.livis-relayd.plist.example`
- `packaging/systemd/livis-relayd.service.example`

替换模板中的绝对路径后再加载服务；daemon 和 Hermes Gateway 必须是两个独立服务。

## 8. 结果 ACK 退避与 JobStore v3 升级

`status` 中的 `recentJobs[].outboxStatus=AckFailed` 表示结果在当前 ACK 快速重试
周期耗尽后进入持久化退避；`outboxNextAttemptAt` 是下一次尝试的 Unix 毫秒时间。
退避到期、Relay 重连或 daemon 重启都会自动恢复投递，期间到达的迟到 ACK 也能
直接收敛为 `Delivered`。

本版本第一次由 `serve`、`doctor` 或 `session release` 打开旧 `relay.db` 时，会把
JobStore schema v1/v2 自动升级为 v3。迁移在同一个 SQLite `BEGIN IMMEDIATE`
事务中取得写锁后读取版本，并在提交前运行 integrity 与 foreign-key 检查；失败会
保留原版本，不允许半迁移状态继续运行。部署步骤固定为：

1. 停止 `livis-relayd` 与专用 Hermes Gateway，并禁用服务管理器自动拉起。
2. 完整备份 state directory，包括 `relay.db`、`relay.db-wal` 和
   `relay.db-shm`（若存在）；备份完成前不要运行上述任何会打开 JobStore 的命令。
3. 使用新版本启动一次 daemon，再运行 `status` 与 `doctor --online`，确认 SQLite
   integrity、Relay、connector 和 upstream proof 均正常。

JobStore v3 与 protocol profile schema v1→v2 是两条独立迁移：profile 命令明确
不打开 SQLite，也不会升级或回滚 `relay.db`。如果一次部署同时执行两者，应在两项
操作之前统一停服并备份整个 state directory。旧版 daemon 不认识 JobStore v3；
回滚程序或把 profile 回滚到 v1 时，仍必须同时恢复升级前的数据库备份，不能让旧版
直接打开 v3 数据库。

- 不要删除 `relay.db`，也不要重跑 Agent job；结果投递本来就是至少一次语义，手工
  重跑会扩大业务副作用。
- 如果超过 `outboxNextAttemptAt` 且 Relay 已连接后仍长时间没有新投递，保留
  `status`、`doctor --online` 与 daemon 日志；不要直接编辑 SQLite。

## 9. Session 隔离恢复

看到 `CancelUnknown` 后：

1. 停止并重启专用 Hermes Gateway。
2. 确认旧工具/子进程已经退出。
3. 从 `status` 查到隔离的 `sessionKey`。
4. 执行：

```bash
bun run src/index.ts session release '<sessionKey>'
```

不得只为清除状态而跳过前两步。

## 10. Relay 资源边界告警

日志出现 `WebSocket frame 超过配置的字节上限`、外部标识 `超过字节上限` 或 `pending cancel intent 已达到总量上限` 时，不要直接扩大限制：

1. 确认消息是否来自预期 Relay，并检查上游是否发生重投风暴或协议漂移；
2. unknown cancel 满额时，新 intent 不会落盘，也不会回复成功 ACK；等待已有 intent 被匹配消费或超过 24 小时 TTL 后再重试；
3. 只有已确认合法消息确实需要更大帧时才调整 `relay.maxFrameBytes`，且不得超过 16777216；
4. 监控 `relay.db`、WAL/SHM、进程 RSS 与消息速率。

该门禁只限制单帧、外部标识和临时 cancel intent。它没有实现 jobs/outbox 自动清理，也没有给大量合法小帧的处理队列增加流量整形；历史数据清理由安全手册中的停机流程负责。
