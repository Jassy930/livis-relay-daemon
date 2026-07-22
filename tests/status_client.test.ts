import { describe, expect, test } from "bun:test";
import {
  DEFAULT_STATUS_TIMEOUT_MS,
  fetchDaemonStatus,
  type DaemonStatusFetch,
} from "../src/status-client.ts";

describe("本地 daemon status client", () => {
  test("使用 Unix socket、connector token 和有界 signal 请求状态", async () => {
    expect(DEFAULT_STATUS_TIMEOUT_MS).toBe(3_000);
    let capturedUrl = "";
    let capturedInit: (RequestInit & { unix: string }) | undefined;
    const fetchImpl: DaemonStatusFetch = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return Response.json({ ok: true });
    };

    const response = await fetchDaemonStatus("/private/status.sock", "connector-secret", {
      timeoutMs: 50,
      fetchImpl,
    });

    expect(capturedUrl).toBe("http://localhost/v1/status");
    expect(capturedInit?.unix).toBe("/private/status.sock");
    expect(new Headers(capturedInit?.headers).get("authorization")).toBe("Bearer connector-secret");
    expect(capturedInit?.signal).toBeDefined();
    expect(await response.json()).toEqual({ ok: true });
  });

  test("socket 接受后不响应会在请求超时后失败", async () => {
    const fetchImpl: DaemonStatusFetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        if (!signal) {
          reject(new Error("缺少 status 超时 signal"));
          return;
        }
        const rejectWithReason = () => reject(signal.reason);
        if (signal.aborted) rejectWithReason();
        else signal.addEventListener("abort", rejectWithReason, { once: true });
      });

    const startedAt = Date.now();
    let caught: unknown;
    try {
      await fetchDaemonStatus("/private/hanging.sock", "connector-secret", {
        timeoutMs: 20,
        fetchImpl,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe("TimeoutError");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
