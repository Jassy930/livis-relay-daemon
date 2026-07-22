# 架构与状态所有权

## 进程边界

`livis-relayd` 是 LiViS 协议与持久化状态的唯一所有者：

- 独占 LiViS OAuth、refresh token、远端 WebSocket、ACK、重连和 SQLite。
- `ExecutionBackend` 只抽象执行生命周期，不转移 JobStore、lease 或 outbox 所有权。
- 默认 Hermes backend 通过本机 connector IPC 与 `MessageEvent` / `SendResult` 转换；
  plugin 不连接 LiViS、不打开 relay SQLite，也不隐式启动 daemon。
- 显式 Codex backend 由 daemon 直接管理一个 `codex app-server --stdio` 子进程，不
  经过 Hermes connector，也不把 thread 当作 job 状态真源。
- Hermes 模式下 daemon 与专用 Hermes Gateway 分别由 launchd/systemd 管理；Codex
  模式只管理 daemon 服务，app-server 随 daemon 启停。

这种边界允许以后评审新的执行后端，而不复制 LiViS 登录、协议和 durable outbox。
Claude Code 当前尚未实现，不属于可选择 backend。

当前抽象还不是完整的 provider-neutral managed-session 层：事件中的 `turnId`、SQLite
中的 `thread_id/active_turn_id` 以及 daemon 多处 `kind === "codex"` 分支都带 Codex
语义。引入 Claude Code 前，应先抽出 backend registry、托管目录/session 生命周期、
attempt fencing、terminal/cancel 能力和 provider session/execution 标识；Codex 的
JSON-RPC stdio 与 Claude 的 SDK/CLI stream-json 必须保留为两个独立 transport，不能
为了复用代码把它们伪装成同一协议。一套 daemon 是否同时承载两个 provider 仍是产品
决策，当前只支持配置时二选一。

这里的“协议所有者”描述本地状态职责，不代表项目掌握服务端规范。服务端已经接受、仅由官方客户端观察、只在 fake Relay 验证或仍未知的行为，统一登记在[LiViS 服务端协议证据与支持边界](LIVIS-RELAY-PROTOCOL-BOUNDARY.md)。

## 一期设备与会话所有权

一期暂将 LiViS 入站消息中的 `from_node_id` 视为设备来源标识。它是当前兼容协议中观察到的路由字段，不是 OAuth 账号身份，也不是密码学设备证明；上游一旦给出更明确的身份和轮换契约，必须重新审阅该假设。

受支持的部署拓扑固定为一个 daemon、一个 config、一个 state directory、一个执行
backend 和恰好一个获准 `node_id`。Hermes 模式额外对应一个专用 profile；Codex
模式额外对应一个 daemon 私有 `CODEX_HOME`、一个 session workspace 和一个持久
thread。两种 backend 不得在同一 daemon 中同时启用或共享会话。

`security.allowedNodeIds` 的数组形式和 Hermes `LIVIS_ALLOWED_USERS` 的逗号列表形式只是
配置格式，不代表一期支持多个设备；`allowAllNodes` 与 `LIVIS_ALLOW_ALL_USERS` 必须
保持关闭。Codex 模式进一步在代码级要求 `allowAllNodes=false` 且 allowlist 恰好一个。

当前 backend session、单 session 执行锁、quarantine、job 和 outbox 的状态所有权都
只在“唯一来源设备”前提下成立。稳定 session key 为 `livis:<agentId>`；Codex 的
immutable session hash 还绑定唯一获准 `node_id`，因此同一 state directory 原地换
设备会拒绝复用旧 thread。多设备路由、跨设备会话连续性、设备 ID 轮换和既有状态迁移
均不在一期范围内；不得通过追加第二个 allowlist 值来绕过该边界。

## 执行与投递是两套状态

```text
job execution:
Received → Acked → Dispatching → Running → Succeeded | Failed
                              └→ Cancelling → CancelUnknown

outbox delivery:
Pending → Delivering → Delivered
             └→ AckFailed（持久化退避）─到期→ Delivering
                                      └─迟到 ACK→ Delivered
```

`Succeeded` 只表示 Agent final 已持久化；远端完成还要求 outbox 收到 `ack_send_result`。重启时：

- 未派发 job 可以继续派发。
- `Dispatching/Running/Cancelling` 属于 ambiguous execution，不自动重跑。
- 未 ACK 的结果只重发 outbox，每次生成新的 `msg_id`，保留原 `job_id` 和结果内容。

`resultMaxRetries` 只限制一个投递周期内的快速重试。耗尽后 outbox 进入
`AckFailed`，并在 SQLite 保存 `next_attempt_at`；退避时间按
`resultAckTimeoutMs` 与本周期重试次数指数增长，最长 5 分钟。到期后，当前在线
连接、重连或 daemon 重启都会开启新周期。因此 `AckFailed` 是可恢复的持久化
退避态，不是永久死信。

每次投递的 `msg_id` 都先写入 `outbox_delivery_attempts`，再交给 WebSocket。
同步 `send()` 失败时，daemon 会在一个 SQLite 事务内删除尚未出进程的 attempt，
恢复前一个真实 attempt 的 ID 与投递时间，并回到 `Pending`。只有至少存在一个
真实投递 attempt，引用原 `job_id` 或任一历史 `msg_id` 的 ACK 才能让
`Pending`、`Delivering` 或 `AckFailed` 收敛到 `Delivered`；从未投递的结果不接受
ACK。

JobStore schema v3 曾为 outbox 增加 `next_attempt_at`；当前 schema v4 新增
`backend_sessions`，保存 backend/session hash/cwd/CLI version/thread ID，以及活动
job/lease/run generation/turn ID 与 recovery 标记。fresh、v1、v2 和 v3 数据库都在
同一个 `BEGIN IMMEDIATE` 事务内完成版本读取、DDL、旧 `AckFailed` 恢复为
`Pending`、完整性与外键检查以及最终版本提交。版本裁决发生在取得写锁之后，避免
两个 opener 同时按旧版本迁移；任一步失败会回滚全部 DDL/DML 和
`PRAGMA user_version`。

取消意图在 SQLite `IMMEDIATE` 事务内按当前状态原子转移：`Received/Acked` 可直接进入 `Cancelled`，`Dispatching/Running` 只能进入 `Cancelling`。重复 cancel 保持 `Cancelling`，迟到 cancel 不会回退 `Interrupted` 或任何终态；Hermes connector 确认已发出 `/stop`，或 Codex app-server 接受 `turn/interrupt`，都不能证明工具副作用已经停止，daemon 仍须记录 `CancelUnknown` 并隔离 session。

## Relay 入站门禁与提前取消

远端 WebSocket 的处理顺序固定为：`ws maxPayload` 整体字节门禁 → 回调字节复核 → JSON 对象与外部标识校验 → handler → SQLite。超限帧或标识不会到达业务 handler，因此不会创建 job、outbox 或 pending cancel；拒绝日志只包含固定或已受字节界约束的错误与有界数字/摘要。

`cancel_chat` 可能先于 `send_message` 到达。未知 job 的 intent 使用 `(scope_key, job_id)` 去重，TTL 为 24 小时，全库硬上限为 4096 条。request cancel、job 状态 CAS、容量判断与 intent 写入使用 `IMMEDIATE` 事务；job 首次或重复入库时，匹配 intent 都会先按状态应用、再在同一事务删除。daemon 的 `recoverAfterRestart` 在同一个恢复事务内处理当前 scope 的历史残留：`Received/Acked → Cancelled`，`Dispatching/Running → Cancelling → CancelUnknown` 并隔离 session。单纯构造 `JobStore` 不消费 intent，`doctor`、`session release` 等维护命令不会把运行中 job 静默改为 `Cancelling`。终态保持不变。容量已满时不保存新 ID，也不发送成功 ACK。

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

daemon 会为每次接纳的 `hello` 分配仅存于本机进程的 connector generation。失活连接被 takeover 时，daemon 先 fence 旧 socket，并通过 `onDisconnected` 完整执行 `markConnectorDisconnected`：`Dispatching/Running` 转为 `Interrupted`，`Cancelling` 转为 `CancelUnknown`，同时隔离相关 session。只有这一次持久化结算完成后，新 generation 才会进入 ready 并触发派发；首次 SQLite/I/O 失败不会把 generation 永久标成已处理，takeover 或迟到 `close` 仍可重试。旧 socket 的延迟 `close` 或入站消息会同时按 socket 实例和 generation 拒绝，即使新旧连接复用同一 `connectorId` 也不会跨代影响。

Hermes `handle_message()` 会在后台完成，lease 必须保持到 `on_processing_complete()`。`send()` 只有收到 daemon 的 `result_stored` 后才向 Hermes 返回成功。

## Codex app-server contract

Codex 是 daemon 内部 backend，不使用 connector v1。daemon 为稳定
`sessionKey=livis:<agentId>` 创建或恢复一个非 ephemeral thread，并固定：

```text
initialize → account/read → permissionProfile/list → experimentalFeature/list
           → thread/start → memoryMode/set → thread/read → SQLite bind
           → 或 thread/resume → thread/read
job claim  → turn/start → item/completed* → turn/completed
cancel     → turn/interrupt
```

私有运行目录位于 `<stateDir>/backends/codex`；session workspace 是唯一工具可写根，
工具网络关闭，审批策略为 `never`，所有 approval request 默认拒绝。daemon 在创建或
恢复 thread 后读回 cwd、runtime workspace roots、permission profile、approval policy
与 sandbox；任一字段或固定配置漂移都失败关闭。

JobStore 先原子 claim job 并保留 backend attempt，随后才允许发送 `turn/start`。
只有 transport 明确证明请求未写入时才可撤销 attempt；请求可能已写入、响应无法绑定
turn、app-server 断连或 daemon 重启时，均保留 attempt 并进入
`Interrupted`/`CancelUnknown`、recovery 和 quarantine，绝不自动重发或创建替代
thread。

Codex 0.145.0 的新 thread 在首个 turn 前不会自动落盘。daemon 只在有界物化回读确认
rollout 位于专用 `CODEX_HOME/sessions`、首条 `session_meta.id` 匹配后写入 SQLite；
因此已绑定 thread 的恢复失败视为数据损坏，不会降级为创建替代 thread。

`item/completed` 只在内存中收集 agent message。只有匹配当前 thread/turn 的 terminal
`turn/completed` 才能把一个 final 写入 outbox；reasoning、工具输出、progress、错误
重试通知和流式 commentary 均不会直接进入 LiViS。完整安全与恢复边界见
[Codex app-server 执行后端](CODEX-APPSERVER.md)。

## 官方更新分层

LiViS 与执行后端使用不同门禁：

1. LiViS：版本化 protocol profile、artifact 哈希、wire marker、`wireContractRevision + credentialMode`、active profile SHA pin、runtime contract digest、24 小时 supported proof 与本地脱敏 S2 probe artifact。
2. Hermes：外置公共 platform plugin、connector hello、bridge 版本区间、Hermes runtime 版本区间和真实包 smoke test。
3. Codex：CLI `[0.145.0, 0.146.0)` 版本窗、专用登录、固定 app-server argv/config、
   高风险 feature 回读、thread/rollout/sandbox 安全回读和真实恶意凭据负向 canary。
4. daemon：自身版本与上述 profile 分离；升级 daemon 不覆盖状态目录中的 active profile、
   backend session 或 workspace。

自动生成的 LiViS 候选只能改变官方版本和 upstream artifact 信息。IDaaS、relay、OAuth、wire identity、timing 或 wire protocol 变化属于运行契约变化，必须随新版 daemon 审核和迁移，不能用候选文件直接放行。

profile schema v2 的 revision/mode 必须命中代码内置 registry；supported proof 绑定同一 runtime digest。脱敏 probe 负责检测代码与已审阅 S2 wire 形状的偏移，但不承担真实服务端兼容证明。

schema v1→v2 是独立的文件状态机，不复用普通 upstream activate/rollback，也
不打开 `JobStore`：

```text
PREPARED（原 config/profile 备份 + target v2）
  → proof quarantine（old SHA + new SHA + alias）
  → CONFIG_COMMITTED（config durable rename，唯一提交点）
  → PROOF_REBUILD_REQUIRED
```

apply 在协作式 operation guard 内对完整 source config/profile 原始字节做
初始及提交前 SHA 校验；rollback 重复校验 current config，并在依赖 active v1
时验证它的 schema/SHA。它们拒绝接入 guard 的并发命令和已发生的外部改写，但不是
内核级原子 CAS，因此停服窗口仍禁止 `init` 或外部编辑器写文件。新 v2 与
fallback v1 分别进入只含对应 schema 的独立目录。config readback 失败会恢复
提交前 config，proof 仍保持隔离以失败关闭；rename 后目录 fsync 未确认则保留
两层 guard 交给人工恢复。`relay.db`、SQLite `user_version` 和 wire runtime 都
不属于这条迁移的状态所有权。

rollback 会先用 source backups 重建 target profile/config/runtime digest，防止
混配 receipt。当前 config 为 source 或 fallback 时只验证、必要时修复 active v1，
不再要求 target v2 文件存在。当前 config 为 target 时，它的完整字节 SHA
必须精确命中由 receipt/source backups 重建的 target config，且 profile 路径与
SHA pin 必须一致；实时 target profile 不是回滚信任输入，可缺失、损坏或
落在不可信路径，回滚不读取、不修复也不覆盖它。回滚准备记录与
pre-rollback config 先落盘，随后 proof quarantine，最后才发生 config
提交或 active fallback profile 自愈提交。两层 guard 都会在生命周期内保持创建
fd 打开，以固定原 inode，并与当前路径的 dev/inode、link count、类型、权限、
nonce 和目录项持久性一并在提交前复核；私有父目录的类型、权限与 realpath 会在
每次所有权检查和 release 完成前重验。这仍是协作锁，不是内核原子 CAS。
source/fallback 的幂等 fast path 也在 guard 内检查三份 proof，残留 proof 会触发
只隔离 proof、不改 config/profile 的清理模式。

所有 CLI proof writer（`upstream check/activate`、`login` 与 `serve` 启动）、daemon
周期 proof writer 以及普通 upstream rollback 都使用同一 `ProfileOperationGuard`
可验证 lease。CLI 先获取 guard、再加载完整 context；daemon 的 6 小时周期只负责主动
复核，proof 的绝对 `expiresAt` 另由 one-shot deadline、Relay admission 与每次 dispatch
同步检查。周期 writer 遇到占用且 proof 尚未过期时只跳过本轮；到达绝对期限后即使
timer 延迟、网络失败或 dispatch 已在循环中，也会关闭 upstream 门禁且不再 ingest、
ACK、claim 或 send。claim 后才跨期的 job 会先撤销未发送 lease。

关门状态与 Relay 是否已完整停止分别记录：`relay.stop()` 失败不会清除 blocker，只会
清除失败的在途 stop，下一次 admission、dispatch 或周期复核会重试；并发入口复用同一
在途 stop。`RelayClient` 的 `connected` 回调位于自身 run loop 内，因此该入口只同步
设置 blocker、发起 stop 后返回，不反向等待 run loop；其他入口仍可等待完整停止。
复核成功后的恢复路径会等待该 stop，并再次检查新 proof 的绝对期限；等待期间跨期时
保持门禁，不 restart 或 dispatch。`stop()` 会等待在途复核与门禁关闭完成，返回后不会
再写 proof、重新启动 Relay 或派发。

proof 的 `upstream/`、`upstream/proofs/` 逐层固定为 `0700` 并同步目录项；keyed proof
和 alias 都在 guard 持有期间 durable 写入、读回。半写失败只补偿仍精确等于本次写入
内容的文件，检测到并发内容则拒绝覆盖。`serve` 启动失败时按主错误、daemon stop、
guard release 的顺序完成并聚合清理，同步 throw 与异步 reject 使用同一规则。这样迁移
不会与预先读取的旧 profile 快照交错。运行中 daemon 由 connector socket 占用阻止
离线迁移，`serve` 则持有 operation guard 直到 socket 启动成功。
