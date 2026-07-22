# 官方版本升级与回滚

## 原则

- 不执行 `latest/setup.sh`，也不让官方更新脚本修改本项目。
- LiViS、Hermes 和 daemon 分层更新；任何一层都不能隐式替换另一层。
- 新版本先检查、留存 artifact、测试、人工审阅，再显式激活。
- 激活只更新本地 profile 指针，不执行官方 OpenClaw 插件。

## 现有部署的 protocol profile schema v1→v2 迁移

这条迁移只处理仓库外的 active protocol profile 和 config pin，不打开
`relay.db`，也不改变 SQLite `PRAGMA user_version`、wire 行为、OAuth 凭据或
一期单设备边界。v1 只能显式映射到已审阅的固定基线：

- `wireContractRevision=livis-relay-v1-access-refresh-r1`
- `credentialMode=access-and-refresh-token`

如果代码 registry 的 current revision 已离开该基线，命令会失败关闭，必须
另写专用迁移；不能把 v1 自动声明成未来 contract。

### 1. 停服与 dry-run

先停止专用 Hermes Gateway 和 daemon，并在 launchd/systemd 中禁用自动拉起。
确认没有活跃 job、待投递结果和其他 `upstream` / `profile` 管理命令。迁移会
在实际 `config.connector.socketPath` 创建 0600 普通文件 guard：运行中 daemon
会令获取失败，guard 存在期间新旧 ConnectorServer 都会因该路径不是 socket
而失败关闭；人工停服仍是硬前置，不能只依赖文件检查。socket 父目录必须是
stateDir 内的私有非 symlink 目录（0700 或更严格），否则 guard 无法阻止其他
本地用户删除或替换，命令会在任何迁移写入前失败关闭。

`upstream check/activate/rollback`、`login` 的 proof 刷新与 `serve` 启动阶段会
在加载 profile 前获取同一 operation guard，避免用迁移前快照在回滚后写回旧
proof 或旧 config。外部编辑器和 `init` 不接入该 guard；停服窗口内不得运行
`init`、手工改写 config/profile 或从其他程序直接调用状态写 API。

```bash
CONFIG="$HOME/.livis-relay/config.json"

bun run src/index.ts profile migrate-v2 \
  --config "$CONFIG" \
  --wire-contract-revision livis-relay-v1-access-refresh-r1 \
  --credential-mode access-and-refresh-token \
  --dry-run
```

dry-run 零写入、零网络，只输出 schema、哈希、目标路径和待执行门禁；不会输
出端点、OAuth identity、token、Agent/node/device ID。确认输出仅包含以下
变化：`schemaVersion:1→2`、新增 revision/mode，以及 config 的 profile 路径和
SHA pin。必须保持 `LIVIS_RELAY_STATE_DIR` 未设置；若使用非默认配置，可通过
`--config` 或 `LIVIS_RELAY_CONFIG` 选择，二者不要指向不同部署。

### 2. 应用与提交点

```bash
bun run src/index.ts profile migrate-v2 \
  --config "$CONFIG" \
  --wire-contract-revision livis-relay-v1-access-refresh-r1 \
  --credential-mode access-and-refresh-token \
  --apply \
  --acknowledge-reviewed-wire-contract \
  --acknowledge-daemon-and-hermes-stopped
```

apply 会重新完成全部检查，不把先前 dry-run 当授权。顺序固定为：

1. 在协作式 operation guard 内，对 config 和 active v1 profile 做初始及提交前
   原始字节 SHA 校验；这能拒绝接入 guard 的并发命令与已发生的外部改写，但
   不是文件系统提供的原子 compare-and-swap；
2. 在 `stateDir/profile-migrations/<id>/` 以 0600 保存原 config 和原 v1 profile；
   目录为 0700；
3. 把新 v2 profile 写入只含 v2 文件的
   `stateDir/protocol-profiles-v2/<sha>.json`，不覆盖原 v1；
4. 以 0600 保存不可变 `PREPARED.json`；它只会在两份备份和目标 v2 profile
   均已持久化后出现；
5. 把 old SHA、new SHA 和 `last-supported.json` 的既有 proof 持久化移动到本次
   私有 `proof-quarantine/`，目标目录先于源目录 fsync，不删除审计证据，也绝不
   自动恢复；
6. 最后 durable rename config；这是唯一提交点。异常后以 live config 的完整
   SHA 判断仍在 source、已经 target 或发生未知并发修改；
7. readback config/profile/proof 状态。验证失败时自动恢复原 config，但 proof
   保持隔离，服务继续 fail closed。

`CONFIG_COMMITTED.json` 与 `PROOF_REBUILD_REQUIRED.json` 是提交后的审计 marker；
即使进程在 marker 前退出，`PREPARED.json` 加 live config SHA 仍是恢复真源。
若 rename 已发生但父目录 fsync 未确认，命令会明确失败并故意保留两层 guard，
不得只凭当前可见 SHA 宣称提交成功。命令不会修改或复制 `relay.db`。

### 3. 重新生成 proof 并启动

旧 proof 不可继承。apply 成功后保持服务停止，依次执行：

```bash
bun run src/index.ts upstream check --config "$CONFIG"
bun run src/index.ts doctor --online --config "$CONFIG"
```

只有 `upstream check` 为 `supported`、新 schema v2 proof 已生成且 doctor 全绿，
才重新启用 daemon 的自动拉起并按 daemon→Hermes 顺序启动。`doctor` 是迁移后
独立运行门禁，不属于 profile migration；迁移命令自身不会实例化 `JobStore`。

### 4. 显式回滚

若尚未通过启动前验证，继续保持两个服务停止并使用 apply 输出的
`receiptPath`：

```bash
bun run src/index.ts profile rollback-migration \
  --config "$CONFIG" \
  --receipt '/绝对路径/profile-migrations/<id>/PREPARED.json' \
  --apply \
  --acknowledge-daemon-and-hermes-stopped
```

回滚会验证 receipt、当前 config SHA、原 config/profile 备份和路径边界，并从
备份重新构造 v2 profile、target config 与 runtime contract digest，确认
source→target 确实属于同一次迁移。当前 config 仍为 target 时，它的完整字节
SHA 必须精确命中这个重建 target，profile 路径和 SHA pin 也必须与 receipt
一致。live target v2 文件不参与回滚授权：它可能正是丢失、损坏或路径
异常的故障点，回滚不读取、不重建也不覆盖它，只从已验证 source backup
恢复 v1。坏 target 会保留供人工分析，再次迁移前需先按运维流程处理。

执行顺序固定为：先写 `ROLLBACK_PREPARED-*` 与 `config.pre-rollback-*`，再隔离
old/new/alias proof，最后准备 v1 profile 并提交 config。原 v1 文件若丢失、成为
symlink、权限过宽或内容漂移，会把已验证备份写入只含 v1 文件的
`protocol-profiles-v1-rollback/`，并生成确定性的 fallback config；损坏的普通
fallback 会先持久化移动到 receipt 目录留证。若 config 已指向 fallback 而该
文件后来丢失或损坏，fallback profile 的 durable rename 本身就是本次修复提交
点，proof quarantine 必须先完成；其他回滚仍以 config durable rename 为提交点。
重复回滚会在两层 guard 内验证当前 active v1，而不是只看 config SHA，必要时
受控自愈；若发现任一 old/new/alias proof，哪怕 config 已是 v1，也会再次隔离
proof 并要求重建。只有 active v1 有效且三份 proof 均不存在时才返回 no-op。

恢复 v1 后必须切回迁移前的旧 daemon，再用旧版本重新执行其 `upstream check`
生成 proof；当前 v2-only daemon 不会加载 v1。回滚只处理 profile/config/proof
指针，不回滚 SQLite 或二进制。

如果进程被强制终止，`profile-operation.guard` 或 connector socket 原路径的
JSON guard 可能故意遗留以保持 fail closed。只有在确认 daemon、Hermes、相关
CLI 和服务管理器都已停止，并核对普通文件中的 `kind`/`nonce` 属于本迁移后，
才人工清理；guard 文件与父目录项都会持久化，进程存活期间创建 fd 保持打开并
与当前路径的 dev/inode、link count、类型、权限和 nonce 交叉复核。不得自动
删除未知 socket、symlink、被替换 inode 或 guard。尤其看到“durable rename 已
发生，但目录 fsync 未确认”时，应先按 receipt 与 live config/profile SHA
人工判定 source/target，再决定恢复或完成提交，不能先删 guard 重启服务。

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
- [本地协议探针](PROTOCOL-PROBES.md)的 revision/mode、脱敏 artifact 和风险观察；
- [服务端协议证据账本](LIVIS-RELAY-PROTOCOL-BOUNDARY.md)中的对应消息、字段、未知项和历史 canary 是否仍成立；
- `bun run check` 全绿。

自动候选只能保持 IDaaS、relay、OAuth、wire identity、timing 和 wire protocol 运行契约不变。若这些字段变化，停止升级；需要新版 daemon、重新登录或 identity migration。

profile schema v2 强制声明 `wireContractRevision + credentialMode`。supported proof schema v2 额外绑定 runtime contract SHA、revision 与 mode；任何一项不匹配或旧 proof 都失败关闭并要求重新在线检查。

官方客户端静态字段、artifact marker 和 fake Relay 都不能单独证明真实服务端兼容。任何 wire 字段、凭据流向、握手、ACK、heartbeat、在线刷新、取消或重试时序变化，都必须让旧 supported proof 与 canary 失效，并在精确最终 head 上重新完成获授权真实 Relay canary。

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

默认审核范围是 Hermes `[0.15.1, 0.15.2)`，只放行已做真实 smoke 的 0.15.1。0.15.2 及未知未来版本会被 connector hello 和 doctor 拒绝，验证后再显式扩大范围。

更新步骤：

1. 停止专用 Hermes Gateway；不要从 LiViS 远程执行 `/update`。
2. 按 Hermes 官方本地升级方式更新隔离环境，不改本项目 plugin。
3. 在候选官方版本环境中执行 plugin import/register/job/final/cancel smoke。
4. 执行 `uv run pytest -q` 和项目根目录 `bun run check`。
5. 只有验证通过后，才在配置中扩大 `minimumVersion/maximumExclusiveVersion`；先做 canary，再恢复常驻服务。

外置 `~/.hermes/plugins/livis-bridge` 不修改 Hermes core，正常官方更新不会被覆盖。若官方 public platform API 变化，测试或 plugin 加载会先失败，daemon 不会接受 connector。
