import {
  inspectCodexAccountResponse,
  type CodexAccountInspection,
} from "./codex-execution-backend.ts";

export interface CodexNativeAccountClient {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

export interface CodexNativeAccountBinding {
  accountType: "apiKey" | "chatgpt" | "amazonBedrock";
  accountSubjectSha256: string;
  identityStrength: "subject";
  requiresOpenaiAuth: boolean;
}

export type CodexNativeAuthSessionErrorCode =
  | "backend_auth_unavailable"
  | "native_account_response_incompatible"
  | "native_account_identity_incompatible"
  | "native_account_binding_drift"
  | "native_client_epoch_superseded";

export class CodexNativeAuthSessionError extends Error {
  constructor(
    readonly code: CodexNativeAuthSessionErrorCode,
    readonly readiness: "authentication-required" | "incompatible",
    readonly sessionDisposition: "none" | "quarantine_required",
    message: string,
  ) {
    super(message);
    this.name = "CodexNativeAuthSessionError";
  }
}

export interface CodexNativeClientEpochReceipt {
  clientEpoch: number;
  accountBinding: CodexNativeAccountBinding;
  productionReady: false;
}

export interface CodexNativeClientAttachOptions {
  requestTimeoutMs: number;
  expectedAccountBinding?: CodexNativeAccountBinding;
}

interface ActiveClientEpoch {
  client: CodexNativeAccountClient;
  receipt: CodexNativeClientEpochReceipt | null;
  epoch: number;
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} 必须是正整数`);
}

function errorDisposition(
  expected: CodexNativeAccountBinding | undefined,
): "none" | "quarantine_required" {
  return expected === undefined ? "none" : "quarantine_required";
}

function bindingFromInspection(
  inspection: CodexAccountInspection,
  disposition: "none" | "quarantine_required",
): CodexNativeAccountBinding {
  if (inspection.accountType === null || inspection.identityStrength === null) {
    throw new CodexNativeAuthSessionError(
      "backend_auth_unavailable",
      "authentication-required",
      disposition,
      "Codex 原生当前认证不可用",
    );
  }
  if (
    inspection.identityStrength !== "subject" ||
    inspection.accountSubjectSha256 === null
  ) {
    throw new CodexNativeAuthSessionError(
      "native_account_identity_incompatible",
      "incompatible",
      disposition,
      "Codex 原生账号未提供可证明的主体绑定，禁止绑定持久 thread",
    );
  }
  return {
    accountType: inspection.accountType as CodexNativeAccountBinding["accountType"],
    accountSubjectSha256: inspection.accountSubjectSha256,
    identityStrength: inspection.identityStrength,
    requiresOpenaiAuth: inspection.requiresOpenaiAuth,
  };
}

function sameBinding(
  left: CodexNativeAccountBinding,
  right: CodexNativeAccountBinding,
): boolean {
  return left.accountType === right.accountType &&
    left.accountSubjectSha256 === right.accountSubjectSha256 &&
    left.identityStrength === right.identityStrength &&
    left.requiresOpenaiAuth === right.requiresOpenaiAuth;
}

function validateExpectedBinding(binding: CodexNativeAccountBinding): void {
  if (
    binding.accountType.trim() === "" ||
    !["apiKey", "chatgpt", "amazonBedrock"].includes(binding.accountType) ||
    binding.identityStrength !== "subject" ||
    !/^[0-9a-f]{64}$/.test(binding.accountSubjectSha256) ||
    typeof binding.requiresOpenaiAuth !== "boolean"
  ) {
    throw new Error("expectedAccountBinding 必须是已脱敏的强主体绑定");
  }
}

async function readAccountBinding(
  client: CodexNativeAccountClient,
  requestTimeoutMs: number,
  disposition: "none" | "quarantine_required",
): Promise<CodexNativeAccountBinding> {
  let response: unknown;
  try {
    response = await client.request("account/read", { refreshToken: false }, requestTimeoutMs);
  } catch {
    throw new CodexNativeAuthSessionError(
      "native_account_response_incompatible",
      "incompatible",
      disposition,
      "Codex 原生 account/read 无法完成安全回读",
    );
  }
  let inspection: CodexAccountInspection;
  try {
    inspection = inspectCodexAccountResponse(response);
  } catch {
    throw new CodexNativeAuthSessionError(
      "native_account_response_incompatible",
      "incompatible",
      disposition,
      "Codex 原生 account/read 响应未经审核",
    );
  }
  return bindingFromInspection(inspection, disposition);
}

/**
 * 只管理 relay 自己的 proxy client 代际与脱敏账号绑定。
 *
 * 它不连接真实 socket、不创建 thread、不读取凭据，也不管理原生 daemon。新 attach 会立即
 * fence 旧代际；是否允许在旧 attempt 未收口时开始新 attach，仍由未来的持久 session
 * coordinator 裁决。
 */
export class CodexNativeClientEpochFence {
  private nextEpoch = 0;
  private active: ActiveClientEpoch | null = null;

  async attach(
    client: CodexNativeAccountClient,
    options: CodexNativeClientAttachOptions,
  ): Promise<CodexNativeClientEpochReceipt> {
    positiveInteger(options.requestTimeoutMs, "requestTimeoutMs");
    if (options.expectedAccountBinding) validateExpectedBinding(options.expectedAccountBinding);

    const epoch = ++this.nextEpoch;
    const candidate: ActiveClientEpoch = { client, receipt: null, epoch };
    // 进入新 attach 即失效旧 client；失败时也不能静默恢复旧认证或旧 thread。
    this.active = candidate;
    const disposition = errorDisposition(options.expectedAccountBinding);
    let accountBinding: CodexNativeAccountBinding;
    try {
      accountBinding = await readAccountBinding(
        client,
        options.requestTimeoutMs,
        disposition,
      );
    } catch (error) {
      if (this.active === candidate) this.active = null;
      throw error;
    }
    if (this.active !== candidate) {
      throw new CodexNativeAuthSessionError(
        "native_client_epoch_superseded",
        "incompatible",
        "none",
        "Codex native proxy attach 已被更新代际取代",
      );
    }
    if (
      options.expectedAccountBinding &&
      !sameBinding(accountBinding, options.expectedAccountBinding)
    ) {
      this.active = null;
      throw new CodexNativeAuthSessionError(
        "native_account_binding_drift",
        "incompatible",
        "quarantine_required",
        "Codex 原生账号主体或认证类型与持久 session 不一致",
      );
    }

    const receipt: CodexNativeClientEpochReceipt = {
      clientEpoch: epoch,
      accountBinding,
      productionReady: false,
    };
    candidate.receipt = receipt;
    return receipt;
  }

  isCurrent(
    receipt: CodexNativeClientEpochReceipt,
    client: CodexNativeAccountClient,
  ): boolean {
    return this.active?.receipt === receipt && this.active.client === client &&
      this.active.epoch === receipt.clientEpoch;
  }

  invalidate(
    receipt: CodexNativeClientEpochReceipt,
    client: CodexNativeAccountClient,
  ): boolean {
    if (!this.isCurrent(receipt, client)) return false;
    this.active = null;
    return true;
  }

  async revalidate(
    receipt: CodexNativeClientEpochReceipt,
    client: CodexNativeAccountClient,
    requestTimeoutMs: number,
  ): Promise<void> {
    positiveInteger(requestTimeoutMs, "requestTimeoutMs");
    if (!this.isCurrent(receipt, client)) {
      throw new CodexNativeAuthSessionError(
        "native_client_epoch_superseded",
        "incompatible",
        "none",
        "Codex native proxy client epoch 已失效",
      );
    }
    const current = await readAccountBinding(
      client,
      requestTimeoutMs,
      "quarantine_required",
    );
    if (!this.isCurrent(receipt, client)) {
      throw new CodexNativeAuthSessionError(
        "native_client_epoch_superseded",
        "incompatible",
        "none",
        "Codex native proxy client epoch 在认证回读期间失效",
      );
    }
    if (!sameBinding(current, receipt.accountBinding)) {
      throw new CodexNativeAuthSessionError(
        "native_account_binding_drift",
        "incompatible",
        "quarantine_required",
        "Codex 原生账号主体或认证类型在 turn/start 前发生漂移",
      );
    }
  }
}
