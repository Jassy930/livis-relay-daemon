# 发布流程

当前 daemon 与 Hermes bridge 共用一个 SemVer 版本。版本同时存在于：

- `package.json`
- `src/daemon.ts` 的 `DAEMON_VERSION`
- `hermes-plugin/pyproject.toml`
- `hermes-plugin/plugin.yaml`
- `hermes-plugin/adapter.py` 的 `PLUGIN_VERSION`
- `capabilities.json` 的 `package.version`

`bun run version:check` 会拒绝不一致版本。

## 发布候选

1. 更新上述版本和 `CHANGELOG.md`。
2. 在独立 Git 仓库的干净 checkout 中执行 `bun install --frozen-lockfile` 和 `uv sync --frozen`。
3. 用 `git add` 更新候选 index，再执行 `bun run check`。其中 `release:check` 直接读取 `git ls-files -z` 与 index blob，不以 `.gitignore` 或工作区文件清单代替 tracked-files 审计。
4. 确认公开树不包含 live profile、token、数据库、日志、私有 probe/raw trace、上游 artifact、`node_modules` 或 `.venv`。
5. 等待 GitHub Actions 的 macOS/Linux 与 Python 3.11–3.13 矩阵通过。
6. 在空的 `dist/` 中执行 `bun run release:verify`。该命令构建源码包和 Hermes bridge 包，生成 `release-manifest.json`，再按 manifest 读回大小与 SHA-256 并解包审计。
7. 对解包后的源码包运行敏感路径/内容门禁；bridge 包只允许 `plugin.yaml`、`__init__.py`、`adapter.py`、README、LICENSE、NOTICE、能力契约和 Schema。
8. 使用审计通过的 bridge 包做一次 plugin 加载和 UDS canary。产物审计不替代真实 Hermes 或 LiViS 验证。
9. 计算 `release-manifest.json` 自身的 SHA-256，把它写入由签名 tag/release note 独立绑定的
   发布说明；再创建签名 tag `vX.Y.Z` 和 GitHub Release，附两个归档与 manifest。部署
   安装器要求操作者从可信渠道取得这个 manifest SHA，不能只信同一下载目录里的自声明值。

## 发布产物命令

日常 `bun run check` 会在临时目录从当前工作树构建两份归档并执行同一解包审计，不会写入 `dist/`：

```bash
bun run release:artifact-check
```

正式发布必须从干净 checkout 构建，且 `dist/` 中不能已有同名文件：

```bash
bun run release:verify
```

生成内容：

- `livis-relay-daemon-X.Y.Z.tar.gz`：明确白名单目录组成的源码发行包，不会包含 `.claude/`、`node_modules/`、`.venv/`、缓存或运行状态。
- `livis-hermes-bridge-X.Y.Z.tar.gz`：最小 Hermes bridge 安装包。
- `release-manifest.json`：记录版本、源码状态、Git commit、每个归档的唯一根目录、大小、SHA-256 和必需路径。只有干净 checkout 会记录 commit；日常工作树自检明确标记为 `working-tree` 且不绑定 commit。

正式候选构建后记录 manifest 自身摘要：

```bash
shasum -a 256 dist/release-manifest.json
```

这个摘要是 [`deploy` 安装器](DEPLOYMENT-INSTALLER.md)的固定信任输入。manifest 内部不保存
自身摘要，也没有内置签名信任根；如果摘要与 manifest/归档来自同一个未受信渠道，哈希
只能检测传输错误，不能证明发布者身份。

审计在解包前拒绝绝对路径、`..`、多根目录、超过 20000 个条目、符号链接和硬链接；解包后再次拒绝白名单外 bridge 文件、敏感路径、生产身份、私钥和运行状态。任何归档被修改后都会因 SHA-256 不匹配而失败。

## Tracked-files 安全门禁

`bun run release:check` 必须在项目 Git 顶层运行。未初始化仓库、空 index、嵌套在其他仓库、未合并 index、tracked symlink/submodule 都会 fail closed。

门禁至少拒绝本地 profile、数据库/WAL/SHM、日志、PEM/key、`.env`、官方 `bundle.js`、归档、`upstream-artifacts/`、依赖目录，以及常见 token/identity/secret/state 文件。内容检查读取 index blob，而不是可能尚未 staged 的工作区版本：

- 运行时代码、配置与数据不得包含已知生产 LiViS 域名；
- Markdown、RST、TXT 文档可为安全审计和来源说明提及生产域名；
- 官方 OAuth client identity 只以 SHA-256 指纹识别，所有文本文件均无例外，仓库不保存或打印原始值；
- 私钥头在任意文本文件中都会被拒绝。
- `protocol-probes/` 默认全部拒绝；只有 Git index 中 `src/protocol/wire-contract-registry.json` 精确登记、mode 为 `100644`、SHA-256 和内部 contract 均匹配的 canonical 脱敏 S2 artifact 可以发布。任意其他 JSON、私有回执、raw frame、trace、HAR、pcap 或改名文件一律拒绝。
- Codex custom provider 示例只能使用 `.invalid` 域名。真实 provider URL、API key、
  `auth.json`、包含 provider 自由文本的 stderr/rollout、真实 Responses 请求/响应和 canary
  trace 都不得进入发布候选；即使自动门禁尚未识别某个新格式，也必须在 staged diff 与
  归档中人工拒绝。

`bun run wire-contract:append-only:check` 还会把候选 Git index 与 base commit 比较：既有 registry definition 和 artifact 原始字节不可删除、改名或原地修改；每个候选最多新增一个 revision，且必须成为 current 接受 generator 重建校验。没有新增时不得切换 current。CI checkout 使用完整历史，并从 PR base SHA 或 push before SHA 取基线；基线不可读或不是当前 HEAD 祖先时失败关闭。首次 bootstrap 只有在 base 同时没有 registry 和任何 `protocol-probes/` 文件时才允许，且只能登记一个 current revision。

tracked-files 门禁只证明当前 Git index 未命中这些规则；产物门禁只证明最终归档与 manifest 一致且解包内容通过当前规则。两者都不代替提交历史扫描、GitHub secret scanning、人工 diff 审阅或真实链路 canary。

初始公开仓库只发布源码，不自动创建 Release；在跨语言 UDS canary 和真实 Hermes 候选版本验证完成前，不应把 `v0.1.0` 标记为稳定版。
