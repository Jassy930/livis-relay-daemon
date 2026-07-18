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

## Hermes connector contract

一期 connector protocol 固定为 v2，关键消息为：

```text
hello / hello_ack
draining → draining_ack
job → accepted → result|failed
job → failed(notStarted=true)
cancel → cancelled
result_stored
ping / pong
```

所有执行消息携带 `jobId + leaseId`。daemon 只接受当前 lease，旧 connector 或迟到结果不能完成新执行。

`failed.notStarted` 是 connector 与 daemon 共同依赖的状态语义：v2 connector 必须在 `hello.capabilities` 声明 `prestartFailure=true` 与 `draining=true`，daemon 也必须在 `hello_ack.capabilities` 回声两项能力。任一方缺失或协议版本不同都在 connector 就绪前终止握手，避免新旧组件把“从未执行”误解为普通执行失败，或在关闭窗口继续派发新 job。

Hermes 0.18.2 的普通文本 `handle_message()` 会先完成 topic recovery、建立 session guard 并启动后台处理，再返回调用方。因此正常 job 由 socket reader 建立 job/lease/source 映射并发送 accepted，随后直接等待这一步注册完成，才读取紧邻的 cancel；这样 `/stop` 一定看到原 job 的 active session，而真实结果仍由 Hermes 后台任务生成，reader 可继续处理 ACK/error/ping。若 `handle_message()` 在返回前抛出异常，0.18.2 尚未完成 guard/owner 注册，bridge 会释放本地映射并以精确 `notStarted` proof 结算；cancel 已先到时也不会留下永久 `Cancelling`。final/failed 发出后到 owner task 释放 guard 前是可证明的 settling 窗口；daemon 紧邻派发的同 session 下一 job 由 bridge 自己的 deferred task 等到 guard 真正释放后再 cold-dispatch，不进入 Hermes 会发送 queue/interrupt 中间 ACK 的 busy-session 路径。等待期间 socket reader 继续处理 cancel、ACK 和心跳；若 cancel 或 transport 断开先到，该 job 以 `notStarted` 结算而不生成 `/stop`。

dispatcher 前被命令或审批门禁拒绝的 job 不发送 accepted，而以 `failed.notStarted=true` 保留 lease tombstone 直到 daemon 回 ACK；cancel 命中该 tombstone 时只重申“从未执行”，绝不生成 `/stop`。tombstone 跨 UDS transport 重连保留并在 v2 握手后、connector 就绪前重放；若 daemon 已因断线或重启把它保守标为 `Interrupted/CancelUnknown`，匹配证明只删除由同一 `jobId + leaseId` 建立的 quarantine 行。人工释放同时为相关 job 写入 durable release marker，迟到 cancel 不能重建已经由操作员确认解除的 quarantine；v2→v3 迁移按旧 quarantine 与歧义终态在同一事务写入的时间戳，只把 legacy 行绑定到对应故障 epoch，同 session 更早或已删除 legacy 行的历史歧义回填 marker。同毫秒多个精确匹配全部保留；找不到精确 epoch，或旧版迟到 cancel 已把隔离来源改成带 lease 的 `Cancelled` 并覆盖原时间戳时，都会保留 sentinel 和相关 job，使自动 proof 无法解除而人工 release 仍能持久写入 marker。旧 terminal proof 也不能解除后来真实执行的隔离。`/sethome` 写出的 `LIVIS_HOME_CHANNEL` 会在下次 plugin env enablement 时恢复为 `PlatformConfig.home_channel`，因此一次性门禁跨重启保持。`/stop` 取消真实后台任务时，completion hook 与 connector cancel 路径通过 `jobId + leaseId` 幂等地合并 cancelled 通知。graceful disconnect 先发送 `draining`；daemon 在回 `draining_ack` 前同步关闭该 connector 的派发门，bridge 收到 ACK 后重放所有未执行 proof，并等待每条 `result_stored` 才关闭具体 UDS WebSocket。整个 drain 共享一个有界预算；即使既有 writer 卡在 UDS 背压或发送锁上，预算结束后也会强制关闭具体 socket，而不会让 Gateway 优雅停止无限挂起。非优雅断线仍由下一代连接重放 proof；旧 listener 不得清理新一代连接状态。

lease 必须保持到 `on_processing_complete()`；`send()` 的 final 以及 completion hook 上报的普通 `failed` 都只有收到 daemon 的 `result_stored` 后才视为 durable terminal。bridge 设置 `supports_async_delivery=false`，不为当前 turn/job 结束后的后台完成通知保留投递通道。

## 官方更新分层

LiViS 与 Hermes 使用不同门禁：

1. LiViS：版本化 protocol profile、artifact 哈希、wire marker、active profile SHA pin、24 小时 supported proof。
2. Hermes：外置公共 platform plugin、connector hello、bridge 版本区间、Hermes runtime 版本区间和真实包 smoke test。
3. daemon：自身版本与上述 profile 分离；升级 daemon 不覆盖状态目录中的 active profile。

自动生成的 LiViS 候选只能改变官方版本和 upstream artifact 信息。IDaaS、relay、OAuth、wire identity、timing 或 wire protocol 变化属于运行契约变化，必须随新版 daemon 审核和迁移，不能用候选文件直接放行。
