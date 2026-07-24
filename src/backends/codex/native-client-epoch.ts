export interface CodexNativeClientEpochReceipt {
  clientEpoch: number;
  productionReady: false;
}

interface ActiveClientEpoch {
  client: object;
  receipt: CodexNativeClientEpochReceipt;
}

/**
 * 只对 Relay 自己的 stdio app-server client 做进程内代际 fencing。
 *
 * 本类不发 RPC、不读取本地账号或凭据状态，也不连接 Desktop daemon。Relay 重启后的持久 fencing
 * 仍由 job lease、run generation、attempt ledger 与 thread checkpoint 负责。
 */
export class CodexNativeClientEpochFence {
  private nextEpoch = 0;
  private active: ActiveClientEpoch | null = null;

  attach(client: object): CodexNativeClientEpochReceipt {
    const receipt: CodexNativeClientEpochReceipt = {
      clientEpoch: ++this.nextEpoch,
      productionReady: false,
    };
    this.active = { client, receipt };
    return receipt;
  }

  isCurrent(receipt: CodexNativeClientEpochReceipt, client: object): boolean {
    return this.active?.receipt === receipt && this.active.client === client;
  }

  invalidate(receipt: CodexNativeClientEpochReceipt, client: object): boolean {
    if (!this.isCurrent(receipt, client)) return false;
    this.active = null;
    return true;
  }
}
