export const LOCAL_BACKEND_CONTRACT_VERSION = 1 as const;

export const TARGET_LOCAL_BACKENDS = ["hermes", "codex", "claude"] as const;
export type LocalBackendKind = (typeof TARGET_LOCAL_BACKENDS)[number];

export type LocalBackendImplementationState =
  | "implemented"
  | "implemented-experimental"
  | "contract-only";

// 这里只描述当前代码实现状态，不等同于生产能力声明。
export const LOCAL_BACKEND_IMPLEMENTATION_STATE = {
  hermes: "implemented",
  codex: "implemented-experimental",
  claude: "contract-only",
} as const satisfies Record<LocalBackendKind, LocalBackendImplementationState>;

export type LocalBackendAuthenticationIntegration =
  | "native-profile-owned"
  | "daemon-private-native-store"
  | "not-implemented";

// 认证集成状态必须与实现状态分开：Codex transport 已实现，但仍使用 daemon
// state directory 下的私有 CODEX_HOME，并未复用用户日常 Codex 登录态。
export const LOCAL_BACKEND_AUTH_INTEGRATION = {
  hermes: "native-profile-owned",
  codex: "daemon-private-native-store",
  claude: "not-implemented",
} as const satisfies Record<LocalBackendKind, LocalBackendAuthenticationIntegration>;

export const LOCAL_BACKEND_AUTH_POLICY = {
  targetMode: "native-current-state-opaque",
  credentialOwner: "native-backend",
  daemonReadsCredentialStores: false,
  daemonInspectsAuthenticationState: false,
  daemonStartsAuthentication: false,
  daemonRefreshesCredentials: false,
  daemonBlocksInvocationOnAuthenticationState: false,
  backendErrorsFlowThroughExecution: true,
} as const;

export type LocalBackendReadiness =
  | "ready"
  | "offline"
  | "incompatible";

export interface LocalBackendProbe {
  backend: LocalBackendKind;
  readiness: LocalBackendReadiness;
  implementation: {
    name: string;
    version: string;
  };
}

export interface LocalBackendSessionRef {
  backend: LocalBackendKind;
  localSessionId: string;
}

export interface LocalBackendInvocation {
  contractVersion: typeof LOCAL_BACKEND_CONTRACT_VERSION;
  backend: LocalBackendKind;
  jobId: string;
  leaseId: string;
  runGeneration: number;
  text: string;
  session?: LocalBackendSessionRef;
}

export interface LocalBackendResult {
  backend: LocalBackendKind;
  localSessionId: string;
  text: string;
}

export interface LocalBackendCancellation {
  backend: LocalBackendKind;
  jobId: string;
  leaseId: string;
  localSessionId?: string;
}

export interface LocalBackendAdapter {
  readonly backend: LocalBackendKind;
  probe(): Promise<LocalBackendProbe>;
  invoke(request: LocalBackendInvocation, signal?: AbortSignal): Promise<LocalBackendResult>;
  cancel(request: LocalBackendCancellation, signal?: AbortSignal): Promise<void>;
}

export function isLocalBackendKind(value: unknown): value is LocalBackendKind {
  return typeof value === "string" && TARGET_LOCAL_BACKENDS.includes(value as LocalBackendKind);
}
