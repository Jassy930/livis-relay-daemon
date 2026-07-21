import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IdaasClient, TerminalAuthError } from "../src/auth/idaas.ts";
import { SecretStore } from "../src/secrets.ts";
import type { DeviceCodeResponse, OAuthTokenSet } from "../src/types.ts";
import { temporaryDirectory, testProfile } from "./helpers.ts";

const DEVICE_CODE_SENTINEL = "probe-device-code-sentinel";
const ACCESS_TOKEN_SENTINEL = "probe-access-token-sentinel";
const SECOND_ACCESS_TOKEN_SENTINEL = "probe-second-access-token-sentinel";
const REFRESH_TOKEN_SENTINEL = "probe-refresh-token-sentinel";
const ROTATED_REFRESH_TOKEN_SENTINEL = "probe-rotated-refresh-token-sentinel";
const ID_TOKEN_SENTINEL = "probe-id-token-sentinel";

const SECRET_LABELS = new Map([
  [DEVICE_CODE_SENTINEL, "<device-code>"],
  [ACCESS_TOKEN_SENTINEL, "<access-token>"],
  [SECOND_ACCESS_TOKEN_SENTINEL, "<second-access-token>"],
  [REFRESH_TOKEN_SENTINEL, "<refresh-token>"],
  [ROTATED_REFRESH_TOKEN_SENTINEL, "<rotated-refresh-token>"],
  [ID_TOKEN_SENTINEL, "<id-token>"],
]);

interface CapturedRequest {
  url: string;
  init: RequestInit;
  form: URLSearchParams;
}

interface DeferredResponse {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
}

function redactSecret(value: string): string {
  return SECRET_LABELS.get(value) ?? value;
}

function requestSnapshot(request: CapturedRequest): {
  method: string | undefined;
  path: string;
  query: string;
  contentType: string | null;
  fields: Array<[string, string]>;
} {
  const url = new URL(request.url);
  return {
    method: request.init.method,
    path: url.pathname,
    query: url.search,
    contentType: new Headers(request.init.headers).get("content-type"),
    fields: [...request.form.entries()]
      .map(([key, value]): [string, string] => [key, redactSecret(value)])
      .sort(([left], [right]) => left.localeCompare(right)),
  };
}

function captureRequest(input: string | URL | Request, init?: RequestInit): CapturedRequest {
  if (typeof init?.body !== "string") {
    throw new Error("离线 IDaaS probe 只接受字符串表单请求体");
  }
  return {
    url: String(input),
    init,
    form: new URLSearchParams(init.body),
  };
}

function queuedFetch(
  responses: Array<Response | Error>,
  requests: CapturedRequest[],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = captureRequest(input, init);
    requests.push(request);
    const response = responses.shift();
    if (!response) {
      throw new Error(`离线 IDaaS probe 未声明 ${new URL(request.url).pathname} 的响应`);
    }
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }) as typeof fetch;
}

function deferredResponse(): DeferredResponse {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function waitForRequestCount(requests: CapturedRequest[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (requests.length === count) return;
    await Promise.resolve();
  }
  throw new Error(`离线 IDaaS probe 等待 ${count} 个请求超时`);
}

async function captureSafeError(promise: Promise<unknown>): Promise<{
  message: string;
  terminal: boolean;
}> {
  try {
    await promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if ([...SECRET_LABELS.keys()].some((sentinel) => message.includes(sentinel))) {
      throw new Error("IDaaS 错误消息泄露了固定 token 哨兵");
    }
    return {
      message,
      terminal: error instanceof TerminalAuthError,
    };
  }
  throw new Error("离线 IDaaS probe 预期调用失败，但调用成功");
}

function validDeviceCode(): DeviceCodeResponse {
  return {
    device_code: DEVICE_CODE_SENTINEL,
    verification_uri_complete: "https://login.example.test/device?code=public-user-code",
    expires_in: 60,
    interval: 1,
  };
}

function tokenSnapshot(token: OAuthTokenSet): Record<string, unknown> {
  return {
    accessToken: redactSecret(token.accessToken),
    refreshToken: token.refreshToken ? redactSecret(token.refreshToken) : undefined,
    expiresIn: token.expiresIn,
    tokenType: token.tokenType,
    idToken: token.idToken ? redactSecret(token.idToken) : undefined,
  };
}

describe("IDaaS 本地 S2 contract probe（完全离线）", () => {
  let directory: Awaited<ReturnType<typeof temporaryDirectory>>;
  let secrets: SecretStore;

  beforeEach(async () => {
    directory = await temporaryDirectory("livis-idaas-contract-probe-");
    secrets = new SecretStore(directory.path);
    await secrets.initialize();
  });

  afterEach(async () => {
    await directory.cleanup();
  });

  test("/aux 固定使用 POST 表单及精确字段，只有 force=true 才发送 prompt=login", async () => {
    const profile = await testProfile();
    const requests: CapturedRequest[] = [];
    const responseBody = {
      device_code: DEVICE_CODE_SENTINEL,
      verification_uri_complete: "https://login.example.test/device",
      expires_in: 60,
      interval: 1,
    };
    const client = new IdaasClient(profile, secrets, {
      fetch: queuedFetch([Response.json(responseBody), Response.json(responseBody)], requests),
    });

    await client.requestDeviceCode();
    await client.requestDeviceCode(true);

    expect(requests.map(requestSnapshot)).toEqual([
      {
        method: "POST",
        path: "/api/aux",
        query: "",
        contentType: "application/x-www-form-urlencoded",
        fields: [
          ["audience", profile.oauth.audience],
          ["client_id", profile.oauth.clientId],
          ["offline_access", "true"],
          ["scope", `${profile.oauth.scope} offline_access`],
        ],
      },
      {
        method: "POST",
        path: "/api/aux",
        query: "",
        contentType: "application/x-www-form-urlencoded",
        fields: [
          ["audience", profile.oauth.audience],
          ["client_id", profile.oauth.clientId],
          ["offline_access", "true"],
          ["prompt", "login"],
          ["scope", `${profile.oauth.scope} offline_access`],
        ],
      },
    ]);
  });

  test("device /token 固定字段可接收 flat token，并将 refresh token 写入临时 SecretStore", async () => {
    const profile = await testProfile();
    const requests: CapturedRequest[] = [];
    const sleeps: number[] = [];
    const client = new IdaasClient(profile, secrets, {
      fetch: queuedFetch([
        Response.json({
          access_token: ACCESS_TOKEN_SENTINEL,
          refresh_token: REFRESH_TOKEN_SENTINEL,
          expires_in: 3600,
          token_type: "Bearer",
          id_token: ID_TOKEN_SENTINEL,
        }),
      ], requests),
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });

    const token = await client.pollForToken(validDeviceCode());

    expect(tokenSnapshot(token)).toEqual({
      accessToken: "<access-token>",
      refreshToken: "<refresh-token>",
      expiresIn: 3600,
      tokenType: "Bearer",
      idToken: "<id-token>",
    });
    expect(sleeps).toEqual([1000]);
    expect((await secrets.get()).refreshToken === REFRESH_TOKEN_SENTINEL).toBeTrue();
    expect(requests.map(requestSnapshot)).toEqual([
      {
        method: "POST",
        path: "/api/token",
        query: "",
        contentType: "application/x-www-form-urlencoded",
        fields: [
          ["client_id", profile.oauth.clientId],
          ["device_code", "<device-code>"],
          ["grant_type", "urn:ietf:params:oauth:grant-type:device_code"],
        ],
      },
    ]);
  });

  test("device /token 以 OAuth error 而非单一 HTTP 状态驱动 pending/slow_down，并可接收 audience 嵌套 token", async () => {
    const profile = await testProfile();
    const requests: CapturedRequest[] = [];
    const sleeps: number[] = [];
    let pendingCount = 0;
    const client = new IdaasClient(profile, secrets, {
      fetch: queuedFetch([
        Response.json({ error: "authorization_pending" }, { status: 400 }),
        Response.json({ error: "authorization_pending" }, { status: 428 }),
        Response.json({ error: "slow_down" }, { status: 503 }),
        Response.json({
          [profile.oauth.audience]: {
            access_token: ACCESS_TOKEN_SENTINEL,
            refresh_token: REFRESH_TOKEN_SENTINEL,
            expires_in: 7200,
            token_type: "Bearer",
          },
          id_token: ID_TOKEN_SENTINEL,
        }),
      ], requests),
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });

    const token = await client.pollForToken(validDeviceCode(), {
      onPending: () => {
        pendingCount += 1;
      },
    });

    expect(tokenSnapshot(token)).toEqual({
      accessToken: "<access-token>",
      refreshToken: "<refresh-token>",
      expiresIn: 7200,
      tokenType: "Bearer",
      idToken: "<id-token>",
    });
    expect({ pendingCount, sleeps }).toEqual({
      pendingCount: 2,
      sleeps: [1000, 1000, 1000, 6000],
    });
    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(requestSnapshot(request)).toEqual({
        method: "POST",
        path: "/api/token",
        query: "",
        contentType: "application/x-www-form-urlencoded",
        fields: [
          ["client_id", profile.oauth.clientId],
          ["device_code", "<device-code>"],
          ["grant_type", "urn:ietf:params:oauth:grant-type:device_code"],
        ],
      });
    }
  });

  test("refresh /token 精确字段支持嵌套 token 轮换，并在后续 flat 响应省略 refresh_token 时保留轮换值", async () => {
    const profile = await testProfile();
    await secrets.setRefreshToken(REFRESH_TOKEN_SENTINEL);
    const requests: CapturedRequest[] = [];
    const client = new IdaasClient(profile, secrets, {
      fetch: queuedFetch([
        Response.json({
          [profile.oauth.audience]: {
            access_token: ACCESS_TOKEN_SENTINEL,
            refresh_token: ROTATED_REFRESH_TOKEN_SENTINEL,
            expires_in: 3600,
            token_type: "Bearer",
          },
        }),
        Response.json({
          access_token: SECOND_ACCESS_TOKEN_SENTINEL,
          expires_in: 1800,
          token_type: "Bearer",
        }),
      ], requests),
    });

    const firstAccessToken = await client.getAccessToken(true);
    const rotatedOnDisk = (await secrets.get()).refreshToken === ROTATED_REFRESH_TOKEN_SENTINEL;
    const secondAccessToken = await client.getAccessToken(true);

    expect({
      firstAccessToken: redactSecret(firstAccessToken),
      secondAccessToken: redactSecret(secondAccessToken),
      rotatedOnDisk,
      rotationPreservedWhenOmitted: (await secrets.get()).refreshToken === ROTATED_REFRESH_TOKEN_SENTINEL,
    }).toEqual({
      firstAccessToken: "<access-token>",
      secondAccessToken: "<second-access-token>",
      rotatedOnDisk: true,
      rotationPreservedWhenOmitted: true,
    });
    expect(requests.map(requestSnapshot)).toEqual([
      {
        method: "POST",
        path: "/api/token",
        query: "",
        contentType: "application/x-www-form-urlencoded",
        fields: [
          ["client_id", profile.oauth.clientId],
          ["grant_type", "refresh_token"],
          ["refresh_token", "<refresh-token>"],
        ],
      },
      {
        method: "POST",
        path: "/api/token",
        query: "",
        contentType: "application/x-www-form-urlencoded",
        fields: [
          ["client_id", profile.oauth.clientId],
          ["grant_type", "refresh_token"],
          ["refresh_token", "<rotated-refresh-token>"],
        ],
      },
    ]);
  });

  test("[S2 当前风险观察] refresh 将 invalid_grant 与任意可解析 HTTP 401 视为清除信号", async () => {
    const profile = await testProfile();
    const observations: Array<Record<string, unknown>> = [];
    const cases = [
      {
        label: "oauth-invalid-grant",
        response: Response.json({ error: "invalid_grant" }, { status: 400 }),
        expectedCleared: true,
      },
      {
        // temporarily_unavailable 并不等于 refresh token 失效；这里固定的是当前客户端风险，不是正确服务端语义。
        label: "http-401-risk-observation",
        response: Response.json({ error: "temporarily_unavailable" }, { status: 401 }),
        expectedCleared: true,
      },
      {
        label: "transient-http",
        response: Response.json({ error: "temporarily_unavailable" }, { status: 503 }),
        expectedCleared: false,
      },
    ];

    for (const currentCase of cases) {
      await secrets.setRefreshToken(REFRESH_TOKEN_SENTINEL);
      const requests: CapturedRequest[] = [];
      const client = new IdaasClient(profile, secrets, {
        fetch: queuedFetch([currentCase.response], requests),
      });
      const error = await captureSafeError(client.getAccessToken(true));
      const cleared = (await secrets.get()).refreshToken === undefined;
      observations.push({
        label: currentCase.label,
        terminal: error.terminal,
        cleared,
        request: requestSnapshot(requests[0]!),
      });
      expect(cleared).toBe(currentCase.expectedCleared);
    }

    expect(observations).toEqual([
      {
        label: "oauth-invalid-grant",
        terminal: true,
        cleared: true,
        request: {
          method: "POST",
          path: "/api/token",
          query: "",
          contentType: "application/x-www-form-urlencoded",
          fields: [
            ["client_id", profile.oauth.clientId],
            ["grant_type", "refresh_token"],
            ["refresh_token", "<refresh-token>"],
          ],
        },
      },
      {
        label: "http-401-risk-observation",
        terminal: true,
        cleared: true,
        request: {
          method: "POST",
          path: "/api/token",
          query: "",
          contentType: "application/x-www-form-urlencoded",
          fields: [
            ["client_id", profile.oauth.clientId],
            ["grant_type", "refresh_token"],
            ["refresh_token", "<refresh-token>"],
          ],
        },
      },
      {
        label: "transient-http",
        terminal: false,
        cleared: false,
        request: {
          method: "POST",
          path: "/api/token",
          query: "",
          contentType: "application/x-www-form-urlencoded",
          fields: [
            ["client_id", profile.oauth.clientId],
            ["grant_type", "refresh_token"],
            ["refresh_token", "<refresh-token>"],
          ],
        },
      },
    ]);
  });

  test("/revoke 仅成功响应清除本地 token，失败响应保留；两种路径请求字段完全一致", async () => {
    const profile = await testProfile();
    await secrets.setRefreshToken(REFRESH_TOKEN_SENTINEL);
    const requests: CapturedRequest[] = [];
    const failedClient = new IdaasClient(profile, secrets, {
      fetch: queuedFetch([
        Response.json({ error: "temporarily_unavailable" }, { status: 503 }),
      ], requests),
    });

    const failure = await captureSafeError(failedClient.revoke());
    const preservedAfterFailure = (await secrets.get()).refreshToken === REFRESH_TOKEN_SENTINEL;

    const successfulClient = new IdaasClient(profile, secrets, {
      fetch: queuedFetch([new Response(null, { status: 204 })], requests),
    });
    await successfulClient.revoke();

    expect({
      failureMessage: failure.message,
      preservedAfterFailure,
      clearedAfterSuccess: (await secrets.get()).refreshToken === undefined,
    }).toEqual({
      failureMessage: "撤销 refresh token 失败：HTTP 503；本地 refresh token 已保留",
      preservedAfterFailure: true,
      clearedAfterSuccess: true,
    });
    expect(requests.map(requestSnapshot)).toEqual([
      {
        method: "POST",
        path: "/api/revoke",
        query: "",
        contentType: "application/x-www-form-urlencoded",
        fields: [
          ["client_id", profile.oauth.clientId],
          ["token", "<refresh-token>"],
          ["token_type_hint", "refresh_token"],
        ],
      },
      {
        method: "POST",
        path: "/api/revoke",
        query: "",
        contentType: "application/x-www-form-urlencoded",
        fields: [
          ["client_id", profile.oauth.clientId],
          ["token", "<refresh-token>"],
          ["token_type_hint", "refresh_token"],
        ],
      },
    ]);
  });

  test("[当前观察][风险待修复] /aux 会接受错误字段类型和非 HTTPS verification URI；这不是服务端契约要求", async () => {
    const profile = await testProfile();
    const client = new IdaasClient(profile, secrets, {
      fetch: queuedFetch([
        Response.json({
          device_code: 7,
          verification_uri_complete: "http://insecure.example.test/device",
          expires_in: "60",
          interval: -1,
        }),
      ], []),
    });

    const observed = await client.requestDeviceCode();

    // S2 只记录当前缺少运行时校验的事实，不能把这些值解释为允许的服务器响应。
    expect({
      deviceCodeType: typeof observed.device_code,
      verificationProtocol: new URL(observed.verification_uri_complete).protocol,
      expiresInType: typeof observed.expires_in,
      interval: observed.interval,
    }).toEqual({
      deviceCodeType: "number",
      verificationProtocol: "http:",
      expiresInType: "string",
      interval: -1,
    });
  });

  test("[当前观察][风险待修复] refresh 非 JSON HTTP 401 在清除判定前失败，因此失效 token 仍被保留", async () => {
    const profile = await testProfile();
    await secrets.setRefreshToken(REFRESH_TOKEN_SENTINEL);
    const requests: CapturedRequest[] = [];
    const client = new IdaasClient(profile, secrets, {
      fetch: queuedFetch([
        new Response("unauthorized", {
          status: 401,
          headers: { "Content-Type": "text/plain" },
        }),
      ], requests),
    });

    const error = await captureSafeError(client.getAccessToken(true));

    // 这是错误处理顺序的现状记录；后续修复应让明确的 401 失效信号失败关闭。
    expect({
      message: error.message,
      terminal: error.terminal,
      refreshTokenPreserved: (await secrets.get()).refreshToken === REFRESH_TOKEN_SENTINEL,
      requestCount: requests.length,
    }).toEqual({
      message: "IDaaS refresh /token 返回了非 JSON 响应",
      terminal: false,
      refreshTokenPreserved: true,
      requestCount: 1,
    });
  });

  test("[当前观察][风险待修复] expires_in=1 的 access token 在服务端 TTL 后仍命中 30 秒本地缓存", async () => {
    const profile = await testProfile();
    await secrets.setRefreshToken(REFRESH_TOKEN_SENTINEL);
    const requests: CapturedRequest[] = [];
    let now = 1_700_000_000_000;
    const originalDateNow = Date.now;
    Date.now = () => now;
    try {
      const client = new IdaasClient(profile, secrets, {
        fetch: queuedFetch([
          Response.json({
            access_token: ACCESS_TOKEN_SENTINEL,
            expires_in: 1,
            token_type: "Bearer",
          }),
        ], requests),
      });

      const first = await client.getAccessToken(true);
      now += 2_000;
      const afterServerTtl = await client.getAccessToken();

      // 结构化观察表明当前最短缓存为 30 秒，不表示短 TTL 响应是安全的。
      expect({
        requestCount: requests.length,
        firstWasSentinel: first === ACCESS_TOKEN_SENTINEL,
        reusedAfterServerTtl: afterServerTtl === ACCESS_TOKEN_SENTINEL,
        elapsedMs: 2_000,
        serverTtlMs: 1_000,
      }).toEqual({
        requestCount: 1,
        firstWasSentinel: true,
        reusedAfterServerTtl: true,
        elapsedMs: 2_000,
        serverTtlMs: 1_000,
      });
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("[当前观察][风险待修复] 并发 refresh 可在一次轮换成功后被另一请求的 invalid_grant 清空", async () => {
    const profile = await testProfile();
    await secrets.setRefreshToken(REFRESH_TOKEN_SENTINEL);
    const requests: CapturedRequest[] = [];
    const firstResponse = deferredResponse();
    const secondResponse = deferredResponse();
    const deferred = [firstResponse, secondResponse];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = captureRequest(input, init);
      requests.push(request);
      const response = deferred[requests.length - 1];
      if (!response) {
        throw new Error(`离线 IDaaS probe 未声明 ${new URL(request.url).pathname} 的并发响应`);
      }
      return response.promise;
    }) as typeof globalThis.fetch;
    const client = new IdaasClient(profile, secrets, { fetch });

    const successfulRefresh = client.getAccessToken(true);
    const staleRefreshFailure = captureSafeError(client.getAccessToken(true));
    await waitForRequestCount(requests, 2);

    firstResponse.resolve(Response.json({
      access_token: ACCESS_TOKEN_SENTINEL,
      refresh_token: ROTATED_REFRESH_TOKEN_SENTINEL,
      expires_in: 3600,
    }));
    const accessToken = await successfulRefresh;
    const rotationWasStored = (await secrets.get()).refreshToken === ROTATED_REFRESH_TOKEN_SENTINEL;

    secondResponse.resolve(Response.json({ error: "invalid_grant" }, { status: 400 }));
    const failure = await staleRefreshFailure;

    // 两个请求都携带旧 token；此断言只记录竞态，不认可“后返回错误覆盖新状态”的语义。
    expect({
      accessToken: redactSecret(accessToken),
      rotationWasStored,
      staleFailureWasTerminal: failure.terminal,
      finalRefreshState: (await secrets.get()).refreshToken === undefined ? "cleared" : "present",
      requests: requests.map(requestSnapshot),
    }).toEqual({
      accessToken: "<access-token>",
      rotationWasStored: true,
      staleFailureWasTerminal: true,
      finalRefreshState: "cleared",
      requests: [
        {
          method: "POST",
          path: "/api/token",
          query: "",
          contentType: "application/x-www-form-urlencoded",
          fields: [
            ["client_id", profile.oauth.clientId],
            ["grant_type", "refresh_token"],
            ["refresh_token", "<refresh-token>"],
          ],
        },
        {
          method: "POST",
          path: "/api/token",
          query: "",
          contentType: "application/x-www-form-urlencoded",
          fields: [
            ["client_id", profile.oauth.clientId],
            ["grant_type", "refresh_token"],
            ["refresh_token", "<refresh-token>"],
          ],
        },
      ],
    });
  });
});
