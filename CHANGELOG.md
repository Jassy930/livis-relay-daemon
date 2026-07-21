# 更新日志

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [未发布]

### 修复

- `logout` 现在只在 IDaaS revoke 返回 2xx 后清除本地 refresh token；远端非 2xx 或网络失败会令命令失败并保留本地可恢复凭据，不再虚假报告撤销成功。
- 重复 `cancel_chat` 现在保持 `Cancelling`，不会误降为 `Cancelled` 并绕过 `CancelUnknown` 与 session 隔离；取消状态转移改为 SQLite 原子条件更新，迟到 cancel 不再回退 `Interrupted` 或其他终态。
- 结果重试不再覆盖旧的投递 ID；首次投递的延迟 ACK 在重试开始后仍能关联原 job。
- 驱逐失活 connector 后，旧 socket 的延迟 `close` 回调不再误清理复用同一 ID 的新连接。
- `ack_send_result` 的 `ref_msg_id` 现在会按持久化投递记录回查真实 job，引用投递 `msg_id` 的 ACK 不再丢失。
- connector Unix socket 发送遇到背压（Bun `send()` 返回 -1）不再误判为失败，避免同一 job 被重置后重复派发。
- IDaaS refresh 失效以 OAuth error 值为准：`invalid_grant`（常见 HTTP 400）同样清除本地 refresh token 并终止重连；refresh 请求补充 `client_id`。
- Device Flow 依据 OAuth error 处理 `authorization_pending` / `slow_down`，兼容 LiViS IDaaS 对 pending 返回 HTTP 428 的实际行为。
- relay 心跳判活改为任何可解析的服务端消息都刷新，不再仅依赖 WS 协议层 pong。
- `parseSemverTriplet` 拒绝预发布版本（如 `0.15.1-beta`），预发布 Hermes/bridge 不再落入已审核区间。

### 变更

- 新增完全离线的 IDaaS / Relay S2 protocol probe、机器可读 wire contract registry、append-only 历史门禁、精确 artifact 发布白名单与严格 fake Relay 场景；当前风险以“观察”记录，不升级为服务端事实。
- protocol profile 升级为 schema v2，强制绑定 `wireContractRevision + credentialMode`；runtime digest、supported proof 与 status 同步绑定，旧 profile/proof 失败关闭。
- 新增 protocol profile schema v1→v2 的 dry-run/apply/rollback 闭环：固定 r1 contract 映射、guard 内重复 config/profile SHA 校验、source→target receipt 重建校验、私有目录/inode 持久化 guard、私有 PREPARED/备份、durable config/fallback 提交点及 old/new/alias proof quarantine；所有 CLI proof writer 与 serve 启动在持锁后加载 context，已回滚 v1 丢失或损坏时可从已验证备份自愈，全流程不触碰 SQLite。
- 新增 LiViS IDaaS / Relay 服务端协议证据账本，分开真实 canary、官方客户端静态观察、fake Relay、工程推断与未知项，并为 wire 变化建立 Draft、脱敏 canary 和精确 head 门禁。
- 一期受支持拓扑明确为一个 daemon、config、state directory 和专用 Hermes profile 只绑定一个 LiViS `node_id`（暂按设备来源标识理解）；多设备、跨设备会话和原地换设备不在当前范围内。
- Hermes plugin 的开发测试依赖约束升级至 `pytest>=9.0.3,<10` 与 `pytest-asyncio>=1.3,<2`（当前锁定 9.1.1 / 1.4.0），修复旧版 pytest 的安全告警；运行时依赖保持不变。
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
