# 普通 protocol profile 激活与回滚

本文只描述 `upstream activate` / `upstream rollback` 的普通 profile 指针事务。
protocol profile schema v1→v2 迁移是另一套状态机，仍以
[官方升级与回滚](UPSTREAM-UPGRADE.md)中的迁移章节为准。

## 边界与前置条件

- 激活只安装已人工审阅、且再次在线复核为 `supported` 的兼容 profile；不会执行
  官方安装脚本，也不会迁移 wire contract、OAuth identity、SQLite 或设备状态。
- 每次操作只属于磁盘 config 声明的一个 state directory。激活和回滚都禁止设置
  `LIVIS_RELAY_STATE_DIR`；需要选择部署时只使用 `--config` 或
  `LIVIS_RELAY_CONFIG`。CLI 会在加载 config、联网和获取 guard 前拒绝覆盖，
  底层 API 也会重复拒绝。
- 磁盘 `config.stateDir`、effective state directory 和
  `ProfileOperationGuard` 的 canonical 目录必须完全一致。后续所有托管路径均
  锚定该 canonical 目录；祖先 symlink 在事务中改指也不会把写入导向新目标，
  且最终读回会再次核对。任何不一致都失败关闭，不会隐式迁移 state directory。
- config 父目录必须是 canonical 私有目录且不含 symlink 祖先；live config、
  activation 读取的当前 active profile、已安装候选副本、配置备份和 rollback
  待恢复 profile 都必须是 `0600`、单 link、非 symlink 的普通文件。传入的候选
  source 只用于解析和审阅记录，不作为 live 文件；外部替换、hardlink、FIFO 或
  权限放宽都会失败关闭。
- 操作依赖所有项目内 writer 共用 `ProfileOperationGuard`。它不是针对任意外部
  编辑器的内核级路径 CAS；操作期间不得运行 `init`、手工改 config/profile，
  或从其他程序直接调用写状态 API。

建议先停止 daemon 和专用 Hermes Gateway，并禁用服务管理器自动拉起，再执行写操作。

## 激活事务

```bash
bun run src/index.ts upstream activate \
  --config "$HOME/.livis-relay/config.json" \
  --profile '/绝对路径/已审阅-profile.json' \
  --acknowledge-reviewed-profile
```

固定顺序如下：

1. 获取 operation guard 后重新加载初始 context；这一步不把网络检查前的快照
   直接当作写入授权。
2. 再次在线检查候选；只有候选自身为 `supported` 才进入文件事务。
3. 在任何托管写入前重新安全读取 live config 与当前 profile，核对 config 完整
   原始文本、profile 路径/SHA/ID、私有文件身份和 canonical state directory。
4. 逐层建立并持久化 `0700` 的托管目录，写入并读回候选 profile；同名既有文件
   只有在内容 SHA 和私有单-link 文件身份都匹配时才复用。
5. 以 UUID 路径保存原始 config 完整字节备份。
6. 在 config 提交前 durable 写入并读回候选的 keyed/alias supported proof 和审批
   回执。回执只是前置审批证据，文件存在本身不代表激活成功。
7. 在 config 同目录创建 `0600` staging，创建 fd 保持到提交和读回结束；提交前
   同时核对 retained fd 与路径的类型、权限、link count、dev/inode、内容，并再次
   对 live config 做完整原始文本 CAS。
8. staging 到 live config 的 durable rename 是唯一且最后的提交点。rename 后继续
   核对 destination 与 retained fd 的 dev/inode，再只读验证 config 的完整文本、
   文件身份、profile 路径/SHA/ID、active profile 和 stateDir canonical 归属。

只有 guard 已成功释放后，CLI 才输出 `ok: true`。成功事实以 live config 完整文本
SHA 命中回执中的 `configCommitSha256` 为准；`receiptPath`、`backupConfigPath` 或
proof 单独存在都不能证明提交成功。

## 激活失败与补偿

- config rename 前失败：live config 不变；只逆序恢复仍精确等于本次写入内容的
  proof 和回执。候选副本与 UUID config 备份保留为审计材料。
- config rename 后提交或读回失败：仅当 live config 仍是安全的私有普通文件且
  精确等于本次 target 文本时，用同样的私有 staging/durable rename 恢复原始
  config，再精确恢复 proof 和回执。
- 若发现 guard 外并发内容、stateDir 祖先改指、替代 inode 或无法确认的 durability，
  绝不覆盖未知 config，也不删除可能仍对应已提交候选的 proof/回执；错误会保留
  原始失败、补偿失败和备份路径，交由人工判定。
- staging 被换成外部 inode 时不会提交，也不会误删替代文件。guard release 或
  目录 fsync 失败时 CLI 不输出 `ok: true` 并返回非零；finalization durability
  视为未确认，必须人工核验，不得假设 guard 路径一定仍存在或直接删除未知文件。

## 回滚事务

```bash
bun run src/index.ts upstream rollback \
  --config "$HOME/.livis-relay/config.json" \
  --backup '/绝对路径/config-backups/<activation-id>.json' \
  --acknowledge-rollback
```

回滚先对当前 live config 做完整原始文本 CAS 和 state directory 核对，再授权
backup 路径；因此 stale config 或 stateDir 不一致不会触碰备份或写入托管目录。
backup 必须是 canonical `stateDir/config-backups/` 直属的私有普通文件，内部
`stateDir` 必须仍属于当前部署。旧 profile 的字节必须命中 backup 中的 SHA pin，
从这些已绑定字节解析出的 ID 还会在最终 readback 核对；ID 没有 receipt 提供的
独立信任锚。

回滚只从 backup 取回 `profile` 与 `profileSha256` 两个字段。当前 config 中后来
合法修改的 `relay`、`security`、`hermes`、connector 和 stateDir 等字段全部保留，
避免恢复旧 profile 静默变成整份旧配置覆盖。提交前先以 UUID 路径保存当前完整
config；随后使用同目录长持有 fd staging、完整文本 CAS、durable rename 和只读
readback。提交后失败只在 live config 仍精确命中回滚 target 时恢复操作前 config；
发现并发内容或 stateDir 归属不再可信时失败关闭并保留审计材料。

回滚本身不生成、改写或伪造旧 profile 的 supported proof；stateDir 中既有的
keyed proof 会保留，并继续受原 `expiresAt`、在线复核与 drift 规则约束。仍应把
重新在线检查作为恢复服务的强门禁。完成后保持服务停止，执行：

```bash
CONFIG="$HOME/.livis-relay/config.json"
bun run src/index.ts upstream check --config "$CONFIG"
bun run src/index.ts doctor --online --config "$CONFIG"
bun run check
```

只有旧 profile 重新得到当前 `supported` proof 且 doctor 全绿，才重新启动
daemon 和 Hermes。

## 人工恢复判定

遇到补偿失败或 durable rename 已发生但目录 fsync 未确认时：

1. 保持 daemon、Hermes 和服务管理器停止，不先删除 guard、proof、回执或备份。
2. 读取激活回执的 `configCommitSha256`，分别计算 live config 与
   `backupConfigPath` 的完整文本 SHA；同时核对 config/profile 的文件类型、
   权限、link count 和路径归属。
3. live SHA 命中 target 时按已提交但命令失败处理；命中 backup 原文时按已补偿
   处理；两者都不命中时视为外部并发状态，禁止自动覆盖。
4. 记录判定和保留的审计路径后，再决定完成提交或使用备份人工恢复。恢复后仍需
   重新执行 `upstream check`、`doctor --online` 和项目门禁。

不要仅凭回执存在、当前可见 profile ID 或某个 proof 文件判断成功。
