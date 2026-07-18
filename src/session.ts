import type { RelayIdentity } from "./identity.ts";
import { sha256 } from "./util.ts";

/**
 * 为 Hermes 构造不暴露原始身份值的稳定会话键。
 *
 * account、agent 和来源节点分别哈希并带显式标签，避免分隔符碰撞；固定长度的
 * node 段确保不同 LiViS 节点不会共享 Hermes DM 历史或 session quarantine。
 */
export function buildHermesSessionKey(identity: RelayIdentity, fromNodeId: string): string {
  return [
    "livis",
    "account",
    sha256(identity.accountId),
    "agent",
    sha256(identity.agentId),
    "node",
    sha256(fromNodeId),
  ].join(":");
}
