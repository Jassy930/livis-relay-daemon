# 更新日志

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [未发布]

### 安全

- Hermes bridge 0.1.1 在建立 job 映射、发送 connector v1 `accepted` 和进入 dispatcher 前拒绝全部远程斜杠命令及 Hermes 0.15.1 的自然语言重启别名；active session、blocking approval 或状态不可读时同样通过当前 lease 的 v1 `failed` 失败关闭。拒绝结果等待 daemon 的 durable `result_stored`，ACK 超时会清理本地 waiter 并关闭 connector；offer tombstone 与 admission reservation 关闭 cancel 和相邻 job 的接纳竞态。daemon 内部 cancel `/stop` 保持独立路径，不引入 connector v2 或 JobStore schema 迁移。
- Hermes home channel 改为本地必填的 `LIVIS_HOME_CHANNEL=livis:<agent_id>`，并强制关闭 gateway 启停通知；远程 `/sethome` 不再是初始化或 canary 步骤。
- daemon 与新配置的版本统一提升为 0.1.1，并内建 bridge 0.1.1 安全下限；存量配置若仍允许 0.1.0 会在启动前失败关闭，必须在停服升级中显式更新并同步安装 bridge。
- bridge 会把非有限、不可解析或超出平台日期范围的远端 job timestamp 降级为当前 UTC 时间，避免异常元数据在输入门禁结算前中止 background task 并遗留 `Dispatching` job。

### 修复

- 本地 `status` 请求增加 3 秒硬超时，避免 connector socket 已接受但 daemon 不响应时让 launchd 启动验收无界卡住。
- 结果 ACK 重试耗尽后改为持久化退避并自动恢复；在线、重连与重启都不会再遗留永久 `AckFailed`，退避期间的迟到 ACK 仍可完成投递。
- WebSocket `send()` 同步失败会原子撤销未出进程的投递 attempt，恢复前一个真实投递 ID 与时间；没有真实 attempt 的 ACK 不再误结算或清除当前 ACK timer。
- CLI、`serve` 启动与 daemon 周期 supported-proof writer 统一使用可验证的 `ProfileOperationGuard` lease；proof 目录逐层固定为 `0700` 并持久化，keyed/alias 半写会按精确内容逆序补偿，绝对到期边界改为 `expiresAt <= now`。
- supported proof 到期由 one-shot timer、Relay admission 与 dispatch 同步失败关闭；claim 后跨期会撤销未发送 lease。Relay 停止失败会保留 blocker 并由后续入口重试，`connected` 回调不会反向等待自身 run loop；daemon 停止会等待在途复核/关门，`serve` 启动失败按主错误、daemon stop、guard release 的固定顺序聚合清理错误。
- AckFailed 迟到 ACK 回归不再用 CI runner 的当前墙钟裁决已持久化的退避状态；测试隔离在线 recovery timer，并改为验证 `nextAttemptAt` 相对 outbox 状态更新时间的因果关系，不改变生产退避语义。
- 普通 profile 激活/回滚改为 guard 内完整 config 文本 CAS、config-last durable rename 与私有 retained-fd readback；禁止 `LIVIS_RELAY_STATE_DIR` 和隐式 stateDir 迁移，拒绝 symlink/hardlink/权限漂移，失败只补偿仍精确命中的本次目标。回滚只恢复 profile 两字段，不再覆盖当前 relay/security/Hermes 等配置。
- protocol profile schema v1→v2 回滚不再把 live target v2 文件健康度当作恢复授权；只要 receipt/source backups 能重建完整 target 关系且当前 config SHA 精确命中，target 缺失、损坏或路径异常时仍可恢复 v1，且不读取、重建或覆盖故障 target。
- schema v1→v2 迁移的 durable 文件、两类 guard 和私有目录现在会在创建句柄或目录上显式固定并读回 `0600` / `0700`，避免极端 `umask` 产生不可读配置、无法释放的 guard 或不可访问目录。
- `logout` 现在只在 IDaaS revoke 返回 2xx 后清除本地 refresh token；远端非 2xx 或网络失败会令命令失败并保留本地可恢复凭据，不再虚假报告撤销成功。
- 重复 `cancel_chat` 现在保持 `Cancelling`，不会误降为 `Cancelled` 并绕过 `CancelUnknown` 与 session 隔离；取消状态转移改为 SQLite 原子条件更新，迟到 cancel 不再回退 `Interrupted` 或其他终态。
- 结果重试不再覆盖旧的投递 ID；首次投递的延迟 ACK 在重试开始后仍能关联原 job。
- 驱逐失活 connector 时会先结算旧 generation 的活跃 lease 并隔离相关 session，再接纳新连接；结算仅在持久化成功后标记完成，首次 SQLite/I/O 失败可由 takeover 或迟到 `close` 重试；旧 socket 的入站消息不再影响复用同一 ID 的新 generation。
- `ack_send_result` 的 `ref_msg_id` 现在会按持久化投递记录回查真实 job，引用投递 `msg_id` 的 ACK 不再丢失。
- connector Unix socket 发送遇到背压（Bun `send()` 返回 -1）不再误判为失败，避免同一 job 被重置后重复派发。
- IDaaS refresh 失效以 OAuth error 值为准：`invalid_grant`（常见 HTTP 400）同样清除本地 refresh token 并终止重连；refresh 请求补充 `client_id`。
- Device Flow 依据 OAuth error 处理 `authorization_pending` / `slow_down`，兼容 LiViS IDaaS 对 pending 返回 HTTP 428 的实际行为。
- relay 心跳判活改为任何可解析的服务端消息都刷新，不再仅依赖 WS 协议层 pong。
- `parseSemverTriplet` 拒绝预发布版本（如 `0.15.1-beta`），预发布 Hermes/bridge 不再落入已审核区间。
- Relay WebSocket 新增兼容旧配置的整体帧上限，并在落盘前限制外部 type、job/message/node 等标识；超长错误不再原样进入日志。
- 提前到达的 cancel intent 会在匹配 job 首次、重复入库或启动恢复时先按状态应用、再同事务消费；未知 intent 采用 24 小时 TTL 和全库 4096 条硬上限，旧 schema v2 数据库会幂等补充 GC 索引并修复历史残留。
- 未在 job 入库事务中消费的历史 cancel intent 只由 daemon 重启恢复事务批量处理；`doctor`、`session release` 等维护命令打开数据库时不再静默改变 active job。

### 变更

- macOS Relay LaunchAgent 模板补齐显式 `HOME`、可解析 Bun/Hermes 的 `PATH`、10 秒启动节流与 `077` umask；运行手册固定稳定 checkout、Relay/Hermes 双 LaunchAgent 的安装、启停、升级、日志和分层验收，并把历史服务级记录与旧基线测试数量降为参考信息。
- JobStore schema 升级为 v3；fresh、v1、v2 数据库在取得 SQLite `IMMEDIATE` 写锁后统一裁决并原子迁移，提交前验证 integrity 与 foreign keys，失败时完整回滚。
- 新增完全离线的 IDaaS / Relay S2 protocol probe、机器可读 wire contract registry、append-only 历史门禁、精确 artifact 发布白名单与严格 fake Relay 场景；当前风险以“观察”记录，不升级为服务端事实。
- protocol profile 升级为 schema v2，强制绑定 `wireContractRevision + credentialMode`；runtime digest、supported proof 与 status 同步绑定，旧 profile/proof 失败关闭。
- 新增 protocol profile schema v1→v2 的 dry-run/apply/rollback 闭环：固定 r1 contract 映射、guard 内重复 config/profile SHA 校验、source→target receipt 重建校验、私有目录与长持有创建 fd 锚定的 guard、私有 PREPARED/备份、durable config/fallback 提交点及 old/new/alias proof quarantine；所有 CLI proof writer 与 serve 启动在持锁后加载 context，已回滚 v1 丢失或损坏时可从已验证备份自愈，全流程不触碰 SQLite。
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
