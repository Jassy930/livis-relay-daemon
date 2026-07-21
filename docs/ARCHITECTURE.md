# 架构与状态所有权

## 进程边界

`livis-relayd` 是 LiViS 协议与持久化状态的唯一所有者：

- 独占 LiViS OAuth、refresh token、远端 WebSocket、ACK、重连和 SQLite。
- Hermes plugin 只做本机 IPC 与 `MessageEvent` / `SendResult` 转换。
- Hermes plugin 不连接 LiViS、不打开 relay SQLite，也不隐式启动 daemon。
- daemon 与专用 Hermes Gateway 分别由 launchd/systemd 管理。

这种边界允许将来增加 AionCore connector，而不复制 LiViS 登录、协议和 durable outbox。

这里的“协议所有者”描述本地状态职责，不代表项目掌握服务端规范。服务端已经接受、仅由官方客户端观察、只在 fake Relay 验证或仍未知的行为，统一登记在[LiViS 服务端协议证据与支持边界](LIVIS-RELAY-PROTOCOL-BOUNDARY.md)。

## 一期设备与会话所有权

一期暂将 LiViS 入站消息中的 `from_node_id` 视为设备来源标识。它是当前兼容协议中观察到的路由字段，不是 OAuth 账号身份，也不是密码学设备证明；上游一旦给出更明确的身份和轮换契约，必须重新审阅该假设。

受支持的部署拓扑固定为一个 daemon、一个 config、一个 state directory、一个专用 Hermes profile 和恰好一个获准 `node_id`。`security.allowedNodeIds` 的数组形式和 Hermes `LIVIS_ALLOWED_USERS` 的逗号列表形式只是配置格式，不代表一期支持多个设备；`allowAllNodes` 与 `LIVIS_ALLOW_ALL_USERS` 必须保持关闭。

当前 Hermes session、单 session 执行锁、quarantine、job 和 outbox 的状态所有权都只在“唯一来源设备”前提下成立。多设备路由、跨设备会话连续性、设备 ID 轮换、原地换设备和既有状态迁移均不在一期范围内；不得通过追加第二个 allowlist 值来绕过该边界。

## 执行与投递是两套状态

```text
job execution:
Received → Acked → Dispatching → Running → Succeeded | Failed
                              └→ Cancelling → CancelUnknown

outbox delivery:
Pending → Delivering → Delivered
                    └→ AckFailed
```

`Succeeded` 只表示 Agent final 已持久化；远端完成还要求 outbox 收到 `ack_send_result`。重启时：

- 未派发 job 可以继续派发。
- `Dispatching/Running/Cancelling` 属于 ambiguous execution，不自动重跑。
- 未 ACK 的结果只重发 outbox，每次生成新的 `msg_id`，保留原 `job_id` 和结果内容。

取消意图在 SQLite `IMMEDIATE` 事务内按当前状态原子转移：`Received/Acked` 可直接进入 `Cancelled`，`Dispatching/Running` 只能进入 `Cancelling`。重复 cancel 保持 `Cancelling`，迟到 cancel 不会回退 `Interrupted` 或任何终态；connector 即使确认已发出 `/stop`，仍须由 daemon 记录 `CancelUnknown` 并隔离 session。

## Hermes connector contract

一期 connector protocol 固定为 v1，关键消息为：

```text
hello / hello_ack
job → accepted → result|failed
cancel → cancelled
result_stored
ping / pong
```

所有执行消息携带 `jobId + leaseId`。daemon 只接受当前 lease，旧 connector 或迟到结果不能完成新执行。

Hermes `handle_message()` 会在后台完成，lease 必须保持到 `on_processing_complete()`。`send()` 只有收到 daemon 的 `result_stored` 后才向 Hermes 返回成功。

## 官方更新分层

LiViS 与 Hermes 使用不同门禁：

1. LiViS：版本化 protocol profile、artifact 哈希、wire marker、active profile SHA pin、24 小时 supported proof。
2. Hermes：外置公共 platform plugin、connector hello、bridge 版本区间、Hermes runtime 版本区间和真实包 smoke test。
3. daemon：自身版本与上述 profile 分离；升级 daemon 不覆盖状态目录中的 active profile。

自动生成的 LiViS 候选只能改变官方版本和 upstream artifact 信息。IDaaS、relay、OAuth、wire identity、timing 或 wire protocol 变化属于运行契约变化，必须随新版 daemon 审核和迁移，不能用候选文件直接放行。
