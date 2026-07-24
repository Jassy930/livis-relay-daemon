# Codex 原生当前认证复用探针

本文记录阶段 B 的第一个实现切片：只读验证本机 Codex app-server daemon 是否能作为
`livis-relayd` 的原生认证所有者。该探针不是生产 backend，也不会把
`codex_native_auth_reuse` 提升为已支持。

## 1. 使用方式

先由操作者独立确认原生 Codex app-server daemon 已按官方方式运行，并取得它报告的绝对
Unix socket 路径。探针不会启动、重启、停止 daemon，也不会替操作者启用 remote control。

```bash
bun run src/index.ts codex probe-native-daemon \
  --config /绝对路径/config.json \
  --socket /绝对路径/app-server-control.sock
```

配置中的 `codex.command` 必须是 stateDir 外的绝对路径。该命令是只读诊断入口；成功只表示
transport 与当前认证状态可被观察，输出中的 `productionReady` 仍固定为 `false`。

## 2. 探针实际执行的动作

探针按以下顺序失败关闭：

1. 解析并固定 Codex CLI 的 canonical 可执行文件及内容身份；
2. 运行 `codex --version`，要求位于仓库审核窗口；
3. 运行官方 `codex app-server daemon version`，要求 daemon 已运行、管理 CLI 版本一致，且
   运行中 app-server 也位于同一审核窗口；
4. 要求 daemon 报告的 socket 与操作者显式传入值完全一致；socket 必须是当前用户持有的
   `0600` Unix socket，直属父目录必须是同一用户持有的固定 `0700` 普通目录；
5. 通过 `codex app-server proxy --sock ...` 连接该 socket，只发送 `initialize`、`initialized`
   和 `account/read(refreshToken=false)`；
6. 只输出标准化 `ready` 或 `authentication-required`，不输出账号、邮箱、套餐、token、scope、
   cookie 或原始 provider 错误；随后只关闭本次 proxy 子进程，不停止原生 daemon。

整个路径不会创建 thread、发送 turn、调用模型、触发登录/注销或修改认证状态。

## 3. 环境与状态边界

`daemon version` 是唯一允许看到原生 `HOME`/`CODEX_HOME` 选择器的官方只读管理命令；它只继承
这两个选择器和固定 locale/terminal 白名单，不继承 API key、LiViS 或其他任意环境变量。

`app-server proxy` 使用更窄的环境白名单：不包含 `HOME`、`CODEX_HOME`、`PATH` 或 daemon 的
其他环境。它只能连接已固定的绝对 socket，因此 relay 进程无需读取、复制、链接或导出原生
认证文件。

initialize 还必须证明原生 runtime 的 `codexHome` 位于 relay stateDir 之外。返回路径只用于
进程内比较，不进入报告。

## 4. 结果语义

| 状态 | 含义 | 是否允许生产派发 |
| --- | --- | --- |
| `ready` | proxy 握手成功，`account/read` 返回已审核的非空认证形态 | 否 |
| `authentication-required` | transport 正常，但原生 Codex 当前未认证 | 否 |
| `offline` | daemon 未运行或 proxy 无法完成 initialize | 否 |
| `incompatible` | CLI/app-server 版本、socket 身份或协议响应不满足门禁 | 否 |

即使 `ready`，报告也只把 `native-daemon-transport` 和 `native-authentication-state` 列为已验证。
server config 隔离、thread/turn 生命周期、session resume 和 Desktop/CLI 并发仍明确未验证。

## 5. 2026-07-24 本机只读观察

固定 CLI 为 `0.145.0`，运行中的原生 app-server 为 `0.144.1`。因此当前探针在连接 proxy 前
返回 `native_daemon_version_incompatible`；不会为了通过门禁而重启用户 daemon。此前一次只读
proxy initialize 尝试在 5 秒内未得到响应，没有创建 thread、调用模型或改写认证状态。

该观察是本机当时状态，不是协议长期结论。版本更新或原生 daemon 重启后必须重新运行探针。

## 6. 下一实现门禁

在生产接线前还必须独立闭合：

1. 操作者把管理 CLI 与运行中 app-server 对齐到同一审核窗口，并得到 `ready` 探针；
2. 证明共享原生 daemon 时，LiViS thread 能以逐 thread 的固定审批、sandbox、工具和网络策略
   隔离，不依赖或改写用户默认 config；
3. 把 proxy transport 映射到 `ExecutionBackend` 的 `not_sent | submitted`、accepted、唯一 final、
   credential-rejected、disconnect 与 ambiguous execution 语义；
4. 覆盖 Desktop/CLI 并发、运行中注销/切换、daemon 重启、resume 和旧事件 fencing；
5. 完成不复制凭据的受控本机 canary 后，才允许修改机器可读 capability 状态。
