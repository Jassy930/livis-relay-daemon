# Hermes 实网 canary

本文记录一期 Hermes bridge 的最小实网验收顺序与已知边界。所有账号、Agent ID、node ID、token 和完整业务消息都不得提交到仓库。

## 验收前提

- 使用隔离的 `HERMES_HOME`，不得复用或升级用户的默认 Hermes profile。
- Hermes runtime、bridge 和 LiViS protocol profile 均位于项目审核的版本区间。
- daemon 与 Hermes 两侧使用同一个显式 node allowlist；`allowAllNodes` 和 `LIVIS_ALLOW_ALL_USERS` 都必须为 `false`。
- Hermes 平台配置保持非流式、关闭 tool progress、中间消息、reasoning 和长任务通知。
- `bun run src/index.ts doctor --online` 全部通过，`bun run src/index.ts status` 同时显示 relay handshake 与 connector ready。

## 首次会话顺序

Hermes 0.15.1 会在一个平台的首次会话中先发送一次 home-channel 提示。LiViS 一期 bridge 对每个 job 只允许一个不同的 final，因此该提示会先占用 final，随后生成的模型答复会被 bridge 拒绝，避免向同一个远端 job 投递两个互相冲突的结果。

首次绑定后按以下顺序测试：

1. 在理想同学 App 的“我的 Agent”核对当前 Agent ID，并确认 App 已更新到支持个人 Agent 的版本。
2. 发送 `/sethome`，等待 Hermes 返回 home channel 已设置。
3. 发送唯一 canary，例如 `请只回复：Hermes 联调成功 <随机后缀>`。
4. 确认 App 收到模型纯文本答复。
5. 读回 daemon 状态，确认 job 为 `Succeeded`、outbox 为 `Delivered`，且 Hermes 日志没有第二个 final、fallback send 或权限错误。

`/sethome` 只用于完成 Hermes 的平台初始化并避免一次性提示抢占 canary。它不会放宽一期边界；一期仍不支持 cron/cross-platform 主动推送、附件、审批、流式输出或远程管理命令。

## 2026-07-18 本地证据

本地隔离 profile 使用 Hermes 0.15.1、bridge 0.1.0 和经在线 proof 确认的 LiViS v2.0.0 profile 完成了以下闭环：

- 首条 canary 被 Hermes 接收并调用模型；home-channel 提示先成为唯一 final，daemon 将其持久化并收到 LiViS ACK。模型答复因一期唯一 final 门禁被拒绝，符合安全设计。
- `/sethome` job 进入 `Succeeded`，确认结果进入 durable outbox 并变为 `Delivered`。
- 后续普通文本 job 进入 `Succeeded`；Hermes 完成一次模型调用，纯文本结果进入 durable outbox 并收到 LiViS `ack_send_result`。
- SQLite integrity、上游 supported proof、relay handshake、connector ready 和双重 allowlist 均通过。

### launchd 常驻复验

同一版本组合随后从稳定部署 checkout `$HOME/.local/share/livis-relay-daemon` 切换为两个独立的用户级 LaunchAgent：

- `com.local.livis-relayd` 与隔离 profile 的 `ai.hermes.gateway-livis-test` 均已加载并保持运行；用户原有的默认 `ai.hermes.gateway` 未被替换或停止。
- 稳定 checkout 位于已审核提交 `708b857`，完整 `bun run check` 仍为 57 项 Bun 测试和 22 项 Hermes plugin pytest 通过。
- 常驻切换后，在线 doctor、LiViS supported proof、relay handshake、connector ready 和无 session quarantine 的服务级检查通过。
- 目标消息 `请只回复：launchd 联调成功 #1` 尚未在 daemon 数据库或 Hermes 日志中出现，因此当前没有可归属于该消息的 job `Succeeded`、outbox `Delivered`、Hermes inbound/response 或 App 回显证据。消息真正入站前，不得把服务存活或 WebSocket 握手写成 launchd 端到端 canary 通过。

这份证据只证明上述版本组合的前台纯文本路径，以及 launchd 下的服务存活与连接就绪。它不替代升级后的重新 canary，也不代表 launchd 消息闭环、重启或重新登录后的自动恢复、systemd 常驻、断网重连、取消 race、未来 Hermes 版本或未来 LiViS bundle 已通过生产验收。

## 升级后复验

LiViS 官方 bundle、protocol profile、Hermes runtime 或 bridge 任一项变化后，都必须重新执行：

```bash
bun run src/index.ts upstream check
bun run src/index.ts doctor --online
bun run src/index.ts status
```

只有 supported proof、relay handshake、connector ready、普通文本 `Succeeded` 和 outbox `Delivered` 同时成立，才能把该版本组合加入审核范围。未知版本或缺少最终 ACK 时必须失败关闭。
