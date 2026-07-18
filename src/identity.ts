import { join } from "node:path";
import type { ProtocolProfile } from "./protocol/profile.ts";
import { atomicWritePrivate, parseJsonObject } from "./util.ts";

export interface RelayIdentity {
  schemaVersion: 1;
  accountId: string;
  agentId: string;
  deviceId: string;
  createdAt: string;
}

export class IdentityStore {
  readonly path: string;

  constructor(
    stateDir: string,
    private readonly profile: ProtocolProfile,
  ) {
    this.path = join(stateDir, "identity.json");
  }

  async initialize(): Promise<RelayIdentity> {
    if (await Bun.file(this.path).exists()) {
      return this.load();
    }
    const identity: RelayIdentity = {
      schemaVersion: 1,
      accountId: "idaas-default",
      agentId: `${this.profile.wireIdentity.agentIdPrefix}${crypto.randomUUID()}`,
      deviceId: `${this.profile.wireIdentity.deviceIdPrefix}${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
    };
    await atomicWritePrivate(this.path, `${JSON.stringify(identity, null, 2)}\n`);
    return identity;
  }

  async load(): Promise<RelayIdentity> {
    const root = parseJsonObject(await Bun.file(this.path).text(), this.path);
    if (
      root.schemaVersion !== 1 ||
      typeof root.accountId !== "string" ||
      typeof root.agentId !== "string" ||
      typeof root.deviceId !== "string" ||
      typeof root.createdAt !== "string"
    ) {
      throw new Error("identity.json 格式无效");
    }
    if (!root.agentId.startsWith(this.profile.wireIdentity.agentIdPrefix)) {
      throw new Error("identity.json agentId 与当前 profile 前缀不兼容");
    }
    if (!root.deviceId.startsWith(this.profile.wireIdentity.deviceIdPrefix)) {
      throw new Error("identity.json deviceId 与当前 profile 前缀不兼容");
    }
    return root as unknown as RelayIdentity;
  }

  static scopeKey(identity: RelayIdentity): string {
    return `${identity.accountId}:${identity.agentId}`;
  }
}
