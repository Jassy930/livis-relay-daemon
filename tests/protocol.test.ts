import { describe, expect, test } from "bun:test";
import {
  buildAckEnvelope,
  buildConnectEnvelope,
  buildResultEnvelope,
  buildTokenRefreshEnvelope,
  parseIncomingRelayJob,
  parseRelayEnvelope,
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
    });
    expect(connect.payload?.client).toBe(profile.wireIdentity.client);
    expect(connect.payload?.node_desc).toContain("personal-device");
    expect(connect.payload?.token).toBe("access");
    expect(connect.payload).not.toHaveProperty("refresh_token");
    const tokenRefresh = buildTokenRefreshEnvelope({
      profile,
      agentId: "test-agent-id",
      deviceId: "pc-device",
      accessToken: "access-next",
    });
    expect(tokenRefresh.payload?.token).toBe("access-next");
    expect(tokenRefresh.payload).not.toHaveProperty("refresh_token");
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
});
