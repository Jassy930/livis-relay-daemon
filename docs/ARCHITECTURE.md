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
             └→ AckFailed (backoff) ─到期→ Delivering
                                      └─迟到 ACK→ Delivered
```

`Succeeded` 只表示 Agent final 已持久化；远端完成还要求 outbox 收到 `ack_send_result`。重启时：

- 未派发 job 可以继续派发。
- `Dispatching/Running/Cancelling` 属于 ambiguous execution，不自动重跑。
- 未 ACK 的结果只重发 outbox，每次生成新的 `msg_id`，保留原 `job_id` 和结果内容。

`resultMaxRetries` 只限制一个投递周期内的快速重试。耗尽后 outbox 进入 `AckFailed`，并在 SQLite 中保存 `next_attempt_at`；退避时间按 `resultAckTimeoutMs` 和本周期重试次数指数增长，最长 5 分钟。到期后，当前在线连接、重连或 daemon 重启都会开启新周期；这是持久化退避态，不是死信。

每次投递的 `msg_id` 都先持久化在 `outbox_delivery_attempts`，再交给 WebSocket；若 `send` 同步失败，daemon 会在同一个 SQLite 事务内撤销该未出进程的 ID、恢复此前的最后一次真实 attempt 并回到 `Pending`。只要结果确实曾投递，引用任一历史 `msg_id` 或原 `job_id` 的迟到 ACK 在 `Pending` / `Delivering` / `AckFailed` 期间都能将它收敛为 `Delivered`；尚未投递过的 `Pending` 结果不接受 ACK。

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
