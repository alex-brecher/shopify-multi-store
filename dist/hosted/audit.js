import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
/** Longest string kept for any logged argument value. */
export const AUDIT_MAX_STRING = 2_000;
/** Longest audit line, in bytes. */
export const AUDIT_MAX_LINE_BYTES = 64 * 1024;
/** Customer contact fields in mutation arguments. Their values are replaced with a hash. */
const PII_KEY = /(e-?mail|phone|address|^zip$|zip_?code|postal)/i;
/** Cut a string to the audit limit, saying how much was dropped. */
export function capString(value, max = AUDIT_MAX_STRING) {
    return value.length <= max ? value : `${value.slice(0, max)}...[truncated ${value.length - max} chars]`;
}
/**
 * Prepare mutation arguments for the audit log: secrets become [REDACTED], customer email,
 * phone and address values become a sha256 of their canonical JSON (so equal values can still
 * be correlated), and every string is capped at AUDIT_MAX_STRING characters.
 */
export function auditArguments(value, depth = 0) {
    if (depth > 20)
        return "[TRUNCATED]";
    if (typeof value === "string")
        return capString(value);
    if (Array.isArray(value))
        return value.map((item) => auditArguments(item, depth + 1));
    if (value && typeof value === "object") {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            if (SECRET_KEY.test(key))
                out[key] = "[REDACTED]";
            else if (PII_KEY.test(key) && item !== null && item !== undefined && item !== "")
                out[key] = `[PII sha256:${sha256Hex(canonicalJson(item))}]`;
            else
                out[key] = auditArguments(item, depth + 1);
        }
        return out;
    }
    return value;
}
/** Serialize one audit line, dropping argument detail if the line would exceed AUDIT_MAX_LINE_BYTES. */
export function auditLine(entry) {
    let line = JSON.stringify(entry);
    if (Buffer.byteLength(line) <= AUDIT_MAX_LINE_BYTES)
        return line;
    const slim = { ...entry, truncated: true };
    delete slim.args;
    if (typeof slim.query === "string")
        slim.query = capString(slim.query, 500);
    if (typeof slim.error === "string")
        slim.error = capString(slim.error, 500);
    if (typeof slim.reason === "string")
        slim.reason = capString(slim.reason, 500);
    line = JSON.stringify(slim);
    if (Buffer.byteLength(line) <= AUDIT_MAX_LINE_BYTES)
        return line;
    return JSON.stringify({ event: entry.event ?? "tool_call", timestamp: entry.timestamp, truncated: true });
}
const SECRET_KEY = /(token|secret|password|passwd|authorization|api[-_]?key|credential|cookie|private[-_]?key)/i;
/** Replace values under secret-looking keys. Tool arguments never carry credentials by design; this is a second guard. */
export function redact(value, depth = 0) {
    if (depth > 20)
        return "[TRUNCATED]";
    if (Array.isArray(value))
        return value.map((item) => redact(item, depth + 1));
    if (value && typeof value === "object") {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            out[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redact(item, depth + 1);
        }
        return out;
    }
    return value;
}
/** JSON with sorted object keys, so the argument hash does not depend on key order. */
export function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
        const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}
export function sha256Hex(value) {
    return createHash("sha256").update(value).digest("hex");
}
/** Append-only JSON Lines file. Writes are serialized so lines never interleave. */
export class FileAuditLog {
    path;
    queue = Promise.resolve();
    ready;
    constructor(path) {
        this.path = path;
    }
    write(entry) {
        const line = `${auditLine(entry)}\n`;
        this.ready ??= mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const next = this.queue.then(async () => {
            await this.ready;
            await appendFile(this.path, line, { encoding: "utf8", mode: 0o600, flag: "a" });
        });
        // Keep the queue alive after a failed write; report the failure to the caller.
        this.queue = next.catch(() => { });
        return next;
    }
}
//# sourceMappingURL=audit.js.map