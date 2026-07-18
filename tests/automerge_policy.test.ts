import { describe, expect, test } from "bun:test";
import {
  CANARY_PENDING_CONTENT,
  CANARY_PENDING_LINE,
  CANARY_VERIFIED_LINE,
  autoMergeReadbackFindings,
  GATE_EXTERNAL_ID_PREFIXES,
  autoMergeCommitMarker,
  classifyAutoMergeQuotaEvidence,
  classifyCommitPolicyMarker,
  classifyEventTombstoneImpact,
  countRecentAutoMergeEvidence,
  computeAuthorizationFingerprint,
  computeDiffFingerprint,
  establishAuthorizationLease,
  expectedAutoMergeCommitHeadline,
  evaluateExactAutoMergeRequest,
  evaluateAutoMergePolicy,
  evaluatePostLeaseSafety,
  gateExternalId,
  interruptionTombstoneReason,
  isCanaryTransition,
  leaseSuccessWindowFindings,
  MIN_CANDIDATE_ADMISSION_REMAINING_MS,
  MIN_LEASE_SUCCESS_REMAINING_MS,
  observationExternalId,
  observationTombstoneExternalId,
  orderPreflightPulls,
  planEnforceSchedule,
  resolveIssueAffectedPulls,
  REQUIRED_CHECKS,
  TRUSTED_CI_WORKFLOW_ID,
  validateTrustedWorkflowSha,
  type AutoMergePolicySnapshot,
  type PullRequestSnapshot,
} from "../scripts/check-automerge-policy.ts";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const baseContent = [
  "# 低风险自动合并演练",
  "",
  "本文件只用于验证低风险自动合并链路。首轮策略只允许下方状态行从“待验证”切换为“已验证”，不接受其他文件或其他内容变更。",
  "",
  "<!-- automerge-canary-state:start -->",
  CANARY_PENDING_LINE,
  "<!-- automerge-canary-state:end -->",
  "",
].join("\n");
const headContent = baseContent.replace(CANARY_PENDING_LINE, CANARY_VERIFIED_LINE);
const patch = [
  "@@ -3,5 +3,5 @@",
  " 本文件只用于验证低风险自动合并链路。首轮策略只允许下方状态行从“待验证”切换为“已验证”，不接受其他文件或其他内容变更。",
  " ",
  " <!-- automerge-canary-state:start -->",
  `-${CANARY_PENDING_LINE}`,
  `+${CANARY_VERIFIED_LINE}`,
  " <!-- automerge-canary-state:end -->",
].join("\n");

function validSnapshot(): AutoMergePolicySnapshot {
  const files = [{
    filename: "docs/AUTOMERGE-CANARY.md",
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    patch,
  }];
  const diff = computeDiffFingerprint(baseSha, headSha, files);
  const snapshot: AutoMergePolicySnapshot = {
    repository: "Jassy930/livis-relay-daemon",
    repositoryId: 1_304_630_129,
    defaultBranch: "main",
    currentMainSha: baseSha,
    mainComparison: {
      status: "ahead",
      aheadBy: 1,
      behindBy: 0,
      mergeBaseSha: baseSha,
      baseSha,
      headSha,
    },
    branchProtection: {
      strict: true,
      enforceAdmins: true,
      requireLinearHistory: true,
      requireConversationResolution: true,
      allowForcePushes: false,
      allowDeletions: false,
      requiredChecks: [...REQUIRED_CHECKS, "Low-risk Auto-merge Gate"].map((context) => ({
        context,
        appId: 15_368,
      })),
    },
    repositoryAllowsAutoMerge: true,
    now: "2026-07-18T08:30:00.000Z",
    headCommittedAt: "2026-07-18T08:00:00.000Z",
    recentAutoMergeCount: 0,
    unresolvedReviewThreads: 0,
    pullRequest: {
      number: 21,
      nodeId: "PR_fixture",
      state: "open",
      draft: true,
      body: "文档措辞修正。\n\n<!-- codex-issue-worker:v1 issue=20 -->",
      author: "Jassy930",
      baseRef: "main",
      baseSha,
      baseRepositoryId: 1_304_630_129,
      headRef: "codex/issue-20-doc-wording",
      headSha,
      headRepository: "Jassy930/livis-relay-daemon",
      headRepositoryId: 1_304_630_129,
      mergeable: true,
      mergeableState: "draft",
      commitCount: 1,
      labels: ["merge:auto"],
      requestedReviewers: [],
      requestedTeams: [],
      autoMergeEnabled: false,
      autoMergeRequest: null,
    },
    issue: {
      number: 20,
      state: "open",
      author: "Jassy930",
      labels: ["documentation", "decision:auto"],
      updatedAt: "2026-07-18T07:50:00.000Z",
      isPullRequest: false,
    },
    files,
    baseContent,
    headContent,
    comments: [{
      id: 400,
      author: "Jassy930",
      body: `<!-- codex-automerge-candidate:v1 pr=21 head=${headSha} diff=${diff} -->`,
      createdAt: "2026-07-18T08:10:00.000Z",
      updatedAt: "2026-07-18T08:10:00.000Z",
    }],
    reviews: 0,
    reviewComments: 0,
    checkRuns: REQUIRED_CHECKS.map((name) => ({
      id: 100 + REQUIRED_CHECKS.indexOf(name),
      name,
      status: "completed",
      conclusion: "success",
      appId: 15_368,
      headSha,
      checkSuiteId: 200,
      workflowRunId: 300,
      workflowRunAttempt: 1,
      workflowId: TRUSTED_CI_WORKFLOW_ID,
      workflowPath: ".github/workflows/ci.yml",
      workflowEvent: "pull_request",
      workflowHeadSha: headSha,
      workflowStatus: "completed",
      workflowConclusion: "success",
      workflowRepositoryId: 1_304_630_129,
      workflowHeadRepositoryId: 1_304_630_129,
      workflowPullRequests: [{
        number: 21,
        baseRef: "main",
        baseSha,
        baseRepositoryId: 1_304_630_129,
        headSha,
        headRepositoryId: 1_304_630_129,
      }],
    })),
  };
  snapshot.checkRuns.push({
    id: 500,
    name: "Low-risk Auto-merge Observation",
    status: "completed",
    conclusion: "neutral",
    appId: 15_368,
    externalId: observationExternalId(snapshot),
    startedAt: "2026-07-18T08:00:00.000Z",
    headSha,
  });
  return snapshot;
}

describe("低风险 Auto-merge policy", () => {
  test("workflow 固定信任 main、使用仓库级锁，并按三态物理隔离 token 权限", async () => {
    const workflow = await Bun.file(new URL("../.github/workflows/automerge-policy.yml", import.meta.url)).text();
    expect(workflow).toContain("pull_request_target:\n    branches: [main]");
    expect(workflow.match(/ref: \$\{\{ github\.workflow_sha \}\}/g)?.length).toBe(3);
    expect(workflow.match(/AUTOMERGE_TRUSTED_WORKFLOW_SHA: \$\{\{ github\.workflow_sha \}\}/g)?.length).toBe(3);
    expect(workflow).toContain("group: livis-relay-daemon-automerge-policy");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("permissions: {}");
    expect(workflow.match(/timeout-minutes: 25/g)?.length).toBe(3);
    expect(workflow.match(/timeout-minutes: 5/g)?.length).toBe(6);
    expect(workflow.match(/timeout-minutes: 10/g)?.length).toBe(3);

    const dryRun = workflow.split("\n  audit:\n")[0]!.split("\n  dry-run:\n")[1]!;
    const audit = workflow.split("\n  audit:\n")[1]!.split("\n  enforce:\n")[0]!;
    const enforce = workflow.split("\n  enforce:\n")[1]!;
    expect(dryRun).toContain("AUTOMERGE_POLICY_MODE: dry-run");
    expect(dryRun).toContain("checks: read");
    expect(dryRun).toContain("contents: read");
    expect(dryRun).toContain("pull-requests: read");
    expect(dryRun).not.toContain(": write");
    expect(audit).toContain("AUTOMERGE_POLICY_MODE: audit");
    expect(audit).toContain("checks: write");
    expect(audit).toContain("contents: read");
    expect(audit).toContain("pull-requests: read");
    expect(audit).not.toContain("contents: write");
    expect(audit).not.toContain("pull-requests: write");
    expect(enforce).toContain("AUTOMERGE_POLICY_MODE: enforce");
    expect(enforce).toContain("checks: write");
    expect(enforce).toContain("contents: write");
    expect(enforce).toContain("pull-requests: write");
    expect(workflow).not.toContain("github.event.pull_request.head");
    expect(workflow).not.toContain("github.event.pull_request.base.sha");
  });

  test("策略写入只接受仍等于实时 main 的可信 workflow SHA", async () => {
    const trusted = "a".repeat(40);
    expect(validateTrustedWorkflowSha(trusted, trusted)).toEqual([]);
    expect(validateTrustedWorkflowSha(undefined, trusted)).toContain("可信 workflow SHA 缺失或格式无效");
    expect(validateTrustedWorkflowSha("not-a-sha", trusted)).toContain("可信 workflow SHA 缺失或格式无效");
    expect(validateTrustedWorkflowSha(trusted, "not-a-sha")).toContain("实时 main SHA 格式无效");
    expect(validateTrustedWorkflowSha(trusted, "b".repeat(40))).toContain("可信 workflow SHA 不再等于实时 main SHA");

    const script = await Bun.file(new URL("../scripts/check-automerge-policy.ts", import.meta.url)).text();
    expect(script.match(/await this\.assertCurrentWorkflowMayWrite\(/g)?.length).toBe(6);
    expect(script).toContain("assertCurrentWorkflowMayWrite(true)");
    expect(script).toContain("allowFailCloseDuringCleanup && this.cleanupMode");
    expect(script).toContain("拒绝创建迟到的替代 success");
  });

  test("enforce 调度先覆盖全部人工 Gate，仅在安全且余量充足时接纳一个候选", async () => {
    const pull = (number: number, candidate: boolean): PullRequestSnapshot => ({
      ...structuredClone(validSnapshot().pullRequest),
      number,
      labels: candidate ? ["merge:auto"] : ["merge:human"],
    });
    const pulls = [pull(9, false), pull(7, true), pull(2, false), pull(3, true)];

    const ready = planEnforceSchedule(pulls, true, MIN_CANDIDATE_ADMISSION_REMAINING_MS);
    expect(ready.nonCandidates.map((pr) => pr.number)).toEqual([2, 9]);
    expect(ready.admittedCandidate?.number).toBe(3);
    expect(ready.deferredCandidates.map((pr) => pr.number)).toEqual([7]);
    expect(ready.admissionBlockedReason).toBeNull();

    const unsafe = planEnforceSchedule(pulls, false, Number.POSITIVE_INFINITY);
    expect(unsafe.nonCandidates.map((pr) => pr.number)).toEqual([2, 9]);
    expect(unsafe.admittedCandidate).toBeNull();
    expect(unsafe.deferredCandidates.map((pr) => pr.number)).toEqual([3, 7]);
    expect(unsafe.admissionBlockedReason).toContain("fail-safe");

    const late = planEnforceSchedule(pulls, true, MIN_CANDIDATE_ADMISSION_REMAINING_MS - 1);
    expect(late.admittedCandidate).toBeNull();
    expect(late.deferredCandidates.map((pr) => pr.number)).toEqual([3, 7]);
    expect(late.admissionBlockedReason).toContain("180 秒");

    const script = await Bun.file(new URL("../scripts/check-automerge-policy.ts", import.meta.url)).text();
    const humanGate = script.indexOf("for (const pr of initialSchedule.nonCandidates)");
    const candidateAdmission = script.indexOf("const admissionSchedule = planEnforceSchedule");
    const candidateExecution = script.indexOf("await enforceCandidate(client, event, admissionSchedule.admittedCandidate");
    expect(humanGate).toBeGreaterThan(0);
    expect(candidateAdmission).toBeGreaterThan(humanGate);
    expect(candidateExecution).toBeGreaterThan(candidateAdmission);
    expect(script).toContain("failures.length === 0");
  });

  test("enforce 预检优先收口既有 Auto-merge，并在软截止后给尾部 head 写 failure Gate", async () => {
    const pulls = [
      { number: 9, auto_merge: null },
      { number: 7, auto_merge: { enabled_at: "now" } },
      { number: 2, auto_merge: null },
    ] as unknown as Parameters<typeof orderPreflightPulls>[0];
    expect(orderPreflightPulls(pulls, 9).map((pr) => pr.number)).toEqual([7, 9, 2]);

    const script = await Bun.file(new URL("../scripts/check-automerge-policy.ts", import.meta.url)).text();
    expect(script).toContain("const orderedOpenPulls = orderPreflightPulls");
    expect(script).toContain("failCloseIncompletePreflight(");
    expect(script).toContain("failCloseAndDisarmPreflight(");
    expect(script).toContain("client.beginCleanup()");
    expect(script).toContain("禁止复用旧 Gate");
    const failCloseHelper = script.split("async function failCloseAndDisarmPreflight")[1]!
      .split("async function ensureObservation")[0]!;
    expect(failCloseHelper.match(/try \{/g)?.length).toBe(2);
    expect(failCloseHelper).toContain("failCloseIncompletePreflight");
    expect(failCloseHelper).toContain("disableAndVerifyAutoMerge");
  });

  test("仓库内 canary 初始文件与策略的 canonical 内容逐字一致", async () => {
    const actual = await Bun.file(new URL("../docs/AUTOMERGE-CANARY.md", import.meta.url)).text();
    expect(actual).toBe(CANARY_PENDING_CONTENT);
  });

  test("原生 Auto-merge 原子绑定 expected head，且脚本没有直接 merge REST 路径", async () => {
    const script = await Bun.file(new URL("../scripts/check-automerge-policy.ts", import.meta.url)).text();
    expect(script).toContain("expectedHeadOid: $head");
    expect(script).not.toMatch(/\/pulls\/\$\{[^}]+\}\/merge/);
    expect(script).not.toContain("mergePullRequest(");
  });

  test("接受与当前 SHA 和 diff 绑定的唯一 canary 状态切换", () => {
    const result = evaluateAutoMergePolicy(validSnapshot());
    expect(result.findings).toEqual([]);
    expect(result.eligible).toBeTrue();
  });

  test("拒绝伪造或陈旧的 candidate marker", () => {
    const snapshot = validSnapshot();
    snapshot.comments[0]!.body = snapshot.comments[0]!.body.replace(headSha, "c".repeat(40));
    const result = evaluateAutoMergePolicy(snapshot);
    expect(result.eligible).toBeFalse();
    expect(result.findings.some((item) => item.includes("candidate marker"))).toBeTrue();

    const early = validSnapshot();
    early.comments[0]!.createdAt = "2026-07-18T08:25:00.000Z";
    expect(evaluateAutoMergePolicy(early).eligible).toBeFalse();
  });

  test("Issue marker 必须唯一且与 head 分支编号一致", () => {
    const duplicate = validSnapshot();
    duplicate.pullRequest.body += "\n<!-- codex-issue-worker:v1 issue=20 -->";
    expect(evaluateAutoMergePolicy(duplicate).eligible).toBeFalse();

    const mismatch = validSnapshot();
    mismatch.pullRequest.headRef = "codex/issue-19-doc-wording";
    expect(evaluateAutoMergePolicy(mismatch).findings).toContain("PR head 分支编号与 Issue marker 不一致");
  });

  test("拒绝其他路径、多个文件和非单行替换", () => {
    const critical = validSnapshot();
    critical.files[0]!.filename = "docs/FAQ.md";
    expect(evaluateAutoMergePolicy(critical).eligible).toBeFalse();

    const multiple = validSnapshot();
    multiple.files.push({ ...multiple.files[0]!, filename: "docs/FAQ-SECOND.md" });
    expect(evaluateAutoMergePolicy(multiple).findings).toContain("PR 必须只修改一个文件");

    const oversized = validSnapshot();
    oversized.files[0]!.additions = 2;
    expect(evaluateAutoMergePolicy(oversized).findings).toContain("canary 必须恰好替换一行");
  });

  test("除固定状态切换外，拒绝标题、链接、命令、路径、结构与 Unicode 混淆", () => {
    const rejected = [
      ["# 原标题", "# 新标题"],
      ["访问原页面。", "访问 https://example.invalid 页面。"],
      ["使用原方式。", "使用 `bun run check`。"],
      ["使用原方式。", "请运行 rm -rf temp。"],
      ["原位置。", "位置为 docs/FAQ.md。"],
      ["原说明", "新说明\n---"],
      ["原说明", "项目 | 状态"],
      [CANARY_PENDING_LINE, "当前低风险自动合并演练状态：已验��。"],
    ];
    for (const [before, after] of rejected) {
      expect(
        isCanaryTransition(
          `@@ -1 +1 @@\n-${before}\n+${after}`,
          `${before}\n`,
          `${after}\n`,
        ),
        after,
      ).toBeFalse();
    }
  });

  test("拒绝非自动授权 Issue、PR 伪装 Issue、fork、额外 commit 与非可信 check", () => {
    const approved = validSnapshot();
    approved.issue!.labels = ["documentation", "decision:approved"];
    expect(evaluateAutoMergePolicy(approved).eligible).toBeFalse();

    const pullAsIssue = validSnapshot();
    pullAsIssue.issue!.isPullRequest = true;
    expect(evaluateAutoMergePolicy(pullAsIssue).findings).toContain("关联 Issue API 对象不是独立 Issue");

    const fork = validSnapshot();
    fork.pullRequest.headRepository = "someone/fork";
    expect(evaluateAutoMergePolicy(fork).eligible).toBeFalse();

    const commits = validSnapshot();
    commits.pullRequest.commitCount = 2;
    expect(evaluateAutoMergePolicy(commits).findings).toContain("PR 必须恰好包含一个 commit");

    const checks = validSnapshot();
    checks.checkRuns[0]!.appId = 1;
    expect(evaluateAutoMergePolicy(checks).eligible).toBeFalse();

    const wrongWorkflow = validSnapshot();
    wrongWorkflow.checkRuns[0]!.workflowPath = ".github/workflows/untrusted.yml";
    expect(evaluateAutoMergePolicy(wrongWorkflow).eligible).toBeFalse();

    const wrongWorkflowId = validSnapshot();
    wrongWorkflowId.checkRuns[0]!.workflowId = 1;
    expect(evaluateAutoMergePolicy(wrongWorkflowId).eligible).toBeFalse();

    const wrongPullRequest = validSnapshot();
    wrongPullRequest.checkRuns[0]!.workflowPullRequests![0]!.number = 22;
    expect(evaluateAutoMergePolicy(wrongPullRequest).eligible).toBeFalse();

    const wrongBase = validSnapshot();
    wrongBase.checkRuns[0]!.workflowPullRequests![0]!.baseRef = "release";
    expect(evaluateAutoMergePolicy(wrongBase).eligible).toBeFalse();

    const mixedRuns = validSnapshot();
    mixedRuns.checkRuns[0]!.checkSuiteId = 201;
    expect(evaluateAutoMergePolicy(mixedRuns).findings).toContain("required checks 不属于同一次可信 CI workflow run");
  });

  test("拒绝不稳定候选、未更新 main、既有自动合并和 review 状态", () => {
    const stale = validSnapshot();
    stale.checkRuns.find((check) => check.name === "Low-risk Auto-merge Observation")!.startedAt =
      "2026-07-18T08:25:00.000Z";
    expect(evaluateAutoMergePolicy(stale).findings).toContain("当前 head/marker 的可信 observation 尚未稳定满 15 分钟");

    const prepublished = validSnapshot();
    prepublished.checkRuns = prepublished.checkRuns.filter((check) => check.name !== "Low-risk Auto-merge Observation");
    prepublished.comments[0]!.createdAt = "2026-07-17T08:00:00.000Z";
    prepublished.comments[0]!.updatedAt = "2026-07-17T08:00:00.000Z";
    expect(evaluateAutoMergePolicy(prepublished).findings).toContain("当前 head/marker 的可信 observation 尚未稳定满 15 分钟");

    const revertedAuthorization = validSnapshot();
    revertedAuthorization.checkRuns.push({
      id: 501,
      name: "Low-risk Auto-merge Observation",
      status: "completed",
      conclusion: "neutral",
      appId: 15_368,
      externalId: "low-risk-automerge-observation:v1:newer-different-state",
      startedAt: "2026-07-18T08:20:00.000Z",
      headSha,
    });
    expect(evaluateAutoMergePolicy(revertedAuthorization).findings).toContain(
      "当前 head/marker 的可信 observation 尚未稳定满 15 分钟",
    );

    const behind = validSnapshot();
    behind.mainComparison!.behindBy = 1;
    expect(evaluateAutoMergePolicy(behind).findings).toContain("PR 未基于最新 main");

    const throttled = validSnapshot();
    throttled.recentAutoMergeCount = 1;
    expect(evaluateAutoMergePolicy(throttled).findings).toContain("过去 24 小时已发生低风险自动合并");

    const reviewed = validSnapshot();
    reviewed.unresolvedReviewThreads = 1;
    expect(evaluateAutoMergePolicy(reviewed).eligible).toBeFalse();

    const staleIssue = validSnapshot();
    staleIssue.issue!.updatedAt = "2026-07-18T08:21:00.000Z";
    expect(evaluateAutoMergePolicy(staleIssue).findings).toContain("candidate marker 早于关联 Issue 的最近授权变更");
  });

  test("非候选与中断事件 tombstone 使旧成熟 Observation 永久失效", () => {
    const restored = validSnapshot();
    const nonCandidate = structuredClone(restored.pullRequest);
    nonCandidate.labels = ["merge:human"];
    const passThroughTombstone = observationTombstoneExternalId(nonCandidate, "non-candidate-pass-through");
    expect(observationTombstoneExternalId(nonCandidate, "non-candidate-pass-through")).toBe(passThroughTombstone);
    restored.checkRuns.push({
      id: 501,
      name: "Low-risk Auto-merge Observation",
      status: "completed",
      conclusion: "neutral",
      appId: 15_368,
      externalId: passThroughTombstone,
      startedAt: "2026-07-18T08:20:00.000Z",
      headSha,
    });
    expect(evaluateAutoMergePolicy(restored).findings).toContain(
      "当前 head/marker 的可信 observation 尚未稳定满 15 分钟",
    );

    const interruptingActions = [
      "closed",
      "reopened",
      "labeled",
      "unlabeled",
      "edited",
      "converted_to_draft",
      "ready_for_review",
      "review_requested",
      "review_request_removed",
      "synchronize",
    ];
    for (const [index, action] of interruptingActions.entries()) {
      const reason = interruptionTombstoneReason({
        action,
        label: action === "unlabeled" ? { name: "merge:auto" } : undefined,
        repository: {
          id: 1_304_630_129,
          full_name: "Jassy930/livis-relay-daemon",
          default_branch: "main",
        },
        pull_request: { number: 21, head: { sha: headSha } },
      });
      expect(reason).not.toBeNull();
      const interrupted = validSnapshot();
      interrupted.checkRuns.push({
        id: 600 + index,
        name: "Low-risk Auto-merge Observation",
        status: "completed",
        conclusion: "neutral",
        appId: 15_368,
        externalId: observationTombstoneExternalId(interrupted.pullRequest, reason!),
        startedAt: "2026-07-18T08:29:00.000Z",
        headSha,
      });
      expect(evaluateAutoMergePolicy(interrupted).eligible, action).toBeFalse();
    }

    const withFreshB = structuredClone(restored);
    withFreshB.checkRuns.push({
      id: 700,
      name: "Low-risk Auto-merge Observation",
      status: "completed",
      conclusion: "neutral",
      appId: 15_368,
      externalId: observationExternalId(withFreshB),
      startedAt: "2026-07-18T08:29:00.000Z",
      headSha,
    });
    expect(evaluateAutoMergePolicy(withFreshB).eligible).toBeFalse();
    withFreshB.checkRuns.at(-1)!.startedAt = "2026-07-18T08:00:00.000Z";
    expect(evaluateAutoMergePolicy(withFreshB).eligible).toBeTrue();
  });

  test("评论、review 与 Issue 事件精确路由到 live-head tombstone", async () => {
    const repository = {
      id: 1_304_630_129,
      full_name: "Jassy930/livis-relay-daemon",
      default_branch: "main",
    };
    const pullCommentCreated = classifyEventTombstoneImpact("issue_comment", {
      repository,
      action: "created",
      issue: { number: 21, pull_request: {} },
      comment: { id: 900 },
    }, "1001");
    const pullCommentDeleted = classifyEventTombstoneImpact("issue_comment", {
      repository,
      action: "deleted",
      issue: { number: 21, pull_request: {} },
      comment: { id: 900 },
    }, "1002");
    expect(pullCommentCreated?.directPullNumber).toBe(21);
    expect(pullCommentDeleted?.directPullNumber).toBe(21);
    expect(pullCommentCreated?.reason).not.toBe(pullCommentDeleted?.reason);

    const issueComment = classifyEventTombstoneImpact("issue_comment", {
      repository,
      action: "edited",
      issue: { number: 20 },
      comment: { id: 901 },
    }, "1003");
    expect(issueComment?.sourceIssueNumber).toBe(20);

    const review = classifyEventTombstoneImpact("pull_request_review", {
      repository,
      action: "dismissed",
      pull_request: { number: 21 },
      review: { id: 902 },
    }, "1004");
    const reviewCommentCreated = classifyEventTombstoneImpact("pull_request_review_comment", {
      repository,
      action: "created",
      pull_request: { number: 21 },
      comment: { id: 903 },
    }, "1005");
    const reviewComment = classifyEventTombstoneImpact("pull_request_review_comment", {
      repository,
      action: "deleted",
      pull_request: { number: 21 },
      comment: { id: 903 },
    }, "1006");
    expect(review?.directPullNumber).toBe(21);
    expect(reviewComment?.directPullNumber).toBe(21);
    expect(reviewCommentCreated?.reason).not.toBe(reviewComment?.reason);

    const issueEvent = classifyEventTombstoneImpact("issues", {
      repository,
      action: "unlabeled",
      issue: { number: 20 },
      label: { name: "decision:auto" },
    }, "1007");
    expect(issueEvent?.sourceIssueNumber).toBe(20);

    const linkedPulls = [
      { number: 21, body: "<!-- codex-issue-worker:v1 issue=20 -->", labels: ["merge:auto"] },
      { number: 22, body: "<!-- codex-issue-worker:v1 issue=19 -->", labels: ["merge:auto"] },
      { number: 23, body: "人工 PR", labels: ["merge:human"] },
    ];
    expect(resolveIssueAffectedPulls(20, linkedPulls)).toEqual([21]);
    expect(resolveIssueAffectedPulls(999, linkedPulls)).toEqual([21, 22]);

    const script = await Bun.file(new URL("../scripts/check-automerge-policy.ts", import.meta.url)).text();
    expect(script).toContain("process.env.GITHUB_EVENT_NAME");
    expect(script).toContain("process.env.GITHUB_RUN_ID");
    expect(script).toContain("WOULD_TOMBSTONE");
    expect(script).not.toContain("eventHeadSha");
  });

  test("评论 add→delete 后状态恢复仍必须创建新 Observation", () => {
    const restored = validSnapshot();
    const created = classifyEventTombstoneImpact("issue_comment", {
      repository: {
        id: 1_304_630_129,
        full_name: "Jassy930/livis-relay-daemon",
        default_branch: "main",
      },
      action: "created",
      issue: { number: 21, pull_request: {} },
      comment: { id: 910 },
    }, "1010")!;
    const deleted = classifyEventTombstoneImpact("issue_comment", {
      repository: {
        id: 1_304_630_129,
        full_name: "Jassy930/livis-relay-daemon",
        default_branch: "main",
      },
      action: "deleted",
      issue: { number: 21, pull_request: {} },
      comment: { id: 910 },
    }, "1011")!;
    for (const [id, reason] of [[800, created.reason], [801, deleted.reason]] as const) {
      restored.checkRuns.push({
        id,
        name: "Low-risk Auto-merge Observation",
        status: "completed",
        conclusion: "neutral",
        appId: 15_368,
        externalId: observationTombstoneExternalId(restored.pullRequest, reason),
        startedAt: "2026-07-18T08:20:00.000Z",
        headSha,
      });
    }
    expect(evaluateAutoMergePolicy(restored).eligible).toBeFalse();

    restored.checkRuns.push({
      id: 802,
      name: "Low-risk Auto-merge Observation",
      status: "completed",
      conclusion: "neutral",
      appId: 15_368,
      externalId: observationExternalId(restored),
      startedAt: "2026-07-18T08:29:00.000Z",
      headSha,
    });
    expect(evaluateAutoMergePolicy(restored).eligible).toBeFalse();
    restored.checkRuns.at(-1)!.startedAt = "2026-07-18T08:00:00.000Z";
    expect(evaluateAutoMergePolicy(restored).eligible).toBeTrue();
  });

  test("拒绝仓库 Auto-merge 或 head-bound required Gate 未就绪", () => {
    const disabled = validSnapshot();
    disabled.repositoryAllowsAutoMerge = false;
    expect(evaluateAutoMergePolicy(disabled).findings).toContain("仓库尚未启用 GitHub 原生 Auto-merge");

    const missingGate = validSnapshot();
    missingGate.branchProtection!.requiredChecks.pop();
    expect(evaluateAutoMergePolicy(missingGate).eligible).toBeFalse();

    const weakenedProtection = validSnapshot();
    weakenedProtection.branchProtection!.allowForcePushes = true;
    expect(evaluateAutoMergePolicy(weakenedProtection).eligible).toBeFalse();

    const extraRequiredCheck = validSnapshot();
    extraRequiredCheck.branchProtection!.requiredChecks.push({ context: "Unreviewed extra", appId: 15_368 });
    expect(evaluateAutoMergePolicy(extraRequiredCheck).findings).toContain("分支保护 required checks 不是精确安全基线");
  });

  test("audit 允许 Auto-merge 关闭且 Gate 尚未 required，enforce 仍拒绝", () => {
    const snapshot = validSnapshot();
    snapshot.repositoryAllowsAutoMerge = false;
    snapshot.branchProtection!.requiredChecks = snapshot.branchProtection!.requiredChecks.filter(
      (check) => check.context !== "Low-risk Auto-merge Gate",
    );
    expect(evaluateAutoMergePolicy(snapshot, "audit").eligible).toBeTrue();
    expect(evaluateAutoMergePolicy(snapshot, "enforce").eligible).toBeFalse();
  });

  test("完整授权指纹覆盖可变元数据，post-lease 只接受同 head 与平台安全状态", () => {
    const before = validSnapshot();
    const changed = structuredClone(before);
    changed.issue!.labels = ["decision:human", "documentation"];
    expect(computeAuthorizationFingerprint(changed)).not.toBe(computeAuthorizationFingerprint(before));

    const workflowOwnedTransition = structuredClone(before);
    workflowOwnedTransition.pullRequest.draft = false;
    workflowOwnedTransition.pullRequest.autoMergeEnabled = true;
    workflowOwnedTransition.pullRequest.mergeable = null;
    expect(computeAuthorizationFingerprint(workflowOwnedTransition)).toBe(computeAuthorizationFingerprint(before));

    const establishedAt = "2026-07-18T08:30:01.000Z";
    const leaseReadback = structuredClone(before);
    leaseReadback.now = "2026-07-18T08:30:02.000Z";
    const leaseResult = establishAuthorizationLease(before, leaseReadback, establishedAt);
    expect(leaseResult.findings).toEqual([]);
    expect(leaseResult.lease).not.toBeNull();

    const afterLease = structuredClone(before);
    afterLease.now = "2026-07-18T08:30:30.000Z";
    afterLease.issue!.labels = ["decision:human", "documentation"];
    afterLease.pullRequest.labels = ["merge:human"];
    expect(evaluatePostLeaseSafety(afterLease, leaseResult.lease!).eligible).toBeTrue();

    const exactRequest = structuredClone(afterLease);
    exactRequest.pullRequest.autoMergeEnabled = true;
    exactRequest.pullRequest.autoMergeRequest = {
      mergeMethod: "SQUASH",
      commitHeadline: expectedAutoMergeCommitHeadline(21),
      commitBody: autoMergeCommitMarker(21, headSha, computeDiffFingerprint(baseSha, headSha, exactRequest.files)),
      enabledBy: "github-actions[bot]",
      enabledAt: "2026-07-18T08:30:20.000Z",
    };
    expect(evaluatePostLeaseSafety(exactRequest, leaseResult.lease!, "exact").eligible).toBeTrue();
    expect(evaluateExactAutoMergeRequest(exactRequest, leaseResult.lease!)).toEqual([]);
    expect(evaluatePostLeaseSafety(afterLease, leaseResult.lease!, "exact").eligible).toBeFalse();
    expect(evaluatePostLeaseSafety(exactRequest, leaseResult.lease!, "absent").eligible).toBeFalse();

    const invalidRequests: Array<[
      string,
      (snapshot: AutoMergePolicySnapshot) => void,
      string,
    ]> = [
      ["merge method", (snapshot) => { snapshot.pullRequest.autoMergeRequest!.mergeMethod = "MERGE"; }, "mergeMethod"],
      ["headline", (snapshot) => { snapshot.pullRequest.autoMergeRequest!.commitHeadline = "docs: 伪造标题"; }, "commitHeadline"],
      [
        "head provenance",
        (snapshot) => {
          snapshot.pullRequest.autoMergeRequest!.commitBody = autoMergeCommitMarker(
            21,
            "c".repeat(40),
            computeDiffFingerprint(baseSha, headSha, snapshot.files),
          );
        },
        "commitBody",
      ],
      [
        "diff provenance",
        (snapshot) => {
          snapshot.pullRequest.autoMergeRequest!.commitBody = autoMergeCommitMarker(21, headSha, "d".repeat(64));
        },
        "commitBody",
      ],
      ["enabled actor", (snapshot) => { snapshot.pullRequest.autoMergeRequest!.enabledBy = "Jassy930"; }, "enabledBy"],
      ["early enable", (snapshot) => { snapshot.pullRequest.autoMergeRequest!.enabledAt = "2026-07-18T08:29:59.000Z"; }, "enabledAt"],
      ["late enable", (snapshot) => { snapshot.pullRequest.autoMergeRequest!.enabledAt = "2026-07-18T08:31:02.000Z"; }, "enabledAt"],
    ];
    for (const [label, mutate, finding] of invalidRequests) {
      const invalid = structuredClone(exactRequest);
      mutate(invalid);
      expect(evaluateExactAutoMergeRequest(invalid, leaseResult.lease!).some((item) => item.includes(finding)), label)
        .toBeTrue();
      expect(evaluatePostLeaseSafety(invalid, leaseResult.lease!, "exact").eligible, label).toBeFalse();
    }

    const replacedRequest = structuredClone(exactRequest);
    replacedRequest.pullRequest.autoMergeRequest!.mergeMethod = "REBASE";
    replacedRequest.pullRequest.autoMergeRequest!.enabledBy = "Jassy930";
    expect(evaluatePostLeaseSafety(replacedRequest, leaseResult.lease!, "exact").eligible).toBeFalse();

    const movedHead = structuredClone(afterLease);
    movedHead.pullRequest.headSha = "c".repeat(40);
    expect(evaluatePostLeaseSafety(movedHead, leaseResult.lease!).eligible).toBeFalse();

    const expired = structuredClone(afterLease);
    expired.now = "2026-07-18T08:31:02.000Z";
    expect(evaluatePostLeaseSafety(expired, leaseResult.lease!).findings).toContain("authorization lease 已过期");
  });

  test("success Gate 前后都必须保留 GitHub server time 证明的 lease 余量", () => {
    const before = validSnapshot();
    const after = structuredClone(before);
    after.now = "2026-07-18T08:30:02.000Z";
    const lease = establishAuthorizationLease(before, after, "2026-07-18T08:30:01.000Z").lease!;
    expect(MIN_LEASE_SUCCESS_REMAINING_MS).toBe(30_000);
    expect(leaseSuccessWindowFindings(lease, "2026-07-18T08:30:20.000Z")).toEqual([]);
    expect(leaseSuccessWindowFindings(lease, "2026-07-18T08:30:40.000Z")).toContain(
      "authorization lease 剩余不足 30 秒",
    );
    expect(leaseSuccessWindowFindings(lease, "invalid").length).toBeGreaterThan(0);
  });

  test("失败清理要求 REST 与 GraphQL AutoMergeRequest 双读同时为空", async () => {
    const request = {
      mergeMethod: "SQUASH",
      commitHeadline: "headline",
      commitBody: "body",
      enabledAt: "2026-07-18T08:30:20.000Z",
      enabledBy: "github-actions[bot]",
    };
    expect(autoMergeReadbackFindings(false, null)).toEqual([]);
    expect(autoMergeReadbackFindings(true, null)).toContain("REST auto_merge 仍存在");
    expect(autoMergeReadbackFindings(false, request)).toContain("GraphQL AutoMergeRequest 仍存在");
    expect(autoMergeReadbackFindings(true, request)).toHaveLength(2);

    const script = await Bun.file(new URL("../scripts/check-automerge-policy.ts", import.meta.url)).text();
    expect(script).toContain("disableAndVerifyAutoMerge(client, original.number)");
    expect(script).toContain('ensureObservationTombstone(client, original, "enforce-failure")');
    expect(script).toContain("转回 draft 后读回不一致");
    expect(script).toContain("const finalAutoMergeState = await readAutoMergeState(client, listed.number)");
  });
});

describe("低风险 Auto-merge 配额证据", () => {
  const quotaNow = "2026-07-18T10:00:00.000Z";
  const mergeSha = "c".repeat(40);
  const diffSha = "d".repeat(64);

  function evidenceInput(overrides: Partial<Parameters<typeof classifyAutoMergeQuotaEvidence>[0]> = {}) {
    return {
      prNumber: 21,
      headSha,
      mergeCommitSha: mergeSha,
      mergedAt: "2026-07-18T09:30:00.000Z",
      mergedBy: "Jassy930",
      commitMessage: "普通人工合并",
      gateExternalIds: [],
      ...overrides,
    };
  }

  test("四种 Gate phase 使用物理隔离的 external ID", () => {
    const pr = validSnapshot().pullRequest;
    const authorization = "e".repeat(64);
    const ids = [
      gateExternalId(pr, "passThrough"),
      gateExternalId(pr, "audit", authorization),
      gateExternalId(pr, "enforcePreflight"),
      gateExternalId(pr, "enforceLease", authorization),
    ];
    expect(new Set(ids).size).toBe(4);
    expect(ids[0]).toStartWith(`${GATE_EXTERNAL_ID_PREFIXES.passThrough}:`);
    expect(ids[1]).toStartWith(`${GATE_EXTERNAL_ID_PREFIXES.audit}:`);
    expect(ids[2]).toStartWith(`${GATE_EXTERNAL_ID_PREFIXES.enforcePreflight}:`);
    expect(ids[3]).toStartWith(`${GATE_EXTERNAL_ID_PREFIXES.enforceLease}:`);
    expect(() => gateExternalId(pr, "enforceLease")).toThrow();
  });

  test("fail-safe 并集接受精确或畸形 marker、enforce lease、legacy Gate 与 Actions bot", () => {
    const exact = classifyAutoMergeQuotaEvidence(evidenceInput({
      commitMessage: `subject\n\n${autoMergeCommitMarker(21, headSha, diffSha)}`,
    }));
    expect(exact?.sources).toEqual(["exact-commit-marker"]);

    const malformed = classifyAutoMergeQuotaEvidence(evidenceInput({
      commitMessage: "codex-automerge-policy:v1 pr=broken",
    }));
    expect(malformed?.sources).toEqual(["malformed-policy-marker"]);
    expect(classifyCommitPolicyMarker(autoMergeCommitMarker(21, headSha, diffSha))).toEqual({
      source: "exact-commit-marker",
      prNumber: 21,
      headSha,
    });
    expect(classifyCommitPolicyMarker("codex-automerge-policy:v1 pr=broken")).toEqual({
      source: "malformed-policy-marker",
      prNumber: null,
      headSha: "",
    });

    const lease = classifyAutoMergeQuotaEvidence(evidenceInput({
      gateExternalIds: [gateExternalId(validSnapshot().pullRequest, "enforceLease", "f".repeat(64))],
    }));
    expect(lease?.sources).toEqual(["enforce-lease-gate"]);

    const legacy = classifyAutoMergeQuotaEvidence(evidenceInput({
      gateExternalIds: [`low-risk-automerge-gate:v1:pr=21:head=${headSha}:authorization=${"a".repeat(64)}`],
    }));
    expect(legacy?.sources).toEqual(["legacy-authorization-gate"]);

    const bot = classifyAutoMergeQuotaEvidence(evidenceInput({ mergedBy: "github-actions[bot]" }));
    expect(bot?.sources).toEqual(["github-actions-bot-merge"]);
  });

  test("audit/pass-through Gate 不占配额，多个证据按 PR 去重", () => {
    const pr = validSnapshot().pullRequest;
    expect(classifyAutoMergeQuotaEvidence(evidenceInput({
      gateExternalIds: [
        gateExternalId(pr, "audit", "a".repeat(64)),
        gateExternalId(pr, "passThrough"),
        gateExternalId(pr, "enforcePreflight"),
      ],
    }))).toBeNull();

    const first = classifyAutoMergeQuotaEvidence(evidenceInput({ mergedBy: "github-actions[bot]" }))!;
    const second = classifyAutoMergeQuotaEvidence(evidenceInput({
      commitMessage: autoMergeCommitMarker(21, headSha, diffSha),
    }))!;
    const other = classifyAutoMergeQuotaEvidence(evidenceInput({
      prNumber: 22,
      headSha: "e".repeat(40),
      mergedAt: "2026-07-17T09:59:59.999Z",
      mergedBy: "github-actions[bot]",
    }))!;
    expect(countRecentAutoMergeEvidence([first, second, other], quotaNow, 999)).toBe(1);
    expect(countRecentAutoMergeEvidence([first, second], quotaNow, 21)).toBe(0);
  });

  test("commit marker 在 associated PR 索引为空时也先独立占用配额", async () => {
    const markerOnly = classifyAutoMergeQuotaEvidence(evidenceInput({
      prNumber: null,
      headSha: "",
      commitMessage: "codex-automerge-policy:v1 pr=broken",
    }))!;
    expect(countRecentAutoMergeEvidence([markerOnly], quotaNow, 21)).toBe(1);

    const script = await Bun.file(new URL("../scripts/check-automerge-policy.ts", import.meta.url)).text();
    const commitMarker = script.indexOf("const commitMarker = classifyCommitPolicyMarker(commit.commit.message)");
    const associated = script.indexOf("const associated = await client.paginate<GitHubPullRequest>");
    expect(commitMarker).toBeGreaterThan(0);
    expect(associated).toBeGreaterThan(commitMarker);
  });
});
