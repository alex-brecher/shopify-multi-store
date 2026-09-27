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
/** Replace values under secret-looking keys. Tool arguments never carry credentials by design; this is a second guard. */
export declare function redact(value: unknown, depth?: number): unknown;
/** JSON with sorted object keys, so the argument hash does not depend on key order. */
export declare function canonicalJson(value: unknown): string;
export declare function sha256Hex(value: string): string;
/** Append-only JSON Lines file. Writes are serialized so lines never interleave. */
export declare class FileAuditLog implements AuditLog {
    private readonly path;
    private queue;
    private ready?;
    constructor(path: string);
    write(entry: AuditEntry): Promise<void>;
}
