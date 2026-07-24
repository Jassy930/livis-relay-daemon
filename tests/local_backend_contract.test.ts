import { describe, expect, test } from "bun:test";
import {
  LOCAL_BACKEND_AUTH_POLICY,
  LOCAL_BACKEND_AUTH_INTEGRATION,
  LOCAL_BACKEND_COMPATIBILITY_POLICY,
  LOCAL_BACKEND_CONTRACT_VERSION,
  LOCAL_BACKEND_IMPLEMENTATION_STATE,
  TARGET_LOCAL_BACKENDS,
  isLocalBackendKind,
  type LocalBackendAdapter,
  type LocalBackendCancellation,
  type LocalBackendInvocation,
  type LocalBackendProbe,
  type LocalBackendResult,
  type LocalBackendSessionRef,
} from "../src/backend/contract.ts";

type ForbiddenCredentialField =
  | "credentials"
  | "credentialStore"
  | "credentialPath"
  | "token"
  | "tokenFile"
  | "oauthToken"
  | "accessToken"
  | "refreshToken"
  | "apiKey"
  | "password"
  | "authorization"
  | "environment"
  | "env";

type ForbiddenAuthMethod =
  | "login"
  | "logout"
  | "authenticate"
  | "authorize"
  | "refresh"
  | "refreshCredentials"
  | "setCredentials"
  | "getAccessToken";
type HasNoForbiddenKey<T, Forbidden extends PropertyKey> = Extract<keyof T, Forbidden> extends never ? true : false;

// 这些赋值由 `bun run typecheck` 执行，未来若把凭据字段或认证方法加入
// daemon/adapter 契约会直接编译失败。
const invocationHasNoCredentials: HasNoForbiddenKey<LocalBackendInvocation, ForbiddenCredentialField> = true;
const resultHasNoCredentials: HasNoForbiddenKey<LocalBackendResult, ForbiddenCredentialField> = true;
const probeHasNoCredentials: HasNoForbiddenKey<LocalBackendProbe, ForbiddenCredentialField> = true;
const sessionHasNoCredentials: HasNoForbiddenKey<LocalBackendSessionRef, ForbiddenCredentialField> = true;
const cancellationHasNoCredentials: HasNoForbiddenKey<LocalBackendCancellation, ForbiddenCredentialField> = true;
const adapterHasNoAuthMethods: HasNoForbiddenKey<LocalBackendAdapter, ForbiddenAuthMethod> = true;

describe("本地后端中立契约", () => {
  test("实现状态与认证集成状态分离，Codex 不能再误报为 contract-only", () => {
    expect(TARGET_LOCAL_BACKENDS).toEqual(["hermes", "codex", "claude"]);
    expect(LOCAL_BACKEND_IMPLEMENTATION_STATE).toEqual({
      hermes: "implemented",
      codex: "implemented-experimental",
      claude: "contract-only",
    });
    expect(LOCAL_BACKEND_AUTH_INTEGRATION).toEqual({
      hermes: "native-profile-owned",
      codex: "native-current-state-opaque",
      claude: "not-implemented",
    });
    expect(isLocalBackendKind("hermes")).toBeTrue();
    expect(isLocalBackendKind("codex")).toBeTrue();
    expect(isLocalBackendKind("claude")).toBeTrue();
    expect(isLocalBackendKind("openai")).toBeFalse();
  });

  test("调用契约不携带凭据、环境或认证控制方法", () => {
    expect({
      invocationHasNoCredentials,
      resultHasNoCredentials,
      probeHasNoCredentials,
      sessionHasNoCredentials,
      cancellationHasNoCredentials,
      adapterHasNoAuthMethods,
    }).toEqual({
      invocationHasNoCredentials: true,
      resultHasNoCredentials: true,
      probeHasNoCredentials: true,
      sessionHasNoCredentials: true,
      cancellationHasNoCredentials: true,
      adapterHasNoAuthMethods: true,
    });

    const request: LocalBackendInvocation = {
      contractVersion: LOCAL_BACKEND_CONTRACT_VERSION,
      backend: "codex",
      jobId: "job-1",
      leaseId: "lease-1",
      runGeneration: 1,
      text: "只返回纯文本结果",
    };
    expect(Object.keys(request).sort()).toEqual([
      "backend",
      "contractVersion",
      "jobId",
      "leaseId",
      "runGeneration",
      "text",
    ]);
  });

  test("认证状态对 daemon 完全不透明，本地错误继续走执行结果", () => {
    expect(LOCAL_BACKEND_AUTH_POLICY).toEqual({
      targetMode: "native-current-state-opaque",
      credentialOwner: "native-backend",
      daemonReadsCredentialStores: false,
      daemonInspectsAuthenticationState: false,
      daemonStartsAuthentication: false,
      daemonRefreshesCredentials: false,
      daemonBlocksInvocationOnAuthenticationState: false,
      backendErrorsFlowThroughExecution: true,
    });
  });

  test("版本只用于观测，readiness 由 capability/协议握手裁决", () => {
    expect(LOCAL_BACKEND_COMPATIBILITY_POLICY).toEqual({
      readinessBasis: "capability-probe",
      versionsAreObservational: true,
      rejectVersionDifferenceAlone: false,
      targetedVersionDenialsRequireEvidence: true,
    });
  });
});
