import { type AuditLog, type AuditRecord } from "../hosted/audit.js";
import type { D1DatabaseLike } from "./types.js";
/**
 * Audit log in Cloudflare D1. Each line is the same PII-free JSON the Node server appends to
 * audit.jsonl, plus a few indexed columns for queries. D1 rather than Workers Logs because an
 * audit log must be durable and queryable for as long as the operator decides: Workers Logs
 * keeps only a few days, cannot be queried with SQL, and may be sampled. If a D1 write fails
 * (or no D1 binding is configured) the line goes to Workers Logs instead, so it is not lost
 * silently.
 */
export declare class D1AuditLog implements AuditLog {
    private readonly db;
    private ready?;
    constructor(db: D1DatabaseLike | undefined);
    private ensureTable;
    write(entry: AuditRecord): Promise<void>;
}
