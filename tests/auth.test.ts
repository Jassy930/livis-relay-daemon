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
      Response.json({ error: "authorization_pending" }, { status: 400 }),
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
    expect(pending).toBe(1);
    expect((await secrets.get()).refreshToken).toBe("refresh-1");
    expect(await client.getAccessToken(true)).toBe("access-2");
    expect((await secrets.get()).refreshToken).toBe("refresh-2");
    const auxBody = String(requests[0]?.init?.body);
    expect(auxBody).toContain(`scope=${profile.oauth.scope}+offline_access`);
    expect(auxBody).toContain(`audience=${profile.oauth.audience}`);
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
});
