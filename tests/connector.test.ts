import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import WebSocket from "ws";
import { ConnectorServer, type ConnectorServerHandlers } from "../src/connector/server.ts";
import { Logger } from "../src/logger.ts";
import { JobStore } from "../src/state/store.ts";
import type { ConnectorHello, ConnectorInboundMessage } from "../src/types.ts";
import { incomingJob, temporaryDirectory } from "./helpers.ts";

function openWebSocket(path: string, token: string): WebSocket {
  return new WebSocket(`ws+unix://${path}:/v1/connectors/hermes`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

function messageReader(socket: WebSocket) {
  const queued: Array<Record<string, unknown>> = [];
  const waiters: Array<(message: Record<string, unknown>) => void> = [];
  socket.on("message", (data) => {
    const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else queued.push(parsed);
  });
  return async () => {
    const message = queued.shift();
    if (message) return message;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const onMessage = (received: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(received);
      };
      const timer = setTimeout(() => {
        const index = waiters.indexOf(onMessage);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error("等待 connector WebSocket 消息超时"));
      }, 2_000);
      waiters.push(onMessage);
    });
  };
}

describe("Hermes connector Unix WebSocket", () => {
  let directory: Awaited<ReturnType<typeof temporaryDirectory>>;
  let store: JobStore;
  let server: ConnectorServer;
  const token = "x".repeat(43);
  const events: Array<{ type: string; jobId?: string }> = [];

  beforeEach(async () => {
    directory = await temporaryDirectory();
    store = new JobStore(join(directory.path, "relay.db"), "account:agent");
    const handlers: ConnectorServerHandlers = {
      onReady: async (hello: ConnectorHello) => { events.push({ type: "ready", jobId: hello.connectorId }); },
      onAccepted: async (message) => { events.push({ type: "accepted", jobId: message.jobId }); },
      onResult: async (message) => { events.push({ type: "result", jobId: message.jobId }); },
      onFailed: async (message) => { events.push({ type: "failed", jobId: message.jobId }); },
      onCancelled: async (message) => { events.push({ type: "cancelled", jobId: message.jobId }); },
      onDisconnected: async (connectorId) => { events.push({ type: "disconnected", jobId: connectorId }); },
      status: () => ({ test: true }),
    };
    server = new ConnectorServer({
      socketPath: join(directory.path, "connector.sock"),
      connectorToken: token,
      helloTimeoutMs: 1000,
      resultStoreTimeoutMs: 750,
      maxFrameBytes: 1024 * 1024,
      daemonVersion: "test",
      hermesMinimumVersion: "0.15.1",
      hermesMaximumExclusiveVersion: "0.15.2",
      bridgeImplementation: "livis-hermes-bridge",
      bridgeMinimumVersion: "0.1.0",
      bridgeMaximumExclusiveVersion: "0.2.0",
    }, handlers, new Logger("test.connector", "error"));
    server.start();
  });

  afterEach(async () => {
    server.stop();
    store.close();
    await directory.cleanup();
    events.length = 0;
  });

  test("鉴权、hello、lease job 和 durable result ACK", async () => {
    const unauthorized = await fetch("http://localhost/v1/status", {
      unix: server.socketPath,
      headers: { Authorization: "Bearer wrong" },
    });
    expect(unauthorized.status).toBe(401);

    const client = openWebSocket(server.socketPath, token);
    const read = messageReader(client);
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    expect((await read()).type).toBe("hello_required");
    client.send(JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      connectorId: "hermes-test",
      backend: "hermes",
      implementation: { name: "livis-hermes-bridge", version: "0.1.0", runtimeVersion: "0.15.1" },
      capabilities: { cancel: true, finalResult: true },
    }));
    const helloAck = await read();
    expect(helloAck.type).toBe("hello_ack");
    expect(helloAck.resultStoreTimeoutMs).toBe(750);
    await Bun.sleep(5);
    expect(server.ready).toBeTrue();
    expect(events[0]).toEqual({ type: "ready", jobId: "hermes-test" });

    store.ingest(incomingJob("job-1"), "session-1");
    store.markAcked("job-1");
    const job = store.claimForDispatch("job-1", "hermes-test", "lease-1")!;
    expect(server.sendJob(job)).toBeTrue();
    const offered = await read();
    expect(offered.type).toBe("job");
    expect((offered.job as Record<string, unknown>).leaseId).toBe("lease-1");

    client.send(JSON.stringify({ type: "accepted", jobId: "job-1", leaseId: "lease-1" }));
    client.send(JSON.stringify({ type: "result", jobId: "job-1", leaseId: "lease-1", text: "done" }));
    await Bun.sleep(5);
    expect(events.some((event) => event.type === "accepted")).toBeTrue();
    expect(events.some((event) => event.type === "result")).toBeTrue();
    server.acknowledgeResult("job-1", "lease-1");
    expect(await read()).toEqual({ type: "result_stored", jobId: "job-1", leaseId: "lease-1" });

    client.close();
    await new Promise((resolve) => client.once("close", resolve));
  });

  test("拒绝不兼容 connector protocol", async () => {
    const client = openWebSocket(server.socketPath, token);
    const read = messageReader(client);
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    await read();
    client.send(JSON.stringify({
      type: "hello",
      protocolVersion: 99,
      connectorId: "bad",
      backend: "hermes",
      implementation: { name: "livis-hermes-bridge", version: "0.1.0", runtimeVersion: "0.15.1" },
      capabilities: { cancel: true, finalResult: true },
    }));
    const error = await read();
    expect(error.type).toBe("error");
    expect(error.code).toBe("invalid_message");
    client.close();
  });

  test("只接受已审核 Hermes 和 bridge 版本范围", async () => {
    const oldClient = openWebSocket(server.socketPath, token);
    const readOld = messageReader(oldClient);
    await new Promise<void>((resolve, reject) => {
      oldClient.once("open", resolve);
      oldClient.once("error", reject);
    });
    await readOld();
    oldClient.send(JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      connectorId: "old-hermes",
      backend: "hermes",
      implementation: { name: "livis-hermes-bridge", version: "0.1.0", runtimeVersion: "0.14.9" },
      capabilities: { cancel: true, finalResult: true },
    }));
    expect((await readOld()).code).toBe("hermes_version_unsupported");
    await new Promise((resolve) => oldClient.once("close", resolve));

    const futureClient = openWebSocket(server.socketPath, token);
    const readFuture = messageReader(futureClient);
    await new Promise<void>((resolve, reject) => {
      futureClient.once("open", resolve);
      futureClient.once("error", reject);
    });
    await readFuture();
    futureClient.send(JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      connectorId: "future-hermes",
      backend: "hermes",
      implementation: { name: "livis-hermes-bridge", version: "0.1.0", runtimeVersion: "0.15.2" },
      capabilities: { cancel: true, finalResult: true },
    }));
    expect((await readFuture()).code).toBe("hermes_version_unsupported");
    await new Promise((resolve) => futureClient.once("close", resolve));

    const foreignBridge = openWebSocket(server.socketPath, token);
    const readForeign = messageReader(foreignBridge);
    await new Promise<void>((resolve, reject) => {
      foreignBridge.once("open", resolve);
      foreignBridge.once("error", reject);
    });
    await readForeign();
    foreignBridge.send(JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      connectorId: "foreign-bridge",
      backend: "hermes",
      implementation: { name: "another-bridge", version: "0.1.0", runtimeVersion: "0.15.1" },
      capabilities: { cancel: true, finalResult: true },
    }));
    expect((await readForeign()).code).toBe("bridge_implementation_unsupported");
    await new Promise((resolve) => foreignBridge.once("close", resolve));

    const newClient = openWebSocket(server.socketPath, token);
    const readNew = messageReader(newClient);
    await new Promise<void>((resolve, reject) => {
      newClient.once("open", resolve);
      newClient.once("error", reject);
    });
    await readNew();
    newClient.send(JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      connectorId: "new-hermes",
      backend: "hermes",
      implementation: { name: "livis-hermes-bridge", version: "0.1.1", runtimeVersion: "0.15.1" },
      capabilities: { cancel: true, finalResult: true },
    }));
    expect((await readNew()).type).toBe("hello_ack");
    newClient.close();
    await new Promise((resolve) => newClient.once("close", resolve));
  });
});
