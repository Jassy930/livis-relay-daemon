import type { CodexAppServerNotification } from "./app-server-client.ts";
import {
  attachCodexNativeStdio,
  type CodexNativeStdioAttachDependencies,
  type CodexNativeStdioAttachOptions,
  type CodexNativeStdioAttachment,
} from "./native-stdio.ts";
import { CodexNativeClientEpochFence } from "./native-client-epoch.ts";
import {
  CodexNativeSessionCoordinator,
  type CodexNativeSessionCoordinatorOptions,
} from "./native-session-coordinator.ts";
import type {
  ExecutionBackendHandlers,
  ExecutionSubmission,
} from "../execution-backend.ts";
import type { JobStore } from "../../state/store.ts";
import type { StoredJob } from "../../types.ts";

export interface CodexNativeSessionHarnessOptions {
  transport: Omit<CodexNativeStdioAttachOptions, "onNotification">;
  session: Omit<CodexNativeSessionCoordinatorOptions, "cliVersion">;
}

export interface CodexNativeSessionHarnessDependencies {
  store: JobStore;
  handlers: ExecutionBackendHandlers;
  clientEpochFence: CodexNativeClientEpochFence;
  attachDependencies?: CodexNativeStdioAttachDependencies;
}

interface NotificationTarget {
  coordinator: CodexNativeSessionCoordinator;
  clientEpoch: number;
}

/**
 * 把 stdio app-server 构造时固定的 notification callback 延迟绑定到 coordinator 的确切 client epoch。
 *
 * initialize 到 coordinator ready 之间没有合法 active attempt；这段窗口的 notification 只计数并
 * 丢弃，不保存内容。bind 后的每条事件都携带绑定时 epoch，旧 client 不能借迟到事件命中新代际。
 */
class CodexNativeNotificationBridge {
  private target: NotificationTarget | null = null;
  private stopped = false;
  private unboundNotificationCount = 0;

  readonly handle = (notification: CodexAppServerNotification): void => {
    const target = this.target;
    if (this.stopped || target === null) {
      this.unboundNotificationCount += 1;
      return;
    }
    target.coordinator.handleNotification(notification, target.clientEpoch);
  };

  bind(coordinator: CodexNativeSessionCoordinator): void {
    if (this.stopped || this.target !== null) {
      throw new Error("Codex native notification bridge 只能绑定一次");
    }
    this.target = { coordinator, clientEpoch: coordinator.clientEpoch };
  }

  stop(): void {
    this.stopped = true;
    this.target = null;
  }

  status(): Record<string, unknown> {
    return {
      bound: this.target !== null,
      clientEpoch: this.target?.clientEpoch ?? null,
      unboundNotificationCount: this.unboundNotificationCount,
    };
  }
}

async function closeAttachmentAfterStartFailure(
  attachment: CodexNativeStdioAttachment,
  primaryError: unknown,
): Promise<never> {
  if (!attachment.client.running) throw primaryError;
  try {
    await attachment.client.close();
  } catch (closeError) {
    throw new AggregateError(
      [primaryError, closeError],
      "Codex native harness 启动失败且 stdio app-server 收口未确认",
    );
  }
  throw primaryError;
}

/**
 * 原生 stdio app-server 与持久 session coordinator 的受控组合 harness。
 *
 * 本模块不进入 daemon/config，不读取账号状态、不连接 Desktop daemon，也不声明生产可用。唯一拥有的
 * 外部资源是 Relay 自己启动并负责收口的 stdio app-server。
 */
export class CodexNativeSessionHarness {
  readonly kind = "codex" as const;
  readonly executionId: string;

  private constructor(
    private readonly attachment: CodexNativeStdioAttachment,
    private readonly coordinator: CodexNativeSessionCoordinator,
    private readonly notificationBridge: CodexNativeNotificationBridge,
  ) {
    this.executionId = coordinator.executionId;
  }

  static async start(
    options: CodexNativeSessionHarnessOptions,
    dependencies: CodexNativeSessionHarnessDependencies,
  ): Promise<CodexNativeSessionHarness> {
    const notificationBridge = new CodexNativeNotificationBridge();
    const attachment = await attachCodexNativeStdio({
      ...options.transport,
      onNotification: notificationBridge.handle,
    }, dependencies.attachDependencies);

    let coordinator: CodexNativeSessionCoordinator | null = null;
    try {
      coordinator = await CodexNativeSessionCoordinator.start({
        ...options.session,
        cliVersion: attachment.cliVersion,
      }, {
        store: dependencies.store,
        client: attachment.client,
        handlers: dependencies.handlers,
        clientEpochFence: dependencies.clientEpochFence,
      });
      notificationBridge.bind(coordinator);
    } catch (error) {
      notificationBridge.stop();
      if (coordinator !== null) {
        try {
          await coordinator.stop();
        } catch (stopError) {
          throw new AggregateError(
            [error, stopError],
            "Codex native harness 绑定失败且 coordinator 收口未确认",
          );
        }
        throw error;
      }
      return closeAttachmentAfterStartFailure(attachment, error);
    }

    return new CodexNativeSessionHarness(attachment, coordinator, notificationBridge);
  }

  get ready(): boolean {
    return this.coordinator.ready;
  }

  get clientEpoch(): number {
    return this.coordinator.clientEpoch;
  }

  dispatch(job: StoredJob): Promise<ExecutionSubmission> {
    return this.coordinator.dispatch(job);
  }

  cancel(job: StoredJob): Promise<ExecutionSubmission> {
    return this.coordinator.cancel(job);
  }

  waitForIdle(): Promise<void> {
    return this.coordinator.waitForIdle();
  }

  async stop(): Promise<void> {
    this.notificationBridge.stop();
    await this.coordinator.stop();
  }

  status(): Record<string, unknown> {
    return {
      implementation: "codex-native-session-harness-prototype",
      ready: this.ready,
      executionId: this.executionId,
      transport: this.attachment.transport,
      compatibilityBasis: this.attachment.compatibilityBasis,
      versionRelation: this.attachment.versionRelation,
      cliVersion: this.attachment.cliVersion,
      appServerVersion: this.attachment.appServerVersion,
      ownsAppServerProcess: this.attachment.ownsAppServerProcess,
      touchedDesktopDaemon: this.attachment.touchedDesktopDaemon,
      notificationBinding: this.notificationBridge.status(),
      coordinator: this.coordinator.status(),
      productionReady: false,
    };
  }
}
