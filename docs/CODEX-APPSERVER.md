# Codex app-server 执行后端

本文定义 daemon 内置 Codex 执行后端的配置、状态所有权、运行目录和上线门禁。
它不改变 LiViS wire 协议边界，也不把 Codex 伪装成 Hermes connector。

Codex 当前是显式选择的实验后端；默认执行后端仍是 Hermes。配置枚举固定为
`hermes | codex | claude` 且一套 daemon 同时只选一个。Claude Code 尚未实现；选择
`claude` 时 `doctor`/`serve` 失败关闭，不得通过复用 Codex 配置、Hermes socket 或
手工改数据库来接入。

## 支持范围

- Codex CLI 只审核 `[0.145.0, 0.146.0)`；当前窗口实际只放行 `0.145.x`。
- daemon 直接启动 `codex app-server --strict-config --stdio`，同时禁用 plugins、
  remote plugin、apps、宿主 shell snapshot/hooks、image generation、goals、memories、
  skill 依赖安装和 multi-agent；Codex 不经过 Hermes bridge。专用配置还关闭 agents、
  bundled skills 与自动 skill instructions。
- Codex 模式在代码级要求 `security.allowAllNodes=false` 且
  `security.allowedNodeIds` 恰好包含一个获准 `node_id`。所有该设备的消息固定映射到
  `sessionKey=livis:<agentId>`，再映射到一个持久 Codex thread。
- 只把纯文本作为 turn 输入，只在 terminal `turn/completed` 后选择一个 agent final
  交给 durable outbox；reasoning、tool output、progress 和流式 commentary 不发送到
  LiViS。若上游没有标记 `final_answer`，只在 terminal 后使用最后一个已完成且
  `phase=null` 的 `agentMessage` 作为兼容兜底。
- 附件、远程审批、多设备、多 thread 路由、主动消息和远程管理命令均不支持。

## 显式配置与确认

旧配置缺少 `execution` 时仍按 Hermes 运行。启用 Codex 必须同时设置：

```json
{
  "execution": {
    "backend": "codex"
  },
  "codex": {
    "command": "/绝对路径/codex",
    "model": null,
    "requestTimeoutMs": 30000,
    "turnTimeoutMs": 900000,
    "interruptGraceMs": 5000,
    "shutdownTimeoutMs": 5000,
    "acknowledgeRemoteExecution": true
  }
}
```

`acknowledgeRemoteExecution=true` 只表示操作者理解“来自唯一获准 LiViS 设备的文本会
触发 Codex 在 daemon workspace 中执行”。它不扩大 LiViS 授权、不开放审批，也不
表示已通过生产安全 canary。没有这项确认时 `serve` 失败关闭。

`codex.command` 必须是绝对路径。daemon 启动前会解析其 canonical executable，并拒绝
位于 state directory 内的命令；传给子进程的 `PATH` 同时会过滤空项、相对项和位于
state directory 内的目录，避免 launchd/systemd 的环境差异或不可信目录改变实际
执行文件。`doctor` 会复用同一套 runtime layout、canonical command、私有环境、
有界输出与超时门禁检查所选后端和版本窗，但不会替代私有账号登录、app-server
thread 安全回读或真实消息闭环。

## 私有目录与登录

不得复用用户日常使用的 `~/.codex`。默认 state directory 下的布局为：

```text
<stateDir>/                              0700
└── backends/
    └── codex/
        ├── home/                        专用 CODEX_HOME
        │   ├── config.toml              daemon 固定并读回的安全配置
        │   └── ...                      Codex CLI 管理的认证与 thread 数据
        └── sessions/
            └── <64 位小写十六进制 session hash>/
                ├── host-home/            app-server 子进程的 HOME
                ├── host-tmp/             app-server 子进程的 TMPDIR
                └── workspace/            唯一工具可写根
                    ├── .agent-home/       agent shell 的 HOME
                    └── .agent-tmp/        agent shell 的 TMPDIR
```

session hash 由本地 scope、backend、稳定 session key 和唯一获准 `node_id` 共同推导；
真实 ID 不直接作为目录名。该 node ID 是 immutable session metadata，在同一 state
directory 中原地换设备会产生 session hash 冲突并拒绝复用旧 thread。daemon 会逐层
创建并读回 `0700` 普通目录，拒绝 symlink、realpath 漂移、inode 替换或安全
`config.toml` 内容漂移。

## 无模型 turn 的本机 smoke

协议 fake 不能代替真实 app-server。使用下面的手动入口可在系统临时目录创建一个带
专用 marker 的可丢弃 state directory，并执行：

```text
initialize → account/read → permissionProfile/list → experimentalFeature/list
→ thread/start → thread/memoryMode/set(disabled) → thread/read
→ close → 新 app-server initialize → thread/resume → close
```

```bash
bun run smoke:codex:app-server -- --command /opt/homebrew/bin/codex
```

入口不会读取 relay config、不会打开或迁移 `relay.db`、不会复用 `~/.codex`，也绝不
发送 `turn/start`。它会先把空 thread 物化，再由第二个真实 app-server 恢复同一 ID；
输出中的 `zeroTurnMaterialized=true` 与 `zeroTurnResumeVerified=true` 才表示该回归通过。
全新 state 的预期账号结果是 `authenticated=false`、`requiresOpenaiAuth=true`、
`backendStartReady=false`；若意外继承账号会失败关闭。

系统临时目录位于 macOS `:minimal` 读取基线内，不能用于证明凭据隔离。要运行真实读取
负向 canary，必须在可信终端使用一个尚不存在、位于非临时私有持久父目录下的路径：

```bash
bun run smoke:codex:app-server -- \
  --command /opt/homebrew/bin/codex \
  --create-state-dir /绝对/非临时/路径/livis-codex-canary \
  --verify-read-isolation
```

该模式用 `command/exec` 操作本入口生成的无秘密 marker，验证 workspace 和 agent
HOME/TMPDIR 可读写，专用 `CODEX_HOME` 与宿主 HOME/TMPDIR 均不可读写，且 sandbox
子进程看不到 `CODEX_HOME`、`OPENAI_*`、`LIVIS_*`。
它不需要账号或模型 turn。macOS 嵌套沙箱可能拒绝在另一个 sandbox 中执行
`sandbox-exec`，此时应在本机可信终端直接运行，不能把 `Operation not permitted`
误判为 profile 通过或失败。

只有本入口创建、权限为 `0700` 且 marker 精确匹配的目录，才能通过 `--state-dir`
复用；`--create-state-dir` 要求目标不存在且父目录为 canonical 普通目录。两者都不能
指向生产 state directory、项目 checkout 或用户日常 `~/.codex`。输出目录会保留，
用完后由操作者确认路径再删除。

这个 smoke 只承诺“没有模型 turn”，不承诺完全离线。Codex 0.145.0 即使在空账号下，
也可能在 `thread/start` 后尝试连接模型控制面并产生有界 stderr；因此该入口保持手动，
不加入默认 `bun run check`。每次运行还会在可丢弃 state 中创建一个未使用的非
ephemeral thread。

首次使用时，在本机可信终端为专用目录登录；不要从 LiViS 消息触发登录，也不要把
API key 写入 argv、配置文件或 shell history。以下示例使用默认 state directory：

```bash
STATE_DIR="$HOME/.livis-relay"
CODEX_HOME="$STATE_DIR/backends/codex/home"

test -d "$STATE_DIR" && ! test -L "$STATE_DIR"
test "$(cd "$STATE_DIR" && pwd -P)" = "$STATE_DIR"
test "$(stat -f '%Lp' "$STATE_DIR")" = 700
install -d -m 0700 "$CODEX_HOME"

env CODEX_HOME="$CODEX_HOME" /绝对路径/codex login --device-auth
env CODEX_HOME="$CODEX_HOME" /绝对路径/codex login status
```

Linux 应使用等价的 `stat -c '%a'` 检查。若使用 API key 登录，应从标准输入传入
`codex login --with-api-key`；不要把 key 拼进命令行。登录命令只负责专用 Codex
账号，daemon 首次启动仍会生成并固定自己的 `config.toml`。如果该文件已由其他工具
生成或被改写，daemon 会拒绝启动；不得为了启动而放宽或覆盖安全配置。

退出账号前先停止 daemon，确认 app-server 子进程和可能的工具子进程均已退出，再用
同一个专用 `CODEX_HOME` 执行本地 `codex logout`。LiViS `logout` 与 Codex logout
是两条独立的认证生命周期。

## app-server 安全边界

daemon 为 app-server 固定以下边界，并在 `thread/start` 或 `thread/resume` 返回后
逐项读回：

- `approvalPolicy=never`，且 client 对任何新旧 approval request 默认拒绝；
- active permission profile 必须为 `livis-remote`；
- sandbox 必须为 `workspaceWrite`，`runtimeWorkspaceRoots` 必须恰好是上述 workspace，
  且 `sandbox.writableRoots` 不得追加任何额外写根；
- 自定义 filesystem profile 固定为 `:root=deny`、`:minimal=read`、
  `:workspace_roots=write`。其中 `:minimal` 只为 shell、动态库和系统运行时保留平台
  基线，不等于绝对的 workspace-only 读取；
- 新建 thread 与每次 turn 都显式选择唯一的 `local` environment，并在该选择中再次
  固定 `cwd` 与 `runtimeWorkspaceRoots`；`environments=[]` 会清空本地 runtime roots，
  不能用于隔离。`thread/resume` 不发送 environments，因此恢复后的每次 turn 仍必须
  重新固定 `local` environment，不能沿用 thread sticky environment；
- 工具网络为关闭状态，`/tmp` 与继承的 `TMPDIR` 不额外放行；
- shell 只继承最小环境，并排除 `CODEX_HOME`、`OPENAI_*` 和 `LIVIS_*`；
- workspace 预先标为 `untrusted`，防止 Codex 在首次 thread 创建时把项目自动追加为
  trusted 并修改 daemon 固定配置。

app-server 的 NDJSON 单行、stderr、notification backlog、agent message 数量、标识和
累计内容均设有硬上限。stdout 在进程退出前 EOF、无法关联有效请求 ID 的已知
server request（包括审批、用户输入、elicitation、动态工具、凭据刷新、attestation 与
时间读取）都会直接关闭 transport，不得降级为可忽略 notification。

daemon 还会通过 `experimentalFeature/list` 回读精确的 0.145.x enabled allowlist；
未知 enabled、重复名称、缺项、分页、允许项 stage/default 漂移或高风险项重新启用都
在创建 thread 前失败关闭，完整排序快照的 SHA-256 会绑定到 backend session。
`shell_snapshot` 与 hooks 必须特别保持关闭：前者会启动宿主 login shell 并 source
runtime HOME 下的 rc，后者的 command runner 也不经过 turn sandbox。关闭 bundled skills 后，真实无模型
smoke 不再铺设 `.system` skills 或 `shell_snapshots`；但上游仍会在外层 `0700` home
内创建部分 `0755` 子目录和 `0644` 文件，不能把 daemon 自管目录/文件的
`0700/0600` 保证外推到所有上游产物。

这里的“无网络”指 agent 工具执行沙箱不允许网络访问；Codex app-server 自身仍需通过
其认证控制面请求模型。workspace 内容应始终视为远程输入可影响的不可信数据，不应
放置 daemon secret、LiViS token、用户默认 Codex 凭据或其他项目 checkout。

## thread、job 与持久化

JobStore schema v4 新增 `backend_sessions`；schema v5 在 job 首次入库时持久化不可变
`target_backend`，阻止切换配置后的 Hermes、Codex 或未来 Claude 接管旧积压。当前
schema v6 继续持久化 Codex 账号类型、账号 subject 摘要与身份强度、请求/实际 model、
model provider、安全配置 SHA、feature 快照 SHA 和稳定 thread-tail checkpoint；同时保留
backend、session hash、cwd、CLI 版本、thread ID 以及当前 job/lease/run generation/turn ID。
状态职责为：

```text
LiViS message
  → JobStore 原子 claim + backend attempt reservation
  → turn/start（可能已写入时绝不自动重发）
  → turn ID 与 Running 原子绑定
  → terminal turn/completed
  → Succeeded/Failed + durable outbox
```

Codex thread 是会话连续性的载体，不是 job/outbox 真源。daemon 重启后只有在没有 active
attempt、没有 quarantine 且持久元数据完全一致时才恢复同一个 thread；不会因为恢复
失败而静默创建替代 thread。CLI 版本、cwd、session hash、账号/模型/安全摘要、thread
绑定或 checkpoint 发生冲突时均失败关闭。v5 旧 session 只有在没有 active attempt、
recovery 或 quarantine 时，才允许在真实安全回读后一次性补绑 v6 元数据。

Codex 0.145.0 的非 ephemeral thread 在首个 user turn 前采用 lazy materialization；
仅 `thread/start` 后关闭 app-server 会留下不可恢复 ID。daemon 因此在 SQLite bind 前
固定执行：

```text
thread/start 安全回读
→ thread/memoryMode/set(mode=disabled)
→ 有界轮询 thread/read(includeTurns=true)
→ 校验 rollout 位于专用 CODEX_HOME/sessions、普通非 symlink 文件、首条 session_meta.id
→ bindBackendThread → onReady
```

物化验证前崩溃时 SQLite 仍保持 `thread_id=null`，最多遗留一个没有 turn 的空 rollout；
验证后保持不变量“`backend_sessions.thread_id` 非空即 rollout 已验证存在”。已绑定 thread
的 rollout 缺失、路径漂移或内容不匹配一律按数据损坏失败关闭，不会静默创建替代
thread。真实 Codex 0.145.0 已通过“零 turn 关闭后由新 app-server 恢复同一 ID”回归。

## 取消、崩溃与人工 release

`turn/interrupt` 返回成功只证明 app-server 接受了中断请求，不能证明已经启动的工具
副作用停止。对已提交 turn 的取消会进入 `CancelUnknown`，并把 backend session 标成
`recovery_required`、保留 active job/lease/generation/turn 证据和 session quarantine。

`turn/start` 超时或传输终止时，只有 transport 能证明请求尚未写入，daemon 才可撤销
attempt；只要可能写入，就按 ambiguous execution 进入 `Interrupted`/quarantine，绝不
自动重发。daemon 重启、app-server 意外退出、事件处理失败或活动 turn 期间停止服务
也采用同一失败关闭原则。

`turnTimeoutMs` 从发送 `turn/start` 前开始计算完整 turn 的绝对时限；超时后只允许
deadline 或用户 cancel 中的一个 interruption owner 发出一次 `turn/interrupt`，并在
`interruptGraceMs` 后失败关闭。`turn/interrupt` 的 RPC response 不是 terminal 真源；
用户取消仍须等待权威 `turn/completed`，先以 active fence checkpoint 实际
completed/failed/interrupted 尾部，再进入 `CancelUnknown`。deadline 后到达的任何
terminal 或取消回执一律不生成 result/outbox。

app-server 作为独立 POSIX 进程组 leader 启动，关闭按
`SIGTERM → 有界等待 → SIGKILL → 有界收口回执` 执行，并同时等待直接 child、stdio 与
进程组消失；无法确认时不会静默报告 stop 成功。

恢复顺序固定为：

1. 停止 daemon，并确认旧 `codex app-server` 和它启动的所有工具子进程均已退出；
2. 保留日志、`status` 和数据库作为证据，判断外部副作用是否需要人工处置；
3. 从 `status` 读回稳定 `sessionKey`；
4. 完整备份 `relay.db`、WAL/SHM（若存在），并保留旧 `CODEX_HOME` rollout；
5. 执行 `bun run src/index.ts session release '<sessionKey>'`；该操作会退役存在 recovery
   的 Codex backend session/thread 绑定，下次启动创建新 thread，不会恢复旧 thread；
6. 重新执行 `doctor --online`，确认无 quarantine 后再启动 daemon，并读回新 thread。

`session release` 根据 JobStore 中所有 backend 的历史恢复证据执行，不依赖当前选择的
执行后端。因此，从 Codex 切回 Hermes 后仍可释放先前留下的 Codex quarantine，反之
亦然。对存在 recovery 的 Codex session，它会删除数据库中的旧 backend session 绑定，
但不会删除旧 rollout、workspace、job/outbox，也不会撤销文件、命令或外部系统副作用。
这是显式 session reset：下次启动会按当时账号、模型和安全配置创建并绑定新 thread。

## 当前上线门禁

当前实现和真实 `thread/start` 安全回读已经确认：只有显式选择 `local` environment
后，approval、permission profile、workspace-only writable roots、无工具网络以及
`/tmp` 隔离才会同时命中预期；空 environment 数组会退化为 `readOnly`。

2026-07-22 的旧 profile 真实命令 canary 曾确认 agent 可读取专用 `CODEX_HOME`；只剥离
环境变量不足以保护凭据。加入 `:root=deny`、`:minimal=read` 与 workspace write
carveout 后，Codex 0.145.0 已在 macOS 非临时、可丢弃私有目录重新通过：workspace
和 agent HOME/TMPDIR 可读写，专用 `CODEX_HOME` 与宿主 HOME/TMPDIR 读写被拒绝，且
`CODEX_HOME`、`OPENAI_*`、`LIVIS_*` 未进入 sandbox 子进程环境。该回执只覆盖当前
macOS/CLI/config 组合，不可外推到 Linux 或未来 Codex 版本。

macOS 的 `:minimal` 会为系统运行时开放一组平台路径，并包含 `/tmp`、`/private/tmp`、
`/var/tmp`。所以协议 smoke 可以使用系统临时目录，但凭据/读取隔离 canary 和生产
`CODEX_HOME` 绝不能放在这些目录；必须使用不在 minimal 基线中的私有持久目录。Linux
也必须按目标版本重新核对平台基线，不能把 macOS 回执直接复用。

因此 Codex 后端已经跨过“空账号协议接线、读取隔离、零 turn 恢复与高风险 feature
冻结”这组本地门禁，但仍只能作为受控开发功能，不能宣称生产上线。继续集成至少还要：

- 用本地 fake Responses endpoint 截获工具定义，确认只有已审核的 core/workspace 工具；
- workspace 内创建指向 Codex command 的 hardlink 必须被 sandbox 拒绝，并核对后续
  启动前 command 内容没有漂移；
- 增加真实工具网络负向 canary；当前读取隔离 canary 没有尝试联网；
- cancel、app-server kill 和 daemon restart 都进入预期 quarantine，且 release 前不派发；
- 为专用账号完成一个受控真实 turn，验证已实现的总体 deadline、输出与工具事件归属；
- 唯一设备的纯文本 job 只在 terminal 后产生一个 final，并完成
  `Succeeded → Delivered → App 回显`。

### 2026-07-22 本机验证回执

当前本地 worktree 在更新 `origin` 引用后仍基于最新 `origin/main`，未执行 merge、rebase、
push 或创建 PR。本轮在允许监听 loopback TCP 与 Unix socket 的本机环境执行：

```bash
bun run check
bun run smoke:codex:app-server -- --command /opt/homebrew/bin/codex
bun run smoke:codex:app-server -- \
  --command /opt/homebrew/bin/codex \
  --state-dir /绝对/非临时/私有/canary/path \
  --verify-read-isolation
```

`bun run check` 通过 300 个 Bun 测试和 22 个 Hermes pytest。两次真实 Codex 0.145.0
smoke 均得到 `sentModelTurn=false`、`zeroTurnMaterialized=true` 和
`zeroTurnResumeVerified=true`；非临时 canary 还确认 workspace 可读写、专用
`CODEX_HOME` 与宿主 HOME/TMPDIR 读写被拒绝，agent HOME/TMPDIR 可写，敏感环境变量
不可见。

这些回执只证明当前 macOS 上的无模型协议、持久化和读取隔离边界。smoke 使用未登录的
可丢弃专用 `CODEX_HOME`，所以 `backendStartReady=false` 是预期结果；它没有验证专用真实
账号、模型 turn、工具最终清单、资源收口或 LiViS App 回显。

## 当前产品语义与后续缺口

当前代码实际实现的是：一个 daemon、一个获准 `node_id`、一个固定隔离空 workspace、
一个长期 Codex thread，所有纯文本 job 串行执行；一套配置只能在 Hermes、Codex、
Claude 中选择一个 backend，Claude 未实现时失败关闭。
这足以验证第一条 Codex 功能链，但以下语义尚未定型：

- LiViS 每次新对话是否创建新 thread，还是一台设备永久复用一个 thread；
- workspace 永远由 daemon 创建为空目录，还是允许操作者显式绑定已有项目；

当前已验证的 LiViS `send_message` 输入只有 job、来源 node 和文本，没有稳定的
conversation/session 标识。因此“App 新对话自动创建新 thread”目前没有可靠路由键；
在服务端字段得到 probe 证据前，只能继续复用唯一 thread，或由本地显式 rotate 命令切换，
不能从 job ID、时间间隔或文本内容猜测对话边界。

不依赖上述产品决策、仍应在 Codex MVP 后续补齐的工程项包括：

- idle app-server 崩溃后的有界自动恢复；
- 当前已覆盖完整 turn deadline 和同一 POSIX 进程组的两阶段收口；仍需 CPU、内存、
  PID、磁盘、token/费用配额，以及 Linux cgroup/systemd 对逃逸进程组后代的强制收口；
- 持久保留 job → provider session/thread → provider turn 的审计映射；
- 当前已持久化并校验 thread tail/checkpoint；仍需跨进程独占锁和 append-only execution
  attempts，使 terminal 或人工 reset 后也能长期追溯 job/thread/turn；
- 当前已分离宿主与 agent HOME/TMPDIR，并绑定账号类型、可用时的 ChatGPT email 摘要、
  model/provider 与安全摘要；API key/Bedrock 或无 email 账号仍只有 type-only 身份强度，
  需要更强的可轮换账号标识；
- backend 不可用时的 Relay admission 策略：当前 idle app-server 退出后不会自动恢复，
  新 job 仍可能持久化并 ACK，但会一直等待 daemon 人工重启；
- 输入速率、排队深度、token/费用和持久磁盘总量配额；
- session new/list/rotate/archive 与 workspace 生命周期管理；
- 固定空 workspace 中产物的查看、导出或销毁路径；一期 LiViS 只回纯文本 final，不会把
  本地文件交付到 App；
- Codex CLI 升级后旧 session 的兼容检查与迁移路径；
- 专用账号初始化/状态运维，以及真实 LiViS App 回显闭环。

Claude Code 不应复用 Codex JSON-RPC transport。下一阶段应只抽象 provider-neutral 的
backend registry、托管目录、session 生命周期、attempt fencing、terminal/cancel 语义
和持久化标识；Codex 保留 app-server NDJSON，Claude 保留其 SDK/CLI stream-json 与
transcript 路径。当前 `ExecutionBackend` 事件和 `backend_sessions.thread_id/active_turn_id`
仍带 Codex 语义，在引入 Claude 前需要完成这层重命名与 capability 拆分。当前单个
`CODEX_HOME/config.toml` 还精确绑定唯一 workspace；多 session/workspace 不能只增加一张
路由表，必须同时拆分配置与 runtime layout 的所有权。
