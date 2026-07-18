import type { IncomingRelayJob, RelayEnvelope } from "../types.ts";
import type { ProtocolProfile } from "./profile.ts";
import { parseJsonObject } from "../util.ts";

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
  if (typeof parsed.type !== "string" || parsed.type.trim() === "") {
    throw new Error("LiViS message.type 缺失");
  }
  if (parsed.metadata !== undefined && (parsed.metadata === null || typeof parsed.metadata !== "object" || Array.isArray(parsed.metadata))) {
    throw new Error("LiViS message.metadata 格式无效");
  }
  if (parsed.payload !== undefined && (parsed.payload === null || typeof parsed.payload !== "object" || Array.isArray(parsed.payload))) {
    throw new Error("LiViS message.payload 格式无效");
  }
  return parsed as RelayEnvelope;
}

export function parseIncomingRelayJob(envelope: RelayEnvelope, maxInputChars: number): IncomingRelayJob {
  if (envelope.type !== "send_message") {
    throw new Error(`不是 send_message：${envelope.type}`);
  }
  const jobId = envelope.metadata?.job_id;
  if (typeof jobId !== "string" || jobId.trim() === "") {
    throw new Error("send_message.metadata.job_id 缺失");
  }
  const messageId = typeof envelope.metadata?.msg_id === "string" ? envelope.metadata.msg_id : "";
  const payload = envelope.payload ?? {};
  const fromNodeId = payload.from_node_id;
  if (typeof fromNodeId !== "string" || fromNodeId.trim() === "") {
    throw new Error("send_message.payload.from_node_id 缺失");
  }
  const rawData = payload.data;
  let data: Record<string, unknown>;
  if (typeof rawData === "string") {
    data = parseJsonObject(rawData, "send_message.payload.data");
  } else if (rawData !== null && typeof rawData === "object" && !Array.isArray(rawData)) {
    data = rawData as Record<string, unknown>;
  } else {
    throw new Error("send_message.payload.data 格式无效");
  }
  if (data.type !== "exec") {
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
    fromNodeType: typeof payload.from_node_type === "string" ? payload.from_node_type : null,
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

export function resultAckJobId(envelope: RelayEnvelope): string | null {
  const reference = envelope.payload?.ref_msg_id;
  if (typeof reference === "string" && reference !== "") {
    return reference;
  }
  const jobId = envelope.metadata?.job_id;
  if (typeof jobId === "string" && jobId !== "") {
    return jobId;
  }
  const messageId = envelope.metadata?.msg_id;
  return typeof messageId === "string" && messageId !== "" ? messageId : null;
}

export function serializeResult(text: string): string {
  return JSON.stringify({ text });
}
