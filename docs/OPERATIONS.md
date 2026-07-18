# 运行手册

以下命令都在项目根目录执行。示例使用默认配置 `~/.livis-relay/config.json`。配置与 state directory 必须位于 Git 仓库之外；CLI 会拒绝把 live profile、token 或数据库初始化到项目树内。

## 1. 安装开发依赖并自检

```bash
bun install --frozen-lockfile
bun run check
```

## 2. 准备获授权的 protocol profile

公开仓库只提供无效占位值的 [`protocol-profiles/livis-authorized.example.json`](../protocol-profiles/livis-authorized.example.json)。从有权管理相关服务的一方取得参数，将 profile 保存到仓库外的私有位置；不要直接使用 example 连接服务。

## 3. 初始化

```bash
bun run src/index.ts init \
  --profile '/绝对路径/authorized-profile.json' \
  --acknowledge-unofficial-protocol
```

`init` 会把已审核 LiViS profile 复制到 state directory，并把该文件的 SHA-256 固定到配置。它不会登录、绑定或启动服务。

随后编辑配置：

- 保持 `security.allowAllNodes=false`。
- 将获准的稳定 LiViS node ID 填入 `security.allowedNodeIds`。
- `relay.maxFrameBytes` 控制远端 WebSocket 完整消息的 UTF-8 字节上限；默认 1048576，允许范围为 1 到 16777216。旧配置不含该字段时自动采用默认值。
- 不扩大 Hermes 审核版本范围，除非已按升级 runbook 验证。

## 4. 生成近期 upstream 证明

```bash
bun run src/index.ts upstream check
```

只有输出 `compatibility: "supported"` 且 exit code 为 0，才会生成 active profile 的 supported proof。检查只下载并静态读取 artifact，不执行官方脚本。

## 5. 登录 LiViS

```bash
bun run src/index.ts login
```

完成 Device Flow 后，refresh token 保存在 daemon state directory。不要把 connector token 或 refresh token 粘贴到聊天、日志和 shell history。

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
LIVIS_ALLOWED_USERS=<与 daemon 一致的逗号分隔 node ID>
LIVIS_PHASE1_READ_ONLY_ACK=true
```

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

## 8. Session 隔离恢复

看到 `CancelUnknown` 后：

1. 停止并重启专用 Hermes Gateway。
2. 确认旧工具/子进程已经退出。
3. 从 `status` 查到隔离的 `sessionKey`。
4. 执行：

```bash
bun run src/index.ts session release '<sessionKey>'
```

不得只为清除状态而跳过前两步。

## 9. Relay 资源边界告警

日志出现 `WebSocket frame 超过配置的字节上限`、外部标识 `超过字节上限` 或 `pending cancel intent 已达到总量上限` 时，不要直接扩大限制：

1. 确认消息是否来自预期 Relay，并检查上游是否发生重投风暴或协议漂移；
2. unknown cancel 满额时，新 intent 不会落盘，也不会回复成功 ACK；等待已有 intent 被匹配消费或超过 24 小时 TTL 后再重试；
3. 只有已确认合法消息确实需要更大帧时才调整 `relay.maxFrameBytes`，且不得超过 16777216；
4. 监控 `relay.db`、WAL/SHM、进程 RSS 与消息速率。

该门禁只限制单帧、外部标识和临时 cancel intent。它没有实现 jobs/outbox 自动清理，也没有给大量合法小帧的处理队列增加流量整形；历史数据清理由安全手册中的停机流程负责。
