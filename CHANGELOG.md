# 更新日志

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [未发布]

### 修复

- LiViS 远端消息进入 Hermes 前只在 home channel 尚未设置时放行一次精确的 `/sethome`；其余斜杠命令及 Hermes 识别的自然语言重启别名均失败关闭。Hermes 存在 blocking tool approval 时，所有 LiViS 远端回复都会被拒绝，避免普通文本被升级为 `/approve`；daemon 内部取消使用的 `/stop` 不受影响。
- dispatcher 前拒绝使用 `failed.notStarted=true` 结算，daemon 可区分“从未执行”与执行后失败；若 cancel 先获胜则直接进入 `Cancelled`，不发送 `/stop`、不卡在 `Cancelling`，也不隔离从未运行的 session。
- connector protocol 升至 v2，`hello` 与 daemon `hello_ack` 双向协商 `prestartFailure` 与 `draining` 能力；新旧组件混用时在 connector 就绪前失败关闭，不会将派发前拒绝误当为已执行失败。
- 未执行拒绝证明跨 UDS 重连保留并在就绪前重放；匹配 lease 的证明可纠正断线/重启窗口产生的 `Interrupted` 或 `CancelUnknown`。quarantine schema v3 将隔离绑定到具体 `jobId + leaseId`，旧 proof 不会误解除后续真实执行，人工释放会写入 durable marker，防止迟到 cancel 重建已解除的 quarantine；v2 数据库迁移按同事务时间戳只把 legacy quarantine 绑定到对应故障 epoch，同 session 更早或升级前已删除 legacy 行的历史歧义回填 marker，同毫秒精确匹配碰撞、无法匹配的孤儿行或被旧版迟到 cancel 覆盖时间戳的带 lease `Cancelled` 来源则保留为 fail-closed 隔离，等待显式 release。
- final/failed 与 Hermes owner guard 释放之间的收尾窗口由 bridge 异步等待后 cold-dispatch 同 session 后续 job，不进入会产生中间 ACK 的 busy-session 路径；等待、accepted 发送、guard 注册和 active handoff 四个取消窗口各自由单一状态所有者结算，已结束 owner 遗留的 stale guard 则先自愈。
- `Interrupted` 后到的 cancel 保持为 `CancelUnknown` 并继续隔离；只有当前 job 本身从 `Interrupted/CancelUnknown` 被匹配 lease 的未执行证明纠正时，才可解除它的 session quarantine。
- Hermes plugin 适配 0.18.2 的 `connect(*, is_reconnect=False)` 生命周期签名，Gateway 重连不再因未知关键字参数失败。
- listener teardown 捕获并关闭自己持有的具体 UDS WebSocket，只清理同一代连接状态，并在断线后幂等中断已注册任务，避免旧连接残留导致重连 hello 冲突；graceful disconnect 发送 `draining` 后，daemon 在 `draining_ack` 前同步关闭 dispatch gate，bridge 重放未执行 proof 并等待所有 `result_stored` 才关闭 UDS。drain 的发送、握手与 proof ACK 共用一个有界预算，UDS writer 背压也不能让 Gateway 停止无限挂起。
- connector 在完成 job 映射与 accepted 后等待 Hermes 0.18.2 注册会话 guard 和后台处理任务，再读取紧邻的 cancel，避免 `/stop` 抢在原 job 前成为独立 turn；注册前异常会以精确 `notStarted` proof 清理 lease，即使 cancel 已先进入 `Cancelling` 也能结算；后台结果不会阻塞 socket reader 读取 ACK 与心跳。
- `/stop` 取消旧后台任务时，Hermes completion hook 与 connector cancel 路径共享按 `jobId + leaseId` 幂等的 cancelled 通知，避免同一取消重复上报；重复 Relay cancel 保持 `Cancelling` 并重发同一 lease，不会提前解除隔离。
- final 文本的“已尝试发送”与 daemon `result_stored` 的“已 durable”分开记录；普通 `failed` terminal 也必须等待同样的 durable ACK。输出被拒绝、ACK 丢失或 final/cancel 竞争时，completion hook 仍会形成唯一 terminal failure/cancel，而不会让 daemon 永久停在 `Running/Cancelling`。
- bridge 显式声明不支持 turn 结束后的异步投递，Hermes 不再为一期 job/lease 通道承诺后台任务完成通知。
- 结果重试不再覆盖旧的投递 ID；首次投递的延迟 ACK 在重试开始后仍能关联原 job。
- 驱逐失活 connector 后，旧 socket 的延迟 `close` 回调不再误清理复用同一 ID 的新连接。
- `ack_send_result` 的 `ref_msg_id` 现在会按持久化投递记录回查真实 job，引用投递 `msg_id` 的 ACK 不再丢失。
- connector Unix socket 发送遇到背压（Bun `send()` 返回 -1）不再误判为失败，避免同一 job 被重置后重复派发。
- IDaaS refresh 失效以 OAuth error 值为准：`invalid_grant`（常见 HTTP 400）同样清除本地 refresh token 并终止重连；refresh 请求补充 `client_id`。
- Device Flow 依据 OAuth error 处理 `authorization_pending` / `slow_down`，兼容 LiViS IDaaS 对 pending 返回 HTTP 428 的实际行为。
- relay 心跳判活改为任何可解析的服务端消息都刷新，不再仅依赖 WS 协议层 pong。
- `parseSemverTriplet` 拒绝预发布版本（如 `0.15.1-beta`），预发布 Hermes/bridge 不再落入已审核区间。

### 变更

- 新初始化配置和公开示例的 Hermes 默认审核范围收紧为 `[0.18.2, 0.18.3)`；0.18.3 及其他未知版本继续失败关闭。
- `config.connector.resultStoreTimeoutMs` 通过 `hello_ack` 下发给 Hermes plugin，替代 plugin 侧硬编码 5 秒。
- cancel 竞争获胜后到达的 final/failed 上报改用专用错误码 `cancel_superseded`，plugin 将其按取消成功处理，不再向 Hermes 报告投递失败。
- upstream 门禁关闭后周期复核继续运行，恢复 `supported` 时自动重连 LiViS relay，不再要求重启进程。
- hello 冲突时若旧 connector 已错过两个心跳周期则驱逐旧连接，缩短 Hermes 重启后的重连黑洞。

## [0.1.0] - 2026-07-18

### 新增

- 独立 Bun/TypeScript LiViS relay daemon。
- 版本化 protocol profile 框架、无效占位 example、IDaaS Device Flow 和远端 WebSocket。
- SQLite durable jobs/outbox、幂等、lease fencing、取消竞态与 session quarantine。
- 仅通过 Unix Domain Socket 连接的 Hermes platform plugin。
- 官方 artifact 检查、supported proof、候选审阅、显式激活和回滚。
- macOS launchd 与 Linux systemd 示例。
- Bun fake LiViS/SQLite/connector 测试和 Hermes pytest。

[0.1.0]: https://github.com/Jassy930/livis-relay-daemon/releases/tag/v0.1.0
