# 安全边界

## 必须明确确认的事实

- 截至 2026-07-21，在[协议证据账本](LIVIS-RELAY-PROTOCOL-BOUNDARY.md)列明的 GitHub 与聚焦公开网页检索范围内，只找到 OpenClaw 接入线索，未发现可验证的第三方 SDK、服务端 schema 或稳定协议承诺；该阴性结果存在私有和未索引资料盲区。
- 本项目只静态兼容官方 v2.0.0 artifact 中观察到的 wire 行为，不执行或复制官方 bundle。
- 原 OpenClaw 插件的 `CommandAuthorized: true` 不适用于本项目。
- 公开仓库不附带 live profile；example 中的端点、OAuth 和哈希均为无效占位值。
- `bun run release:check` 只审核 `git ls-files -z` 返回的 index 内容，拒绝本地状态文件、官方 bundle、归档、生产域名和官方 OAuth client identity 指纹。生产域名仅允许在 Markdown/RST/TXT 安全说明中出现，OAuth identity 与私钥内容没有文档例外。
- 本地 protocol probe 只使用固定哨兵、注入 fetch 和 loopback；公开发布门禁拒绝私有 probe 回执、raw frame、trace、HAR 与 pcap。probe 成功仍只是 S2。
- Codex 默认连接 OpenAI；显式 custom Responses endpoint 是 API key、prompt、会话上下文和
  工具结果的共同出口。配置 custom provider 等同于把这些数据交给该端点，必须独立完成
  供应方、数据处理、留存、地域和撤销能力审阅；项目不替任何 custom endpoint 背书。

初始化时必须显式传入 `--acknowledge-unofficial-protocol`。这只是确认已知边界，不代表获得第三方授权。

## 一期强制默认值

- `allowAllNodes=false`；进入 `serve` 或实网 canary 前，`security.allowedNodeIds` 必须恰好包含一个获准 `node_id`。
- `execution.backend` 缺省为 `hermes`，显式值只能是 `hermes | codex | claude`，且
  一套 daemon 同时只启用一个。`claude` 尚未实现，`doctor` 与 `serve` 均失败关闭，
  不会静默回退。切换为 `codex` 时，代码会拒绝
  `allowAllNodes=true` 或不等于一个元素的 `allowedNodeIds`，并且还必须显式设置
  `codex.acknowledgeRemoteExecution=true`。
- `LIVIS_ALLOW_ALL_USERS` 必须为空/false；`LIVIS_ALLOWED_USERS` 必须只包含与 daemon 完全相同的唯一 `node_id`，`*` 和多个值都不属于一期受支持配置。
- `LIVIS_PHASE1_READ_ONLY_ACK=true` 只在专用 Hermes profile 已关闭写工具后设置。
- Hermes streaming、tool progress、interim message、附件和远程审批全部关闭。
- Hermes runtime 审核范围默认是 `[0.15.1, 0.15.2)`；bridge 范围是 `[0.1.0, 0.2.0)`。
- Codex CLI 审核范围固定为 `[0.145.0, 0.146.0)`；必须使用 daemon state
  directory 内通过标准输入单独写入 API key 的 `CODEX_HOME`，不得复用 `~/.codex`。
  生产 backend 只接受 `account.type=apiKey`；OAuth/ChatGPT、Bedrock、空账号和未知类型
  都必须在 permission profile、thread 与 turn RPC 前失败关闭。每次 dispatch 都必须在
  `turn/start` 前重新回读账号并与内存/SQLite 锚点核对，运行中认证模式漂移同样失败关闭。
- Codex provider 只允许精确 `{type:"openai"}`，或带 HTTPS `baseUrl` 与
  `acknowledgeApiKeyTransmission=true` 的 custom Responses provider。该确认同时覆盖 API key、
  prompt、会话上下文和工具结果。custom URL 禁止 userinfo、query、fragment；首期禁止
  `env_key`、`experimental_bearer_token`、static/env headers、query 参数和 command-backed
  auth，request/SSE retry 固定为 `0`，WebSocket 固定关闭。未知字段失败关闭。
- `forced_login_method="api"` 与运行态 `account.type=apiKey` 是两道独立门禁。API key 只由
  专用 `CODEX_HOME` 的文件凭据存储管理，不得进入 argv、环境变量、relay JSON/TOML、日志、
  SQLite、workspace 或 agent 环境；发送给选定 provider 是其唯一获准网络用途。
- provider 选择、custom URL 与固定重试策略进入安全摘要，但 API key 不进入，且当前
  `jobs.target_backend` 只绑定 `codex`。同一 state directory 禁止 provider 切换、endpoint
  变更或 key 轮换；只能创建全新 state/CODEX_HOME。`session release` 不是切换工具。
- 未知版本、哈希、wire protocol 或运行契约变化 fail closed。
- job 在首次入库事务内持久绑定 `target_backend`；schema v7 的 SQLite trigger 会拒绝
  任何后续改写，积压 job 不会跟随后来配置切换。`serve` 在启动 backend 或 Relay 前
  拒绝异 backend 的 `Received/Acked/Dispatching/Running/Cancelling` 积压；终态历史与
  outbox 投递不触发 provider 重跑。
  schema v4 的待派发 job 没有该历史字段，只有操作者显式填写
  `execution.legacyV4JobBackend` 后才允许 v4→v5 迁移；该值必须描述原始入库 backend，
  不能填写准备切换到的目标 backend。
- 当前 JobStore schema v7 延续 v6 的 Codex 账号身份强度、请求/实际 model、model
  provider、安全配置和 feature snapshot SHA-256，以及单调 thread-tail checkpoint；
  旧 v5 session 仅在没有 active/recovery/quarantine 时允许一次性安全补绑。
- v7 的 `execution_attempt_events` 永久记录 job/backend/session/lease/execution、Codex
  thread/turn、runtime/model/account/安全摘要与 attempt 事件；UPDATE 和 DELETE 都由
  SQLite trigger 拒绝。`backend_sessions` 仍是可变的当前 session/recovery anchor，只有
  账本用于 terminal 或人工 release 后的历史追溯，`jobs/outbox` 仍负责状态裁决。
- append-only 是当前 SQLite schema 内的防误改约束，不是密码学签名或外部 WORM。拥有
  state directory 写权限的人仍可替换整份数据库或备份；当前也没有自动 retention、导出
  或远端见证。账本不保存原始 prompt、final 或完整 transcript，但 reason、provider ID
  与账号摘要仍按敏感运行元数据保护，备份必须包含数据库、WAL 和 SHM。

## 设备来源边界

一期暂将 `from_node_id` 视为设备来源标识，但该值不是账号 subject，也不构成密码学设备认证。配置结构接受数组和逗号列表只是为了兼容现有格式，不表示多设备拓扑已经设计、验证或受到支持。

一套 daemon、config、state directory 与所选 execution backend 只能绑定一个来源设备。不得同时放行第二个 `node_id`，不得在同一状态目录中原地替换 `node_id`，也不得假设不同设备可以继承同一个 backend session、job、quarantine 或 outbox。Codex 的 immutable session hash 会绑定唯一 node ID，原地换设备必须因 metadata 冲突拒绝复用旧 thread。设备更换和多设备支持必须先定义上游 ID 稳定性、账号绑定、状态迁移、回滚与真实设备 canary，再作为独立方案评审。

Codex 模式已经在 daemon 代码级硬门禁“恰好一个 ID”，Hermes plugin 的双侧 allowlist 仍需运行前人工读回一致。两种模式都不能被表述为密码学逐帧设备认证；尤其 `cancel_chat` 只有 `job_id`、没有来源 `node_id`，其身份边界仍依赖已建立的 Relay 连接和一期单设备部署约束。

## 本地权限

- state directory：`0700`。
- connector socket、配置、身份、secret、proof、candidate 与审批回执：`0600`。
- Codex 的 `<stateDir>/backends/codex/home`、sessions、session root、workspace、
  workspace 外的宿主 HOME/TMPDIR 与 workspace 内的 agent HOME/TMPDIR 逐层要求
  `0700` 且不能是 symlink，并校验 realpath 与 dev/ino；daemon 固定的
  `config.toml` 为 `0600`。登录凭据由专用 Codex CLI 管理，仍受外层 `0700`
  `CODEX_HOME` 保护，不得复制到 workspace。当前固定配置禁用 shell snapshot 与
  bundled `.system` skills；Codex 0.145.0 仍会自行生成 SQLite/WAL/SHM、installation
  ID 等 `0755` 子目录或 `0644` 文件。它们依赖父目录 `0700` 隔离，不能把 daemon
  自管目录/文件的 `0700/0600` 保证外推到所有上游产物。
- schema v1→v2 迁移和 supported-proof writer 新建的私有目录会在 fsync 前显式固定并精确读回 `0700`；若上次进程在 `mkdir` 与固定权限之间退出，重试会受控修复只缺 owner 权限的已有目录。durable 临时文件与两类 guard 会在各自创建 fd 上显式固定并精确读回 `0600` 后才写入、同步或 rename。不能只依赖 `mkdir` / `open` 的 mode 参数，因为进程 umask 仍可能移除 owner 权限。
- `config.connector.socketPath` 的父目录必须是 state directory 内的私有非 symlink 目录；profile 迁移会在该路径创建并持久化普通文件 guard。创建 fd 会保持打开到安全 release，以固定原 inode，并与当前路径交叉复核 dev/inode、link count、文件类型、权限和 nonce；父目录的类型、私有权限与 realpath 也会在每次所有权检查和 release 完成前重验。位于 `/tmp` 等共享目录或 state directory 外的 socket 不属于迁移支持边界。
- connector 使用至少 32 字节随机 Bearer token，并做常量时间比较。
- refresh token 只在 daemon state directory 持久化，不进入 SQLite、argv、普通日志或 Git。当前 v2.0.0 兼容基线仍会把它复制进 Relay `connect` / `token_refresh` 帧：历史高层 canary 发生在旧代码基线，但没有字段级 receipt，也不证明服务端要求该字段；这是待收口的显式安全例外。目标是 Relay 只接收短期 access token，但在真实 Relay canary 前不得宣称兼容，也不得设置静默泄露回退。证据和门禁见[服务端协议边界](LIVIS-RELAY-PROTOCOL-BOUNDARY.md)。
- LiViS 一期没有附件或文件上传路径。Codex agent 可以读写其专用 workspace；该目录
  必须只放允许远程执行影响的内容，不得包含 daemon secret、其他项目 checkout 或
  用户默认 Codex profile。

## Codex 工具沙箱

Codex backend 只通过 `--strict-config --stdio` 启动，并禁用 plugins、remote plugin、
apps、shell snapshot、hooks、image generation、goals、memories、skill 依赖安装和
multi-agent；配置同时关闭 agents、bundled skills 与自动 skill instructions。daemon
通过 `experimentalFeature/list` 回读精确的已审核 enabled allowlist；未知 enabled、重复
名称、缺项、分页、stage/default 漂移或高风险项重新启用都在创建 thread 前失败关闭。
完整排序快照的 SHA-256 会绑定到 backend session。`shell_snapshot` 会在宿主权限下
source runtime HOME 的 shell rc，hooks 也可直接启动宿主命令；两者不能只依赖 turn
sandbox。

daemon 在每次创建或恢复 thread 后还必须读回：approval policy 为 `never`、
active permission profile 为 `livis-remote`、sandbox 为 `workspaceWrite`、工具网络
关闭，`runtimeWorkspaceRoots` 恰好为 daemon workspace，且 sandbox 不含额外
writable root。新建 thread 和每次 turn 都显式选择唯一的 `local` environment，并在
选择内重复固定 daemon workspace；空数组会清空本地 runtime roots，不能作为隔离
手段。`thread/resume` 不携带该选择，恢复后的每次 turn 必须重新固定。所有 approval
request 由 app-server client 默认拒绝。

filesystem profile 同时固定 `:root=deny`、`:minimal=read` 和
`:workspace_roots=write`。`workspaceWrite` 这个兼容回读名称本身不能证明读隔离；
真正的依据是固定配置与负向 canary。`:minimal` 仍会放行平台运行时路径，macOS 还会
读写系统临时目录，因此生产 state/Codex home 不得放在 `/tmp`、`/private/tmp` 或
`/var/tmp`，不同平台必须分别留存回执。

app-server 子进程只得到 session root 下 workspace 外的专用 `HOME`、`TMPDIR` 和
`CODEX_HOME`；agent shell 使用 workspace 内另行固定的 HOME/TMPDIR。其环境策略会排除
`CODEX_HOME`、`OPENAI_*` 和 `LIVIS_*`，并且不额外放行 `/tmp` 或继承的 `TMPDIR`。
工具无网络不等于 Codex 模型控制面无网络；app-server 仍需使用专用账号访问模型服务。
选择 custom provider 时，控制面目标就是配置的 custom endpoint；即使工具网络保持关闭，
API key、prompt、会话上下文与工具结果仍会由 app-server 发往该 endpoint。不得把工具
`networkAccess=false` 误写成“数据不会离开本机”。

Codex command 必须解析为 state directory 外、由当前 daemon 用户或 root 持有、不可被
group/other 写入且 `nlink=1` 的 canonical 可执行普通文件。daemon 通过
`lstat → open(O_NOFOLLOW) → fstat → 流式 SHA-256 → fstat/lstat` 固定 path、dev/ino、
mode、uid/gid、link count、长度、mtime/ctime 和内容摘要；版本探针后、app-server spawn
前、安全回读后及 idle recovery 都重新核对。生产 backend session 的
`security_config_sha256` 是固定版本的“安全 config 摘要 + command identity 摘要”绑定；
重启或 recovery 命中旧绑定时会在再次执行 command 前 quarantine，必须停机审阅并显式
`session release` 退役旧 thread。

这些 pathname/fd 复核仍不是内核原子的 fd-based exec，不能防御最后一次复核与
`exec` 之间由同一 OS 用户发起的协作外竞态。当前远端任务边界依赖 turn sandbox 禁止
把 workspace 外文件 hardlink 进 workspace；macOS/Codex 0.145.0 的长期 canary 会在
workspace 外用 `O_EXCL|O_NOFOLLOW` 创建同卷、无秘密的 0700 牺牲文件，先做 workspace
内 hardlink 正向 control，再要求外部文件 link 被拒绝、源 dev/ino/nlink 保持稳定，并按
dev/ino 清理。真实 Codex command 不参与 hardlink 探针，只单独复核 identity。该清理仍是
`lstat(dev/ino) → unlink` 的协作式保护，不是任意同 UID writer 下的原子 unlink CAS。升级
Codex、迁移平台或改变 filesystem profile 后必须重跑；独立 root-owned/只读安装或服务
身份仍是更强的生产边界。

app-server 在 macOS/Linux 作为独立 POSIX 进程组 leader 启动；关闭会先向整个进程组
发送 `SIGTERM`，超时后升级 `SIGKILL`，并等待直接 child、stdout/stderr 与进程组消失。
这只覆盖仍属于该进程组的后代；主动 `setsid()` 逃逸的进程仍需 Linux cgroup/systemd
或等价宿主隔离，不能把当前回执表述为任意进程树的强制收口。

idle app-server 自动恢复也受同一收口边界约束：只有 `running` 且内存/SQLite 都无 active
attempt、无 recovery/quarantine、Store anchor 未漂移时才可进入；旧进程组未确认关闭
不得启动候选，失败候选未确认关闭不得继续重试。daemon 生命周期固定累计三次候选，
退避为 `250/1000/5000 ms`。恢复只对同一持久 thread 执行 `thread/resume + thread/read`，
禁止新建 thread、修改 memory mode、发送 turn 或重放 job；immutable metadata、Store
anchor、rollout/checkpoint/tail 任一漂移立即 quarantine，不再重试。预算耗尽失败关闭；
活动 turn 退出仍保留执行不确定性并要求人工恢复。`stop()` 会取消退避并等待 recovery、
disconnect 与 app-server 进程组收口，关闭失败必须向上暴露。

旧 profile 的真实命令 canary 曾确认 agent 可以读取专用 `CODEX_HOME`；只剥离环境
变量不足以保护凭据。加入 workspace 外 read deny 后，2026-07-22 的一个 Codex 0.145.0
macOS 旧候选非临时目录回归曾确认 workspace 与 agent HOME/TMPDIR 可读写，专用
`CODEX_HOME` 和宿主 HOME/TMPDIR 读写被拒绝，且敏感环境变量未下传；零 turn 物化后
也能由新 app-server 恢复同一 thread。2026-07-23 的 fresh 回归又完整确认同卷外部牺牲
文件 hardlink 被拒绝、command identity 稳定，以及 macOS 系统 `nc -O` 对已监听 loopback
返回精确 `EPERM=1` 且 listener 无第二次 accept；该探针不需要放宽 profile 去读取 Perl
runtime。回执不覆盖 Linux、真实模型 turn、逃逸进程组后代或未来版本，Codex 后端仍不能
宣称生产上线。详细矩阵见
[Codex app-server 执行后端](CODEX-APPSERVER.md#当前上线门禁)。

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

- LiViS `logout` 不是运行中 daemon 的控制通道；执行前必须停止 daemon，以及 Hermes
  模式下的专用 Gateway，避免进程继续使用内存中的 access token 或已缓存 refresh token。
- IDaaS revoke 只有返回 2xx 才允许删除本地 refresh token；网络失败或远端拒绝时保留本地凭据并明确失败，供操作者重试。
- 一期没有 OAuth 账号 subject 与 identity/outbox 的迁移契约，不支持在同一 state directory 直接切换账号；不同账号必须使用隔离的配置和状态目录。
- Codex 登录与 LiViS OAuth 相互独立。执行 Codex logout 前必须停止 daemon 并确认
  app-server/工具子进程退出，再把命令精确指向专用 `CODEX_HOME`；不得登出或复用
  用户默认 `~/.codex`。
- Codex logout 只处理本地专用凭据，不等于 OpenAI/custom provider 已撤销 API key；撤销
  必须由对应 provider 管理面明确确认。轮换或切换 provider 时保留旧 state 作为证据，在
  全新 state/CODEX_HOME 登录新 key，不复制旧 `auth.json`，也不对旧 state 用
  `session release` 原地接管。

## 取消与隔离

Hermes `/stop` 和 Codex `turn/interrupt` 都不能证明不合作的工具线程或外部副作用已经停止。因此 backend 接受取消后，daemon 仍记录 `CancelUnknown` 并隔离 session。只有在停止所选 backend、确认旧 app-server/Gateway 及其工具子进程已结束、处置外部副作用并完整备份状态后，才允许人工执行 `session release`。命令会在 canonical connector socket 路径取得 offline guard，并固定同一 canonical state directory 打开 SQLite；运行中 daemon 或并发启动存在时失败关闭，配置 symlink 随后重定向也不能改变数据库 target。退役和 `retiredBackendSessions` 内容来自同一个 SQLite 事务。存在 recovery，或存在 quarantine 且所有 backend session 都无 active/recovery 时，它会退役相应旧绑定；任一 backend 仍有未进入 recovery 的 active evidence、recovery 锚点与 job 的 session/backend/lease/generation 不一致或 recovery 不可释放时拒绝。旧 rollout/workspace 和 job/outbox 保留，`codexBackendSessionRetired=true` 才精确表示数据库中的 Codex 绑定被退役；不能把 release 理解为恢复原 thread、删除外部证据或自动证明没有 backend row 的 ambiguous `thread/start` 已被撤销。事务提交后的 guard 收口与 stdout 不具备 SQLite 原子性，收口失败时必须读回数据库，不能用空回执推断零修改。

未知 job 的 `cancel_chat` 可以先于对应消息到达，但 intent 只保留 24 小时，全库最多保留 4096 条。重复 cancel 会刷新同一 intent 的有效期；满额后新的未知 job ID 会被拒绝且不发送成功 ACK，不会静默挤掉 TTL 内已有 intent。job 到达时会在同一 SQLite 事务中应用并删除匹配 intent。旧数据库启动时会删除过期 intent；当前 scope 已有匹配 job 的残留会先按当前状态应用取消，再删除 intent，其中未执行 job 进入 `Cancelled`，active job 进入 `Cancelling` 并在重启恢复中隔离为 `CancelUnknown`。若旧数据已超过上限，只确定性保留最新 4096 条。因此 cancel-before-message 只在 24 小时乱序窗口和容量未耗尽时保证。

## Relay 输入资源边界

- `config.relay.maxFrameBytes` 默认 1 MiB，最大允许 16 MiB；旧 schema v1 配置缺少该字段时使用默认值。
- `ws` 在组装完整消息、解压、转成字符串和 JSON 解析前执行整体 payload 上限；回调中再次按 UTF-8 字节数检查。
- envelope 与业务 `type` 最多 64 UTF-8 字节；job/message/ACK/node/agent/device ID 最多 256 字节；node type 最多 64 字节。超限值不会进入 handler、SQLite 或普通日志。
- 日志中的非秘密字符串超过 1024 UTF-8 字节时整段替换为长度摘要；token、authorization、secret、password 和 cookie 字段仍整段脱敏。

Codex `turn/completed.turn.error.message/additionalDetails`、JSON-RPC error 的 `message/data`
与 app-server stderr 属于未受信 provider 自由文本，即使上游只显示 API key 掩码片段也
不得进入 Relay、`relay.db` 或共享日志。公开 RPC/transport error 只保留内部 method、
数值 code/exit code 和固定分类；daemon 只持久化白名单
`codexErrorInfo`/HTTP 分类和固定的 `invalid_api_key` 标签。原始详情可能仍存在于专用
`CODEX_HOME` rollout 或 client 的有界诊断缓冲，因此该目录与进程内诊断必须继续按凭据级
敏感数据保护。明确认证拒绝会在同一事务中提交 `Failed`、ledger、outbox、active clear
和 session quarantine，随后关闭 backend，避免崩溃窗口或排队请求反复发送。

这些限制约束单帧和单条标识，不构成完整流量整形。当前消息处理 Promise 队列没有独立深度/累计字节上限，大量合法小帧仍可能形成短时积压；应在受控 Relay、网络层限速和进程监控下运行。

## 数据落盘与保留

SQLite 默认明文保存 `from_node_id`、输入文本、原始 payload、job/lease 状态、最终结果和 backend session 元数据。Codex workspace 与专用 `CODEX_HOME` 还会保存工作产物以及由 Codex CLI 管理的认证/thread 数据。daemon 自管数据库/WAL/SHM/配置文件固定为 `0600`；Codex 上游自管文件可能为 `0644`，依赖专用 home 及其父目录的 `0700`。两者都不提供项目层静态加密。

除上述临时 `pending_cancels` 外，一期仍没有 jobs、outbox 或投递尝试的自动保留期和后台 purge；这些记录会持续保留，直到操作者主动清理。合法但未授权 node 的请求仍保持原有回复语义：先持久化为 `Rejected` 并通过 outbox 返回配置的未授权提示，本次资源边界不改变这一行为。需要彻底清除历史时：

1. 停止 daemon；Hermes 模式同时停止专用 Gateway，Codex 模式确认 app-server 与工具子进程均已退出；
2. 按组织要求备份或销毁 `relay.db`、`relay.db-wal`、`relay.db-shm`；
3. 若需要彻底清除 Codex 历史，同时按组织要求处理 `<stateDir>/backends/codex`，不得只删 thread 或只改 SQLite；
4. 重新启动前执行 `doctor`，确认新数据库完整且 session quarantine 为空。

不要在服务运行期间直接删除或复制 WAL/SHM，也不要把数据库加入 issue、测试 fixture 或 Git 提交。
