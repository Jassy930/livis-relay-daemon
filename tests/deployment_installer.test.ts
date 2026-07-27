import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  DeploymentCommandRunner,
  DeploymentServiceController,
} from "../src/install/deployment-contract.ts";
import {
  applyDeployment,
  planDeployment,
  rollbackDeployment,
  uninstallDeployment,
  type DeploymentPlanOptions,
} from "../src/install/deployment.ts";
import { buildReleaseArtifacts } from "../src/release/artifacts.ts";
import { atomicWritePrivate, sha256 } from "../src/util.ts";
import { temporaryDirectory, testConfig } from "./helpers.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr || stdout);
}

async function formalReleaseFixture(commit = "1".repeat(40)): Promise<{
  root: string;
  manifestPath: string;
  manifestSha256: string;
  mutateForUpgrade: (nextCommit: string) => Promise<void>;
}> {
  const directory = await temporaryDirectory("livis-deployment-release-");
  cleanups.push(directory.cleanup);
  const built = await buildReleaseArtifacts({
    projectRoot: PROJECT_ROOT,
    outputDirectory: directory.path,
  });
  const makeFormal = async (gitCommit: string): Promise<string> => {
    const manifest = JSON.parse(await readFile(built.manifestPath, "utf8")) as {
      gitCommit: string | null;
      sourceTree: string;
      artifacts: Array<{
        kind: string;
        file: string;
        root: string;
        sha256: string;
        sizeBytes: number;
      }>;
    };
    manifest.gitCommit = gitCommit;
    manifest.sourceTree = "clean-git";
    await writeFile(built.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return sha256(await readFile(built.manifestPath));
  };
  const fixture: {
    root: string;
    manifestPath: string;
    manifestSha256: string;
    mutateForUpgrade: (nextCommit: string) => Promise<void>;
  } = {
    root: directory.path,
    manifestPath: built.manifestPath,
    manifestSha256: await makeFormal(commit),
    mutateForUpgrade: async (nextCommit: string) => {
      const manifest = JSON.parse(await readFile(built.manifestPath, "utf8")) as {
        gitCommit: string | null;
        sourceTree: string;
        artifacts: Array<{
          kind: string;
          file: string;
          root: string;
          sha256: string;
          sizeBytes: number;
        }>;
      };
      const source = manifest.artifacts.find((item) => item.kind === "source-tarball")!;
      const extraction = join(directory.path, "upgrade-extraction");
      await mkdir(extraction, { mode: 0o700 });
      const artifactPath = join(directory.path, source.file);
      await run(["tar", "-xzf", artifactPath, "-C", extraction]);
      await writeFile(join(extraction, source.root, "docs/deployment-upgrade-marker.md"), "升级测试标记\n");
      const nextArtifact = join(directory.path, ".source-upgrade.tar.gz");
      await run(["tar", "-czf", nextArtifact, "-C", extraction, source.root]);
      await unlink(artifactPath);
      await rename(nextArtifact, artifactPath);
      await rm(extraction, { recursive: true, force: true });
      const bytes = await readFile(artifactPath);
      source.sha256 = sha256(bytes);
      source.sizeBytes = bytes.byteLength;
      manifest.gitCommit = nextCommit;
      manifest.sourceTree = "clean-git";
      await writeFile(built.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      fixture.manifestSha256 = sha256(await readFile(built.manifestPath));
    },
  };
  return fixture;
}

async function configFixture(backend: "hermes" | "codex" | "claude" = "codex"): Promise<{
  stateDir: string;
  configPath: string;
}> {
  const state = await temporaryDirectory("livis-deployment-state-");
  cleanups.push(state.cleanup);
  await chmod(state.path, 0o700);
  const config = testConfig(state.path);
  config.execution.backend = backend;
  if (backend === "codex") {
    config.codex.mode = "native-current";
    config.codex.command = "/usr/bin/true";
    config.codex.acknowledgeRemoteExecution = true;
  }
  if (backend === "claude") {
    config.claude.mode = "native-current";
    config.claude.command = "/usr/bin/true";
    config.claude.acknowledgeRemoteExecution = true;
  }
  const configPath = join(state.path, "config.json");
  const serialized = JSON.parse(JSON.stringify(config)) as {
    codex: Record<string, unknown>;
  };
  if (backend === "codex") delete serialized.codex.provider;
  await atomicWritePrivate(configPath, `${JSON.stringify(serialized, null, 2)}\n`);
  return { stateDir: state.path, configPath };
}

class FakeCommandRunner implements DeploymentCommandRunner {
  readonly commands: string[][] = [];

  async run(command: readonly string[], options: { cwd?: string }): Promise<void> {
    this.commands.push([...command]);
    if (command[1] === "install") await mkdir(join(options.cwd!, "node_modules"), { mode: 0o700 });
  }
}

class FakeServiceController implements DeploymentServiceController {
  readonly manager = "launchd" as const;
  active = false;
  definitionText: string | null = null;
  readonly calls: string[] = [];

  constructor(readonly definitionPath: string) {}

  async inspect() {
    this.calls.push("inspect");
    return {
      installed: this.definitionText !== null,
      active: this.active,
      definitionText: this.definitionText,
    };
  }

  async stop(): Promise<void> {
    this.calls.push("stop");
    this.active = false;
  }

  async writeDefinition(text: string): Promise<void> {
    this.calls.push("write");
    this.definitionText = text;
  }

  async removeDefinition(): Promise<void> {
    this.calls.push("remove");
    this.definitionText = null;
  }

  async reload(): Promise<void> {
    this.calls.push("reload");
  }

  async start(): Promise<void> {
    this.calls.push("start");
    this.active = true;
  }
}

async function baseOptions(serviceManager: "none" | "launchd" = "none") {
  const release = await formalReleaseFixture();
  const config = await configFixture("codex");
  const install = await temporaryDirectory("livis-deployment-install-parent-");
  cleanups.push(install.cleanup);
  const installRoot = join(install.path, "deployment");
  const home = await temporaryDirectory("livis-deployment-home-");
  cleanups.push(home.cleanup);
  const options: DeploymentPlanOptions = {
    manifestPath: release.manifestPath,
    manifestSha256: release.manifestSha256,
    configPath: config.configPath,
    installRoot,
    serviceManager,
    bunPath: process.execPath,
    homeDirectory: home.path,
    platform: "darwin",
  };
  return { release, config, installRoot, home, options };
}

describe("部署安装器事务", () => {
  test("plan 为零写入并拒绝未固定或 working-tree manifest", async () => {
    const fixture = await baseOptions();
    const plan = await planDeployment(fixture.options);
    expect(plan).toMatchObject({
      operation: "install",
      backend: "codex",
      credentialHandling: "native-state-unmanaged",
      credentialsReadOrMigrated: false,
      service: { manager: "none", definitionPath: null },
    });
    expect(await Bun.file(fixture.installRoot).exists()).toBeFalse();

    await expect(planDeployment({
      ...fixture.options,
      manifestSha256: "0".repeat(64),
    })).rejects.toThrow("固定值不一致");

    const manifest = JSON.parse(await readFile(fixture.release.manifestPath, "utf8"));
    manifest.sourceTree = "working-tree";
    manifest.gitCommit = null;
    await writeFile(fixture.release.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(planDeployment({
      ...fixture.options,
      manifestSha256: sha256(await readFile(fixture.release.manifestPath)),
    })).rejects.toThrow("只接受 clean-git");
  });

  test("install、upgrade、rollback、uninstall 保留不可变 release 与 stateDir", async () => {
    const fixture = await baseOptions();
    const firstRunner = new FakeCommandRunner();
    const installed = await applyDeployment({
      ...fixture.options,
      requestedOperation: "install",
      apply: true,
      commandRunner: firstRunner,
    });
    expect(installed.status).toBe("installed");
    expect(installed.credentialsReadOrMigrated).toBeFalse();
    expect(firstRunner.commands.map((item) => item.slice(1, 3))).toEqual([
      ["install", "--frozen-lockfile"],
      ["run", "version:check"],
      ["run", "capabilities:check"],
    ]);
    expect((await lstat(installed.receiptPath)).mode & 0o777).toBe(0o600);
    expect(await Bun.file(join(installed.plan.releasePath, ".livis-release.json")).exists()).toBeTrue();
    expect((await lstat(fixture.config.stateDir)).isDirectory()).toBeTrue();

    await fixture.release.mutateForUpgrade("2".repeat(40));
    fixture.options.manifestSha256 = fixture.release.manifestSha256;
    const upgraded = await applyDeployment({
      ...fixture.options,
      requestedOperation: "upgrade",
      apply: true,
      acknowledgeStateBackup: true,
      commandRunner: new FakeCommandRunner(),
    });
    expect(upgraded.status).toBe("upgraded");
    expect(upgraded.previousDeployment?.receiptPath).toBe(installed.receiptPath);
    expect(upgraded.plan.releasePath).not.toBe(installed.plan.releasePath);
    expect((await lstat(installed.plan.releasePath)).isDirectory()).toBeTrue();

    const rolledBack = await rollbackDeployment({
      installRoot: fixture.installRoot,
      receiptPath: upgraded.receiptPath,
      apply: true,
      acknowledgeStateCompatibility: true,
    });
    expect(rolledBack.status).toBe("rolled-back");
    const currentAfterRollback = await Bun.file(join(fixture.installRoot, "current.json")).json();
    expect(currentAfterRollback.receiptPath).toBe(installed.receiptPath);

    const uninstalled = await uninstallDeployment({
      installRoot: fixture.installRoot,
      apply: true,
      acknowledgeUninstall: true,
    });
    expect(uninstalled.status).toBe("uninstalled");
    expect(await Bun.file(join(fixture.installRoot, "current.json")).exists()).toBeFalse();
    expect((await lstat(installed.plan.releasePath)).isDirectory()).toBeTrue();
    expect((await lstat(upgraded.plan.releasePath)).isDirectory()).toBeTrue();
    expect((await lstat(fixture.config.stateDir)).isDirectory()).toBeTrue();
  });

  test("服务副作用必须显式确认且只经注入控制器执行", async () => {
    const fixture = await baseOptions("launchd");
    const plan = await planDeployment({ ...fixture.options, manageService: true });
    const controller = new FakeServiceController(plan.service.definitionPath!);
    await expect(applyDeployment({
      ...fixture.options,
      manageService: true,
      apply: true,
      commandRunner: new FakeCommandRunner(),
      serviceController: controller,
    })).rejects.toThrow("acknowledge-service-restart");
    expect(controller.calls).toEqual([]);

    const receipt = await applyDeployment({
      ...fixture.options,
      manageService: true,
      apply: true,
      acknowledgeServiceRestart: true,
      commandRunner: new FakeCommandRunner(),
      serviceController: controller,
    });
    expect(receipt.serviceRestartPerformed).toBeTrue();
    expect(controller.calls).toEqual(["inspect", "write", "inspect", "reload", "start"]);
    expect(controller.active).toBeTrue();
    expect(controller.definitionText).toContain(receipt.plan.releasePath);
  });

  test("提交点前失败会恢复服务定义且不留下活动部署指针", async () => {
    const fixture = await baseOptions("launchd");
    const plan = await planDeployment({ ...fixture.options, manageService: true });
    const controller = new FakeServiceController(plan.service.definitionPath!);
    await expect(applyDeployment({
      ...fixture.options,
      manageService: true,
      apply: true,
      acknowledgeServiceRestart: true,
      commandRunner: new FakeCommandRunner(),
      serviceController: controller,
      beforeCurrentCommit: () => {
        throw new Error("injected before current commit");
      },
    })).rejects.toThrow("injected before current commit");
    expect(await Bun.file(join(fixture.installRoot, "current.json")).exists()).toBeFalse();
    expect(controller.definitionText).toBeNull();
    expect(controller.active).toBeFalse();
    expect(controller.calls).toEqual([
      "inspect",
      "write",
      "inspect",
      "reload",
      "start",
      "stop",
      "remove",
      "reload",
    ]);
  });

  test("upgrade 拒绝覆盖部署后的服务定义人工改动", async () => {
    const fixture = await baseOptions("launchd");
    const firstPlan = await planDeployment(fixture.options);
    const controller = new FakeServiceController(firstPlan.service.definitionPath!);
    const installed = await applyDeployment({
      ...fixture.options,
      apply: true,
      acknowledgeDaemonStopped: true,
      commandRunner: new FakeCommandRunner(),
      serviceController: controller,
    });
    expect(installed.status).toBe("installed");
    controller.definitionText = `${controller.definitionText}\n# operator changed\n`;
    await fixture.release.mutateForUpgrade("3".repeat(40));
    fixture.options.manifestSha256 = fixture.release.manifestSha256;
    await expect(applyDeployment({
      ...fixture.options,
      apply: true,
      acknowledgeDaemonStopped: true,
      acknowledgeStateBackup: true,
      commandRunner: new FakeCommandRunner(),
      serviceController: controller,
    })).rejects.toThrow("服务定义已在部署后发生变化");
    const current = await Bun.file(join(fixture.installRoot, "current.json")).json();
    expect(current.receiptPath).toBe(installed.receiptPath);
  });

  test("plan 与 upgrade 会拒绝已安装 release 或依赖漂移", async () => {
    const fixture = await baseOptions();
    const installed = await applyDeployment({
      ...fixture.options,
      apply: true,
      commandRunner: new FakeCommandRunner(),
    });
    await writeFile(join(installed.plan.releasePath, "node_modules/operator-tamper.txt"), "tampered\n");
    await fixture.release.mutateForUpgrade("4".repeat(40));
    fixture.options.manifestSha256 = fixture.release.manifestSha256;
    await expect(planDeployment(fixture.options)).rejects.toThrow("release 或依赖在安装后发生变化");
    const current = await Bun.file(join(fixture.installRoot, "current.json")).json();
    expect(current.receiptPath).toBe(installed.receiptPath);
  });

  test("三后端 plan 不读取认证状态，Hermes 只要求显式专用 home", async () => {
    const release = await formalReleaseFixture();
    for (const backend of ["codex", "claude"] as const) {
      const config = await configFixture(backend);
      const target = await temporaryDirectory(`livis-plan-${backend}-`);
      cleanups.push(target.cleanup);
      const plan = await planDeployment({
        manifestPath: release.manifestPath,
        manifestSha256: release.manifestSha256,
        configPath: config.configPath,
        installRoot: join(target.path, "install"),
        serviceManager: "none",
        bunPath: process.execPath,
      });
      expect(plan.backend).toBe(backend);
      expect(plan.hermesHome).toBeNull();
      expect(plan.credentialsReadOrMigrated).toBeFalse();
    }

    const config = await configFixture("hermes");
    const target = await temporaryDirectory("livis-plan-hermes-");
    const hermes = await temporaryDirectory("livis-plan-hermes-home-");
    cleanups.push(target.cleanup, hermes.cleanup);
    await mkdir(join(hermes.path, "plugins"), { mode: 0o700 });
    await writeFile(join(hermes.path, "config.yaml"), "plugins:\n  enabled: []\n", { mode: 0o600 });
    await expect(planDeployment({
      manifestPath: release.manifestPath,
      manifestSha256: release.manifestSha256,
      configPath: config.configPath,
      installRoot: join(target.path, "install"),
      serviceManager: "none",
      bunPath: process.execPath,
    })).rejects.toThrow("--hermes-home");
    const plan = await planDeployment({
      manifestPath: release.manifestPath,
      manifestSha256: release.manifestSha256,
      configPath: config.configPath,
      installRoot: join(target.path, "install"),
      serviceManager: "none",
      bunPath: process.execPath,
      hermesHome: hermes.path,
    });
    expect(plan.backend).toBe("hermes");
    expect(plan.hermesHome).toBe(await realpath(hermes.path));
  });

  test("Hermes install 只使用已审计 bridge 快照并由部署收据回滚", async () => {
    const release = await formalReleaseFixture();
    const config = await configFixture("hermes");
    const target = await temporaryDirectory("livis-deploy-hermes-target-");
    const hermes = await temporaryDirectory("livis-deploy-hermes-runtime-");
    cleanups.push(target.cleanup, hermes.cleanup);
    await mkdir(join(hermes.path, "plugins"), { mode: 0o700 });
    const originalConfig = "# dedicated profile\nplugins:\n  enabled: []\n";
    await writeFile(join(hermes.path, "config.yaml"), originalConfig, { mode: 0o600 });
    const receipt = await applyDeployment({
      manifestPath: release.manifestPath,
      manifestSha256: release.manifestSha256,
      configPath: config.configPath,
      installRoot: join(target.path, "install"),
      serviceManager: "none",
      bunPath: process.execPath,
      hermesHome: hermes.path,
      apply: true,
      acknowledgeHermesStopped: true,
      commandRunner: new FakeCommandRunner(),
    });
    expect(receipt.hermesInstallReceiptPath).not.toBeNull();
    expect(await Bun.file(join(hermes.path, "plugins/livis-bridge/adapter.py")).exists()).toBeTrue();
    expect(await readFile(join(hermes.path, "config.yaml"), "utf8")).toContain("livis-bridge");

    const rolledBack = await rollbackDeployment({
      installRoot: join(target.path, "install"),
      receiptPath: receipt.receiptPath,
      apply: true,
      acknowledgeHermesStopped: true,
      acknowledgeStateCompatibility: true,
    });
    expect(rolledBack.status).toBe("rolled-back");
    expect(await Bun.file(join(hermes.path, "plugins/livis-bridge")).exists()).toBeFalse();
    expect(await readFile(join(hermes.path, "config.yaml"), "utf8")).toBe(originalConfig);
  });
});
