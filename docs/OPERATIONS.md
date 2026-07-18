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

插件目录必须同时包含三个文件：

```text
~/.hermes/plugins/livis-bridge/
├── plugin.yaml
├── __init__.py
└── adapter.py
```

从仓库根目录复制：

```bash
install -d -m 0700 "$HOME/.hermes/plugins/livis-bridge"
install -m 0644 \
  hermes-plugin/plugin.yaml \
  hermes-plugin/__init__.py \
  hermes-plugin/adapter.py \
  "$HOME/.hermes/plugins/livis-bridge/"
```

复制后显式启用：

```bash
hermes plugins enable livis-bridge
```

在专用 Hermes profile 的环境中设置：

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
