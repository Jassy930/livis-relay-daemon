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

## Hermes 会话隔离

每个 LiViS 来源节点使用独立 Hermes `chatId`：

```text
livis:account:<sha256(accountId)>:agent:<sha256(agentId)>:node:<sha256(from_node_id)>
```

三个身份段均使用固定长度 SHA-256 和显式标签，保留 account/agent 命名空间并避免分隔符碰撞；原始节点 ID 不直接进入 `chatId`。哈希只用于稳定编码，不是加密或匿名化。不同节点不会共享 Hermes 对话历史、单 session 执行锁或 session quarantine。

从旧版升级时，daemon 会把已落盘作业从旧共享 session 重建到各节点 session；旧共享 session 上已有的隔离记录会保守地展开到其中出现过的所有节点。Hermes 中既有的共享对话历史无法安全拆分，因此升级后会被有意切断，不会由任一节点继承；各节点的下一条消息从新的独立 `chatId` 开始。

## 数据落盘与保留

SQLite 默认明文保存 `from_node_id`、输入文本、原始 payload、job/lease 状态和最终结果。数据库依赖 state directory 的 `0700` 与数据库/WAL/SHM 的 `0600` 权限保护，不提供静态加密。

一期没有自动保留期或后台 purge，记录会持续保留，直到操作者主动清理。需要彻底清除历史时：

1. 停止 daemon 和专用 Hermes Gateway；
2. 按组织要求备份或销毁 `relay.db`、`relay.db-wal`、`relay.db-shm`；
3. 重新启动前执行 `doctor`，确认新数据库完整且 session quarantine 为空。

不要在服务运行期间直接删除或复制 WAL/SHM，也不要把数据库加入 issue、测试 fixture 或 Git 提交。
