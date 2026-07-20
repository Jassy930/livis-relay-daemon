import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { ConnectorServer, type ConnectorServerHandlers } from "../src/connector/server.ts";
import { Logger } from "../src/logger.ts";
import { JobStore } from "../src/state/store.ts";
import type { ConnectorHello, ConnectorInboundMessage } from "../src/types.ts";
import { incomingJob, temporaryDirectory } from "./helpers.ts";

const READY_TIMEOUT_MS = 30_000;
const MESSAGE_TIMEOUT_MS = 5_000;
const DISCONNECT_TIMEOUT_MS = 2_000;
type PythonProcess = Bun.Subprocess<"ignore", "pipe", "pipe">;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitWhileProcessRuns<T>(
  promise: Promise<T>,
  process: PythonProcess,
  stderrText: Promise<string>,
  label: string,
  timeoutMs = MESSAGE_TIMEOUT_MS,
): Promise<T> {
  return bounded(
    Promise.race([
      promise,
      process.exited.then(async (exitCode) => {
        const stderr = (await stderrText).trim();
        throw new Error(
          `Python connector 在 ${label} 前退出（exit ${exitCode}）${stderr ? `：${stderr}` : ""}`,
        );
      }),
    ]),
    timeoutMs,
    label,
  );
}

async function terminate(process: PythonProcess | null): Promise<void> {
  if (!process || process.exitCode !== null) return;
  process.kill("SIGTERM");
  try {
    await bounded(process.exited, 1_000, "Python connector SIGTERM");
  } catch {
    process.kill("SIGKILL");
    await bounded(process.exited, 1_000, "Python connector SIGKILL");
  }
}

test("Python websockets 与 Bun ConnectorServer 完成真实 UDS job/result 往返", async () => {
  const directory = await temporaryDirectory("livis-python-connector-test-");
  const token = "p".repeat(43);
  const connectorId = "python-uds-test";
  const jobId = "python-job-1";
  const leaseId = "python-lease-1";
  const inputText = "cross-language request";
  const resultText = "cross-language result";
  const ready = deferred<ConnectorHello>();
  const accepted = deferred<{
    message: Extract<ConnectorInboundMessage, { type: "accepted" }>;
    connectorId: string;
  }>();
  const result = deferred<{
    message: Extract<ConnectorInboundMessage, { type: "result" }>;
    connectorId: string;
  }>();
  const disconnected = deferred<string>();
  let connectorBecameReady = false;

  const handlers: ConnectorServerHandlers = {
    onReady: async (hello) => {
      connectorBecameReady = true;
      ready.resolve(hello);
    },
    onAccepted: async (message, id) => { accepted.resolve({ message, connectorId: id }); },
    onResult: async (message, id) => { result.resolve({ message, connectorId: id }); },
    onFailed: async () => { throw new Error("Python connector 不应返回 failed"); },
    onCancelled: async () => { throw new Error("Python connector 不应返回 cancelled"); },
    onDisconnected: async (id) => { disconnected.resolve(id); },
    status: () => ({ test: true }),
  };

  let store: JobStore | null = null;
  let server: ConnectorServer | null = null;
  let pythonProcess: PythonProcess | null = null;
  try {
    const activeStore = new JobStore(join(directory.path, "relay.db"), "account:agent");
    store = activeStore;
    const activeServer = new ConnectorServer({
      socketPath: join(directory.path, "connector.sock"),
      connectorToken: token,
      helloTimeoutMs: MESSAGE_TIMEOUT_MS,
      resultStoreTimeoutMs: 5000,
      maxFrameBytes: 1024 * 1024,
      daemonVersion: "test",
      hermesMinimumVersion: "0.15.1",
      hermesMaximumExclusiveVersion: "0.15.2",
      bridgeImplementation: "livis-hermes-bridge",
      bridgeMinimumVersion: "0.1.0",
      bridgeMaximumExclusiveVersion: "0.2.0",
    }, handlers, new Logger("test.python-connector", "error"));
    server = activeServer;
    activeServer.start();
    const projectRoot = resolve(import.meta.dir, "..");
    pythonProcess = Bun.spawn([
      "uv",
      "run",
      "--project",
      join(projectRoot, "hermes-plugin"),
      "--frozen",
      "--no-dev",
      "python",
      join(import.meta.dir, "fixtures", "python_connector_client.py"),
      "--socket",
      activeServer.socketPath,
      "--token",
      token,
      "--connector-id",
      connectorId,
      "--job-id",
      jobId,
      "--lease-id",
      leaseId,
      "--expected-text",
      inputText,
      "--result-text",
      resultText,
    ], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        UV_PROJECT_ENVIRONMENT: join(directory.path, "python-env"),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdoutText = new Response(pythonProcess.stdout).text();
    const stderrText = new Response(pythonProcess.stderr).text();

    const hello = await waitWhileProcessRuns(
      ready.promise,
      pythonProcess,
      stderrText,
      "Python connector hello",
      READY_TIMEOUT_MS,
    );
    expect(hello.connectorId).toBe(connectorId);
    expect(hello.implementation).toEqual({
      name: "livis-hermes-bridge",
      version: "0.1.0",
      runtimeVersion: "0.15.1",
    });

    activeStore.ingest(incomingJob(jobId, inputText), "session-python");
    activeStore.markAcked(jobId);
    const job = activeStore.claimForDispatch(jobId, connectorId, leaseId);
    expect(job).not.toBeNull();
    expect(activeServer.sendJob(job!)).toBeTrue();

    expect(await waitWhileProcessRuns(
      accepted.promise,
      pythonProcess,
      stderrText,
      "Python connector accepted",
    )).toEqual({
      message: { type: "accepted", jobId, leaseId },
      connectorId,
    });
    expect(await waitWhileProcessRuns(
      result.promise,
      pythonProcess,
      stderrText,
      "Python connector result",
    )).toEqual({
      message: { type: "result", jobId, leaseId, text: resultText },
      connectorId,
    });

    activeServer.acknowledgeResult(jobId, leaseId);
    expect(await bounded(pythonProcess.exited, MESSAGE_TIMEOUT_MS, "Python connector exit")).toBe(0);
    expect(await bounded(disconnected.promise, DISCONNECT_TIMEOUT_MS, "Python connector disconnect")).toBe(connectorId);
    expect(JSON.parse((await stdoutText).trim())).toEqual({
      connectorId,
      jobId,
      leaseId,
      resultStored: true,
    });
  } finally {
    await terminate(pythonProcess);
    if (connectorBecameReady) {
      try {
        await bounded(disconnected.promise, DISCONNECT_TIMEOUT_MS, "Python connector cleanup disconnect");
      } catch {
        // 若主动断开事件未到达，下面的 server.stop() 仍会做最终清理。
      }
    }
    server?.stop();
    store?.close();
    await directory.cleanup();
  }
}, 45_000);
