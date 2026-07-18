# 发布流程

当前 daemon 与 Hermes bridge 共用一个 SemVer 版本。版本同时存在于：

- `package.json`
- `src/daemon.ts` 的 `DAEMON_VERSION`
- `hermes-plugin/pyproject.toml`
- `hermes-plugin/plugin.yaml`
- `hermes-plugin/adapter.py` 的 `PLUGIN_VERSION`

`bun run version:check` 会拒绝不一致版本。

## 发布候选

1. 更新上述版本和 `CHANGELOG.md`。
2. 在独立 Git 仓库的干净 checkout 中执行 `bun install --frozen-lockfile` 和 `uv sync --frozen`。
3. 用 `git add` 更新候选 index，再执行 `bun run check`。其中 `release:check` 直接读取 `git ls-files -z` 与 index blob，不以 `.gitignore` 或工作区文件清单代替 tracked-files 审计。
4. 确认公开树不包含 live profile、token、数据库、日志、artifact、`node_modules` 或 `.venv`。
5. 等待 GitHub Actions 的 macOS/Linux 与 Python 3.11–3.13 矩阵通过。
6. 从 Git tracked files 的干净 checkout 构建 Hermes plugin 归档，只包含 `plugin.yaml`、`__init__.py`、`adapter.py`、README、LICENSE 和 NOTICE。
7. 对发布归档生成 SHA-256，做一次解压、plugin 加载和 UDS canary。
8. 创建签名 tag `vX.Y.Z`，再创建 GitHub Release 并附归档与 SHA-256。

## Tracked-files 安全门禁

`bun run release:check` 必须在项目 Git 顶层运行。未初始化仓库、空 index、嵌套在其他仓库、未合并 index、tracked symlink/submodule 都会 fail closed。

门禁至少拒绝本地 profile、数据库/WAL/SHM、日志、PEM/key、`.env`、官方 `bundle.js`、归档、`upstream-artifacts/`、依赖目录，以及常见 token/identity/secret/state 文件。内容检查读取 index blob，而不是可能尚未 staged 的工作区版本：

- 运行时代码、配置与数据不得包含已知生产 LiViS 域名；
- Markdown、RST、TXT 文档可为安全审计和来源说明提及生产域名；
- 官方 OAuth client identity 只以 SHA-256 指纹识别，所有文本文件均无例外，仓库不保存或打印原始值；
- 私钥头在任意文本文件中都会被拒绝。

该门禁只证明当前 Git index 未命中这些规则，不代替提交历史扫描、GitHub secret scanning 或人工 diff 审阅。

初始公开仓库只发布源码，不自动创建 Release；在跨语言 UDS canary 和真实 Hermes 候选版本验证完成前，不应把 `v0.1.0` 标记为稳定版。
