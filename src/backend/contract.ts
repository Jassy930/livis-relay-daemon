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
  | "native-current-state-opaque"
  | "not-implemented";

// 认证集成状态必须与实现状态分开：Codex 的原生 stdio 实验路径只把 HOME/CODEX_HOME
// 作为 runtime 选择器交给 Codex，本身不读取或解释用户当前认证状态。生产 serve 在真实执行
// canary 完成前仍保持既有私有 backend，不由这个枚举宣称上线。
export const LOCAL_BACKEND_AUTH_INTEGRATION = {
  hermes: "native-profile-owned",
  codex: "native-current-state-opaque",
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

// 原生后端更新频繁；版本用于诊断和漂移审计，readiness 由实际能力/协议握手决定。
// 若已证明某个精确版本存在不可安全兼容的行为，可在具体 adapter 增加带证据的定向拒绝，
// 但不能用“版本不同”本身替代协议验证。
export const LOCAL_BACKEND_COMPATIBILITY_POLICY = {
  readinessBasis: "capability-probe",
  versionsAreObservational: true,
  rejectVersionDifferenceAlone: false,
  targetedVersionDenialsRequireEvidence: true,
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
