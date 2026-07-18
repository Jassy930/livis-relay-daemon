# 低风险自动合并门禁

本门禁只用于第一轮低风险自动合并 canary，不是通用的“CI 全绿就合并”。协议、认证、持久化、Hermes bridge、依赖、发布、仓库治理和普通文档变更仍然必须人工审阅、人工合并。

## 第一轮唯一允许的变更

第一轮只接受默认分支上已经存在的 `docs/AUTOMERGE-CANARY.md`，且唯一允许的 diff 是下面这一行固定状态切换：

```diff
-当前低风险自动合并演练状态：待验证。
+当前低风险自动合并演练状态：已验证。
```

文件新增、删除、重命名、反向切换、空白变化、额外行以及任何其他路径都会失败关闭。完成这一次 canary 不代表可以自动合并其他 Markdown；扩大文件或内容范围必须另开 policy PR，并继续走人工审阅和人工合并。

## 信任边界

最终执行身份是默认分支上 [Auto-merge Policy workflow](../.github/workflows/automerge-policy.yml) 获得的仓库级临时 `GITHUB_TOKEN`。本机 Codex 管理员 token 和 Codex 定时任务只能提出候选或切换候选标签，不得 ready、approve、直接 merge 或启用 Auto-merge。

workflow 的可信代码固定检出 GitHub 为本次运行解析的不可变 `${{ github.workflow_sha }}`，不使用事件 base/head SHA，也不在运行中跟随可漂移的分支引用。`pull_request_target` 只接受 base 为 `main` 的 PR；任何触发事件都只负责唤醒审计，事件载荷不作为策略事实。脚本不会检出、下载或执行 PR head、PR artifact、附件或 fork 内容，而是重新通过 GitHub API 读取仓库、PR、Issue、commit、diff、check 和 review 状态，并扫描所有 open PR。

三个 job 都把同一个 `github.workflow_sha` 作为 `AUTOMERGE_TRUSTED_WORKFLOW_SHA` 传给脚本。`dry-run` 的 token 全部只读；`audit` 与 `enforce` 在每次 Observation/Gate、ready 或 Auto-merge 等正向写入前，都会实时读取 `refs/heads/main`，只有实时 main SHA 与本次可信 workflow SHA 精确相等才允许写入。只要 `main` 在 run 启动后前进，旧 workflow 的后续授权写入就立即失败关闭，等待由新 main SHA 启动的下一轮处理。已经进入 cleanup 的旧 run 仍可写 failure/tombstone、禁用 Auto-merge 和转回 draft；这些操作只收紧状态，不能因 main 漂移而被反向阻断。

Observation 与 Gate 的平台身份只能绑定到共享的 GitHub Actions App ID，不能直接绑定具体 workflow。因此灰度期额外要求：除本 policy workflow 外，仓库不得存在任何能写 `Low-risk Auto-merge Observation` / `Low-risk Auto-merge Gate` 或拥有 `checks: write` 的 workflow。Watchdog 必须固定扫描这一不变量；未来若要扩大 checks-write 信任根，应改用独立低权限 GitHub App 并另走人工 policy 决策。

workflow 顶层权限为空，并按模式拆成三个互斥 job。仓库变量只决定哪个 job 获得 token，每个 job 再把模式常量写入脚本环境，不能用一个高权限 token 在运行时切换模式：

| Job | `actions` | `checks` | `contents` | `issues` | `pull-requests` |
| --- | --- | --- | --- | --- | --- |
| `dry-run` | read | read | read | read | read |
| `audit` | read | write | read | read | read |
| `enforce` | read | write | write | read | write |

`audit` 的唯一写权限用于当前 head 上的 `Low-risk Auto-merge Observation` 与 `Low-risk Auto-merge Gate` check。只有 `enforce` 能转 ready、禁用旧 Auto-merge 请求，并用 GitHub 原生 API 申请 squash Auto-merge；所有禁用和清理都必须同时读回 REST `auto_merge` 与 GraphQL `AutoMergeRequest` 为空，单侧为空不能算成功。`contents: write` 不会持久化到 checkout，脚本没有 push 或直接 merge 路径。三个 job 都没有 secrets、administration、workflows、deployments、releases 或 environments 权限。

workflow 和策略脚本本身属于信任根；首次引入及以后对它们、测试或 `.github/**` 的任何修改都不得由本机制自动合并。

## 三种运行模式

仓库变量 `AUTOMERGE_POLICY_MODE` 控制运行模式。只有精确的 `audit` 或 `enforce` 会启动对应 job；变量缺失、拼写错误或值不在 allowlist 时只启动低权限 `dry-run`。job 传给脚本的是固定模式常量，不直接透传仓库变量。

| 模式 | 允许写入 | 用途 |
| --- | --- | --- |
| `dry-run` | 绝对零策略写入 | 只输出重新计算的判定与拒绝原因 |
| `audit` | 只创建或更新 head-bound Observation/Gate check | 为所有 open PR 播种检查；不得 ready、启用或禁用 Auto-merge |
| `enforce` | Observation/Gate check、ready 和原生 Auto-merge 控制 | 第一轮 canary 的完整执行模式；仍禁止评论、打标签、approve、push 和直接 merge |

`audit` 用于迁移分支保护，因此候选的正向判定允许仓库仍为 `allow_auto_merge=false`，也允许 `Low-risk Auto-merge Gate` 尚未加入 required checks。进入 `enforce` 后这两项变为硬门禁：仓库必须启用原生 Auto-merge，分支保护必须同时要求五项可信 CI check 与 `Low-risk Auto-merge Gate`，并保持 strict 且覆盖管理员。

`pull_request_target` 自身的 workflow check 绑定 base，不可充当 PR head 的 required check。因此脚本通过 Checks API 把 Observation 与 `Low-risk Auto-merge Gate` 明确创建在当前 `head_sha` 上；Observation 是带授权指纹的 neutral 计时证据，Gate 才是分支保护 required check：

- `merge:auto` 候选按完整策略得到 success 或 failure。
- 非候选 PR 得到 pass-through success，避免 Gate 加入分支保护后阻塞人工路径。
- 强制模式先写 in-progress，并在进入下文定义的短期授权窗口前复读相同状态。
- 旧 head 上的 success 不能满足新 head；失败或漂移会写 failure，并在强制模式禁用已有 Auto-merge 请求和恢复必要状态。

Gate 名称保持为同一个 required check，但 external ID 按 `pass-through`、`audit`、`enforce-preflight` 与 `enforce-lease` 四个 phase 使用不同的 v2 前缀。只有 `enforce-lease` 表示真正进入提交授权路径；audit 与人工 pass-through Gate 永远不能作为自动合并配额证据。迁移前遗留的 v1 `authorization=` Gate 无法区分 audit/enforce，对已经合并的 PR 按占用配额保守处理。

## 重新审计与串行化

以下事件都会唤醒一次全量重新审计：

- `pull_request_target`：PR 创建、重开、同步、编辑、关闭、标签、review request、draft/ready 和 Auto-merge 状态变化。
- `issue_comment` 与 `issues`：候选指纹评论、关联 Issue 内容、开关状态或标签变化。
- `pull_request_review` 与 `pull_request_review_comment`：review 和行内评论的新增、编辑、删除或驳回。GitHub Actions 没有可依赖的 review-thread 解决状态触发器，五分钟轮询会重新读取 GraphQL thread 状态补偿。
- `workflow_run`：可信 `CI` workflow 完成。
- `push` 到 `main`：默认分支前进后重新检查 behind 状态和配额。
- `workflow_dispatch`：人工复审。
- 每五分钟 `schedule`：补偿 GitHub 事件延迟、丢失，以及 `GITHUB_TOKEN` 写操作可能不会再次触发 workflow 的情况。

评论、review 与 Issue 事件不能只依赖运行时看到的最终状态。例如 PR 评论或行内 review comment 在两个排队 run 执行前先新增再删除，API 读回可能已经恢复成原样，但这段授权状态并未连续稳定。为此，`audit`/`enforce` 会在任何新 Observation、Gate 或 admission 之前，按 `GITHUB_EVENT_NAME`、事件 action、实体 ID 和 `GITHUB_RUN_ID` 在受影响 PR 的实时 head 上写入 neutral Observation tombstone：

- `issue_comment` 发生在 PR 上时直接定位该 PR；发生在普通 Issue 上时按 PR body 中的 Issue Worker marker 映射关联 PR。
- `pull_request_review` 与 `pull_request_review_comment` 直接定位事件中的 PR；created/edited/deleted/dismissed 分别形成不同 tombstone。
- `issues` 事件映射关联 PR；无法映射时，失败关闭地 tombstone 当前所有 `merge:auto` 候选。
- `pull_request_target` 的关闭、重开、标签、编辑、draft/ready、review request、同步及 Auto-merge 状态事件同样写 tombstone。

tombstone 总是通过 GitHub API 重新读取 PR 后写在当前 live head，而不信任可能陈旧的事件 head。相同事件 rerun 或相同非候选状态会复用最新 tombstone，避免五分钟轮询制造无界 check-run；一旦 tombstone 比旧 Observation 更新，即使评论、标签或 review 状态后来恢复为原值，旧的 15 分钟证据也永久失效，必须创建新的 Observation 并重新等待。`dry-run` 只打印 `WOULD_TOMBSTONE`，绝不写 Check Run。

所有触发器共享一把固定的仓库级 concurrency 锁，且 `cancel-in-progress: false`。每次运行都重新读取全部 open PR。`enforce` 先对所有 PR 执行既有 Auto-merge 的 fail-safe 禁用与读回，再逐个处理全部非候选 PR 的人工 pass-through Gate；单个预检或人工 Gate 错误会被聚合并继续处理后续人工 PR，不能让无效 `merge:auto` 候选饿死人工路径。

只有所有 fail-safe 预检和人工 Gate 都成功、且 5 分钟 admission 软截止前仍至少剩余 180 秒时，`enforce` 才按 PR 编号选择最早的一笔候选进入授权/提交路径。每个 run 最多接纳一笔；其他候选明确延期到后续事件或定时轮询。任何聚合错误都必须让本轮失败并禁止 candidate admission，不能把既有 Auto-merge 禁用失败降级成告警后继续。预检先处理初始 REST 已显示 Auto-merge 的 PR，再处理事件直接目标与其余 PR；若软截止到达，脚本进入 cleanup，给尚未双读的每个 head 写最新 failure Gate，并继续禁用初始 REST 已知请求，避免尾部 PR 复用旧 success Gate。

每个 job 的平台硬超时为 25 分钟，checkout 与 Bun setup step 各自最多 5 分钟，真正执行策略脚本的 step 单独硬限 10 分钟。脚本从自身进程启动时开始计时：约 5 分钟后停止接收新工作，candidate admission 还要求至少 180 秒余量；9 分钟进入清理硬截止，并在写 success 前预留至少 90 秒。因此脚本清理截止早于该 step 的平台硬超时。原生合并等待最多 60 秒。平台强制终止进程时仍不保证 cleanup 已执行，不能把 timeout 当成撤销机制；事件队列和五分钟 schedule 会在下一轮读取远端真实状态、补写 Gate 并执行必要清理。

这套“全局锁 + 单候选 + 短等待”降低两笔候选在第一笔尚未落到 `main` 时同时穿过 24 小时配额的风险。正常完成时，配额的主要持久证据写入 squash commit body：

```text
codex-automerge-policy:v1 pr=<PR编号> head=<40位SHA> diff=<64位SHA-256>
```

脚本使用 GitHub server time 分页扫描 `main` 最近 24 小时（另加五分钟边界余量）的 commit、关联 merged PR 与 PR head check runs，而不是依赖可被移除的 `merge:auto` 标签或可编辑评论。配额采用 fail-safe 并集：精确 marker、包含 policy 前缀但格式畸形的 marker、v2 `enforce-lease` Gate、无法区分阶段的旧 v1 `authorization=` Gate，以及 `github-actions[bot]` 完成的合并，任一证据都按一次占用；同一 PR 的多种证据只计一次。audit/pass-through Gate 不计入配额。读取、分页或时间戳证据不完整时直接失败关闭，不能把异常已合并结果当成零。由此可能把其他 GitHub Actions 合并保守计入 24 小时窗口；第一轮 canary 接受这种只阻止、不放行的误报。

## 短期授权租约与 commit point

GitHub 原生 Auto-merge 从授权到真正写入 `main` 不是一个可由策略脚本持续锁住的事务。本机制因此显式采用短期、不可追溯撤销的授权租约，并把风险限制在上面的单行 canary：

1. 策略首次看到一个可判定的当前 head/marker 授权状态时，在该 head 上创建 neutral `Low-risk Auto-merge Observation`，其 external ID 绑定完整授权指纹。只有后续运行用 GitHub server time 证明同一 Observation 连续存在满 15 分钟，才允许 `enforce` 创建 in-progress Gate 作为授权 lease；`audit` 写出的 Gate 只是迁移证据，不是合并 lease。
2. lease 精确绑定 PR 编号、head SHA 和 diff 指纹。创建后立即重新读取 PR、Issue、marker、diff、CI、`main`、分支保护和配额；任何差异都会在 commit point 前拒绝并执行 best-effort cleanup。
3. 两次读取得到相同授权状态后进入 commit point，并只为这一笔 canary 打开最多 60 秒的原生提交窗口。Auto-merge 请求用 GraphQL `expectedHeadOid` 绑定该 head，不允许替换成别的 commit。
4. commit point 之后，标签、Issue、普通评论或 review 等策略元数据变化只会唤醒下一轮审计，不能追溯撤销已经授出的 60 秒 lease。这是明确接受的短期授权边界，不得把它描述为完全可撤销事务。
5. head、可信 CI、最新 `main` 或 required-check/保护状态漂移仍由 `expectedHeadOid`、strict 分支保护和 GitHub 原生 Auto-merge 阻断。60 秒内未合并时脚本先把 Gate 置为 failure、写 Observation tombstone，再禁用请求并要求 REST/GraphQL 双读同时为空；曾由本轮转为 ready 的同一 head 还必须转回 draft 并读回。若进程被平台硬终止，则依赖下一次 schedule 从远端状态清理。

这里的“60 秒 lease”是 policy 的目标授权/清理窗口，不是 GitHub 原生 Auto-merge 提供的硬 TTL。脚本只在 GitHub server time 证明写 success Gate 前至少剩余 30 秒、写后至少剩余 20 秒时继续，并把轮询截止绑定到 lease expiry；但 success Check 与 AutoMergeRequest 本身不会自动到期。若 runner 在 success 后被平台强杀，原生请求理论上可能在 60 秒以后、下一次五分钟 schedule 清理以前完成。第一轮只因 diff 被固定为单行 canary 才接受这一不可完全撤销的残余风险；若业务要求严格 TTL，必须改用不同执行架构，不能把本机制描述为硬事务。

任何扩大文件范围、延长 lease 或放宽原生阻断条件的变更，都是新的风险决策，必须另开人工审阅的 policy PR。

## 候选门禁

第一轮候选必须同时满足以下条件：

1. 仓库全名、numeric repository ID、owner 和默认分支都与本仓库精确匹配。
2. PR 为 open，base 为 `main`，来自同仓库 `codex/issue-<编号>-<slug>` 分支，作者是允许的内部维护者，且只有一个 commit。
3. `merge:auto` 是唯一候选标签；出现 `merge:human`、`codex:blocked` 或其他标签立即拒绝。
4. PR 正文只有一个 Issue Worker marker，分支编号与 marker 一致；关联对象必须是真正的 open Issue，不能是 GitHub API 以 Issue 形式返回的 PR。
5. 关联 Issue 作者是允许的内部维护者，标签必须且只能是 `documentation` 与 `decision:auto`。
6. PR base SHA 与 merge base 必须都是当前 `main`，当前 head 相对 `main` 的 compare 结果必须为 `ahead_by=1`、`behind_by=0`；只比较事件 base SHA 不足以证明这一点。
7. 只修改一个既有 `docs/AUTOMERGE-CANARY.md`，且完整内容与 patch 精确等于“待验证”到“已验证”的固定切换。
8. candidate marker 必须唯一，作者可信，并绑定 PR 编号、当前 head SHA 和规范化 diff SHA-256；marker 未被编辑且不得早于关联 Issue 的最近授权变更，同一 head/marker/授权指纹的可信 Observation 还必须使用 GitHub server time 稳定满 15 分钟。
9. 当前 head 的五个 CI required checks 必须由预期的默认分支 `CI` workflow 成功完成；缺失、重复、pending、skipped、stale、失败或来源不可信都拒绝。
10. PR 必须可干净合并，没有 review、review comment、review request、额外普通评论或未解决 thread。
11. 过去 24 小时没有任何 fail-safe policy 合并证据（精确/畸形 marker、enforce lease Gate、legacy Gate 或 Actions bot 合并），且本轮尚未让另一笔候选进入授权路径。
12. `audit` 可在 Auto-merge 关闭且 Gate 尚未 required 时给出正向结果；`enforce` 额外要求仓库 Auto-merge 已开启、五项 CI 加 head-bound Gate 共六项 required checks 完整生效。commit point 前必须完成第二次相同状态复读；随后只申请带 `expectedHeadOid` 的 squash Auto-merge，绝不调用直接 merge 或管理员绕过接口。

候选评论格式如下：

```text
<!-- codex-automerge-candidate:v1 pr=<PR编号> head=<40位SHA> diff=<64位SHA-256> -->
```

diff 指纹由策略版本、base/head SHA 和排序后的文件元数据及 patch 计算。候选生成器与 policy workflow 必须使用同一实现；旧 head、手工拼接或重复 marker 都无效。

candidate marker 是一次性授权材料。候选一旦离开 `merge:auto`、Issue 授权撤销或任一门禁失效，Codex Gate 必须删除旧 marker；以后重新进入候选时只能创建新的 marker 评论，不能复用旧评论。Policy 也只接受该 head 上最新的 Observation；发现更新的不同授权状态后，即使状态恢复为原值，也必须新建 Observation 并重新等待 15 分钟。

## 开启顺序

必须按以下顺序迁移，不能提前跳到 `enforce`：

1. 保持仓库 `allow_auto_merge=false`，保持 `AUTOMERGE_POLICY_MODE=dry-run`；在 policy PR 人工合入前不创建会添加 `merge:auto` 的 Codex Auto-merge Gate。若环境中已存在同名 Gate，则必须保持 `PAUSED`。
2. 在人工审阅的 policy PR 中引入本 workflow、策略脚本、测试、文档，以及旧态 `docs/AUTOMERGE-CANARY.md`；人工合并到 `main`。在这一步完成前，绝不允许开启仓库 Auto-merge。
3. policy PR 人工合入后，先暂停现有 Triage、Issue Worker、PR/CI Worker、Daily Digest 与 Watchdog；等待活动 run 结束并留出 10 分钟事件宽限。此时仍保持 `allow_auto_merge=false`、五项原 required checks、无 `merge:auto`，不得边运行旧 prompt 边迁移基线。
4. 在全部任务暂停时创建新的 Codex Auto-merge Gate，初始状态必须是 `PAUSED`；同时更新 Triage、Issue Worker、PR/CI Worker 与 Daily Digest 的低风险期 prompt。逐项读回这五个业务任务的状态、schedule、worktree、prompt 全文与哈希，确认 Gate 只能切换候选标签，其他任务不能 ready、approve、enable Auto-merge 或 merge。
5. 再把暂停态 Watchdog 升级为 v2，固定核对默认分支 workflow/script blob SHA、三态变量、分支保护、required checks、上述五个业务任务的 prompt 哈希、标签语义，以及“没有其他 workflow 拥有 `checks: write` 或伪造本 policy 两个 Check 名称”的独占不变量；写回后逐项读回。Watchdog 只能报警或熔断业务任务，不得自动修改信任根、分支保护或仓库 Auto-merge 设置。
6. 创建 `merge:auto` 标签，但保持 Codex Gate 暂停。创建唯一 canary PR，把模式切到 `audit` 并人工触发 workflow；首次运行会建立 head-bound Observation、把尚未成熟的候选 Gate 写为 failure，并让该次 workflow 明确失败。至少 15 分钟后再次触发，才允许同一授权状态得到正向 Gate。确认普通人工 PR 得到 pass-through success，合格 canary 在 `allow_auto_merge=false` 且 Gate 尚未 required 时仍能得到正向 Gate，非法样例得到 failure，且没有 ready 或 Auto-merge 写入。
7. 移除 canary 的候选标签或恢复 `merge:human`。在仓库 Auto-merge 仍关闭时，把 `Low-risk Auto-merge Gate` 加入 `main` 分支保护的 required checks，再触发 `audit` 为所有当前 head 播种 Gate；确认普通人工 PR 不被阻塞，原有五项 CI required checks 和 strict/admin 保护未被削弱。
8. 保持五个业务任务和 Watchdog 全部暂停，确认没有遗留 Auto-merge 请求后，才开启仓库 `allow_auto_merge=true`，再把模式切到 `enforce`；此时分支保护必须显示五项 CI 加 Gate 共六项 required checks。
9. 先启动 Watchdog 并取得连续两轮 HEALTHY，再恢复 Daily Digest、Triage、Issue Worker 与 PR/CI Worker；Codex Gate 最后启动，且只能做 `merge:human` 到 `merge:auto` 的候选标签切换。
10. 等待唯一 canary 自动合并，核对 lease 的 head SHA、60 秒提交窗口、squash marker、`main` SHA、24 小时配额和 post-merge CI。任何证据缺失都立即回滚，不扩大范围。

## 失败回滚

发现异常时按以下顺序处理：

1. 立即关闭仓库 Auto-merge；在 required Gate 仍存在时把模式降为 `audit`，保留人工 PR 的 pass-through。若需要完全零写，则先暂停合并并移除 required Gate，再切回 `dry-run`。
2. 暂停 Codex Gate、Issue Worker、PR/CI Worker 和会改变候选状态的 Watchdog 动作。
3. 对未合并 PR 禁用 Auto-merge，并要求 REST/GraphQL 双读同时为空；写 Observation tombstone、恢复同一 head 的 draft、移除 `merge:auto` 并恢复 `merge:human`。不得“自动修好后继续自动合并”。
4. 人工审计并回退 policy workflow；Watchdog 只能报警，不能自动修改 `.github/**`、策略脚本或分支保护。
5. 已完成的合并不能事务撤销，只能保留审计证据并另建人工审阅的 revert PR。

如果由 `GITHUB_TOKEN` 完成的合并没有触发预期的 `main` push CI，也必须回退。是否改用独立低权限 GitHub App 是后续单独的人工决策，不能在本轮 canary 中临时放宽身份或权限。
