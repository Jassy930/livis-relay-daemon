export const LOCAL_BACKEND_CONTRACT_VERSION = 1 as const;

export const TARGET_LOCAL_BACKENDS = ["hermes", "codex", "claude"] as const;
export type LocalBackendKind = (typeof TARGET_LOCAL_BACKENDS)[number];

// 这里只描述当前可用性，不等同于能力声明。Codex/Claude 在完成 adapter、
// 隔离测试和实网 canary 前必须保持 contract-only。
export const LOCAL_BACKEND_IMPLEMENTATION_STATE = {
  hermes: "phase1-existing",
  codex: "contract-only",
  claude: "contract-only",
} as const satisfies Record<LocalBackendKind, "phase1-existing" | "contract-only">;

export const LOCAL_BACKEND_AUTH_POLICY = {
  credentialOwner: "native-backend",
  daemonReadsCredentialStores: false,
  daemonStartsAuthentication: false,
  daemonRefreshesCredentials: false,
  authenticationUnavailableCode: "backend_auth_unavailable",
} as const;

export type LocalBackendReadiness =
  | "ready"
  | "offline"
  | "authentication-required"
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

export class LocalBackendAuthenticationUnavailableError extends Error {
  readonly code = LOCAL_BACKEND_AUTH_POLICY.authenticationUnavailableCode;

  constructor(readonly backend: LocalBackendKind) {
    super(`本地 ${backend} 后端没有可用认证；请在其原生客户端完成认证后重试`);
    this.name = "LocalBackendAuthenticationUnavailableError";
  }
}

export function isLocalBackendKind(value: unknown): value is LocalBackendKind {
  return typeof value === "string" && TARGET_LOCAL_BACKENDS.includes(value as LocalBackendKind);
}
