# Codex app-server 执行后端

本文定义 daemon 内置 Codex 执行后端的配置、状态所有权、运行目录和上线门禁。
它不改变 LiViS wire 协议边界，也不把 Codex 伪装成 Hermes connector。

Codex 当前是显式选择的实验后端；默认执行后端仍是 Hermes。配置枚举固定为
`hermes | codex | claude` 且一套 daemon 同时只选一个。Claude Code 尚未实现；选择
`claude` 时 `doctor`/`serve` 失败关闭，不得通过复用 Codex 配置、Hermes socket 或
手工改数据库来接入。

## 支持范围

- Codex CLI 只审核 `[0.145.0, 0.146.0)`；当前窗口实际只放行 `0.145.x`。
- 生产 backend 只支持专用 `CODEX_HOME` 中 `account/read.account.type=apiKey`。启动、恢复和
  每次 dispatch 都会回读账号；dispatch 还会在 `turn/start` 前与内存及 SQLite 锚点交叉
  检查。协议层仍能识别 `chatgpt` 与 `amazonBedrock` 以安全拒绝，但 OAuth/ChatGPT、
  Bedrock、空账号、未知类型和运行中认证模式漂移都不会进入后续 permission profile、thread
  或 turn RPC。
- Codex model provider 只能是默认 OpenAI，或由操作者显式配置的单个 custom Responses
  endpoint。custom endpoint 会接收 API key、prompt、会话上下文和工具结果，属于独立的
  凭据与数据出口；没有复合确认时失败关闭。
- custom provider 首期只允许 HTTPS `baseUrl` 和固定 Responses wire；禁止 URL userinfo、
  query、fragment、`env_key`、`experimental_bearer_token`、static/env headers、query 参数和
  command-backed auth，provider 内部 request/SSE retry 固定为 `0`。
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
    "toolchainReadRoots": [],
    "model": null,
    "provider": {
      "type": "openai"
    },
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

`toolchainReadRoots` 为空时只提供 permission profile 的最小系统工具。完整编码态若要让
shell 通过 PATH 发现 Bun、uv 等外部工具，必须把已经审核、只含工具链的绝对目录逐项加入
该数组，例如 macOS Homebrew 的 `"/opt/homebrew/bin"`。daemon 会 canonicalize、去重、
固定目录 inode、加入 app-server PATH，并在 filesystem profile 中只授予 `read`；这些目录
不会成为 writable root。不得填写 `/`、state directory、用户 HOME、项目集合目录或任何
含凭据/业务数据的宽泛路径。工具升级或目录身份变化后必须停服、使用全新 state directory
重新验收，不能在既有持久 thread 上静默漂移。

默认 OpenAI provider 必须精确写成 `{ "type": "openai" }`，不接受额外字段。显式
custom provider 必须同时指定模型、HTTPS `baseUrl` 与复合确认：

```json
{
  "execution": {
    "backend": "codex"
  },
  "codex": {
    "command": "/绝对路径/codex",
    "toolchainReadRoots": ["/绝对/只读/工具链/bin"],
    "model": "已审核的模型 ID",
    "provider": {
      "type": "custom",
      "baseUrl": "https://provider.example.invalid/v1",
      "acknowledgeApiKeyTransmission": true
    },
    "requestTimeoutMs": 30000,
    "turnTimeoutMs": 900000,
    "interruptGraceMs": 5000,
    "shutdownTimeoutMs": 5000,
    "acknowledgeRemoteExecution": true
  }
}
```

尽管字段名只提到 API key，`acknowledgeApiKeyTransmission=true` 在当前 schema 中表示操作者
同时确认“API key、prompt、会话上下文和工具结果都会发送到该 custom endpoint”。它不表示
项目替该端点背书，也不允许增加第二套 header、query 或命令认证。字段命名应在配置 API
稳定前再次评审；当前不接受别名或省略确认。

custom provider 的 daemon 固定配置必须生成并精确读回以下规范性字段；`base_url` 只能来自
已校验的 relay config，API key 仍由专用 `CODEX_HOME` 的 `login --with-api-key` 管理：

```toml
forced_login_method = "api"
model_provider = "livis-custom-responses"

[model_providers.livis-custom-responses]
base_url = "https://provider.example.invalid/v1"
wire_api = "responses"
requires_openai_auth = true
request_max_retries = 0
stream_max_retries = 0
supports_websockets = false
```

`forced_login_method="api"` 只固定 CLI 登录方式，不能替代运行态
`account/read.account.type=apiKey`；两项必须同时通过。上述 custom provider 字段已有官方
[custom model provider](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers)
与 [config reference](https://learn.chatgpt.com/docs/config-file/config-reference#configtoml)
依据。精确提交 `56a1d77` 已在固定 Codex `0.145.0` 上取得无秘密 `--strict-config` 和
隔离 API-key 的真实 custom single-turn 回执；该结论绑定当前 endpoint/model/platform，
任何一项变化都必须重跑，且不能据此宣称完整生产上线。

`codex.command` 必须是绝对路径。daemon 启动前会解析其 canonical executable，并拒绝
位于 state directory 内的命令；最终文件必须由当前 daemon 用户或 root 持有、不可被
group/other 写入、`nlink=1` 且可执行。它通过
`lstat → open(O_NOFOLLOW) → fstat → 流式 SHA-256 → fstat/lstat` 固定 path、dev/ino、
权限、owner、link count、长度、mtime/ctime 和完整内容摘要，并在版本探针后、spawn 前、
安全回读后与 idle recovery 重验。生产 session 的安全摘要同时绑定固定安全 config 与
command identity；同版本替换、原地修改、换 inode 或 hardlink 后再删除都不能靠版本
字符串绕过，重启时在再次执行 command 前就会 quarantine。

传给子进程的 `PATH` 同时会过滤空项、相对项和位于 state directory 内的目录，避免
launchd/systemd 的环境差异或不可信目录改变实际执行文件。`doctor` 会复用同一套
runtime layout、command fd/hash、私有环境、有界输出与超时门禁检查所选后端和版本窗，
但不会替代私有账号登录、app-server thread 安全回读或真实消息闭环。最后一次 identity
复核到 pathname `exec` 仍不是内核原子 CAS；同一 OS 用户的外部并发改写不在远端任务
sandbox 的强保证内，生产可进一步使用 root-owned/只读安装或独立服务身份。

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

provider 选择、custom `baseUrl`、固定 retry 与 Codex command identity 都进入安全配置摘要；
API key 本身不进入摘要，且 Codex `account/read` 只提供 type-only 身份强度，无法区分两把
API key。因此同一 `stateDir` 既不能切换 provider，也不能轮换 key。合法变更必须停止旧
daemon，保留旧状态证据，并用全新 `stateDir`、专用 `CODEX_HOME`、数据库和 workspace
重新初始化；`session release` 不会把旧 job 绑定改成新的 Codex 子 provider。

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

不传 `--config` 时入口不会读取 relay config；即使传入配置，它也不会打开或迁移
`relay.db`、不会复用 `~/.codex`，也绝不发送 `turn/start`。配置中的 provider、model 与
`toolchainReadRoots` 会进入本次 smoke 的安全边界。入口会先把空 thread 物化，再由第二个
真实 app-server 恢复同一 ID；
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
子进程看不到 `CODEX_HOME`、`OPENAI_*`、`LIVIS_*`。同一轮还会先证明 workspace 内
普通 hardlink 可以创建，再在 workspace 外的 app-server `host-home` 用随机文件名、
`O_EXCL|O_NOFOLLOW` 创建同卷、无秘密的 0700 牺牲文件，要求它不能被 link 进 workspace，
源文件 dev/ino/nlink 保持稳定且所有自有目录项按身份清理。真实 Codex command 不参与
`/bin/ln` 探针，只在探针后重新核对完整 identity，避免一次失败或进程崩溃留下 executable
的可写别名。

网络探针使用 host 侧原始 TCP listener/connect 正向 control；sandbox 内再用 macOS 系统
`/usr/bin/nc -4 -n -O -G 1 -v -z` 对同一 endpoint 执行 old-style `connect()`。只有退出码
精确为 1、stdout 只有 `error = 0 1|13`、stderr 只有目标 host/port 对应的
`Operation not permitted`/`Permission denied`，并在额外 250 ms 等待后 listener 仍只有
一次宿主正向连接，才裁决工具网络权限被拒绝。普通超时、`ECONNREFUSED`、其他 errno、
stdout/stderr 多余内容、目标不匹配、`nc -O` 不可用或真实/延迟 TCP 命中全部失败关闭。
该方案不需要扩大 filesystem profile 去读取系统 Perl runtime；Linux 和非 Apple `nc`
不能复用本回执。

只有输出同时包含 `workspaceHardlinkControlPassed=true`、
`externalFileHardlinkDenied=true`、`externalFileIdentityStable=true`、
`commandIdentityStable=true`、`loopbackEndpointReachable=true`、
`systemNcProbeAvailable=true` 与 `toolNetworkPermissionDenied=true`，hardlink/工具网络
负向结论才成立。workspace 与外部牺牲文件若不在同一文件系统，或目标平台没有
`/bin/ln`、兼容的 `/usr/bin/nc -O`，入口会按“无法裁决”失败，不会把 `EXDEV`、普通超时
或命令缺失当成 sandbox 通过。
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
ephemeral thread。允许 `account=null` 只服务于这个不进入生产 backend 的零模型协议诊断；
此时 `backendStartReady=false`。显式 state 若读到非空且非 `apiKey` 的账号，会在创建
thread 前失败关闭。

首次使用时，在本机可信终端为专用目录登录；不要从 LiViS 消息触发登录，也不要把
API key 写入 argv、配置文件或 shell history。以下示例使用默认 state directory：

```bash
STATE_DIR="$HOME/.livis-relay"
CODEX_HOME="$STATE_DIR/backends/codex/home"

test -d "$STATE_DIR" && ! test -L "$STATE_DIR"
test "$(cd "$STATE_DIR" && pwd -P)" = "$STATE_DIR"
test "$(stat -f '%Lp' "$STATE_DIR")" = 700
install -d -m 0700 "$CODEX_HOME"

env CODEX_HOME="$CODEX_HOME" /绝对路径/codex \
  -c 'cli_auth_credentials_store="file"' login --with-api-key
```

Linux 应使用等价的 `stat -c '%a'` 检查。上述命令启动后只从标准输入接收 API key；不要把
key 放入 argv、环境变量、配置文本或 shell history。
首次登录必须显式固定 `file`，后续 daemon 安全配置也会固定同一值，保证认证数据落在
专用 `$CODEX_HOME/auth.json`，不复用系统 credential store。不要复制、symlink 或 hardlink
用户日常的 `auth.json`。`codex login status` 在部分认证模式下会显示 API key 的掩码片段，
不得采集到 CI、工单或共享日志；daemon 会通过 app-server 的脱敏 `account/read` 在启动时
验证账号。登录命令只负责专用 Codex 账号，daemon 首次启动仍会生成并固定自己的
`config.toml`。如果该文件已由其他工具生成或被改写，daemon 会拒绝启动；不得为了启动
而放宽或覆盖安全配置。

`account/read.requiresOpenaiAuth` 表示当前 provider 是否依赖 OpenAI 认证，不是“账号仍未
登录”或认证模式。Codex 0.145.0 对 API key 账号会正常返回 `true`；生产 daemon 只接受
精确 `account.type=apiKey`，`account=null`、`chatgpt` 与 `amazonBedrock` 无论该布尔值为何
都会在创建或恢复 thread 前失败关闭；每次 dispatch 还会在 `turn/start` 前重新回读并拒绝
运行中认证模式漂移。API key 是否仍有效继续由获授权真实 turn 裁决。

退出账号前先停止 daemon，确认 app-server 子进程和可能的工具子进程均已退出，再用
同一个专用 `CODEX_HOME` 执行本地 `codex logout`。LiViS `logout` 与 Codex logout
是两条独立的认证生命周期。

provider 或 API key 变更不得在这个目录原地完成。旧 key 的本地 logout 与 provider 侧
revoke 是两步独立操作；只有外部 provider 明确确认撤销，才能声称旧 key 已失效。新 key
必须登录到全新 state directory 的专用 `CODEX_HOME`，不能复制、symlink 或 hardlink 旧
`auth.json`。

## app-server 安全边界

daemon 为 app-server 固定以下边界，并在 `thread/start` 或 `thread/resume` 返回后
逐项读回：

- `approvalPolicy=never`，且 client 对任何新旧 approval request 默认拒绝；
- active permission profile 必须为 `livis-remote`；
- sandbox 必须为 `workspaceWrite`，`runtimeWorkspaceRoots` 必须恰好是上述 workspace，
  且 `sandbox.writableRoots` 不得追加任何额外写根；
- 自定义 filesystem profile 固定为 `:root=deny`、`:minimal=read`、
  `:workspace_roots=write`，并只对 `toolchainReadRoots` 中逐项审核的目录增加 `read`。
  其中 `:minimal` 只为 shell、动态库和系统运行时保留平台基线，不等于绝对的
  workspace-only 读取；
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

JobStore schema v4 新增可变的 `backend_sessions`；schema v5 在 job 首次入库时持久化
`target_backend`，schema v6 继续持久化 Codex 账号类型、账号 subject 摘要与身份强度、
请求/实际 model、model provider、安全配置 SHA、feature 快照 SHA 和稳定 thread-tail
checkpoint。当前 schema v7 以 SQLite trigger 强制 `jobs.target_backend` 不可变，并新增
`execution_attempt_events` append-only 账本。状态职责为：

- `jobs/outbox` 是状态裁决与结果投递真源；
- `backend_sessions` 是可变的当前 thread、active attempt 和 recovery anchor；terminal 或
  人工 release 后它可以更新，不能当作永久审计记录；
- `execution_attempt_events` 是 job → backend session → provider operation 的永久历史。
  Codex 把 thread/turn 写入 provider session/operation，Hermes connector v1 没有等价的
  provider-native ID 时允许为空。账本还保存 lease/execution、runtime、model、account、
  安全配置与 feature 摘要；UPDATE/DELETE 均由 trigger 拒绝。

账本事件固定为 `reserved`、`accepted`、`not_sent`、`cancelled_not_sent`、`succeeded`、
`failed`、`cancel_unknown`、`interrupted` 与 `legacy_active_imported`。事件只记录已在同一
SQLite 事务中稳定提交的事实，不参与自动重放或替代 job 状态裁决。v6→v7 迁移会把当时
可证明的 active attempt 作为 `legacy_active_imported` 导入，但不重建不存在的早期事件。

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

配置切换不会改写既有 job。`serve` 在启动 app-server 或 Relay 前检查全部非终态 backlog；
若存在不属于当前 backend 的 `Received/Acked/Dispatching/Running/Cancelling` job，则拒绝
启动并要求先切回原 backend 排空。`status.backendBacklog` 显示各 backend 非终态计数，
`recentJobs[].latestAttempt` 显示最近账本事件；`doctor` 的
`execution_backend_backlog` 对异 backend 非终态积压失败。终态历史不会阻止切换，未完成
的 outbox 投递也不要求重新调用原 provider。

这里的持久 job 只通过 `jobs.target_backend=codex` 绑定执行 backend，当前 schema 没有把
OpenAI/custom 子 provider 直接写入 job 行。`backend_sessions` 与 attempt ledger 虽会保存
实际 `model_provider` 和安全摘要，也不足以证明尚未派发的旧 Codex backlog 可以跨 provider
执行。因此同一 `stateDir` 禁止切换 Codex 子 provider；后续若要支持，必须先让 job 在入库
时绑定子 provider，并设计迁移、积压、回滚与 outbox 语义。

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

## 取消、崩溃、idle 自动恢复与人工 release

`turn/interrupt` 返回成功只证明 app-server 接受了中断请求，不能证明已经启动的工具
副作用停止。对已提交 turn 的取消会进入 `CancelUnknown`，并把 backend session 标成
`recovery_required`、保留 active job/lease/generation/turn 证据和 session quarantine。

`turn/start` 超时或传输终止时，只有 transport 能证明请求尚未写入，daemon 才可撤销
attempt；只要可能写入，就按 ambiguous execution 进入 `Interrupted`/quarantine，绝不
自动重发。daemon 重启、事件处理失败或活动 turn 期间 app-server 意外退出/停止服务
也采用同一失败关闭原则，必须保留证据并走人工 release；idle 自动恢复不适用于这些
存在或可能存在 turn 的情形。

`turnTimeoutMs` 从发送 `turn/start` 前开始计算完整 turn 的绝对时限；超时后只允许
deadline 或用户 cancel 中的一个 interruption owner 发出一次 `turn/interrupt`，并在
`interruptGraceMs` 后失败关闭。`turn/interrupt` 的 RPC response 不是 terminal 真源；
用户取消仍须等待权威 `turn/completed`，先以 active fence checkpoint 实际
completed/failed/interrupted 尾部，再进入 `CancelUnknown`。deadline 后到达的任何
terminal 或取消回执一律不生成 result/outbox。

Codex 0.145.0 的实测行为是在 provider 失败后把权威 `turn/completed` 标为 `failed`，同时让
`thread/read.status.type` 保持为 `systemError`；其 legacy history 投影还会把同一 failed
tail 错写成 `completed`，下一次 `turn/start` 才清除该 thread 状态。例外版本 allowlist
只含精确 `0.145.0`。daemon 只在当前 client 实际收到 failed terminal，且 thread ID、
turn ID、`systemError`、legacy completed tail、rollout 和 active fence 全部精确一致时，
才把 tail 的业务语义归一化为 failed、结算 `Failed`；raw turns status 不改写，checkpoint
hash 仍绑定原始 readback。同一 app-server client epoch 中的下一次 dispatch 还必须持有
该 terminal 建立的内存 marker，并与 SQLite checkpoint、legacy 投影标志和当前 raw
ID/status/count/hash 完全一致；marker 不跨 client/recovery 持久化。
fresh start、daemon 重启和 idle recovery 仍要求严格 `idle`。`completed/interrupted`
terminal 配 `systemError`、不同 turn、未记录 tail、后来无关的 `systemError`、窗口外版本
或任一漂移继续按执行不确定失败关闭。

`TurnError.message`、`additionalDetails`、JSON-RPC error 的 `message/data` 与 app-server stderr
都可能带 API key 掩码片段或账号信息，不得进入 JobStore、Relay 或共享日志。stderr 只保留
在 client 的有界专用诊断缓冲；公开 RPC/transport error 仅保留内部 method、数值 code/exit
code 和固定分类。daemon 只持久化白名单错误分类；
明确的 `401 invalid_api_key`/`unauthorized` 会在同一 SQLite 事务中提交 `Failed`、failed
ledger、通用失败 outbox、active clear 与固定原因 quarantine，事务提交后再关闭 backend，
防止崩溃窗口或排队 job 继续使用已被拒绝的凭据。修复专用凭据后必须人工 release 旧
session，禁止自动重发原 job；进程组关闭失败仍会被 `stop()` 向上报告。

app-server 作为独立 POSIX 进程组 leader 启动，关闭按
`SIGTERM → 有界等待 → SIGKILL → 有界收口回执` 执行，并同时等待直接 child、stdio 与
进程组消失；无法确认时不会静默报告 stop 成功。

app-server 在 `running` 状态意外退出时，只有以下 fence 全部成立才进入 idle 自动恢复：

- 内存中没有 active attempt，SQLite 也没有 active job/lease/run generation/turn；
- backend session 没有 `recovery_required`，session 没有 quarantine；
- 已绑定 runtime/thread/recovery anchor 完整，SQLite 中的 thread ID 未变，且当前 Store
  anchor 与 daemon 最后一次 anchor 完全一致。

恢复预算按 daemon 生命周期累计，而不是按单次崩溃重新计算：第 1、2、3 次候选前分别
固定等待 `250 ms`、`1000 ms`、`5000 ms`，成功恢复也不会返还已消耗次数。首个候选启动
前必须确认退出的旧进程组已经关闭；某个候选失败时，也必须确认它的进程组、child 与
stdio 已收口后才可进入下一次退避。任一关闭无法确认都会 quarantine 并失败关闭。

每次候选会重新校验 CLI/runtime layout、账号身份、请求/实际 model、model provider、
安全配置和 feature snapshot 等 immutable metadata，并在每个关键阶段重查同一个 Store
anchor。针对 thread 的恢复链只允许：

```text
thread/resume（SQLite 已绑定的同一 thread ID）
→ thread/read(includeTurns=true)
→ 校验 rollout + checkpoint + thread tail
→ 发布同一 executionId ready
```

idle recovery 禁止 `thread/start`、`thread/memoryMode/set`、任何 `turn/start` 或自动重放
job。immutable metadata、Store anchor、rollout、checkpoint 或 tail 任一漂移都会立即
quarantine 且不再重试；只有没有漂移证据的瞬时启动/传输失败才会使用剩余预算。三次
预算耗尽后 backend 失败关闭。daemon `stop()` 会取消尚未到期的退避，并等待在途
recovery、disconnect、候选/当前 app-server close 与事件链；任何进程组收口失败都会
传播给调用方，不能把 stop 返回理解为尽力而为。

因此，下面的人工恢复顺序只用于 active turn 不确定、command/security binding、
metadata/checkpoint/tail 漂移、quarantine、关闭无法确认或恢复预算耗尽；满足 fence 且
已自动恢复成功的 idle 退出不应执行 `session release`。

恢复顺序固定为：

1. 停止 daemon，并确认旧 `codex app-server` 和它启动的所有工具子进程均已退出；
2. 保留日志、`status` 和数据库作为证据，判断外部副作用是否需要人工处置；
3. 从 `status` 读回稳定 `sessionKey`；
4. 完整备份 `relay.db`、WAL/SHM（若存在），并保留旧 `CODEX_HOME` rollout；
5. 执行 `bun run src/index.ts session release '<sessionKey>'`；命令会先在 connector socket
   的 canonical 路径取得 daemon offline guard，固定同一 canonical state directory 打开
   SQLite，再由同一事务退役存在 recovery 的 backend session，或没有 active/recovery 证据
   但已 quarantine 的 idle session；同一 session 下任何 backend 仍有未进入 recovery 的
   active evidence，或 recovery 锚点与 job 的 session/backend/lease/generation 不一致时拒绝释放；
6. 重新执行 `doctor --online`，确认无 quarantine 后再启动 daemon，并读回实际新建或恢复的
   thread；只有回执为 `codexBackendSessionRetired=true`，或已另行确认原本没有 Codex row，
   才能在后续启动成功到达 thread 物化阶段时预期新建 Codex thread。

`session release` 根据 JobStore 中所有 backend 的历史恢复证据执行，不依赖当前选择的
执行后端。因此，从 Codex 切回 Hermes 后仍可释放先前留下的 Codex quarantine，反之
亦然。对存在 recovery 的 Codex session，或 command/security 漂移后被隔离且没有
active/recovery 证据的 idle session，它会删除数据库中的旧 backend session 绑定；存在
尚不可释放的 recovery，或任何 backend 仍有未进入 recovery 的 active evidence 时都失败
关闭。该操作不会删除旧 rollout、workspace、
job/outbox，也不会撤销文件、命令或外部系统副作用。它只重置事务实际退役的 backend row；
`codexBackendSessionRetired=true` 只证明旧 Codex 数据库绑定已删除。后续 Codex 若成功到达
thread 物化阶段，将不能复用该绑定，必须按当时 command、账号、模型和安全配置创建并绑定
新 thread；release 不证明下一次启动本身会成功。JSON 中的
`retiredBackendSessions` 来自退役事务本身；`codexBackendSessionRetired=true` 才表示旧
Codex 数据库绑定确实被删除。`releasedQuarantineWithoutBackendSession=true` 表示只释放了
尚无 backend row 的 quarantine，不得据此宣称 ambiguous `thread/start` 的外部副作用已
撤销，也不再输出不精确的 `nextStartCreatesNewThread` 推断。事务提交后的第二次 guard
校验、guard 删除和 stdout 写出不属于 SQLite 事务；若这些收口步骤失败，命令可能已完成
数据库退役但没有 JSON 回执，操作者必须保留错误、重新只读检查数据库与 `status`，不得
盲目重试或根据空 stdout 推断“没有改变”。

`session release` 只退役可证明可释放的 backend session row，不修改
`jobs.target_backend`，也不提供 API-key identity。它不得用于 OpenAI/custom 切换、custom
endpoint 变更或 key 轮换；这些操作一律新建 `stateDir`。

## 当前上线门禁

当前实现、fake 回归与 2026-07-23 的 fresh 真实回执确认：只有显式选择 `local`
environment 后，approval、permission profile、workspace-only writable roots、无工具网络
以及 `/tmp` 隔离才会同时命中预期；空 environment 数组会退化为 `readOnly`。真实回执还
闭合了 hardlink、command identity 与系统 `nc -O` 精确 errno 组合门禁，但只覆盖当前
macOS/Codex 0.145.0/config 组合。

2026-07-22 的旧 profile 真实命令 canary 曾确认 agent 可读取专用 `CODEX_HOME`；只剥离
环境变量不足以保护凭据。加入 `:root=deny`、`:minimal=read` 与 workspace write
carveout 后，当时的 Codex 0.145.0 候选曾在 macOS 非临时、可丢弃私有目录通过：workspace
和 agent HOME/TMPDIR 可读写，专用 `CODEX_HOME` 与宿主 HOME/TMPDIR 读写被拒绝，且
`CODEX_HOME`、`OPENAI_*`、`LIVIS_*` 未进入 sandbox 子进程环境。该历史回执本身不足以
证明当前增强 canary；当前 fresh 回执见下文，两者都不可外推到 Linux 或未来 Codex 版本。

macOS 的 `:minimal` 会为系统运行时开放一组平台路径，并包含 `/tmp`、`/private/tmp`、
`/var/tmp`。所以协议 smoke 可以使用系统临时目录，但凭据/读取隔离 canary 和生产
`CODEX_HOME` 绝不能放在这些目录；必须使用不在 minimal 基线中的私有持久目录。Linux
也必须按目标版本重新核对平台基线，不能把 macOS 回执直接复用。

因此当前实现与真实回执已经覆盖“空账号协议接线、读取隔离、hardlink/command/TCP
组合门禁、零 turn 恢复、高风险 feature 冻结，以及一次隔离 API-key/custom provider
成功 turn”，但整体仍只能作为受控开发功能，不能宣称生产上线。继续集成至少还要：

- 用本地 fake Responses endpoint 截获工具定义，确认只有已审核的 core/workspace 工具；
- 在 Linux、未来 Codex 版本和 filesystem profile 变更后重跑牺牲文件 hardlink、原始
  TCP errno 与 command identity canary；当前系统 `nc -O` 回执只覆盖 macOS/Codex 0.145.0；
- 在真实 Codex 进程上分别验证 idle app-server kill 按固定预算恢复，以及 active turn kill
  和 daemon restart 进入预期 quarantine、release 前不派发；
- 用 endpoint 侧脱敏计数独立确认 Responses HTTP 请求数与重试行为；当前固定 retry=0、
  单一 provider operation 和单次 dispatch 不能证明 provider 内部只收到一个 HTTP 请求；
- 在请求层移除或 allowlist 工具 schema；当前只证明该成功 turn 实际产生零工具/审批事件，
  不能把提示词、workspace 不变和沙箱约束表述为硬 `tool_choice=none`；
- 在最终发布 head 重跑[完整 LiViS 人在环 canary](CODEX-E2E-CANARY.md)，并补齐异常恢复、
  长期运行与 IDaaS revoke 2xx 的凭据收口证据。

### 2026-07-22 至 2026-07-23 本机验证回执

当前本地 worktree 在更新 `origin` 引用后仍基于最新 `origin/main`，未执行 merge、rebase、
push 或创建 PR。本轮在允许监听 loopback TCP 与 Unix socket 的本机环境执行：

```bash
bun run check
bun run smoke:codex:app-server -- --command /opt/homebrew/bin/codex
bun run smoke:codex:app-server -- \
  --command /opt/homebrew/bin/codex \
  --create-state-dir /绝对/非临时/私有/canary/path \
  --verify-read-isolation
```

`bun run check` 通过 389 个 Bun 测试和 22 个 Hermes pytest。本轮真实 Codex 0.145.0
零模型 turn smoke 得到 `sentModelTurn=false`、`zeroTurnMaterialized=true` 和
`zeroTurnResumeVerified=true`；最终 fresh 非临时 canary 的全部读取隔离、hardlink、command
identity 与网络 required fields 均为 true，其中系统 `nc -O` 对已监听 loopback 返回精确
`EPERM=1`，listener 没有第二次 accept，`systemNcProbeAvailable=true` 且
`toolNetworkPermissionDenied=true`。真实 command 内容 SHA-256 与 identity SHA-256 也由
同一 JSON 回执给出，但不写入仓库。

此前 Perl/Socket 方案因 sandbox 无法读取系统 `libperl.dylib` 而以 exit 134 失败关闭；
改用不需要额外 runtime carveout 的系统 `nc` 后，第一次解析又因真实数值 errno 位于 stdout、
人类错误位于 stderr 而失败关闭。按真实分流收紧解析后，才在全新目录取得上述完整回执。
三次可丢弃目录均在核对专用 marker 后清理，旧安全配置目录未被复用或覆盖。

随后一次获授权、提示不使用工具的单 turn canary 已取得 app-server `turn/start` 提交回执和
provider turn ID。为这次
例外测试，经用户明确授权，把日常 `~/.codex/auth.json` 复制为隔离 `CODEX_HOME` 中权限
`0600`、单链接的临时普通文件；它不是按本 runbook 完成的专用登录凭据，不能作为生产做法。
Responses API 以 `401 invalid_api_key` 拒绝该临时副本；rollout 没有 assistant message，
也没有 token-count 记录。该调用确实发出；harness/daemon 没有再次 dispatch，provider
内部 HTTP retry 未在该回执中评估。它只暴露 provider 错误终态与
该副本的凭据有效性缺口，不能证明专用登录凭据状态，也不能替代成功模型 turn 或 LiViS
回显验收。

在提交 `e71363f` 上对同一隔离凭据做的一次性复核仍只发送了一个 turn，并再次得到 provider
的 `401 invalid_api_key` task-complete；但 0.145.0 legacy `thread/read` 把权威 failed tail
投影成 completed，导致当时 backend 按漂移失败关闭，最终保留 `Interrupted`、三条
`reserved/accepted/interrupted` ledger、active recovery 锚点、单条 quarantine 和零 outbox。
rollout 同时确认没有 assistant、没有工具记录且没有 token-count 记录。该结果不是成功
模型 turn，也不是预期凭据拒绝事务的通过证明；harness/daemon 未再次 dispatch，未评估
provider 内部 HTTP retry，也没有 release 或清理，私有证据目录保持原样。当前本地修复
只对精确 0.145.0 的“同一 failed 通知 + 同一 turn + systemError + legacy completed tail”
做窄语义归一化，并继续以 raw turns hash 检测漂移；fake 回归已通过。

该轮证据目录 `.livis-relay-real-canary-20260723-e71363f-r2` 必须永久按只读证据处理：不得
复用为新 canary、不得 `session release`、不得改库或清理。

提交 `65f00c1` 上又以全新固定目录完成一次获授权、提示不使用工具的单 turn canary。该轮误把
本机非默认凭据副本复制为隔离 `CODEX_HOME/auth.json`；app-server 与 SQLite 运行态均将其
识别为 `account_type=chatgpt`，不是用户确认的 API-key 路径。源文件前后未变化，副本为
`0600`、单链接普通文件。provider 返回 structured
`unauthorized`，rollout 没有 assistant、工具或 token-count 记录。修复后的 backend 在同一
事务把 job 收口为 `Failed`、outbox `Pending`、ledger
`reserved → accepted → failed`、checkpoint `failed/1`、active 全清、
`recovery_required=false` 和一条凭据 quarantine；SQLite integrity/foreign key 与敏感模式
扫描均通过。canary 顶层仍为 `ok=false`：harness 只接受上一轮写死的
`401 invalid_api_key` 文案，而本轮持久化的是更窄的脱敏 `Codex provider 认证失败`；报告
生成瞬间的 `lsof` 也无法裁决。报告已确认独立进程组关闭，事后同路径 `lsof` 为零，但不能
倒推报告瞬间已有零句柄证据。本轮因此只是通用失败结算修复的 `FIX_GO_ONLY`，不是受支持的
API-key 凭据 canary 或成功模型 turn；当前生产门禁会在 thread 前拒绝同类账号。它也不能
证明专用登录凭据有效或 LiViS 回显。`Pending` outbox 只是通用失败结果等待 Relay
投递，不表示模型任务仍在运行；`recovery_required=false` 只表示没有遗留不明确的 active
turn，session quarantine 仍会阻止自动重试，不能据此视为 backend ready。

该轮证据目录 `.livis-relay-real-canary-20260723-65f00c1-r3` 同样不得复用、release、改库或
清理。后续任何真实 canary 都必须使用全新 `stateDir` 与独立 `CODEX_HOME`；不得复用日常
凭据、历史证据目录或旧 `auth.json`。

随后在精确提交 `56a1d77` 上创建全新 r4 state，用标准输入把默认本机凭据中的 API key
登录到隔离 `CODEX_HOME`，没有复制默认 `auth.json`，也没有加载默认 config 中的自由 bearer
token。固定 custom provider/model 的生产 backend 只 dispatch 一个固定短答 job，并取得
如下脱敏结果：

- `accountType=apiKey`、`modelProvider=livis-custom-responses`，请求与实际模型精确一致；
- terminal fixed reply 匹配，job `Succeeded`、outbox `Pending`、ledger
  `reserved → accepted → succeeded`、checkpoint `completed/1`；
- active 四字段清空、`recovery_required=false`、quarantine 为零；
- rollout 只有一条 assistant、零工具、零未知 item、一个 `task_started/task_complete`，
  workspace 前后不变；
- SQLite schema v7、integrity、foreign key 和通用敏感模式扫描通过，临时 API-key 文件删除后，
  其余普通文件对该 key 的精确扫描为零命中；
- 默认生产 spawn 的独立进程组已确认关闭。报告瞬间 `lsof` 无法裁决，令 harness 顶层
  `ok=false`；事后相同参数确认零句柄，没有重发 turn，故业务功能结论为 GO、瞬时 lsof
  回执为 `FIX_GO_ONLY`。

脱敏复核后整个可丢弃 r4 state 已清理；r2/r3 只读证据仍原样保留。该成功回执没有 endpoint
侧请求计数，故只证明一次 daemon dispatch 和单一 provider operation，不证明内部 HTTP
请求精确一次；它也只证明本轮实际零工具，不证明请求层未携带工具 schema，更没有经过
LiViS Relay 的 `Delivered → App 回显`。

#### 2026-07-23 LiViS 完整人在环 canary

随后在精确提交 `896091b` 上使用全新隔离 state 完成了 App → Relay → daemon → Codex
app-server/custom Responses → durable outbox → App 的完整人在环测试。隔离 state 只复制经
profile 前缀校验的 identity、在内存继承唯一 node allowlist，并生成 fresh secrets；没有复制
生产 refresh token、数据库、proof 或日常 Codex `auth.json`。旧 schema v1 profile 只在隔离
state 中迁移到 v2，fresh Device Flow 与 stdin API-key 登录分别建立两套独立凭据。

获授权用户本人从唯一允许设备只发送一次随机 nonce 作为规范 canary：

- 发送前 Relay handshake、`accountType=apiKey`、custom provider、固定模型、checkpoint 0、
  active/recovery/quarantine 全部通过；
- 唯一 nonce job 为 `Succeeded/Delivered`、`run_generation=1`，ledger 精确为
  `reserved → accepted → succeeded`，只有一个 provider operation 和一次 outbox delivery
  attempt，checkpoint 为 `completed/1`；
- App 人工确认只出现一个正文精确匹配的回复气泡；`Delivered` 与视觉确认分别留证，未互相
  替代；
- 用户随后主动追加两条扩展消息；最终一个 rollout 含三轮和三条 assistant message，三条
  job 各自 `Succeeded/Delivered`，实际 tool、approval、user-input request 与 unknown item
  均为 0；这些消息不是 Relay 重复投递，也不扩写成三次规范 canary；
- daemon 优雅停止后 connector socket 消失、state 零打开句柄；原 Relay 与专用 Hermes
  Gateway 已恢复并排空队列，零 quarantine、零未投递结果。

功能结论为 `E2E_FUNCTIONAL_GO`。私有脱敏回执 ID 是
`codex-e2e-20260723-93b4d1e292d6881e`，公开记录不含 endpoint、token、Agent/node ID、
profile SHA 或消息正文。收口结论独立为 `CREDENTIAL_CLEANUP_BLOCKED`：隔离 Codex 已本地
logout 且临时 `auth.json` 已删除，但 LiViS IDaaS 对当前 profile 的 `POST /revoke` 返回
HTTP 404，daemon 按失败关闭规则保留 refresh token。因此该 canary state 不得 release、
手工删 token、复用或清理。完整步骤和失败边界见
[Codex 完整 LiViS 人在环 canary](CODEX-E2E-CANARY.md)。

该回执仍只观察到单一 daemon provider operation，不证明 endpoint 内部 HTTP 请求恰好一次；
三轮零工具 item 也不证明请求 payload 没有工具 schema。它只覆盖本次
macOS/Codex 0.145.0/model/provider/profile 与未知 Relay build，不能外推到 Linux、未来版本、
资源配额、取消、重连或长期运行。

前述零模型 smoke 回执只证明当前 macOS/Codex 0.145.0 组合上的无模型协议、持久化和安全边界。smoke 使用未登录的
可丢弃专用 `CODEX_HOME`，所以 `backendStartReady=false` 是预期结果；它没有验证专用真实
账号、模型 turn、工具最终清单、资源收口或 LiViS App 回显；上述完整 E2E 回执是独立证据，
不能由 smoke 结果反推。

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

- 当前已覆盖完整 turn deadline 和同一 POSIX 进程组的两阶段收口；仍需 CPU、内存、
  PID、磁盘、token/费用配额，以及 Linux cgroup/systemd 对逃逸进程组后代的强制收口；
- 当前已持久化并校验 thread tail/checkpoint，也已有 append-only execution attempt 账本；
  仍需跨进程独占锁，以及账本备份、导出、保留期与外部防篡改策略；
- 当前已分离宿主与 agent HOME/TMPDIR，并绑定 `accountType=apiKey`、model/provider 与安全
  摘要；上游对 API key 只提供 type-only 身份强度，无法区分两把 key。key 轮换仍要求人工
  创建全新 state directory，`session release` 不得用于轮换；后续需要更强的本地可轮换账号
  标识；
- `jobs.target_backend` 当前只绑定 `codex`，尚未绑定 OpenAI/custom 子 provider；这正是
  禁止同一 state directory 切换 provider 的持久化原因，后续需要 job 级 provider fence；
- backend 处于 recovery 退避、恢复预算耗尽或失败关闭时的 Relay admission 策略：当前
  新 job 仍可能持久化并 ACK，需要进一步定义排队、背压与明确拒绝的边界；
- 输入速率、排队深度、token/费用和持久磁盘总量配额；
- session new/list/rotate/archive 与 workspace 生命周期管理；
- 固定空 workspace 中产物的查看、导出或销毁路径；一期 LiViS 只回纯文本 final，不会把
  本地文件交付到 App；
- Codex CLI 升级后旧 session 的兼容检查与迁移路径；
- 专用账号初始化/状态运维、完整 E2E 的可重复准备工具，以及 revoke、异常恢复与长期运行
  收口。

Claude Code 不应复用 Codex JSON-RPC transport。下一阶段应只抽象 provider-neutral 的
backend registry、托管目录、session 生命周期、attempt fencing、terminal/cancel 语义
和持久化标识；Codex 保留 app-server NDJSON，Claude 保留其 SDK/CLI stream-json 与
transcript 路径。当前 `ExecutionBackend` 事件和 `backend_sessions.thread_id/active_turn_id`
仍带 Codex 语义，在引入 Claude 前需要完成这层重命名与 capability 拆分。当前单个
`CODEX_HOME/config.toml` 还精确绑定唯一 workspace；多 session/workspace 不能只增加一张
路由表，必须同时拆分配置与 runtime layout 的所有权。
