import { describe, expect, test } from "bun:test";
import { errorMessage, LOG_STRING_MAX_BYTES } from "../src/logger.ts";

describe("有界日志错误", () => {
  test("截断异常和非 Error 值，避免外部输入扩张单条日志", () => {
    const external = `sentinel-${"x".repeat(LOG_STRING_MAX_BYTES * 2)}`;
    expect(errorMessage(new Error(external))).toBe(`[TRUNCATED bytes=${Buffer.byteLength(external)}]`);
    expect(errorMessage(external)).not.toContain("sentinel");
    expect(errorMessage(new Error("bounded"))).toBe("bounded");
  });
});
