# 架构与状态所有权

## 进程边界

`livis-relayd` 是 LiViS 协议与持久化状态的唯一所有者：

- 独占 LiViS OAuth、refresh token、远端 WebSocket、ACK、重连和 SQLite。
- Hermes plugin 只做本机 IPC 与 `MessageEvent` / `SendResult` 转换。
- Hermes plugin 不连接 LiViS、不打开 relay SQLite，也不隐式启动 daemon。
- daemon 与专用 Hermes Gateway 分别由 launchd/systemd 管理。

这种边界允许将来增加 AionCore connector，而不复制 LiViS 登录、协议和 durable outbox。

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

## Relay 入站门禁与提前取消

远端 WebSocket 的处理顺序固定为：`ws maxPayload` 整体字节门禁 → 回调字节复核 → JSON 对象与外部标识校验 → handler → SQLite。超限帧或标识不会到达业务 handler，因此不会创建 job、outbox 或 pending cancel；拒绝日志只包含固定错误与有界数字/摘要。

`cancel_chat` 可能先于 `send_message` 到达。未知 job 的 intent 使用 `(scope_key, job_id)` 去重，TTL 为 24 小时，全库硬上限为 4096 条。request cancel、job 状态 CAS、容量判断与 intent 写入使用 `IMMEDIATE` 事务；job 首次或重复入库时，匹配 intent 都会先按状态应用、再在同一事务删除。daemon 的 `recoverAfterRestart` 在同一个恢复事务内处理历史残留：`Received/Acked → Cancelled`，`Dispatching/Running → Cancelling → CancelUnknown` 并隔离 session。单纯构造 `JobStore` 不消费 intent，`doctor`、`session release` 等维护命令不会把运行中 job 静默改为 `Cancelling`。终态保持不变。容量已满时不保存新 ID，也不发送成功 ACK。

该临时表边界与 durable job/outbox 保留策略相互独立；jobs、outbox 和投递尝试仍没有自动 retention。大量合法小帧的 Promise 排队也不在本次边界内。

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
