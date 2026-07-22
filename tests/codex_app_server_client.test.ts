import { describe, expect, test } from "bun:test";
import {
  CODEX_APP_SERVER_COMMAND,
  CodexAppServerClient,
  CodexAppServerCloseUnconfirmedError,
  CodexAppServerRequestTransportError,
  CodexAppServerRpcError,
  CodexAppServerTimeoutError,
  type CodexAppServerProcess,
  type CodexAppServerSpawn,
  type CodexAppServerSpawnOptions,
  type CodexProcessGroupController,
} from "../src/backends/codex/app-server-client.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`等待 ${label} 超时`);
    await Bun.sleep(2);
  }
}

class FakeAppServer {
  readonly messages: Array<Record<string, unknown>> = [];
  readonly process: CodexAppServerProcess;
  readonly spawn: CodexAppServerSpawn;
  command: readonly string[] | null = null;
  spawnOptions: CodexAppServerSpawnOptions | null = null;
  writeGate: Deferred<void> | null = null;
  readonly killSignals: Array<number | NodeJS.Signals | undefined> = [];
  ignoreSigterm = false;
  ignoreAllSignals = false;
  onMessage: (message: Record<string, unknown>) => void | Promise<void> = async (message) => {
    if (typeof message.id === "number" && typeof message.method === "string") {
      await this.send({ id: message.id, result: { method: message.method, params: message.params } });
    }
  };

  private readonly stdout = new TransformStream<Uint8Array, Uint8Array>();
  private readonly stderr = new TransformStream<Uint8Array, Uint8Array>();
  private readonly stdoutWriter = this.stdout.writable.getWriter();
  private readonly stderrWriter = this.stderr.writable.getWriter();
  private readonly exit = deferred<number>();
  private inputBuffer = "";
  private stopped = false;

  constructor() {
    this.process = {
      pid: 42_424,
      stdin: {
        write: async (chunk) => {
          if (this.writeGate) await this.writeGate.promise;
          const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
          this.inputBuffer += new TextDecoder().decode(bytes);
          let newline = this.inputBuffer.indexOf("\n");
          while (newline >= 0) {
            const line = this.inputBuffer.slice(0, newline);
            this.inputBuffer = this.inputBuffer.slice(newline + 1);
            if (line.trim()) {
              const message = JSON.parse(line) as Record<string, unknown>;
              this.messages.push(message);
              await this.onMessage(message);
            }
            newline = this.inputBuffer.indexOf("\n");
          }
          return bytes.byteLength;
        },
        flush: () => 0,
        end: () => 0,
      },
      stdout: this.stdout.readable,
      stderr: this.stderr.readable,
      exited: this.exit.promise,
      kill: (signal) => {
        this.killSignals.push(signal);
        if (this.ignoreAllSignals) return;
        if (this.ignoreSigterm && (signal === undefined || signal === "SIGTERM")) return;
        void this.stop(0);
      },
    };
    this.spawn = (command, options) => {
      this.command = command;
      this.spawnOptions = options;
      return this.process;
    };
  }

  async send(message: Record<string, unknown>, splitAt?: number): Promise<void> {
    const bytes = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
    if (splitAt !== undefined && splitAt > 0 && splitAt < bytes.byteLength) {
      await this.stdoutWriter.write(bytes.slice(0, splitAt));
      await this.stdoutWriter.write(bytes.slice(splitAt));
      return;
    }
    await this.stdoutWriter.write(bytes);
  }

  async writeStderr(text: string): Promise<void> {
    await this.stderrWriter.write(new TextEncoder().encode(text));
  }

  async closeStdoutOnly(): Promise<void> {
    await this.stdoutWriter.close();
  }

  async stop(exitCode: number): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await Promise.allSettled([this.stdoutWriter.close(), this.stderrWriter.close()]);
    this.exit.resolve(exitCode);
  }

  async startClient(
    options: Partial<Parameters<typeof CodexAppServerClient.start>[0]> = {},
  ): Promise<CodexAppServerClient> {
    return CodexAppServerClient.start({
      spawn: this.spawn,
      requestTimeoutMs: 200,
      ...options,
    });
  }
}

describe("Codex app-server stdio client", () => {
  test("使用固定安全参数启动并完成 initialize/initialized", async () => {
    const fake = new FakeAppServer();
    const client = await fake.startClient({ cwd: "/daemon/sessions/session-1" });
    try {
      expect(fake.command).toEqual(CODEX_APP_SERVER_COMMAND);
      expect(fake.spawnOptions).toEqual({
        cwd: "/daemon/sessions/session-1",
        env: undefined,
        detached: true,
      });
      expect(fake.messages).toHaveLength(2);
      expect(fake.messages[0]).toEqual({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "livis-relay-daemon",
            title: "LiViS Relay Daemon",
            version: "0.1.0",
          },
          capabilities: { experimentalApi: false, requestAttestation: false },
        },
      });
      expect(fake.messages[1]).toEqual({ method: "initialized" });
      expect(fake.messages.some((message) => "jsonrpc" in message)).toBeFalse();
    } finally {
      await client.close();
    }
  });

  test("显式 command argv 原样交给 spawn", async () => {
    const fake = new FakeAppServer();
    const command = [
      "/opt/livis/bin/codex",
      "app-server",
      "--stdio",
      "--disable",
      "plugins",
      "-c",
      "features.example=false",
    ] as const;
    const env = { PATH: "/opt/livis/bin:/usr/bin", CODEX_HOME: "/daemon/codex-home" };
    const client = await fake.startClient({ command, env });
    try {
      expect(fake.command).toBe(command);
      expect(fake.spawnOptions?.env).toBe(env);
    } finally {
      await client.close();
    }
  });

  test("稳定方法保持 app-server method 与 params 原样", async () => {
    const fake = new FakeAppServer();
    const client = await fake.startClient();
    try {
      const responses = await Promise.all([
        client.threadStart({ cwd: "/daemon/sessions/new" }),
        client.threadResume({ threadId: "thread-1", cwd: "/daemon/sessions/existing" }),
        client.turnStart({
          threadId: "thread-1",
          input: [{ type: "text", text: "你好", text_elements: [] }],
        }),
        client.turnInterrupt({ threadId: "thread-1", turnId: "turn-1" }),
        client.threadUnsubscribe({ threadId: "thread-1" }),
      ]);

      expect(responses.map((response) => (response as { method: string }).method)).toEqual([
        "thread/start",
        "thread/resume",
        "turn/start",
        "turn/interrupt",
        "thread/unsubscribe",
      ]);
      expect(fake.messages.slice(2).map((message) => message.method)).toEqual([
        "thread/start",
        "thread/resume",
        "turn/start",
        "turn/interrupt",
        "thread/unsubscribe",
      ]);
    } finally {
      await client.close();
    }
  });

  test("可解析拆分的无 jsonrpc NDJSON 通知与 RPC error", async () => {
    const fake = new FakeAppServer();
    const notifications: string[] = [];
    const client = await fake.startClient({
      onNotification: (notification) => {
        notifications.push(notification.method);
      },
    });
    try {
      await fake.send({ method: "turn/started", params: { turn: { id: "turn-1" } } }, 7);
      await waitFor(() => notifications.length === 1, "turn/started 通知");
      expect(notifications).toEqual(["turn/started"]);

      fake.onMessage = async (message) => {
        if (message.method === "turn/start") {
          await fake.send({
            id: message.id,
            error: { code: -32_000, message: "synthetic failure", data: { retryable: false } },
          });
        }
      };
      const failure = client.turnStart({ threadId: "thread-1", input: [] });
      await expect(failure).rejects.toBeInstanceOf(CodexAppServerRpcError);
      await expect(failure).rejects.toThrow("synthetic failure");
      expect(client.pendingRequestCount).toBe(0);
    } finally {
      await client.close();
    }
  });

  test("捕获审批请求并按协议默认明确拒绝", async () => {
    const fake = new FakeAppServer();
    const approvals: string[] = [];
    const client = await fake.startClient({
      onApprovalRequest: (request) => {
        approvals.push(request.method);
        if (request.id === 103) throw new Error("观察回调失败");
      },
    });
    try {
      await fake.send({
        id: 101,
        method: "item/commandExecution/requestApproval",
        params: { command: "git status" },
      });
      await fake.send({
        id: 102,
        method: "execCommandApproval",
        params: { command: ["git", "status"] },
      });
      await fake.send({
        id: 103,
        method: "item/permissions/requestApproval",
        params: { permissions: { network: ["example.com"] } },
      });
      await waitFor(
        () => fake.messages.filter((message) => [101, 102, 103].includes(message.id as number)).length === 3,
        "审批拒绝响应",
      );

      expect(approvals).toEqual([
        "item/commandExecution/requestApproval",
        "execCommandApproval",
        "item/permissions/requestApproval",
      ]);
      expect(fake.messages.find((message) => message.id === 101)).toEqual({
        id: 101,
        result: { decision: "decline" },
      });
      expect(fake.messages.find((message) => message.id === 102)).toEqual({
        id: 102,
        result: {
          decision: {
            denied: { rejection: "LiViS 远程通道未启用审批控制，已默认拒绝" },
          },
        },
      });
      expect(fake.messages.find((message) => message.id === 103)).toEqual({
        id: 103,
        error: {
          code: -32_001,
          message: "LiViS 远程通道未启用审批控制，已默认拒绝",
        },
      });
      expect(JSON.stringify(fake.messages.slice(2))).not.toContain("accept");
      expect(JSON.stringify(fake.messages.slice(2))).not.toContain("approved");
    } finally {
      await client.close();
    }
  });

  test("已知 server request 缺少有效 id 时关闭传输而不是当作普通通知", async () => {
    const methods = [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/tool/requestUserInput",
      "mcpServer/elicitation/request",
      "item/permissions/requestApproval",
      "item/tool/call",
      "account/chatgptAuthTokens/refresh",
      "attestation/generate",
      "currentTime/read",
      "applyPatchApproval",
      "execCommandApproval",
    ];
    for (const method of methods) {
      for (const invalidId of [undefined, null, { nested: true }]) {
        const fake = new FakeAppServer();
        const notifications: string[] = [];
        const client = await fake.startClient({
          onNotification: (notification) => {
            notifications.push(notification.method);
          },
        });
        try {
          fake.onMessage = async () => undefined;
          const pending = client.turnStart({ threadId: "thread-1", input: [] });
          const request: Record<string, unknown> = { method, params: {} };
          if (invalidId !== undefined) request.id = invalidId;
          await fake.send(request);
          await expect(pending).rejects.toBeInstanceOf(CodexAppServerRequestTransportError);
          await expect(pending).rejects.toThrow("server request 缺少有效 id");
          await expect(pending).rejects.toThrow(method);
          await client.exited;
          expect(notifications).toEqual([]);
        } finally {
          await client.close();
        }
      }
    }
  });

  test("stdout 在进程仍存活时 EOF 会立即关闭 transport 并拒绝活动请求", async () => {
    const fake = new FakeAppServer();
    const client = await fake.startClient();
    try {
      fake.onMessage = () => undefined;
      const pending = client.turnStart({ threadId: "thread-1", input: [] });
      await waitFor(() => client.pendingRequestCount === 1, "活动 turn/start 请求");

      await fake.closeStdoutOnly();

      await expect(pending).rejects.toBeInstanceOf(CodexAppServerRequestTransportError);
      await expect(pending).rejects.toThrow("stdout 在进程退出前意外关闭");
      expect(client.pendingRequestCount).toBe(0);
      expect(() => client.request("synthetic/after-eof")).toThrow(
        "stdout 在进程退出前意外关闭",
      );
    } finally {
      await client.close();
    }
  });

  test("请求超时会清理 pending，迟到响应不会复活请求", async () => {
    const fake = new FakeAppServer();
    const client = await fake.startClient();
    try {
      fake.onMessage = () => undefined;
      const request = client.request("synthetic/hang", {}, 15);
      await expect(request).rejects.toBeInstanceOf(CodexAppServerTimeoutError);
      try {
        await request;
      } catch (error) {
        expect((error as CodexAppServerTimeoutError).written).toBeTrue();
      }
      expect(client.pendingRequestCount).toBe(0);

      const requestMessage = fake.messages.find((message) => message.method === "synthetic/hang");
      await fake.send({ id: requestMessage?.id, result: { tooLate: true } });
      await Bun.sleep(5);
      expect(client.pendingRequestCount).toBe(0);
    } finally {
      await client.close();
    }
  });

  test("慢写一旦开始就标记为结果不确定，禁止把 timeout 当作未发送", async () => {
    const fake = new FakeAppServer();
    const client = await fake.startClient();
    const gate = deferred<void>();
    fake.writeGate = gate;
    try {
      fake.onMessage = () => undefined;
      const request = client.request("synthetic/slow-write", {}, 15);
      try {
        await request;
        throw new Error("slow write 应当超时");
      } catch (error) {
        expect(error).toBeInstanceOf(CodexAppServerTimeoutError);
        expect((error as CodexAppServerTimeoutError).written).toBeTrue();
      }
      expect(fake.messages.some((message) => message.method === "synthetic/slow-write")).toBeFalse();

      gate.resolve();
      await waitFor(
        () => fake.messages.some((message) => message.method === "synthetic/slow-write"),
        "慢写最终离开 client",
      );
    } finally {
      gate.resolve();
      await client.close();
    }
  });

  test("排队请求在开始写入前超时后不会迟到写出，可安全报告 written=false", async () => {
    const fake = new FakeAppServer();
    const client = await fake.startClient();
    const gate = deferred<void>();
    fake.writeGate = gate;
    try {
      const first = client.request("synthetic/first", {}, 1_000);
      const queued = client.request("synthetic/queued", {}, 15);
      try {
        await queued;
        throw new Error("queued request 应当超时");
      } catch (error) {
        expect(error).toBeInstanceOf(CodexAppServerTimeoutError);
        expect((error as CodexAppServerTimeoutError).written).toBeFalse();
      }

      gate.resolve();
      await first;
      await Bun.sleep(10);
      expect(fake.messages.some((message) => message.method === "synthetic/queued")).toBeFalse();
    } finally {
      gate.resolve();
      await client.close();
    }
  });

  test("进程退出拒绝全部 pending，stderr 独立有界收集", async () => {
    const fake = new FakeAppServer();
    const client = await fake.startClient({ stderrMaxBytes: 8 });
    fake.onMessage = () => undefined;
    const pendingA = client.request("synthetic/a", {}, 1_000);
    const pendingB = client.request("synthetic/b", {}, 1_000);
    await waitFor(() => client.pendingRequestCount === 2, "两个 pending 请求");
    await fake.writeStderr("0123456789abcdef");
    await fake.stop(17);

    await expect(pendingA).rejects.toBeInstanceOf(CodexAppServerRequestTransportError);
    await expect(pendingB).rejects.toThrow("stdout 在进程退出前意外关闭");
    await waitFor(() => client.exitCode === 17, "进程退出状态");
    expect(client.pendingRequestCount).toBe(0);
    expect(client.stderrText).toBe("89abcdef");
    expect(client.stderrTruncated).toBeTrue();
    expect(new TextEncoder().encode(client.stderrText).byteLength).toBeLessThanOrEqual(8);
    await client.close();
  });

  test("close 幂等，并在 SIGTERM 无效时升级 SIGKILL 后等待直接 child 与 stdio", async () => {
    const fake = new FakeAppServer();
    fake.ignoreSigterm = true;
    const client = await fake.startClient({ closeTimeoutMs: 15 });

    const first = client.close();
    const second = client.close();
    expect(second).toBe(first);
    await first;

    expect(fake.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(client.exitCode).toBe(0);
  });

  test("SIGKILL 后直接 child 或 stdio 仍未收口时明确失败", async () => {
    const fake = new FakeAppServer();
    fake.ignoreAllSignals = true;
    const client = await fake.startClient({ closeTimeoutMs: 10 });

    try {
      await expect(client.close()).rejects.toBeInstanceOf(CodexAppServerCloseUnconfirmedError);
      expect(fake.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      await fake.stop(137);
    }
  });

  test("注入进程组控制时必须以 PGID 收口，不能只依赖直接 child kill", async () => {
    const fake = new FakeAppServer();
    let groupExists = true;
    const signals: Array<number | NodeJS.Signals> = [];
    const groups: number[] = [];
    const controller: CodexProcessGroupController = {
      signal(processGroupId, signal) {
        groups.push(processGroupId);
        signals.push(signal);
        groupExists = false;
        void fake.stop(0);
      },
      exists() {
        return groupExists;
      },
    };
    const client = await fake.startClient({ processGroupController: controller });

    await client.close();

    expect(groups).toEqual([42_424]);
    expect(signals).toEqual(["SIGTERM"]);
    expect(fake.killSignals).toEqual([]);
  });
});
