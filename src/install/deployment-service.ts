import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  DeploymentBackend,
  DeploymentServiceController,
  DeploymentServiceManager,
} from "./deployment-contract.ts";

export const LAUNCHD_LABEL = "com.local.livis-relayd";
export const SYSTEMD_UNIT = "livis-relayd.service";

export interface DeploymentServiceDefinitionOptions {
  manager: Exclude<DeploymentServiceManager, "none">;
  bunPath: string;
  releasePath: string;
  configPath: string;
  stateDir: string;
  homeDirectory: string;
  backend: DeploymentBackend;
  nativeHomeAccess: boolean;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdQuote(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", () => "$$")
    .replaceAll("%", "%%")}"`;
}

function assertServiceValue(value: string, label: string): void {
  if (/[\0\r\n]/.test(value)) throw new Error(`${label} 不能包含 NUL 或换行符`);
}

function servicePathValue(homeDirectory: string, bunPath: string): string {
  return [
    dirname(bunPath),
    join(homeDirectory, ".local/bin"),
    join(homeDirectory, ".bun/bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter((value, index, all) => all.indexOf(value) === index).join(":");
}

export function defaultServiceDefinitionPath(
  manager: DeploymentServiceManager,
  homeDirectory: string,
): string | null {
  if (manager === "launchd") {
    return resolve(homeDirectory, "Library/LaunchAgents/com.local.livis-relayd.plist");
  }
  if (manager === "systemd") {
    return resolve(homeDirectory, ".config/systemd/user/livis-relayd.service");
  }
  return null;
}

export function renderDeploymentServiceDefinition(
  options: DeploymentServiceDefinitionOptions,
): string {
  for (const [label, value] of Object.entries({
    bunPath: options.bunPath,
    releasePath: options.releasePath,
    configPath: options.configPath,
    stateDir: options.stateDir,
    homeDirectory: options.homeDirectory,
  })) {
    assertServiceValue(value, label);
  }
  const entrypoint = join(options.releasePath, "src/index.ts");
  const pathValue = servicePathValue(options.homeDirectory, options.bunPath);
  if (options.manager === "launchd") {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(options.bunPath)}</string>
    <string>run</string>
    <string>${xmlEscape(entrypoint)}</string>
    <string>serve</string>
    <string>--config</string>
    <string>${xmlEscape(options.configPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(options.releasePath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xmlEscape(options.homeDirectory)}</string>
    <key>PATH</key>
    <string>${xmlEscape(pathValue)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(options.stateDir, "daemon.stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(options.stateDir, "daemon.stderr.log"))}</string>
</dict>
</plist>
`;
  }

  const description = `LiViS 共享 Relay Daemon（${options.backend} backend）`;
  return `[Unit]
Description=${description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdQuote(options.releasePath)}
ExecStart=${[
    options.bunPath,
    "run",
    entrypoint,
    "serve",
    "--config",
    options.configPath,
  ].map(systemdQuote).join(" ")}
Environment=${systemdQuote(`HOME=${options.homeDirectory}`)}
Environment=${systemdQuote(`PATH=${pathValue}`)}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=${options.nativeHomeAccess ? "false" : "read-only"}
ReadWritePaths=${systemdQuote(options.stateDir)}
UMask=0077

[Install]
WantedBy=default.target
`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertSafeDefinitionParent(path: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const stats = await lstat(parent);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`服务定义父路径必须是非符号链接目录：${parent}`);
  }
  if (await realpath(parent) !== resolve(parent)) {
    throw new Error(`服务定义父路径不能经由符号链接解析：${parent}`);
  }
}

async function atomicWriteDefinition(path: string, text: string): Promise<void> {
  await assertSafeDefinitionParent(path);
  if (await exists(path)) {
    const current = await lstat(path);
    if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1) {
      throw new Error(`服务定义必须是单 link 普通文件：${path}`);
    }
  }
  const temporary = join(dirname(path), `.${path.split("/").at(-1)}.${crypto.randomUUID()}.tmp`);
  let committed = false;
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(text, "utf8");
      await handle.chmod(0o644);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    committed = true;
    await chmod(path, 0o644);
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (!committed) await rm(temporary, { force: true });
  }
}

async function readDefinition(path: string): Promise<string | null> {
  if (!await exists(path)) return null;
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
    throw new Error(`服务定义必须是单 link 普通文件：${path}`);
  }
  return readFile(path, "utf8");
}

async function removeDefinition(path: string): Promise<void> {
  if (!await exists(path)) return;
  await readDefinition(path);
  await unlink(path);
}

async function runServiceCommand(command: readonly string[], allowFailure = false): Promise<number> {
  const env: Record<string, string> = {};
  for (const key of ["HOME", "USER", "LOGNAME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  const child = Bun.spawn([...command], {
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await child.exited;
  if (!allowFailure && exitCode !== 0) {
    throw new Error(`服务命令失败（exit ${exitCode}）：${command.join(" ")}`);
  }
  return exitCode;
}

class LaunchdServiceController implements DeploymentServiceController {
  readonly manager = "launchd" as const;
  constructor(readonly definitionPath: string, private readonly uid: number) {}

  private get target(): string {
    return `gui/${this.uid}/${LAUNCHD_LABEL}`;
  }

  async inspect(): ReturnType<DeploymentServiceController["inspect"]> {
    return {
      installed: await exists(this.definitionPath),
      active: await runServiceCommand(["/bin/launchctl", "list", LAUNCHD_LABEL], true) === 0,
      definitionText: await readDefinition(this.definitionPath),
    };
  }

  async stop(): Promise<void> {
    if (await runServiceCommand(["/bin/launchctl", "bootout", this.target], true) !== 0) {
      const state = await this.inspect();
      if (state.active) throw new Error(`无法停止精确 launchd job：${this.target}`);
    }
  }

  writeDefinition(text: string): Promise<void> {
    return atomicWriteDefinition(this.definitionPath, text);
  }

  removeDefinition(): Promise<void> {
    return removeDefinition(this.definitionPath);
  }

  async reload(): Promise<void> {
    if (!await exists(this.definitionPath)) return;
    await runServiceCommand(["/bin/launchctl", "bootstrap", `gui/${this.uid}`, this.definitionPath]);
  }

  async start(): Promise<void> {
    await runServiceCommand(["/bin/launchctl", "kickstart", this.target]);
    if (!(await this.inspect()).active) throw new Error(`launchd job 启动后未加载：${this.target}`);
  }
}

class SystemdServiceController implements DeploymentServiceController {
  readonly manager = "systemd" as const;
  constructor(readonly definitionPath: string) {}

  async inspect(): ReturnType<DeploymentServiceController["inspect"]> {
    return {
      installed: await exists(this.definitionPath),
      active: await runServiceCommand(["/usr/bin/systemctl", "--user", "is-active", "--quiet", SYSTEMD_UNIT], true) === 0,
      definitionText: await readDefinition(this.definitionPath),
    };
  }

  async stop(): Promise<void> {
    await runServiceCommand(["/usr/bin/systemctl", "--user", "stop", SYSTEMD_UNIT]);
    if ((await this.inspect()).active) throw new Error(`systemd unit 停止后仍为 active：${SYSTEMD_UNIT}`);
  }

  writeDefinition(text: string): Promise<void> {
    return atomicWriteDefinition(this.definitionPath, text);
  }

  removeDefinition(): Promise<void> {
    return removeDefinition(this.definitionPath);
  }

  async reload(): Promise<void> {
    await runServiceCommand(["/usr/bin/systemctl", "--user", "daemon-reload"]);
  }

  async start(): Promise<void> {
    await runServiceCommand(["/usr/bin/systemctl", "--user", "start", SYSTEMD_UNIT]);
    if (!(await this.inspect()).active) throw new Error(`systemd unit 启动后未 active：${SYSTEMD_UNIT}`);
  }
}

export function createDeploymentServiceController(options: {
  manager: Exclude<DeploymentServiceManager, "none">;
  definitionPath: string;
  uid?: number;
}): DeploymentServiceController {
  if (options.manager === "launchd") {
    const uid = options.uid ?? process.getuid?.();
    if (!Number.isSafeInteger(uid) || Number(uid) < 0) {
      throw new Error("无法确定当前用户 uid，拒绝构造 launchd 控制器");
    }
    return new LaunchdServiceController(resolve(options.definitionPath), Number(uid));
  }
  return new SystemdServiceController(resolve(options.definitionPath));
}
