const TARGET_REPOSITORY = "Jassy930/livis-relay-daemon";
const TARGET_REPOSITORY_ID = 1_304_630_129;
const TARGET_OWNER = "Jassy930";
const TARGET_DEFAULT_BRANCH = "main";
const GITHUB_ACTIONS_APP_ID = 15_368;
const TRUSTED_CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
export const TRUSTED_CI_WORKFLOW_ID = 315_569_085;
const GATE_CHECK_NAME = "Low-risk Auto-merge Gate";
export const GATE_EXTERNAL_ID_PREFIXES = {
  passThrough: "low-risk-automerge-gate:v2:phase=pass-through",
  audit: "low-risk-automerge-gate:v2:phase=audit",
  enforcePreflight: "low-risk-automerge-gate:v2:phase=enforce-preflight",
  enforceLease: "low-risk-automerge-gate:v2:phase=enforce-lease",
} as const;
const LEGACY_GATE_EXTERNAL_ID_PREFIX = "low-risk-automerge-gate:v1";
const POLICY_COMMIT_MARKER_PREFIX = "codex-automerge-policy:v1";
const OBSERVATION_CHECK_NAME = "Low-risk Auto-merge Observation";
const OBSERVATION_EXTERNAL_ID_PREFIX = "low-risk-automerge-observation:v1";
const OBSERVATION_TOMBSTONE_PREFIX = "low-risk-automerge-observation-tombstone:v1";
const CANARY_PATH = "docs/AUTOMERGE-CANARY.md";
export const CANARY_PENDING_LINE = "当前低风险自动合并演练状态：待验证。";
export const CANARY_VERIFIED_LINE = "当前低风险自动合并演练状态：已验证。";
export const CANARY_PENDING_CONTENT = `# 低风险自动合并演练

本文件只用于验证低风险自动合并链路。首轮策略只允许下方状态行从“待验证”切换为“已验证”，不接受其他文件或其他内容变更。

<!-- automerge-canary-state:start -->
${CANARY_PENDING_LINE}
<!-- automerge-canary-state:end -->
`;
export const CANARY_VERIFIED_CONTENT = CANARY_PENDING_CONTENT.replace(
  CANARY_PENDING_LINE,
  CANARY_VERIFIED_LINE,
);
const MIN_CANDIDATE_AGE_MS = 15 * 60 * 1_000;
const AUTO_MERGE_WINDOW_MS = 24 * 60 * 60 * 1_000;
const AUTO_MERGE_SCAN_MARGIN_MS = 5 * 60 * 1_000;
const AUTHORIZATION_LEASE_MS = 60 * 1_000;
const RUN_SOFT_DEADLINE_MS = 5 * 60 * 1_000;
const RUN_CLEANUP_HARD_DEADLINE_MS = 9 * 60 * 1_000;
const SUCCESS_CLEANUP_RESERVE_MS = 90 * 1_000;
export const MIN_LEASE_SUCCESS_REMAINING_MS = 30 * 1_000;
const MIN_POST_SUCCESS_LEASE_REMAINING_MS = 20 * 1_000;
const MERGE_WAIT_TIMEOUT_MS = 60 * 1_000;
const MERGE_POLL_INTERVAL_MS = 5_000;
export const MIN_CANDIDATE_ADMISSION_REMAINING_MS = 180 * 1_000;
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;

export const REQUIRED_CHECKS = [
  "Bun + Hermes (ubuntu-latest)",
  "Bun + Hermes (macos-latest)",
  "Hermes Python 3.11",
  "Hermes Python 3.12",
  "Hermes Python 3.13",
] as const;

export interface PullRequestSnapshot {
  number: number;
  nodeId: string;
  state: string;
  draft: boolean;
  body: string;
  author: string;
  baseRef: string;
  baseSha: string;
  baseRepositoryId?: number;
  headRef: string;
  headSha: string;
  headRepository: string;
  headRepositoryId?: number;
  mergeable: boolean | null;
  mergeableState: string;
  commitCount: number;
  labels: string[];
  requestedReviewers: string[];
  requestedTeams: string[];
  autoMergeEnabled: boolean;
  autoMergeRequest?: AutoMergeRequestSnapshot | null;
}

export interface AutoMergeRequestSnapshot {
  mergeMethod: string;
  commitHeadline: string | null;
  commitBody: string | null;
  enabledAt: string;
  enabledBy: string;
}

interface IssueSnapshot {
  number: number;
  state: string;
  author: string;
  labels: string[];
  updatedAt?: string;
  isPullRequest?: boolean;
}

export interface ChangedFileSnapshot {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch: string | null;
}

interface CommentSnapshot {
  id?: number;
  author: string;
  body: string;
  createdAt: string;
  updatedAt?: string;
}

interface CheckRunSnapshot {
  id?: number;
  name: string;
  status: string;
  conclusion: string | null;
  appId: number | null;
  externalId?: string | null;
  startedAt?: string | null;
  headSha?: string;
  checkSuiteId?: number | null;
  workflowRunId?: number | null;
  workflowRunAttempt?: number | null;
  workflowId?: number | null;
  workflowPath?: string | null;
  workflowEvent?: string | null;
  workflowHeadSha?: string | null;
  workflowStatus?: string | null;
  workflowConclusion?: string | null;
  workflowRepositoryId?: number | null;
  workflowHeadRepositoryId?: number | null;
  workflowPullRequests?: WorkflowPullRequestSnapshot[];
}

interface WorkflowPullRequestSnapshot {
  number: number;
  baseRef: string;
  baseSha: string;
  baseRepositoryId: number;
  headSha: string;
  headRepositoryId: number;
}

export type AutoMergePolicyPhase = "audit" | "enforce";

export interface AuthorizationLease {
  prNumber: number;
  headSha: string;
  authorizationFingerprint: string;
  establishedAt: string;
  expiresAt: string;
}

export interface AuthorizationLeaseResult {
  lease: AuthorizationLease | null;
  findings: string[];
}

interface MainComparisonSnapshot {
  status: string;
  aheadBy: number;
  behindBy: number;
  mergeBaseSha: string;
  baseSha: string;
  headSha: string;
}

interface BranchProtectionSnapshot {
  strict: boolean;
  enforceAdmins: boolean;
  requireLinearHistory?: boolean;
  requireConversationResolution?: boolean;
  allowForcePushes?: boolean;
  allowDeletions?: boolean;
  requiredChecks: Array<{ context: string; appId: number | null }>;
}

export interface AutoMergePolicySnapshot {
  repository: string;
  repositoryId: number;
  defaultBranch: string;
  currentMainSha: string;
  mainComparison?: MainComparisonSnapshot;
  branchProtection?: BranchProtectionSnapshot;
  repositoryAllowsAutoMerge?: boolean;
  now: string;
  headCommittedAt: string;
  recentAutoMergeCount: number;
  unresolvedReviewThreads: number;
  pullRequest: PullRequestSnapshot;
  issue: IssueSnapshot | null;
  files: ChangedFileSnapshot[];
  baseContent: string | null;
  headContent: string | null;
  comments: CommentSnapshot[];
  reviews: number;
  reviewComments: number;
  checkRuns: CheckRunSnapshot[];
}

export interface AutoMergePolicyResult {
  eligible: boolean;
  diffFingerprint: string;
  findings: string[];
}

export type GateExternalIdPhase = keyof typeof GATE_EXTERNAL_ID_PREFIXES;

export type AutoMergeQuotaEvidenceSource =
  | "exact-commit-marker"
  | "malformed-policy-marker"
  | "enforce-lease-gate"
  | "legacy-authorization-gate"
  | "github-actions-bot-merge";

export interface AutoMergeQuotaEvidenceInput {
  prNumber: number | null;
  headSha: string;
  mergeCommitSha: string;
  mergedAt: string;
  mergedBy: string | null;
  commitMessage: string;
  gateExternalIds: string[];
}

export interface AutoMergeQuotaEvidence extends AutoMergeQuotaEvidenceInput {
  sources: AutoMergeQuotaEvidenceSource[];
}

interface GitHubPullRequest {
  number: number;
  node_id: string;
  state: string;
  draft: boolean;
  body: string | null;
  user: { login: string };
  base: { ref: string; sha: string; repo: { id: number; full_name: string } };
  head: { ref: string; sha: string; repo: { id: number; full_name: string } | null };
  mergeable: boolean | null;
  mergeable_state: string;
  commits: number;
  labels: Array<{ name: string }>;
  requested_reviewers: Array<{ login: string }>;
  requested_teams: Array<{ slug: string }>;
  auto_merge: unknown | null;
  merged?: boolean;
  merged_at?: string | null;
  merged_by?: { login: string } | null;
  merge_commit_sha?: string | null;
}

interface GitHubIssue {
  number: number;
  state: string;
  user: { login: string };
  labels: Array<{ name?: string }>;
  updated_at: string;
  pull_request?: unknown;
}

interface GitHubFile extends ChangedFileSnapshot {}

interface GitHubComment {
  id: number;
  user: { login: string };
  body: string | null;
  created_at: string;
  updated_at: string;
  issue_url?: string;
}

interface GitHubCheckRuns {
  total_count: number;
  check_runs: Array<{
    name: string;
    id: number;
    head_sha: string;
    external_id: string | null;
    started_at: string | null;
    status: string;
    conclusion: string | null;
    app: { id: number } | null;
    check_suite: { id: number; head_sha: string } | null;
  }>;
}

interface GitHubWorkflowRuns {
  total_count: number;
  workflow_runs: Array<{
    id: number;
    workflow_id: number;
    run_attempt: number;
    check_suite_id: number | null;
    head_sha: string;
    path: string;
    event: string;
    status: string;
    conclusion: string | null;
    repository: { id: number };
    head_repository: { id: number };
    pull_requests: Array<{
      number: number;
      base: { ref: string; sha: string; repo: { id: number } };
      head: { sha: string; repo: { id: number } };
    }>;
  }>;
}

interface AutoMergeRequestQuery {
  repository: {
    pullRequest: {
      autoMergeRequest: {
        mergeMethod: string;
        commitHeadline: string | null;
        commitBody: string | null;
        enabledAt: string;
        enabledBy: { login: string };
      } | null;
    } | null;
  };
}

interface GitHubComparison {
  status: string;
  ahead_by: number;
  behind_by: number;
  base_commit: { sha: string };
  merge_base_commit: { sha: string };
}

interface GitHubBranchProtection {
  required_status_checks: {
    strict: boolean;
    contexts: string[];
    checks: Array<{ context: string; app_id: number | null }>;
  } | null;
  enforce_admins: { enabled: boolean } | null;
  required_linear_history: { enabled: boolean } | null;
  required_conversation_resolution: { enabled: boolean } | null;
  allow_force_pushes: { enabled: boolean } | null;
  allow_deletions: { enabled: boolean } | null;
}

interface GitHubRepository {
  id: number;
  full_name: string;
  default_branch: string;
  allow_auto_merge: boolean;
}

interface GitHubCommitListItem {
  sha: string;
  commit: {
    message: string;
    committer: { date: string } | null;
  };
}

interface GitHubCommit {
  commit: {
    message: string;
    author: { date: string } | null;
    committer: { date: string } | null;
  };
}

interface GitHubContent {
  type: string;
  encoding: string;
  content: string;
}

export interface RepositoryEvent {
  repository: { id: number; full_name: string; default_branch: string };
  action?: string;
  label?: { name?: string };
  pull_request?: { number: number; head?: { sha?: string } };
  issue?: { number: number; pull_request?: unknown };
  comment?: { id?: number; updated_at?: string };
  review?: { id?: number; submitted_at?: string; state?: string };
}

export interface EventTombstoneImpact {
  directPullNumber: number | null;
  sourceIssueNumber: number | null;
  reason: string;
}

export interface IssueLinkedPull {
  number: number;
  body: string;
  labels: string[];
}

export function validateTrustedWorkflowSha(
  trustedWorkflowSha: string | undefined,
  currentMainSha: string,
): string[] {
  const findings: string[] = [];
  if (!trustedWorkflowSha || !FULL_COMMIT_SHA.test(trustedWorkflowSha)) {
    findings.push("可信 workflow SHA 缺失或格式无效");
  }
  if (!FULL_COMMIT_SHA.test(currentMainSha)) findings.push("实时 main SHA 格式无效");
  if (
    trustedWorkflowSha &&
    FULL_COMMIT_SHA.test(trustedWorkflowSha) &&
    FULL_COMMIT_SHA.test(currentMainSha) &&
    trustedWorkflowSha !== currentMainSha
  ) {
    findings.push("可信 workflow SHA 不再等于实时 main SHA");
  }
  return findings;
}

class GitHubClient {
  private lastServerDate: string | null = null;
  private cleanupMode = false;

  constructor(
    private readonly repository: string,
    private readonly token: string,
    private readonly admissionDeadlineMs = Date.now() + RUN_SOFT_DEADLINE_MS,
    private readonly cleanupDeadlineMs = Date.now() + RUN_CLEANUP_HARD_DEADLINE_MS,
    private readonly trustedWorkflowSha: string | null = null,
  ) {}

  beginCleanup(): void {
    this.cleanupMode = true;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const deadlineMs = this.cleanupMode ? this.cleanupDeadlineMs : this.admissionDeadlineMs;
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw new Error(this.cleanupMode
        ? "策略 run 已到 9 分钟清理硬截止时间，拒绝继续调用 GitHub API"
        : "策略 run 已到 5 分钟 admission 软截止时间，进入 fail-close 清理");
    }
    const response = await fetch(`https://api.github.com${path}`, {
      ...init,
      signal: AbortSignal.timeout(Math.min(20_000, remainingMs)),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "livis-relay-automerge-policy",
        ...init.headers,
      },
    });
    this.lastServerDate = response.headers.get("date");
    if (!response.ok) {
      const body = (await response.text()).slice(0, 1_000);
      throw new Error(`GitHub API ${init.method ?? "GET"} ${path} 失败：${response.status} ${body}`);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  repoPath(path: string): string {
    return `/repos/${this.repository}${path}`;
  }

  async paginate<T>(path: string): Promise<T[]> {
    const result: T[] = [];
    for (let page = 1; ; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const values = await this.request<T[]>(`${path}${separator}per_page=100&page=${page}`);
      result.push(...values);
      if (values.length < 100) return result;
    }
  }

  async serverNow(): Promise<string> {
    await this.request("/rate_limit");
    if (!this.lastServerDate || !Number.isFinite(Date.parse(this.lastServerDate))) {
      throw new Error("GitHub 响应缺少可信 Date 时间戳");
    }
    return new Date(this.lastServerDate).toISOString();
  }

  async graphQL<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.request<{ data?: T; errors?: Array<{ message: string }> }>("/graphql", {
      method: "POST",
      body: JSON.stringify({ query, variables }),
      headers: { "Content-Type": "application/json" },
    });
    if (response.errors?.length || !response.data) {
      throw new Error(`GitHub GraphQL 失败：${response.errors?.map((item) => item.message).join("；") || "缺少 data"}`);
    }
    return response.data;
  }

  private async assertCurrentWorkflowMayWrite(allowFailCloseDuringCleanup = false): Promise<void> {
    if (allowFailCloseDuringCleanup && this.cleanupMode) return;
    const mainRef = await this.request<{ object: { sha: string } }>(
      this.repoPath(`/git/ref/heads/${TARGET_DEFAULT_BRANCH}`),
    );
    const findings = validateTrustedWorkflowSha(this.trustedWorkflowSha ?? undefined, mainRef.object.sha);
    if (findings.length) {
      throw new Error(`策略写入前可信 main 复核失败：${findings.join("；")}`);
    }
  }

  async disableAutoMerge(nodeId: string): Promise<void> {
    // main 前进后仍必须允许已进入 cleanup 的旧 run 撤销 Auto-merge。
    await this.assertCurrentWorkflowMayWrite(true);
    await this.graphQL(
      `mutation($id: ID!) {
        disablePullRequestAutoMerge(input: { pullRequestId: $id }) {
          pullRequest { id }
        }
      }`,
      { id: nodeId },
    );
  }

  async markReady(nodeId: string): Promise<void> {
    await this.assertCurrentWorkflowMayWrite();
    await this.graphQL(
      `mutation($id: ID!) {
        markPullRequestReadyForReview(input: { pullRequestId: $id }) {
          pullRequest { id isDraft }
        }
      }`,
      { id: nodeId },
    );
  }

  async convertToDraft(nodeId: string): Promise<void> {
    // 转回 draft 只会收紧状态；cleanup 不能被 main 漂移反向阻断。
    await this.assertCurrentWorkflowMayWrite(true);
    await this.graphQL(
      `mutation($id: ID!) {
        convertPullRequestToDraft(input: { pullRequestId: $id }) {
          pullRequest { id isDraft }
        }
      }`,
      { id: nodeId },
    );
  }

  async enableAutoMerge(
    nodeId: string,
    expectedHeadOid: string,
    commitHeadline: string,
    commitBody: string,
  ): Promise<void> {
    await this.assertCurrentWorkflowMayWrite();
    await this.graphQL(
      `mutation($id: ID!, $head: GitObjectID!, $headline: String!, $body: String!) {
        enablePullRequestAutoMerge(input: {
          pullRequestId: $id
          mergeMethod: SQUASH
          expectedHeadOid: $head
          commitHeadline: $headline
          commitBody: $body
        }) {
          pullRequest { id autoMergeRequest { enabledAt } }
        }
      }`,
      { id: nodeId, head: expectedHeadOid, headline: commitHeadline, body: commitBody },
    );
  }

  async createCheckRun(body: Record<string, unknown>): Promise<{ id: number }> {
    const failClosingCleanup = body.conclusion === "failure" ||
      (
        body.name === OBSERVATION_CHECK_NAME &&
        body.conclusion === "neutral" &&
        typeof body.external_id === "string" &&
        body.external_id.startsWith(OBSERVATION_TOMBSTONE_PREFIX)
      );
    await this.assertCurrentWorkflowMayWrite(failClosingCleanup);
    return this.request(this.repoPath("/check-runs"), {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  }

  async updateCheckRun(id: number, body: Record<string, unknown>): Promise<void> {
    await this.assertCurrentWorkflowMayWrite(body.conclusion === "failure");
    await this.request(this.repoPath(`/check-runs/${id}`), {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  }
}

function labels(values: Array<{ name?: string }>): string[] {
  return values.flatMap((item) => (item.name ? [item.name] : [])).sort();
}

function issueNumber(body: string): number | null {
  const matches = [...body.matchAll(/<!--\s*codex-issue-worker:v1\s+issue=(\d+)\s*-->/g)];
  if (matches.length !== 1 || !matches[0]?.[1]) return null;
  const value = Number.parseInt(matches[0][1], 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function lineFingerprintInput(
  baseSha: string,
  headSha: string,
  files: readonly ChangedFileSnapshot[],
): string {
  return JSON.stringify({
    version: 1,
    baseSha,
    headSha,
    files: [...files]
      .sort((left, right) => left.filename.localeCompare(right.filename))
      .map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        patch: file.patch,
      })),
  });
}

export function computeDiffFingerprint(
  baseSha: string,
  headSha: string,
  files: readonly ChangedFileSnapshot[],
): string {
  return new Bun.CryptoHasher("sha256")
    .update(lineFingerprintInput(baseSha, headSha, files))
    .digest("hex");
}

interface PatchChanges {
  oldLines: number[];
  newLines: number[];
}

function changedLineNumbers(patch: string): PatchChanges | null {
  const oldLines: number[] = [];
  const newLines: number[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk?.[1] && hunk[2]) {
      oldLine = Number.parseInt(hunk[1], 10);
      newLine = Number.parseInt(hunk[2], 10);
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+")) {
      newLines.push(newLine);
      newLine += 1;
    } else if (line.startsWith("-")) {
      oldLines.push(oldLine);
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    } else {
      return null;
    }
  }
  return inHunk ? { oldLines, newLines } : null;
}

export function isCanaryTransition(
  patch: string,
  baseContent: string,
  headContent: string,
): boolean {
  if (baseContent !== CANARY_PENDING_CONTENT || headContent !== CANARY_VERIFIED_CONTENT) return false;
  const changes = changedLineNumbers(patch);
  if (!changes || changes.oldLines.length !== 1 || changes.newLines.length !== 1) return false;

  const pendingCount = baseContent.split(CANARY_PENDING_LINE).length - 1;
  const prematureVerifiedCount = baseContent.split(CANARY_VERIFIED_LINE).length - 1;
  const remainingPendingCount = headContent.split(CANARY_PENDING_LINE).length - 1;
  const verifiedCount = headContent.split(CANARY_VERIFIED_LINE).length - 1;
  if (pendingCount !== 1 || prematureVerifiedCount !== 0 || remainingPendingCount !== 0 || verifiedCount !== 1) {
    return false;
  }
  if (headContent !== baseContent.replace(CANARY_PENDING_LINE, CANARY_VERIFIED_LINE)) return false;

  const baseLines = baseContent.split("\n");
  const headLines = headContent.split("\n");
  const oldLine = changes.oldLines[0];
  const newLine = changes.newLines[0];
  return oldLine !== undefined && newLine !== undefined &&
    baseLines[oldLine - 1] === CANARY_PENDING_LINE &&
    headLines[newLine - 1] === CANARY_VERIFIED_LINE &&
    patch.split("\n").filter((line) => line.startsWith("-")).join("\n") === `-${CANARY_PENDING_LINE}` &&
    patch.split("\n").filter((line) => line.startsWith("+")).join("\n") === `+${CANARY_VERIFIED_LINE}`;
}

// 保留旧导出名，避免调用方绕回宽泛 prose 判定；其语义现在就是精确 canary 两态转换。
export function isPlainProsePatch(
  patch: string,
  baseContent: string,
  headContent: string,
): boolean {
  return isCanaryTransition(patch, baseContent, headContent);
}

function sameValues(actual: readonly string[], expected: readonly string[]): boolean {
  return [...actual].sort().join("\n") === [...expected].sort().join("\n");
}

export function computeCandidateMarkerFingerprint(snapshot: AutoMergePolicySnapshot): string | null {
  const pr = snapshot.pullRequest;
  const diff = computeDiffFingerprint(pr.baseSha, pr.headSha, snapshot.files);
  const expected = `<!-- codex-automerge-candidate:v1 pr=${pr.number} head=${pr.headSha} diff=${diff} -->`;
  const candidates = snapshot.comments.filter((comment) => comment.body.includes("codex-automerge-candidate:"));
  const marker = candidates.length === 1 ? candidates[0] : undefined;
  if (
    !marker?.id ||
    marker.author !== TARGET_OWNER ||
    marker.body.trim() !== expected ||
    !Number.isFinite(Date.parse(marker.createdAt)) ||
    !Number.isFinite(Date.parse(marker.updatedAt ?? "")) ||
    marker.createdAt !== marker.updatedAt
  ) {
    return null;
  }
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify({
      version: 1,
      pr: pr.number,
      head: pr.headSha,
      diff,
      id: marker.id,
      body: marker.body.trim(),
      createdAt: marker.createdAt,
    }))
    .digest("hex");
}

export function observationExternalId(snapshot: AutoMergePolicySnapshot): string | null {
  const markerFingerprint = computeCandidateMarkerFingerprint(snapshot);
  if (!markerFingerprint) return null;
  const authorizationFingerprint = computeAuthorizationFingerprint(snapshot);
  return `${OBSERVATION_EXTERNAL_ID_PREFIX}:pr=${snapshot.pullRequest.number}:head=${snapshot.pullRequest.headSha}:auth=${authorizationFingerprint}:marker=${markerFingerprint}`;
}

export function computeAuthorizationFingerprint(snapshot: AutoMergePolicySnapshot): string {
  const pr = snapshot.pullRequest;
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify({
      version: 2,
      repository: snapshot.repository,
      repositoryId: snapshot.repositoryId,
      defaultBranch: snapshot.defaultBranch,
      pullRequest: {
        number: pr.number,
        nodeId: pr.nodeId,
        state: pr.state,
        body: pr.body,
        author: pr.author,
        baseRef: pr.baseRef,
        baseSha: pr.baseSha,
        baseRepositoryId: pr.baseRepositoryId,
        headRef: pr.headRef,
        headSha: pr.headSha,
        headRepository: pr.headRepository,
        headRepositoryId: pr.headRepositoryId,
        commitCount: pr.commitCount,
        labels: [...pr.labels].sort(),
        requestedReviewers: [...pr.requestedReviewers].sort(),
        requestedTeams: [...pr.requestedTeams].sort(),
      },
      issue: snapshot.issue ? {
        ...snapshot.issue,
        labels: [...snapshot.issue.labels].sort(),
      } : null,
      files: [...snapshot.files].sort((left, right) => left.filename.localeCompare(right.filename)),
      baseContent: snapshot.baseContent,
      headContent: snapshot.headContent,
      comments: [...snapshot.comments]
        .map((comment) => ({
          id: comment.id,
          author: comment.author,
          body: comment.body,
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
        }))
        .sort((left, right) => (left.id ?? 0) - (right.id ?? 0)),
      reviews: snapshot.reviews,
      reviewComments: snapshot.reviewComments,
      unresolvedReviewThreads: snapshot.unresolvedReviewThreads,
      diffFingerprint: computeDiffFingerprint(pr.baseSha, pr.headSha, snapshot.files),
    }))
    .digest("hex");
}

export function evaluateAutoMergePolicy(
  snapshot: AutoMergePolicySnapshot,
  phase: AutoMergePolicyPhase = "enforce",
): AutoMergePolicyResult {
  const findings: string[] = [];
  const pr = snapshot.pullRequest;
  const diffFingerprint = computeDiffFingerprint(pr.baseSha, pr.headSha, snapshot.files);

  if (snapshot.repository !== TARGET_REPOSITORY || snapshot.repositoryId !== TARGET_REPOSITORY_ID) {
    findings.push("目标仓库身份不匹配");
  }
  if (snapshot.defaultBranch !== TARGET_DEFAULT_BRANCH || pr.baseRef !== TARGET_DEFAULT_BRANCH) {
    findings.push("默认分支或 PR base 不是 main");
  }
  if (pr.baseRepositoryId !== TARGET_REPOSITORY_ID) findings.push("PR base repository id 不匹配");
  const comparison = snapshot.mainComparison;
  if (
    snapshot.currentMainSha !== pr.baseSha ||
    !comparison ||
    comparison.baseSha !== snapshot.currentMainSha ||
    comparison.headSha !== pr.headSha ||
    comparison.status !== "ahead" ||
    comparison.aheadBy !== 1 ||
    comparison.behindBy !== 0 ||
    comparison.mergeBaseSha !== snapshot.currentMainSha
  ) {
    findings.push("PR 未基于最新 main");
  }
  if (pr.state !== "open") findings.push("PR 不是 open 状态");
  if (pr.author !== TARGET_OWNER) findings.push("PR 作者不是允许的内部维护者");
  if (pr.headRepository !== TARGET_REPOSITORY || pr.headRepositoryId !== TARGET_REPOSITORY_ID) {
    findings.push("PR 来自 fork 或其他仓库");
  }
  if (!/^codex\/issue-\d+-[a-z0-9][a-z0-9-]*$/.test(pr.headRef)) {
    findings.push("PR head 分支不符合 codex/issue-<编号>-<slug>");
  }
  if (pr.commitCount !== 1) findings.push("PR 必须恰好包含一个 commit");
  if (pr.mergeable !== true) findings.push("GitHub 尚未确认 PR 可合并");
  if (!["blocked", "clean", "draft"].includes(pr.mergeableState)) {
    findings.push(`PR mergeable_state 不在安全集合：${pr.mergeableState}`);
  }
  if (pr.requestedReviewers.length || pr.requestedTeams.length) findings.push("PR 仍有 review request");
  if (pr.autoMergeEnabled || pr.autoMergeRequest !== null) {
    findings.push("已有 Auto-merge 请求必须先禁用并通过 REST/GraphQL 双读回");
  }
  if (!sameValues(pr.labels, ["merge:auto"])) findings.push("PR 标签必须且只能是 merge:auto");

  const linkedIssue = issueNumber(pr.body);
  if (!linkedIssue || linkedIssue !== snapshot.issue?.number) findings.push("PR 缺少唯一且匹配的 Issue marker");
  const branchIssue = pr.headRef.match(/^codex\/issue-(\d+)-/)?.[1];
  if (!branchIssue || Number.parseInt(branchIssue, 10) !== linkedIssue) {
    findings.push("PR head 分支编号与 Issue marker 不一致");
  }
  if (!snapshot.issue || snapshot.issue.state !== "open") findings.push("关联 Issue 不存在或已关闭");
  if (snapshot.issue?.isPullRequest !== false) findings.push("关联 Issue API 对象不是独立 Issue");
  if (snapshot.issue?.author !== TARGET_OWNER) findings.push("关联 Issue 作者不是内部维护者");
  if (snapshot.issue && !sameValues(snapshot.issue.labels, ["decision:auto", "documentation"])) {
    findings.push("关联 Issue 标签必须且只能是 documentation + decision:auto");
  }

  if (snapshot.files.length !== 1) findings.push("PR 必须只修改一个文件");
  const file = snapshot.files[0];
  if (file) {
    if (file.status !== "modified") findings.push("文档必须是既有文件的修改，不能新增/删除/重命名");
    if (file.filename !== CANARY_PATH) findings.push(`唯一允许的文件是 ${CANARY_PATH}`);
    if (file.additions !== 1 || file.deletions !== 1 || file.changes !== 2) {
      findings.push("canary 必须恰好替换一行");
    }
    if (!file.patch || snapshot.baseContent === null || snapshot.headContent === null) {
      findings.push("缺少可审计的文本 patch 或文件内容");
    } else if (!isCanaryTransition(file.patch, snapshot.baseContent, snapshot.headContent)) {
      findings.push("变更不是唯一允许的 canary 待验证到已验证转换");
    }
  }

  if (snapshot.reviews !== 0 || snapshot.reviewComments !== 0 || snapshot.unresolvedReviewThreads !== 0) {
    findings.push("PR 存在 review、review comment 或未解决 thread");
  }
  const expectedMarker = `<!-- codex-automerge-candidate:v1 pr=${pr.number} head=${pr.headSha} diff=${diffFingerprint} -->`;
  const candidateComments = snapshot.comments.filter((comment) => comment.body.includes("codex-automerge-candidate:"));
  const candidate = candidateComments.length === 1 ? candidateComments[0] : undefined;
  if (!candidate || candidate.author !== TARGET_OWNER || candidate.body.trim() !== expectedMarker) {
    findings.push("缺少与当前 head/diff 精确绑定的唯一 candidate marker");
  }
  if (snapshot.comments.some((comment) => comment !== candidate)) findings.push("PR 存在 candidate marker 之外的评论");

  const now = Date.parse(snapshot.now);
  const markerCreatedAt = Date.parse(candidate?.createdAt ?? "");
  const markerUpdatedAt = Date.parse(candidate?.updatedAt ?? candidate?.createdAt ?? "");
  const issueUpdatedAt = Date.parse(snapshot.issue?.updatedAt ?? "");
  if (
    !Number.isFinite(markerCreatedAt) ||
    !Number.isFinite(markerUpdatedAt) ||
    markerCreatedAt > now ||
    markerUpdatedAt > now
  ) {
    findings.push("candidate marker 时间戳无效");
  }
  if (Number.isFinite(markerCreatedAt) && Number.isFinite(markerUpdatedAt) && markerCreatedAt !== markerUpdatedAt) {
    findings.push("candidate marker 曾被编辑，必须删除后重新创建");
  }
  if (!Number.isFinite(issueUpdatedAt) || !Number.isFinite(markerCreatedAt) || markerCreatedAt < issueUpdatedAt) {
    findings.push("candidate marker 早于关联 Issue 的最近授权变更");
  }

  const expectedObservationId = observationExternalId(snapshot);
  const observation = snapshot.checkRuns
    .filter((check) => check.name === OBSERVATION_CHECK_NAME && check.appId === GITHUB_ACTIONS_APP_ID)
    .sort((left, right) => (right.id ?? 0) - (left.id ?? 0))
    [0];
  const observationStartedAt = Date.parse(observation?.startedAt ?? "");
  if (
    !expectedObservationId ||
    !observation?.id ||
    observation.externalId !== expectedObservationId ||
    observation.headSha !== pr.headSha ||
    observation.status !== "completed" ||
    observation.conclusion !== "neutral" ||
    !Number.isFinite(now) ||
    !Number.isFinite(observationStartedAt) ||
    observationStartedAt > now ||
    now - observationStartedAt < MIN_CANDIDATE_AGE_MS
  ) {
    findings.push("当前 head/marker 的可信 observation 尚未稳定满 15 分钟");
  }

  const trustedChecks: CheckRunSnapshot[] = [];
  for (const name of REQUIRED_CHECKS) {
    const matches = snapshot.checkRuns
      .filter((check) => check.name === name)
      .sort((left, right) => (right.id ?? 0) - (left.id ?? 0));
    const check = matches[0];
    if (!check) {
      findings.push(`缺少 required check：${name}`);
      continue;
    }
    trustedChecks.push(check);
    if (
      !check.id ||
      check.appId !== GITHUB_ACTIONS_APP_ID ||
      check.headSha !== pr.headSha ||
      !check.checkSuiteId ||
      !check.workflowRunId ||
      check.workflowId !== TRUSTED_CI_WORKFLOW_ID ||
      check.workflowPath !== TRUSTED_CI_WORKFLOW_PATH ||
      check.workflowEvent !== "pull_request" ||
      check.workflowHeadSha !== pr.headSha ||
      check.workflowStatus !== "completed" ||
      check.workflowConclusion !== "success" ||
      check.workflowRepositoryId !== TARGET_REPOSITORY_ID ||
      check.workflowHeadRepositoryId !== TARGET_REPOSITORY_ID ||
      check.workflowPullRequests?.length !== 1 ||
      check.workflowPullRequests[0]?.number !== pr.number ||
      check.workflowPullRequests[0]?.baseRef !== TARGET_DEFAULT_BRANCH ||
      check.workflowPullRequests[0]?.baseSha !== pr.baseSha ||
      check.workflowPullRequests[0]?.baseRepositoryId !== TARGET_REPOSITORY_ID ||
      check.workflowPullRequests[0]?.headSha !== pr.headSha ||
      check.workflowPullRequests[0]?.headRepositoryId !== TARGET_REPOSITORY_ID ||
      check.status !== "completed" ||
      check.conclusion !== "success"
    ) {
      findings.push(`required check 未绑定可信 ci.yml workflow run：${name}`);
    }
  }
  const suiteIds = new Set(trustedChecks.map((check) => check.checkSuiteId));
  const runIds = new Set(trustedChecks.map((check) => check.workflowRunId));
  if (trustedChecks.length === REQUIRED_CHECKS.length && (suiteIds.size !== 1 || runIds.size !== 1)) {
    findings.push("required checks 不属于同一次可信 CI workflow run");
  }

  const protection = snapshot.branchProtection;
  const auditChecks = [...REQUIRED_CHECKS];
  const enforceChecks = [...REQUIRED_CHECKS, GATE_CHECK_NAME];
  const expectedProtectedChecks = phase === "enforce" ? enforceChecks : auditChecks;
  if (
    !protection ||
    !protection.strict ||
    !protection.enforceAdmins ||
    protection.requireLinearHistory !== true ||
    protection.requireConversationResolution !== true ||
    protection.allowForcePushes !== false ||
    protection.allowDeletions !== false
  ) {
    findings.push("main 分支保护未满足 strict/admin/linear/conversation/no-force-push/no-deletion 基线");
  } else {
    const actualContexts = protection.requiredChecks.map((check) => check.context).sort();
    const exactFive = sameValues(actualContexts, auditChecks);
    const exactSix = sameValues(actualContexts, enforceChecks);
    if (phase === "enforce" ? !exactSix : !exactFive && !exactSix) {
      findings.push("分支保护 required checks 不是精确安全基线");
    }
    for (const name of phase === "audit" && exactSix ? enforceChecks : expectedProtectedChecks) {
      const matches = protection.requiredChecks.filter((check) => check.context === name);
      if (matches.length !== 1 || matches[0]?.appId !== GITHUB_ACTIONS_APP_ID) {
        findings.push(`分支保护 required check 未绑定预期 GitHub Actions app：${name}`);
      }
    }
  }
  if (phase === "enforce" && snapshot.repositoryAllowsAutoMerge !== true) {
    findings.push("仓库尚未启用 GitHub 原生 Auto-merge");
  }
  if (phase === "audit" && snapshot.repositoryAllowsAutoMerge !== false) {
    findings.push("audit 阶段要求仓库 Auto-merge 保持关闭");
  }
  if (snapshot.recentAutoMergeCount !== 0) findings.push("过去 24 小时已发生低风险自动合并");

  return { eligible: findings.length === 0, diffFingerprint, findings };
}

export function establishAuthorizationLease(
  snapshotA: AutoMergePolicySnapshot,
  snapshotB: AutoMergePolicySnapshot,
  establishedAt: string,
): AuthorizationLeaseResult {
  const findings: string[] = [];
  const resultA = evaluateAutoMergePolicy(snapshotA, "enforce");
  const resultB = evaluateAutoMergePolicy(snapshotB, "enforce");
  if (!resultA.eligible) findings.push(...resultA.findings.map((item) => `snapshot A: ${item}`));
  if (!resultB.eligible) findings.push(...resultB.findings.map((item) => `snapshot B: ${item}`));
  const fingerprintA = computeAuthorizationFingerprint(snapshotA);
  const fingerprintB = computeAuthorizationFingerprint(snapshotB);
  if (fingerprintA !== fingerprintB) findings.push("snapshot A/B 的完整授权指纹不一致");
  if (
    snapshotA.pullRequest.number !== snapshotB.pullRequest.number ||
    snapshotA.pullRequest.headSha !== snapshotB.pullRequest.headSha
  ) {
    findings.push("snapshot A/B 的 PR 或 head SHA 不一致");
  }
  const establishedMs = Date.parse(establishedAt);
  const snapshotANow = Date.parse(snapshotA.now);
  const snapshotBNow = Date.parse(snapshotB.now);
  if (
    !Number.isFinite(establishedMs) ||
    !Number.isFinite(snapshotANow) ||
    !Number.isFinite(snapshotBNow) ||
    establishedMs < snapshotANow ||
    establishedMs > snapshotBNow
  ) {
    findings.push("authorization lease 的 GitHub server 建立时间无效");
  }
  if (findings.length) return { lease: null, findings };
  return {
    lease: {
      prNumber: snapshotB.pullRequest.number,
      headSha: snapshotB.pullRequest.headSha,
      authorizationFingerprint: fingerprintB,
      establishedAt: new Date(establishedMs).toISOString(),
      expiresAt: new Date(establishedMs + AUTHORIZATION_LEASE_MS).toISOString(),
    },
    findings,
  };
}

export function expectedAutoMergeCommitHeadline(number: number): string {
  return `docs: 完成低风险自动合并金丝雀验证 (#${number})`;
}

export function evaluateExactAutoMergeRequest(
  snapshot: AutoMergePolicySnapshot,
  lease: AuthorizationLease,
): string[] {
  const findings: string[] = [];
  const request = snapshot.pullRequest.autoMergeRequest;
  const diff = computeDiffFingerprint(
    snapshot.pullRequest.baseSha,
    snapshot.pullRequest.headSha,
    snapshot.files,
  );
  const enabledAt = Date.parse(request?.enabledAt ?? "");
  if (!snapshot.pullRequest.autoMergeEnabled || !request) {
    return ["缺少 REST/GraphQL 一致的 AutoMergeRequest"];
  }
  if (request.mergeMethod !== "SQUASH") findings.push("AutoMergeRequest.mergeMethod 不是 SQUASH");
  if (request.commitHeadline !== expectedAutoMergeCommitHeadline(snapshot.pullRequest.number)) {
    findings.push("AutoMergeRequest.commitHeadline 不匹配");
  }
  if (request.commitBody !== autoMergeCommitMarker(snapshot.pullRequest.number, lease.headSha, diff)) {
    findings.push("AutoMergeRequest.commitBody provenance 不匹配");
  }
  if (request.enabledBy !== "github-actions[bot]") findings.push("AutoMergeRequest.enabledBy 不可信");
  if (
    !Number.isFinite(enabledAt) ||
    enabledAt < Date.parse(lease.establishedAt) ||
    enabledAt > Date.parse(lease.expiresAt) ||
    enabledAt > Date.parse(snapshot.now)
  ) {
    findings.push("AutoMergeRequest.enabledAt 不在 authorization lease 内");
  }
  return findings;
}

export function evaluatePostLeaseSafety(
  snapshot: AutoMergePolicySnapshot,
  lease: AuthorizationLease,
  autoMergeExpectation: "absent" | "exact" = "absent",
): AutoMergePolicyResult {
  const findings: string[] = [];
  const pr = snapshot.pullRequest;
  const diffFingerprint = computeDiffFingerprint(pr.baseSha, pr.headSha, snapshot.files);
  const now = Date.parse(snapshot.now);
  if (!Number.isFinite(now) || now > Date.parse(lease.expiresAt)) findings.push("authorization lease 已过期");
  if (pr.number !== lease.prNumber || pr.headSha !== lease.headSha || pr.state !== "open") {
    findings.push("lease 后 PR number/head/state 不安全");
  }
  const comparison = snapshot.mainComparison;
  if (
    snapshot.repository !== TARGET_REPOSITORY ||
    snapshot.repositoryId !== TARGET_REPOSITORY_ID ||
    snapshot.defaultBranch !== TARGET_DEFAULT_BRANCH ||
    pr.baseRef !== TARGET_DEFAULT_BRANCH ||
    pr.baseRepositoryId !== TARGET_REPOSITORY_ID ||
    snapshot.currentMainSha !== pr.baseSha ||
    !comparison ||
    comparison.baseSha !== snapshot.currentMainSha ||
    comparison.headSha !== pr.headSha ||
    comparison.status !== "ahead" ||
    comparison.aheadBy !== 1 ||
    comparison.behindBy !== 0 ||
    comparison.mergeBaseSha !== snapshot.currentMainSha
  ) {
    findings.push("lease 后 main/head compare 安全条件失效");
  }

  const selectedChecks: CheckRunSnapshot[] = [];
  for (const name of REQUIRED_CHECKS) {
    const check = snapshot.checkRuns
      .filter((item) => item.name === name)
      .sort((left, right) => (right.id ?? 0) - (left.id ?? 0))[0];
    if (!check) {
      findings.push(`lease 后缺少 CI check：${name}`);
      continue;
    }
    selectedChecks.push(check);
    const pull = check.workflowPullRequests?.[0];
    if (
      !check.id ||
      !check.checkSuiteId ||
      !check.workflowRunId ||
      check.appId !== GITHUB_ACTIONS_APP_ID ||
      check.headSha !== pr.headSha ||
      check.status !== "completed" ||
      check.conclusion !== "success" ||
      check.workflowId !== TRUSTED_CI_WORKFLOW_ID ||
      check.workflowPath !== TRUSTED_CI_WORKFLOW_PATH ||
      check.workflowEvent !== "pull_request" ||
      check.workflowHeadSha !== pr.headSha ||
      check.workflowStatus !== "completed" ||
      check.workflowConclusion !== "success" ||
      check.workflowRepositoryId !== TARGET_REPOSITORY_ID ||
      check.workflowHeadRepositoryId !== TARGET_REPOSITORY_ID ||
      check.workflowPullRequests?.length !== 1 ||
      pull?.number !== pr.number ||
      pull?.baseRef !== TARGET_DEFAULT_BRANCH ||
      pull?.baseSha !== pr.baseSha ||
      pull?.baseRepositoryId !== TARGET_REPOSITORY_ID ||
      pull?.headSha !== pr.headSha ||
      pull?.headRepositoryId !== TARGET_REPOSITORY_ID
    ) {
      findings.push(`lease 后 CI provenance 失效：${name}`);
    }
  }
  if (
    new Set(selectedChecks.map((check) => check.checkSuiteId)).size !== 1 ||
    new Set(selectedChecks.map((check) => check.workflowRunId)).size !== 1
  ) {
    findings.push("lease 后 CI checks 不属于同一 workflow run/check suite");
  }

  const protection = snapshot.branchProtection;
  const exactChecks = [...REQUIRED_CHECKS, GATE_CHECK_NAME];
  if (
    !protection ||
    !protection.strict ||
    !protection.enforceAdmins ||
    protection.requireLinearHistory !== true ||
    protection.requireConversationResolution !== true ||
    protection.allowForcePushes !== false ||
    protection.allowDeletions !== false ||
    !sameValues(protection.requiredChecks.map((check) => check.context), exactChecks) ||
    protection.requiredChecks.some((check) => check.appId !== GITHUB_ACTIONS_APP_ID)
  ) {
    findings.push("lease 后 branch protection 安全基线失效");
  }
  if (snapshot.repositoryAllowsAutoMerge !== true) findings.push("lease 后仓库 Auto-merge 已关闭");
  if (snapshot.recentAutoMergeCount !== 0) findings.push("lease 后 24 小时配额已被占用");
  if (autoMergeExpectation === "absent") {
    if (pr.autoMergeEnabled || pr.autoMergeRequest !== null) {
      findings.push("lease 后 enable 前出现了非空 AutoMergeRequest");
    }
  } else {
    findings.push(...evaluateExactAutoMergeRequest(snapshot, lease));
  }
  return { eligible: findings.length === 0, diffFingerprint, findings };
}

export function leaseSuccessWindowFindings(
  lease: AuthorizationLease,
  githubServerNow: string,
  minimumRemainingMs = MIN_LEASE_SUCCESS_REMAINING_MS,
): string[] {
  const nowMs = Date.parse(githubServerNow);
  const establishedMs = Date.parse(lease.establishedAt);
  const expiresMs = Date.parse(lease.expiresAt);
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(establishedMs) ||
    !Number.isFinite(expiresMs) ||
    nowMs < establishedMs ||
    expiresMs <= establishedMs
  ) {
    return ["authorization lease 或 GitHub server time 无效"];
  }
  if (!Number.isFinite(minimumRemainingMs) || minimumRemainingMs < 0) {
    return ["authorization lease 最小余量配置无效"];
  }
  const remainingMs = expiresMs - nowMs;
  return remainingMs >= minimumRemainingMs
    ? []
    : [`authorization lease 剩余不足 ${Math.ceil(minimumRemainingMs / 1_000)} 秒`];
}

function decodeContent(value: GitHubContent): string | null {
  if (value.type !== "file" || value.encoding !== "base64") return null;
  return Buffer.from(value.content.replaceAll("\n", ""), "base64").toString("utf8");
}

function contentPath(path: string): string {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

interface ReviewThreadsPage {
  nodes: Array<{ isResolved: boolean }>;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface ReviewThreadsQuery {
  repository: {
    pullRequest: {
      reviewThreads: ReviewThreadsPage;
    } | null;
  };
}

async function reviewThreadCount(client: GitHubClient, number: number): Promise<number> {
  let unresolved = 0;
  let after: string | null = null;
  for (;;) {
    const data: ReviewThreadsQuery = await client.graphQL<ReviewThreadsQuery>(
      `query($owner: String!, $name: String!, $number: Int!, $after: String) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            reviewThreads(first: 100, after: $after) {
              nodes { isResolved }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`,
      { owner: TARGET_OWNER, name: "livis-relay-daemon", number, after },
    );
    const threads: ReviewThreadsPage | undefined = data.repository.pullRequest?.reviewThreads;
    if (!threads) throw new Error(`PR #${number} 不存在，无法读取 review threads`);
    unresolved += threads.nodes.filter((item) => !item.isResolved).length;
    if (!threads.pageInfo.hasNextPage) return unresolved;
    if (!threads.pageInfo.endCursor) throw new Error("review threads 分页缺少 endCursor");
    after = threads.pageInfo.endCursor;
  }
}

function pullRequestSnapshot(
  pr: GitHubPullRequest,
  autoMergeRequest: AutoMergeRequestSnapshot | null = null,
): PullRequestSnapshot {
  return {
    number: pr.number,
    nodeId: pr.node_id,
    state: pr.state,
    draft: pr.draft,
    body: pr.body ?? "",
    author: pr.user.login,
    baseRef: pr.base.ref,
    baseSha: pr.base.sha,
    baseRepositoryId: pr.base.repo.id,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    headRepository: pr.head.repo?.full_name ?? "",
    headRepositoryId: pr.head.repo?.id,
    mergeable: pr.mergeable,
    mergeableState: pr.mergeable_state,
    commitCount: pr.commits,
    labels: labels(pr.labels),
    requestedReviewers: pr.requested_reviewers.map((item) => item.login).sort(),
    requestedTeams: pr.requested_teams.map((item) => item.slug).sort(),
    autoMergeEnabled: pr.auto_merge !== null,
    autoMergeRequest,
  };
}

async function readAutoMergeRequest(
  client: GitHubClient,
  number: number,
): Promise<AutoMergeRequestSnapshot | null> {
  const data = await client.graphQL<AutoMergeRequestQuery>(
    `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          autoMergeRequest {
            mergeMethod
            commitHeadline
            commitBody
            enabledAt
            enabledBy { login }
          }
        }
      }
    }`,
    { owner: TARGET_OWNER, name: "livis-relay-daemon", number },
  );
  const request = data.repository.pullRequest?.autoMergeRequest;
  return request ? {
    mergeMethod: request.mergeMethod,
    commitHeadline: request.commitHeadline,
    commitBody: request.commitBody,
    enabledAt: request.enabledAt,
    enabledBy: request.enabledBy.login,
  } : null;
}

export function autoMergeReadbackFindings(
  restAutoMergeEnabled: boolean,
  graphQlRequest: AutoMergeRequestSnapshot | null,
): string[] {
  const findings: string[] = [];
  if (restAutoMergeEnabled) findings.push("REST auto_merge 仍存在");
  if (graphQlRequest !== null) findings.push("GraphQL AutoMergeRequest 仍存在");
  return findings;
}

async function readAutoMergeState(
  client: GitHubClient,
  number: number,
): Promise<{ pull: GitHubPullRequest; request: AutoMergeRequestSnapshot | null }> {
  const [pull, request] = await Promise.all([
    client.request<GitHubPullRequest>(client.repoPath(`/pulls/${number}`)),
    readAutoMergeRequest(client, number),
  ]);
  return { pull, request };
}

async function disableAndVerifyAutoMerge(
  client: GitHubClient,
  number: number,
): Promise<GitHubPullRequest> {
  let state = await readAutoMergeState(client, number);
  const initialFindings = autoMergeReadbackFindings(state.pull.auto_merge !== null, state.request);
  if (!initialFindings.length) return state.pull;
  if (state.pull.state !== "open") {
    throw new Error(`PR #${number} 已非 open，但 Auto-merge 双读仍非空：${initialFindings.join("；")}`);
  }

  let mutationError: unknown = null;
  try {
    await client.disableAutoMerge(state.pull.node_id);
  } catch (error) {
    // Mutation 与事件清理可能竞态；最终以 REST + GraphQL 双读为准。
    mutationError = error;
  }
  state = await readAutoMergeState(client, number);
  const finalFindings = autoMergeReadbackFindings(state.pull.auto_merge !== null, state.request);
  if (finalFindings.length) {
    const mutation = mutationError ? `；disable mutation=${errorText(mutationError)}` : "";
    throw new Error(`PR #${number} 禁用 Auto-merge 后双读未清空：${finalFindings.join("；")}${mutation}`);
  }
  return state.pull;
}

async function allCheckRuns(client: GitHubClient, headSha: string): Promise<GitHubCheckRuns["check_runs"]> {
  const result: GitHubCheckRuns["check_runs"] = [];
  for (let page = 1; ; page += 1) {
    const response = await client.request<GitHubCheckRuns>(
      client.repoPath(`/commits/${headSha}/check-runs?filter=all&per_page=100&page=${page}`),
    );
    result.push(...response.check_runs);
    if (response.check_runs.length < 100) return result;
  }
}

async function allWorkflowRuns(client: GitHubClient, headSha: string): Promise<GitHubWorkflowRuns["workflow_runs"]> {
  const result: GitHubWorkflowRuns["workflow_runs"] = [];
  for (let page = 1; ; page += 1) {
    const response = await client.request<GitHubWorkflowRuns>(
      client.repoPath(`/actions/runs?head_sha=${headSha}&per_page=100&page=${page}`),
    );
    result.push(...response.workflow_runs);
    if (response.workflow_runs.length < 100) return result;
  }
}

export function classifyCommitPolicyMarker(
  commitMessage: string,
): { source: "exact-commit-marker" | "malformed-policy-marker"; prNumber: number | null; headSha: string } | null {
  const policyLines = commitMessage
    .split(/\r?\n/)
    .filter((line) => line.includes(POLICY_COMMIT_MARKER_PREFIX));
  if (policyLines.length === 0) return null;
  const exact = policyLines.length === 1 ? policyLines[0]?.match(
    /^codex-automerge-policy:v1 pr=(\d+) head=([0-9a-f]{40}) diff=([0-9a-f]{64})$/,
  ) : null;
  if (exact?.[1] && exact[2]) {
    const prNumber = Number.parseInt(exact[1], 10);
    if (Number.isSafeInteger(prNumber) && prNumber > 0) {
      return { source: "exact-commit-marker", prNumber, headSha: exact[2] };
    }
  }
  const partialPr = policyLines[0]?.match(/(?:^|\s)pr=(\d+)(?:\s|$)/)?.[1];
  const partialHead = policyLines[0]?.match(/(?:^|\s)head=([0-9a-f]{40})(?:\s|$)/)?.[1] ?? "";
  const parsedPr = partialPr ? Number.parseInt(partialPr, 10) : Number.NaN;
  return {
    source: "malformed-policy-marker",
    prNumber: Number.isSafeInteger(parsedPr) && parsedPr > 0 ? parsedPr : null,
    headSha: partialHead,
  };
}

export function classifyAutoMergeQuotaEvidence(
  input: AutoMergeQuotaEvidenceInput,
): AutoMergeQuotaEvidence | null {
  const sources = new Set<AutoMergeQuotaEvidenceSource>();
  const marker = classifyCommitPolicyMarker(input.commitMessage);
  if (marker) {
    if (
      marker.source === "exact-commit-marker" &&
      marker.prNumber === input.prNumber &&
      marker.headSha === input.headSha
    ) sources.add("exact-commit-marker");
    else sources.add("malformed-policy-marker");
  }

  for (const externalId of input.gateExternalIds) {
    if (externalId.startsWith(`${GATE_EXTERNAL_ID_PREFIXES.enforceLease}:`)) {
      sources.add("enforce-lease-gate");
    } else if (
      externalId.startsWith(`${LEGACY_GATE_EXTERNAL_ID_PREFIX}:`) &&
      externalId.includes(":authorization=")
    ) {
      sources.add("legacy-authorization-gate");
    }
  }
  if (["github-actions[bot]", "github-actions"].includes(input.mergedBy ?? "")) {
    sources.add("github-actions-bot-merge");
  }
  return sources.size ? { ...input, sources: [...sources].sort() } : null;
}

export function countRecentAutoMergeEvidence(
  evidence: readonly AutoMergeQuotaEvidence[],
  now: string,
  excludeNumber: number,
): number {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("GitHub server time 无效");
  return new Set(evidence.filter((item) => {
    const mergedAt = Date.parse(item.mergedAt);
    return item.prNumber !== excludeNumber &&
      Number.isFinite(mergedAt) &&
      mergedAt <= nowMs &&
      mergedAt >= nowMs - AUTO_MERGE_WINDOW_MS;
  }).map((item) => item.mergeCommitSha)).size;
}

const quotaCache = new Map<string, AutoMergeQuotaEvidence[]>();

async function mergedPolicyPullsOnMain(
  client: GitHubClient,
  mainSha: string,
  now: string,
  forceRefresh = false,
): Promise<AutoMergeQuotaEvidence[]> {
  const cached = forceRefresh ? undefined : quotaCache.get(mainSha);
  if (cached) return cached;
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("GitHub server time 无效");
  const since = new Date(nowMs - AUTO_MERGE_WINDOW_MS - AUTO_MERGE_SCAN_MARGIN_MS).toISOString();
  const commits = await client.paginate<GitHubCommitListItem>(
    client.repoPath(`/commits?sha=${mainSha}&since=${encodeURIComponent(since)}`),
  );
  const found = new Map<string, AutoMergeQuotaEvidence>();
  for (const commit of commits) {
    const commitMarker = classifyCommitPolicyMarker(commit.commit.message);
    if (commitMarker) {
      const committedAt = commit.commit.committer?.date ?? "";
      const committedAtMs = Date.parse(committedAt);
      if (!Number.isFinite(committedAtMs) || committedAtMs > nowMs) {
        throw new Error(`main commit ${commit.sha} 的 committer 时间无效`);
      }
      if (committedAtMs >= nowMs - AUTO_MERGE_WINDOW_MS) {
        found.set(commit.sha, {
          prNumber: commitMarker.prNumber,
          headSha: commitMarker.headSha,
          mergeCommitSha: commit.sha,
          mergedAt: committedAt,
          mergedBy: null,
          commitMessage: commit.commit.message,
          gateExternalIds: [],
          sources: [commitMarker.source],
        });
      }
    }
    const associated = await client.paginate<GitHubPullRequest>(
      client.repoPath(`/commits/${commit.sha}/pulls`),
    );
    for (const pull of associated) {
      if (
        pull.merged !== true ||
        !pull.merged_at ||
        pull.merge_commit_sha !== commit.sha ||
        pull.base.ref !== TARGET_DEFAULT_BRANCH ||
        pull.base.repo.id !== TARGET_REPOSITORY_ID
      ) {
        continue;
      }
      const mergedAt = Date.parse(pull.merged_at);
      if (!Number.isFinite(mergedAt) || mergedAt > nowMs) {
        throw new Error(`PR #${pull.number} 的 merged_at 无效`);
      }
      if (mergedAt < nowMs - AUTO_MERGE_WINDOW_MS) continue;
      if (!FULL_COMMIT_SHA.test(pull.head.sha)) throw new Error(`PR #${pull.number} 的 head SHA 无效`);
      const gateExternalIds = (await allCheckRuns(client, pull.head.sha))
        .filter((check) =>
          check.name === GATE_CHECK_NAME &&
          check.app?.id === GITHUB_ACTIONS_APP_ID &&
          check.head_sha === pull.head.sha &&
          check.external_id
        )
        .map((check) => check.external_id!);
      const evidence = classifyAutoMergeQuotaEvidence({
        prNumber: pull.number,
        headSha: pull.head.sha,
        mergeCommitSha: commit.sha,
        mergedAt: pull.merged_at,
        mergedBy: pull.merged_by?.login ?? null,
        commitMessage: commit.commit.message,
        gateExternalIds,
      });
      if (!evidence) continue;
      const existing = found.get(commit.sha);
      found.set(commit.sha, existing ? {
        ...evidence,
        sources: [...new Set([...existing.sources, ...evidence.sources])].sort(),
      } : evidence);
    }
  }
  const result = [...found.values()];
  if (!forceRefresh) quotaCache.set(mainSha, result);
  return result;
}

async function recentAutoMergeCount(
  client: GitHubClient,
  mainSha: string,
  now: string,
  excludeNumber: number,
): Promise<number> {
  return countRecentAutoMergeEvidence(
    await mergedPolicyPullsOnMain(client, mainSha, now),
    now,
    excludeNumber,
  );
}

async function buildSnapshot(
  client: GitHubClient,
  event: RepositoryEvent,
  number: number,
): Promise<AutoMergePolicySnapshot> {
  const pr = await client.request<GitHubPullRequest>(client.repoPath(`/pulls/${number}`));
  const linkedIssue = issueNumber(pr.body ?? "");
  const [files, comments, reviews, reviewComments, checkRuns, workflowRuns, mainRef, threads, repository, protection, autoMergeRequest] = await Promise.all([
    client.paginate<GitHubFile>(client.repoPath(`/pulls/${number}/files`)),
    client.paginate<GitHubComment>(client.repoPath(`/issues/${number}/comments`)),
    client.paginate<unknown>(client.repoPath(`/pulls/${number}/reviews`)),
    client.paginate<unknown>(client.repoPath(`/pulls/${number}/comments`)),
    allCheckRuns(client, pr.head.sha),
    allWorkflowRuns(client, pr.head.sha),
    client.request<{ object: { sha: string } }>(client.repoPath(`/git/ref/heads/${TARGET_DEFAULT_BRANCH}`)),
    reviewThreadCount(client, number),
    client.request<GitHubRepository>(client.repoPath("")),
    client.request<GitHubBranchProtection>(client.repoPath(`/branches/${TARGET_DEFAULT_BRANCH}/protection`)),
    readAutoMergeRequest(client, number),
  ]);

  const issue = linkedIssue
    ? await client.request<GitHubIssue>(client.repoPath(`/issues/${linkedIssue}`))
    : null;
  let baseContent: string | null = null;
  let headContent: string | null = null;
  if (files.length === 1 && files[0]) {
    const path = contentPath(files[0].filename);
    const [base, head] = await Promise.all([
      client.request<GitHubContent>(client.repoPath(`/contents/${path}?ref=${pr.base.sha}`)),
      client.request<GitHubContent>(client.repoPath(`/contents/${path}?ref=${pr.head.sha}`)),
    ]);
    baseContent = decodeContent(base);
    headContent = decodeContent(head);
  }

  const now = await client.serverNow();
  if (
    repository.id !== TARGET_REPOSITORY_ID ||
    repository.full_name !== TARGET_REPOSITORY ||
    repository.default_branch !== TARGET_DEFAULT_BRANCH
  ) {
    throw new Error("GitHub Repository API 身份与固定策略目标不匹配");
  }
  const comparison = await client.request<GitHubComparison>(
    client.repoPath(`/compare/${mainRef.object.sha}...${pr.head.sha}`),
  );
  const quotaCount = await recentAutoMergeCount(client, mainRef.object.sha, now, number);
  const runsBySuite = new Map<number, GitHubWorkflowRuns["workflow_runs"][number]>();
  for (const run of [...workflowRuns].sort((left, right) => right.id - left.id)) {
    if (run.check_suite_id !== null && !runsBySuite.has(run.check_suite_id)) {
      runsBySuite.set(run.check_suite_id, run);
    }
  }

  return {
    repository: event.repository.full_name,
    repositoryId: event.repository.id,
    defaultBranch: event.repository.default_branch,
    currentMainSha: mainRef.object.sha,
    mainComparison: {
      status: comparison.status,
      aheadBy: comparison.ahead_by,
      behindBy: comparison.behind_by,
      mergeBaseSha: comparison.merge_base_commit.sha,
      baseSha: comparison.base_commit.sha,
      headSha: pr.head.sha,
    },
    branchProtection: {
      strict: protection.required_status_checks?.strict === true,
      enforceAdmins: protection.enforce_admins?.enabled === true,
      requireLinearHistory: protection.required_linear_history?.enabled === true,
      requireConversationResolution: protection.required_conversation_resolution?.enabled === true,
      allowForcePushes: protection.allow_force_pushes?.enabled === true,
      allowDeletions: protection.allow_deletions?.enabled === true,
      requiredChecks: (protection.required_status_checks?.checks ?? []).map((item) => ({
        context: item.context,
        appId: item.app_id,
      })),
    },
    repositoryAllowsAutoMerge: repository.allow_auto_merge,
    now,
    // 仅为旧 snapshot/测试调用方保留；授权稳定时间只使用 GitHub server 的 marker.created_at。
    headCommittedAt: "",
    recentAutoMergeCount: quotaCount,
    unresolvedReviewThreads: threads,
    pullRequest: pullRequestSnapshot(pr, autoMergeRequest),
    issue: issue ? {
      number: issue.number,
      state: issue.state,
      author: issue.user.login,
      labels: labels(issue.labels),
      updatedAt: issue.updated_at,
      isPullRequest: issue.pull_request !== undefined,
    } : null,
    files,
    baseContent,
    headContent,
    comments: comments.map((item) => ({
      id: item.id,
      author: item.user.login,
      body: item.body ?? "",
      createdAt: item.created_at,
      updatedAt: item.updated_at,
    })),
    reviews: reviews.length,
    reviewComments: reviewComments.length,
    checkRuns: checkRuns.map((item) => {
      const suiteId = item.check_suite?.id ?? null;
      const run = suiteId === null ? undefined : runsBySuite.get(suiteId);
      return {
        id: item.id,
        name: item.name,
        status: item.status,
        conclusion: item.conclusion,
        appId: item.app?.id ?? null,
        externalId: item.external_id,
        startedAt: item.started_at,
        headSha: item.head_sha,
        checkSuiteId: suiteId,
        workflowRunId: run?.id ?? null,
        workflowRunAttempt: run?.run_attempt ?? null,
        workflowId: run?.workflow_id ?? null,
        workflowPath: run?.path ?? null,
        workflowEvent: run?.event ?? null,
        workflowHeadSha: run?.head_sha ?? null,
        workflowStatus: run?.status ?? null,
        workflowConclusion: run?.conclusion ?? null,
        workflowRepositoryId: run?.repository.id ?? null,
        workflowHeadRepositoryId: run?.head_repository.id ?? null,
        workflowPullRequests: (run?.pull_requests ?? []).map((pull) => ({
          number: pull.number,
          baseRef: pull.base.ref,
          baseSha: pull.base.sha,
          baseRepositoryId: pull.base.repo.id,
          headSha: pull.head.sha,
          headRepositoryId: pull.head.repo.id,
        })),
      };
    }),
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type PolicyMode = "dry-run" | "audit" | "enforce";

export interface EnforceSchedule {
  nonCandidates: PullRequestSnapshot[];
  admittedCandidate: PullRequestSnapshot | null;
  deferredCandidates: PullRequestSnapshot[];
  admissionBlockedReason: string | null;
}

export function planEnforceSchedule(
  pulls: readonly PullRequestSnapshot[],
  prerequisitesSucceeded: boolean,
  remainingMs: number,
): EnforceSchedule {
  const byNumber = (left: PullRequestSnapshot, right: PullRequestSnapshot): number => left.number - right.number;
  const nonCandidates = pulls.filter((pr) => !pr.labels.includes("merge:auto")).sort(byNumber);
  const candidates = pulls.filter((pr) => pr.labels.includes("merge:auto")).sort(byNumber);
  if (candidates.length === 0) {
    return { nonCandidates, admittedCandidate: null, deferredCandidates: [], admissionBlockedReason: null };
  }
  if (!prerequisitesSucceeded) {
    return {
      nonCandidates,
      admittedCandidate: null,
      deferredCandidates: candidates,
      admissionBlockedReason: "fail-safe 预检或人工 Gate 存在失败",
    };
  }
  if (!Number.isFinite(remainingMs) || remainingMs < MIN_CANDIDATE_ADMISSION_REMAINING_MS) {
    return {
      nonCandidates,
      admittedCandidate: null,
      deferredCandidates: candidates,
      admissionBlockedReason: "candidate admission 前剩余时间不足 180 秒",
    };
  }
  return {
    nonCandidates,
    admittedCandidate: candidates[0]!,
    deferredCandidates: candidates.slice(1),
    admissionBlockedReason: null,
  };
}

export function orderPreflightPulls(
  pulls: readonly GitHubPullRequest[],
  directEventPullNumber: number | null,
): GitHubPullRequest[] {
  return [...pulls].sort((left, right) =>
    Number(right.auto_merge !== null) - Number(left.auto_merge !== null) ||
    Number(right.number === directEventPullNumber) - Number(left.number === directEventPullNumber) ||
    left.number - right.number
  );
}

interface GateHandle {
  id: number;
  headSha: string;
  externalId: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function gateExternalId(
  pr: PullRequestSnapshot,
  phase: GateExternalIdPhase,
  authorizationFingerprint?: string,
): string {
  const prefix = GATE_EXTERNAL_ID_PREFIXES[phase];
  const requiresAuthorization = phase === "audit" || phase === "enforceLease";
  if (requiresAuthorization !== Boolean(authorizationFingerprint)) {
    throw new Error(`Gate phase ${phase} 的 authorization fingerprint 形态无效`);
  }
  if (authorizationFingerprint) {
    return `${prefix}:pr=${pr.number}:head=${pr.headSha}:authorization=${authorizationFingerprint}`;
  }
  const state = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify({ labels: [...pr.labels].sort(), autoMergeEnabled: pr.autoMergeEnabled }))
    .digest("hex")
    .slice(0, 16);
  return `${prefix}:pr=${pr.number}:head=${pr.headSha}:state=${state}`;
}

function checkOutput(title: string, summary: string): { title: string; summary: string } {
  return { title: title.slice(0, 255), summary: summary.slice(0, 60_000) };
}

async function startGate(
  client: GitHubClient,
  pr: PullRequestSnapshot,
  phase: GateExternalIdPhase,
  authorizationFingerprint?: string,
): Promise<GateHandle> {
  const externalId = gateExternalId(pr, phase, authorizationFingerprint);
  const gates = (await allCheckRuns(client, pr.headSha))
    .filter((check) =>
      check.name === GATE_CHECK_NAME &&
      check.app?.id === GITHUB_ACTIONS_APP_ID
    )
    .sort((left, right) => right.id - left.id);
  const latest = gates[0];
  const existing = gates.find((check) => check.external_id === externalId);
  const updateBody = {
    name: GATE_CHECK_NAME,
    external_id: externalId,
    status: "in_progress",
    started_at: await client.serverNow(),
    output: checkOutput("低风险自动合并门禁复审中", `PR #${pr.number} 的 head ${pr.headSha} 正在重新判定。`),
  };
  // Lease-bound Gate 必须是该 app/name/head 的最新 check；不能 PATCH 较旧的 audit Gate 后误以为已提升顺序。
  if (existing && (!authorizationFingerprint || latest?.id === existing.id)) {
    try {
      await client.updateCheckRun(existing.id, updateBody);
      return { id: existing.id, headSha: pr.headSha, externalId };
    } catch {
      // GitHub 可能拒绝把 completed check 重新置为 in_progress；创建更新的一次 check run。
    }
  }
  const created = await client.createCheckRun({ ...updateBody, head_sha: pr.headSha });
  return { id: created.id, headSha: pr.headSha, externalId };
}

async function finishGate(
  client: GitHubClient,
  gate: GateHandle,
  conclusion: "success" | "failure",
  title: string,
  summary: string,
): Promise<void> {
  const body = {
    name: GATE_CHECK_NAME,
    status: "completed",
    conclusion,
    completed_at: await client.serverNow(),
    output: checkOutput(title, summary),
  };
  try {
    await client.updateCheckRun(gate.id, body);
  } catch (error) {
    if (conclusion === "success") {
      throw new Error(`success Gate 更新失败，拒绝创建迟到的替代 success：${errorText(error)}`);
    }
    // 若原 check run 已不可更新，创建同一 head 上更新的一次结论，避免旧 success 残留为最新结论。
    await client.createCheckRun({
      ...body,
      head_sha: gate.headSha,
      external_id: gate.externalId,
    });
  }
}

async function failCloseIncompletePreflight(
  client: GitHubClient,
  pr: PullRequestSnapshot,
  reason: string,
): Promise<void> {
  const completedAt = await client.serverNow();
  await client.createCheckRun({
    name: GATE_CHECK_NAME,
    head_sha: pr.headSha,
    external_id: gateExternalId(pr, "enforcePreflight"),
    status: "completed",
    conclusion: "failure",
    started_at: completedAt,
    completed_at: completedAt,
    output: checkOutput("低风险自动合并预检未完成", reason),
  });
}

async function failCloseAndDisarmPreflight(
  client: GitHubClient,
  listed: GitHubPullRequest,
  reason: string,
): Promise<string[]> {
  client.beginCleanup();
  const failures: string[] = [];
  try {
    await failCloseIncompletePreflight(client, pullRequestSnapshot(listed), reason);
  } catch (error) {
    failures.push(`failure Gate 写入失败：${errorText(error)}`);
  }
  try {
    await disableAndVerifyAutoMerge(client, listed.number);
  } catch (error) {
    failures.push(`Auto-merge 禁用/双读失败：${errorText(error)}`);
  }
  return failures;
}

async function ensureObservation(
  client: GitHubClient,
  snapshot: AutoMergePolicySnapshot,
): Promise<boolean> {
  const externalId = observationExternalId(snapshot);
  if (!externalId) return false;
  const latest = snapshot.checkRuns
    .filter((check) =>
      check.name === OBSERVATION_CHECK_NAME &&
      check.appId === GITHUB_ACTIONS_APP_ID &&
      check.headSha === snapshot.pullRequest.headSha
    )
    .sort((left, right) => (right.id ?? 0) - (left.id ?? 0))[0];
  if (
    latest?.externalId === externalId &&
    latest.status === "completed" &&
    latest.conclusion === "neutral" &&
    latest.startedAt
  ) {
    return false;
  }

  const observedAt = await client.serverNow();
  await client.createCheckRun({
    name: OBSERVATION_CHECK_NAME,
    head_sha: snapshot.pullRequest.headSha,
    external_id: externalId,
    status: "completed",
    conclusion: "neutral",
    started_at: observedAt,
    completed_at: observedAt,
    output: checkOutput(
      "低风险候选观察已开始",
      `首次观察时间=${observedAt}\n${externalId}`,
    ),
  });
  return true;
}

export function observationTombstoneExternalId(
  pr: PullRequestSnapshot,
  reason: string,
): string {
  const state = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify({
      version: 1,
      reason,
      state: pr.state,
      draft: pr.draft,
      labels: [...pr.labels].sort(),
      autoMergeEnabled: pr.autoMergeEnabled,
    }))
    .digest("hex");
  return `${OBSERVATION_TOMBSTONE_PREFIX}:pr=${pr.number}:head=${pr.headSha}:state=${state}`;
}

async function ensureObservationTombstone(
  client: GitHubClient,
  pr: PullRequestSnapshot,
  reason: string,
): Promise<boolean> {
  const externalId = observationTombstoneExternalId(pr, reason);
  const latest = (await allCheckRuns(client, pr.headSha))
    .filter((check) =>
      check.name === OBSERVATION_CHECK_NAME &&
      check.app?.id === GITHUB_ACTIONS_APP_ID
    )
    .sort((left, right) => right.id - left.id)[0];
  if (
    latest?.external_id === externalId &&
    latest.status === "completed" &&
    latest.conclusion === "neutral"
  ) {
    return false;
  }
  const observedAt = await client.serverNow();
  await client.createCheckRun({
    name: OBSERVATION_CHECK_NAME,
    head_sha: pr.headSha,
    external_id: externalId,
    status: "completed",
    conclusion: "neutral",
    started_at: observedAt,
    completed_at: observedAt,
    output: checkOutput(
      "低风险候选观察已失效",
      `中断原因=${reason}\n失效时间=${observedAt}\n${externalId}`,
    ),
  });
  return true;
}

export function autoMergeCommitMarker(number: number, headSha: string, diffFingerprint: string): string {
  return `codex-automerge-policy:v1 pr=${number} head=${headSha} diff=${diffFingerprint}`;
}

async function mainContainsMergeAndQuotaEvidence(
  client: GitHubClient,
  number: number,
  mergeCommitSha: string,
): Promise<boolean> {
  const mainRef = await client.request<{ object: { sha: string } }>(
    client.repoPath(`/git/ref/heads/${TARGET_DEFAULT_BRANCH}`),
  );
  const comparison = await client.request<GitHubComparison>(
    client.repoPath(`/compare/${mergeCommitSha}...${mainRef.object.sha}`),
  );
  const containsMerge =
    ["ahead", "identical"].includes(comparison.status) &&
    comparison.behind_by === 0 &&
    comparison.merge_base_commit.sha === mergeCommitSha;
  if (!containsMerge) return false;
  const now = await client.serverNow();
  const evidence = await mergedPolicyPullsOnMain(client, mainRef.object.sha, now, true);
  return evidence.some((item) => item.prNumber === number && item.mergeCommitSha === mergeCommitSha);
}

function policyFailure(number: number, result: AutoMergePolicyResult): Error {
  return new Error(`PR #${number} 不满足低风险策略：\n- ${result.findings.join("\n- ")}`);
}

async function restoreAfterFailure(
  client: GitHubClient,
  original: PullRequestSnapshot,
  gate: GateHandle,
  changedDraftState: boolean,
  failure: unknown,
): Promise<never> {
  client.beginCleanup();
  const cleanupErrors: string[] = [];
  try {
    await finishGate(
      client,
      gate,
      "failure",
      "低风险自动合并门禁失败",
      errorText(failure),
    );
  } catch (error) {
    cleanupErrors.push(`Gate failure 写入失败：${errorText(error)}`);
  }

  let current: GitHubPullRequest | null = null;
  try {
    await ensureObservationTombstone(client, original, "enforce-failure");
  } catch (error) {
    cleanupErrors.push(`Observation tombstone 写入失败：${errorText(error)}`);
  }
  try {
    current = await disableAndVerifyAutoMerge(client, original.number);
  } catch (error) {
    cleanupErrors.push(`Auto-merge 回滚失败：${errorText(error)}`);
  }
  try {
    current ??= await client.request<GitHubPullRequest>(client.repoPath(`/pulls/${original.number}`));
    if (current.head.sha !== original.headSha) {
      await ensureObservationTombstone(
        client,
        pullRequestSnapshot(current),
        "enforce-failure-live-head",
      );
    }
    if (changedDraftState) {
      if (current.state !== "open") {
        throw new Error(`PR #${original.number} 已进入 ${current.state}，无法转回 draft`);
      }
      if (current.head.sha !== original.headSha) {
        throw new Error(`PR #${original.number} head 已漂移，拒绝修改新 head 的 draft 状态`);
      }
      if (!current.draft) await client.convertToDraft(current.node_id);
      current = await client.request<GitHubPullRequest>(client.repoPath(`/pulls/${original.number}`));
      if (current.state !== "open" || current.head.sha !== original.headSha || !current.draft) {
        throw new Error(`PR #${original.number} 转回 draft 后读回不一致`);
      }
    }
  } catch (error) {
    cleanupErrors.push(`draft 回滚失败：${errorText(error)}`);
  }

  const suffix = cleanupErrors.length ? `\n- ${cleanupErrors.join("\n- ")}` : "";
  throw new Error(`${errorText(failure)}${suffix}`);
}

async function auditCandidate(
  client: GitHubClient,
  event: RepositoryEvent,
  pr: PullRequestSnapshot,
): Promise<void> {
  let seedSnapshot = await buildSnapshot(client, event, pr.number);
  if (await ensureObservation(client, seedSnapshot)) {
    seedSnapshot = await buildSnapshot(client, event, pr.number);
  }
  const authorizationFingerprint = computeAuthorizationFingerprint(seedSnapshot);
  const gate = await startGate(client, pr, "audit", authorizationFingerprint);
  try {
    const snapshot = await buildSnapshot(client, event, pr.number);
    const result = evaluateAutoMergePolicy(snapshot, "audit");
    if (snapshot.pullRequest.headSha !== pr.headSha) throw new Error("Gate 创建后 head SHA 已漂移");
    if (computeAuthorizationFingerprint(snapshot) !== authorizationFingerprint) {
      throw new Error("audit Gate 创建后完整授权指纹已漂移");
    }
    if (snapshot.pullRequest.autoMergeEnabled) {
      throw new Error("audit 模式检测到既有 Auto-merge；仅写 failure Gate，不执行状态变更");
    }
    await finishGate(
      client,
      gate,
      result.eligible ? "success" : "failure",
      result.eligible ? "低风险自动合并候选通过审计" : "低风险自动合并候选未通过审计",
      result.eligible ? `diff=${result.diffFingerprint}` : result.findings.join("\n"),
    );
    if (!result.eligible) throw policyFailure(pr.number, result);
  } catch (error) {
    client.beginCleanup();
    try {
      await finishGate(client, gate, "failure", "低风险自动合并候选未通过审计", errorText(error));
    } catch {
      // 保留原始审计错误；上层汇总后 workflow 失败。
    }
    throw error;
  }
}

async function enforceCandidate(
  client: GitHubClient,
  event: RepositoryEvent,
  original: PullRequestSnapshot,
  runDeadlineMs: number,
): Promise<void> {
  let gate: GateHandle | null = null;
  let changedDraftState = false;
  try {
    let current = await disableAndVerifyAutoMerge(client, original.number);

    let seed = await buildSnapshot(client, event, original.number);
    if (await ensureObservation(client, seed)) seed = await buildSnapshot(client, event, original.number);
    const snapshotA = seed;
    const resultA = evaluateAutoMergePolicy(snapshotA, "enforce");
    gate = await startGate(client, snapshotA.pullRequest, "enforcePreflight");
    if (snapshotA.pullRequest.headSha !== original.headSha || !resultA.eligible) {
      throw snapshotA.pullRequest.headSha === original.headSha
        ? policyFailure(original.number, resultA)
        : new Error(`PR #${original.number} 首次判定时 head SHA 漂移`);
    }

    if (snapshotA.pullRequest.draft) {
      await client.markReady(snapshotA.pullRequest.nodeId);
      changedDraftState = true;
    }

    let snapshotB: AutoMergePolicySnapshot | null = null;
    let resultB: AutoMergePolicyResult | null = null;
    for (let attempt = 0; attempt < (changedDraftState ? 10 : 2); attempt += 1) {
      if (attempt > 0 || changedDraftState) await wait(3_000);
      snapshotB = await buildSnapshot(client, event, original.number);
      resultB = evaluateAutoMergePolicy(snapshotB, "enforce");
      if (resultB.eligible && snapshotB.pullRequest.headSha === original.headSha) break;
    }
    if (!snapshotB || !resultB?.eligible || snapshotB.pullRequest.headSha !== original.headSha) {
      throw new Error(`PR #${original.number} ready 后完整授权状态未稳定：\n- ${resultB?.findings.join("\n- ") || "head SHA 漂移"}`);
    }

    const authorizationFingerprint = computeAuthorizationFingerprint(snapshotB);
    gate = await startGate(client, snapshotB.pullRequest, "enforceLease", authorizationFingerprint);
    const leaseTime = await client.serverNow();
    const snapshotC = await buildSnapshot(client, event, original.number);
    const boundGate = snapshotC.checkRuns
      .filter((check) => check.name === GATE_CHECK_NAME && check.appId === GITHUB_ACTIONS_APP_ID)
      .sort((left, right) => (right.id ?? 0) - (left.id ?? 0))[0];
    if (
      boundGate?.externalId !== gate.externalId ||
      boundGate.headSha !== original.headSha ||
      boundGate.status !== "in_progress"
    ) {
      throw new Error("authorization Gate 未以最新 in_progress check 精确绑定完整授权指纹");
    }
    const leaseResult = establishAuthorizationLease(snapshotB, snapshotC, leaseTime);
    if (!leaseResult.lease) {
      throw new Error(`PR #${original.number} 无法建立授权 lease：\n- ${leaseResult.findings.join("\n- ")}`);
    }
    const lease = leaseResult.lease;

    const readySafety = evaluatePostLeaseSafety(snapshotC, lease);
    if (!readySafety.eligible) {
      throw new Error(`PR #${original.number} lease 后安全复核失败：\n- ${readySafety.findings.join("\n- ")}`);
    }

    const commitMarker = autoMergeCommitMarker(original.number, original.headSha, readySafety.diffFingerprint);
    await client.enableAutoMerge(
      original.nodeId,
      original.headSha,
      expectedAutoMergeCommitHeadline(original.number),
      commitMarker,
    );

    const finalSnapshot = await buildSnapshot(client, event, original.number);
    const finalSafety = evaluatePostLeaseSafety(finalSnapshot, lease, "exact");
    if (!finalSnapshot.pullRequest.autoMergeEnabled || !finalSafety.eligible) {
      throw new Error(`PR #${original.number} 启用 Auto-merge 后安全复核失败：\n- ${finalSafety.findings.join("\n- ")}`);
    }
    if (runDeadlineMs - Date.now() < SUCCESS_CLEANUP_RESERVE_MS) {
      throw new Error("写入 success Gate 前已不足 90 秒清理余量");
    }
    const preSuccessServerNow = await client.serverNow();
    const preSuccessLeaseFindings = leaseSuccessWindowFindings(lease, preSuccessServerNow);
    if (preSuccessLeaseFindings.length) {
      throw new Error(`写入 success Gate 前 lease 余量不足：${preSuccessLeaseFindings.join("；")}`);
    }

    await finishGate(
      client,
      gate,
      "success",
      "低风险自动合并门禁通过",
      `head=${original.headSha}\nauthorization=${lease.authorizationFingerprint}\nlease_expires=${lease.expiresAt}`,
    );

    const postSuccessServerNow = await client.serverNow();
    const postSuccessLeaseFindings = leaseSuccessWindowFindings(
      lease,
      postSuccessServerNow,
      MIN_POST_SUCCESS_LEASE_REMAINING_MS,
    );
    if (postSuccessLeaseFindings.length) {
      throw new Error(`success Gate 写入后 lease 余量不足：${postSuccessLeaseFindings.join("；")}`);
    }

    const leaseRemainingMs = Date.parse(lease.expiresAt) - Date.parse(postSuccessServerNow);
    const deadline = Math.min(
      Date.now() + MERGE_WAIT_TIMEOUT_MS,
      Date.now() + leaseRemainingMs,
      runDeadlineMs,
    );
    while (Date.now() < deadline) {
      current = await client.request<GitHubPullRequest>(client.repoPath(`/pulls/${original.number}`));
      if (current.merged === true && current.merged_at && current.merge_commit_sha) {
        const mergedAt = Date.parse(current.merged_at);
        if (
          current.head.sha !== original.headSha ||
          !Number.isFinite(mergedAt) ||
          mergedAt < Date.parse(lease.establishedAt) ||
          mergedAt > Date.parse(lease.expiresAt)
        ) {
          throw new Error("已合并 PR 不在 head-bound 60 秒授权 lease 内");
        }
        const mergedCommit = await client.request<GitHubCommit>(
          client.repoPath(`/commits/${current.merge_commit_sha}`),
        );
        if (!mergedCommit.commit.message.split("\n").includes(commitMarker)) {
          throw new Error("已合并 squash commit 缺少预期 policy provenance marker");
        }
        if (await mainContainsMergeAndQuotaEvidence(client, original.number, current.merge_commit_sha)) {
          console.log(`PR #${original.number} 已合并，且 main/quota provenance 已读回确认：${current.merge_commit_sha}`);
          return;
        }
        await wait(MERGE_POLL_INTERVAL_MS);
        continue;
      }
      if (current.state !== "open") throw new Error(`PR #${original.number} 已关闭但未合并`);
      if (current.head.sha !== original.headSha) throw new Error(`PR #${original.number} 等待合并时 head SHA 漂移`);
      if (current.auto_merge === null) throw new Error(`PR #${original.number} 的原生 Auto-merge 请求意外消失`);

      const polled = await buildSnapshot(client, event, original.number);
      const polledResult = evaluatePostLeaseSafety(polled, lease, "exact");
      if (!polledResult.eligible || polled.pullRequest.headSha !== original.headSha) {
        throw new Error(`PR #${original.number} 等待合并时 lease safety 失效：\n- ${polledResult.findings.join("\n- ")}`);
      }
      await wait(MERGE_POLL_INTERVAL_MS);
    }
    throw new Error("等待原生 Auto-merge/main/quota 读回超过 60 秒");
  } catch (error) {
    if (gate) return restoreAfterFailure(client, original, gate, changedDraftState, error);
    throw error;
  }
}

async function passThroughHumanPull(
  client: GitHubClient,
  listed: PullRequestSnapshot,
  mode: Exclude<PolicyMode, "dry-run">,
): Promise<void> {
  const initialAutoMergeState = await readAutoMergeState(client, listed.number);
  let current = initialAutoMergeState.pull;
  if (current.state !== "open" || current.head.sha !== listed.headSha) {
    throw new Error("人工路径 pass-through 判定时 PR state/head 已漂移");
  }
  const currentSnapshot = pullRequestSnapshot(current, initialAutoMergeState.request);
  await ensureObservationTombstone(client, currentSnapshot, "non-candidate-pass-through");
  if (labels(current.labels).includes("merge:auto")) {
    throw new Error("人工路径 pass-through 判定时出现 merge:auto 标签，已 tombstone 旧 observation");
  }

  const latestGate = (await allCheckRuns(client, currentSnapshot.headSha))
    .filter((check) => check.name === GATE_CHECK_NAME && check.app?.id === GITHUB_ACTIONS_APP_ID)
    .sort((left, right) => right.id - left.id)[0];
  if (
    autoMergeReadbackFindings(currentSnapshot.autoMergeEnabled, currentSnapshot.autoMergeRequest ?? null).length === 0 &&
    latestGate?.external_id === gateExternalId(currentSnapshot, "passThrough") &&
    latestGate.status === "completed" &&
    latestGate.conclusion === "success"
  ) {
    console.log(`PR #${listed.number} 的 head/label/Auto-merge 状态未变，复用既有 pass-through Gate`);
    return;
  }
  const gate = await startGate(client, currentSnapshot, "passThrough");
  try {
    if (
      current.auto_merge !== null ||
      initialAutoMergeState.request !== null
    ) {
      if (mode === "audit") {
        throw new Error("audit 模式发现非候选 PR 已启用 Auto-merge，Gate 保持 failure");
      }
      current = await disableAndVerifyAutoMerge(client, listed.number);
    }
    const finalAutoMergeState = await readAutoMergeState(client, listed.number);
    current = finalAutoMergeState.pull;
    if (autoMergeReadbackFindings(current.auto_merge !== null, finalAutoMergeState.request).length) {
      if (mode === "audit") {
        throw new Error("audit 人工路径完成前出现 Auto-merge 请求");
      }
      current = await disableAndVerifyAutoMerge(client, listed.number);
    }
    if (
      current.state !== "open" ||
      current.head.sha !== listed.headSha ||
      labels(current.labels).includes("merge:auto")
    ) {
      throw new Error("人工路径完成前 PR state/head/label 已漂移");
    }
    await finishGate(
      client,
      gate,
      "success",
      "人工合并路径 pass-through",
      "该 PR 未请求 merge:auto；此 Gate 不替代人工审阅与其他 required checks。",
    );
  } catch (error) {
    client.beginCleanup();
    try {
      await finishGate(client, gate, "failure", "人工路径安全复审失败", errorText(error));
    } catch {
      // 保留原始错误。
    }
    throw error;
  }
}

const INTERRUPTING_PULL_REQUEST_ACTIONS = new Set([
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
  "auto_merge_enabled",
  "auto_merge_disabled",
]);

const EVENT_ACTIONS = new Map<string, ReadonlySet<string>>([
  ["pull_request_target", INTERRUPTING_PULL_REQUEST_ACTIONS],
  ["issue_comment", new Set(["created", "edited", "deleted"])],
  ["issues", new Set(["opened", "edited", "closed", "reopened", "labeled", "unlabeled", "deleted"])],
  ["pull_request_review", new Set(["submitted", "edited", "dismissed"])],
  ["pull_request_review_comment", new Set(["created", "edited", "deleted"])],
]);

export function interruptionTombstoneReason(event: RepositoryEvent): string | null {
  if (
    !event.pull_request?.number ||
    !event.action ||
    !INTERRUPTING_PULL_REQUEST_ACTIONS.has(event.action)
  ) {
    return null;
  }
  const label = event.label?.name ? `:label=${event.label.name}` : "";
  return `pull_request_target:${event.action}:pr=${event.pull_request.number}${label}`;
}

export function classifyEventTombstoneImpact(
  eventName: string,
  event: RepositoryEvent,
  githubRunId: string,
): EventTombstoneImpact | null {
  const allowedActions = EVENT_ACTIONS.get(eventName);
  if (!allowedActions || !event.action || !allowedActions.has(event.action) || !/^\d+$/.test(githubRunId)) {
    return null;
  }

  let directPullNumber: number | null = null;
  let sourceIssueNumber: number | null = null;
  let entityId: number | null = null;
  if (eventName === "pull_request_target" || eventName === "pull_request_review" || eventName === "pull_request_review_comment") {
    directPullNumber = event.pull_request?.number ?? null;
    entityId = eventName === "pull_request_review"
      ? event.review?.id ?? null
      : eventName === "pull_request_review_comment"
        ? event.comment?.id ?? null
        : directPullNumber;
  } else if (eventName === "issue_comment") {
    entityId = event.comment?.id ?? null;
    if (event.issue?.pull_request !== undefined) directPullNumber = event.issue.number;
    else sourceIssueNumber = event.issue?.number ?? null;
  } else if (eventName === "issues") {
    sourceIssueNumber = event.issue?.number ?? null;
    entityId = sourceIssueNumber;
  }
  if ((!directPullNumber && !sourceIssueNumber) || !entityId) return null;
  const label = event.label?.name ? `:label=${event.label.name}` : "";
  return {
    directPullNumber,
    sourceIssueNumber,
    reason: `event=${eventName}:action=${event.action}:entity=${entityId}:run=${githubRunId}${label}`,
  };
}

export function resolveIssueAffectedPulls(
  issueNumberValue: number,
  openPulls: readonly IssueLinkedPull[],
): number[] {
  const linked = openPulls
    .filter((pull) => issueNumber(pull.body) === issueNumberValue)
    .map((pull) => pull.number);
  const targets = linked.length
    ? linked
    : openPulls.filter((pull) => pull.labels.includes("merge:auto")).map((pull) => pull.number);
  return [...new Set(targets)].sort((left, right) => left - right);
}

async function main(): Promise<void> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const token = process.env.GITHUB_TOKEN;
  const requestedMode = process.env.AUTOMERGE_POLICY_MODE;
  const trustedWorkflowSha = process.env.AUTOMERGE_TRUSTED_WORKFLOW_SHA;
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const githubRunId = process.env.GITHUB_RUN_ID ?? "";
  const mode: PolicyMode = requestedMode === "audit" || requestedMode === "enforce" ? requestedMode : "dry-run";
  if (!eventPath || !token) throw new Error("缺少 GITHUB_EVENT_PATH 或 GITHUB_TOKEN");
  if (mode !== "dry-run" && (!trustedWorkflowSha || !FULL_COMMIT_SHA.test(trustedWorkflowSha))) {
    throw new Error("audit/enforce 缺少格式有效的 AUTOMERGE_TRUSTED_WORKFLOW_SHA");
  }
  const event = await Bun.file(eventPath).json() as RepositoryEvent;
  if (
    !event.repository ||
    event.repository.full_name !== TARGET_REPOSITORY ||
    event.repository.id !== TARGET_REPOSITORY_ID ||
    event.repository.default_branch !== TARGET_DEFAULT_BRANCH
  ) {
    throw new Error("GitHub event 的仓库身份不匹配");
  }

  const runStartedMs = Date.now();
  const runDeadlineMs = runStartedMs + RUN_SOFT_DEADLINE_MS;
  const client = new GitHubClient(
    TARGET_REPOSITORY,
    token,
    runDeadlineMs,
    runStartedMs + RUN_CLEANUP_HARD_DEADLINE_MS,
    mode === "dry-run" ? null : trustedWorkflowSha!,
  );
  const openPulls = await client.paginate<GitHubPullRequest>(
    client.repoPath("/pulls?state=open&sort=created&direction=asc"),
  );
  const isInterruptingEvent = Boolean(event.action && EVENT_ACTIONS.get(eventName)?.has(event.action));
  const impact = classifyEventTombstoneImpact(eventName, event, githubRunId);
  if (isInterruptingEvent && !impact) {
    throw new Error(`无法安全解析 ${eventName}/${event.action} 的 PR 影响范围或 GITHUB_RUN_ID`);
  }
  if (impact) {
    const targetNumbers = impact.directPullNumber
      ? [impact.directPullNumber]
      : resolveIssueAffectedPulls(
        impact.sourceIssueNumber!,
        openPulls.map((pull) => ({
          number: pull.number,
          body: pull.body ?? "",
          labels: labels(pull.labels),
        })),
      );
    for (const number of targetNumbers) {
      if (mode === "dry-run") {
        console.log(`DRY_RUN：WOULD_TOMBSTONE PR #${number}，reason=${impact.reason}`);
        continue;
      }
      const interrupted = await client.request<GitHubPullRequest>(client.repoPath(`/pulls/${number}`));
      await ensureObservationTombstone(client, pullRequestSnapshot(interrupted), impact.reason);
    }
  }
  if (openPulls.length === 0) {
    console.log(`${mode.toUpperCase()}：当前没有 open PR`);
    return;
  }

  const currentPulls: PullRequestSnapshot[] = [];
  const preflightFailures: string[] = [];
  let preflightCleanupMode = false;
  const orderedOpenPulls = orderPreflightPulls(openPulls, impact?.directPullNumber ?? null);
  for (const listed of orderedOpenPulls) {
    if (Date.now() >= runDeadlineMs) {
      const failure = "open PR 预检超过 5 分钟软截止时间";
      if (mode !== "enforce") throw new Error(failure);
      if (!preflightCleanupMode) {
        preflightFailures.push(failure);
        preflightCleanupMode = true;
      }
      const cleanupFailures = await failCloseAndDisarmPreflight(
        client,
        listed,
        "本轮未能在 admission 软截止前完成 REST/GraphQL 双读；已失败关闭该 head，禁止复用旧 Gate。",
      );
      for (const detail of cleanupFailures) {
        const cleanupFailure = `PR #${listed.number} 超时收口失败：${detail}`;
        preflightFailures.push(cleanupFailure);
        console.error(cleanupFailure);
      }
      continue;
    }
    try {
      const current = mode === "enforce"
        ? await disableAndVerifyAutoMerge(client, listed.number)
        : await client.request<GitHubPullRequest>(client.repoPath(`/pulls/${listed.number}`));
      if (current.state !== "open") continue;
      currentPulls.push(pullRequestSnapshot(current));
    } catch (error) {
      if (mode !== "enforce") throw error;
      const failure = `PR #${listed.number} fail-safe 预检失败：${errorText(error)}`;
      preflightFailures.push(failure);
      console.error(failure);
      preflightCleanupMode = true;
      const cleanupFailures = await failCloseAndDisarmPreflight(
        client,
        listed,
        "REST/GraphQL 预检失败；已独立尝试写 failure Gate 与禁用 Auto-merge。",
      );
      for (const detail of cleanupFailures) {
        const cleanupFailure = `PR #${listed.number} 预检失败收口异常：${detail}`;
        preflightFailures.push(cleanupFailure);
        console.error(cleanupFailure);
      }
    }
  }

  if (mode === "enforce") {
    const failures = [...preflightFailures];
    const initialSchedule = planEnforceSchedule(currentPulls, false, 0);

    // 人工路径永远先于 candidate admission；单个 Gate 失败只聚合，不阻断后续人工 PR。
    for (const pr of initialSchedule.nonCandidates) {
      try {
        await passThroughHumanPull(client, pr, mode);
        console.log(`ENFORCE：PR #${pr.number} 已写入人工路径 pass-through Gate`);
      } catch (error) {
        const failure = `PR #${pr.number} 人工路径 Gate 失败：${errorText(error)}`;
        failures.push(failure);
        console.error(failure);
      }
    }

    const admissionSchedule = planEnforceSchedule(
      currentPulls,
      failures.length === 0,
      runDeadlineMs - Date.now(),
    );
    if (admissionSchedule.admissionBlockedReason) {
      failures.push(`candidate admission 已阻止：${admissionSchedule.admissionBlockedReason}`);
    }
    if (admissionSchedule.deferredCandidates.length) {
      console.log(
        `本轮延期候选：${admissionSchedule.deferredCandidates.map((pr) => `#${pr.number}`).join("、")}`,
      );
    }
    if (admissionSchedule.admittedCandidate) {
      await enforceCandidate(client, event, admissionSchedule.admittedCandidate, runDeadlineMs);
      return;
    }
    if (failures.length) throw new Error(`低风险 Auto-merge policy 存在失败：\n- ${failures.join("\n- ")}`);
    return;
  }

  const failures: string[] = [];
  for (const pr of currentPulls) {
    if (Date.now() >= runDeadlineMs) {
      failures.push("策略扫描达到 5 分钟软截止时间");
      break;
    }
    const candidate = pr.labels.includes("merge:auto");
    try {
      if (mode === "dry-run") {
        if (!candidate) {
          const warning = pr.autoMergeEnabled ? "；警告：检测到未授权 Auto-merge（dry-run 不写入）" : "";
          console.log(`DRY_RUN：PR #${pr.number} 走人工 pass-through${warning}`);
          continue;
        }
        const snapshot = await buildSnapshot(client, event, pr.number);
        const result = evaluateAutoMergePolicy(snapshot, "audit");
        console.log(
          result.eligible
            ? `DRY_RUN：PR #${pr.number} 满足策略；diff=${result.diffFingerprint}`
            : `DRY_RUN：PR #${pr.number} 不满足策略：\n- ${result.findings.join("\n- ")}`,
        );
        if (!result.eligible) failures.push(`PR #${pr.number}: ${result.findings.join("；")}`);
        continue;
      }

      if (!candidate) {
        await passThroughHumanPull(client, pr, mode);
        console.log(`${mode.toUpperCase()}：PR #${pr.number} 已写入人工路径 pass-through Gate`);
      } else if (mode === "audit") {
        await auditCandidate(client, event, pr);
        console.log(`AUDIT：PR #${pr.number} 候选 Gate 审计完成，未 ready/enable/merge`);
      }
    } catch (error) {
      failures.push(`PR #${pr.number}: ${errorText(error)}`);
      console.error(`PR #${pr.number} 处理失败：${errorText(error)}`);
    }
  }

  if (failures.length) throw new Error(`低风险 Auto-merge policy 存在失败：\n- ${failures.join("\n- ")}`);
}

if (import.meta.main) {
  await main();
}
