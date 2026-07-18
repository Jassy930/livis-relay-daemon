export type LogLevel = "debug" | "info" | "warn" | "error";

const SECRET_KEY_PATTERN = /token|authorization|secret|password|cookie/i;

function sanitize(value: unknown, key = "", seen = new WeakSet<object>()): unknown {
  if (SECRET_KEY_PATTERN.test(key)) {
    return "[REDACTED]";
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, "", seen));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
      childKey,
      sanitize(childValue, childKey, seen),
    ]),
  );
}

export class Logger {
  constructor(
    private readonly component: string,
    private readonly minimumLevel: LogLevel = "info",
  ) {}

  child(component: string): Logger {
    return new Logger(`${this.component}.${component}`, this.minimumLevel);
  }

  debug(message: string, fields: Record<string, unknown> = {}): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields: Record<string, unknown> = {}): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields: Record<string, unknown> = {}): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields: Record<string, unknown> = {}): void {
    this.write("error", message, fields);
  }

  private write(level: LogLevel, message: string, fields: Record<string, unknown>): void {
    const order: LogLevel[] = ["debug", "info", "warn", "error"];
    if (order.indexOf(level) < order.indexOf(this.minimumLevel)) {
      return;
    }
    const sanitizedFields = sanitize(fields) as Record<string, unknown>;
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      message,
      ...sanitizedFields,
    });
    if (level === "error" || level === "warn") {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
