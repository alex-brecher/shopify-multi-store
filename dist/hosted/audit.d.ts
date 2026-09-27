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
    /** The arguments as auditArguments() reduces them: no free text, documents summarized. */
    args?: unknown;
    truncated?: boolean;
    /** Set when the call was authenticated with a personal access token. The id, never the value. */
    tokenId?: string;
}
/** Sign-in, token, and request-authorization events. Tokens are never included. */
export interface AuthAuditEntry {
    event: "sign_in" | "sign_in_denied" | "consent_approved" | "consent_denied" | "personal_token_created" | "personal_token_revoked" | "token_issued" | "token_refreshed" | "refresh_denied" | "request_unauthorized" | "request_forbidden";
    timestamp: string;
    user?: string;
    clientId?: string;
    /** Personal access token id (never the token value). */
    tokenId?: string;
    status?: number;
    reason?: string;
}
export type AuditRecord = AuditEntry | AuthAuditEntry;
export interface AuditLog {
    write(entry: AuditRecord): Promise<void>;
}
/** Longest string kept for any logged argument value. */
export declare const AUDIT_MAX_STRING = 2000;
/** Longest audit line, in bytes. */
export declare const AUDIT_MAX_LINE_BYTES: number;
/** Cut a string to the audit limit, saying how much was dropped. */
export declare function capString(value: string, max?: number): string;
/** What the audit log keeps of a GraphQL document: its shape, never its literal values. */
export interface GraphqlAuditSummary {
    operations: Array<{
        type: string;
        rootFields: string[];
    }>;
    argumentNames: string[];
    documentSha256: string;
}
/**
 * Summarize a GraphQL document for the audit log: operation types, root field names (not
 * aliases), and argument names, plus a sha256 of the full text. Literal values, aliases,
 * operation names and variables never appear. Unparseable input is only hashed.
 */
export declare function summarizeGraphql(document: string): GraphqlAuditSummary | string;
export interface AuditArgumentOptions {
    /** Argument names that hold a GraphQL document for this tool. They are summarized, not stored. */
    graphqlKeys?: readonly string[];
}
/**
 * Reduce tool arguments to what the audit log may keep. The log never stores free text:
 * - values under secret-looking keys become [REDACTED];
 * - GraphQL documents (graphqlKeys) become a summary: operation types, root fields, argument
 *   names and a sha256 of the text, so inline literals such as query:"email:..." are dropped;
 * - `variables` become a sha256 of their canonical JSON;
 * - booleans, numbers and null are kept, except under customer-contact keys;
 * - strings are kept only when allowlisted: Shopify GIDs, store aliases under store keys,
 *   numeric ids under id keys, and enum values under status/sort keys;
 * - every other string, including search expressions, becomes [sha256:<hex>] of its value,
 *   so equal values can still be correlated.
 */
export declare function auditArguments(value: unknown, options?: AuditArgumentOptions, key?: string, depth?: number): unknown;
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
