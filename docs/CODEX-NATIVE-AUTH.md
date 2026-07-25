# Codex 原生当前状态边界

本文说明 LiViS Relay 如何调用本机 Codex 当前 runtime，同时保持账号、登录方式、凭据、provider 和
认证错误对 Relay 完全不透明。

当前主路径是 Relay 自己启动并负责收口的 `codex app-server --stdio` 子进程。它不连接 Codex
Desktop 的 control socket，不依赖 `app-server daemon`，也不会启动、停止、重启、升级或配置 Desktop
daemon。

这项能力当前为 `codex_native_auth_reuse=operator-only`：显式生产接线、离线守卫和原子配置切换
已有自动化证据，transport-only 与单次真实 thread/turn Gate 也已通过；但真实 LiViS 消息闭环、
session resume、取消/超时和 Desktop 长时并发仍未通过，因此不能标为 live canary。

## 1. 显式模式与原子切换

Codex 后端必须显式选择模式；缺少 `codex.mode` 时配置解析和 `serve` 都失败关闭：

```json
{
  "execution": { "backend": "codex" },
  "codex": {
    "mode": "native-current",
    "command": "/绝对路径/codex",
    "requestTimeoutMs": 30000,
    "turnTimeoutMs": 900000,
    "shutdownTimeoutMs": 5000,
    "acknowledgeRemoteExecution": true
  }
}
```

`native-current` 不接受 `provider`、`model` 或 `toolchainReadRoots`；这些字段属于显式
`private-api-key` 兼容模式，不能成为 fallback。推荐使用切换命令生成配置，不手工改写：

```bash
# 只读计划，不写配置
bun run src/index.ts backend switch codex \
  --mode native-current \
  --command /绝对路径/codex \
  --config /绝对路径/config.json

# 完整备份 state directory、停止 daemon/Hermes 并确认无遗留进程后执行
bun run src/index.ts backend switch codex \
  --mode native-current \
  --command /绝对路径/codex \
  --apply \
  --acknowledge-daemon-stopped \
  --acknowledge-remote-execution \
  --config /绝对路径/config.json
```

`apply` 只接受 JobStore v8，并跨全部 scope 拒绝非终态 backend backlog、任意 account-bound
Codex session 和 quarantine。命令先在 connector socket 与 profile operation 路径持有离线 guard，
再写原配置备份和 `PREPARED` 收据，最后原子替换并语义读回配置；提交后验证失败会恢复原配置。
可选 `CONFIG_COMMITTED` marker 写入失败不改变配置提交结果，是否完成以 live config SHA-256 与
`PREPARED.targetConfigSha256` 相等为准。若 durable rename 已发生但父目录 fsync 未确认，命令保留
guard 并要求人工恢复，不能直接重启服务。收据固定写明 `credentialsReadOrMigrated=false`。

切回 Hermes 使用同一门禁，但不接受 Codex mode/command：

```bash
bun run src/index.ts backend switch hermes \
  --apply \
  --acknowledge-daemon-stopped \
  --config /绝对路径/config.json
```

## 2. transport-only 探针

使用 Relay 配置中的 Codex command 与 state directory：

```bash
bun run src/index.ts codex probe-native-app-server --config /绝对路径/config.json
```

只检查 transport、且不加载 Relay/Hermes 配置时，可显式提供已存在的私有 state directory：

```bash
bun run src/index.ts codex probe-native-app-server \
  --command /绝对路径/codex \
  --state-dir /绝对路径/已有私有状态目录
```

`--command` 与 `--state-dir` 必须同时提供，且不能与 `--config` 混用。这里的 state directory 只用于
固定可执行文件和阻止 native runtime 指向 Relay 私有目录；探针不会创建或打开 Relay 数据库、
SecretStore、IdentityStore，也不会连接 Hermes。

探针只执行：

1. 固定 Codex CLI 的文件身份并观测 `--version`；
2. 从当前进程环境选择本地 `HOME`，以及已经存在时的 `CODEX_HOME`；
3. 启动独立 `codex app-server --stdio`，通过子进程 argv 注入 workspace-only permission profile，
   并关闭未经审核的 feature；
4. 发送 `initialize` 和 `initialized`；
5. 回读 `codexHome`、client-bound user agent 和平台字段；
6. 关闭并确认 Relay 自己启动的 app-server 进程组已收口。

这些 argv 只作用于 Relay 自己启动的进程，不写本地 `config.toml`，也不改变 Desktop 的 feature 或
permission profile。探针不会调用账号接口、创建或恢复 thread、发送 turn、发起登录、刷新凭据或改变
本地认证状态。

## 3. 为什么不连接 Desktop daemon

“复用当前本地认证状态”和“复用 Desktop 正在运行的 app-server 实例”是两个不同目标。前者只要求
Codex 子进程自行使用当前 runtime；后者还会引入 Desktop session、control socket、WebSocket transport
和外部进程生命周期耦合。

当前目标不要求共享 Desktop thread/session，因此默认启动独立 stdio app-server：

- Relay 已有 app-server NDJSON client 可直接使用官方 stdio transport；
- 子进程读取本机当前 runtime，Relay 不需要读取或复制其中任何文件；
- Relay 只管理自己启动的进程，不会向 Desktop daemon 发送生命周期或 remote-control 操作；
- Desktop 与 Relay 的 thread/session 状态天然分离；
- 本地状态无论正常、未登录、过期或 provider 错误，都由 Codex 在实际调用时返回，Relay 不预判。

旧 `app-server proxy` 方案已经退出主路径。官方 proxy 只是 stdio 与 Unix socket 之间的原始字节复制，
而 Desktop control socket 使用 WebSocket framing；把 NDJSON client 直接接到 proxy 不会完成 WebSocket
upgrade。旧实现和 CLI 已移除，只在本文保留根因与迁移记录。

## 4. 环境与认证所有权

Relay 只把以下非业务内容交给独立 app-server：

- `HOME`；
- 当前环境已经显式存在时的 `CODEX_HOME`；
- 经过绝对路径、存在性和 Relay state directory 排除检查的 `PATH`；
- `TMPDIR`；
- 语言、终端、时区和无颜色输出设置。

其他 daemon 环境不透传。Relay 不打开 HOME/CODEX_HOME 下的账号文件，不访问 Keychain，不读取账号
主体、登录类型、token、scope 或 provider 认证分类。HOME/CODEX_HOME 在本层只是 runtime 选择器；其下
状态的所有权和解释权仍属于 Codex。

执行 attach 会在 initialize 声明 `experimentalApi=true`，因为 `runtimeWorkspaceRoots`、
`approvalsReviewer` 和逐 thread policy 回读属于当前 app-server 的实验协议字段；transport-only probe
仍声明 `false`。这只是协议能力协商，不是账号、凭据或 Desktop remote-control 开关。

执行路径使用 argv 内完整覆盖的 `livis-native-stdio` profile：只读 `:minimal`、只写
`:workspace_roots`、网络关闭，并排除 `TMPDIR` 与 `/tmp`。Relay 不依赖用户预先配置同名 profile，
也不使用内建 `:workspace`，因为真实回读证明内建 profile 不隔离系统临时目录。

`initialize.codexHome` 必须与本次选择的 runtime 一致，并且不能位于 Relay state directory 内。这个
回读只证明进程使用了预期本地 runtime，不证明账号有效，也不会把路径写入公开报告。

## 5. 结果语义

| 状态 | 含义 | 是否证明真实执行正常 |
| --- | --- | --- |
| `ready` | 固定 CLI、独立 stdio app-server、initialize 和进程收口兼容 | 否 |
| `offline` | app-server 无法启动或无法完成 initialize | 否 |
| `incompatible` | runtime 选择器、版本输出或 initialize 响应结构不满足门禁 | 否 |

成功报告固定写明：

- `transport=app-server-stdio`；
- `compatibilityBasis=protocol-handshake`；
- `touchedDesktopDaemon=false`；
- `sentModelTurn=false`；
- `probeProcessClosed=true`；
- `productionReady=false`。

CLI 与 app-server 版本仅用于观测，版本不同本身不阻断；readiness 由真实 initialize 结果裁决。精确版本
若已发现不可安全兼容行为，可以增加带证据的定向拒绝，但不能恢复成静态版本相等门禁。

这里没有 `authentication-required`。本地账号状态错误不会改变 transport readiness；只有未来实际执行
时才由 Codex 返回普通、脱敏的 backend failure，且不会触发 Relay 登录或凭据恢复流程。

## 6. 2026-07-24 本机真实 Gate

在受控权限环境运行 transport-only 探针得到：

- CLI `0.145.0`；
- 独立 app-server `0.145.0`；
- `readiness=ready`；
- `versionRelation=same`；
- 自有探针进程已收口；
- 没有账号读取、thread、turn 或 model 请求。

探针前后只读回读 Desktop daemon 均为：

- PID `72289`；
- 启动时间 `2026-07-13 16:23:14`；
- app-server `0.144.1`；
- control socket 与进程命令未改变。

受限开发沙箱内的首次真实运行因 `Operation not permitted` 失败；同一命令在获授权受控环境重跑后
通过。这属于执行环境限制，不是 Codex transport、版本或本地认证状态失败。

随后在临时 workspace 和 Relay 数据库上完成一次真实 thread/turn canary。最终结果为：

- submission 为 `submitted`；
- 唯一 final 精确为 `NATIVE_STDIO_CANARY_OK`；
- job 为 `Succeeded`，outbox 为 `Pending`；
- attempt ledger 为 `reserved → accepted → succeeded`；
- checkpoint 为 `completed`、turn count 为 `1`；
- session 为 `local-state-opaque`，无 recovery、无 quarantine；
- CLI/app-server 均为 `0.145.0`，transport 为 `app-server-stdio`；
- 自有 stdio app-server 已收口，Desktop daemon PID 和原启动时间未改变。

真实 bring-up 同时发现并修复了四个可证伪的协议问题：

1. 原生子进程最初继承了本地启用的 plugin、hook、browser 等 feature；现改为逐进程 argv 关闭，并按
   实际 feature 属性回读，不绑定精确 CLI 小版本；
2. 本地 runtime 没有私有 `livis-remote` profile；现通过 argv 完整注入独立的
   `livis-native-stdio`，不写用户配置；
3. attach 最初未声明 experimental API，却使用 `runtimeWorkspaceRoots`；现只有执行 attach 声明对应
   capability；
4. 本地 runtime 的 provider 和全局 instruction source 属于当前 Codex 状态。fresh session 接受
   app-server 的实际 provider，把 provider 与有界 instruction-source 路径摘要绑定到 session policy；
   resume 仍要求持久锚点一致。Relay 不读取 instruction 文件内容，也不解释 provider 的认证状态。

## 7. Desktop 不干扰不变量

- 默认路径不得连接 Desktop control socket；
- 不得执行 `app-server daemon start|stop|restart` 或 remote-control 切换；
- Relay 只能 signal 和关闭自己启动并持有进程组身份的 stdio app-server；
- 初始化、执行或收口失败时保持失败关闭，不能触碰 Desktop daemon 进行“修复”；
- 不兼容时不能自动回退到私有 API-key backend；
- 离线自动化只使用测试拥有的 fake app-server，不使用真实 Desktop socket 作为夹具。

## 8. 执行组合与生产接线

[`CodexNativeSessionHarness`](../src/backends/codex/native-session-harness.ts) 已改为通过
[`attachCodexNativeStdio`](../src/backends/codex/native-stdio.ts) 获得独立 app-server，再组合：

- client epoch fencing；
- `not_sent | submitted`；
- accepted、唯一 final、cancel、timeout 与 disconnect；
- native thread policy、checkpoint 和 session resume 状态机；
- active attempt 断线后的持久 recovery/quarantine；
- idle app-server exit 只降低 readiness；
- 旧 epoch 迟到事件不能命中新 client。

离线组合测试继续使用 fake client，不读取真实账号状态；本节第 6 节的受控 canary 已额外证明同一
harness 能完成真实单 turn。显式 `native-current` 由
[`CodexNativeExecutionBackend`](../src/backends/codex/native-execution-backend.ts) 建立
`<stateDir>/backends/codex/native-sessions/<sessionHash>/workspace`，固定 Codex command，并把 harness
接入 `ExecutionBackend`；`daemon.ts` 只在该显式模式下选择它。旧私有 adapter 只在
`mode=private-api-key` 时选择，两个实现不存在异常 fallback。

probe/attachment 中的 `productionReady=false` 表示该报告本身没有发送模型 turn、不能充当生产或
LiViS 闭环证据；它不再表示代码禁止 `serve`。运行中的 status 应显示 `mode=native-current`、
`stateOwnership=local-state-opaque`、`touchedDesktopDaemon=false` 和
`credentialStateInspected=false`。

## 9. 下一验证门禁

在 `codex_native_auth_reuse` 从 `operator-only` 升级为真实 canary 证据前，还必须完成：

1. 从当前部署的 LiViS App 发送唯一文本 canary，核对同一 job 的
   `Succeeded → outbox Delivered → App 回显`；
2. 验证真实 resume、取消、超时、断线和迟到事件的协议形态；
3. 在 Codex Desktop 同时运行时完成更长时段并发 canary，确认 Desktop session 与日常交互不受影响；
4. 绑定精确 commit、CLI/app-server 版本、测试门禁和脱敏 receipt。任一缺失都保持
   `operator-only`，不能用 doctor ready 或 transport probe 代替。
