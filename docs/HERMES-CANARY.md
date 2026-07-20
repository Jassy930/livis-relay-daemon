# Hermes 实网 canary

本文记录一期 Hermes bridge 的最小实网验收顺序与已知边界。所有账号、Agent ID、node ID、token 和完整业务消息都不得提交到仓库。

## 验收前提

- 使用隔离的 `HERMES_HOME`，不得复用或升级用户的默认 Hermes profile。
- Hermes runtime、bridge 和 LiViS protocol profile 均位于项目审核的版本区间。
- daemon 与 Hermes 两侧使用同一个显式 node allowlist；`allowAllNodes` 和 `LIVIS_ALLOW_ALL_USERS` 都必须为 `false`。
- Hermes 平台配置保持非流式、关闭 tool progress、中间消息、reasoning 和长任务通知。
- `bun run src/index.ts doctor --online` 全部通过，`bun run src/index.ts status` 同时显示 relay handshake 与 connector ready。

## 首次会话顺序

历史 canary 使用的 Hermes 0.15.1 会在一个平台的首次会话中先发送一次 home-channel 提示。LiViS 一期 bridge 对每个 job 只允许一个不同的 final，因此该提示会先占用 final，随后生成的模型答复会被 bridge 拒绝，避免向同一个远端 job 投递两个互相冲突的结果。Hermes 0.18.2 是否仍有相同行为必须由新的隔离 canary 读回确认。

首次绑定后按以下顺序测试：

1. 在理想同学 App 的“我的 Agent”核对当前 Agent ID，并确认 App 已更新到支持个人 Agent 的版本。
2. 发送 `/sethome`，等待 Hermes 返回 home channel 已设置。
3. 发送唯一 canary，例如 `请只回复：Hermes 联调成功 <随机后缀>`。
4. 确认 App 收到模型纯文本答复。
5. 读回 daemon 状态，确认 job 为 `Succeeded`、outbox 为 `Delivered`，且 Hermes 日志没有第二个 final、fallback send 或权限错误。

`/sethome` 只用于完成 Hermes 的平台初始化并避免一次性提示抢占 canary，也是远端文本入口唯一允许的 Hermes 命令。它只在专用 profile 尚无 home channel 时放行一次，并把首个获准 node 对应的 chat 持久写为 home target；设置完成后不能再从 LiViS 重写。其他斜杠命令及 Hermes 识别的自然语言重启别名会在 dispatcher 前失败关闭；blocking tool approval 存在时所有远端回复也会被拒绝。daemon 内部取消直接生成的 `/stop` 不经过该入口。这个例外不会放宽一期边界；一期仍不支持 cron/cross-platform 主动推送、附件、审批、流式输出或其他远程管理命令。

## 2026-07-18 本地证据

本地隔离 profile 使用 Hermes 0.15.1、bridge 0.1.0 和经在线 proof 确认的 LiViS v2.0.0 profile 完成了以下闭环：

- 首条 canary 被 Hermes 接收并调用模型；home-channel 提示先成为唯一 final，daemon 将其持久化并收到 LiViS ACK。模型答复因一期唯一 final 门禁被拒绝，符合安全设计。
- `/sethome` job 进入 `Succeeded`，确认结果进入 durable outbox 并变为 `Delivered`。
- 后续普通文本 job 进入 `Succeeded`；Hermes 完成一次模型调用，纯文本结果进入 durable outbox 并收到 LiViS `ack_send_result`。
- SQLite integrity、上游 supported proof、relay handshake、connector ready 和双重 allowlist 均通过。

这份证据只证明上述版本组合与纯文本路径。它不替代升级后的重新 canary，也不代表 launchd/systemd 常驻、断网重连、取消 race、未来 Hermes 版本或未来 LiViS bundle 已通过生产验收。

## Hermes 0.18.2 有界 runtime canary

当前代码已对照 Hermes 0.18.2 的公开 platform adapter 合约：bridge 接受 `connect(*, is_reconnect=False)`，显式设置 `supports_async_delivery=false`，并通过自动回归确认紧邻到达的 `job → cancel` 会先建立 job/lease/source 映射，再把 `/stop` 交给 Hermes；远端 `/restart`、`/yolo`、`/approve`、`/debug`、自然语言重启别名及 blocking approval 普通文本快捷语均不会进入 Hermes dispatcher。dispatcher 前拒绝与 cancel 并发时通过 `notStarted` 结算为已知未执行，不会进入 `CancelUnknown`；v2 握手、跨 transport 重放和 lease 匹配纠正覆盖断线/daemon 重启窗口。final ACK 后同 session 下一 job 由 bridge 异步等待 owner guard 释放后再 cold-dispatch，不进入会产生中间 ACK 的 Hermes busy-session 路径；stale owner guard 则先按 Hermes 原生逻辑自愈。新初始化配置默认只接受 `[0.18.2, 0.18.3)`。

另已在生产主机现有 Hermes 0.18.2 runtime 中，使用临时 plugin 目录、隔离 `HERMES_HOME` 和 fake UDS daemon 完成有界验证：真实 plugin register/create、`supports_async_delivery=false`、冷启动 final/result_stored、紧邻 job/cancel 仅一个 cancelled、旧 socket 关闭以及 reconnect final 均通过。新增门禁又使用该 runtime 的真实明文命令归一化、session guard 自愈和 blocking approval 状态复验：14 组危险斜杠命令/自然语言重启别名全部在 runner 前以 `notStarted` 拒绝；approval 等待中的普通文本同样被拒绝；拒绝与 cancel 并发时没有生成 `/stop`；普通文本、首次规范化 `/sethome` 和真实 connector cancel 的内部 `/stop` 仍进入预期路径；第二次 `/sethome` 被拒绝。最终复验还确认 v2 的 `prestartFailure + draining` 双能力握手、缺能力失败关闭、live owner 拒绝、done owner guard 自愈、持久 home target 恢复和 runner 注入属性均符合 0.18.2 运行时。针对 settling 窗口的附加复验在 owner 释放前读回为零 dispatch/零 frame，释放后才出现单个 accepted 并 cold-dispatch；等待期 cancel 只产生 `failed.notStarted`，首次 proof 发送失败后仍能在重连握手时重放，旧 v1 daemon 也在 connector hello 前被拒绝。最新 drain 复验进一步确认普通 `failed` 只有收到 `result_stored` 才释放映射；daemon 在 `draining_ack` 前已排入 socket 的 job 没有进入 Hermes，而是形成精确 `notStarted` proof，并在该 proof 收到 `result_stored` 后关闭连接、清空 tombstone。全部临时目录均已删除；验证期间未改写现有生产 profile，也未中断常驻服务，用户级 `hermes-gateway.service` 前后均为 active，PID `2053630`、`NRestarts=0`。

这只证明 0.18.2 runtime 公共接口和本地 connector wire 行为，不是完整实网验收：它没有连接真实 LiViS Relay、没有执行 Device Flow 或真实模型，也没有验证完整生产 profile、durable outbox、session quarantine 和长时间断网恢复。合入或部署前仍须在隔离 profile 中完成这些实网项目并按下节读回证据；不得直接在现有生产 profile 上试验。

## 升级后复验

LiViS 官方 bundle、protocol profile、Hermes runtime 或 bridge 任一项变化后，都必须重新执行：

```bash
bun run src/index.ts upstream check
bun run src/index.ts doctor --online
bun run src/index.ts status
```

只有 supported proof、relay handshake、connector ready、普通文本 `Succeeded` 和 outbox `Delivered` 同时成立，才能把该版本组合加入审核范围。未知版本或缺少最终 ACK 时必须失败关闭。
