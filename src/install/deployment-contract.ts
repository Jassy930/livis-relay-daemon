export const DEPLOYMENT_BACKENDS = ["hermes", "codex", "claude"] as const;
export type DeploymentBackend = typeof DEPLOYMENT_BACKENDS[number];

export const DEPLOYMENT_SERVICE_MANAGERS = ["launchd", "systemd", "none"] as const;
export type DeploymentServiceManager = typeof DEPLOYMENT_SERVICE_MANAGERS[number];

export type DeploymentOperation = "install" | "upgrade";
export type DeploymentReceiptStatus =
  | "prepared"
  | "installed"
  | "upgraded"
  | "rolled-back"
  | "uninstalled";

export interface DeploymentArtifactIdentity {
  manifestSha256: string;
  sourceArtifactSha256: string;
  bridgeArtifactSha256: string;
  version: string;
  gitCommit: string;
}

export interface DeploymentServicePlan {
  manager: DeploymentServiceManager;
  definitionPath: string | null;
  definitionSha256: string | null;
  manageService: boolean;
  stopRequired: boolean;
  reloadRequired: boolean;
  startRequired: boolean;
  explicitAcknowledgementRequired: boolean;
}

export interface DeploymentPlan {
  schemaVersion: 1;
  operation: DeploymentOperation;
  backend: DeploymentBackend;
  installRoot: string;
  releasePath: string;
  configPath: string;
  stateDir: string;
  bunPath: string;
  artifacts: DeploymentArtifactIdentity;
  service: DeploymentServicePlan;
  hermesHome: string | null;
  credentialHandling: "native-state-unmanaged";
  credentialsReadOrMigrated: false;
}

export interface DeploymentPointer {
  schemaVersion: 1;
  releasePath: string;
  version: string;
  gitCommit: string;
  sourceArtifactSha256: string;
  backend: DeploymentBackend;
  configPath: string;
  receiptPath: string;
}

export interface DeploymentReceipt {
  schemaVersion: 1;
  kind: "livis-relay-deployment";
  operationId: string;
  operation: DeploymentOperation;
  status: DeploymentReceiptStatus;
  createdAt: string;
  completedAt: string | null;
  plan: DeploymentPlan;
  previousDeployment: DeploymentPointer | null;
  installedDeployment: DeploymentPointer;
  previousServiceDefinitionSha256: string | null;
  previousServiceDefinitionBackupPath: string | null;
  hermesInstallReceiptPath: string | null;
  serviceRestartPerformed: boolean;
  credentialsReadOrMigrated: false;
  receiptPath: string;
  rolledBackAt?: string;
  uninstalledAt?: string;
}

export interface DeploymentServiceController {
  readonly manager: Exclude<DeploymentServiceManager, "none">;
  readonly definitionPath: string;
  inspect(): Promise<{
    installed: boolean;
    active: boolean;
    definitionText: string | null;
  }>;
  stop(): Promise<void>;
  writeDefinition(text: string): Promise<void>;
  removeDefinition(): Promise<void>;
  reload(): Promise<void>;
  start(): Promise<void>;
}

export interface DeploymentCommandRunner {
  run(command: readonly string[], options: { cwd?: string }): Promise<void>;
}
