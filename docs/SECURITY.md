# 安全边界

## 必须明确确认的事实

- 截至 2026-07-21，在[协议证据账本](LIVIS-RELAY-PROTOCOL-BOUNDARY.md)列明的 GitHub 与聚焦公开网页检索范围内，只找到 OpenClaw 接入线索，未发现可验证的第三方 SDK、服务端 schema 或稳定协议承诺；该阴性结果存在私有和未索引资料盲区。
- 本项目只静态兼容官方 v2.0.0 artifact 中观察到的 wire 行为，不执行或复制官方 bundle。
- 原 OpenClaw 插件的 `CommandAuthorized: true` 不适用于本项目。
- 公开仓库不附带 live profile；example 中的端点、OAuth 和哈希均为无效占位值。
- `bun run release:check` 只审核 `git ls-files -z` 返回的 index 内容，拒绝本地状态文件、官方 bundle、归档、生产域名和官方 OAuth client identity 指纹。生产域名仅允许在 Markdown/RST/TXT 安全说明中出现，OAuth identity 与私钥内容没有文档例外。
- 本地 protocol probe 只使用固定哨兵、注入 fetch 和 loopback；公开发布门禁拒绝私有 probe 回执、raw frame、trace、HAR 与 pcap。probe 成功仍只是 S2。

初始化时必须显式传入 `--acknowledge-unofficial-protocol`。这只是确认已知边界，不代表获得第三方授权。

## 一期强制默认值

- `allowAllNodes=false`；进入 `serve` 或实网 canary 前，`security.allowedNodeIds` 必须恰好包含一个获准 `node_id`。
- `execution.backend` 缺省为 `hermes`。切换为 `codex` 时，代码会拒绝
  `allowAllNodes=true` 或不等于一个元素的 `allowedNodeIds`，并且还必须显式设置
  `codex.acknowledgeRemoteExecution=true`。
- `LIVIS_ALLOW_ALL_USERS` 必须为空/false；`LIVIS_ALLOWED_USERS` 必须只包含与 daemon 完全相同的唯一 `node_id`，`*` 和多个值都不属于一期受支持配置。
- `LIVIS_PHASE1_READ_ONLY_ACK=true` 只在专用 Hermes profile 已关闭写工具后设置。
- Hermes streaming、tool progress、interim message、附件和远程审批全部关闭。
- Hermes runtime 审核范围默认是 `[0.15.1, 0.15.2)`；bridge 范围是 `[0.1.0, 0.2.0)`。
- Codex CLI 审核范围固定为 `[0.145.0, 0.146.0)`；必须使用 daemon state
  directory 内单独登录的 `CODEX_HOME`，不得复用 `~/.codex`。
- 未知版本、哈希、wire protocol 或运行契约变化 fail closed。

## 设备来源边界

一期暂将 `from_node_id` 视为设备来源标识，但该值不是账号 subject，也不构成密码学设备认证。配置结构接受数组和逗号列表只是为了兼容现有格式，不表示多设备拓扑已经设计、验证或受到支持。

一套 daemon、config、state directory 与所选 execution backend 只能绑定一个来源设备。不得同时放行第二个 `node_id`，不得在同一状态目录中原地替换 `node_id`，也不得假设不同设备可以继承同一个 backend session、job、quarantine 或 outbox。Codex 的 immutable session hash 会绑定唯一 node ID，原地换设备必须因 metadata 冲突拒绝复用旧 thread。设备更换和多设备支持必须先定义上游 ID 稳定性、账号绑定、状态迁移、回滚与真实设备 canary，再作为独立方案评审。

Codex 模式已经在 daemon 代码级硬门禁“恰好一个 ID”，Hermes plugin 的双侧 allowlist 仍需运行前人工读回一致。两种模式都不能被表述为密码学逐帧设备认证；尤其 `cancel_chat` 只有 `job_id`、没有来源 `node_id`，其身份边界仍依赖已建立的 Relay 连接和一期单设备部署约束。

## 本地权限

- state directory：`0700`。
- connector socket、配置、身份、secret、proof、candidate 与审批回执：`0600`。
- Codex 的 `<stateDir>/backends/codex/home`、sessions、session root、workspace、
  runtime HOME 与 TMPDIR 逐层要求 `0700` 且不能是 symlink；daemon 固定的
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
通过 `experimentalFeature/list` 回读高风险 feature 均为 disabled，缺项、分页或重新
启用都在创建 thread 前失败关闭。`shell_snapshot` 会在宿主权限下 source 可写 runtime
HOME 的 shell rc，hooks 也可直接启动宿主命令；两者不能只依赖 turn sandbox。

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

app-server 子进程只得到专用 `HOME`、`TMPDIR` 和 `CODEX_HOME`；agent shell 的环境
策略会排除 `CODEX_HOME`、`OPENAI_*` 和 `LIVIS_*`，并且不额外放行 `/tmp` 或继承的
`TMPDIR`。工具无网络不等于 Codex 模型控制面无网络；app-server 仍需使用专用账号
访问模型服务。

旧 profile 的真实命令 canary 曾确认 agent 可以读取专用 `CODEX_HOME`；只剥离环境
变量不足以保护凭据。加入 workspace 外 read deny 后，2026-07-22 的 Codex 0.145.0
macOS 非临时目录回归已确认 workspace 可读写、专用 `CODEX_HOME` 读写被拒绝，
且敏感环境变量未下传；零 turn 物化后也能由新 app-server 恢复同一 thread。该回执不
覆盖 Linux、真实模型 turn、后代进程或未来版本，Codex 后端仍不能宣称生产上线。详细矩阵见
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

## 取消与隔离

Hermes `/stop` 和 Codex `turn/interrupt` 都不能证明不合作的工具线程或外部副作用已经停止。因此 backend 接受取消后，daemon 仍记录 `CancelUnknown` 并隔离 session。只有在停止所选 backend、确认旧 app-server/Gateway 及其工具子进程已结束并处置外部副作用后，才允许人工执行 `session release`。

未知 job 的 `cancel_chat` 可以先于对应消息到达，但 intent 只保留 24 小时，全库最多保留 4096 条。重复 cancel 会刷新同一 intent 的有效期；满额后新的未知 job ID 会被拒绝且不发送成功 ACK，不会静默挤掉 TTL 内已有 intent。job 到达时会在同一 SQLite 事务中应用并删除匹配 intent。旧数据库启动时会删除过期 intent；当前 scope 已有匹配 job 的残留会先按当前状态应用取消，再删除 intent，其中未执行 job 进入 `Cancelled`，active job 进入 `Cancelling` 并在重启恢复中隔离为 `CancelUnknown`。若旧数据已超过上限，只确定性保留最新 4096 条。因此 cancel-before-message 只在 24 小时乱序窗口和容量未耗尽时保证。

## Relay 输入资源边界

- `config.relay.maxFrameBytes` 默认 1 MiB，最大允许 16 MiB；旧 schema v1 配置缺少该字段时使用默认值。
- `ws` 在组装完整消息、解压、转成字符串和 JSON 解析前执行整体 payload 上限；回调中再次按 UTF-8 字节数检查。
- envelope 与业务 `type` 最多 64 UTF-8 字节；job/message/ACK/node/agent/device ID 最多 256 字节；node type 最多 64 字节。超限值不会进入 handler、SQLite 或普通日志。
- 日志中的非秘密字符串超过 1024 UTF-8 字节时整段替换为长度摘要；token、authorization、secret、password 和 cookie 字段仍整段脱敏。

这些限制约束单帧和单条标识，不构成完整流量整形。当前消息处理 Promise 队列没有独立深度/累计字节上限，大量合法小帧仍可能形成短时积压；应在受控 Relay、网络层限速和进程监控下运行。

## 数据落盘与保留

SQLite 默认明文保存 `from_node_id`、输入文本、原始 payload、job/lease 状态、最终结果和 backend session 元数据。Codex workspace 与专用 `CODEX_HOME` 还会保存工作产物以及由 Codex CLI 管理的认证/thread 数据。daemon 自管数据库/WAL/SHM/配置文件固定为 `0600`；Codex 上游自管文件可能为 `0644`，依赖专用 home 及其父目录的 `0700`。两者都不提供项目层静态加密。

除上述临时 `pending_cancels` 外，一期仍没有 jobs、outbox 或投递尝试的自动保留期和后台 purge；这些记录会持续保留，直到操作者主动清理。合法但未授权 node 的请求仍保持原有回复语义：先持久化为 `Rejected` 并通过 outbox 返回配置的未授权提示，本次资源边界不改变这一行为。需要彻底清除历史时：

1. 停止 daemon；Hermes 模式同时停止专用 Gateway，Codex 模式确认 app-server 与工具子进程均已退出；
2. 按组织要求备份或销毁 `relay.db`、`relay.db-wal`、`relay.db-shm`；
3. 若需要彻底清除 Codex 历史，同时按组织要求处理 `<stateDir>/backends/codex`，不得只删 thread 或只改 SQLite；
4. 重新启动前执行 `doctor`，确认新数据库完整且 session quarantine 为空。

不要在服务运行期间直接删除或复制 WAL/SHM，也不要把数据库加入 issue、测试 fixture 或 Git 提交。
