# 更新日志

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [未发布]

### 修复

- 结果重试不再覆盖旧的投递 ID；首次投递的延迟 ACK 在重试开始后仍能关联原 job。
- 驱逐失活 connector 后，旧 socket 的延迟 `close` 回调不再误清理复用同一 ID 的新连接。
- `ack_send_result` 的 `ref_msg_id` 现在会按持久化投递记录回查真实 job，引用投递 `msg_id` 的 ACK 不再丢失。
- connector Unix socket 发送遇到背压（Bun `send()` 返回 -1）不再误判为失败，避免同一 job 被重置后重复派发。
- IDaaS refresh 失效以 OAuth error 值为准：`invalid_grant`（常见 HTTP 400）同样清除本地 refresh token 并终止重连；refresh 请求补充 `client_id`。
- Device Flow 依据 OAuth error 处理 `authorization_pending` / `slow_down`，兼容 LiViS IDaaS 对 pending 返回 HTTP 428 的实际行为。
- relay 心跳判活改为任何可解析的服务端消息都刷新，不再仅依赖 WS 协议层 pong。
- `parseSemverTriplet` 拒绝预发布版本（如 `0.15.1-beta`），预发布 Hermes/bridge 不再落入已审核区间。
- profile 激活现在先持久化 supported proof 与审批回执，再以 live config 为最后提交点；跨进程锁与配置内容 CAS 防止并发激活或补偿回滚相互覆盖。

### 变更

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
