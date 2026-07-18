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

运行依赖由 Hermes Gateway 的 Python 环境提供。开发测试使用：

```bash
uv sync --frozen
PYTHONDONTWRITEBYTECODE=1 uv run python -m pytest -p no:cacheprovider -q
```

升级时先停止专用 Hermes Gateway，备份旧 plugin 目录，再覆盖上述三个文件并重新运行完整门禁。不要从 LiViS 远程渠道执行 `/update`，也不要在未指定 `HERMES_HOME` 时启用、停用或启动本插件。
