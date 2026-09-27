import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface AuditEntry {
  timestamp: string;
  user: string;
  role: string;
  tool: string;
  stores: string[];
  readOnly: boolean;
  ok: boolean;
  error?: string;
  durationMs: number;
  argsSha256?: string;
  args?: unknown;
}

export interface AuditLog {
  write(entry: AuditEntry): Promise<void>;
}

const SECRET_KEY = /(token|secret|password|passwd|authorization|api[-_]?key|credential|cookie|private[-_]?key)/i;

/** Replace values under secret-looking keys. Tool arguments never carry credentials by design; this is a second guard. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 20) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redact(item, depth + 1);
    }
    return out;
  }
  return value;
}

/** JSON with sorted object keys, so the argument hash does not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Append-only JSON Lines file. Writes are serialized so lines never interleave. */
export class FileAuditLog implements AuditLog {
  private queue: Promise<void> = Promise.resolve();
  private ready?: Promise<unknown>;

  constructor(private readonly path: string) {}

  write(entry: AuditEntry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    this.ready ??= mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const next = this.queue.then(async () => {
      await this.ready;
      await appendFile(this.path, line, { encoding: "utf8", mode: 0o600, flag: "a" });
    });
    // Keep the queue alive after a failed write; report the failure to the caller.
    this.queue = next.catch(() => {});
    return next;
  }
}
