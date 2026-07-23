# Codex 完整 LiViS 人在环 canary

本文记录 Codex backend 从 LiViS App 到结果回显的受控验收方法，以及
2026-07-23 在 macOS/Codex 0.145.0 上完成的一次脱敏回执。它只证明固定版本组合在
该次测试中的实际行为，不是 LiViS 服务端正式协议，也不能替代最终发布 head 的重新验证。

## 1. 2026-07-23 脱敏结果

测试绑定提交 `896091b`、隔离 protocol profile schema v2、
`wireContractRevision=livis-relay-v1-access-refresh-r1`、
`credentialMode=access-and-refresh-token`、Codex 0.145.0、显式 custom Responses
provider、固定模型 `gpt-5.6-sol` 与唯一获准来源设备。Relay 服务端构建标识未知。
私有脱敏回执 ID 为 `codex-e2e-20260723-93b4d1e292d6881e`；公开文档不保存 profile ID/SHA、
endpoint、Agent/node ID、token、原始消息或响应正文。

规范 canary 只发送一次带随机 nonce 的固定短答请求，验收结果为：

- Relay 已连接并完成握手；Codex backend 为 `running/ready`，账号为 `apiKey`，请求与
  实际 model/provider 精确匹配；发送前 checkpoint 为 0、active 为空、无 recovery 或
  quarantine；
- 唯一 nonce job 为 `Succeeded`、`run_generation=1`，attempt ledger 精确为
  `reserved → accepted → succeeded`，只有一个 provider operation；
- outbox 为 `Delivered`、只有一次 delivery attempt，checkpoint 为 `completed/1`，
  active 清空；
- 操作者确认 LiViS App 只出现一个回复气泡，正文与随机 nonce 精确一致；
- 操作者随后主动追加两条扩展消息；三条 job 均各自 `Succeeded/Delivered`，不是 Relay
  重复投递。唯一 rollout 共三轮、三条 assistant message，实际工具、审批、用户输入请求和
  unknown item 均为 0；
- canary daemon 优雅停止，connector socket 消失且 state directory 零打开句柄；旧 Relay
  与专用 Hermes Gateway 按固定顺序恢复，生产队列最终排空，零 quarantine、零未投递结果。

收口时，隔离 Codex 账号已本地 logout，临时 `auth.json` 已删除。LiViS IDaaS 对当前
profile 的 `POST /revoke` 返回 HTTP 404；daemon 按失败关闭规则保留 refresh token，不能
声称远端凭据已撤销。为保留可恢复凭据和审计证据，本次 canary state 不得
`session release`、手工删 token、复用或清理。

## 2. 测试前置条件

1. 固定并记录精确 daemon commit；工作区必须干净，且 `bun run check` 在该提交通过。
2. 当前生产 daemon 必须为 Relay handshake 完成、所选 backend ready、SQLite integrity
   为 `ok`，并且非终态 job、未投递 outbox、pending cancel 与 quarantine 都为 0。
3. 测试必须使用仓库外、非系统临时目录、权限 `0700` 的全新 state directory。不得直接把
   新 daemon 指向生产 state：旧 profile/SQLite 迁移后，旧 daemon 可能无法回退读取。
4. 为让 App 仍指向同一 Agent，隔离 state 只允许复制经过 profile 前缀校验的
   `identity.json`，并在内存中继承唯一 node allowlist；不得复制生产 `secrets.json`、
   `relay.db`、supported proof、Codex home 或任何 token。
5. 当前 CLI 还没有“保留 identity、生成 fresh secrets、迁移 v1 profile”的原子命令。
   在补齐该命令前，隔离 state 只能由已审阅的一次性 scaffolding 创建，并逐项断言普通文件、
   无 symlink、`0600/0700` 权限、唯一 node 和零生产 secret；不能用 `init` 代替。
6. schema v1 profile 先在隔离 state 中执行 `profile migrate-v2 --dry-run`，只允许出现
   `1→2`、固定 revision/mode 与 profile path/SHA pin 变化；再显式 apply 并执行
   `upstream check`。迁移与 proof 都不得触碰生产 state。
7. 通过全新 LiViS Device Flow 获取隔离 refresh token。API key 只能从可信终端经 stdin
   登录 state 内专用 `CODEX_HOME`，不能复制日常 `auth.json`，也不能把 key 放入 argv、
   环境变量、配置、日志或 shell history。`backends/`、`backends/codex/` 与专用 home 的
   daemon 自管父目录必须是 `0700`；权限过宽时 `doctor` 应失败关闭。
8. `doctor --online` 必须全绿后，向操作者明确说明短暂停服范围并取得确认。

## 3. 服务切换与发送前门禁

同一 Agent 不能同时连接两套 daemon。Hermes 模式切到 Codex canary 时，固定顺序为：

1. `bootout` 专用 LiViS Hermes Gateway，确认 label 已卸载且原 PID 消失；
2. `bootout` 旧 `livis-relayd`，同样确认 label 与 PID 收口；
3. 与 LiViS 无关的默认 Hermes Gateway 保持运行；
4. 前台启动隔离 Codex daemon，不另起第二个 app-server；
5. 用脱敏 `status` 确认 Relay `connected/handshakeComplete`、Codex
   `running/ready/apiKey`、精确 model/provider、checkpoint 为空、active 为空、无
   recovery/quarantine/backend backlog。

任一门禁不满足都不得让用户发送消息。Codex 模式不接 Hermes connector，因此不能把
`daemon.connector.ready=false` 当作失败；执行真源是 `daemon.execution`。

## 4. 人在环消息与验收

让唯一获准设备只发送一次如下形状的消息，随机后缀每次重新生成：

```text
请不要调用任何工具，只回复下一行，不要加标点、引号或代码块：
LIVIS_CODEX_E2E_OK_<UTC>_<16_HEX>
```

发送后禁止重发、cancel、重启、切换 provider/key/model 或 `session release`。即使 App 暂时
没有显示，也必须保持 daemon 在线，先等待 configured turn timeout 和 durable outbox
恢复逻辑裁决。

完整通过必须同时满足：

- nonce 在 SQLite 只命中一个规范 job；job 为 `Succeeded`、`run_generation=1`、无 error，
  ledger 精确为 `reserved → accepted → succeeded`，同一 lease/execution/session 且只有
  一个 provider operation；
- outbox 为 `Delivered`，`acked_at/delivered_at` 均存在，至少一个 delivery attempt，结果
  正文哈希与预期一致。一次 attempt 记为 `PRISTINE_GO`；多次只表示 outbox 投递重试，
  不能写成模型重跑；
- backend session 为 `apiKey`、精确 model/provider、checkpoint `completed/1`，四个 active
  字段为空、`recovery_required=0`，无 quarantine 或 pending cancel；
- rollout 实际没有 tool、approval、user-input request 或 unknown item；
- 操作者确认 App 中同一 nonce 只有一个回复气泡且正文精确一致。`Delivered` 只证明 Relay
  ACK，不能替代 App 视觉确认。

若出现 `Interrupted`、`CancelUnknown`、active/recovery/quarantine、无法确认的进程组收口，
或 App/数据库关联不一致，立即按 `FAIL_CLOSED` 保留整个 state；不得为了取得绿灯重跑。

## 5. 完整编码态工具 canary（待执行）

第 4 节只验证纯文本 turn 和 durable result，不证明 Codex 实际获得 shell、修改文件或运行
测试。启用完整编码态前，必须在全新 state directory 或已确认 idle、零 quarantine 的专用
Codex session 中完成本节；未取得全部回执时继续标记为“纯文本功能 canary”，不得称为
完整编码态。

### 5.1 工具链前置读回

发送消息前，由操作者从 `status` 记录脱敏 workspace 路径、thread checkpoint 和 backend
状态。daemon 必须为 `running/ready`，active 为空，workspace 必须是 daemon 管理的唯一可写
根。Codex 工具网络仍为关闭，审批策略仍为 `never`；不得为通过本 canary 临时加入额外
writable root、启用网络或复用宿主项目目录。

若工具链不在 `:minimal` 可发现范围，允许使用配置中预先审核并持久绑定的
`codex.toolchainReadRoots` 只读目录；它必须在 daemon 启动前已配置并通过 doctor，不能在
canary 期间临时改写。该只读目录不等于额外 writable root，仍不得包含凭据或业务数据。

目标机器必须已经安装可由 Codex sandbox 执行的 Bun，但 canary 不得安装或更新工具链、
下载依赖或访问 package registry。`command -v bun`、`bun --version` 任一失败都按
`TOOLCHAIN_BLOCKED` 收口，不能退化成只写文件不运行测试。

### 5.2 唯一编码请求

每次生成新的 `<NONCE>`，只发送一次以下形状的消息：

```text
请完成一次本地完整编码验收，必须实际调用工具，不得只描述步骤，也不得访问网络或工作区外路径。
1. 先运行 pwd、command -v bun 和 bun --version。
2. 在当前工作区创建目录 coding-canary-<NONCE>。
3. 在该目录创建 package.json、src/add.ts 和 tests/add.test.ts；实现并测试两个整数相加，至少覆盖正数、负数和零。
4. 使用 bun test 运行测试。
5. 只有测试通过后才回复一行：LIVIS_CODEX_CODING_OK_<NONCE> tests=<通过数> files=3
若任何工具、写文件或测试失败，只回复一行：LIVIS_CODEX_CODING_FAILED_<NONCE>
```

消息发出后不得重发、人工补文件、在 workspace 中手动运行测试、切换 model/provider/key，
也不得用另一条消息提示 Agent 修正。失败证据必须原样保留；需要修复后重验时使用全新 nonce，
并明确记录为另一次 canary。

### 5.3 三方验收

完整通过必须同时满足：

- SQLite 中 nonce 只命中一个 job；job 为 `Succeeded`、`run_generation=1`，attempt ledger
  精确为 `reserved → accepted → succeeded`，outbox 为 `Delivered`；
- rollout 至少出现一个真实 command execution/tool item，且实际包含工作区内文件创建和
  `bun test`；approval、user-input request、unknown item 均为 0；
- 所有 tool cwd 与 thread/runtime workspace 精确一致，没有额外 writable root，没有网络
  命中，也没有访问宿主 HOME、CODEX_HOME、daemon state 或系统临时目录；
- 操作者只读检查 `coding-canary-<NONCE>`：三个要求的文件均为普通文件且位于 workspace 内，
  `package.json` 不含第三方依赖，源码与测试内容符合请求；
- 操作者在同一 workspace 以已审核 Bun 再运行一次 `bun test`，全部测试通过；这次只读验收
  是独立复核，不得发生安装、格式化或源码修改；
- App 只显示一个 final 气泡，正文精确等于成功行；数据库结果正文哈希与该行一致；
- terminal 后 backend checkpoint 增加 1，active 四字段清空，零 recovery、quarantine 和
  backend backlog。

模型声称“已运行”但 rollout 没有 tool item、只创建文件未运行测试、工具链不可见、审批被
拒绝、网络被访问、App/数据库/文件系统任一方不一致，都必须裁决为 `FAIL_CLOSED`。成功目录
作为编码态验收证据保留到部署回执完成；后续清理必须由操作者按精确 workspace 路径处理，
不能让 Agent 自行删除证据。

## 6. 收口与恢复

只有 terminal、outbox `Delivered`、active 为空且人工回显确认完成后，才能优雅停止 canary。
必须看到 `daemon 已停止`，确认 connector socket 不存在、daemon/app-server PID 已消失，且
`lsof +D <stateDir>` 零句柄。

恢复顺序固定为：

1. 启动旧 `livis-relayd`，等待 Relay connected + handshake；
2. 启动专用 LiViS Hermes Gateway，等待 connector ready；
3. 确认生产非终态队列自然排空、零未投递与零 quarantine。不得用重派或数据库编辑加速。

最后分别处理两套凭据生命周期：

- 在隔离 `CODEX_HOME` 本地 `codex logout`，并验证临时 `auth.json` 不存在；这不等于
  custom provider 已撤销 API key；
- 在 daemon 停止后执行 LiViS `logout`。只有 IDaaS revoke 返回 2xx 才能清除本地 refresh
  token。网络失败或非 2xx 时必须保留 token 和 state 以便重试，并在私有回执记录失败；
  不得手工删除后宣称撤销完成。

## 7. 仍未证明的边界

- 单一 daemon provider operation 与 `retry=0` 不等于 custom endpoint 内部只收到一个
  Responses HTTP 请求；需要 endpoint 侧脱敏计数。
- rollout 零工具只证明本轮实际没有工具 item，不证明请求 payload 完全不含工具 schema。
- 第 5 节在取得真实回执前只是验收合同；文档存在不表示 Bun 工具链可见、模型一定调用工具，
  或完整编码态已经通过。
- 本轮只覆盖 macOS/Codex 0.145.0、固定 model/provider/profile 与未知 Relay build；Linux、
  未来 Codex、资源配额、长期重连、取消和在线 token refresh 必须独立验证。
- App 回显是人工确认；没有字段级原始 Relay trace、公开截图或 S5 服务端规范。
