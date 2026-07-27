# LiViS Relay Daemon

[![CI](https://github.com/Jassy930/livis-relay-daemon/actions/workflows/ci.yml/badge.svg)](https://github.com/Jassy930/livis-relay-daemon/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

在本地把 LiViS 消息连接到 Hermes、Codex 或 Claude Code。

`livis-relay-daemon` 接收 LiViS 文本任务，调用选定的本地 AI 后端，并通过 SQLite 保存任务与回复
投递状态。一套 daemon 同时只使用一个后端，不会自动切换或静默 fallback。

> 当前版本为实验性的第三方兼容实现，不是 LiViS、Hermes、Codex、Claude 或相关厂商的官方组件。

## 主要功能

- 支持 Hermes、Codex 和 Claude Code 本地后端。
- 复用 Codex/Claude 本机当前 runtime 状态，不单独读取、复制或管理其认证凭据。
- 使用 SQLite 持久化 job、执行状态和 durable outbox。
- 支持任务幂等、租约隔离、结果重投和 best-effort 取消。
- 提供状态诊断、后端切换和发布部署命令。
- 可选使用 `AGENTS.md + memory/*.md` 提供个人助手上下文。

```text
LiViS Relay  <-- OAuth + WSS -->  livis-relayd  <-- 本地接口 -->  Hermes / Codex / Claude Code
                                      |
                                      └── SQLite jobs + outbox
```

## 支持的后端

| 后端 | 调用方式 | 状态 |
| --- | --- | --- |
| Hermes | Unix Socket connector + 专用 Hermes Gateway | 已支持，默认后端 |
| Codex `native-current` | `codex app-server --stdio` | 预览；使用本机当前 Codex runtime，不连接 Codex Desktop daemon |
| Codex `private-api-key` | daemon 私有 `CODEX_HOME` | 兼容模式，需显式启用 |
| Claude `native-current` | Claude Code `stream-json` | 预览；当前仅支持无工具、无持久会话的纯文本任务 |

daemon 只管理 LiViS OAuth。本地后端的账号和认证仍由各自客户端管理，本机当前是什么状态就按什么
状态调用。详细说明见[本地后端文档](docs/LOCAL-BACKENDS.md)。

## 快速开始

### 环境要求

- macOS 或 Linux
- Bun 1.3.14 或更高版本
- Python 3.11–3.13 与 uv（Hermes plugin）
- 获授权的 LiViS protocol profile
- 所需的 Hermes、Codex 或 Claude Code runtime

### 安装依赖

```bash
git clone https://github.com/Jassy930/livis-relay-daemon.git
cd livis-relay-daemon
bun install --frozen-lockfile
(cd hermes-plugin && uv sync --frozen)
bun run check
```

### 初始化

公开仓库不提供可直接连接服务的 live profile。取得获授权的 profile 后运行：

```bash
bun run src/index.ts init \
  --profile '/绝对路径/authorized-profile.json' \
  --acknowledge-unofficial-protocol
```

在 `~/.livis-relay/config.json` 中设置唯一允许的 `security.allowedNodeIds`，然后执行：

```bash
bun run src/index.ts upstream check
bun run src/index.ts login
```

完整配置步骤见[运行手册](docs/OPERATIONS.md)。

### 选择后端

- Hermes 是默认后端，需要专用 profile 和 Hermes bridge。
- Codex 使用 `codex probe-native-app-server` 检查本地接口，再通过 `backend switch codex` 切换。
- Claude 使用 `claude probe-native-cli` 检查本地接口，再通过 `backend switch claude` 切换。

`backend switch` 默认只输出计划。实际切换需要先停止 daemon、备份 state directory，再显式使用
`--apply`。具体命令见 [Codex native-current](docs/CODEX-NATIVE-AUTH.md)、
[Claude native-current](docs/CLAUDE-NATIVE.md)和[运行手册](docs/OPERATIONS.md)。

### 启动

```bash
bun run src/index.ts serve
```

另开终端查看状态：

```bash
bun run src/index.ts status
bun run src/index.ts doctor --online
```

Hermes 模式还需要启动专用 Hermes Gateway；Codex 和 Claude 模式只需启动 daemon。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `bun run src/index.ts capabilities` | 查看能力清单 |
| `bun run src/index.ts init` | 初始化配置与 state directory |
| `bun run src/index.ts login` | 登录 LiViS |
| `bun run src/index.ts serve` | 启动 daemon |
| `bun run src/index.ts status` | 查看运行状态 |
| `bun run src/index.ts doctor --online` | 执行在线诊断 |
| `bun run src/index.ts backend switch ...` | 切换执行后端 |
| `bun run src/index.ts deploy ...` | 安装、升级、回滚或卸载 |

运行 `bun run src/index.ts help` 查看完整参数。

## 个人助手上下文

Codex 和 Claude 可以读取由操作者维护的 `AGENTS.md` 与 Markdown 记忆文件：

```json
{
  "assistantContext": {
    "mode": "read-only-files",
    "contextDir": "/绝对路径/assistant-scope",
    "maxPromptChars": 20000
  }
}
```

`contextDir` 必须位于 daemon state directory 外。daemon 会生成 workspace 快照，但不会自动修改或
写回原始文件。详见[个人助手上下文](docs/ASSISTANT-CONTEXT.md)。

## 部署

正式运行建议使用 `deploy` 安装器，而不是直接使用开发 checkout。安装器通过固定 SHA-256 的
`release-manifest.json` 验证发布内容，并支持 `plan`、`install`、`upgrade`、`rollback` 和
`uninstall`。

```bash
bun run src/index.ts deploy plan \
  --manifest '/绝对路径/release-manifest.json' \
  --manifest-sha256 '<manifest-sha256>' \
  --config "$HOME/.livis-relay/config.json"
```

完整安装与回滚步骤见[部署说明](docs/DEPLOYMENT-INSTALLER.md)。

## 当前限制

- 一套 daemon 只支持一个 LiViS `node_id` 和一个执行后端。
- 当前只支持纯文本输入和单个 final 文本回复。
- 不支持在线多后端路由、自动 fallback 或跨后端会话迁移。
- 不支持附件、流式回复、tool progress、远程审批和远程管理命令。
- `status` 或 `doctor` 通过只表示服务就绪，不代表真实消息已完成端到端投递。

完整能力范围以 [`capabilities.json`](capabilities.json) 为准。

## 开发

```bash
bun run check
```

这是项目的统一检查入口，包含版本、能力、文档、类型、Bun 测试和 Hermes plugin 测试。
参与开发前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 文档

- [运行手册](docs/OPERATIONS.md)
- [架构说明](docs/ARCHITECTURE.md)
- [本地后端](docs/LOCAL-BACKENDS.md)
- [安全边界](docs/SECURITY.md)
- [部署安装器](docs/DEPLOYMENT-INSTALLER.md)
- [个人助手上下文](docs/ASSISTANT-CONTEXT.md)
- [能力清单](docs/CAPABILITIES.md)
- [LiViS 协议边界](docs/LIVIS-RELAY-PROTOCOL-BOUNDARY.md)

## 许可证

本项目自主实现的代码采用 [MIT License](LICENSE)。第三方服务、协议和商标不因本项目许可证而获得
授权，详见 [NOTICE](NOTICE.md)。
