import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RelayConfig } from "../src/config.ts";
import { parseProtocolProfile, type ProtocolProfile } from "../src/protocol/profile.ts";
import type { IncomingRelayJob } from "../src/types.ts";
import { sha256 } from "../src/util.ts";

export async function temporaryDirectory(prefix = "livis-relay-test-"): Promise<{
  path: string;
  cleanup: () => Promise<void>;
}> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return {
    path,
    cleanup: () => rm(path, { recursive: true, force: true }),
  };
}

export async function testProfile(): Promise<ProtocolProfile> {
  const path = resolve(import.meta.dir, "fixtures", "livis-test-v2.0.0.json");
  return parseProtocolProfile(await Bun.file(path).text(), path);
}

export function testConfig(stateDir: string): RelayConfig {
  return {
    schemaVersion: 1,
    profile: "profile.json",
    profileSha256: sha256("test-profile"),
    stateDir,
    relay: { nodeName: "测试电脑", handshakeTimeoutMs: 1000, reconnectMaxMs: 1000 },
    connector: {
      socketPath: join(stateDir, "connector.sock"),
      helloTimeoutMs: 500,
      resultStoreTimeoutMs: 500,
      maxFrameBytes: 1024 * 1024,
    },
    security: {
      acknowledgeUnofficialProtocol: true,
      allowAllNodes: false,
      allowedNodeIds: ["node-1"],
      maxInputChars: 32_768,
      maxOutputChars: 1_048_576,
      unauthorizedMessage: "unauthorized",
    },
    routing: {
      defaultBackend: "hermes",
      nodeBackends: {},
    },
    hermes: {
      command: "hermes",
      minimumVersion: "0.15.1",
      maximumExclusiveVersion: "0.15.2",
      bridgeImplementation: "livis-hermes-bridge",
      bridgeMinimumVersion: "0.1.0",
      bridgeMaximumExclusiveVersion: "0.2.0",
    },
  };
}

export function incomingJob(jobId: string, text = "hello", nodeId = "node-1"): IncomingRelayJob {
  return {
    jobId,
    messageId: `msg-${jobId}`,
    fromNodeId: nodeId,
    fromNodeType: "phone",
    text,
    timestamp: 1_700_000_000_000,
    rawPayload: JSON.stringify({ jobId, text, nodeId }),
  };
}
