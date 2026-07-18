# Hermes bridge plugin

该目录是 Hermes 用户 plugin 的源码与测试环境，不是可发布 wheel。`pyproject.toml` 只用于通过 uv 锁定 `websockets` 和 pytest 依赖。

当前 monorepo 不能直接作为 `hermes plugins install owner/repo` 的 plugin 根目录使用。安装时将以下三个文件复制到 Hermes 用户 plugin 目录：

```text
~/.hermes/plugins/livis-bridge/
├── plugin.yaml
├── __init__.py
└── adapter.py
```

然后执行：

```bash
hermes plugins enable livis-bridge
```

运行依赖由 Hermes Gateway 的 Python 环境提供。开发测试使用：

```bash
uv sync --frozen
PYTHONDONTWRITEBYTECODE=1 uv run python -m pytest -p no:cacheprovider -q
```

升级时先停止专用 Hermes Gateway，备份旧 plugin 目录，再覆盖上述三个文件并重新运行完整门禁。不要从 LiViS 远程渠道执行 `/update`。
