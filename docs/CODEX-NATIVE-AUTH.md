# Codex 原生当前状态边界

本文说明 LiViS Relay 如何调用本机 Codex 当前 runtime，同时保持账号、登录方式、凭据、provider 和
认证错误对 Relay 完全不透明。

当前主路径是 Relay 自己启动并负责收口的 `codex app-server --stdio` 子进程。它不连接 Codex
Desktop 的 control socket，不依赖 `app-server daemon`，也不会启动、停止、重启、升级或配置 Desktop
daemon。

这项能力仍为实验实现，`codex_native_auth_reuse=unsupported`。transport-only 真实 Gate 已通过不等于
真实 thread/turn、session resume、并发或生产 `serve` 已通过。

## 1. transport-only 探针

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
3. 启动 `[codex, app-server, --stdio]`；
4. 发送 `initialize` 和 `initialized`；
5. 回读 `codexHome`、client-bound user agent 和平台字段；
6. 关闭并确认 Relay 自己启动的 app-server 进程组已收口。

它不会调用账号接口、创建或恢复 thread、发送 turn、发起登录、刷新凭据或改变本地认证状态。

## 2. 为什么不连接 Desktop daemon

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

## 3. 环境与认证所有权

Relay 只把以下非业务内容交给独立 app-server：

- `HOME`；
- 当前环境已经显式存在时的 `CODEX_HOME`；
- 经过绝对路径、存在性和 Relay state directory 排除检查的 `PATH`；
- `TMPDIR`；
- 语言、终端、时区和无颜色输出设置。

其他 daemon 环境不透传。Relay 不打开 HOME/CODEX_HOME 下的账号文件，不访问 Keychain，不读取账号
主体、登录类型、token、scope 或 provider 认证分类。HOME/CODEX_HOME 在本层只是 runtime 选择器；其下
状态的所有权和解释权仍属于 Codex。

`initialize.codexHome` 必须与本次选择的 runtime 一致，并且不能位于 Relay state directory 内。这个
回读只证明进程使用了预期本地 runtime，不证明账号有效，也不会把路径写入公开报告。

## 4. 结果语义

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

## 5. 2026-07-24 本机真实 Gate

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

## 6. Desktop 不干扰不变量

- 默认路径不得连接 Desktop control socket；
- 不得执行 `app-server daemon start|stop|restart` 或 remote-control 切换；
- Relay 只能 signal 和关闭自己启动并持有进程组身份的 stdio app-server；
- 初始化、执行或收口失败时保持失败关闭，不能触碰 Desktop daemon 进行“修复”；
- 不兼容时不能自动回退到私有 API-key backend；
- 离线自动化只使用测试拥有的 fake app-server，不使用真实 Desktop socket 作为夹具。

## 7. 离线执行组合状态

[`CodexNativeSessionHarness`](../src/backends/codex/native-session-harness.ts) 已改为通过
[`attachCodexNativeStdio`](../src/backends/codex/native-stdio.ts) 获得独立 app-server，再组合：

- client epoch fencing；
- `not_sent | submitted`；
- accepted、唯一 final、cancel、timeout 与 disconnect；
- native thread policy、checkpoint 和 session resume 状态机；
- active attempt 断线后的持久 recovery/quarantine；
- idle app-server exit 只降低 readiness；
- 旧 epoch 迟到事件不能命中新 client。

这些组合测试使用 fake client，不读取真实账号状态。组合 harness 仍没有被 `daemon.ts`、`config.ts` 或
生产 `serve` 导入。

## 8. 下一实现门禁

在 `codex_native_auth_reuse` 从 `unsupported` 升级前，还必须完成：

1. 使用独立 stdio app-server 完成一条受控真实 thread/turn，并确认本地错误只作为普通 execution
   failure 返回；
2. 验证 fresh/resume、取消、超时、断线和迟到事件的真实协议形态；
3. 在 Codex Desktop 同时运行时完成并发 canary，前后回读 Desktop PID、版本和 session 不受影响；
4. 明确生产配置中的 native/private 模式选择，禁止静默 fallback；
5. 绑定精确 commit、CLI/app-server 版本、测试门禁和脱敏 receipt 后，才接入 `serve`。
