import { describe, expect, test } from "bun:test";
import {
  CodexNativeClientEpochFence,
} from "../src/backends/codex/native-client-epoch.ts";

describe("Codex native client epoch fence", () => {
  test("attach 只分配递增代际，不读取或保存账号状态", () => {
    const fence = new CodexNativeClientEpochFence();
    const firstClient = {};
    const secondClient = {};
    const first = fence.attach(firstClient);
    const second = fence.attach(secondClient);

    expect(first).toEqual({ clientEpoch: 1, productionReady: false });
    expect(second).toEqual({ clientEpoch: 2, productionReady: false });
    expect(Object.keys(second).sort()).toEqual(["clientEpoch", "productionReady"]);
    expect(fence.isCurrent(first, firstClient)).toBeFalse();
    expect(fence.isCurrent(second, secondClient)).toBeTrue();
  });

  test("旧代际不能 invalidate 新 client", () => {
    const fence = new CodexNativeClientEpochFence();
    const firstClient = {};
    const first = fence.attach(firstClient);
    const secondClient = {};
    const second = fence.attach(secondClient);

    expect(fence.invalidate(first, firstClient)).toBeFalse();
    expect(fence.isCurrent(second, secondClient)).toBeTrue();
    expect(fence.invalidate(second, secondClient)).toBeTrue();
    expect(fence.isCurrent(second, secondClient)).toBeFalse();
  });
});
