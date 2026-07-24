import { describe, expect, test } from "bun:test";
import {
  CodexNativeAuthSessionError,
  CodexNativeClientEpochFence,
  type CodexNativeAccountBinding,
  type CodexNativeAccountClient,
} from "../src/backends/codex/native-auth-session.ts";

function account(email = "native-user@example.test"): Record<string, unknown> {
  return {
    requiresOpenaiAuth: true,
    account: { type: "chatgpt", email },
  };
}

class FakeAccountClient implements CodexNativeAccountClient {
  readonly requests: Array<{ method: string; params: unknown; timeoutMs?: number }> = [];
  response: unknown = account();
  failure: Error | null = null;

  async request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    this.requests.push({ method, params, timeoutMs });
    if (this.failure) throw this.failure;
    return this.response as T;
  }
}

function authError(error: unknown): CodexNativeAuthSessionError {
  expect(error).toBeInstanceOf(CodexNativeAuthSessionError);
  return error as CodexNativeAuthSessionError;
}

describe("Codex native 账号绑定与 client epoch", () => {
  test("attach 只读 account/read(false)，仅保留脱敏强主体绑定", async () => {
    const client = new FakeAccountClient();
    const fence = new CodexNativeClientEpochFence();
    const receipt = await fence.attach(client, { requestTimeoutMs: 80 });

    expect(client.requests).toEqual([{
      method: "account/read",
      params: { refreshToken: false },
      timeoutMs: 80,
    }]);
    expect(receipt).toMatchObject({
      clientEpoch: 1,
      accountBinding: {
        accountType: "chatgpt",
        identityStrength: "subject",
        requiresOpenaiAuth: true,
      },
      productionReady: false,
    });
    expect(receipt.accountBinding.accountSubjectSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain("native-user@example.test");
  });

  test("未认证使用稳定 backend_auth_unavailable，旧 session 场景要求 quarantine", async () => {
    const freshClient = new FakeAccountClient();
    freshClient.response = { requiresOpenaiAuth: true, account: null };
    let freshCaught: unknown;
    try {
      await new CodexNativeClientEpochFence().attach(freshClient, { requestTimeoutMs: 50 });
    } catch (error) {
      freshCaught = error;
    }
    expect(authError(freshCaught)).toMatchObject({
      code: "backend_auth_unavailable",
      readiness: "authentication-required",
      sessionDisposition: "none",
    });

    const firstClient = new FakeAccountClient();
    const fence = new CodexNativeClientEpochFence();
    const first = await fence.attach(firstClient, { requestTimeoutMs: 50 });
    const resumedClient = new FakeAccountClient();
    resumedClient.response = { requiresOpenaiAuth: true, account: null };
    await expect(fence.attach(resumedClient, {
      requestTimeoutMs: 50,
      expectedAccountBinding: first.accountBinding,
    })).rejects.toMatchObject({
      code: "backend_auth_unavailable",
      sessionDisposition: "quarantine_required",
    });
  });

  test("弱身份不能绑定持久 thread，同类型新账号也不能继承旧 thread", async () => {
    const weak = new FakeAccountClient();
    weak.response = {
      requiresOpenaiAuth: true,
      account: { type: "chatgpt" },
    };
    await expect(new CodexNativeClientEpochFence().attach(weak, { requestTimeoutMs: 50 }))
      .rejects.toMatchObject({
        code: "native_account_identity_incompatible",
        readiness: "incompatible",
      });

    const fence = new CodexNativeClientEpochFence();
    const original = await fence.attach(new FakeAccountClient(), { requestTimeoutMs: 50 });
    const replacement = new FakeAccountClient();
    replacement.response = account("replacement@example.test");
    await expect(fence.attach(replacement, {
      requestTimeoutMs: 50,
      expectedAccountBinding: original.accountBinding,
    })).rejects.toMatchObject({
      code: "native_account_binding_drift",
      sessionDisposition: "quarantine_required",
    });
    expect(fence.isCurrent(original, replacement)).toBeFalse();
  });

  test("畸形响应和读取失败只返回稳定 incompatible，不携带原始错误", async () => {
    for (const variant of ["malformed", "failure"] as const) {
      const client = new FakeAccountClient();
      if (variant === "malformed") client.response = { unexpected: "SENSITIVE_RESPONSE" };
      else client.failure = new Error("SENSITIVE_PROVIDER_FAILURE");
      let caught: unknown;
      try {
        await new CodexNativeClientEpochFence().attach(client, { requestTimeoutMs: 50 });
      } catch (error) {
        caught = error;
      }
      const error = authError(caught);
      expect(error).toMatchObject({
        code: "native_account_response_incompatible",
        readiness: "incompatible",
        sessionDisposition: "none",
      });
      expect(JSON.stringify(error)).not.toContain("SENSITIVE");
      expect(error.message).not.toContain("SENSITIVE");
      expect(error.cause).toBeUndefined();
    }
  });

  test("每次 attach 递增 epoch，并重新建立认证绑定而非复用旧 receipt", async () => {
    const fence = new CodexNativeClientEpochFence();
    const firstClient = new FakeAccountClient();
    const first = await fence.attach(firstClient, { requestTimeoutMs: 50 });
    const secondClient = new FakeAccountClient();
    const second = await fence.attach(secondClient, { requestTimeoutMs: 50 });

    expect(first.clientEpoch).toBe(1);
    expect(second.clientEpoch).toBe(2);
    expect(first).not.toBe(second);
    expect(first.accountBinding).not.toBe(second.accountBinding);
    expect(firstClient.requests).toHaveLength(1);
    expect(secondClient.requests).toHaveLength(1);
    expect(fence.isCurrent(first, firstClient)).toBeFalse();
    expect(fence.isCurrent(second, secondClient)).toBeTrue();
  });

  test("expected binding 本身必须是脱敏强主体形态", async () => {
    const invalid = {
      accountType: "chatgpt",
      accountSubjectSha256: "not-a-digest",
      identityStrength: "subject",
      requiresOpenaiAuth: true,
    } as CodexNativeAccountBinding;
    await expect(new CodexNativeClientEpochFence().attach(new FakeAccountClient(), {
      requestTimeoutMs: 50,
      expectedAccountBinding: invalid,
    })).rejects.toThrow("expectedAccountBinding 必须是已脱敏的强主体绑定");
  });
});
