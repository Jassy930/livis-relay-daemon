import type { DeviceCodeResponse, OAuthTokenSet } from "../types.ts";
import type { ProtocolProfile } from "../protocol/profile.ts";
import type { SecretStore } from "../secrets.ts";
import { delay } from "../util.ts";

export class TerminalAuthError extends Error {}

interface IdaasClientOptions {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function formBody(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

async function responseJson(response: Response, label: string): Promise<Record<string, unknown>> {
  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    throw new Error(`${label} 返回了非 JSON 响应`, { cause: error });
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${label} 返回 JSON 格式无效`);
  }
  return data as Record<string, unknown>;
}

function tokenSetFromResponse(data: Record<string, unknown>, audience: string): OAuthTokenSet {
  const nested = data[audience];
  const tokenData = nested !== null && typeof nested === "object" && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : data;
  if (typeof tokenData.access_token !== "string" || tokenData.access_token === "") {
    throw new Error("IDaaS 响应缺少 access_token");
  }
  const expiresIn = typeof tokenData.expires_in === "number"
    ? tokenData.expires_in
    : typeof data.expires_in === "number"
      ? data.expires_in
      : 3600;
  return {
    accessToken: tokenData.access_token,
    ...(typeof tokenData.refresh_token === "string" ? { refreshToken: tokenData.refresh_token } : {}),
    expiresIn,
    tokenType: typeof tokenData.token_type === "string"
      ? tokenData.token_type
      : typeof data.token_type === "string"
        ? data.token_type
        : "Bearer",
    ...(typeof data.id_token === "string"
      ? { idToken: data.id_token }
      : typeof tokenData.id_token === "string"
        ? { idToken: tokenData.id_token }
        : {}),
  };
}

export class IdaasClient {
  private readonly fetchImplementation: typeof fetch;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(
    private readonly profile: ProtocolProfile,
    private readonly secrets: SecretStore,
    options: IdaasClientOptions = {},
  ) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.sleep = options.sleep ?? delay;
  }

  async requestDeviceCode(force = false): Promise<DeviceCodeResponse> {
    const values: Record<string, string> = {
      client_id: this.profile.oauth.clientId,
      scope: `${this.profile.oauth.scope} offline_access`,
      audience: this.profile.oauth.audience,
      offline_access: "true",
    };
    if (force) {
      values.prompt = "login";
    }
    const response = await this.postForm("/aux", values);
    const data = await responseJson(response, "IDaaS /aux");
    if (!response.ok) {
      throw new Error(`申请设备码失败：HTTP ${response.status}`);
    }
    const required: Array<keyof DeviceCodeResponse> = [
      "device_code",
      "verification_uri_complete",
      "expires_in",
      "interval",
    ];
    for (const key of required) {
      if (data[key] === undefined) {
        throw new Error(`IDaaS /aux 缺少 ${key}`);
      }
    }
    return data as unknown as DeviceCodeResponse;
  }

  async pollForToken(
    deviceCode: DeviceCodeResponse,
    options: { signal?: AbortSignal; onPending?: () => void } = {},
  ): Promise<OAuthTokenSet> {
    const expiresAt = Date.now() + deviceCode.expires_in * 1000;
    let intervalMs = Math.max(1000, deviceCode.interval * 1000);
    while (Date.now() < expiresAt) {
      await this.sleep(intervalMs, options.signal);
      const response = await this.postForm("/token", {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode.device_code,
        client_id: this.profile.oauth.clientId,
      });
      const data = await responseJson(response, "IDaaS /token");
      if (response.ok) {
        const tokenSet = tokenSetFromResponse(data, this.profile.oauth.audience);
        await this.acceptTokenSet(tokenSet);
        return tokenSet;
      }
      const oauthError = typeof data.error === "string" ? data.error : `http_${response.status}`;
      // LiViS IDaaS currently returns HTTP 428 for authorization_pending,
      // although RFC 8628 examples commonly use HTTP 400. The OAuth error
      // value is authoritative; coupling polling semantics to one status code
      // makes a normal pending response terminate the Device Flow.
      if (oauthError === "authorization_pending") {
        options.onPending?.();
        continue;
      }
      if (oauthError === "slow_down") {
        intervalMs += 5000;
        continue;
      }
      if (oauthError === "expired_token") {
        throw new TerminalAuthError("设备码已过期");
      }
      if (oauthError === "access_denied") {
        throw new TerminalAuthError("用户拒绝了授权");
      }
      throw new Error(`设备授权失败：${oauthError}（HTTP ${response.status}）`);
    }
    throw new TerminalAuthError("设备授权等待超时");
  }

  async getAccessToken(force = false): Promise<string> {
    if (!force && this.accessToken && Date.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
    }
    const currentSecrets = await this.secrets.get();
    if (!currentSecrets.refreshToken) {
      throw new TerminalAuthError("缺少 refresh token，请先执行 login");
    }
    const response = await this.postForm("/token", {
      grant_type: "refresh_token",
      refresh_token: currentSecrets.refreshToken,
      client_id: this.profile.oauth.clientId,
    });
    const data = await responseJson(response, "IDaaS refresh /token");
    // refresh token 失效的信号以 OAuth error 值为准（invalid_grant 常见于
    // HTTP 400），只认 401 会让 daemon 拿着死 token 无限重连而不提示重新登录。
    const oauthError = typeof data.error === "string" ? data.error : null;
    if (response.status === 401 || oauthError === "invalid_grant") {
      await this.secrets.clearRefreshToken();
      this.accessToken = null;
      throw new TerminalAuthError("refresh token 已失效，请重新登录");
    }
    if (!response.ok) {
      throw new Error(`刷新 access token 失败：${oauthError ?? `HTTP ${response.status}`}`);
    }
    const tokenSet = tokenSetFromResponse(data, this.profile.oauth.audience);
    await this.acceptTokenSet(tokenSet, currentSecrets.refreshToken);
    return tokenSet.accessToken;
  }

  async revoke(): Promise<void> {
    const currentSecrets = await this.secrets.get();
    if (currentSecrets.refreshToken) {
      let response: Response;
      try {
        response = await this.postForm("/revoke", {
          token: currentSecrets.refreshToken,
          token_type_hint: "refresh_token",
          client_id: this.profile.oauth.clientId,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`撤销 refresh token 失败：${detail}；本地 refresh token 已保留`, { cause: error });
      }
      if (!response.ok) {
        throw new Error(`撤销 refresh token 失败：HTTP ${response.status}；本地 refresh token 已保留`);
      }
    }
    await this.secrets.clearRefreshToken();
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
  }

  private async acceptTokenSet(tokenSet: OAuthTokenSet, fallbackRefreshToken?: string): Promise<void> {
    const refreshToken = tokenSet.refreshToken ?? fallbackRefreshToken;
    if (refreshToken) {
      await this.secrets.setRefreshToken(refreshToken);
    }
    this.accessToken = tokenSet.accessToken;
    this.accessTokenExpiresAt = Date.now() + Math.max(30, tokenSet.expiresIn - 60) * 1000;
  }

  private postForm(path: string, values: Record<string, string>): Promise<Response> {
    return this.fetchImplementation(`${this.profile.endpoints.idaasBaseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody(values),
    });
  }
}
