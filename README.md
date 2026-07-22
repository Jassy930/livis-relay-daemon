# LiViS 共享 Relay Daemon（一期：Hermes）

[![CI](https://github.com/Jassy930/livis-relay-daemon/actions/workflows/ci.yml/badge.svg)](https://github.com/Jassy930/livis-relay-daemon/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

这是一个独立于 LiViS 官方 OpenClaw 插件、也独立于 Hermes core 的本地 relay daemon。当前协议实现基于对 LiViS v2.0.0 wire 行为的静态观察，把消息可靠地交给专用 Hermes Gateway；服务端事实、历史 canary 与未知项以[协议证据边界](docs/LIVIS-RELAY-PROTOCOL-BOUNDARY.md)为准。

> 当前属于实验性的第三方兼容实现，不是理想或 Hermes 官方组件，也不代表任何官方背书。本仓库不包含或再分发官方 bundle；使用者在连接相关服务前，应自行确认适用的服务条款、协议权限和数据合规要求。

公开仓库不附带可直连生产服务的 live profile，也不默认复用任何官方 OAuth 客户端身份。运行前必须准备自己有权使用的 profile，详见 [`protocol-profiles/README.md`](protocol-profiles/README.md)。

```mermaid
flowchart LR
    L["理想同学 / LiViS Relay"] <-->|"OAuth + WSS"| D["livis-relayd\nBun / SQLite"]
    D <-->|"UDS WebSocket\nBearer + lease"| P["Hermes livis-bridge plugin"]
    P <--> H["专用 Hermes Gateway\n只读工具配置"]
```

## 一期边界

- 只接 Hermes，不接 AionUI/AionCore。
- 只支持纯文本、单个 final result。
- 一期暂将 LiViS `node_id` 视为设备来源标识；每套 daemon、config 与 state directory 只允许一个预先配置的 `node_id`。
- 不支持多设备同时接入、跨设备共享 Hermes 会话或原地换设备。
- Hermes 必须使用专用 profile、专用工作区和只读工具集。
- 不支持远程审批、附件、token stream、tool progress、管理命令和远程 `/update`。
- 取消语义为 `best_effort`；无法证明工具线程退出时进入 `CancelUnknown` 并隔离 session。

## 可靠性与安全特性

- `(agent, job_id)` 幂等和 payload hash 冲突检测（一期单账号，account 维度固定为本地占位值）。
- SQLite durable outbox；Agent 至多执行一次，ACK/结果至少投递一次。
- `lease_id + run_generation` fencing，同 session 单活。
- cancel/final 使用 CAS 决定唯一赢家；ambiguous execution 不自动重跑。
- Hermes connector 只开放权限 `0600` 的 Unix socket，不监听 TCP。
- LiViS profile 按 SHA-256 固定；未知 wire protocol、版本或 artifact 漂移默认拒绝。
- `login/serve` 要求近期 supported proof；daemon 每 6 小时在线复核。
- `wireContractRevision + credentialMode` 同时绑定 profile、runtime digest 与 supported proof；机器可读 registry、append-only 历史门禁和本地脱敏 probe artifact 防止 wire 代码静默漂移或覆写旧基线。
- schema v1→v2 迁移采用固定 contract 人工确认、私有 PREPARED/备份、source→target 重建校验、持久化 guard、proof quarantine 和可自愈显式回滚；迁移命令不打开 SQLite。
- Hermes runtime 与 bridge 都必须位于审核版本区间，未知未来版本不会自动放行。

## 开发验证

### 环境要求

- macOS 或 Linux；不支持 Windows。
- Bun 1.3.14+；CI 与锁文件基线为 1.3.14。
- uv 0.11+ 与 Python 3.11–3.13。
- 本地 Hermes 版本须位于配置中的已审核范围。

### 获取与验证

```bash
git clone https://github.com/Jassy930/livis-relay-daemon.git
cd livis-relay-daemon
bun install --frozen-lockfile
bun run check
```

`bun run check` 会依次检查版本、文档链接、Git tracked files、wire contract append-only 历史与本地 S2 protocol probe artifact，再执行 TypeScript 类型检查、全部 Bun 测试、`uv lock --check` 和 Hermes plugin pytest。其中公开发布与 append-only 门禁审核 Git index；probe generator、类型检查和测试读取当前工作区。运行前应先用 `git add` 精确暂存候选文件，并保持 staged/worktree 一致。

截至 2026-07-18 的本地验收：

- 57 项 Bun 测试通过（含 fake LiViS 端到端、SQLite、UDS connector、Python 跨语言往返、Device Flow 428、更新/回滚、proof 与公开发布门禁）。
- 22 项 Hermes plugin pytest 通过，真实 Hermes 0.15.1 package import/runtimeVersion smoke 通过。
- 使用本地未纳入版本控制的研究 profile，临时目录 `init → upstream check → doctor` 已通过；该 profile 不随公开仓库分发。
- 状态文件、SQLite、WAL 和 SHM 权限均读回为 `0600`。
- 已使用隔离的 Hermes 0.15.1 profile 完成真实 Device Flow 登录、Agent ID 绑定和 LiViS v2.0.0 消息 canary：入站任务进入 Hermes、模型生成纯文本结果、durable outbox 收到 `ack_send_result` 并进入 `Delivered`。
- 首次会话必须先发送 `/sethome`；Hermes 的一次性 home-channel 提示会占用一期协议允许的唯一 final。完整证据、操作顺序和限制见 [`docs/HERMES-CANARY.md`](docs/HERMES-CANARY.md)。
- 本地 canary 当前以前台进程运行，尚未安装 launchd/systemd 常驻服务；默认 Hermes profile 未被修改。

## 使用入口

- [LiViS 服务端协议证据与支持边界](docs/LIVIS-RELAY-PROTOCOL-BOUNDARY.md)
- [本地协议探针](docs/PROTOCOL-PROBES.md)
- [运行手册](docs/OPERATIONS.md)
- [Hermes 实网 canary](docs/HERMES-CANARY.md)
- [官方升级与回滚](docs/UPSTREAM-UPGRADE.md)
- [普通 profile 激活事务](docs/PROFILE-ACTIVATION.md)
- [版本与发布流程](docs/RELEASING.md)
- [架构与状态所有权](docs/ARCHITECTURE.md)
- [安全边界](docs/SECURITY.md)
- [参与贡献](CONTRIBUTING.md)
- [漏洞报告政策](SECURITY.md)
- [第三方与商标声明](NOTICE.md)

初始化前先审阅安全文档；不要直接执行 LiViS 的 `curl | bash` 安装器来部署本项目。

## 许可证

本项目自主实现的代码采用 [MIT License](LICENSE)。LiViS、理想、Hermes、OpenClaw 等名称、服务、协议和商标不因本项目许可证而获得授权，详见 [NOTICE](NOTICE.md)。
