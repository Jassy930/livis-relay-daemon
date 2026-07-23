# 运行手册

以下命令都在项目根目录执行。示例使用默认配置 `~/.livis-relay/config.json`。配置与 state directory 必须位于 Git 仓库之外；CLI 会拒绝把 live profile、token 或数据库初始化到项目树内。

## 1. 安装开发依赖并自检

```bash
bun install --frozen-lockfile
bun run check
```

## 2. 准备获授权的 protocol profile

公开仓库只提供无效占位值的 [`protocol-profiles/livis-authorized.example.json`](../protocol-profiles/livis-authorized.example.json)。从有权管理相关服务的一方取得参数，将 profile 保存到仓库外的私有位置；不要直接使用 example 连接服务。

当前只接受 protocol profile schema v2，并要求 `wireContractRevision=livis-relay-v1-access-refresh-r1` 与 `credentialMode=access-and-refresh-token` 精确匹配代码 registry。两者描述当前仍向 Relay 发送 refresh token 的兼容基线，不代表服务端要求或目标安全策略。

## 3. 初始化

```bash
bun run src/index.ts init \
  --profile '/绝对路径/authorized-profile.json' \
  --acknowledge-unofficial-protocol
```

`init` 会把已审核 LiViS profile 复制到 state directory，并把该文件的 SHA-256 固定到配置。它不会登录、绑定或启动服务。

已有 schema v1 部署必须按[protocol profile v1→v2 迁移 runbook](UPSTREAM-UPGRADE.md#现有部署的-protocol-profile-schema-v1v2-迁移)处理：先确认 connector socket 父目录是 state directory 内的私有非 symlink 目录，再停止 daemon；Hermes 模式还要停止 Gateway，并禁用服务管理器自动拉起。执行零写入 dry-run 后才可显式 apply。命令会保存原 config/profile 和 PREPARED receipt，以 config durable rename 为 apply 唯一提交点，隔离旧/新 supported proof，且不触碰 SQLite。迁移后必须重新执行 `upstream check` 与 `doctor --online` 才能启动；回滚 v1 后必须切回旧 daemon 并重新生成 proof，不得旁路校验。

随后编辑配置：

- 保持 `security.allowAllNodes=false`。
- 将唯一获准且稳定的 LiViS `node_id` 作为 `security.allowedNodeIds` 的唯一元素；不要填写多个值。
- `relay.maxFrameBytes` 控制远端 WebSocket 完整消息的 UTF-8 字节上限；默认 1048576，允许范围为 1 到 16777216。旧配置不含该字段时自动采用默认值。
- `execution.backend` 缺省为 `hermes`，只能取 `hermes | codex | claude`，一套 daemon
  同时只启用一个；不要仅因为配置中存在 `codex` 段就认为已经启用。
- Hermes 模式不扩大 runtime/bridge 审核范围，除非已按升级 runbook 验证。
- Codex 模式必须保持唯一 node allowlist、CLI `[0.145.0, 0.146.0)` 版本窗，并在审阅
  [Codex app-server 执行后端](CODEX-APPSERVER.md)后显式设置
  `codex.acknowledgeRemoteExecution=true`。Claude Code 目前只有配置枚举边界，选择
  `claude` 时 `doctor` 和 `serve` 都会明确失败，不会回退到其他 backend。

一期暂将 `node_id` 视为设备来源标识，一套 daemon、config、state directory 和所选 backend 只支持该一个设备。配置解析器接受数组是格式兼容，不代表支持多设备；Codex 模式还会在代码级拒绝 `allowAllNodes=true` 或非单元素 allowlist，并把唯一 node ID 纳入 immutable session hash。不得通过追加第二个 ID、开启 `allowAllNodes` 或直接替换原 ID 来接入另一设备；原地换设备会拒绝复用旧 Codex thread。设备更换、跨设备会话和旧状态迁移均需另行设计与验收。

## 4. 生成近期 upstream 证明

```bash
bun run src/index.ts upstream check
```

只有输出 `compatibility: "supported"` 且 exit code 为 0，才会生成 active profile 的 supported proof。检查只下载并静态读取 artifact，不执行官方脚本。

CLI、`serve` 启动和 daemon 六小时周期复核都通过 state directory 中同一个
`profile-operation.guard` 写 proof。周期复核若恰逢激活、回滚或其他 proof writer
持锁，proof 尚未过期时会记录并跳过本轮；到达 proof 的绝对 `expiresAt` 后，daemon
会在 admission 与 dispatch 同步关闭门禁，即使 one-shot timer 延迟也不会继续接收、
ACK、claim 或 send。Relay 停止失败不会开放门禁，后续入站、派发或复核会重试停止。

不要为消除“guard 已存在”而删除文件；先确认是否有活跃命令，崩溃遗留 guard 按升级
runbook 的 inode/nonce 流程处理。`serve` 启动失败若同时发生 daemon stop 或 guard
release 错误，日志会按主错误、stop、release 顺序聚合；必须先处理最前面的主错误，
并保留无法安全释放的 guard 作为 fail-closed 证据。

## 5. 登录 LiViS

```bash
bun run src/index.ts login
```

完成 Device Flow 后，refresh token 保存在 daemon state directory。不要把 connector token 或 refresh token 粘贴到聊天、日志和 shell history。

### 安全登出与账号边界

`logout` 只负责向 IDaaS 撤销 refresh token 并在远端返回 2xx 后清除本地副本；它不是运行中 daemon 的控制通道。执行前应确认没有活跃 job 或待投递结果，再停止 `livis-relayd`；Hermes 模式还须先停止专用 Gateway：

```bash
bun run src/index.ts logout
```

只有看到“已撤销并清除本地 refresh token”才表示远端确认成功。网络失败或远端非 2xx 时命令以失败退出，并故意保留本地 token，便于恢复网络后重试；不要为消除错误而手工删除凭据。

一期尚未把 OAuth 账号 subject 与 `identity.json`、SQLite job/outbox 做持久化绑定，因此不支持在同一个 state directory 中直接切换账号。需要使用另一账号时，应使用独立配置和独立 state directory；不得用 `login --force` 覆盖原账号 token 后继续复用旧 outbox。

## 6. 准备执行后端

一套 daemon 只能在 Hermes、Codex、Claude 中选择一个 backend。默认 Hermes 的运维
步骤见 6.1；显式 Codex 的私有登录与目录步骤见 6.2。Claude 尚无实现和启动步骤。
三者不能同时启动，也不能共享会话或工作区。

### 6.1 安装 Hermes plugin

先创建不复制默认凭据、skills、会话或 Gateway 状态的隔离 profile：

```bash
hermes profile create livis-test --no-skills --no-alias \
  --description "LiViS Relay 一期隔离测试 profile"
export LIVIS_HERMES_HOME="$HOME/.hermes/profiles/livis-test"
test -d "$LIVIS_HERMES_HOME" && ! test -L "$LIVIS_HERMES_HOME" || {
  echo "livis-test profile 不存在、不是目录或末级为 symlink" >&2
  exit 1
}
test "$(cd "$LIVIS_HERMES_HOME" && pwd -P)" = "$LIVIS_HERMES_HOME" || {
  echo "livis-test profile 的物理路径发生了 symlink/canonical 漂移" >&2
  exit 1
}
```

不要使用 `--clone` / `--clone-all`，也不要把插件启用到正在承载其他渠道的默认 Gateway。字符串路径正确不足以证明隔离；上述物理路径检查会在任何插件或 Gateway 写操作前拒绝末级及祖先的 symlink/canonical 漂移。插件目录必须同时包含三个文件：

```text
$LIVIS_HERMES_HOME/plugins/livis-bridge/
├── plugin.yaml
├── __init__.py
└── adapter.py
```

从仓库根目录复制：

```bash
(
set -euo pipefail
: "${LIVIS_HERMES_HOME:?请先把 LIVIS_HERMES_HOME 设为隔离 livis-test profile 的绝对路径}"
test "$LIVIS_HERMES_HOME" = "$HOME/.hermes/profiles/livis-test" || {
  echo "拒绝操作非 livis-test Hermes profile: $LIVIS_HERMES_HOME" >&2
  exit 1
}
test -d "$LIVIS_HERMES_HOME" && ! test -L "$LIVIS_HERMES_HOME" || {
  echo "livis-test profile 不存在、不是目录或末级为 symlink" >&2
  exit 1
}
test "$(cd "$LIVIS_HERMES_HOME" && pwd -P)" = "$LIVIS_HERMES_HOME" || {
  echo "livis-test profile 物理路径不精确，拒绝安装插件" >&2
  exit 1
}
PROJECT_ROOT="$(pwd -P)"
PLUGINS_DIR="$LIVIS_HERMES_HOME/plugins"
BRIDGE_DIR="$PLUGINS_DIR/livis-bridge"
if test -e "$PLUGINS_DIR" || test -L "$PLUGINS_DIR"; then
  test -d "$PLUGINS_DIR" && ! test -L "$PLUGINS_DIR" || {
    echo "Hermes plugins 路径不是真实目录" >&2
    exit 1
  }
else
  install -d -m 0700 "$PLUGINS_DIR"
fi
test "$(cd "$PLUGINS_DIR" && pwd -P)" = "$PLUGINS_DIR" || {
  echo "Hermes plugins 目录的物理路径不精确" >&2
  exit 1
}
if test -e "$BRIDGE_DIR" || test -L "$BRIDGE_DIR"; then
  test -d "$BRIDGE_DIR" && ! test -L "$BRIDGE_DIR" || {
    echo "livis-bridge 路径不是真实目录" >&2
    exit 1
  }
else
  install -d -m 0700 "$BRIDGE_DIR"
fi
test "$(cd "$BRIDGE_DIR" && pwd -P)" = "$BRIDGE_DIR" || {
  echo "livis-bridge 目录的物理路径不精确" >&2
  exit 1
}
(
  cd "$BRIDGE_DIR"
  test "$(pwd -P)" = "$BRIDGE_DIR" || exit 1
  install -m 0644 \
    "$PROJECT_ROOT/hermes-plugin/plugin.yaml" \
    "$PROJECT_ROOT/hermes-plugin/__init__.py" \
    "$PROJECT_ROOT/hermes-plugin/adapter.py" \
    .
)
HERMES_CONFIG="$LIVIS_HERMES_HOME/config.yaml"
test -f "$HERMES_CONFIG" && ! test -L "$HERMES_CONFIG" || {
  echo "livis-test config.yaml 缺失、不是普通文件或为 symlink" >&2
  exit 1
}
case "$(uname -s)" in
  Darwin)
    HERMES_CONFIG_LINKS="$(stat -f '%l' "$HERMES_CONFIG")"
    HERMES_CONFIG_MODE="$(stat -f '%Lp' "$HERMES_CONFIG")"
    ;;
  Linux)
    HERMES_CONFIG_LINKS="$(stat -c '%h' "$HERMES_CONFIG")"
    HERMES_CONFIG_MODE="$(stat -c '%a' "$HERMES_CONFIG")"
    ;;
  *)
    echo "不支持的主机系统，无法核验 livis-test config.yaml: $(uname -s)" >&2
    exit 1
    ;;
esac
test "$HERMES_CONFIG_LINKS" = 1 && \
  test "$HERMES_CONFIG_MODE" = 600 || {
    echo "livis-test config.yaml 必须是单链接且权限为 0600" >&2
    exit 1
  }
HERMES_HOME="$LIVIS_HERMES_HOME" hermes plugins enable livis-bridge
)
```

在专用 Hermes profile 的 `.env` 中以 `0600` 权限设置：

```bash
LIVIS_RELAY_SOCKET=${HOME}/.livis-relay/connector.sock
LIVIS_RELAY_TOKEN=<使用 connector-token 命令读取>
LIVIS_ALLOWED_USERS=<与 security.allowedNodeIds 完全相同的唯一 node_id>
LIVIS_PHASE1_READ_ONLY_ACK=true
```

启动前读回 daemon 与 Hermes 两处 allowlist，确认它们完全相同且都只有一个值。`LIVIS_ALLOWED_USERS` 的逗号列表语法不代表一期允许配置多个设备。Hermes 0.15.1 的 `.env` 加载只展开 `${HOME}` 形式；裸 `$HOME` 会被当成字面路径，因此 socket 必须写成上述形式或经读回的绝对路径。

读取 connector token：

```bash
bun run src/index.ts connector-token
```

Hermes 显示配置必须关闭 streaming、tool progress 和 interim assistant messages；工具配置必须为只读，并使用独立工作区。不要在这条远程渠道中启用 manual approval，因为一期没有 approval control lane。

Hermes 0.15.1 建议为 LiViS 使用独立 profile，并在该 profile 的 `config.yaml` 中显式固定：

```yaml
platform_toolsets:
  livis:
    - no_mcp
display:
  streaming: false
  interim_assistant_messages: false
  platforms:
    livis:
      streaming: false
      tool_progress: "off"
      interim_assistant_messages: false
      long_running_notifications: false
      busy_ack_detail: false
      show_reasoning: false
streaming:
  enabled: false
gateway:
  strict: true
```

`tool_progress` 的关闭值是字符串 `"off"`，不是 `none` 或 YAML 布尔值；必须保留引号。`no_mcp` 让该平台即使以后配置了全局 MCP，也仍保持零工具面。所有 `hermes plugins` / `hermes gateway` 命令都必须带该 profile 的 `HERMES_HOME`，普通命令会误操作默认 profile。

该目录不是 wheel，也不能直接通过 monorepo 根执行 `hermes plugins install owner/repo`；开发、升级和卸载边界见 [`hermes-plugin/README.md`](../hermes-plugin/README.md)。

### 6.2 登录并启用 Codex app-server

Codex 是 daemon 内部子进程，不安装 Hermes plugin，也不启动 Hermes Gateway。先确认
CLI 版本位于 `[0.145.0, 0.146.0)`，并记录绝对路径：

```bash
command -v codex
/绝对路径/codex --version
```

不得复用用户日常的 `~/.codex`。初始化 LiViS 配置后，在可信本地终端为 state
directory 下的专用 `CODEX_HOME` 登录。macOS 默认目录示例：

```bash
STATE_DIR="$HOME/.livis-relay"
CODEX_HOME="$STATE_DIR/backends/codex/home"

test -d "$STATE_DIR" && ! test -L "$STATE_DIR"
test "$(cd "$STATE_DIR" && pwd -P)" = "$STATE_DIR"
test "$(stat -f '%Lp' "$STATE_DIR")" = 700
install -d -m 0700 "$CODEX_HOME"

env CODEX_HOME="$CODEX_HOME" /绝对路径/codex \
  -c 'cli_auth_credentials_store="file"' login --device-auth
```

Linux 将权限检查替换为 `stat -c '%a'`。API key 登录只能从标准输入交给
`codex -c 'cli_auth_credentials_store="file"' login --with-api-key`，不得写入 argv、config、
日志或 shell history。首次登录必须显式固定 `file`，后续 daemon 配置也会固定同一值，
保证认证数据落在专用 `$CODEX_HOME/auth.json`，不复用系统 credential store；不得复制、
symlink 或 hardlink 用户日常的 `auth.json`。`codex login status` 在部分认证模式下会显示
API key 的掩码片段，不得采集到 CI、工单或共享日志；daemon 会通过 app-server 的脱敏
`account/read` 在启动时验证账号。不要手写 `<stateDir>/backends/codex/home/config.toml`；
daemon 会生成固定安全配置并在每次执行前读回，已有内容不一致时失败关闭。

不要把 `account/read.requiresOpenaiAuth=true` 误判为尚未登录；它表示当前 provider 依赖
OpenAI 认证，API key 与 ChatGPT 账号的正常响应都会如此。生产门禁以 `account` 是否为
受支持对象判断账号是否存在，凭据实际有效性仍由真实模型请求裁决。

随后在 config 中显式选择 backend；`command` 应替换为刚才读回的绝对路径：

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

只有在审阅 workspace 写权限、无工具网络、审批拒绝、terminal-only final、取消与
quarantine 边界后才可把 acknowledgement 设为 `true`。Codex 模式代码级要求
`security.allowAllNodes=false` 且 `security.allowedNodeIds` 恰好一个；唯一 node ID
会绑定 immutable session hash，直接替换 ID 会拒绝复用旧 thread。

`doctor --online` 应显示 `execution_backend=codex`、remote execution acknowledgement
为 true、Codex 版本命中窗口、SQLite integrity 正常且无 quarantine。它不检查专用
账号是否真的可创建 thread；最终还要由 `serve` 的 `account/read`、permission profile
高风险 feature、thread sandbox 与 rollout 持久化回读共同放行。macOS/Codex 0.145.0
的 fresh 非临时 canary 已完整通过基础读取、同卷外部牺牲文件 hardlink、command identity、
系统 `nc -O` 精确 `EPERM` 与零 turn 重启恢复；该结果只覆盖当前 macOS/CLI/config 组合。
完整 turn deadline 与同一 POSIX 进程组的 TERM/KILL
收口已有代码和 fake 回归，但真实账号 turn、Linux/cgroup、资源配额、
逃逸进程组后代和 LiViS App 回显仍未验收，因此本模式当前只用于受控开发，不得宣称
生产上线。

2026-07-23 的一次获授权真实 canary 已确认 `turn/start` 能提交并取得 provider turn ID。
本次是明确获授权的例外：日常 `~/.codex/auth.json` 被复制为隔离 `CODEX_HOME` 中权限
`0600`、单链接的临时普通文件；它不符合上面的专用登录 runbook，不能作为生产做法。
Responses API 以 `401 invalid_api_key` 拒绝该临时副本；没有 assistant 输出，也没有
token-count 记录。这只能证明调用链到达 provider 和该副本已失效，不能证明专用登录凭据状态，
也不能算真实模型 turn 成功。harness/daemon 没有再次 dispatch；provider 内部 HTTP retry
未在该回执中评估。

提交 `e71363f` 上随后进行的一次性复核没有重发旧 job，而是在全新固定证据目录中只提交
一个 turn；provider 再次返回 401，但 Codex 0.145.0 legacy `thread/read` 把权威 failed tail
投影成 completed，backend 因通知/readback 不一致按 fail-closed 保留为 `Interrupted`、
`recovery_required=true`、零 outbox 和单条 quarantine。该证据目录不得复用、手工改库、
release 或清理；当前同一进程组已消失，事后 `lsof` 为零，但报告生成瞬间的 lsof 结果
无结论，不能倒推为当时已经证明零句柄。

本地修复的例外版本 allowlist 只含精确 0.145.0；仅在权威 failed 通知与同一 turn 的
`systemError + legacy completed tail` 完全匹配时归一化业务语义，并继续以 raw turns hash
检测漂移；其他入口仍失败关闭。预期同类凭据拒绝应在同一事务提交 job
`Failed`、failed execution ledger、通用失败 outbox、active clear 和 session quarantine，
随后关闭 backend；原始 provider message、JSON-RPC error message/data 与 app-server stderr
不得进入 `relay.db` 或共享日志。该事务目前只有 fake 回归，没有新的真实 turn 证明。
后续应停止 daemon，配置真正的专用 `CODEX_HOME` 登录，再经人工核对决定是否对旧证据执行
`session release`；新的真实调用必须重新取得明确授权。`account/read` 只证明账号对象存在，
不能证明 API key 当前有效，今后不得用复制日常凭据代替专用登录。

调试真实 app-server 协议时，不要让 `doctor` 或 `serve` 打开现有生产状态。下面的
手动 smoke 自建带 marker 的临时 state，不打开 relay SQLite，也不发送模型 turn：

```bash
bun run smoke:codex:app-server -- --command /opt/homebrew/bin/codex
```

全新目录的 `backendStartReady=false` 表示专用账号尚未登录，不是协议 smoke 失败。
入口可能产生 app-server 控制面网络尝试和 stderr，并会保留输出中的可丢弃 stateDir；
复用时只能传回同一 marker 目录。输出中的 `zeroTurnMaterialized=true` 与
`zeroTurnResumeVerified=true` 表示空 thread 已由第二个 app-server 恢复，但临时目录
不能证明读取隔离。

读取负向 canary 必须使用尚不存在的非临时可丢弃目录，并从可信本机终端执行：

```bash
bun run smoke:codex:app-server -- \
  --command /opt/homebrew/bin/codex \
  --create-state-dir /绝对/非临时/路径/livis-codex-canary \
  --verify-read-isolation
```

只有同时满足下面三组条件，才表示本机安全 probe 通过：

- 顶层 `ok=true`、`sentModelTurn=false`、`zeroTurnMaterialized=true`、
  `zeroTurnResumeVerified=true`；
- `safety` 精确读回 `cwdMatchesWorkspace=true`、`runtimeWorkspaceRootsMatch=true`、
  `sandboxType=workspaceWrite`、`networkAccess=false`、`additionalWritableRoots=0`、
  `approvalPolicy=never`、`highRiskFeaturesDisabled=true`、`bundledSkillsDisabled=true`；
- `readIsolationCanary` 非空，且其中 `stateDirOutsideTemporaryRoots`、`workspaceRead`、
  `workspaceWrite`、`agentHomeWrite`、`agentTmpWrite`、`agentEnvironmentPinned`、
  `codexHomeReadDenied`、`codexHomeWriteDenied`、`hostHomeReadDenied`、`hostHomeWriteDenied`、
  `hostTmpReadDenied`、`hostTmpWriteDenied`、`sensitiveEnvironmentHidden`、
  `workspaceHardlinkControlPassed`、`externalFileHardlinkDenied`、
  `externalFileIdentityStable`、`commandIdentityStable`、`loopbackEndpointReachable`、
  `systemNcProbeAvailable`、`toolNetworkPermissionDenied` 全部为 `true`。
hardlink 探针使用 workspace 外同卷牺牲文件，不触碰真实 Codex executable；网络探针要求
macOS 系统 `/usr/bin/nc -O` 的 stdout/stderr 与目标端点严格匹配，并精确返回
`EPERM/EACCES`。普通超时、其他 errno、多余输出、TCP 命中或 `/bin/ln`、兼容 `nc -O`
缺失都按无法裁决失败。该命令不登录、不发送模型 turn，也不等于
真实 LiViS 功能闭环；用完后确认输出路径再删除。

## 7. 启动顺序

Hermes 模式：先启动 `livis-relayd`，再启动专用 Hermes Gateway。Codex 模式只启动
`livis-relayd`；daemon 会自行创建/恢复 thread 并管理 app-server 子进程，不得另行
常驻启动第二个 app-server。

```bash
bun run src/index.ts serve
bun run src/index.ts status
bun run src/index.ts doctor --online
```

Codex 模式的稳定就绪状态必须显示 `daemon.execution.kind=codex`、
`daemon.execution.state=running`、`daemon.execution.ready=true`、稳定 thread ID 和位于
state directory 内的 workspace；同时读回账号/模型字段
`accountType/accountIdentityStrength/requestedModel/effectiveModel/modelProvider`、
`checkpoint.{turnId,turnStatus,turnCount,checkpointedAt}`，以及
`recovery.{inProgress,attempts,maxAttempts,nextAttemptAt,lastError}`。其中 `attempts` 是本次
daemon 生命周期累计已消费次数，`maxAttempts` 固定为 3。Hermes 模式则要求 connector
ready。
无论哪种模式，服务在线都不等于消息闭环。

idle app-server 意外退出且内存/SQLite 都无 active、无 recovery/quarantine、Store anchor
未漂移时，`state` 会暂时变为 `recovering`、`ready=false`，并按
`250/1000/5000 ms` 的 daemon 生命周期累计预算恢复同一 thread。此时不要另起第二个
app-server，也不要修改 config、SQLite、rollout 或 workspace；观察 `nextAttemptAt` 与
`lastError`。成功后应回到 `state=running`、`ready=true`，thread ID、账号/模型与
checkpoint 均保持不变。漂移会直接 quarantine 且不继续重试，预算耗尽则失败关闭。
活动 turn 期间退出不会走这条自动恢复路径，必须按第 9 节保留证据并人工处置。

生产运行可参考：

- `packaging/launchd/com.local.livis-relayd.plist.example`
- `packaging/systemd/livis-relayd.service.example`

替换模板中的绝对路径后再加载服务。Hermes 模式下 daemon 和 Gateway 必须是两个
独立服务；Codex 模式只加载 daemon 服务，并确保 `codex.command` 的绝对路径可执行。

### macOS LaunchAgent

本节只适用于 Hermes backend 的双 LaunchAgent 部署。以下命令是获授权主机上的操作
手册，不是本仓库验证流程的一部分。本次模板维护不会执行 `launchctl`，也不会安装、
启动或停止用户服务。

#### 7.1 部署边界与稳定 checkout

常驻模式必须使用两个独立的用户级 LaunchAgent：

- `com.local.livis-relayd` 只运行 Relay daemon；
- 隔离 profile `livis-test` 的 Hermes Gateway 使用 runtime 生成的独立 label，Hermes 0.15.1 历史环境中为 `ai.hermes.gateway-livis-test`。

不得把两个进程塞入同一个 plist，也不得覆盖或停止用户默认的 `ai.hermes.gateway`。一期仍只允许唯一 `node_id`；daemon 的 `security.allowedNodeIds` 与 Hermes 的 `LIVIS_ALLOWED_USERS` 必须读回为同一个单元素值。

服务应绑定独立、干净、路径稳定的部署 checkout，不要使用正在开发或带未提交改动的工作树：

```bash
git clone https://github.com/Jassy930/livis-relay-daemon.git \
  "$HOME/.local/share/livis-relay-daemon"
cd "$HOME/.local/share/livis-relay-daemon"
git switch --detach '<已审阅提交>'
bun install --frozen-lockfile
git status --short
bun run check
```

`git status --short` 必须为空，且 `<已审阅提交>` 必须与部署记录一致。不要让 LaunchAgent 跟随会被开发工具重写、删除或切换分支的目录。

启动前还必须确认：

- active protocol profile 是当前支持的 schema v2，supported proof 未过期；
- Hermes runtime 固定在 `[0.15.1, 0.15.2)`，bridge 固定在配置允许范围；未知版本保持失败关闭；
- state directory 位于仓库外并为 `0700`，config、proof、token 与数据库文件不进入部署 checkout；
- 若旧 `relay.db` 尚未由当前代码打开，先按第 8 节停服备份，再允许 JobStore v7 迁移；
  v4 有待派发 job 时必须先声明其原始 backend。

#### 7.2 安装 Relay 与 Hermes LaunchAgent

从 [`packaging/launchd/com.local.livis-relayd.plist.example`](../packaging/launchd/com.local.livis-relayd.plist.example) 复制本机 plist，并人工替换三个占位符：

- `__BUN__`：`command -v bun` 返回的绝对路径；
- `__PROJECT_DIR__`：上述稳定 checkout 的绝对路径；
- `__HOME__`：当前用户 home 的绝对路径。

不要把 token、node ID 或私有 profile 内容写入 plist。模板显式设置 `HOME`，并提供可解析常见 Bun/Hermes 安装位置的 `PATH`；如果 `command -v bun` 或 `command -v hermes` 位于其他目录，必须先更新本机副本的绝对路径或 `PATH`。`ThrottleInterval=10` 限制崩溃重启频率，plist 十进制 `Umask=63` 等价于八进制 `077`。

```bash
install -d -m 0700 "$HOME/.livis-relay"
plutil -lint '/绝对路径/com.local.livis-relayd.plist'
plutil -p '/绝对路径/com.local.livis-relayd.plist'
install -m 0644 '/绝对路径/com.local.livis-relayd.plist' \
  "$HOME/Library/LaunchAgents/com.local.livis-relayd.plist"
```

`plutil -p` 读回时必须核对 label、Bun、checkout、config、HOME、PATH、日志路径、`ThrottleInterval=10` 和 `Umask=63`，且不能残留 `__...__` 占位符。

Hermes plist 必须由审核范围内的 Hermes runtime 针对隔离 profile 生成；不要从本仓库复制模板，也不要手写冻结内部参数：

```bash
(
set -euo pipefail
: "${LIVIS_HERMES_HOME:?请先把 LIVIS_HERMES_HOME 设为隔离 livis-test profile 的绝对路径}"
test "$LIVIS_HERMES_HOME" = "$HOME/.hermes/profiles/livis-test" || {
  echo "拒绝操作非 livis-test Hermes profile: $LIVIS_HERMES_HOME" >&2
  exit 1
}
test -d "$LIVIS_HERMES_HOME" && ! test -L "$LIVIS_HERMES_HOME" || {
  echo "livis-test profile 不存在、不是目录或末级为 symlink" >&2
  exit 1
}
test "$(cd "$LIVIS_HERMES_HOME" && pwd -P)" = "$LIVIS_HERMES_HOME" || {
  echo "livis-test profile 物理路径不精确，拒绝安装 Gateway" >&2
  exit 1
}
HERMES_HOME="$LIVIS_HERMES_HOME" hermes gateway install
plutil -p "$HOME/Library/LaunchAgents/ai.hermes.gateway-livis-test.plist"
)
```

读回生成 plist 的 label、程序路径、`HERMES_HOME` 和日志路径；若 label 或文件路径不同，先检查生成的 plist 和精确 `launchctl print "gui/$(id -u)/ai.hermes.gateway-livis-test"` 目标，不得改为操作默认 `ai.hermes.gateway`。`hermes gateway status` 只可作辅助诊断；0.15.1 在 macOS 上即使报告“not loaded”也可能返回 0，不能用它的退出码证明 job 已加载或运行。如果 `gateway install` 同时加载或启动了 job，应使用第 7.3 节的精确 label/PID 停服段处理，随后仍按 Relay → Hermes 的固定顺序启动；不要在该关键路径依赖 0.15.1 `gateway stop` 的退出码或 PID 强制终止逻辑。每次新开 shell 或进入后续启停、升级步骤，都必须重新执行非空与精确路径检查；不能让空的 `HERMES_HOME` 回退到 active/default profile。Hermes 命令的具体行为以审核中的 0.15.1 runtime 为准，不能拿未来版本 CLI 的输出扩大支持窗口。

#### 7.3 启动、停止与卸载

启动顺序固定为 Relay → Hermes：

```bash
(
set -euo pipefail
: "${LIVIS_HERMES_HOME:?请先把 LIVIS_HERMES_HOME 设为隔离 livis-test profile 的绝对路径}"
test "$LIVIS_HERMES_HOME" = "$HOME/.hermes/profiles/livis-test" || {
  echo "拒绝操作非 livis-test Hermes profile: $LIVIS_HERMES_HOME" >&2
  exit 1
}
test -d "$LIVIS_HERMES_HOME" && ! test -L "$LIVIS_HERMES_HOME" || {
  echo "livis-test profile 不存在、不是目录或末级为 symlink" >&2
  exit 1
}
test "$(cd "$LIVIS_HERMES_HOME" && pwd -P)" = "$LIVIS_HERMES_HOME" || {
  echo "livis-test profile 物理路径不精确，拒绝启动 Gateway" >&2
  exit 1
}
RELAY_TARGET="gui/$(id -u)/com.local.livis-relayd"
HERMES_TARGET="gui/$(id -u)/ai.hermes.gateway-livis-test"
RELAY_CHECKOUT="$HOME/.local/share/livis-relay-daemon"
RELAY_CONFIG="$HOME/.livis-relay/config.json"
test -d "$RELAY_CHECKOUT/.git" || {
  echo "Relay 稳定 checkout 不存在：$RELAY_CHECKOUT" >&2
  exit 1
}
relay_status() {
  (
    cd "$RELAY_CHECKOUT"
    bun run src/index.ts status --config "$RELAY_CONFIG"
  )
}
connector_ready() {
  STATUS_JSON="$(relay_status 2>/dev/null)" || return 1
  STATUS_JSON="$STATUS_JSON" bun -e '
    const status = JSON.parse(process.env.STATUS_JSON ?? "");
    if (status?.daemon?.connector?.ready !== true) process.exit(1);
  '
}
HERMES_PLIST="$HOME/Library/LaunchAgents/ai.hermes.gateway-livis-test.plist"
assert_hermes_definition() {
  DEFINITION_JOB="$1"
  test -f "$HERMES_PLIST" && ! test -L "$HERMES_PLIST" || {
    echo "Hermes LaunchAgent plist 缺失、不是普通文件或为 symlink" >&2
    return 1
  }
  test "$(stat -f '%l' "$HERMES_PLIST")" = 1 || {
    echo "Hermes LaunchAgent plist 必须是单链接文件" >&2
    return 1
  }
  plutil -lint "$HERMES_PLIST" >/dev/null
  test "$(plutil -extract Label raw "$HERMES_PLIST")" = "ai.hermes.gateway-livis-test" && \
    test "$(plutil -extract EnvironmentVariables.HERMES_HOME raw "$HERMES_PLIST")" = "$LIVIS_HERMES_HOME" && \
    test "$(plutil -extract WorkingDirectory raw "$HERMES_PLIST")" = "$LIVIS_HERMES_HOME" && \
    test "$(plutil -extract ProgramArguments raw "$HERMES_PLIST")" = 8 && \
    test "$(plutil -extract ProgramArguments.1 raw "$HERMES_PLIST")" = "-m" && \
    test "$(plutil -extract ProgramArguments.2 raw "$HERMES_PLIST")" = "hermes_cli.main" && \
    test "$(plutil -extract ProgramArguments.3 raw "$HERMES_PLIST")" = "--profile" && \
    test "$(plutil -extract ProgramArguments.4 raw "$HERMES_PLIST")" = "livis-test" && \
    test "$(plutil -extract ProgramArguments.5 raw "$HERMES_PLIST")" = "gateway" && \
    test "$(plutil -extract ProgramArguments.6 raw "$HERMES_PLIST")" = "run" && \
    test "$(plutil -extract ProgramArguments.7 raw "$HERMES_PLIST")" = "--replace" || {
      echo "Hermes LaunchAgent plist 不是已审阅的 livis-test 定义" >&2
      return 1
    }
  HERMES_PROGRAM="$(plutil -extract ProgramArguments.0 raw "$HERMES_PLIST")"
  case "$HERMES_PROGRAM" in
    /*) ;;
    *)
      echo "Hermes LaunchAgent 程序路径不是绝对路径" >&2
      return 1
      ;;
  esac
  test -x "$HERMES_PROGRAM" || {
    echo "Hermes LaunchAgent 程序不可执行：$HERMES_PROGRAM" >&2
    return 1
  }
  if test -n "$DEFINITION_JOB"; then
    for EXPECTED_LINE in \
      "$(printf '\tpath = %s' "$HERMES_PLIST")" \
      "$(printf '\tprogram = %s' "$HERMES_PROGRAM")" \
      "$(printf '\tworking directory = %s' "$LIVIS_HERMES_HOME")" \
      "$(printf '\t\tHERMES_HOME => %s' "$LIVIS_HERMES_HOME")"; do
      test "$(printf '%s\n' "$DEFINITION_JOB" | grep -Fxc -- "$EXPECTED_LINE")" = 1 || {
        echo "已加载的 Hermes job 与 livis-test plist 不一致" >&2
        return 1
      }
    done
    LOADED_ARGUMENTS="$(
      printf '%s\n' "$DEFINITION_JOB" | awk '
        /^[[:space:]]*arguments = \{$/ {
          starts += 1
          inside = 1
          next
        }
        inside && /^[[:space:]]*\}$/ {
          closes += 1
          inside = 0
          next
        }
        inside {
          line = $0
          sub(/^[[:space:]]+/, "", line)
          print line
        }
        END {
          if (starts != 1 || closes != 1 || inside) exit 1
        }
      '
    )" || {
      echo "无法唯一解析已加载 Hermes job 的 arguments 块" >&2
      return 1
    }
    EXPECTED_ARGUMENTS="$(printf '%s\n' \
      "$HERMES_PROGRAM" \
      "-m" \
      "hermes_cli.main" \
      "--profile" \
      "livis-test" \
      "gateway" \
      "run" \
      "--replace")"
    test "$LOADED_ARGUMENTS" = "$EXPECTED_ARGUMENTS" || {
      echo "已加载 Hermes job 的 arguments 数量、顺序或内容发生漂移" >&2
      return 1
    }
  fi
}
hermes_preflight() {
  PRE_HERMES_JOB="$(launchctl print "$HERMES_TARGET" 2>/dev/null)" || PRE_HERMES_JOB=""
  assert_hermes_definition "$PRE_HERMES_JOB"
  PRE_HERMES_LAUNCHD_PID="$(printf '%s\n' "$PRE_HERMES_JOB" | awk '/^[[:space:]]*pid = [0-9]+$/ { print $3; exit }')"
  PRE_HERMES_PROFILE_PID=""
  if test -L "$LIVIS_HERMES_HOME/gateway.pid"; then
    echo "Hermes PID 路径是 symlink，拒绝启动" >&2
    return 1
  elif test -f "$LIVIS_HERMES_HOME/gateway.pid"; then
    test "$(stat -f '%l' "$LIVIS_HERMES_HOME/gateway.pid")" = 1 || {
      echo "Hermes PID 记录必须是单链接文件，拒绝启动" >&2
      return 1
    }
    PRE_HERMES_PROFILE_PID="$(plutil -extract pid raw "$LIVIS_HERMES_HOME/gateway.pid")" || {
      echo "Hermes PID 记录不可读，拒绝启动" >&2
      return 1
    }
  elif test -e "$LIVIS_HERMES_HOME/gateway.pid"; then
    echo "Hermes PID 路径不是普通文件，拒绝启动" >&2
    return 1
  fi
  case "$PRE_HERMES_PROFILE_PID" in
    "") ;;
    *[!0-9]*)
      echo "Hermes profile PID 不是正整数，拒绝启动" >&2
      return 1
      ;;
  esac
  if test -n "$PRE_HERMES_PROFILE_PID" && ! test "$PRE_HERMES_PROFILE_PID" -gt 0; then
    echo "Hermes profile PID 必须大于 0，拒绝启动" >&2
    return 1
  fi
  if test -n "$PRE_HERMES_LAUNCHD_PID" && test -z "$PRE_HERMES_PROFILE_PID"; then
    echo "Hermes LaunchAgent 已有运行 PID 但 profile PID 缺失，拒绝启动" >&2
    return 1
  fi
  if test -n "$PRE_HERMES_LAUNCHD_PID" && \
      test "$PRE_HERMES_LAUNCHD_PID" != "$PRE_HERMES_PROFILE_PID"; then
    echo "Hermes LaunchAgent PID 与 profile PID 不一致，拒绝执行任何启动副作用" >&2
    return 1
  fi
  if test -z "$PRE_HERMES_LAUNCHD_PID" && \
      test -n "$PRE_HERMES_PROFILE_PID" && \
      ps -p "$PRE_HERMES_PROFILE_PID" -o pid= >/dev/null 2>&1; then
    echo "Hermes profile PID 仍存活但精确 LaunchAgent 无运行 PID，拒绝自动启动" >&2
    return 1
  fi
}
cleanup_failed_start() {
  set +e
  CLEANUP_NEWLINE=$'\n'
  CLEAN_HERMES_JOB="$(launchctl print "$HERMES_TARGET" 2>/dev/null)"
  CLEAN_HERMES_PID="$(printf '%s\n' "$CLEAN_HERMES_JOB" | awk '/^[[:space:]]*pid = [0-9]+$/ { print $3; exit }')"
  CLEAN_PROFILE_PID=""
  CLEANUP_PID_PROOF=true
  CLEAN_HERMES_PIDS=""
  case "$CLEAN_HERMES_PID" in
    "") ;;
    *)
      if test "$CLEAN_HERMES_PID" -gt 0; then
        CLEAN_HERMES_PIDS="$CLEAN_HERMES_PID"
      else
        CLEANUP_PID_PROOF=false
      fi
      ;;
  esac
  CLEAN_PROFILE_PID_VALID=true
  if test -L "$LIVIS_HERMES_HOME/gateway.pid"; then
    CLEANUP_PID_PROOF=false
    CLEAN_PROFILE_PID_VALID=false
  elif test -f "$LIVIS_HERMES_HOME/gateway.pid"; then
    if ! test "$(stat -f '%l' "$LIVIS_HERMES_HOME/gateway.pid")" = 1; then
      CLEANUP_PID_PROOF=false
      CLEAN_PROFILE_PID_VALID=false
    fi
    CLEAN_PROFILE_PID="$(plutil -extract pid raw "$LIVIS_HERMES_HOME/gateway.pid" 2>/dev/null)"
    case "$CLEAN_PROFILE_PID" in
      ""|*[!0-9]*)
        CLEANUP_PID_PROOF=false
        CLEAN_PROFILE_PID_VALID=false
        ;;
      *)
        if ! test "$CLEAN_PROFILE_PID" -gt 0; then
          CLEANUP_PID_PROOF=false
          CLEAN_PROFILE_PID_VALID=false
        fi
        ;;
    esac
  elif test -e "$LIVIS_HERMES_HOME/gateway.pid"; then
    CLEANUP_PID_PROOF=false
    CLEAN_PROFILE_PID_VALID=false
  fi
  CLEAN_RELAY_JOB="$(launchctl print "$RELAY_TARGET" 2>/dev/null)"
  CLEAN_RELAY_PID="$(printf '%s\n' "$CLEAN_RELAY_JOB" | awk '/^[[:space:]]*pid = [0-9]+$/ { print $3; exit }')"
  CLEAN_RELAY_PIDS=""
  case "$CLEAN_RELAY_PID" in
    "") ;;
    *)
      if test "$CLEAN_RELAY_PID" -gt 0; then
        CLEAN_RELAY_PIDS="$CLEAN_RELAY_PID"
      else
        CLEANUP_PID_PROOF=false
      fi
      ;;
  esac
  CLEAN_PROFILE_PIDS=""
  if test "$CLEAN_PROFILE_PID_VALID" = true && test -n "$CLEAN_PROFILE_PID"; then
    CLEAN_PROFILE_PIDS="$CLEAN_PROFILE_PID"
  fi
  test -z "$CLEAN_HERMES_JOB" || launchctl bootout "$HERMES_TARGET"
  test -z "$CLEAN_RELAY_JOB" || launchctl bootout "$RELAY_TARGET"
  CLEANUP_DONE=false
  CLEANUP_DEADLINE=$((SECONDS + 30))
  while test "$SECONDS" -lt "$CLEANUP_DEADLINE"; do
    HERMES_LABEL_LEFT=false
    RELAY_LABEL_LEFT=false
    HERMES_PID_LEFT=false
    PROFILE_PID_LEFT=false
    RELAY_PID_LEFT=false
    POST_HERMES_JOB="$(launchctl print "$HERMES_TARGET" 2>/dev/null)"
    if test -n "$POST_HERMES_JOB"; then
      HERMES_LABEL_LEFT=true
      POST_HERMES_PID="$(printf '%s\n' "$POST_HERMES_JOB" | awk '/^[[:space:]]*pid = [0-9]+$/ { print $3; exit }')"
      case "$POST_HERMES_PID" in
        "") ;;
        *)
          if test "$POST_HERMES_PID" -gt 0; then
            if ! printf '%s\n' "$CLEAN_HERMES_PIDS" | grep -Fqx -- "$POST_HERMES_PID"; then
              CLEAN_HERMES_PIDS="${CLEAN_HERMES_PIDS:+${CLEAN_HERMES_PIDS}${CLEANUP_NEWLINE}}${POST_HERMES_PID}"
            fi
          else
            CLEANUP_PID_PROOF=false
          fi
          ;;
      esac
      launchctl bootout "$HERMES_TARGET" >/dev/null 2>&1
    fi
    POST_RELAY_JOB="$(launchctl print "$RELAY_TARGET" 2>/dev/null)"
    if test -n "$POST_RELAY_JOB"; then
      RELAY_LABEL_LEFT=true
      POST_RELAY_PID="$(printf '%s\n' "$POST_RELAY_JOB" | awk '/^[[:space:]]*pid = [0-9]+$/ { print $3; exit }')"
      case "$POST_RELAY_PID" in
        "") ;;
        *)
          if test "$POST_RELAY_PID" -gt 0; then
            if ! printf '%s\n' "$CLEAN_RELAY_PIDS" | grep -Fqx -- "$POST_RELAY_PID"; then
              CLEAN_RELAY_PIDS="${CLEAN_RELAY_PIDS:+${CLEAN_RELAY_PIDS}${CLEANUP_NEWLINE}}${POST_RELAY_PID}"
            fi
          else
            CLEANUP_PID_PROOF=false
          fi
          ;;
      esac
      launchctl bootout "$RELAY_TARGET" >/dev/null 2>&1
    fi
    POST_PROFILE_PID=""
    if test -L "$LIVIS_HERMES_HOME/gateway.pid"; then
      CLEANUP_PID_PROOF=false
    elif test -f "$LIVIS_HERMES_HOME/gateway.pid"; then
      if test "$(stat -f '%l' "$LIVIS_HERMES_HOME/gateway.pid")" = 1; then
        POST_PROFILE_PID="$(plutil -extract pid raw "$LIVIS_HERMES_HOME/gateway.pid" 2>/dev/null)"
        case "$POST_PROFILE_PID" in
          ""|*[!0-9]*) CLEANUP_PID_PROOF=false ;;
          *)
            if test "$POST_PROFILE_PID" -gt 0; then
              if ! printf '%s\n' "$CLEAN_PROFILE_PIDS" | grep -Fqx -- "$POST_PROFILE_PID"; then
                CLEAN_PROFILE_PIDS="${CLEAN_PROFILE_PIDS:+${CLEAN_PROFILE_PIDS}${CLEANUP_NEWLINE}}${POST_PROFILE_PID}"
              fi
            else
              CLEANUP_PID_PROOF=false
            fi
            ;;
        esac
      else
        CLEANUP_PID_PROOF=false
      fi
    elif test -e "$LIVIS_HERMES_HOME/gateway.pid"; then
      CLEANUP_PID_PROOF=false
    fi
    while IFS= read -r KNOWN_PID; do
      if test -n "$KNOWN_PID" && ps -p "$KNOWN_PID" -o pid= >/dev/null 2>&1; then
        HERMES_PID_LEFT=true
      fi
    done <<< "$CLEAN_HERMES_PIDS"
    while IFS= read -r KNOWN_PID; do
      if test -n "$KNOWN_PID" && ps -p "$KNOWN_PID" -o pid= >/dev/null 2>&1; then
        PROFILE_PID_LEFT=true
      fi
    done <<< "$CLEAN_PROFILE_PIDS"
    while IFS= read -r KNOWN_PID; do
      if test -n "$KNOWN_PID" && ps -p "$KNOWN_PID" -o pid= >/dev/null 2>&1; then
        RELAY_PID_LEFT=true
      fi
    done <<< "$CLEAN_RELAY_PIDS"
    if test "$HERMES_LABEL_LEFT" = false && \
        test "$RELAY_LABEL_LEFT" = false && \
        test "$HERMES_PID_LEFT" = false && \
        test "$PROFILE_PID_LEFT" = false && \
        test "$RELAY_PID_LEFT" = false && \
        test "$CLEANUP_PID_PROOF" = true; then
      CLEANUP_DONE=true
      break
    fi
    sleep 0.5
  done
  if test "$CLEANUP_DONE" != true || test "$CLEANUP_PID_PROOF" != true; then
    echo "启动失败后已尝试 bootout 两个精确 label，但无法证明全部 label/PID 均已退出；拒绝继续验收" >&2
  fi
}
hermes_preflight
trap cleanup_failed_start EXIT
if launchctl print "$RELAY_TARGET" >/dev/null 2>&1; then
  # kickstart 不会重新读取磁盘上的 plist；先精确卸载旧定义并确认其 PID 退出。
  PREVIOUS_RELAY_JOB="$(launchctl print "$RELAY_TARGET")"
  PREVIOUS_RELAY_PID="$(printf '%s\n' "$PREVIOUS_RELAY_JOB" | awk '/^[[:space:]]*pid = [0-9]+$/ { print $3; exit }')"
  launchctl bootout "$RELAY_TARGET"
  RELAY_BOOTOUT_DONE=false
  RELAY_BOOTOUT_DEADLINE=$((SECONDS + 30))
  while test "$SECONDS" -lt "$RELAY_BOOTOUT_DEADLINE"; do
    if ! launchctl print "$RELAY_TARGET" >/dev/null 2>&1 && \
        { test -z "$PREVIOUS_RELAY_PID" || ! ps -p "$PREVIOUS_RELAY_PID" -o pid= >/dev/null 2>&1; }; then
      RELAY_BOOTOUT_DONE=true
      break
    fi
    sleep 0.5
  done
  test "$RELAY_BOOTOUT_DONE" = true || {
    echo "旧 Relay LaunchAgent 的精确 label 或 PID 未在 30 秒内退出，拒绝载入新定义" >&2
    exit 1
  }
fi
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/com.local.livis-relayd.plist"
RELAY_READY=false
RELAY_JOB=""
RELAY_PID=""
RELAY_DEADLINE=$((SECONDS + 120))
while test "$SECONDS" -lt "$RELAY_DEADLINE"; do
  RELAY_JOB="$(launchctl print "$RELAY_TARGET" 2>/dev/null)" || RELAY_JOB=""
  RELAY_PID="$(printf '%s\n' "$RELAY_JOB" | awk '/^[[:space:]]*pid = [0-9]+$/ { print $3; exit }')"
  if test -n "$RELAY_PID" && \
      ps -p "$RELAY_PID" -o pid= >/dev/null 2>&1 && \
      relay_status >/dev/null 2>&1 && \
      test "$SECONDS" -lt "$RELAY_DEADLINE"; then
    RELAY_READY=true
    break
  fi
  sleep 0.5
done
test "$RELAY_READY" = true || {
  echo "Relay 未在 120 秒内同时满足精确 label、运行 PID 和本地 status 就绪" >&2
  exit 1
}
printf '%s\n' "$RELAY_JOB"
hermes_preflight
HERMES_HOME="$LIVIS_HERMES_HOME" hermes gateway start
HERMES_READY=false
HERMES_JOB=""
HERMES_LAUNCHD_PID=""
HERMES_PROFILE_PID=""
HERMES_DEADLINE=$((SECONDS + 120))
while test "$SECONDS" -lt "$HERMES_DEADLINE"; do
  HERMES_JOB="$(launchctl print "$HERMES_TARGET" 2>/dev/null)" || HERMES_JOB=""
  if test -n "$HERMES_JOB"; then
    assert_hermes_definition "$HERMES_JOB" || exit 1
  fi
  HERMES_LAUNCHD_PID="$(printf '%s\n' "$HERMES_JOB" | awk '/^[[:space:]]*pid = [0-9]+$/ { print $3; exit }')"
  HERMES_PROFILE_PID=""
  if test -f "$LIVIS_HERMES_HOME/gateway.pid" && ! test -L "$LIVIS_HERMES_HOME/gateway.pid"; then
    HERMES_PROFILE_PID="$(plutil -extract pid raw "$LIVIS_HERMES_HOME/gateway.pid" 2>/dev/null)" || HERMES_PROFILE_PID=""
  fi
  if test -n "$HERMES_LAUNCHD_PID" && \
      test "$HERMES_LAUNCHD_PID" = "$HERMES_PROFILE_PID" && \
      ps -p "$HERMES_LAUNCHD_PID" -o pid= >/dev/null 2>&1 && \
      connector_ready && \
      test "$SECONDS" -lt "$HERMES_DEADLINE"; then
    HERMES_READY=true
    break
  fi
  sleep 0.5
done
test "$HERMES_READY" = true || {
  echo "Hermes 未在 120 秒内同时满足精确 label、PID 一致和 connector ready" >&2
  exit 1
}
hermes_preflight
test -n "$PRE_HERMES_LAUNCHD_PID" && \
  ps -p "$PRE_HERMES_LAUNCHD_PID" -o pid= >/dev/null 2>&1 && \
  connector_ready || {
    echo "Hermes 最终读回时 label、PID 或 connector readiness 已漂移" >&2
    exit 1
  }
printf '%s\n' "$PRE_HERMES_JOB"
relay_status
trap - EXIT
)
```

三个操作段都在 `set -euo pipefail` 子 shell 中执行：任一步失败都不会继续启动下一服务，也不会把 shell 选项泄漏到操作者当前会话。启动段在任何服务副作前先闭合验证 livis-test plist、loaded job、profile 物理路径和 PID；已加载 job 的 arguments 必须与磁盘 plist 在数量、顺序和内容上逐项相等。随后安装 `EXIT` 补偿，启动后在 readiness 轮询及解除 trap 前再次读回定义；只有最终 status 读回成功才解除。中间任一失败或 readiness 超时都会先按 Hermes → Relay 对两个精确 label 执行 `bootout`，并在 30 秒内持续重读、验证和累计启动窗口内见过的 label/profile PID；无法证明时保持失败结论，不会把后续才上线的 KeepAlive job 误判为已清理。已加载的 Relay job 走 `kickstart -k`，因此正常退出后仍为 loaded/inactive 的 job 也会真正启动；未加载时才走 `bootstrap`。`kickstart -k` 会重启已在运行的 job，只能在明确的启动或重启窗口执行。Relay 必须先在 120 秒有界窗口内同时通过精确 label、运行 PID 和本地鉴权 status，才会启动 Hermes；该窗口覆盖 `serve` 启动时 upstream package 探测的三段 30 秒单次超时与初始化余量。Hermes 随后也必须在 120 秒内同时读回精确 label、与隔离 profile `gateway.pid` 一致的存活 PID，并由 Relay status 证明 connector ready。任一窗口超时都失败关闭，不依赖 `gateway status` 的退出码。停止顺序固定为 Hermes → Relay，避免 daemon 继续向正在退出的 connector 派发：

```bash
(
set -euo pipefail
: "${LIVIS_HERMES_HOME:?请先把 LIVIS_HERMES_HOME 设为隔离 livis-test profile 的绝对路径}"
test "$LIVIS_HERMES_HOME" = "$HOME/.hermes/profiles/livis-test" || {
  echo "拒绝操作非 livis-test Hermes profile: $LIVIS_HERMES_HOME" >&2
  exit 1
}
test -d "$LIVIS_HERMES_HOME" && ! test -L "$LIVIS_HERMES_HOME" || {
  echo "livis-test profile 不存在、不是目录或末级为 symlink" >&2
  exit 1
}
test "$(cd "$LIVIS_HERMES_HOME" && pwd -P)" = "$LIVIS_HERMES_HOME" || {
  echo "livis-test profile 物理路径不精确，拒绝停止 Gateway" >&2
  exit 1
}
HERMES_TARGET="gui/$(id -u)/ai.hermes.gateway-livis-test"
RELAY_TARGET="gui/$(id -u)/com.local.livis-relayd"
HERMES_PLIST="$HOME/Library/LaunchAgents/ai.hermes.gateway-livis-test.plist"
HERMES_JOB="$(launchctl print "$HERMES_TARGET" 2>/dev/null)" || HERMES_JOB=""
test -f "$HERMES_PLIST" && ! test -L "$HERMES_PLIST" || {
  echo "Hermes LaunchAgent plist 缺失、不是普通文件或为 symlink" >&2
  exit 1
}
test "$(stat -f '%l' "$HERMES_PLIST")" = 1 || {
  echo "Hermes LaunchAgent plist 必须是单链接文件" >&2
  exit 1
}
plutil -lint "$HERMES_PLIST" >/dev/null
test "$(plutil -extract Label raw "$HERMES_PLIST")" = "ai.hermes.gateway-livis-test" && \
  test "$(plutil -extract EnvironmentVariables.HERMES_HOME raw "$HERMES_PLIST")" = "$LIVIS_HERMES_HOME" && \
  test "$(plutil -extract WorkingDirectory raw "$HERMES_PLIST")" = "$LIVIS_HERMES_HOME" && \
  test "$(plutil -extract ProgramArguments raw "$HERMES_PLIST")" = 8 && \
  test "$(plutil -extract ProgramArguments.1 raw "$HERMES_PLIST")" = "-m" && \
  test "$(plutil -extract ProgramArguments.2 raw "$HERMES_PLIST")" = "hermes_cli.main" && \
  test "$(plutil -extract ProgramArguments.3 raw "$HERMES_PLIST")" = "--profile" && \
  test "$(plutil -extract ProgramArguments.4 raw "$HERMES_PLIST")" = "livis-test" && \
  test "$(plutil -extract ProgramArguments.5 raw "$HERMES_PLIST")" = "gateway" && \
  test "$(plutil -extract ProgramArguments.6 raw "$HERMES_PLIST")" = "run" && \
  test "$(plutil -extract ProgramArguments.7 raw "$HERMES_PLIST")" = "--replace" || {
    echo "Hermes LaunchAgent plist 不是已审阅的 livis-test 定义" >&2
    exit 1
  }
HERMES_PROGRAM="$(plutil -extract ProgramArguments.0 raw "$HERMES_PLIST")"
case "$HERMES_PROGRAM" in
  /*) ;;
  *)
    echo "Hermes LaunchAgent 程序路径不是绝对路径" >&2
    exit 1
    ;;
esac
test -x "$HERMES_PROGRAM" || {
  echo "Hermes LaunchAgent 程序不可执行：$HERMES_PROGRAM" >&2
  exit 1
}
if test -n "$HERMES_JOB"; then
  for EXPECTED_LINE in \
    "$(printf '\tpath = %s' "$HERMES_PLIST")" \
    "$(printf '\tprogram = %s' "$HERMES_PROGRAM")" \
    "$(printf '\tworking directory = %s' "$LIVIS_HERMES_HOME")" \
    "$(printf '\t\tHERMES_HOME => %s' "$LIVIS_HERMES_HOME")"; do
    test "$(printf '%s\n' "$HERMES_JOB" | grep -Fxc -- "$EXPECTED_LINE")" = 1 || {
      echo "已加载的 Hermes job 与 livis-test plist 不一致" >&2
      exit 1
    }
  done
  LOADED_ARGUMENTS="$(
    printf '%s\n' "$HERMES_JOB" | awk '
      /^[[:space:]]*arguments = \{$/ {
        starts += 1
        inside = 1
        next
      }
      inside && /^[[:space:]]*\}$/ {
        closes += 1
        inside = 0
        next
      }
      inside {
        line = $0
        sub(/^[[:space:]]+/, "", line)
        print line
      }
      END {
        if (starts != 1 || closes != 1 || inside) exit 1
      }
    '
  )" || {
    echo "无法唯一解析已加载 Hermes job 的 arguments 块" >&2
    exit 1
  }
  EXPECTED_ARGUMENTS="$(printf '%s\n' \
    "$HERMES_PROGRAM" \
    "-m" \
    "hermes_cli.main" \
    "--profile" \
    "livis-test" \
    "gateway" \
    "run" \
    "--replace")"
  test "$LOADED_ARGUMENTS" = "$EXPECTED_ARGUMENTS" || {
    echo "已加载 Hermes job 的 arguments 数量、顺序或内容发生漂移" >&2
    exit 1
  }
fi
HERMES_LAUNCHD_PID="$(printf '%s\n' "$HERMES_JOB" | awk '/^[[:space:]]*pid = [0-9]+$/ { print $3; exit }')"
HERMES_PROFILE_PID=""
if test -L "$LIVIS_HERMES_HOME/gateway.pid"; then
  echo "Hermes PID 路径是 symlink，拒绝停止" >&2
  exit 1
elif test -f "$LIVIS_HERMES_HOME/gateway.pid"; then
  test "$(stat -f '%l' "$LIVIS_HERMES_HOME/gateway.pid")" = 1 || {
    echo "Hermes PID 记录必须是单链接文件，拒绝停止" >&2
    exit 1
  }
  HERMES_PROFILE_PID="$(plutil -extract pid raw "$LIVIS_HERMES_HOME/gateway.pid")" || {
    echo "Hermes PID 记录不可读，拒绝停止" >&2
    exit 1
  }
elif test -e "$LIVIS_HERMES_HOME/gateway.pid"; then
  echo "Hermes PID 路径不是普通文件，拒绝停止" >&2
  exit 1
fi
case "$HERMES_PROFILE_PID" in
  "") ;;
  *[!0-9]*)
    echo "Hermes profile PID 不是正整数，拒绝停止" >&2
    exit 1
    ;;
esac
if test -n "$HERMES_PROFILE_PID" && ! test "$HERMES_PROFILE_PID" -gt 0; then
  echo "Hermes profile PID 必须大于 0，拒绝停止" >&2
  exit 1
fi
if test -n "$HERMES_LAUNCHD_PID" && test -z "$HERMES_PROFILE_PID"; then
  echo "Hermes LaunchAgent 已有运行 PID 但 profile PID 缺失，拒绝停止" >&2
  exit 1
fi
if test -n "$HERMES_LAUNCHD_PID" && \
    test "$HERMES_LAUNCHD_PID" != "$HERMES_PROFILE_PID"; then
  echo "Hermes LaunchAgent PID 与 profile PID 不一致，拒绝执行任何停止副作用" >&2
  exit 1
fi
if test -z "$HERMES_LAUNCHD_PID" && \
    test -n "$HERMES_PROFILE_PID" && \
    ps -p "$HERMES_PROFILE_PID" -o pid= >/dev/null 2>&1; then
  echo "Hermes profile PID 仍存活但精确 LaunchAgent 无运行 PID，拒绝自动停止" >&2
  exit 1
fi
if test -n "$HERMES_JOB"; then
  launchctl bootout "$HERMES_TARGET"
fi
HERMES_STOPPED=false
ATTEMPT=0
while test "$ATTEMPT" -lt 60; do
  ATTEMPT=$((ATTEMPT + 1))
  HERMES_LABEL_LOADED=false
  HERMES_LAUNCHD_ALIVE=false
  HERMES_PROFILE_ALIVE=false
  HERMES_POST_ALIVE=false
  POST_PID=""
  if launchctl print "$HERMES_TARGET" >/dev/null 2>&1; then
    HERMES_LABEL_LOADED=true
  fi
  if test -n "$HERMES_LAUNCHD_PID" && ps -p "$HERMES_LAUNCHD_PID" -o pid= >/dev/null 2>&1; then
    HERMES_LAUNCHD_ALIVE=true
  fi
  if test -n "$HERMES_PROFILE_PID" && ps -p "$HERMES_PROFILE_PID" -o pid= >/dev/null 2>&1; then
    HERMES_PROFILE_ALIVE=true
  fi
  if test -L "$LIVIS_HERMES_HOME/gateway.pid"; then
    echo "停止后的 Hermes PID 路径变成 symlink，拒绝停止 Relay" >&2
    exit 1
  elif test -f "$LIVIS_HERMES_HOME/gateway.pid"; then
    test "$(stat -f '%l' "$LIVIS_HERMES_HOME/gateway.pid")" = 1 || {
      echo "停止后的 Hermes PID 记录不是单链接文件，拒绝停止 Relay" >&2
      exit 1
    }
    POST_PID="$(plutil -extract pid raw "$LIVIS_HERMES_HOME/gateway.pid")" || {
      echo "停止后的 Hermes PID 记录不可读，拒绝停止 Relay" >&2
      exit 1
    }
    case "$POST_PID" in
      ""|*[!0-9]*)
        echo "停止后的 Hermes PID 不是正整数，拒绝停止 Relay" >&2
        exit 1
        ;;
    esac
    if ! test "$POST_PID" -gt 0; then
      echo "停止后的 Hermes PID 必须大于 0，拒绝停止 Relay" >&2
      exit 1
    fi
    if test -n "$POST_PID" && ps -p "$POST_PID" -o pid= >/dev/null 2>&1; then
      HERMES_POST_ALIVE=true
    fi
  elif test -e "$LIVIS_HERMES_HOME/gateway.pid"; then
    echo "停止后的 Hermes PID 路径不是普通文件，拒绝停止 Relay" >&2
    exit 1
  fi
  if test "$HERMES_LABEL_LOADED" = false && \
      test "$HERMES_LAUNCHD_ALIVE" = false && \
      test "$HERMES_PROFILE_ALIVE" = false && \
      test "$HERMES_POST_ALIVE" = false; then
    HERMES_STOPPED=true
    break
  fi
  sleep 0.5
done
test "$HERMES_STOPPED" = true || {
  echo "Hermes 未在 30 秒内同时释放 label 和所有已记录 PID，拒绝停止 Relay" >&2
  exit 1
}
RELAY_JOB="$(launchctl print "$RELAY_TARGET" 2>/dev/null)" || RELAY_JOB=""
RELAY_PID="$(printf '%s\n' "$RELAY_JOB" | awk '/^[[:space:]]*pid = [0-9]+$/ { print $3; exit }')"
if test -n "$RELAY_JOB"; then
  launchctl bootout "$RELAY_TARGET"
fi
RELAY_STOPPED=false
ATTEMPT=0
while test "$ATTEMPT" -lt 60; do
  ATTEMPT=$((ATTEMPT + 1))
  RELAY_LABEL_LOADED=false
  RELAY_PID_ALIVE=false
  if launchctl print "$RELAY_TARGET" >/dev/null 2>&1; then
    RELAY_LABEL_LOADED=true
  fi
  if test -n "$RELAY_PID" && ps -p "$RELAY_PID" -o pid= >/dev/null 2>&1; then
    RELAY_PID_ALIVE=true
  fi
  if test "$RELAY_LABEL_LOADED" = false && test "$RELAY_PID_ALIVE" = false; then
    RELAY_STOPPED=true
    break
  fi
  sleep 0.5
done
test "$RELAY_STOPPED" = true || {
  echo "Relay 未在 30 秒内同时释放 label 和原 PID" >&2
  exit 1
}
)
```

Hermes 0.15.1 的 `gateway stop` 不仅退出码不能证明进程已经退出，还会信任 `gateway.pid` 并在等待失败后对该 PID 发送强制终止。为避免陈旧或被改写的普通 PID 文件误伤默认 Gateway，上述关键停服路径不调用该命令：它会先比对已存在的 launchd/profile PID，任何存活且无对应精确 label 的 PID 都在副作用前失败关闭；然后只 `bootout` 精确 `ai.hermes.gateway-livis-test` 目标，并在 30 秒有界窗口内同时读回 label、所有原 PID 和停止后残留的 PID 记录。任一 Hermes 进程仍存活时都不会继续停止 Relay。Relay 的 `bootout` 也会先保留顶层 PID，只有 label 消失且原 PID 退出后才完成停服；此后才可进入 SQLite/WAL/SHM 备份。

只有明确要卸载时，才在停止后删除 Relay plist，并通过对应隔离 profile 的 Hermes uninstall 命令移除 Hermes job；任何命令都必须保留正确的 `HERMES_HOME`。不要删除 state directory，卸载服务不等于删除消息、token 或迁移备份。

#### 7.4 日志与故障定位

Relay 模板把结构化日志分别写入：

```text
$HOME/.livis-relay/daemon.stdout.log
$HOME/.livis-relay/daemon.stderr.log
```

读取而不是清空日志：

```bash
tail -n 200 "$HOME/.livis-relay/daemon.stdout.log"
tail -n 200 "$HOME/.livis-relay/daemon.stderr.log"
launchctl print "gui/$(id -u)/com.local.livis-relayd"
launchctl print "gui/$(id -u)/ai.hermes.gateway-livis-test"
```

Hermes 的 stdout/stderr 路径以 runtime 生成的 plist 为准，先用 `plutil -p` 读回，再读取对应文件；不要假设它与 Relay 共用日志。`launchctl print` 中有 PID 或 `state=running` 只证明进程级状态，不能证明 Relay handshake、connector ready 或消息闭环。

#### 7.5 升级与回滚

升级必须在停服窗口完成：

1. 按 Hermes → Relay 顺序停止两个 LaunchAgent，并确认 label 均不再运行。
2. 完整备份 state directory；JobStore v7 场景必须包含 `relay.db`、WAL 和 SHM。备份前不要运行会打开数据库的新版 `serve`、`doctor` 或 `session release`。
3. 在稳定 checkout 中获取并切换到精确已审阅提交，确认工作树干净，执行 `bun install --frozen-lockfile` 与 `bun run check`。
4. 按第 6 节把当前提交中的 bridge 三个文件重新安装到隔离 Hermes profile；不要从 LiViS 通道执行 `/update`，也不要在其他 Gateway 运行期间执行未经评审的全局 Hermes 更新。
5. 若 active protocol profile 仍为 schema v1，只能按升级 runbook 在停服状态执行 `profile migrate-v2` 并重新生成 proof；普通 `upstream activate` 不能替代 schema migration，也不得由 launchd 自动猜测或旁路迁移。
6. 若 active profile 已是 schema v2，但新提交需要切换到另一份已人工审阅的兼容 v2 profile，保持双服务停止，按[普通 profile 激活事务](PROFILE-ACTIVATION.md)执行 `upstream activate`；记录 `backupConfigPath` 与 `receiptPath`，在线复核通过后才继续。
7. 若 Relay plist 模板变化，重新生成本机副本、`plutil -lint`、读回占位符和路径，再覆盖 LaunchAgents 中的副本。
8. 按 Relay → Hermes 顺序启动，并完成下一节的服务级和消息级验收。

第 6 步只适用于 schema v2 内的普通兼容 profile 切换，固定命令如下：

```bash
(
set -euo pipefail
CONFIG="$HOME/.livis-relay/config.json"
if test "${LIVIS_RELAY_STATE_DIR+x}" = x; then
  echo "普通 profile 激活禁止设置 LIVIS_RELAY_STATE_DIR" >&2
  exit 1
fi
bun run src/index.ts upstream activate \
  --config "$CONFIG" \
  --profile '/绝对路径/已审阅-profile.json' \
  --acknowledge-reviewed-profile
bun run src/index.ts upstream check --config "$CONFIG"
bun run src/index.ts doctor --online --config "$CONFIG"
)
```

必须保存激活输出中的 `backupConfigPath`、`receiptPath` 和精确 profile SHA；只有新的 current supported proof 与 online doctor 都通过，才进入启动步骤。普通 v2 激活失败或需要恢复旧 profile 时，继续保持双服务停止，使用对应 config 备份显式回滚：

```bash
(
set -euo pipefail
CONFIG="$HOME/.livis-relay/config.json"
if test "${LIVIS_RELAY_STATE_DIR+x}" = x; then
  echo "普通 profile 回滚禁止设置 LIVIS_RELAY_STATE_DIR" >&2
  exit 1
fi
bun run src/index.ts upstream rollback \
  --config "$CONFIG" \
  --backup '/绝对路径/config-backups/<activation-id>.json' \
  --acknowledge-rollback
bun run src/index.ts upstream check --config "$CONFIG"
bun run src/index.ts doctor --online --config "$CONFIG"
)
```

普通回滚只恢复 `profile` 与 `profileSha256`，不会恢复 relay、security、Hermes、connector 或 stateDir 等其他字段；旧 profile 无法重新得到 current supported proof 时不得启动。schema v1→v2 migration 的回滚是另一套 `profile rollback-migration` 状态机，不能混用普通 activation 备份。

回滚到不认识 JobStore v7 的旧 daemon 时，必须同时恢复升级前的完整数据库备份；只切回 checkout 或只回滚 protocol profile 都不安全。Hermes runtime 或 bridge 变更后仍须保持 `[0.15.1, 0.15.2)` 的 fail-closed 支持窗，除非独立升级评审已经修改代码、配置和 canary 证据。

#### 7.6 分层验收

验收必须分层记录，不能用前一层替代后一层：

1. **静态部署**：两个 plist 均通过 `plutil -lint`，绝对路径存在，无占位符或秘密，稳定 checkout 精确命中已审阅提交。
2. **服务与连接就绪**：两个独立 label 正常；`bun run src/index.ts doctor --online` 和 `status` 显示当前 protocol profile v2、wire revision/mode、未过期 proof、Relay handshake、connector ready、JobStore v7 integrity、无异 backend 非终态积压及无意外 quarantine。
3. **真实消息闭环**：从唯一获准设备发送带随机后缀的单条纯文本 canary，App 收到预期纯文本；同一 job 在 daemon 中为 `Succeeded`，outbox 为 `Delivered`，Hermes 日志存在对应 inbound/response，且没有第二 final、fallback send 或权限错误。

“LaunchAgent 已加载”“服务在线”“Relay 已握手”或“connector ready”都不等于消息闭环。只有第 3 层在精确部署提交、profile、Hermes 0.15.1/bridge 版本和时间上留下脱敏记录后，才能写成 launchd canary 通过；未执行时必须明确写“未验证”。

## 8. 结果 ACK 退避、JobStore v7 升级与 backend 切换

`status` 中的 `recentJobs[].outboxStatus=AckFailed` 表示结果在当前 ACK 快速重试
周期耗尽后进入持久化退避；`outboxNextAttemptAt` 是下一次尝试的 Unix 毫秒时间。
退避到期、Relay 重连或 daemon 重启都会自动恢复投递，期间到达的迟到 ACK 也能
直接收敛为 `Delivered`。

本版本第一次由 `serve`、`doctor` 或 `session release` 打开旧 `relay.db` 时，会把
JobStore schema v1-v6 自动升级为 v7；fresh 数据库直接创建为 v7。v3 的 outbox 退避
语义保持不变，v4 新增可变的 `backend_sessions`，v5 新增 `jobs.target_backend`，v6 新增
Codex 账号/模型/安全摘要和 thread-tail checkpoint；v7 以 trigger 强制
`jobs.target_backend` 不可变，并新增 `execution_attempt_events` append-only 账本。新 job
在首次入库时绑定当前 backend；重复投递和以后切换配置都不能改写。迁移在同一个 SQLite
`BEGIN IMMEDIATE` 事务中取得写锁后读取版本，并在提交前运行 integrity 与 foreign-key
检查；失败会保留原版本，不允许半迁移状态继续运行。部署步骤固定为：

1. 停止 `livis-relayd` 并禁用服务管理器自动拉起；Hermes 模式同时停止专用 Gateway，
   Codex 模式确认 app-server 及其工具子进程均已退出。
2. 完整备份 state directory，包括 `relay.db`、`relay.db-wal` 和
   `relay.db-shm`（若存在）；备份完成前不要运行上述任何会打开 JobStore 的命令。
3. v1-v3 只能来自 Hermes，可自动绑定为 `hermes`。若备份中的数据库已经是 v4 且
   存在 `Received/Acked` job，先查明这些积压实际入库时使用的唯一 backend，并在
   config 的 `execution` 段临时填写 `"legacyV4JobBackend": "hermes"` 或
   `"codex"`。不能填写准备切换到的目标 backend；无法确认或曾混用时停止迁移，保留
   备份并人工处置。缺少该声明时新版会回滚全部 v4→v7 DDL 并拒绝打开数据库。
4. 保持 `execution.backend` 指向积压实际所属的原 backend，使用新版本启动一次 daemon，
   再运行 `status` 与 `doctor --online`，确认 SQLite integrity、Relay、所选 execution
   backend 和 upstream proof 均正常。
5. 确认 `PRAGMA user_version=7`；检查 `status.backendBacklog`、
   `recentJobs[].latestAttempt` 与 `doctor` 的 `execution_backend_backlog`。确认积压 job 的
   `targetBackend`/状态符合预期后，可从 config 删除一次性 `legacyV4JobBackend`；该字段
   不是 provider 切换命令。
6. 若准备切换 backend，先继续使用原 backend，直到它不再有
   `Received/Acked/Dispatching/Running/Cancelling` job，再停服修改配置。用目标 backend
   运行 `doctor`，确认 `execution_backend_backlog` 通过后才允许 `serve`。`serve` 会在启动
   execution backend 或 Relay 前重复同一门禁，不能靠直接编辑 SQLite 或填写
   `legacyV4JobBackend` 绕过。

`status.backendBacklog` 只统计非终态。`Succeeded/Failed/Cancelled/Rejected/Interrupted/`
`CancelUnknown` 历史不会阻止切换；它们的账本和 job 归属仍保留，尚未 `Delivered` 的
outbox 则由独立 Relay 投递状态机继续处理，不会交给新 provider 重跑。

已有 v5 Codex session 的新增元数据不会由迁移事务猜测。只有该 session 没有 active
attempt、recovery 或 quarantine，且新 daemon 已用真实 app-server 回读账号、模型、
feature、安全配置和 thread tail 后，才允许一次性补绑；否则启动失败关闭，先按第 9 节
保留证据并人工处置。

v6→v7 会把迁移时仍处于 `Dispatching/Running/Cancelling` 且字段完整的 active attempt
作为 `legacy_active_imported` 写入账本。它只表示旧库中可证明的迁移快照，不重建更早
事件，也不改变 ambiguous execution 不自动重跑的规则；重启恢复仍须按原状态失败关闭或
进入隔离。

JobStore v7 与 protocol profile schema v1→v2 是两条独立迁移：profile 命令明确
不打开 SQLite，也不会升级或回滚 `relay.db`。如果一次部署同时执行两者，应在两项
操作之前统一停服并备份整个 state directory。任何不认识 JobStore v7 的旧版 daemon
都不能直接打开升级后的数据库；
回滚程序或把 profile 回滚到 v1 时，仍必须同时恢复升级前的数据库备份，不能让旧版
直接打开 v7 数据库。

- 不要删除 `relay.db`，也不要重跑 Agent job；结果投递本来就是至少一次语义，手工
  重跑会扩大业务副作用。
- 如果超过 `outboxNextAttemptAt` 且 Relay 已连接后仍长时间没有新投递，保留
  `status`、`doctor --online` 与 daemon 日志；不要直接编辑 SQLite。

## 9. Session 隔离与 active turn 人工恢复

看到 `CancelUnknown`、`Interrupted` 对应的 session quarantine，或 Codex
`backend_sessions.recovery_required` 后：

本节也适用于 idle recovery 检测到 immutable metadata、Store anchor、rollout、checkpoint
或 tail 漂移、候选进程组关闭无法确认以及三次预算耗尽后的失败关闭。它不适用于已经按
第 7 节自动恢复成功、thread/checkpoint 均未变化的普通 idle 退出。

1. 停止 daemon；Hermes 模式停止并重启专用 Gateway，Codex 模式确认旧 app-server
   与全部工具子进程已经退出。
2. 结合日志和外部系统检查可能已经发生的副作用；`turn/interrupt` 或 `/stop` 成功
   都不能替代这一步。
3. 从 `status` 查到隔离的 `sessionKey`。
4. 完整备份 `relay.db`、WAL/SHM（若存在），Codex 模式同时保留旧
   `CODEX_HOME` rollout、workspace、旧 thread ID 与日志回执。
5. 执行：

```bash
bun run src/index.ts session release '<sessionKey>'
```

`session release` 会先 canonicalize state directory 与 connector socket 父目录，再在该
socket 路径取得 daemon offline guard，并固定 guard 对应的 canonical state directory 打开
SQLite；macOS 的 `/var` 与 `/private/var` 等同一目录别名不会被误判为 config drift，配置
symlink 在门禁后重定向也不会把数据库操作带到另一 target。运行中 daemon、遗留 socket/guard
或并发启动存在时拒绝继续。
它不会回滚文件或外部系统副作用。对于存在
recovery 的 Codex backend，或没有 active/recovery 但因 command/security 等漂移进入
quarantine 的 idle session，它会退役数据库中的旧 session/thread 绑定，而不是只清 active
后恢复一个尾部可能漂移的旧 thread；同 session 下任何 backend 仍有未进入 recovery 的
active evidence，recovery 锚点与 job 的 session/backend/lease/generation 不一致，或 recovery
证据不可释放时都失败关闭。旧 rollout、workspace、
job/outbox 不会删除。JSON 的 `retiredBackendSessions` 与
`releasedQuarantineWithoutBackendSession` 由同一个 SQLite 事务生成；只有
`codexBackendSessionRetired=true` 能精确表示旧 Codex row 已删除。不得把仅 quarantine
释放解读成 ambiguous `thread/start` 外部副作用已撤销，也不得只为清状态跳过前四步。
JSON 内容由退役事务计算，但 SQLite commit 后的 guard 复核、guard 删除与 stdout 写出不在
该事务内；命令若在这些收口步骤失败，可能出现“数据库已退役但没有 JSON 回执”，此时必须
先保留错误并只读核对数据库和 `status`，不能根据空 stdout 盲目重试。
release 后必须再运行 `doctor --online`，确认无 quarantine，再启动 daemon 并从 `status`
读回实际新建或恢复的 thread。

## 10. Relay 资源边界告警

日志出现 `WebSocket frame 超过配置的字节上限`、外部标识 `超过字节上限` 或 `pending cancel intent 已达到总量上限` 时，不要直接扩大限制：

1. 确认消息是否来自预期 Relay，并检查上游是否发生重投风暴或协议漂移；
2. unknown cancel 满额时，新 intent 不会落盘，也不会回复成功 ACK；等待已有 intent 被匹配消费或超过 24 小时 TTL 后再重试；
3. 只有已确认合法消息确实需要更大帧时才调整 `relay.maxFrameBytes`，且不得超过 16777216；
4. 监控 `relay.db`、WAL/SHM、进程 RSS 与消息速率。

该门禁只限制单帧、外部标识和临时 cancel intent。它没有实现 jobs/outbox 自动清理，也没有给大量合法小帧的处理队列增加流量整形；历史数据清理由安全手册中的停机流程负责。
