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

结果投递由单一 outbox pump 驱动，完全以持久化状态为准：`Pending` 启动投递、`Delivering` 超时后重试或转入 `AckFailed`；连接建立、新结果入库、收到 ACK 都只是触发 pump 重新扫描，不为单个 job 维护内存定时器。连接断开或 daemon 停止时把 `Delivering` 批量重置为 `Pending`，重连后自然重放。

## Connector contract 与后端路由

connector protocol 固定为 v1，关键消息为：

```text
hello / hello_ack
job → accepted → result|failed
cancel → cancelled
result_stored
ping / pong
```

daemon 侧维护一个 connector 注册表：每个后端（一期只有 `hermes`）各自声明实现名、bridge 与 runtime 的已审核版本区间。connector 通过 `/v1/connectors/<backend>` 连接并在 `hello.backend` 中声明身份，未注册或与连接路径不符的后端会被 `backend_unsupported` 拒绝；同一后端同时只允许一个 connector 在线（失活旧连接会被驱逐）。active 身份由 `backend + socket 实例` 共同围栏，旧 socket 的迟到 `close` 不能撤销替代连接或清理其新领取的 job。

入站 job 由 `config.routing` 决定去向：`nodeBackends` 按 `from_node_id` 精确路由，未命中时落到 `defaultBackend`（缺省 `hermes`）。路由在派发时根据配置计算，不写入持久化状态；`cancel`、`result_stored` 与错误回复按持有 lease 的 connector 实例路由，而不是按后端在线实例。同一 session 每次只暴露最早的待派发 job；其 backend 离线时后续 job 继续排队，但不会阻塞其他 session。

所有执行消息携带 `jobId + leaseId`。daemon 只接受当前 lease，旧 connector 或迟到结果不能完成新执行。

Hermes `handle_message()` 会在后台完成，lease 必须保持到 `on_processing_complete()`。`send()` 只有收到 daemon 的 `result_stored` 后才向 Hermes 返回成功。

## 官方更新分层

LiViS 与 Hermes 使用不同门禁：

1. LiViS：版本化 protocol profile、artifact 哈希、wire marker、active profile SHA pin、24 小时 supported proof。
2. Hermes：外置公共 platform plugin、connector hello、bridge 版本区间、Hermes runtime 版本区间和真实包 smoke test。
3. daemon：自身版本与上述 profile 分离；升级 daemon 不覆盖状态目录中的 active profile。

自动生成的 LiViS 候选只能改变官方版本和 upstream artifact 信息。IDaaS、relay、OAuth、wire identity、timing 或 wire protocol 变化属于运行契约变化，必须随新版 daemon 审核和迁移，不能用候选文件直接放行。
