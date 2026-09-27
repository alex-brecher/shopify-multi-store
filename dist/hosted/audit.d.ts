/** One tool call. */
export interface AuditEntry {
    event?: "tool_call";
    timestamp: string;
    user: string;
    tool: string;
    stores: string[];
    readOnly: boolean;
    ok: boolean;
    /** Structured failure detail. Never free-form error text, which can echo customer data. */
    error?: AuditErrorInfo;
    durationMs: number;
    argsSha256?: string;
    /** The arguments as auditArguments() reduces them: no free text, documents summarized. */
    args?: unknown;
    truncated?: boolean;
    /** Store alias to the Shopify staff email the call ran as. */
    shopifyAccounts?: Record<string, string>;
}
/** Sign-in, token, and request-authorization events. Tokens are never included. */
export interface AuthAuditEntry {
    event: "sign_in" | "sign_in_denied" | "consent_approved" | "consent_denied" | "token_issued" | "token_refreshed" | "refresh_denied" | "request_unauthorized" | "request_forbidden" | "shopify_connected" | "shopify_connect_denied" | "shopify_disconnected";
    timestamp: string;
    user?: string;
    clientId?: string;
    status?: number;
    reason?: string;
    /** Structured failure detail (never the error text). */
    error?: AuditErrorInfo;
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
    mutations: string[];
    stores: string[];
    dryRun: boolean;
    variablesSha256: string;
    /** Per store; shopifyEmail is the Shopify staff account the call ran as. */
    outcome: Array<{
        store: string;
        ok: boolean;
        error?: AuditErrorInfo;
        userErrors?: number;
        shopifyEmail?: string;
    }>;
}
export type AuditRecord = AuditEntry | AuthAuditEntry | ActionAuditEntry;
export interface AuditLog {
    write(entry: AuditRecord): Promise<void>;
}
/**
 * What the audit log keeps about a failed tool call. Error messages can echo customer data
 * (a userErrors message quoting an email, an HTTP body with an address), so the text itself is
 * never stored: only a class, machine-readable codes, schema field paths, the HTTP status, and a
 * sha256 of the full message so an operator can match a line against a message they hold.
 */
export interface AuditErrorInfo {
    /**
     * access_denied, http_error, throttled, timeout, graphql_errors, user_errors, exception or
     * tool_error; action_run lines also use preflight, refused, dry_run_problems, not_run and
     * the store's outcome (rejected, partial, unknown, failed).
     */
    class: string;
    /** JavaScript error name when the tool threw (Error, TypeError, ...). */
    exception?: string;
    httpStatus?: number;
    /** Shopify error codes, e.g. ACCESS_DENIED, THROTTLED, TAKEN, INVALID. */
    codes?: string[];
    /** userErrors field paths, e.g. input.email. Schema names and list indexes only. */
    fields?: string[];
    messageSha256: string;
}
/**
 * Reduce a tool failure to structured, PII-free audit detail. `thrown` is an exception the tool
 * raised; `result` is an isError tool result. Codes and field paths come from structured content
 * (and from JSON embedded in the message); free text only contributes the HTTP status and
 * upper-case error codes. The full message is kept only as a sha256.
 */
export declare function auditError(thrown: unknown, result?: unknown, errorClass?: string): AuditErrorInfo;
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
