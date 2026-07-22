import type { IncomingRelayJob, RelayEnvelope } from "../types.ts";
import type { ProtocolProfile } from "./profile.ts";
import { parseJsonObject } from "../util.ts";

export const RELAY_MESSAGE_TYPE_MAX_BYTES = 64;
export const RELAY_IDENTIFIER_MAX_BYTES = 256;
export const RELAY_NODE_TYPE_MAX_BYTES = 64;

function stringBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function requireBoundedString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string") {
    throw new Error(`${label} 缺失`);
  }
  const actualBytes = stringBytes(value);
  if (actualBytes > maxBytes) {
    throw new Error(`${label} 超过字节上限：${actualBytes} > ${maxBytes}`);
  }
  if (value.trim() === "") {
    throw new Error(`${label} 缺失`);
  }
  return value;
}

function assertOptionalBoundedString(value: unknown, label: string, maxBytes: number): void {
  if (typeof value !== "string") return;
  const actualBytes = stringBytes(value);
  if (actualBytes > maxBytes) {
    throw new Error(`${label} 超过字节上限：${actualBytes} > ${maxBytes}`);
  }
}

function metadata(jobId: string, agentId: string, deviceId: string) {
  return {
    msg_id: crypto.randomUUID(),
    job_id: jobId,
    agent_id: agentId,
    device_id: deviceId,
    timestamp: Date.now(),
  };
}

export function parseRelayEnvelope(raw: string): RelayEnvelope {
  const parsed = parseJsonObject(raw, "LiViS WebSocket message");
  requireBoundedString(parsed.type, "LiViS message.type", RELAY_MESSAGE_TYPE_MAX_BYTES);
  if (parsed.metadata !== undefined && (parsed.metadata === null || typeof parsed.metadata !== "object" || Array.isArray(parsed.metadata))) {
    throw new Error("LiViS message.metadata 格式无效");
  }
  if (parsed.payload !== undefined && (parsed.payload === null || typeof parsed.payload !== "object" || Array.isArray(parsed.payload))) {
    throw new Error("LiViS message.payload 格式无效");
  }
  const metadata = parsed.metadata as Record<string, unknown> | undefined;
  const payload = parsed.payload as Record<string, unknown> | undefined;
  for (const [value, label] of [
    [metadata?.job_id, "LiViS metadata.job_id"],
    [metadata?.msg_id, "LiViS metadata.msg_id"],
    [metadata?.agent_id, "LiViS metadata.agent_id"],
    [metadata?.device_id, "LiViS metadata.device_id"],
    [payload?.ref_msg_id, "LiViS payload.ref_msg_id"],
    [payload?.from_node_id, "LiViS payload.from_node_id"],
  ] as const) {
    assertOptionalBoundedString(value, label, RELAY_IDENTIFIER_MAX_BYTES);
  }
  for (const [value, label] of [
    [payload?.from_node_type, "LiViS payload.from_node_type"],
    [payload?.nodeType, "LiViS payload.nodeType"],
  ] as const) {
    assertOptionalBoundedString(value, label, RELAY_NODE_TYPE_MAX_BYTES);
  }
  return parsed as RelayEnvelope;
}

export function parseIncomingRelayJob(envelope: RelayEnvelope, maxInputChars: number): IncomingRelayJob {
  if (envelope.type !== "send_message") {
    throw new Error("LiViS message 不是 send_message");
  }
  const jobId = requireBoundedString(
    envelope.metadata?.job_id,
    "send_message.metadata.job_id",
    RELAY_IDENTIFIER_MAX_BYTES,
  );
  const messageId = typeof envelope.metadata?.msg_id === "string" ? envelope.metadata.msg_id : "";
  assertOptionalBoundedString(messageId, "send_message.metadata.msg_id", RELAY_IDENTIFIER_MAX_BYTES);
  const payload = envelope.payload ?? {};
  const fromNodeId = requireBoundedString(
    payload.from_node_id,
    "send_message.payload.from_node_id",
    RELAY_IDENTIFIER_MAX_BYTES,
  );
  const fromNodeType = typeof payload.from_node_type === "string" ? payload.from_node_type : null;
  assertOptionalBoundedString(
    fromNodeType,
    "send_message.payload.from_node_type",
    RELAY_NODE_TYPE_MAX_BYTES,
  );
  const rawData = payload.data;
  let data: Record<string, unknown>;
  if (typeof rawData === "string") {
    data = parseJsonObject(rawData, "send_message.payload.data");
  } else if (rawData !== null && typeof rawData === "object" && !Array.isArray(rawData)) {
    data = rawData as Record<string, unknown>;
  } else {
    throw new Error("send_message.payload.data 格式无效");
  }
  assertOptionalBoundedString(
    data.type,
    "send_message.payload.data.type",
    RELAY_MESSAGE_TYPE_MAX_BYTES,
  );
  if (data.type !== "exec") {
    // 保留现有 S2 probe 的可观察诊断文本；字符串 type 已先限制为 64 字节，
    // 非字符串值最终还会经过全局 1024 字节日志门禁。
    throw new Error(`不支持的 LiViS 业务消息类型：${String(data.type)}`);
  }
  if (typeof data.content !== "string" || data.content.trim() === "") {
    throw new Error("send_message.payload.data.content 不能为空");
  }
  if (data.content.length > maxInputChars) {
    throw new Error(`输入超过上限：${data.content.length} > ${maxInputChars}`);
  }
  return {
    jobId,
    messageId,
    fromNodeId,
    fromNodeType,
    text: data.content,
    timestamp: typeof envelope.metadata?.timestamp === "number" ? envelope.metadata.timestamp : Date.now(),
    rawPayload: JSON.stringify(envelope),
  };
}

export function buildConnectEnvelope(input: {
  profile: ProtocolProfile;
  agentId: string;
  deviceId: string;
  nodeName: string;
  accessToken: string;
  refreshToken: string;
}): RelayEnvelope {
  const { profile, agentId, deviceId, nodeName, accessToken, refreshToken } = input;
  return {
    type: "connect",
    metadata: {
      msg_id: crypto.randomUUID(),
      job_id: crypto.randomUUID(),
      agent_id: agentId,
      timestamp: Date.now(),
    },
    payload: {
      device_id: deviceId,
      node_name: nodeName,
      node_desc: `${profile.wireIdentity.nodeType} ${nodeName}`,
      client: profile.wireIdentity.client,
      token: accessToken,
      refresh_token: refreshToken,
    },
  };
}

function withWireIdentity(profile: ProtocolProfile, envelope: RelayEnvelope): RelayEnvelope {
  return {
    ...envelope,
    metadata: {
      ...(envelope.metadata ?? {}),
      client: envelope.metadata?.client ?? profile.wireIdentity.client,
    },
    payload: {
      ...(envelope.payload ?? {}),
      nodeType: profile.wireIdentity.nodeType,
    },
  };
}

export function buildHeartbeatEnvelope(
  profile: ProtocolProfile,
  agentId: string,
  deviceId: string,
): RelayEnvelope {
  return withWireIdentity(profile, {
    type: "heartbeat",
    metadata: metadata(crypto.randomUUID(), agentId, deviceId),
    payload: {},
  });
}

export function buildAckEnvelope(
  profile: ProtocolProfile,
  type: "ack_send_message" | "ack_cancel_chat",
  jobId: string,
  agentId: string,
  deviceId: string,
): RelayEnvelope {
  return withWireIdentity(profile, {
    type,
    metadata: metadata(jobId, agentId, deviceId),
    payload: {},
  });
}

export function buildResultEnvelope(input: {
  profile: ProtocolProfile;
  jobId: string;
  agentId: string;
  deviceId: string;
  resultJson: string;
  messageId?: string;
}): RelayEnvelope {
  const { profile, jobId, agentId, deviceId, resultJson } = input;
  const envelope = withWireIdentity(profile, {
    type: "send_result",
    metadata: metadata(jobId, agentId, deviceId),
    payload: { data: resultJson },
  });
  if (input.messageId) {
    envelope.metadata = { ...envelope.metadata, msg_id: input.messageId };
  }
  return envelope;
}

export function buildTokenRefreshEnvelope(input: {
  profile: ProtocolProfile;
  agentId: string;
  deviceId: string;
  accessToken: string;
  refreshToken: string;
}): RelayEnvelope {
  return withWireIdentity(input.profile, {
    type: "token_refresh",
    metadata: metadata("", input.agentId, input.deviceId),
    payload: {
      token: input.accessToken,
      refresh_token: input.refreshToken,
    },
  });
}

// ref_msg_id 可能引用 send_result 的 msg_id（每次投递随机），也可能直接是
// job_id；这里只按官方优先级给出候选，由调用方对照 outbox 解析成真实 job_id。
export function resultAckCandidates(envelope: RelayEnvelope): string[] {
  const candidates: string[] = [];
  for (const value of [envelope.payload?.ref_msg_id, envelope.metadata?.job_id, envelope.metadata?.msg_id]) {
    assertOptionalBoundedString(value, "ack_send_result 关联 ID", RELAY_IDENTIFIER_MAX_BYTES);
    if (typeof value === "string" && value !== "" && !candidates.includes(value)) {
      candidates.push(value);
    }
  }
  return candidates;
}

export function serializeResult(text: string): string {
  return JSON.stringify({ text });
}
