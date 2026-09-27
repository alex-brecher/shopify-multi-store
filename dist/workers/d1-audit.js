import { auditLine } from "../hosted/audit.js";
/**
 * Audit log in Cloudflare D1. Each line is the same PII-free JSON the Node server appends to
 * audit.jsonl, plus a few indexed columns for queries. D1 rather than Workers Logs because an
 * audit log must be durable and queryable for as long as the operator decides: Workers Logs
 * keeps only a few days, cannot be queried with SQL, and may be sampled. If a D1 write fails
 * (or no D1 binding is configured) the line goes to Workers Logs instead, so it is not lost
 * silently.
 */
export class D1AuditLog {
    db;
    ready;
    constructor(db) {
        this.db = db;
    }
    ensureTable(db) {
        this.ready ??= db.prepare("CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, event TEXT NOT NULL, user TEXT, tool TEXT, ok INTEGER, line TEXT NOT NULL)").run().then(() => db.prepare("CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts)").run()).catch((error) => {
            this.ready = undefined;
            throw error;
        });
        return this.ready;
    }
    async write(entry) {
        const line = auditLine(entry);
        if (!this.db) {
            console.log(`audit ${line}`);
            return;
        }
        try {
            await this.ensureTable(this.db);
            const record = entry;
            await this.db.prepare("INSERT INTO audit (ts, event, user, tool, ok, line) VALUES (?, ?, ?, ?, ?, ?)")
                .bind(entry.timestamp, record.event ?? "tool_call", record.user ?? null, record.tool ?? null, record.ok === undefined ? null : record.ok ? 1 : 0, line)
                .run();
        }
        catch (error) {
            console.error(`audit (D1 write failed: ${error instanceof Error ? error.message : String(error)}) ${line}`);
        }
    }
}
//# sourceMappingURL=d1-audit.js.map