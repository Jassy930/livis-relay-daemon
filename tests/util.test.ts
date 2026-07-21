import { describe, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DurableCommitUncertainError,
  atomicWritePrivate,
  durableAtomicWritePrivate,
  durableRename,
  parseSemverTriplet,
  versionAtLeast,
  versionLessThan,
} from "../src/util.ts";
import { temporaryDirectory } from "./helpers.ts";

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

describe("durable 文件提交", () => {
  test("rename 后父目录 fsync 失败必须报告 durability 未确认", async () => {
    const directory = await temporaryDirectory("livis-durable-write-");
    try {
      const path = join(directory.path, "config.json");
      await expect(durableAtomicWritePrivate(path, "committed-but-not-confirmed\n", {
        syncParentDirectory: async () => {
          throw new Error("injected directory fsync failure");
        },
      })).rejects.toBeInstanceOf(DurableCommitUncertainError);
      expect(await readFile(path, "utf8")).toBe("committed-but-not-confirmed\n");
    } finally {
      await directory.cleanup();
    }
  });

  test("quarantine rename 后目录 fsync 失败同样报告 durability 未确认", async () => {
    const directory = await temporaryDirectory("livis-durable-rename-");
    try {
      const sourceDirectory = join(directory.path, "source");
      const destinationDirectory = join(directory.path, "destination");
      await mkdir(sourceDirectory, { mode: 0o700 });
      await mkdir(destinationDirectory, { mode: 0o700 });
      const source = join(sourceDirectory, "proof.json");
      const destination = join(destinationDirectory, "proof.json");
      await atomicWritePrivate(source, "proof evidence\n");
      await expect(durableRename(source, destination, {
        syncDirectory: async () => {
          throw new Error("injected quarantine directory fsync failure");
        },
      })).rejects.toBeInstanceOf(DurableCommitUncertainError);
      expect(await Bun.file(source).exists()).toBeFalse();
      expect(await readFile(destination, "utf8")).toBe("proof evidence\n");
    } finally {
      await directory.cleanup();
    }
  });
});
