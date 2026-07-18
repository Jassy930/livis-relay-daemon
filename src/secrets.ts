import { stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivate, generateSecret, parseJsonObject } from "./util.ts";

export interface RelaySecrets {
  schemaVersion: 1;
  connectorToken: string;
  refreshToken?: string;
}

export class SecretStore {
  readonly path: string;
  private secrets: RelaySecrets | null = null;

  constructor(stateDir: string) {
    this.path = join(stateDir, "secrets.json");
  }

  async initialize(): Promise<RelaySecrets> {
    if (await Bun.file(this.path).exists()) {
      return this.load();
    }
    const secrets: RelaySecrets = {
      schemaVersion: 1,
      connectorToken: generateSecret(),
    };
    await this.save(secrets);
    return secrets;
  }

  async load(): Promise<RelaySecrets> {
    const root = parseJsonObject(await Bun.file(this.path).text(), this.path);
    if (root.schemaVersion !== 1 || typeof root.connectorToken !== "string" || root.connectorToken.length < 32) {
      throw new Error("secrets.json 格式无效或 connector token 过短");
    }
    if (root.refreshToken !== undefined && typeof root.refreshToken !== "string") {
      throw new Error("secrets.json refreshToken 格式无效");
    }
    const mode = (await stat(this.path)).mode & 0o777;
    if (mode & 0o077) {
      throw new Error(`secrets.json 权限过宽：${mode.toString(8)}，必须是 0600`);
    }
    this.secrets = {
      schemaVersion: 1,
      connectorToken: root.connectorToken,
      ...(root.refreshToken ? { refreshToken: root.refreshToken } : {}),
    };
    return this.secrets;
  }

  async get(): Promise<RelaySecrets> {
    return this.secrets ?? this.load();
  }

  async setRefreshToken(refreshToken: string | undefined): Promise<void> {
    const current = await this.get();
    const next: RelaySecrets = {
      schemaVersion: 1,
      connectorToken: current.connectorToken,
      ...(refreshToken ? { refreshToken } : {}),
    };
    await this.save(next);
  }

  async clearRefreshToken(): Promise<void> {
    await this.setRefreshToken(undefined);
  }

  private async save(secrets: RelaySecrets): Promise<void> {
    await atomicWritePrivate(this.path, `${JSON.stringify(secrets, null, 2)}\n`);
    this.secrets = secrets;
  }
}
