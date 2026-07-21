# 本地协议探针

本项目提供完全离线的 LiViS IDaaS / Relay contract probe，用于把 daemon 当前会发送、接受、拒绝和持久化的行为固定成可复核差异。它的证据等级始终是 S2：只能证明当前代码与本地 fake 服务的行为，不能证明真实服务端字段必填、错误码、时序或兼容性。

服务端事实、历史 canary 与未知项仍以[服务端协议证据与支持边界](LIVIS-RELAY-PROTOCOL-BOUNDARY.md)为唯一入口。

## 安全边界

- probe 不读取 config、live profile、SecretStore 或用户身份；
- IDaaS 使用注入的 fake `fetch`，Relay 只监听 loopback 随机端口；
- token、device code、Agent/node/job/message ID 和正文全部使用固定哨兵或规范化占位符；
- 原始帧只在测试进程内断言，不写入 artifact；
- 没有“切换到生产”的参数，也不会自动打开浏览器；
- `protocol-probes/` 下只有 `src/protocol/wire-contract-registry.json` 精确登记且 SHA-256/contract 匹配的脱敏 S2 artifact 可以发布；任意其他 JSON、receipt、raw frame、trace、HAR、pcap 或改名文件都会被拒绝。

本地 probe 失败只表示代码偏离已审阅的 S2 基线。它不能因为成功就把任何未知项升级为 S4。

## 命令

查看当前脱敏报告：

```bash
bun run probe:protocol:local
```

验证当前工作区代码与 artifact 一致：

```bash
bun run probe:protocol:check
```

验证既有 revision、definition 与 artifact 原始字节没有被覆写：

```bash
git add <本次候选文件>
bun run wire-contract:append-only:check
```

该命令审核 Git index，并与 PR base / `origin/main` 的 merge-base 比较。CI 使用完整历史和事件携带的 base SHA；基线对象缺失、浅克隆、非祖先 base、unmerged/symlink 文件都失败关闭。`--allow-bootstrap` 只在基线完全不存在 registry 和 `protocol-probes/` 文件时生效，用于本 PR 首次建立 registry，不能覆盖既有历史。

bootstrap 必须且只能登记一个 current revision。后续每个候选最多新增一个 revision，且新增项必须立即成为 current，接受 `probe:protocol:check` 的 generator 重建校验；没有新增项时也不能切换 current 指针。这样不能把未经过 generator 的私有 receipt 或 raw payload 藏进 dormant artifact。

本次是 checker 与 registry 同时首次进入仓库的 bootstrap，安全性还依赖人工审阅最终 diff。CI 在 base 已包含 checker 后，会从 base worktree 执行该版本，而不是信任候选 checker；若要修改 checker 或 CI workflow，仍应与实际 wire revision/artifact 变化拆成两个 PR。仓库内 workflow 仍可被候选修改，不能替代受保护分支、外部 required workflow、required review 和 stale approval 失效策略。

只运行本地 protocol probe 测试矩阵：

```bash
bun run probe:protocol:test
```

只有在人工审阅 wire 差异并决定建立新 revision 后，才更新 artifact：

```bash
bun run probe:protocol:update
git diff -- protocol-probes/
```

完整门禁 `bun run check` 会自动执行 `probe:protocol:check`、包含上述矩阵的全部 Bun 测试和 Hermes pytest。CI 不执行真实服务端 probe。

## 当前 artifact

[`protocol-probes/local/livis-relay-v1-access-refresh-r1.json`](../protocol-probes/local/livis-relay-v1-access-refresh-r1.json)固定以下内容：

- `wireProtocolVersion`、`wireContractRevision` 与 `credentialMode`；
- `connect`、heartbeat、消息/取消 ACK、`send_result`、`token_refresh` 的完整脱敏形状；
- 入站 envelope 与 `send_message` 的接受/拒绝矩阵；
- `/aux`、device `/token`、refresh `/token`、`/revoke` 的 method、path、Content-Type、精确字段集合和敏感字段类别；
- 仍需真实服务端或正式 schema 回答的未知项。

机器可读 SSOT 是 [`src/protocol/wire-contract-registry.json`](../src/protocol/wire-contract-registry.json)。每个条目固定 revision、credential mode、wire protocol、artifact 精确相对路径和 SHA-256；数组形式允许门禁拒绝重复 revision/path/SHA。旧条目只作为不可变历史账本保留，runtime 只接受 `currentRevision`，不会把当前代码未重建的旧 artifact 宣称为仍受支持。当前 revision 是 `livis-relay-v1-access-refresh-r1`，凭据模式是 `access-and-refresh-token`。这只是对现有兼容基线的诚实命名，不是目标安全策略，也不证明 Relay 要求 refresh token。#23 若改为 access-token-only，必须新增 revision、registry 条目与 artifact，不能覆写当前 revision。

## Probe 矩阵

| 分组 | 本地覆盖 | 仍不能证明 |
|---|---|---|
| 出站帧 | URL query、首帧、字段形状、凭据存在性、ping/heartbeat、close | 服务端必填性、忽略或拒绝规则 |
| 入站解析 | 非 JSON、空 type、metadata/payload 形状、job/node/content 边界、未知 type | Relay 实际会发送的 schema |
| 握手与顺序 | 握手前业务、重复或错误关联 `connected`、串行处理 | 服务端顺序与关联保证 |
| Result/ACK | 重试、迟到 ACK、候选关联、断线重放 | 服务端幂等与重复展示 |
| Token refresh | `token_expiring/token_refresh/token_refreshed`、ACK 缺失与重复事件 | 真实在线刷新时序和凭据要求 |
| IDaaS | 表单、flat/nested token、OAuth error、轮换、revoke | 生产状态码、限流、TTL、大小和 redirect 规则 |

## Probe 与代码审计观察到的风险

以下是本地 probe 或对应代码路径确认的客户端现状，不是服务端协议事实，也不能因测试稳定而被解释为“正确行为”：

- `/aux` 目前会接受错误字段类型、负数 interval 和非 HTTPS verification URI；
- refresh 返回非 JSON HTTP 401 时，解析会先失败，失效 refresh token 仍被保留；
- refresh 返回可解析 JSON 的任意 HTTP 401 时，即使 OAuth error 是 `temporarily_unavailable`，当前实现也会清除 refresh token；这是可能销毁仍有效凭据的风险观察，不是正确服务端语义；
- `expires_in=1` 的 access token 仍可能命中 30 秒本地缓存；
- 并发 refresh 可能在一次成功轮换后，被另一次旧请求的 `invalid_grant` 清除新 token；
- `connected` 与 `token_refreshed` 当前不校验原请求关联 ID；
- 单次 token-refresh ACK 超时若未达到 failure 上限，不会自行重发；
- 多个结果 ACK 候选指向不同 job 时，当前采用第一个可解析候选。

这些风险应分别作为后续修复 PR 处理；修复若改变服务端可观察表单、帧或时序，仍需新 revision 和最终 head 的获授权 S4 canary。

## Wire contract 门禁

protocol profile schema v2 强制声明：

```json
{
  "wireContractRevision": "livis-relay-v1-access-refresh-r1",
  "credentialMode": "access-and-refresh-token"
}
```

两者必须匹配由机器可读 JSON 构建的只读 runtime registry；registry 还固定脱敏 artifact 的精确路径和 SHA-256。`runtimeContractSha256()`、supported proof 和 daemon status 同时绑定 revision/mode/artifact path/digest；旧 profile schema 与旧 proof 会失败关闭。

任何 wire 变化必须：

1. 新增而不是复用 `wireContractRevision`；
2. 保留全部旧 registry 条目和 artifact 原始字节，新增 registry 条目、profile、fixture 和脱敏 artifact；
3. 运行 `bun run probe:protocol:update` 并人工审阅完整 diff；
4. 显式暂存候选后运行 `bun run wire-contract:append-only:check` 与 `bun run check`；
5. 按协议证据文档在精确最终代码 head 上完成获授权 S4 canary，或保持 Draft。

## 现有部署迁移边界

schema v1 profile 没有 revision/mode，不能自动猜测后继续运行。升级 daemon 前必须停服务、备份 config/state directory，并在仓库外准备经过人工审阅的 schema v2 profile；只有确认其 wire 仍是当前 `access-and-refresh-token` 基线时，才能填写上述两个值并重新锁定 profile SHA。旧 supported proof 不可复用，迁移后必须重新执行 `upstream check`。

本项目当前没有自动修改 live profile/config 的迁移命令。未完成迁移的现有部署应保持旧 daemon，不得为恢复运行绕过 profile 或 proof 校验。
