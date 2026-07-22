import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { HermesExecutionBackend } from "../src/backends/hermes-backend.ts";
import { ConnectorServer, type ConnectorServerHandlers } from "../src/connector/server.ts";
import { Logger } from "../src/logger.ts";
import type { ConnectorServer as ConnectorServerType } from "../src/connector/server.ts";
import type { StoredJob } from "../src/types.ts";
import { temporaryDirectory } from "./helpers.ts";

describe("ExecutionBackend 薄层", () => {
  test("Hermes wrapper 保留 ConnectorServer 的启动、派发、取消和 ACK 行为", async () => {
    const calls: string[] = [];
    const connector = {
      ready: true,
      connectorId: "hermes-generation-1",
      socketPath: "/private/hermes.sock",
      start: () => calls.push("start"),
      stop: () => calls.push("stop"),
      sendJob: () => {
        calls.push("job");
        return true;
      },
      sendCancel: () => {
        calls.push("cancel");
        return false;
      },
      acknowledgeResult: (jobId: string, leaseId: string) => calls.push(`ack:${jobId}:${leaseId}`),
      rejectJobMessage: (jobId: string, code: string) => calls.push(`reject:${jobId}:${code}`),
    } as unknown as ConnectorServerType;
    const backend = new HermesExecutionBackend(connector);
    const job = { jobId: "job-1", leaseId: "lease-1" } as StoredJob;

    expect(backend.kind).toBe("hermes");
    expect(backend.ready).toBeTrue();
    expect(backend.executionId).toBe("hermes-generation-1");
    expect(backend.status()).toEqual({
      kind: "hermes",
      ready: true,
      executionId: "hermes-generation-1",
      socketPath: "/private/hermes.sock",
    });

    await backend.start();
    expect(await backend.dispatch(job)).toBe("submitted");
    expect(await backend.cancel(job)).toBe("not_sent");
    backend.acknowledgeResult("job-1", "lease-1");
    backend.rejectJobMessage("job-1", "stale_lease", "stale");
    await backend.stop();

    expect(calls).toEqual([
      "start",
      "job",
      "cancel",
      "ack:job-1:lease-1",
      "reject:job-1:stale_lease",
      "stop",
    ]);
  });

  test("关闭 Hermes connector 时仍提供 health/status，且 WS 路由明确不可用", async () => {
    const directory = await temporaryDirectory("livis-control-only-");
    const token = "x".repeat(43);
    const handlers: ConnectorServerHandlers = {
      onReady: async () => {
        throw new Error("关闭的 Hermes route 不应 ready");
      },
      onAccepted: async () => undefined,
      onResult: async () => undefined,
      onFailed: async () => undefined,
      onCancelled: async () => undefined,
      onDisconnected: async () => undefined,
      status: () => ({ execution: { kind: "codex", ready: false } }),
    };
    const server = new ConnectorServer({
      socketPath: join(directory.path, "control.sock"),
      connectorToken: token,
      acceptHermesConnector: false,
      helloTimeoutMs: 1_000,
      resultStoreTimeoutMs: 750,
      maxFrameBytes: 1024 * 1024,
      daemonVersion: "test",
      hermesMinimumVersion: "0.15.1",
      hermesMaximumExclusiveVersion: "0.15.2",
      bridgeImplementation: "livis-hermes-bridge",
      bridgeMinimumVersion: "0.1.0",
      bridgeMaximumExclusiveVersion: "0.2.0",
    }, handlers, new Logger("test.control-only", "error"));

    try {
      server.start();

      const health = await fetch("http://localhost/healthz", { unix: server.socketPath });
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true, connectorReady: false });

      const unauthorized = await fetch("http://localhost/v1/status", { unix: server.socketPath });
      expect(unauthorized.status).toBe(401);
      const status = await fetch("http://localhost/v1/status", {
        unix: server.socketPath,
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({
        ok: true,
        connector: null,
        daemon: { execution: { kind: "codex", ready: false } },
      });

      const hermesRoute = await fetch("http://localhost/v1/connectors/hermes", {
        unix: server.socketPath,
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(hermesRoute.status).toBe(404);
      expect(await hermesRoute.text()).toBe("Hermes connector is disabled");
      expect(server.ready).toBeFalse();
      expect(server.connectorId).toBeNull();
    } finally {
      server.stop();
      await directory.cleanup();
    }
  });
});
