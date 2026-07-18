# 参与贡献

感谢你愿意改进 LiViS Relay Daemon。当前项目仍处于一期实验阶段，安全边界和兼容证据优先于功能数量。

## 开始之前

1. 阅读 [架构](docs/ARCHITECTURE.md)、[安全边界](docs/SECURITY.md) 和 [升级流程](docs/UPSTREAM-UPGRADE.md)。
2. 功能改动建议先创建 issue，说明使用场景、协议证据和安全影响。
3. 安全漏洞不要创建公开 issue，按 [SECURITY.md](SECURITY.md) 私下报告。

## 开发环境

项目只支持 macOS/Linux，依赖使用 Bun 和 uv 管理：

```bash
bun install --frozen-lockfile
cd hermes-plugin
uv sync --frozen
cd ..
bun run check
```

不要使用 npm/yarn/pnpm 或 pip 直接改写锁文件。

## 变更要求

- 做最小必要改动，避免无关重构。
- 新行为必须有自动化测试；修复竞态时需要确定性 oracle。
- 文档默认使用中文；标识符和协议字段保持上游原名。
- 不提交 token、真实消息、身份文件、SQLite、日志、candidate artifact 或本机绝对路径。
- 不复制 LiViS 官方 bundle、反编译输出或其他未获许可的上游源代码。
- 未提供可再分发授权证据时，不接受包含厂商生产端点或官方 OAuth 客户端身份的 live profile。
- 贡献内容必须是你有权以 MIT License 提交的原创实现。

## Protocol profile 更新

新增或修改 `protocol-profiles/` 时，PR 必须同时提供：

- 官方版本与最终下载 URL；
- setup、install 和 package 的 SHA-256；
- wire marker 与 golden fixture 的差异；
- 运行契约 fingerprint 是否变化；
- `upstream check`、完整测试和回滚验证结果。
- profile 参数的使用与再分发授权边界；不能公开的内容应保留在本地 ignored profile。

仅出现字符串 marker 不等于兼容已证明。IDaaS、relay、OAuth、wire identity、timing 或 wire protocol 变化必须作为 daemon 版本升级审查。

## Pull Request

PR 描述应说明：改了什么、为什么、用户影响、安全影响以及验证命令。提交前执行：

```bash
bun run check
```

维护者可能要求补充 fake relay、崩溃窗口、重复投递、取消竞态或真实 Hermes 候选版本 smoke 证据。
