# Hermes bridge plugin

该目录是 Hermes 用户 plugin 的源码与测试环境，不是可发布 wheel。`pyproject.toml` 只用于通过 uv 锁定 `websockets` 和 pytest 依赖。

当前 monorepo 不能直接作为 `hermes plugins install owner/repo` 的 plugin 根目录使用。先用 `hermes profile create livis-test --no-skills --no-alias` 创建隔离 profile，再将以下三个文件复制到该 profile 的 plugin 目录：

```text
~/.hermes/profiles/livis-test/plugins/livis-bridge/
├── plugin.yaml
├── __init__.py
└── adapter.py
```

然后执行：

```bash
HERMES_HOME="$HOME/.hermes/profiles/livis-test" \
  hermes plugins enable livis-bridge
```

专用 profile 的 `.env` 还必须在本地设置 `LIVIS_HOME_CHANNEL=livis:<agent_id>`；`agent_id` 取自同一 daemon state directory 的 `identity.json.agentId`。不得从 LiViS 发送 `/sethome`：bridge 会在 job 映射、`accepted` 和 Hermes dispatcher 之前拒绝全部斜杠命令，以及 Hermes 0.15.1 识别的自然语言重启别名。active session、blocking approval 或安全状态无法读取时也会用 connector v1 `failed` 失败关闭。

`config.yaml` 中应显式设置：

```yaml
livis:
  gateway_restart_notification: false
```

adapter 运行时也会强制关闭该通知，避免 Hermes 在没有 active LiViS job/lease 时向 home channel 主动推送。daemon cancel 合成的内部 `/stop` 仍走独立 `_handle_cancel()` 路径。

运行依赖由 Hermes Gateway 的 Python 环境提供。开发测试使用：

```bash
uv sync --frozen
PYTHONDONTWRITEBYTECODE=1 uv run python -m pytest -p no:cacheprovider -q
```

升级时先停止专用 Hermes Gateway 与 daemon，备份旧 plugin 目录和 daemon state directory，再覆盖上述三个文件；同时把私有 Relay 配置的 `hermes.bridgeMinimumVersion` 显式更新并读回为至少 `0.1.1`，然后重新运行完整门禁。daemon 0.1.1 会拒绝仍允许 bridge 0.1.0 的存量配置。不要从 LiViS 远程渠道执行 `/update`、`/sethome` 或其他 Hermes 命令，也不要在未指定 `HERMES_HOME` 时启用、停用或启动本插件。
