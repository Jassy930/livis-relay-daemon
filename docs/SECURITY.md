# 安全边界

## 必须明确确认的事实

- 截至 2026-07-21，在[协议证据账本](LIVIS-RELAY-PROTOCOL-BOUNDARY.md)列明的 GitHub 与聚焦公开网页检索范围内，只找到 OpenClaw 接入线索，未发现可验证的第三方 SDK、服务端 schema 或稳定协议承诺；该阴性结果存在私有和未索引资料盲区。
- 本项目只静态兼容官方 v2.0.0 artifact 中观察到的 wire 行为，不执行或复制官方 bundle。
- 原 OpenClaw 插件的 `CommandAuthorized: true` 不适用于本项目。
- 公开仓库不附带 live profile；example 中的端点、OAuth 和哈希均为无效占位值。
- `bun run release:check` 只审核 `git ls-files -z` 返回的 index 内容，拒绝本地状态文件、官方 bundle、归档、生产域名和官方 OAuth client identity 指纹。生产域名仅允许在 Markdown/RST/TXT 安全说明中出现，OAuth identity 与私钥内容没有文档例外。
- 本地 protocol probe 只使用固定哨兵、注入 fetch 和 loopback；公开发布门禁拒绝私有 probe 回执、raw frame、trace、HAR 与 pcap。probe 成功仍只是 S2。

初始化时必须显式传入 `--acknowledge-unofficial-protocol`。这只是确认已知边界，不代表获得第三方授权。

## 一期强制默认值

- `allowAllNodes=false`；进入 `serve` 或实网 canary 前，`security.allowedNodeIds` 必须恰好包含一个获准 `node_id`。
- `LIVIS_ALLOW_ALL_USERS` 必须为空/false；`LIVIS_ALLOWED_USERS` 必须只包含与 daemon 完全相同的唯一 `node_id`，`*` 和多个值都不属于一期受支持配置。
- `LIVIS_PHASE1_READ_ONLY_ACK=true` 只在专用 Hermes profile 已关闭写工具后设置。
- Hermes streaming、tool progress、interim message、附件和远程审批全部关闭。
- Hermes runtime 审核范围默认是 `[0.15.1, 0.15.2)`；bridge 范围是 `[0.1.0, 0.2.0)`。
- 未知版本、哈希、wire protocol 或运行契约变化 fail closed。

## 设备来源边界

一期暂将 `from_node_id` 视为设备来源标识，但该值不是账号 subject，也不构成密码学设备认证。配置结构接受数组和逗号列表只是为了兼容现有格式，不表示多设备拓扑已经设计、验证或受到支持。

一套 daemon、config、state directory 与专用 Hermes profile 只能绑定一个来源设备。不得同时放行第二个 `node_id`，不得在同一状态目录中原地替换 `node_id`，也不得假设不同设备可以继承同一个 Hermes session、job、quarantine 或 outbox。设备更换和多设备支持必须先定义上游 ID 稳定性、账号绑定、状态迁移、回滚与真实设备 canary，再作为独立方案评审。

当前版本尚未在 daemon 与 Hermes 两侧把“恰好一个 ID”实现为代码级硬门禁：解析器仍接受多值配置，运行前必须人工读回双侧 allowlist。该残余意味着文档只定义受支持拓扑，不能被表述为已完成逐帧设备认证；尤其 `cancel_chat` 只有 `job_id`、没有来源 `node_id`，其身份边界仍依赖已建立的 Relay 连接和一期单设备部署约束。

## 本地权限

- state directory：`0700`。
- connector socket、配置、身份、secret、proof、candidate 与审批回执：`0600`。
- schema v1→v2 迁移和 supported-proof writer 新建的私有目录会在 fsync 前显式固定并精确读回 `0700`；若上次进程在 `mkdir` 与固定权限之间退出，重试会受控修复只缺 owner 权限的已有目录。durable 临时文件与两类 guard 会在各自创建 fd 上显式固定并精确读回 `0600` 后才写入、同步或 rename。不能只依赖 `mkdir` / `open` 的 mode 参数，因为进程 umask 仍可能移除 owner 权限。
- `config.connector.socketPath` 的父目录必须是 state directory 内的私有非 symlink 目录；profile 迁移会在该路径创建并持久化普通文件 guard。创建 fd 会保持打开到安全 release，以固定原 inode，并与当前路径交叉复核 dev/inode、link count、文件类型、权限和 nonce；父目录的类型、私有权限与 realpath 也会在每次所有权检查和 release 完成前重验。位于 `/tmp` 等共享目录或 state directory 外的 socket 不属于迁移支持边界。
- connector 使用至少 32 字节随机 Bearer token，并做常量时间比较。
- refresh token 只在 daemon state directory 持久化，不进入 SQLite、argv、普通日志或 Git。当前 v2.0.0 兼容基线仍会把它复制进 Relay `connect` / `token_refresh` 帧：历史高层 canary 发生在旧代码基线，但没有字段级 receipt，也不证明服务端要求该字段；这是待收口的显式安全例外。目标是 Relay 只接收短期 access token，但在真实 Relay canary 前不得宣称兼容，也不得设置静默泄露回退。证据和门禁见[服务端协议边界](LIVIS-RELAY-PROTOCOL-BOUNDARY.md)。
- 一期不读取或发送文件，因此没有远程文件上传路径。

## Upstream 门禁

- `upstream check` 只下载并静态检查，不执行官方脚本或插件。
- setup/install script 上限 2 MiB，package 上限 64 MiB，默认下载超时 30 秒。
- tar 拒绝绝对路径、`..`、超过 20000 个条目和超过 16 MiB 的 `bundle.js`。
- 三份原始 artifact 按 SHA-256 保存，供候选审阅复现。
- supported proof 与 active profile ID/SHA、runtime contract SHA、wire revision、credential mode、artifact URL/哈希和 marker 绑定，有效期 24 小时；旧 proof 失败关闭。
- schema v1→v2 迁移和回滚会把 old SHA、new SHA 与 `last-supported` proof 持久化移入 0700 私有 quarantine，永不自动恢复；两条方向都必须重新在线生成 proof。apply 以 config durable rename 为唯一提交点；回滚通常同样提交 config，但已生效 fallback 的自愈以 fallback profile durable rename 为提交点，且 proof 必须先隔离。receipt/backups 会重新构造并核对完整 source→target 关系，PREPARED/备份与 target/fallback profile 均为 0600，命令不打开 SQLite。
- migration、upstream 管理命令、`login` proof 刷新、`serve` 启动和 daemon 周期 proof writer 共享 profile operation guard；CLI 在持锁后加载完整 context，daemon 写入前后验证同一 guard 仍属于当前 state directory。外部编辑器与 `init` 不受该协作锁约束，停服迁移期间仍必须禁止它们写 config/profile。rename 后父目录 fsync 未确认时会保留 guard 并要求人工按 receipt/SHA 恢复，不得按当前可见内容自动放行。
- daemon 每 6 小时主动复核，但 `expiresAt` 是独立的绝对硬门禁：one-shot deadline、Relay admission 与 dispatch 都同步检查，到期即停止 ingest/ACK/claim/send 并断开 LiViS；timer 延迟、guard busy 或暂时网络失败都不能延长 proof。Relay 停止失败时 blocker 持续有效并允许后续入口重试 stop；恢复路径等待完整停止后会再次检查新 proof，等待期间跨期不得清除 blocker、重连或派发。停止 daemon 会等待在途复核和关门，返回后不得再写 proof、重连或派发。

## 认证生命周期

- `logout` 不是运行中 daemon 的控制通道；执行前必须停止专用 Hermes Gateway 与 daemon，避免进程继续使用内存中的 access token 或已缓存 refresh token。
- IDaaS revoke 只有返回 2xx 才允许删除本地 refresh token；网络失败或远端拒绝时保留本地凭据并明确失败，供操作者重试。
- 一期没有 OAuth 账号 subject 与 identity/outbox 的迁移契约，不支持在同一 state directory 直接切换账号；不同账号必须使用隔离的配置和状态目录。

## 取消与隔离

Hermes `/stop` 不能证明不合作的工具线程已退出。因此 connector 返回 `cancelled` 后，daemon 仍记录 `CancelUnknown` 并隔离 session。只有在重启专用 Hermes Gateway、确认旧工具进程已结束后，才允许人工执行 `session release`。

未知 job 的 `cancel_chat` 可以先于对应消息到达，但 intent 只保留 24 小时，全库最多保留 4096 条。重复 cancel 会刷新同一 intent 的有效期；满额后新的未知 job ID 会被拒绝且不发送成功 ACK，不会静默挤掉 TTL 内已有 intent。job 到达时会在同一 SQLite 事务中应用并删除匹配 intent。旧数据库启动时会删除过期 intent；当前 scope 已有匹配 job 的残留会先按当前状态应用取消，再删除 intent，其中未执行 job 进入 `Cancelled`，active job 进入 `Cancelling` 并在重启恢复中隔离为 `CancelUnknown`。若旧数据已超过上限，只确定性保留最新 4096 条。因此 cancel-before-message 只在 24 小时乱序窗口和容量未耗尽时保证。

## Relay 输入资源边界

- `config.relay.maxFrameBytes` 默认 1 MiB，最大允许 16 MiB；旧 schema v1 配置缺少该字段时使用默认值。
- `ws` 在组装完整消息、解压、转成字符串和 JSON 解析前执行整体 payload 上限；回调中再次按 UTF-8 字节数检查。
- envelope 与业务 `type` 最多 64 UTF-8 字节；job/message/ACK/node/agent/device ID 最多 256 字节；node type 最多 64 字节。超限值不会进入 handler、SQLite 或普通日志。
- 日志中的非秘密字符串超过 1024 UTF-8 字节时整段替换为长度摘要；token、authorization、secret、password 和 cookie 字段仍整段脱敏。

这些限制约束单帧和单条标识，不构成完整流量整形。当前消息处理 Promise 队列没有独立深度/累计字节上限，大量合法小帧仍可能形成短时积压；应在受控 Relay、网络层限速和进程监控下运行。

## 数据落盘与保留

SQLite 默认明文保存 `from_node_id`、输入文本、原始 payload、job/lease 状态和最终结果。数据库依赖 state directory 的 `0700` 与数据库/WAL/SHM 的 `0600` 权限保护，不提供静态加密。

除上述临时 `pending_cancels` 外，一期仍没有 jobs、outbox 或投递尝试的自动保留期和后台 purge；这些记录会持续保留，直到操作者主动清理。合法但未授权 node 的请求仍保持原有回复语义：先持久化为 `Rejected` 并通过 outbox 返回配置的未授权提示，本次资源边界不改变这一行为。需要彻底清除历史时：

1. 停止 daemon 和专用 Hermes Gateway；
2. 按组织要求备份或销毁 `relay.db`、`relay.db-wal`、`relay.db-shm`；
3. 重新启动前执行 `doctor`，确认新数据库完整且 session quarantine 为空。

不要在服务运行期间直接删除或复制 WAL/SHM，也不要把数据库加入 issue、测试 fixture 或 Git 提交。
