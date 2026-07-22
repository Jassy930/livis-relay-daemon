# Codex app-server 执行后端

本文定义 daemon 内置 Codex 执行后端的配置、状态所有权、运行目录和上线门禁。
它不改变 LiViS wire 协议边界，也不把 Codex 伪装成 Hermes connector。

Codex 当前是显式选择的实验后端；默认执行后端仍是 Hermes。Claude Code 尚未实现，
不得通过复用 Codex 配置、Hermes socket 或手工改数据库来接入。

## 支持范围

- Codex CLI 只审核 `[0.145.0, 0.146.0)`；当前窗口实际只放行 `0.145.x`。
- daemon 直接启动 `codex app-server --strict-config --stdio`，同时禁用 plugins、
  remote plugin 和 apps；Codex 不经过 Hermes bridge。
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
                └── workspace/           唯一工具可写根
                    ├── .home/            app-server 子进程的 HOME
                    └── .tmp/             app-server 子进程的 TMPDIR
```

session hash 由本地 scope、backend、稳定 session key 和唯一获准 `node_id` 共同推导；
真实 ID 不直接作为目录名。该 node ID 是 immutable session metadata，在同一 state
directory 中原地换设备会产生 session hash 冲突并拒绝复用旧 thread。daemon 会逐层
创建并读回 `0700` 普通目录，拒绝 symlink、realpath 漂移、inode 替换或安全
`config.toml` 内容漂移。

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
- 新建 thread 与每次 turn 都显式发送 `environments=[]`，禁止选择账号默认环境或沿用
  thread sticky environment；`thread/resume` 协议没有该字段，因此恢复后的每次 turn
  仍必须重新发送空数组；
- 工具网络为关闭状态，`/tmp` 与继承的 `TMPDIR` 不额外放行；
- shell 只继承最小环境，并排除 `CODEX_HOME`、`OPENAI_*` 和 `LIVIS_*`；
- workspace 预先标为 `untrusted`，防止 Codex 在首次 thread 创建时把项目自动追加为
  trusted 并修改 daemon 固定配置。

app-server 的 NDJSON 单行、stderr、notification backlog、agent message 数量、标识和
累计内容均设有硬上限。stdout 在进程退出前 EOF、无法关联有效请求 ID 的已知
server request（包括审批、用户输入、elicitation、动态工具、凭据刷新、attestation 与
时间读取）都会直接关闭 transport，不得降级为可忽略 notification。

这里的“无网络”指 agent 工具执行沙箱不允许网络访问；Codex app-server 自身仍需通过
其认证控制面请求模型。workspace 内容应始终视为远程输入可影响的不可信数据，不应
放置 daemon secret、LiViS token、用户默认 Codex 凭据或其他项目 checkout。

## thread、job 与持久化

JobStore schema v4 新增 `backend_sessions`，持久化 backend、session hash、cwd、
Codex CLI 版本、thread ID，以及当前 job/lease/run generation/turn ID。状态职责为：

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
失败而静默创建替代 thread。CLI 版本、cwd、session hash 或 thread 绑定发生冲突时均
失败关闭。

## 取消、崩溃与人工 release

`turn/interrupt` 返回成功只证明 app-server 接受了中断请求，不能证明已经启动的工具
副作用停止。对已提交 turn 的取消会进入 `CancelUnknown`，并把 backend session 标成
`recovery_required`、保留 active job/lease/generation/turn 证据和 session quarantine。

`turn/start` 超时或传输终止时，只有 transport 能证明请求尚未写入，daemon 才可撤销
attempt；只要可能写入，就按 ambiguous execution 进入 `Interrupted`/quarantine，绝不
自动重发。daemon 重启、app-server 意外退出、事件处理失败或活动 turn 期间停止服务
也采用同一失败关闭原则。

恢复顺序固定为：

1. 停止 daemon，并确认旧 `codex app-server` 和它启动的所有工具子进程均已退出；
2. 保留日志、`status` 和数据库作为证据，判断外部副作用是否需要人工处置；
3. 从 `status` 读回稳定 `sessionKey`；
4. 执行 `bun run src/index.ts session release '<sessionKey>'`；
5. 重新执行 `doctor --online`，确认无 quarantine 后再启动 daemon。

`session release` 根据 JobStore 中所有 backend 的历史恢复证据执行，不依赖当前选择的
执行后端。因此，从 Codex 切回 Hermes 后仍可释放先前留下的 Codex quarantine，反之
亦然。它只清除已经落入终态的 active attempt/recovery 标记和对应 quarantine；不会
撤销文件、命令或外部系统副作用，也不会删除 Codex thread。

## 当前上线门禁

当前实现和真实 `thread/start` 安全回读已经确认 approval、permission profile、
workspace-only writable roots、无工具网络以及 `/tmp` 隔离均命中预期。由于本轮验证
环境本身运行在外层 sandbox 中，无法可靠嵌套 macOS Seatbelt 来完成“诱导 agent 读取
专用 `CODEX_HOME`、LiViS secret、环境变量和 workspace 外 canary 文件”的真实恶意
凭据 canary。

因此 Codex 后端只能作为 Draft PR/受控开发功能，不能宣称生产上线。合并或发布前至少
还需要在代表性 macOS/Linux 主机上完成上述负向 canary，保存脱敏回执，并同时验证：

- workspace 内允许读写，workspace 外读写和工具网络均被拒绝；
- `CODEX_HOME`、`OPENAI_*`、`LIVIS_*` 不可由 agent shell 读取；
- workspace 内创建指向 Codex command 的 hardlink 必须被 sandbox 拒绝，并核对后续
  启动前 command 内容没有漂移；
- cancel、app-server kill 和 daemon restart 都进入预期 quarantine，且 release 前不派发；
- 唯一设备的纯文本 job 只在 terminal 后产生一个 final，并完成
  `Succeeded → Delivered → App 回显`。
