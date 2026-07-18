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

Hermes 显示配置必须关闭 streaming、tool progress 和 interim assistant messages；工具配置必须为只读，并使用独立工作区。不要在这条远程渠道中启用 manual approval，因为一期没有 approval control lane。bridge 在检测到 blocking approval 时会拒绝该 session 的全部 LiViS 回复并等待 Hermes 自行超时拒绝；这只用于失败关闭，不能把误配的审批流程变成可用功能。

Hermes 0.18.2 建议为 LiViS 使用独立 profile，并在该 profile 的 `config.yaml` 中显式固定：

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

bridge 与 daemon 必须成对升级：新版使用 connector protocol v2，并双向校验 `prestartFailure` 与 `draining` 能力，任一侧仍为旧版都会在 connector 就绪前失败关闭。停止专用 Hermes Gateway 和 `livis-relayd`，在两侧均完成替换后再按下列顺序启动；不要以一方的兼容失败连接承载业务。优雅停止时，bridge 会先发送 `draining`；daemon 在回 `draining_ack` 之前已同步关闭派发门。bridge 随后重放未执行 `failed` proof，并等待对应 `result_stored` 后才关闭 UDS，因此不得用强制杀进程代替正常停止流程。

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

`session release` 会在同一个 SQLite 事务中删除当前 quarantine，并为相关历史 job 写入 durable release marker。该标记用来防止迟到 cancel 重建已经人工解除的隔离，不代表无需重启 Gateway 或确认旧工具进程退出。

schema v2 升级到 v3 时会保留旧版“删除 session quarantine 行即完成人工释放”的状态：legacy quarantine 只绑定到其 `created_at` 所对应的 `Interrupted/CancelUnknown` 故障 epoch；同 session 更早的歧义 job 会回填 release marker。同一毫秒出现多个精确匹配时会全部保留，找不到同事务时间戳的终态 job 时则迁移为 sentinel 并附带现有歧义 job。旧版迟到 cancel 若把隔离来源改成带 lease 的 `Cancelled` 并覆盖原完成时间，也会强制保留 sentinel 和该来源行。以上不确定情况都确保 proof 不能自动解除而人工 release 仍能持久写入 marker，继续 fail-closed 等待人工核验，不能借升级自动解除。
