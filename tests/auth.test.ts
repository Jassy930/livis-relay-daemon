import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IdaasClient, TerminalAuthError } from "../src/auth/idaas.ts";
import { SecretStore } from "../src/secrets.ts";
import { temporaryDirectory, testProfile } from "./helpers.ts";

function queuedFetch(responses: Response[], requests: Array<{ url: string; init?: RequestInit }>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    const response = responses.shift();
    if (!response) throw new Error("unexpected fetch");
    return response;
  }) as typeof fetch;
}

describe("IDaaS OAuth Device Flow", () => {
  let directory: Awaited<ReturnType<typeof temporaryDirectory>>;
  let secrets: SecretStore;

  beforeEach(async () => {
    directory = await temporaryDirectory();
    secrets = new SecretStore(directory.path);
    await secrets.initialize();
  });

  afterEach(async () => {
    await directory.cleanup();
  });

  test("设备码、pending、audience 嵌套 token 与 refresh rotation", async () => {
    const profile = await testProfile();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = queuedFetch([
      Response.json({
        device_code: "device-code",
        verification_uri_complete: "https://example.test/login",
        expires_in: 60,
        interval: 1,
      }),
      // Preserve the RFC-style 400 path and the HTTP 428 behavior observed
      // from LiViS IDaaS; the OAuth error value is authoritative in both cases.
      Response.json({ error: "authorization_pending" }, { status: 400 }),
      Response.json({ error: "authorization_pending" }, { status: 428 }),
      Response.json({
        [profile.oauth.audience]: {
          access_token: "access",
          refresh_token: "refresh-1",
          expires_in: 3600,
          token_type: "Bearer",
        },
      }),
      Response.json({
        [profile.oauth.audience]: {
          access_token: "access-2",
          refresh_token: "refresh-2",
          expires_in: 3600,
        },
      }),
    ], requests);
    const client = new IdaasClient(profile, secrets, { fetch, sleep: async () => undefined });
    const code = await client.requestDeviceCode();
    let pending = 0;
    const token = await client.pollForToken(code, { onPending: () => pending += 1 });
    expect(token.accessToken).toBe("access");
    expect(pending).toBe(2);
    expect((await secrets.get()).refreshToken).toBe("refresh-1");
    expect(await client.getAccessToken(true)).toBe("access-2");
    expect((await secrets.get()).refreshToken).toBe("refresh-2");
    const auxBody = String(requests[0]?.init?.body);
    expect(auxBody).toContain(`scope=${profile.oauth.scope}+offline_access`);
    expect(auxBody).toContain(`audience=${profile.oauth.audience}`);
  });

  test("slow_down 不依赖特定 HTTP 状态并增加后续轮询间隔", async () => {
    const profile = await testProfile();
    const sleeps: number[] = [];
    const client = new IdaasClient(profile, secrets, {
      fetch: queuedFetch([
        Response.json({ error: "slow_down" }, { status: 429 }),
        Response.json({
          [profile.oauth.audience]: {
            access_token: "access",
            refresh_token: "refresh",
            expires_in: 3600,
          },
        }),
      ], []),
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    });
    const token = await client.pollForToken({
      device_code: "device-code",
      verification_uri_complete: "https://example.test/login",
      expires_in: 60,
      interval: 1,
    });
    expect(token.accessToken).toBe("access");
    expect(sleeps).toEqual([1000, 6000]);
  });

  test("refresh 401 删除本地 refresh token", async () => {
    const profile = await testProfile();
    await secrets.setRefreshToken("expired");
    const client = new IdaasClient(profile, secrets, {
      fetch: queuedFetch([Response.json({ error: "invalid_token" }, { status: 401 })], []),
    });
    await expect(client.getAccessToken(true)).rejects.toBeInstanceOf(TerminalAuthError);
    expect((await secrets.get()).refreshToken).toBeUndefined();
  });

  test("refresh 400 invalid_grant 同样删除本地 refresh token", async () => {
    const profile = await testProfile();
    await secrets.setRefreshToken("revoked");
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = new IdaasClient(profile, secrets, {
      fetch: queuedFetch([Response.json({ error: "invalid_grant" }, { status: 400 })], requests),
    });
    await expect(client.getAccessToken(true)).rejects.toBeInstanceOf(TerminalAuthError);
    expect((await secrets.get()).refreshToken).toBeUndefined();
    expect(String(requests[0]?.init?.body)).toContain(`client_id=${profile.oauth.clientId}`);
  });

  test("revoke 只有远端确认成功后才清除本地 refresh token", async () => {
    const profile = await testProfile();
    await secrets.setRefreshToken("refresh-to-revoke");
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = new IdaasClient(profile, secrets, {
      fetch: queuedFetch([new Response(null, { status: 204 })], requests),
    });

    await client.revoke();

    expect((await secrets.get()).refreshToken).toBeUndefined();
    expect(requests[0]?.url).toEndWith("/revoke");
    const body = String(requests[0]?.init?.body);
    expect(body).toContain("token=refresh-to-revoke");
    expect(body).toContain("token_type_hint=refresh_token");
    expect(body).toContain(`client_id=${profile.oauth.clientId}`);
  });

  test("revoke 非 2xx 时保留磁盘 refresh token 和缓存 access token", async () => {
    const profile = await testProfile();
    await secrets.setRefreshToken("recoverable-refresh");
    const client = new IdaasClient(profile, secrets, {
      fetch: queuedFetch([
        Response.json({
          [profile.oauth.audience]: {
            access_token: "cached-access",
            expires_in: 3600,
          },
        }),
        Response.json({ error: "temporarily_unavailable" }, { status: 503 }),
      ], []),
    });
    expect(await client.getAccessToken(true)).toBe("cached-access");

    await expect(client.revoke()).rejects.toThrow("HTTP 503");

    expect((await secrets.get()).refreshToken).toBe("recoverable-refresh");
    expect((await new SecretStore(directory.path).load()).refreshToken).toBe("recoverable-refresh");
    expect(await client.getAccessToken()).toBe("cached-access");
  });

  test("revoke 网络失败时保留本地 refresh token", async () => {
    const profile = await testProfile();
    await secrets.setRefreshToken("recoverable-refresh");
    const client = new IdaasClient(profile, secrets, {
      fetch: (async () => {
        throw new Error("network unavailable");
      }) as unknown as typeof fetch,
    });

    await expect(client.revoke()).rejects.toThrow("network unavailable");

    expect((await secrets.get()).refreshToken).toBe("recoverable-refresh");
    expect((await new SecretStore(directory.path).load()).refreshToken).toBe("recoverable-refresh");
  });
});
