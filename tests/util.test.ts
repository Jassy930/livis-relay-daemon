import { describe, expect, test } from "bun:test";
import { parseSemverTriplet, versionAtLeast, versionLessThan } from "../src/util.ts";

describe("semver 工具", () => {
  test("从版本输出中提取三段版本号", () => {
    expect(parseSemverTriplet("0.15.1")).toEqual([0, 15, 1]);
    expect(parseSemverTriplet("hermes 0.15.1")).toEqual([0, 15, 1]);
    expect(parseSemverTriplet("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemverTriplet("no version here")).toBeNull();
  });

  test("预发布版本不视为已审核版本，默认拒绝", () => {
    expect(parseSemverTriplet("0.15.1-beta")).toBeNull();
    expect(parseSemverTriplet("hermes 1.2.3-rc.1")).toBeNull();
  });

  test("版本区间比较", () => {
    expect(versionAtLeast([0, 15, 1], [0, 15, 1])).toBeTrue();
    expect(versionAtLeast([0, 15, 0], [0, 15, 1])).toBeFalse();
    expect(versionLessThan([0, 15, 1], [0, 15, 2])).toBeTrue();
    expect(versionLessThan([0, 15, 2], [0, 15, 2])).toBeFalse();
  });
});
