import Ajv2020, { type ErrorObject } from "ajv/dist/2020";
import { isAbsolute, resolve } from "node:path";

export interface CapabilityEntry {
  id: string;
  direction: "livis-to-hermes" | "hermes-to-livis" | "bidirectional" | "local";
  status: "live-canary-verified" | "offline-verified" | "operator-only" | "unsupported";
  evidenceRefs: string[];
  testRefs: string[];
  notes: string;
}

export interface CapabilityManifest {
  schemaVersion: 1;
  package: {
    name: "livis-relay-daemon";
    version: string;
    license: "MIT";
    language: "zh-CN";
    phase: "phase1-multi-backend";
    officialEndorsement: false;
  };
  compatibility: Record<string, string>;
  topology: Record<string, string | boolean>;
  capabilities: CapabilityEntry[];
  safetyDefaults: Record<string, string | boolean>;
  commands: Record<string, string[]>;
  network: Record<string, boolean>;
  localData: Array<Record<string, unknown>>;
  release: {
    artifacts: string[];
    manifest: string;
    requiredGates: string[];
  };
}

export interface CapabilityValidationResult {
  manifest: CapabilityManifest;
  referencedPaths: string[];
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "不符合 schema"}`)
    .join("；");
}

function assertRelativeProjectPath(path: string): void {
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new Error(`能力契约引用必须是项目内相对路径：${path}`);
  }
}

export async function validateCapabilityManifest(
  projectRoot: string,
  manifestValue?: unknown,
  schemaValue?: unknown,
): Promise<CapabilityValidationResult> {
  const root = resolve(projectRoot);
  const manifest = manifestValue ?? await Bun.file(resolve(root, "capabilities.json")).json();
  const schema = schemaValue ?? await Bun.file(resolve(root, "schemas/capabilities.schema.json")).json();
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
  const validate = ajv.compile(schema);
  if (!validate(manifest)) {
    throw new Error(`capabilities.json 不符合 JSON Schema：${formatAjvErrors(validate.errors)}`);
  }

  const typed = manifest as CapabilityManifest;
  const ids = new Set<string>();
  const referencedPaths = new Set<string>();
  for (const capability of typed.capabilities) {
    if (ids.has(capability.id)) throw new Error(`capability.id 重复：${capability.id}`);
    ids.add(capability.id);
    if (capability.status === "live-canary-verified" && capability.evidenceRefs.length === 0) {
      throw new Error(`${capability.id} 标为 live-canary-verified 但没有 evidenceRefs`);
    }
    if (capability.status === "offline-verified" && capability.testRefs.length === 0) {
      throw new Error(`${capability.id} 标为 offline-verified 但没有 testRefs`);
    }
    for (const path of [...capability.evidenceRefs, ...capability.testRefs]) {
      assertRelativeProjectPath(path);
      referencedPaths.add(path);
    }
  }

  for (const path of referencedPaths) {
    if (!await Bun.file(resolve(root, path)).exists()) {
      throw new Error(`能力契约引用不存在：${path}`);
    }
  }

  return { manifest: typed, referencedPaths: [...referencedPaths].sort() };
}
