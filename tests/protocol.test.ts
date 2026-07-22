import { describe, expect, test } from "bun:test";
import {
  buildAckEnvelope,
  buildConnectEnvelope,
  buildResultEnvelope,
  parseIncomingRelayJob,
  parseRelayEnvelope,
  RELAY_IDENTIFIER_MAX_BYTES,
  RELAY_MESSAGE_TYPE_MAX_BYTES,
  RELAY_NODE_TYPE_MAX_BYTES,
  resultAckCandidates,
  serializeResult,
} from "../src/protocol/livis.ts";
import { testProfile } from "./helpers.ts";

describe("LiViS wire protocol", () => {
  test("解析对象和 JSON 字符串业务体", () => {
    const base = {
      type: "send_message",
      metadata: { job_id: "job-1", msg_id: "msg-1", timestamp: 123 },
      payload: { from_node_id: "node-1", data: { type: "exec", content: "你好" } },
    };
    expect(parseIncomingRelayJob(base, 100).text).toBe("你好");
    const stringData = {
      ...base,
      payload: { ...base.payload, data: JSON.stringify(base.payload.data) },
    };
    expect(parseIncomingRelayJob(stringData, 100).jobId).toBe("job-1");
  });

  test("严格拒绝缺 job_id、未知 type 和超长输入", () => {
    const envelope = {
      type: "send_message",
      metadata: {},
      payload: { from_node_id: "node-1", data: { type: "exec", content: "hello" } },
    };
    expect(() => parseIncomingRelayJob(envelope, 100)).toThrow("job_id");
    expect(() => parseIncomingRelayJob({
      ...envelope,
      metadata: { job_id: "job" },
      payload: { ...envelope.payload, data: { type: "notify", content: "hello" } },
    }, 100)).toThrow("不支持");
    expect(() => parseIncomingRelayJob({ ...envelope, metadata: { job_id: "job" } }, 2)).toThrow("超过上限");
  });

  test("构造 connect、ACK 和 final-only 结果", async () => {
    const profile = await testProfile();
    const connect = buildConnectEnvelope({
      profile,
      agentId: "test-agent-id",
      deviceId: "pc-device",
      nodeName: "电脑",
      accessToken: "access",
      refreshToken: "refresh",
    });
    expect(connect.payload?.client).toBe(profile.wireIdentity.client);
    expect(connect.payload?.node_desc).toContain("personal-device");
    const ack = buildAckEnvelope(profile, "ack_send_message", "job", "agent", "device");
    expect(ack.metadata?.job_id).toBe("job");
    expect(ack.payload?.nodeType).toBe("personal-device");
    const resultJson = serializeResult("完成");
    const result = buildResultEnvelope({ profile, jobId: "job", agentId: "agent", deviceId: "device", resultJson });
    expect(result.payload?.data).toBe(resultJson);
    expect(typeof result.payload?.data).toBe("string");
  });

  test("按官方优先级给出结果 ACK 候选 ID", () => {
    expect(resultAckCandidates({
      type: "ack_send_result",
      metadata: { job_id: "metadata-job" },
      payload: { ref_msg_id: "payload-ref" },
    })).toEqual(["payload-ref", "metadata-job"]);
    expect(resultAckCandidates({ type: "ack_send_result", metadata: { msg_id: "message-id" } }))
      .toEqual(["message-id"]);
    expect(resultAckCandidates({
      type: "ack_send_result",
      metadata: { job_id: "same" },
      payload: { ref_msg_id: "same" },
    })).toEqual(["same"]);
    expect(resultAckCandidates({ type: "ack_send_result" })).toEqual([]);
  });

  test("拒绝非对象 envelope", () => {
    expect(() => parseRelayEnvelope("[]")).toThrow("JSON 对象");
    expect(() => parseRelayEnvelope('{"payload":{}}')).toThrow("message.type");
  });

  test("按 UTF-8 字节限制外部 type、job/msg/node 与 ACK 标识", () => {
    expect(parseRelayEnvelope(JSON.stringify({
      type: "t".repeat(RELAY_MESSAGE_TYPE_MAX_BYTES),
    })).type).toHaveLength(RELAY_MESSAGE_TYPE_MAX_BYTES);

    const oversizedType = `sentinel-${"t".repeat(RELAY_MESSAGE_TYPE_MAX_BYTES)}`;
    expect(() => parseRelayEnvelope(JSON.stringify({ type: oversizedType }))).toThrow("字节上限");
    try {
      parseRelayEnvelope(JSON.stringify({ type: oversizedType }));
    } catch (error) {
      expect((error as Error).message).not.toContain("sentinel");
    }

    for (const envelope of [
      { type: "cancel_chat", metadata: { job_id: "j".repeat(RELAY_IDENTIFIER_MAX_BYTES + 1) } },
      { type: "ack_send_result", metadata: { msg_id: "m".repeat(RELAY_IDENTIFIER_MAX_BYTES + 1) } },
      { type: "ack_send_result", payload: { ref_msg_id: "r".repeat(RELAY_IDENTIFIER_MAX_BYTES + 1) } },
      { type: "send_message", payload: { from_node_id: "节".repeat(86) } },
      { type: "send_message", payload: { from_node_type: "n".repeat(RELAY_NODE_TYPE_MAX_BYTES + 1) } },
    ]) {
      expect(() => parseRelayEnvelope(JSON.stringify(envelope))).toThrow("字节上限");
    }
  });

  test("直接解析 job 也不会绕过标识边界或在错误中回显业务 type", () => {
    const oversizedJob = {
      type: "send_message",
      metadata: { job_id: "j".repeat(RELAY_IDENTIFIER_MAX_BYTES + 1) },
      payload: { from_node_id: "node", data: { type: "exec", content: "hello" } },
    };
    expect(() => parseIncomingRelayJob(oversizedJob, 100)).toThrow("字节上限");

    const externalType = `sentinel-${"x".repeat(RELAY_MESSAGE_TYPE_MAX_BYTES)}`;
    try {
      parseIncomingRelayJob({
        ...oversizedJob,
        metadata: { job_id: "job" },
        payload: { from_node_id: "node", data: { type: externalType, content: "hello" } },
      }, 100);
      throw new Error("expected parseIncomingRelayJob to reject");
    } catch (error) {
      expect((error as Error).message).toContain("字节上限");
      expect((error as Error).message).not.toContain("sentinel");
    }
  });
});
