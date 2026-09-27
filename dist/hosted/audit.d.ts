/** One tool call. */
export interface AuditEntry {
    event?: "tool_call";
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
    /** Read-only calls: the first 2,000 characters of a `query` argument. */
    query?: string;
    truncated?: boolean;
    /** Set when the call was authenticated with a personal access token. The id, never the value. */
    tokenId?: string;
}
/** Sign-in, token, and request-authorization events. Tokens are never included. */
export interface AuthAuditEntry {
    event: "sign_in" | "sign_in_denied" | "consent_approved" | "consent_denied" | "personal_token_created" | "personal_token_revoked" | "token_issued" | "token_refreshed" | "refresh_denied" | "request_unauthorized" | "request_forbidden" | "shopify_connected" | "shopify_connect_denied" | "shopify_disconnected";
    timestamp: string;
    user?: string;
    clientId?: string;
    /** Personal access token id (never the token value). */
    tokenId?: string;
    status?: number;
    reason?: string;
    /** Store alias for Shopify connection events. */
    store?: string;
    /** Shopify staff account for Shopify connection events: user id and email as Shopify reported them. */
    shopifyUserId?: string;
    shopifyEmail?: string;
}
/** One shopify_run_action call. Variables are recorded only as a hash. */
export interface ActionAuditEntry {
    event: "action_run";
    timestamp: string;
    user: string;
    role?: string;
    tokenId?: string;
    mutations: string[];
    stores: string[];
    dryRun: boolean;
    variablesSha256: string;
    outcome: Array<{
        store: string;
        ok: boolean;
        error?: string;
        userErrors?: number;
    }>;
}
export type AuditRecord = AuditEntry | AuthAuditEntry | ActionAuditEntry;
export interface AuditLog {
    write(entry: AuditRecord): Promise<void>;
}
/** Longest string kept for any logged argument value. */
export declare const AUDIT_MAX_STRING = 2000;
/** Longest audit line, in bytes. */
export declare const AUDIT_MAX_LINE_BYTES: number;
/** Cut a string to the audit limit, saying how much was dropped. */
export declare function capString(value: string, max?: number): string;
/**
 * Prepare mutation arguments for the audit log: secrets become [REDACTED], customer email,
 * phone and address values become a sha256 of their canonical JSON (so equal values can still
 * be correlated), and every string is capped at AUDIT_MAX_STRING characters.
 */
export declare function auditArguments(value: unknown, depth?: number): unknown;
/** Serialize one audit line, dropping argument detail if the line would exceed AUDIT_MAX_LINE_BYTES. */
export declare function auditLine(entry: AuditRecord): string;
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
    write(entry: AuditRecord): Promise<void>;
}
