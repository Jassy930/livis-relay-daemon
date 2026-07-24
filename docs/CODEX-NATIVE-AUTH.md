# Codex 原生本地状态不透明边界

本文记录阶段 B 的原生 Codex 边界：`livis-relayd` 只连接本机已经存在的 Codex app-server
daemon，并使用本地当前状态执行。relay 不读取、判断、绑定、刷新或修复账号与凭据状态。

本地未登录、账号切换、provider 拒绝或其他运行时错误都由 Codex 自己产生；relay 不在派发前
拦截，也不把其中任何一种识别成特殊认证状态。只要 transport 可连接且协议兼容，就直接调用；
执行失败按普通 backend failed 结算，不自动重试、不 fallback，也不隔离账号。

当前实现仍是离线原型，不会把 `codex_native_auth_reuse` 提升为已支持。

## 1. Transport-only 探针

先由操作者独立确认原生 Codex app-server daemon 已按官方方式运行，并取得它报告的绝对 Unix
socket 路径。探针不会启动、重启、停止 daemon，也不会替操作者启用 remote control。

```bash
bun run src/index.ts codex probe-native-daemon \
  --config /绝对路径/config.json \
  --socket /绝对路径/app-server-control.sock
```

配置中的 `codex.command` 必须是 stateDir 外的绝对路径。成功只证明 transport 可以安全握手，
输出中的 `productionReady` 仍固定为 `false`。

探针按以下顺序失败关闭：

1. 解析并固定 Codex CLI 的 canonical 可执行文件及内容身份；
2. 运行 `codex --version`，要求位于仓库审核窗口；
3. 运行官方 `codex app-server daemon version`，要求 daemon 已运行、管理 CLI 版本一致，且运行中
   app-server 位于同一审核窗口；
4. 要求 daemon 报告的 socket 与操作者显式传入值完全一致；socket 必须是当前用户持有的
   `0600` Unix socket，直属父目录必须是同一用户持有的固定 `0700` 普通目录；
5. 通过 `codex app-server proxy --sock ...` 完成 `initialize` / `initialized`；
6. 随后只关闭本次 proxy 子进程，不停止原生 daemon。

探针不调用账号接口，不创建 thread、不发送 turn、不调用模型，也不触发登录、注销或任何认证
状态变更。

## 2. 环境与状态边界

`daemon version` 是唯一允许看到原生 `HOME`/`CODEX_HOME` 选择器的官方只读管理命令；它只继承
这两个选择器和固定 locale/terminal 白名单，不继承 API key、LiViS 或其他任意环境变量。

`app-server proxy` 使用更窄的环境白名单：不包含 `HOME`、`CODEX_HOME`、`PATH` 或 daemon 的其他
环境。它只能连接已固定的绝对 socket，因此 relay 进程无需读取、复制、链接或导出原生状态文件。

initialize 必须证明原生 runtime 的 `codexHome` 位于 relay stateDir 之外。返回路径只用于进程内
比较，不进入报告。

## 3. 结果语义

| 状态 | 含义 | 是否证明本地执行正常 |
| --- | --- | --- |
| `ready` | CLI、socket、proxy 与 initialize transport 兼容 | 否 |
| `offline` | daemon 未运行或 proxy 无法 initialize | 否 |
| `incompatible` | CLI/app-server 版本、socket 身份或 initialize 不满足门禁 | 否 |

这里没有 `authentication-required`。本地 backend 即使处于未登录或 provider 错误状态，transport
仍可为 `ready`；具体错误只有执行时由本地 backend 返回。relay 不提前判定。

报告只把 `native-daemon-transport` 列为已验证。server config 隔离、thread/turn 生命周期、session
resume、真实执行状态和 Desktop/CLI 并发仍明确未验证。

## 4. 2026-07-24 本机历史观察

当时固定 CLI 为 `0.145.0`，运行中的原生 app-server 为 `0.144.1`，因此探针在连接 proxy 前返回
`native_daemon_version_incompatible`。该记录只是历史快照，本轮离线开发没有重新读取真实端点。

relay 不会为了通过门禁而启动、停止、重启、替换或升级 Desktop 及其原生 daemon，也不会启用或
关闭 remote control。

## 5. Desktop 不干扰不变量

- relay 只能连接操作者显式配置、已经存在且通过版本与文件身份门禁的 socket；
- 版本不兼容、端点离线或协议不兼容时保持失败关闭，不执行修复性生命周期操作；
- relay 关闭的只能是自己启动的 proxy 子进程，不能向原生 daemon 发送停止、重启、升级、
  remote-control 切换或状态变更请求；
- 离线测试只能连接测试拥有的 fake proxy/daemon，不得把真实 Desktop socket 作为夹具；
- 不兼容时不能自动回退到现有私有 API-key backend；目标端点必须来自操作者显式配置。

## 6. 离线执行生命周期原型

[`CodexNativeExecutionLifecycle`](../src/backends/codex/native-execution-lifecycle.ts) 接收已经由上层建立
的 proxy client，只负责把 turn 事件映射为 `ExecutionBackend` 既有语义。它不连接 socket、不读取
账号状态、不管理原生 daemon，也没有被 `daemon.ts` 或 `serve` 导入。

[`codex_native_execution_lifecycle.test.ts`](../tests/codex_native_execution_lifecycle.test.ts) 使用 fake
proxy 验证：

- 只有 `turn/start` 可证明未写入时才返回 `not_sent`，其余提交不确定性进入 ambiguous disconnect；
- accepted handler 完成后才允许交付 terminal，重复 terminal 只产生一个 final；
- 任意本地 backend failed 都按普通、脱敏、不可自动重试的 failed 结算，不识别账号类型，不设置
  `credential_rejected`，也不因此断开或 quarantine session；
- cancel、terminal timeout 和 proxy 意外退出按现有 fencing/disconnect 语义收口；
- lifecycle stop 只关闭测试 proxy，fake 原生 daemon 保持运行且零生命周期调用。

## 7. 离线 thread 安全与 checkpoint 原型

[`prepareCodexNativeThread`](../src/backends/codex/native-thread-policy.ts) 继续只接收测试或上层已经建立
的 client。它在创建或恢复 thread 前回读 permission profile 与 feature 快照，固定 workspace、审批、
model/provider 和 sandbox，关闭 memory，并验证 fresh/resume checkpoint。

这些是执行隔离与结果归属门禁，不是账号门禁。thread 无法创建或恢复时按 transport、协议、提交
可证明性与 checkpoint 语义失败，不推断原因是否与本地认证有关。

## 8. 纯 client epoch fencing

[`CodexNativeClientEpochFence`](../src/backends/codex/native-client-epoch.ts) 每次 proxy attach 只分配递增
epoch。receipt 只包含 epoch 和 `productionReady=false`，不发 RPC，也不保存账号、主体哈希或认证
状态。

notification、proxy exit 和 turn timeout 都绑定产生它们的 epoch。新 attach 会 fence 旧 epoch；旧
proxy 的迟到 terminal、exit 或 timer 不会结算、断开或 interrupt 新 proxy。每个新 epoch 使用新的
lifecycle 实例，不复用旧 active attempt 或 accepted gate。

[`codex_native_client_epoch.test.ts`](../tests/codex_native_client_epoch.test.ts) 与 lifecycle fake 测试覆盖
上述边界。epoch fence 不决定恢复时机；未来持久 coordinator 仍必须先结算或隔离旧 active attempt。

## 9. 持久 session coordinator

[`CodexNativeSessionCoordinator`](../src/backends/codex/native-session-coordinator.ts) 已用纯离线 fake
client 组合 epoch、thread policy/checkpoint、JobStore job/lease/run generation 与 lifecycle。它没有被
`daemon.ts`、`index.ts`、`config.ts` 或生产 `serve` 导入。

JobStore schema v8 为 backend session 与 attempt ledger 增加显式状态所有权：

- 既有 daemon 私有 runtime 为 `account-bound`，继续沿用原安全边界；
- 本地当前状态路径为 `local-state-opaque`，账号类型、主体摘要和身份强度列必须保持 `NULL`；
- fresh thread 与初始 checkpoint 在同一 SQLite 事务中创建，避免留下已知 thread 但未绑定 session
  的中间状态；
- idle 重开只允许同一 workspace、CLI、model/provider、policy/feature 摘要和 checkpoint 的精确
  `thread/resume`；
- 历史 active/recovery、持久 metadata 漂移、thread/checkpoint 漂移或提交不确定都进入 ambiguous
  quarantine，不创建替代 thread，也不自动重发；
- terminal 必须先用 job/lease/run generation/turn fence 原子 checkpoint，再交给既有 daemon handler
  结算 job/outbox；普通 backend failed 不隔离 session，下一 job 仍可继续调用当前本地状态；
- 新 epoch fence 旧 proxy 的迟到 exit/notification；`stop()` 只关闭 relay 自己的 proxy client。

[`codex_native_session_coordinator.test.ts`](../tests/codex_native_session_coordinator.test.ts) 覆盖 fresh 原子
绑定、跨 Store 重开的 idle resume、active ambiguous quarantine、普通 failed 后继续执行、attempt
账本不保存本地状态详情和旧 epoch exit。测试没有连接真实 socket，也没有操作 Desktop 生命周期。

## 10. 受控 transport + coordinator 组合 harness

[`attachCodexNativeDaemon`](../src/backends/codex/native-daemon.ts) 已从一次性探针中抽出可由调用方持有的
attach：复用同一 CLI、只读 daemon report、socket identity、环境白名单和 initialize 门禁，成功后
返回 relay 自己启动的 proxy client。它仍不启动或停止原生 daemon，不读取账号状态，也不创建
thread。initialize 失败且进程组收口无法确认时显式返回 `native_proxy_close_unconfirmed`，不能降格为
普通 offline。

[`CodexNativeSessionHarness`](../src/backends/codex/native-session-harness.ts) 只在测试中把这个 attach 与
持久 coordinator 组合。proxy 构造时固定的 notification callback 在 coordinator ready 后绑定其确切
client epoch；绑定前没有合法 active attempt，期间 notification 只计数并丢弃内容。harness 的资源
所有权只包括 relay 自己启动的 proxy client，`stop()` 不向原生 daemon 发送生命周期请求。

[`codex_native_session_harness.test.ts`](../tests/codex_native_session_harness.test.ts) 使用注入式 fake
daemon report、socket pin 和 proxy，覆盖：

- initialize 后 notification 绑定、成功 dispatch、terminal checkpoint 和唯一 final；
- proxy 环境不获得 API key、OAuth token、`HOME` 或 `CODEX_HOME`；
- attach 校验失败、initialize/close 双失败和 coordinator preflight 失败的所有权收口；
- active proxy exit/terminal timeout 进入持久 recovery/quarantine，idle exit 只降低 transport
  readiness、不错误隔离 session；
- 旧 epoch 的 exit、timeout 与迟到 notification 不影响新 epoch；
- harness 与 `daemon.ts`、`index.ts`、`config.ts` 保持双向未接线。

这些仍是纯离线证据。测试没有连接真实 Desktop/socket，没有读取本机当前状态，也没有改变 capability
状态。

## 11. 下一实现门禁

离线 attach 与执行状态组合已经完成，下一阶段仍不引入账号处理：

1. 在另行授权前不运行真实 Desktop/CLI canary；下一真实门禁是并发、逐 thread 隔离、被动 daemon
   重启恢复与 Desktop 不干扰，不是账号状态探测；
2. canary 必须使用操作者显式配置的现有 socket，不启动、停止、重启、升级或修改 Desktop daemon；
3. 保持 coordinator/harness 不读取或持久化 account type、主体、登录状态、token、scope 或 provider
   认证分类；本地错误继续按普通 execution failed；
4. 在真实证据闭合前不导入 `daemon.ts`、`index.ts`、`config.ts`，不修改
   `codex_native_auth_reuse=unsupported`，也不接入自动 fallback。

即使离线组合 harness 已完成，能力仍保持 `unsupported`，直到 Desktop 不干扰和真实并发 canary
分别闭合。
