import { auditLine, type AuditLog, type AuditRecord } from "../hosted/audit.js";
import type { D1DatabaseLike } from "./types.js";

/**
 * Audit log in Cloudflare D1. Each line is the same PII-free JSON the Node server appends to
 * audit.jsonl, plus a few indexed columns for queries. D1 rather than Workers Logs because an
 * audit log must be durable and queryable for as long as the operator decides: Workers Logs
 * keeps only a few days, cannot be queried with SQL, and may be sampled. If a D1 write fails
 * (or no D1 binding is configured) the line goes to Workers Logs instead, so it is not lost
 * silently.
 */
export class D1AuditLog implements AuditLog {
  private ready?: Promise<unknown>;

  constructor(private readonly db: D1DatabaseLike | undefined) {}

  private ensureTable(db: D1DatabaseLike): Promise<unknown> {
    this.ready ??= db.prepare(
      "CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, event TEXT NOT NULL, user TEXT, tool TEXT, ok INTEGER, line TEXT NOT NULL)"
    ).run().then(() => db.prepare("CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts)").run()).catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  async write(entry: AuditRecord): Promise<void> {
    const line = auditLine(entry);
    if (!this.db) {
      console.log(`audit ${line}`);
      return;
    }
    try {
      await this.ensureTable(this.db);
      const record = entry as { event?: string; user?: string; tool?: string; ok?: boolean };
      await this.db.prepare("INSERT INTO audit (ts, event, user, tool, ok, line) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(entry.timestamp, record.event ?? "tool_call", record.user ?? null, record.tool ?? null, record.ok === undefined ? null : record.ok ? 1 : 0, line)
        .run();
    } catch (error) {
      console.error(`audit (D1 write failed: ${error instanceof Error ? error.message : String(error)}) ${line}`);
    }
  }
}
