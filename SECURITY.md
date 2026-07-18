# 漏洞报告政策

## 支持范围

| 版本 | 安全更新 |
|---|---|
| `0.1.x` | 支持 |
| 更早版本 | 不支持 |

## 私下报告

请使用 GitHub 的 [Private Vulnerability Reporting](https://github.com/Jassy930/livis-relay-daemon/security/advisories/new) 提交安全问题。不要在公开 issue 中粘贴真实 token、消息内容、身份文件、数据库或可直接利用的攻击细节。

报告最好包含：

- 受影响版本和运行环境；
- 最小复现步骤；
- 预期与实际行为；
- 安全影响和可能的缓解方式；
- 已确认可公开的日志或测试 fixture。

维护者会尽量在 7 天内确认收到报告，在确认影响后协调修复和披露时间；这不是商业 SLA。

## 范围说明

本政策覆盖本仓库自主实现的 daemon、Hermes bridge、IPC、状态存储和更新门禁。LiViS、Hermes、OpenClaw 或其他上游服务自身的漏洞，应优先报告给对应供应方。运行时安全默认值和已知边界见 [docs/SECURITY.md](docs/SECURITY.md)。
