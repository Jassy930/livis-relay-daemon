import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { IdaasClient } from "../src/auth/idaas.ts";
import {
  CURRENT_WIRE_CONTRACT_REVISION,
  WIRE_CONTRACT_REGISTRY,
} from "../src/protocol/contract.ts";
import {
  buildAckEnvelope,
  buildConnectEnvelope,
  buildHeartbeatEnvelope,
  buildResultEnvelope,
  buildTokenRefreshEnvelope,
  parseIncomingRelayJob,
  parseRelayEnvelope,
} from "../src/protocol/livis.ts";
import { parseProtocolProfile, type ProtocolProfile } from "../src/protocol/profile.ts";
import { SecretStore } from "../src/secrets.ts";
import type { RelayEnvelope } from "../src/types.ts";
import { sha256 } from "../src/util.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const FIXTURE_PATH = join(PROJECT_ROOT, "tests", "fixtures", "livis-test-v2.0.0.json");
export const LOCAL_PROBE_ARTIFACT_PATH = join(
  PROJECT_ROOT,
  WIRE_CONTRACT_REGISTRY[CURRENT_WIRE_CONTRACT_REVISION]!.localProbeArtifactPath,
);

type ProbeOutcome = "accepted" | "rejected";

interface ParserProbeResult {
  case: string;
  layer: "envelope" | "send_message";
  outcome: ProbeOutcome;
  reason?: string;
}

interface IdaasRequestObservation {
  operation: string;
  method: string;
  path: string;
  contentType: string | null;
  fields: string[];
  sensitiveFields: string[];
}

function normalizedScalar(key: string, value: unknown, envelopeType: string): unknown {
  if (key === "timestamp") return "<timestamp:number>";
  if (key === "msg_id") return value === "probe-message" ? "<provided-message-id>" : "<generated-message-id>";
  if (key === "job_id") {
    if (value === "") return "";
    return envelopeType === "connect" || envelopeType === "heartbeat" ? "<generated-job-id>" : "<job-id>";
  }
  if (key === "agent_id") return "<agent-id>";
  if (key === "device_id") return "<device-id>";
  if (key === "node_name") return "<node-name>";
  if (key === "node_desc") return "<node-description>";
  if (key === "client") return "<wire-client>";
  if (key === "nodeType") return "<node-type>";
  if (key === "token") return "<access-token>";
  if (key === "refresh_token") return "<refresh-token>";
  if (key === "data" && envelopeType === "send_result") return "<json-string:{text}>";
  return value;
}

function normalizeEnvelope(envelope: RelayEnvelope): RelayEnvelope {
  const normalizeObject = (value: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        return [key, normalizeObject(item as Record<string, unknown>)];
      }
      return [key, normalizedScalar(key, item, envelope.type)];
    }),
  );
  return normalizeObject(envelope) as RelayEnvelope;
}

function relayOutboundFrames(profile: ProtocolProfile): Record<string, RelayEnvelope> {
  const common = { profile, agentId: "probe-agent", deviceId: "probe-device" };
  return {
    connect: normalizeEnvelope(buildConnectEnvelope({
      ...common,
      nodeName: "probe-node",
      accessToken: "SENTINEL_ACCESS_TOKEN",
      refreshToken: "SENTINEL_REFRESH_TOKEN",
    })),
    heartbeat: normalizeEnvelope(buildHeartbeatEnvelope(profile, common.agentId, common.deviceId)),
    ack_send_message: normalizeEnvelope(buildAckEnvelope(
      profile,
      "ack_send_message",
      "probe-job",
      common.agentId,
      common.deviceId,
    )),
    ack_cancel_chat: normalizeEnvelope(buildAckEnvelope(
      profile,
      "ack_cancel_chat",
      "probe-job",
      common.agentId,
      common.deviceId,
    )),
    send_result: normalizeEnvelope(buildResultEnvelope({
      ...common,
      jobId: "probe-job",
      resultJson: JSON.stringify({ text: "SENTINEL_RESULT" }),
      messageId: "probe-message",
    })),
    token_refresh: normalizeEnvelope(buildTokenRefreshEnvelope({
      ...common,
      accessToken: "SENTINEL_ACCESS_TOKEN",
      refreshToken: "SENTINEL_REFRESH_TOKEN",
    })),
  };
}

function relayParserCases(): ParserProbeResult[] {
  const base: RelayEnvelope = {
    type: "send_message",
    metadata: { job_id: "probe-job", msg_id: "probe-message", timestamp: 1 },
    payload: { from_node_id: "probe-node", data: { type: "exec", content: "12345678" } },
  };
  const cases: Array<{
    case: string;
    layer: ParserProbeResult["layer"];
    run: () => unknown;
  }> = [
    { case: "valid-object-data", layer: "send_message", run: () => parseIncomingRelayJob(base, 8) },
    {
      case: "valid-json-string-data",
      layer: "send_message",
      run: () => parseIncomingRelayJob({
        ...base,
        payload: { ...base.payload, data: JSON.stringify(base.payload?.data) },
      }, 8),
    },
    {
      case: "extra-fields",
      layer: "send_message",
      run: () => parseIncomingRelayJob({
        ...base,
        extra: true,
        metadata: { ...base.metadata, extra: true },
        payload: { ...base.payload, extra: true },
      }, 8),
    },
    { case: "missing-job-id", layer: "send_message", run: () => parseIncomingRelayJob({ ...base, metadata: {} }, 8) },
    {
      case: "missing-from-node-id",
      layer: "send_message",
      run: () => parseIncomingRelayJob({ ...base, payload: { data: base.payload?.data } }, 8),
    },
    {
      case: "unsupported-business-type",
      layer: "send_message",
      run: () => parseIncomingRelayJob({
        ...base,
        payload: { ...base.payload, data: { type: "notify", content: "ok" } },
      }, 8),
    },
    {
      case: "blank-content",
      layer: "send_message",
      run: () => parseIncomingRelayJob({
        ...base,
        payload: { ...base.payload, data: { type: "exec", content: "  " } },
      }, 8),
    },
    {
      case: "content-over-limit",
      layer: "send_message",
      run: () => parseIncomingRelayJob({
        ...base,
        payload: { ...base.payload, data: { type: "exec", content: "123456789" } },
      }, 8),
    },
    {
      case: "metadata-null",
      layer: "envelope",
      run: () => parseRelayEnvelope(JSON.stringify({ ...base, metadata: null })),
    },
    {
      case: "payload-array",
      layer: "envelope",
      run: () => parseRelayEnvelope(JSON.stringify({ ...base, payload: [] })),
    },
    {
      case: "unknown-envelope-type",
      layer: "envelope",
      run: () => parseRelayEnvelope(JSON.stringify({ type: "probe_unknown" })),
    },
  ];
  return cases.map((item) => {
    try {
      item.run();
      return { case: item.case, layer: item.layer, outcome: "accepted" as const };
    } catch (error) {
      return {
        case: item.case,
        layer: item.layer,
        outcome: "rejected" as const,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

async function idaasRequests(profile: ProtocolProfile): Promise<IdaasRequestObservation[]> {
  const directory = await mkdtemp(join(tmpdir(), "livis-local-probe-"));
  const observations: IdaasRequestObservation[] = [];
  try {
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      const fields = [...form.keys()].sort();
      const grantType = form.get("grant_type");
      const operation = url.pathname.endsWith("/aux")
        ? form.has("prompt") ? "device-code-force" : "device-code"
        : url.pathname.endsWith("/revoke")
          ? "revoke"
          : grantType === "refresh_token"
            ? "refresh-token"
            : "device-token";
      observations.push({
        operation,
        method: init?.method ?? "GET",
        path: url.pathname.endsWith("/aux") ? "/aux" : url.pathname.endsWith("/revoke") ? "/revoke" : "/token",
        contentType: new Headers(init?.headers).get("Content-Type"),
        fields,
        sensitiveFields: fields.filter((field) => ["device_code", "refresh_token", "token"].includes(field)),
      });
      if (url.pathname.endsWith("/aux")) {
        return Response.json({
          device_code: "SENTINEL_DEVICE_CODE",
          verification_uri_complete: "https://example.invalid/verify",
          expires_in: 60,
          interval: 1,
        });
      }
      if (url.pathname.endsWith("/revoke")) return new Response(null, { status: 204 });
      return Response.json({
        access_token: "SENTINEL_ACCESS_TOKEN",
        refresh_token: grantType === "refresh_token" ? "SENTINEL_ROTATED_REFRESH_TOKEN" : "SENTINEL_REFRESH_TOKEN",
        expires_in: 3600,
        token_type: "Bearer",
      });
    };
    const secrets = new SecretStore(directory);
    await secrets.initialize();
    const client = new IdaasClient(profile, secrets, {
      fetch: fakeFetch as typeof fetch,
      sleep: async () => undefined,
    });
    await client.requestDeviceCode(false);
    const deviceCode = await client.requestDeviceCode(true);
    await client.pollForToken(deviceCode);
    await client.getAccessToken(true);
    await client.revoke();
    return observations;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function buildLocalProtocolProbeReport(): Promise<Record<string, unknown>> {
  const profile = parseProtocolProfile(await Bun.file(FIXTURE_PATH).text(), FIXTURE_PATH);
  const frames = relayOutboundFrames(profile);
  return {
    schemaVersion: 1,
    evidenceLevel: "S2",
    disclaimer: "只证明当前 daemon 在固定假数据和本地 fake 服务下的行为，不证明真实 LiViS 服务端要求或兼容性。",
    contract: {
      wireProtocolVersion: profile.wireProtocolVersion,
      wireContractRevision: profile.wireContractRevision,
      credentialMode: profile.credentialMode,
    },
    safety: {
      network: "injected-fetch-and-loopback-only",
      credentials: "fixed-sentinel-only",
      liveProfileRead: false,
      rawFramePersistence: false,
    },
    relay: {
      outboundFrames: frames,
      parserCases: relayParserCases(),
      credentialPresence: {
        connect: {
          accessToken: Object.hasOwn(frames.connect?.payload ?? {}, "token"),
          refreshToken: Object.hasOwn(frames.connect?.payload ?? {}, "refresh_token"),
        },
        tokenRefresh: {
          accessToken: Object.hasOwn(frames.token_refresh?.payload ?? {}, "token"),
          refreshToken: Object.hasOwn(frames.token_refresh?.payload ?? {}, "refresh_token"),
        },
      },
    },
    idaas: { requests: await idaasRequests(profile) },
    unknowns: [
      "真实服务端字段必填性、可选性与额外字段处理",
      "connected 与 token_refreshed 的真实关联字段",
      "真实 ACK 去重、迟到 ACK、heartbeat 和断线恢复语义",
      "真实 IDaaS 状态码、响应 shape、轮换、限流与大小上限",
    ],
  };
}

export function assertPublicProbeTextSafe(text: string): void {
  const forbidden = [
    "SENTINEL_",
    "probe-access-token-v1",
    "probe-access-token-v2",
    "probe-refresh-token-v1",
    "probe-agent",
    "probe-device",
    "probe-node",
    "test-client-id",
    "idaas.test",
    "relay.test",
  ];
  const matched = forbidden.find((value) => text.includes(value));
  if (matched || /(?:https|wss?):\/\//i.test(text)) {
    throw new Error(`本地 protocol probe artifact 未完成脱敏：${matched ?? "包含 URL"}`);
  }
}

export async function canonicalLocalProtocolProbeText(): Promise<string> {
  const text = `${JSON.stringify(await buildLocalProtocolProbeReport(), null, 2)}\n`;
  assertPublicProbeTextSafe(text);
  return text;
}

async function main(): Promise<void> {
  const args = new Set(Bun.argv.slice(2));
  const known = new Set(["--check", "--write"]);
  const unknown = [...args].filter((arg) => !known.has(arg));
  if (unknown.length > 0 || (args.has("--check") && args.has("--write"))) {
    throw new Error("用法：probe-protocol-local.ts [--check | --write]");
  }
  const text = await canonicalLocalProtocolProbeText();
  if (args.has("--write")) {
    await mkdir(resolve(LOCAL_PROBE_ARTIFACT_PATH, ".."), { recursive: true });
    await Bun.write(LOCAL_PROBE_ARTIFACT_PATH, text);
    process.stdout.write(`已更新本地 S2 probe artifact：${LOCAL_PROBE_ARTIFACT_PATH}\nSHA-256：${sha256(text)}\n`);
    return;
  }
  if (args.has("--check")) {
    const current = await Bun.file(LOCAL_PROBE_ARTIFACT_PATH).text().catch(() => "");
    if (current !== text) {
      throw new Error("本地 protocol probe artifact 与当前代码不一致；审阅差异后运行 bun run probe:protocol:update");
    }
    const expectedSha256 = WIRE_CONTRACT_REGISTRY[CURRENT_WIRE_CONTRACT_REVISION]!.localProbeArtifactSha256;
    if (sha256(text) !== expectedSha256) {
      throw new Error("本地 protocol probe artifact SHA-256 未绑定当前 wire contract registry；必须建立新 revision 或审阅后更新 registry");
    }
    process.stdout.write("本地 protocol probe artifact 与当前代码一致\n");
    return;
  }
  process.stdout.write(text);
}

if (import.meta.main) {
  await main();
}
