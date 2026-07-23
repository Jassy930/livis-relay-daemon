# 架构与状态所有权

## 进程边界

`livis-relayd` 是 LiViS 协议与持久化状态的唯一所有者：

- 独占 LiViS OAuth、refresh token、远端 WebSocket、ACK、重连和 SQLite。
- `ExecutionBackend` 只抽象执行生命周期，不转移 JobStore、lease 或 outbox 所有权。
- 默认 Hermes backend 通过本机 connector IPC 与 `MessageEvent` / `SendResult` 转换；
  plugin 不连接 LiViS、不打开 relay SQLite，也不隐式启动 daemon。
- 显式 Codex backend 由 daemon 直接管理一个 `codex app-server --stdio` 子进程，不
  经过 Hermes connector，也不把 thread 当作 job 状态真源。`codex` 是 execution backend；
  其下的默认 OpenAI 或显式 custom Responses 是 model provider，不是第四种 backend。
- Hermes 模式下 daemon 与专用 Hermes Gateway 分别由 launchd/systemd 管理；Codex
  模式只管理 daemon 服务，app-server 随 daemon 启停。

这种边界允许以后评审新的执行后端，而不复制 LiViS 登录、协议和 durable outbox。
`execution.backend` 的配置值固定为 `hermes | codex | claude`，一套 daemon 同时只选择
一个。Claude Code 当前尚未实现：配置解析会接受该枚举值，但 `doctor` 会明确报错，
`serve` 会在启动任何执行 backend 前失败关闭，绝不退回 Hermes 或 Codex。

当前抽象还不是完整的 provider-neutral managed-session 层：事件中的 `turnId`、SQLite
中的 `thread_id/active_turn_id` 以及 daemon 多处 `kind === "codex"` 分支都带 Codex
语义。引入 Claude Code 前，应先抽出 backend registry、托管目录/session 生命周期、
attempt fencing、terminal/cancel 能力和 provider session/execution 标识；Codex 的
JSON-RPC stdio 与 Claude 的 SDK/CLI stream-json 必须保留为两个独立 transport，不能
为了复用代码把它们伪装成同一协议。当前产品边界已经固定为 Hermes、Codex、Claude
三选一，不支持同一 daemon 同时承载多个 execution backend；选择 Codex 后也只能固定一个
model provider。

这里的“协议所有者”描述本地状态职责，不代表项目掌握服务端规范。服务端已经接受、仅由官方客户端观察、只在 fake Relay 验证或仍未知的行为，统一登记在[LiViS 服务端协议证据与支持边界](LIVIS-RELAY-PROTOCOL-BOUNDARY.md)。

## 一期设备与会话所有权

一期暂将 LiViS 入站消息中的 `from_node_id` 视为设备来源标识。它是当前兼容协议中观察到的路由字段，不是 OAuth 账号身份，也不是密码学设备证明；上游一旦给出更明确的身份和轮换契约，必须重新审阅该假设。

受支持的部署拓扑固定为一个 daemon、一个 config、一个 state directory、一个执行
backend 和恰好一个获准 `node_id`。Hermes 模式额外对应一个专用 profile；Codex
模式额外对应一个 daemon 私有 `CODEX_HOME`、一个 session workspace 和一个持久
thread。两种已实现 backend 不得在同一 daemon 中同时启用或共享会话；未来 Claude
实现后也必须遵守同一三选一边界。

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

- job 首次入库时会把所选 execution backend 写入 `jobs.target_backend`，schema v7 的 SQLite
  trigger 会拒绝后续改写；重复投递或配置切换都不能重新绑定。未派发 job 只有在当前
  backend 与该绑定一致时才可继续派发。
- `jobs.target_backend=codex` 当前没有继续绑定 OpenAI/custom 子 provider。Codex session 与
  attempt ledger 会记录实际 `model_provider` 和安全摘要，但不能替代 job 入库时的子 provider
  fence；所以同一 `stateDir` 禁止切换 provider 或 key，避免旧 backlog 跨出口执行。
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

JobStore schema v3 曾为 outbox 增加 `next_attempt_at`，schema v4 新增可变的
`backend_sessions`，schema v5 为每个 job 增加 `target_backend`，schema v6 为 Codex
session 增加账号身份、请求/实际模型、安全配置与 feature 摘要，以及单调 thread-tail
checkpoint。当前 schema v7 再以 trigger 强制 `jobs.target_backend` 不可变，并新增
`execution_attempt_events` append-only 账本。三类状态职责必须分开理解：

- `jobs` 与 `outbox` 是执行裁决和结果投递的业务真源；
- `backend_sessions` 是可更新的当前 session、active attempt 与 recovery anchor，不能
  代替永久历史；
- `execution_attempt_events` 永久记录 `reserved/accepted/not_sent/cancelled_not_sent/`
  `succeeded/failed/cancel_unknown/interrupted/legacy_active_imported`，并绑定 job、backend、
  session、lease、execution、Codex thread/turn 以及可得的 runtime、model、account、
  安全配置与 feature 摘要；UPDATE/DELETE 均由 SQLite trigger 拒绝。

对真实 Codex backend，`backend_sessions.security_config_sha256` 当前不是单独
`config.toml` 的摘要，而是版本化绑定“安全 config 摘要 + canonical command 的
dev/ino/mode/link/内容摘要”。它在项目协作路径、daemon 重启与 idle recovery 门禁中检测
同版本 binary 替换，并成为 execution attempt 账本中的执行环境锚点；最后一次 pathname
复核到 `exec` 仍不是内核原子 CAS，不能宣称防住同一 OS 用户的外部并发改写。command
或安全配置发生合法升级时，旧 session 不会被原地接管：启动会先 quarantine，操作者
停机审阅并执行 `session release`。该命令先在 canonical connector socket 路径取得 daemon offline
guard，并固定同一 canonical state directory 打开 SQLite，再由同一个事务返回实际退役的
backend 列表。旧 Codex 绑定会被退役；后续若成功到达 thread 物化阶段，必须创建新 thread，
但 release 不保证下一次启动本身会成功。job/outbox 和旧 rollout 仍保留。

安全 config 摘要包含 OpenAI/custom 选择、custom `baseUrl`、Responses wire 与固定 retry
策略，但不包含 API key；`account/read` 也只有 type-only 强度，不能区分两把 key。因此
provider、endpoint 或 key 的合法变更必须使用全新 state/CODEX_HOME。`session release`
只退役 session row，既不补足 job 级 provider fence，也不是凭据轮换机制。

fresh 数据库直接创建为 v7，v1-v6 数据库都在同一个 `BEGIN IMMEDIATE` 事务内完成版本
读取、DDL、旧 `AckFailed` 恢复为 `Pending`、完整性与外键检查以及最终版本提交。版本
裁决发生在取得写锁之后，避免两个 opener 同时按旧版本迁移；任一步失败会回滚全部
DDL/DML 和 `PRAGMA user_version`。v1-v3 数据只可能来自 Hermes，可确定性回填为
`hermes`；v4 已可能来自 Hermes 或 Codex，若仍有 `Received/Acked` 积压，迁移必须由
操作者用 `execution.legacyV4JobBackend` 声明其原始 backend。v5 旧 session 只有在没有
active attempt、recovery 或 quarantine 时，才允许在真实 app-server 安全回读后一次性
补绑 v6 元数据；v6→v7 会把当时可证明的 active attempt 作为
`legacy_active_imported` 导入，不猜测更早事件，也不把 ambiguous execution 变成可重试。

backend 切换只允许发生在其他 backend 没有 `Received/Acked/Dispatching/Running/`
`Cancelling` job 时。`serve` 在启动 execution backend 和 Relay 前失败关闭；终态
`Succeeded/Failed/Cancelled/Rejected/Interrupted/CancelUnknown` 不阻止切换，残留 outbox
仍由独立投递状态机继续处理。

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
           → thread/start → thread/memoryMode/set → thread/read → SQLite bind
           → 或 thread/resume → thread/read
job claim  → turn/start → item/completed* → turn/completed
cancel     → turn/interrupt
```

私有运行目录位于 `<stateDir>/backends/codex`；session workspace 是唯一工具可写根，
工具网络关闭，审批策略为 `never`，所有 approval request 默认拒绝。daemon 在创建或
恢复 thread 后读回 cwd、runtime workspace roots、permission profile、approval policy
与 sandbox，并比较账号身份强度、实际 model/provider、配置/feature 摘要及稳定 thread
tail；任一字段、未映射 turn 或固定配置漂移都失败关闭。

默认 OpenAI provider 使用 Codex 内建 Responses 路径；custom provider 固定生成
`model_provider=livis-custom-responses`、HTTPS `base_url`、`wire_api=responses`、
`requires_openai_auth=true`、零 request/SSE retry 和禁用 WebSocket。两者都要求专用
API-key 账号。custom endpoint 是凭据与会话数据出口，不因 agent 工具网络关闭而变成本地
执行；固定 Codex `0.145.0` 的 strict-config 与真实 Responses canary 是独立验收层。精确
提交 `56a1d77` 已对当前 custom endpoint/model 取得成功 single-turn 回执，但 endpoint、
模型、平台或 CLI 变化后必须重新验收，且该回执不替代 LiViS 投递闭环。

JobStore 先原子 claim job 并保留 backend attempt，随后才允许发送 `turn/start`。
只有 transport 明确证明请求未写入时才可撤销 attempt；请求可能已写入、响应无法绑定
turn、活动 turn 期间 app-server 断连或 daemon 重启时，均保留 attempt 并进入
`Interrupted`/`CancelUnknown`、recovery 和 quarantine，绝不自动重发或创建替代
thread。只有 `running` 状态下内存与 SQLite 都没有 active attempt、持久 session 未要求
recovery 且没有 quarantine 时，app-server 意外退出才可进入 idle 自动恢复。

完整 turn 的 deadline 在发送 `turn/start` 前安装。超时取得唯一 interruption owner 后，
只发送一次 `turn/interrupt`，固定 grace 结束仍未安全收敛就断开 backend；deadline 后的
任何 terminal 都不会进入 outbox。app-server 位于独立 POSIX 进程组，关闭按 TERM/KILL
两阶段并等待直接 child、stdout/stderr 和进程组消失；逃逸到其他 session/进程组的后代
仍需目标机 cgroup/systemd 等更强边界。

idle 自动恢复在一次 daemon 生命周期内累计最多尝试三次，固定退避为
`[250, 1000, 5000] ms`；成功不会重置已消耗预算。开始首个候选前必须确认退出的旧
进程组已经关闭，候选失败后也必须先确认候选进程组关闭才可继续。恢复只允许对 SQLite
已绑定的同一 thread 执行 `thread/resume` 和 `thread/read`，禁止 `thread/start`、
`thread/memoryMode/set`、`turn/start` 或自动重放 job。CLI/runtime、账号、模型、配置与
feature 等 immutable metadata、Store anchor、rollout、checkpoint 或 tail 任一漂移都会
立即 quarantine 且不再重试；普通瞬时失败在剩余预算内重试，预算耗尽后失败关闭。
daemon `stop()` 会取消未到期退避，并等待 recovery、disconnect、候选关闭与事件链收口。

Codex 0.145.0 的新 thread 在首个 turn 前不会自动落盘。daemon 只在有界物化回读确认
rollout 位于专用 `CODEX_HOME/sessions`、首条 `session_meta.id` 匹配后写入 SQLite；
因此已绑定 thread 的恢复失败视为数据损坏，不会降级为创建替代 thread。

`item/completed` 只在内存中收集 agent message。只有匹配当前 thread/turn 的 terminal
`turn/completed` 才能把一个 final 写入 outbox；reasoning、工具输出、progress、错误
重试通知和流式 commentary 均不会直接进入 LiViS。完整安全与恢复边界见
[Codex app-server 执行后端](CODEX-APPSERVER.md)。

Codex 0.145.0 的 failed turn 可留下 `thread.status=systemError`，它不是 active turn，也
不是普通 idle。执行层只在同一 terminal failed checkpoint，或同一 app-server client epoch
内由该 terminal 实际观察并以 ID/status/count/hash 精确绑定的下一次 dispatch 接受；其他
生命周期入口保持 strict-idle。provider 原始错误自由文本不进入 Store；认证拒绝使用固定
分类，并在同一事务中提交 `Failed`、ledger、outbox、active clear 与 quarantine，随后关闭
backend。只有非认证失败才允许下一次 `turn/start` 按上游语义清状态。

## 官方更新分层

LiViS 与执行后端使用不同门禁：

1. LiViS：版本化 protocol profile、artifact 哈希、wire marker、`wireContractRevision + credentialMode`、active profile SHA pin、runtime contract digest、24 小时 supported proof 与本地脱敏 S2 probe artifact。
2. Hermes：外置公共 platform plugin、connector hello、bridge 版本区间、Hermes runtime 版本区间和真实包 smoke test。
3. Codex：CLI `[0.145.0, 0.146.0)` 版本窗、专用登录、固定 app-server argv/config、
   精确 enabled feature allowlist 与快照摘要、thread/rollout/sandbox 安全回读和真实恶意
   凭据负向 canary。
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
