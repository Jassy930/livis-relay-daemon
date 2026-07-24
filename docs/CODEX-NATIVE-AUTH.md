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

该观察是本机当时状态，不是协议长期结论。只能等待 Codex Desktop 与其原生 daemon 按用户
正常使用流程自然升级到兼容版本后重新运行探针，或由操作者显式提供另一个与 Desktop 生命周期
完全独立的兼容端点。relay 不得为了让探针通过而启动、停止、重启、替换或升级 Desktop 及其
原生 daemon，也不得启用或关闭 remote control。

## 6. Desktop 不干扰不变量

后续实现与测试必须把当前 Codex Desktop 视为用户拥有的外部系统：

- relay 只能连接操作者显式配置、已经存在且通过版本与文件身份门禁的 socket；
- 版本不兼容、端点离线或协议不兼容时保持 `incompatible` / `offline`，不做修复性生命周期操作；
- relay 关闭的只能是自己启动的 `app-server proxy` 子进程，不能向原生 daemon 发送停止、重启、
  升级、remote-control 切换或认证变更请求；
- 离线开发只能连接测试拥有的 fake proxy/daemon，不得把真实 Desktop socket 作为自动化测试夹具；
- 不兼容时不能自动回退到现有私有 API-key 后端；认证模式和目标端点都必须来自操作者显式配置。

## 7. 下一实现门禁

在生产接线前还必须独立闭合：

1. 等待 Desktop/原生 daemon 自然进入同一审核窗口，或连接另一个不影响 Desktop 的兼容端点，
   并得到 `ready` 探针；relay 不执行任何对齐、升级或重启动作；
2. 证明共享原生 daemon 时，LiViS thread 能以逐 thread 的固定审批、sandbox、工具和网络策略
   隔离，不依赖或改写用户默认 config；
3. 把 proxy transport 映射到 `ExecutionBackend` 的 `not_sent | submitted`、accepted、唯一 final、
   credential-rejected、disconnect 与 ambiguous execution 语义；
4. 用 fake 端点覆盖 transport 生命周期、运行中注销/切换、被动观察到的 daemon 重启、resume 和
   旧事件 fencing；真实 Desktop/CLI 并发只能在另行授权的非生产 canary 中验证；
5. 完成不复制凭据的受控本机 canary 后，才允许修改机器可读 capability 状态。
