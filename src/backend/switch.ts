import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { isAbsolute, join, resolve } from "node:path";
import {
  DEFAULT_CODEX_REQUEST_TIMEOUT_MS,
  DEFAULT_CODEX_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_CODEX_TURN_TIMEOUT_MS,
  loadRelayConfig,
  parseRelayConfig,
} from "../config.ts";
import {
  DaemonOfflineGuard,
  ProfileOperationGuard,
  rethrowAfterProfileOperationCleanup,
} from "../state/offline-guard.ts";
import {
  DurableCommitUncertainError,
  durableAtomicWritePrivate,
  durableMkdirPrivate,
  parseJsonObject,
  readPrivateFileText,
  sha256,
} from "../util.ts";

export type SwitchableBackend = "hermes" | "codex";

interface BacklogRow {
  backend: string;
  count: number;
}

interface DatabaseInspection {
  schemaVersion: number | null;
  backlog: BacklogRow[];
  accountBoundCodexSessions: number;
  quarantinedSessions: number;
}

export interface BackendSwitchOptions {
  configPath: string;
  targetBackend: SwitchableBackend;
  codexMode?: "native-current";
  codexCommand?: string;
  apply: boolean;
  acknowledgeDaemonStopped: boolean;
  acknowledgeRemoteExecution: boolean;
}

export interface BackendSwitchResult {
  ok: true;
  applied: boolean;
  changed: boolean;
  previousBackend: "hermes" | "codex" | "claude";
  targetBackend: SwitchableBackend;
  codexMode: "native-current" | null;
  configPath: string;
  previousConfigSha256: string;
  configSha256: string;
  backupConfigPath: string | null;
  receiptPath: string | null;
  commitMarkerPath: string | null;
  database: DatabaseInspection;
  next: string;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负整数`);
  }
  return value;
}

async function inspectDatabase(stateDir: string): Promise<DatabaseInspection> {
  const path = join(stateDir, "relay.db");
  if (!await Bun.file(path).exists()) {
    return {
      schemaVersion: null,
      backlog: [],
      accountBoundCodexSessions: 0,
      quarantinedSessions: 0,
    };
  }
  const database = new Database(path, { readonly: true, strict: true });
  try {
    const versionRow = database.query<{ user_version: number }, []>("PRAGMA user_version").get();
    const schemaVersion = nonNegativeInteger(versionRow?.user_version, "JobStore user_version");
    if (schemaVersion !== 8) {
      throw new Error(`backend switch 只接受 JobStore v8，当前为 v${schemaVersion}`);
    }
    const backlog = database.query<{
      target_backend: string;
      count: number;
    }, []>(`
      SELECT target_backend,COUNT(*) AS count
      FROM jobs
      WHERE status IN ('Received','Acked','Dispatching','Running','Cancelling')
      GROUP BY target_backend
      ORDER BY target_backend
    `).all().map((row) => ({
      backend: row.target_backend,
      count: nonNegativeInteger(row.count, "backend backlog count"),
    }));
    const accountBound = database.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count
      FROM backend_sessions
      WHERE backend='codex' AND COALESCE(state_ownership,'')<>'local-state-opaque'
    `).get();
    const quarantine = database.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM session_quarantine
    `).get();
    return {
      schemaVersion,
      backlog,
      accountBoundCodexSessions: nonNegativeInteger(
        accountBound?.count,
        "account-bound Codex session count",
      ),
      quarantinedSessions: nonNegativeInteger(
        quarantine?.count,
        "quarantined session count",
      ),
    };
  } finally {
    database.close();
  }
}

function buildTargetConfig(
  currentText: string,
  configPath: string,
  options: BackendSwitchOptions,
): string {
  const root = parseJsonObject(currentText, configPath);
  const previousExecution = root.execution;
  const execution = previousExecution !== null && typeof previousExecution === "object" &&
      !Array.isArray(previousExecution)
    ? { ...(previousExecution as Record<string, unknown>) }
    : {};
  execution.backend = options.targetBackend;
  root.execution = execution;

  if (options.targetBackend === "codex") {
    if (options.codexMode !== "native-current") {
      throw new Error("CLI backend switch 当前只允许显式 codex --mode native-current");
    }
    if (!options.codexCommand) {
      throw new Error("切换到 Codex native-current 必须传入 --command 绝对路径");
    }
    if (!isAbsolute(options.codexCommand)) {
      throw new Error("切换到 Codex native-current 必须传入 --command 绝对路径");
    }
    root.codex = {
      mode: "native-current",
      command: options.codexCommand,
      requestTimeoutMs: DEFAULT_CODEX_REQUEST_TIMEOUT_MS,
      turnTimeoutMs: DEFAULT_CODEX_TURN_TIMEOUT_MS,
      shutdownTimeoutMs: DEFAULT_CODEX_SHUTDOWN_TIMEOUT_MS,
      // dry-run 与 apply 必须生成同一目标配置；flag 只授权写操作，不改变计划内容。
      acknowledgeRemoteExecution: true,
    };
  }
  const text = `${JSON.stringify(root, null, 2)}\n`;
  parseRelayConfig(text, configPath);
  return text;
}

async function buildResult(
  options: BackendSwitchOptions,
  currentText: string,
  applied: boolean,
  backupConfigPath: string | null,
  receiptPath: string | null,
): Promise<BackendSwitchResult> {
  const loaded = await loadRelayConfig(options.configPath);
  if (loaded.text !== currentText && !applied) {
    throw new Error("配置在 backend switch 计划期间发生变化");
  }
  const sourceText = applied ? currentText : loaded.text;
  const targetText = buildTargetConfig(sourceText, loaded.path, options);
  const database = await inspectDatabase(loaded.config.stateDir);
  const changed = targetText !== sourceText;
  return {
    ok: true,
    applied,
    changed,
    previousBackend: loaded.config.execution.backend,
    targetBackend: options.targetBackend,
    codexMode: options.targetBackend === "codex" ? "native-current" : null,
    configPath: loaded.path,
    previousConfigSha256: sha256(sourceText),
    configSha256: sha256(targetText),
    backupConfigPath,
    receiptPath,
    commitMarkerPath: null,
    database,
    next: applied
      ? "运行 doctor --online；通过后只启动目标 backend 所需的常驻服务"
      : "停止 daemon，确认无 backend backlog 后加 --apply 与显式 acknowledgement 重跑",
  };
}

function assertSwitchableDatabase(
  database: DatabaseInspection,
  targetBackend: SwitchableBackend,
): void {
  if (database.backlog.length > 0) {
    throw new Error(
      `存在非终态 backend backlog：${database.backlog.map((item) => `${item.backend}=${item.count}`).join(", ")}；拒绝切换`,
    );
  }
  if (targetBackend === "codex" && database.accountBoundCodexSessions > 0) {
    throw new Error(
      "当前 stateDir 含 private-api-key/account-bound Codex session；禁止原地改为 native-current",
    );
  }
  if (database.quarantinedSessions > 0) {
    throw new Error("当前 stateDir 含 quarantined session；必须先保留证据并人工处置");
  }
}

export async function switchBackend(options: BackendSwitchOptions): Promise<BackendSwitchResult> {
  const initial = await loadRelayConfig(options.configPath);
  const initialText = await readPrivateFileText(initial.path, "backend switch live config");
  if (initialText !== initial.text) throw new Error("配置在 backend switch 加载期间发生变化");
  if (!options.apply) {
    return buildResult(options, initialText, false, null, null);
  }
  if (!options.acknowledgeDaemonStopped) {
    throw new Error("backend switch 写操作必须传入 --acknowledge-daemon-stopped");
  }
  if (options.targetBackend === "codex" && !options.acknowledgeRemoteExecution) {
    throw new Error("切换到 Codex 必须传入 --acknowledge-remote-execution");
  }

  const profileGuard = await ProfileOperationGuard.acquire(initial.config.stateDir, "backend-switch");
  let offlineGuard: DaemonOfflineGuard | null = null;
  try {
    offlineGuard = await DaemonOfflineGuard.acquire(
      initial.config.connector.socketPath,
      initial.config.stateDir,
      "backend-switch",
    );
    await profileGuard.assertHeldForStateDir(initial.config.stateDir);
    await offlineGuard.assertHeld();
    const currentText = await readPrivateFileText(initial.path, "backend switch live config");
    if (currentText !== initialText) {
      throw new Error("配置在 backend switch guard 获取期间发生变化，拒绝覆盖");
    }
    const current = await loadRelayConfig(initial.path);
    if (current.text !== currentText || resolve(current.config.stateDir) !== resolve(initial.config.stateDir)) {
      throw new Error("backend switch 配置或 stateDir 在 guard 获取期间发生变化");
    }
    const targetText = buildTargetConfig(currentText, current.path, options);
    const database = await inspectDatabase(current.config.stateDir);
    assertSwitchableDatabase(database, options.targetBackend);
    if (targetText === currentText) {
      await offlineGuard.release();
      offlineGuard = null;
      await profileGuard.release();
      return {
        ...(await buildResult(options, currentText, true, null, null)),
        changed: false,
      };
    }

    const directory = join(current.config.stateDir, "backend-switch-receipts");
    await durableMkdirPrivate(directory);
    const operationId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
    const backupConfigPath = join(directory, `${operationId}.config-backup.json`);
    const receiptPath = join(directory, `${operationId}.PREPARED.json`);
    const commitMarkerPath = join(directory, `${operationId}.CONFIG_COMMITTED.json`);
    await durableAtomicWritePrivate(backupConfigPath, currentText);
    const receipt = {
      schemaVersion: 1,
      kind: "livis-relay-backend-switch",
      status: "prepared",
      preparedAt: new Date().toISOString(),
      previousBackend: current.config.execution.backend,
      targetBackend: options.targetBackend,
      codexMode: options.targetBackend === "codex" ? "native-current" : null,
      previousConfigSha256: sha256(currentText),
      targetConfigSha256: sha256(targetText),
      backupConfigPath,
      database,
      credentialsReadOrMigrated: false,
      commitRule: "live config SHA-256 equals targetConfigSha256",
    };
    await durableAtomicWritePrivate(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    await profileGuard.assertHeldForStateDir(current.config.stateDir);
    await offlineGuard.assertHeld();
    if (await readPrivateFileText(current.path, "backend switch live config") !== currentText) {
      throw new Error("配置在 backend switch 提交前发生变化，拒绝覆盖");
    }
    await durableAtomicWritePrivate(current.path, targetText);
    try {
      const committedText = await readPrivateFileText(
        current.path,
        "backend switch committed config",
      );
      if (committedText !== targetText) {
        throw new Error("backend switch 配置提交后读回不一致");
      }
      const committed = await loadRelayConfig(current.path);
      if (
        committed.config.execution.backend !== options.targetBackend ||
        (options.targetBackend === "codex" && committed.config.codex.mode !== "native-current")
      ) {
        throw new Error("backend switch 配置提交后语义读回不一致");
      }
    } catch (error) {
      const liveText = await readPrivateFileText(current.path, "backend switch rollback readback")
        .catch(() => null);
      if (liveText === targetText) {
        await durableAtomicWritePrivate(current.path, currentText);
      } else if (liveText !== currentText) {
        throw new Error("backend switch 验证失败后配置状态不明，拒绝覆盖，必须人工恢复", {
          cause: error,
        });
      }
      if (await readPrivateFileText(current.path, "backend switch restored config") !== currentText) {
        throw new Error("backend switch 验证失败且自动恢复未通过读回", { cause: error });
      }
      throw new Error("backend switch 提交后验证失败，已自动恢复原配置", { cause: error });
    }
    let writtenCommitMarkerPath: string | null = commitMarkerPath;
    try {
      await durableAtomicWritePrivate(commitMarkerPath, `${JSON.stringify({
        schemaVersion: 1,
        kind: "livis-relay-backend-switch-commit",
        committedAt: new Date().toISOString(),
        configSha256: sha256(targetText),
        preparedReceiptPath: receiptPath,
      }, null, 2)}\n`);
    } catch {
      writtenCommitMarkerPath = null;
    }
    const result: BackendSwitchResult = {
      ok: true,
      applied: true,
      changed: true,
      previousBackend: current.config.execution.backend,
      targetBackend: options.targetBackend,
      codexMode: options.targetBackend === "codex" ? "native-current" : null,
      configPath: current.path,
      previousConfigSha256: sha256(currentText),
      configSha256: sha256(targetText),
      backupConfigPath,
      receiptPath,
      commitMarkerPath: writtenCommitMarkerPath,
      database,
      next: "运行 doctor --online；通过后只启动目标 backend 所需的常驻服务",
    };
    await offlineGuard.release();
    offlineGuard = null;
    await profileGuard.release();
    return result;
  } catch (error) {
    // durable rename 已发生但父目录 fsync 未确认时，保留两个 guard 作为人工恢复门禁；
    // 不能让服务管理器在配置提交状态仍不确定时重新拉起 daemon。
    if (error instanceof DurableCommitUncertainError) throw error;
    return rethrowAfterProfileOperationCleanup("backend switch", error, [
      ...(offlineGuard
        ? [{ label: "释放 daemon offline guard", run: () => offlineGuard!.release() }]
        : []),
      { label: "释放 profile operation guard", run: () => profileGuard.release() },
    ]);
  }
}
