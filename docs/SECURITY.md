# 安全边界

## 必须明确确认的事实

- LiViS 当前公开的是 OpenClaw 接入，没有公开第三方 SDK 或稳定协议承诺。
- 本项目只静态兼容官方 v2.0.0 artifact 中观察到的 wire 行为，不执行或复制官方 bundle。
- 原 OpenClaw 插件的 `CommandAuthorized: true` 不适用于本项目。
- 公开仓库不附带 live profile；example 中的端点、OAuth 和哈希均为无效占位值。
- `bun run release:check` 只审核 `git ls-files -z` 返回的 index 内容，拒绝本地状态文件、官方 bundle、归档、生产域名和官方 OAuth client identity 指纹。生产域名仅允许在 Markdown/RST/TXT 安全说明中出现，OAuth identity 与私钥内容没有文档例外。

初始化时必须显式传入 `--acknowledge-unofficial-protocol`。这只是确认已知边界，不代表获得第三方授权。

## 一期强制默认值

- `allowAllNodes=false`，并配置 daemon 与 Hermes 双重 allowlist。
- `LIVIS_ALLOW_ALL_USERS` 必须为空/false，`LIVIS_ALLOWED_USERS=*` 会被拒绝。
- `LIVIS_PHASE1_READ_ONLY_ACK=true` 只在专用 Hermes profile 已关闭写工具后设置。
- Hermes streaming、tool progress、interim message、附件和远程审批全部关闭。
- Hermes runtime 审核范围默认是 `[0.15.1, 0.15.2)`；bridge 范围是 `[0.1.0, 0.2.0)`。
- 未知版本、哈希、wire protocol 或运行契约变化 fail closed。

## 本地权限

- state directory：`0700`。
- connector socket、配置、身份、secret、proof、candidate 与审批回执：`0600`。
- connector 使用至少 32 字节随机 Bearer token，并做常量时间比较。
- refresh token 只由 daemon 持有，不进入 SQLite、argv 或普通日志。
- 一期不读取或发送文件，因此没有远程文件上传路径。

## Upstream 门禁

- `upstream check` 只下载并静态检查，不执行官方脚本或插件。
- setup/install script 上限 2 MiB，package 上限 64 MiB，默认下载超时 30 秒。
- tar 拒绝绝对路径、`..`、超过 20000 个条目和超过 16 MiB 的 `bundle.js`。
- 三份原始 artifact 按 SHA-256 保存，供候选审阅复现。
- supported proof 与 active profile ID、profile SHA、artifact URL/哈希和 marker 绑定，有效期 24 小时。
- daemon 每 6 小时复核；确认 drift/unknown 后停止新 job 并断开 LiViS。暂时网络失败只允许使用尚未过期的 proof。

## 取消与隔离

Hermes `/stop` 不能证明不合作的工具线程已退出。因此 connector 返回 `cancelled` 后，daemon 仍记录 `CancelUnknown` 并隔离 session。只有在重启专用 Hermes Gateway、确认旧工具进程已结束后，才允许人工执行 `session release`。

未知 job 的 `cancel_chat` 可以先于对应消息到达，但 intent 只保留 24 小时，全库最多保留 4096 条。重复 cancel 会刷新同一 intent 的有效期；满额后新的未知 job ID 会被拒绝且不发送成功 ACK，不会静默挤掉 TTL 内已有 intent。job 到达时会在同一 SQLite 事务中应用并删除匹配 intent。旧数据库启动时会删除过期 intent；已有匹配 job 的残留会先按当前状态应用取消，再删除 intent，其中未执行 job 进入 `Cancelled`，active job 进入 `Cancelling` 并在重启恢复中隔离为 `CancelUnknown`。若旧数据已超过上限，只确定性保留最新 4096 条。因此 cancel-before-message 只在 24 小时乱序窗口和容量未耗尽时保证。

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
