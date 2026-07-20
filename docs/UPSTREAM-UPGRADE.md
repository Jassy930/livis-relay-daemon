# 官方版本升级与回滚

## 原则

- 不执行 `latest/setup.sh`，也不让官方更新脚本修改本项目。
- LiViS、Hermes 和 daemon 分层更新；任何一层都不能隐式替换另一层。
- 新版本先检查、留存 artifact、测试、人工审阅，再显式激活。
- 激活只更新本地 profile 指针，不执行官方 OpenClaw 插件。

## LiViS 更新流程

### 1. 检查

```bash
bun run src/index.ts upstream check
```

| 状态 | 含义 | 行为 |
|---|---|---|
| `supported` | 当前 active profile 的 URL、版本、三份哈希和 marker 全部匹配 | exit 0，刷新 24 小时 proof |
| `reviewed-upgrade-available` | 本 daemon 已带审核 profile，但当前尚未切换 | exit 2，必须显式激活 |
| `drift` | 已知版本发生 artifact 哈希漂移 | exit 2，生成待审 profile draft |
| `candidate-compatible` | 新版本仍出现旧 wire marker | exit 2，只是候选，不代表兼容已证明 |
| `unknown-breaking` | 版本/marker/结构无法确认 | exit 2，禁止激活 |

输出同时给出：

- snapshot；
- 可用时的 profile draft；
- 已审核 profile 路径；
- `upstream-artifacts/sha256/` 下的原始 setup、install 和 package。

### 2. 审阅候选

至少核对：

- artifact SHA 与 snapshot 一致；
- install script 的版本和 package URL；
- `bundle.js` 中 handshake、消息、ACK、取消、token refresh 的结构化行为；
- golden wire fixtures 与本项目 parser/builder；
- `bun run check` 全绿。

自动候选只能保持 IDaaS、relay、OAuth、wire identity、timing 和 wire protocol 运行契约不变。若这些字段变化，停止升级；需要新版 daemon、重新登录或 identity migration。

### 3. 显式激活

```bash
bun run src/index.ts upstream activate \
  --profile '/绝对路径/已审阅-profile.json' \
  --acknowledge-reviewed-profile
```

激活会再次在线下载并要求候选自身达到 `supported`，然后：

1. 复制 profile 到 state directory；
2. 写配置备份；
3. 原子切换 profile 路径与 SHA pin；
4. 写审批回执；
5. 写新 profile 的 supported proof。

输出中的 `backupConfigPath` 和 `receiptPath` 必须保留。重启 daemon 后执行：

```bash
bun run src/index.ts doctor --online
bun run check
```

最后只用专用测试 Agent 做纯文本、重复投递、断网恢复、取消和迟到取消 canary。

### 4. 回滚

先停 daemon 和专用 Hermes Gateway，再使用激活输出的备份：

```bash
bun run src/index.ts upstream rollback \
  --backup '/绝对路径/config-backups/<timestamp>.json' \
  --acknowledge-rollback
```

回滚会验证备份属于当前 state directory、旧 profile SHA 仍匹配，并再保存一份回滚前配置。随后重新执行 `upstream check` / `doctor --online`；若旧 profile 已不再匹配当前官方 artifact，服务仍会 fail closed。

## Hermes 官方更新流程

默认审核范围是 Hermes `[0.18.2, 0.18.3)`，只放行已完成公共接口对照和自动回归的 0.18.2。0.18.3 及其他未知版本会被 connector hello 和 doctor 拒绝；0.18.2 恢复生产常驻前仍须先完成隔离真实 profile canary。

已有 state directory 中的 `config.json` 不会被升级过程自动改写。旧配置会继续按原范围失败关闭；必须先复制到隔离 state directory 验证，再由操作者显式把 `minimumVersion/maximumExclusiveVersion` 更新为 `0.18.2/0.18.3`。

更新步骤：

1. 停止专用 Hermes Gateway；不要从 LiViS 远程执行 `/update`。
2. 按 Hermes 官方本地升级方式更新隔离环境，不改本项目 plugin。
3. 在候选官方版本环境中执行 plugin import/register/job/final/cancel smoke。
4. 执行 `uv run pytest -q` 和项目根目录 `bun run check`。
5. 只有自动测试通过后，才在隔离配置中更新 `minimumVersion/maximumExclusiveVersion`；真实 canary 通过后再更新生产配置并恢复常驻服务。

外置 `~/.hermes/plugins/livis-bridge` 不修改 Hermes core，正常官方更新不会被覆盖。若官方 public platform API 变化，测试或 plugin 加载会先失败，daemon 不会接受 connector。
