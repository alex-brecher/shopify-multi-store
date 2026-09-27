import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Kind, parse, visit } from "graphql";
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
/** Codes recognized in plain text. Only underscore-joined upper-case tokens and a few known words. */
const TEXT_ERROR_CODE = /\b(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|THROTTLED|UNAUTHORIZED|FORBIDDEN)\b/g;
const FIELD_SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_]{0,63}|\d{1,9})$/;
const MAX_ERROR_ITEMS = 20;
function collectErrorDetail(value, codes, fields, flags, depth = 0) {
    if (depth > 12 || value === null || typeof value !== "object")
        return;
    if (Array.isArray(value)) {
        for (const item of value.slice(0, 200))
            collectErrorDetail(item, codes, fields, flags, depth + 1);
        return;
    }
    for (const [key, item] of Object.entries(value)) {
        if (key === "code" && typeof item === "string" && ERROR_CODE.test(item))
            codes.add(item);
        else if (key === "field" && Array.isArray(item) && item.length) {
            fields.add(item.slice(0, 10).map((part) => (typeof part === "string" || typeof part === "number") && FIELD_SEGMENT.test(String(part)) ? String(part) : "?").join("."));
        }
        if (key === "errors" && Array.isArray(item) && item.length)
            flags.graphql = true;
        if (key === "userErrors" && Array.isArray(item) && item.length)
            flags.user = true;
        collectErrorDetail(item, codes, fields, flags, depth + 1);
    }
}
/**
 * Reduce a tool failure to structured, PII-free audit detail. `thrown` is an exception the tool
 * raised; `result` is an isError tool result. Codes and field paths come from structured content
 * (and from JSON embedded in the message); free text only contributes the HTTP status and
 * upper-case error codes. The full message is kept only as a sha256.
 */
export function auditError(thrown, result, errorClass) {
    const content = result?.content;
    const message = thrown !== undefined
        ? (thrown instanceof Error ? thrown.message : String(thrown))
        : content?.find((item) => item.type === "text")?.text ?? "Tool returned an error.";
    const codes = new Set();
    const fields = new Set();
    const flags = { graphql: false, user: false };
    const structured = result?.structuredContent;
    if (structured !== undefined)
        collectErrorDetail(structured, codes, fields, flags);
    // Messages often embed a JSON body ("Response: {...}") or are JSON themselves.
    for (const start of [message.indexOf("{"), message.indexOf("[")].filter((index) => index >= 0)) {
        try {
            collectErrorDetail(JSON.parse(message.slice(start)), codes, fields, flags);
            break;
        }
        catch {
            // Not JSON (or truncated JSON); fall back to the text scan below.
        }
    }
    for (const match of message.matchAll(TEXT_ERROR_CODE))
        codes.add(match[0]);
    const status = /\bHTTP (\d{3})\b/.exec(message)?.[1];
    const httpStatus = status ? Number(status) : undefined;
    const exception = thrown instanceof Error && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(thrown.name) ? thrown.name : undefined;
    const derivedClass = /^Access denied:/.test(message) ? "access_denied"
        : codes.has("THROTTLED") || /\bthrottled\b/i.test(message) ? "throttled"
            : /did not respond within/.test(message) ? "timeout"
                : httpStatus !== undefined ? "http_error"
                    : flags.user ? "user_errors"
                        : flags.graphql ? "graphql_errors"
                            : thrown !== undefined ? "exception" : "tool_error";
    return {
        class: errorClass ?? derivedClass,
        ...(exception ? { exception } : {}),
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        ...(codes.size ? { codes: [...codes].sort().slice(0, MAX_ERROR_ITEMS) } : {}),
        ...(fields.size ? { fields: [...fields].sort().slice(0, MAX_ERROR_ITEMS) } : {}),
        messageSha256: sha256Hex(message)
    };
}
/** Longest string kept for any logged argument value. */
export const AUDIT_MAX_STRING = 2_000;
/** Longest audit line, in bytes. */
export const AUDIT_MAX_LINE_BYTES = 64 * 1024;
/**
 * Keys whose values are always hashed, even when the value is a number (a zip code or phone
 * number sent as a number).
 */
const PII_KEY = /(e-?mail|phone|address|^zip$|zip_?code|postal|name$)/i;
/** Keys that select stores. Their values are configured aliases, not customer data. */
const STORE_KEY = /^(store|stores|alias|aliases)$/;
const STORE_ALIAS = /^[a-z0-9][a-z0-9-]{0,63}$/i;
/** Keys that carry Shopify ids. Kept only when the value is a GID or a plain number. */
const ID_KEY = /(^id$|^ids$|Id$|Ids$)/;
const SHOPIFY_GID = /^gid:\/\/shopify\/[A-Za-z]+\/\d+$/;
const NUMERIC_ID = /^\d{1,20}$/;
/** Keys that carry a fixed set of values (status and sort enums, match modes). */
const ENUM_KEY = /(^status$|Status$|^sortKey$|^sortOrder$|^matchBy$|^layout$|^currencyCode$|^resource$|^report$|^action$)/;
const ENUM_VALUE = /^(?:[A-Z][A-Z0-9_]{0,39}|[a-z][a-z0-9-]{0,39})$/;
/** Cut a string to the audit limit, saying how much was dropped. */
export function capString(value, max = AUDIT_MAX_STRING) {
    return value.length <= max ? value : `${value.slice(0, max)}...[truncated ${value.length - max} chars]`;
}
function hashed(value) {
    return `[sha256:${sha256Hex(canonicalJson(value))}]`;
}
const MAX_NAMES = 100;
/**
 * Summarize a GraphQL document for the audit log: operation types, root field names (not
 * aliases), and argument names, plus a sha256 of the full text. Literal values, aliases,
 * operation names and variables never appear. Unparseable input is only hashed.
 */
export function summarizeGraphql(document) {
    let ast;
    try {
        ast = parse(document, { noLocation: true, maxTokens: 50_000 });
    }
    catch {
        return hashed(document);
    }
    const fragments = new Map();
    for (const definition of ast.definitions) {
        if (definition.kind === Kind.FRAGMENT_DEFINITION)
            fragments.set(definition.name.value, definition);
    }
    const rootFields = (selectionSet, seen, out) => {
        for (const selection of selectionSet.selections) {
            if (selection.kind === Kind.FIELD)
                out.add(selection.name.value);
            else if (selection.kind === Kind.INLINE_FRAGMENT)
                rootFields(selection.selectionSet, seen, out);
            else {
                const name = selection.name.value;
                const fragment = fragments.get(name);
                if (fragment && !seen.has(name)) {
                    seen.add(name);
                    rootFields(fragment.selectionSet, seen, out);
                }
            }
        }
    };
    const operations = [];
    for (const definition of ast.definitions) {
        if (definition.kind !== Kind.OPERATION_DEFINITION)
            continue;
        const fields = new Set();
        rootFields(definition.selectionSet, new Set(), fields);
        operations.push({ type: definition.operation, rootFields: [...fields].sort().slice(0, MAX_NAMES) });
    }
    const argumentNames = new Set();
    visit(ast, { Argument: (node) => { argumentNames.add(node.name.value); } });
    return {
        operations: operations.slice(0, MAX_NAMES),
        argumentNames: [...argumentNames].sort().slice(0, MAX_NAMES),
        documentSha256: sha256Hex(document)
    };
}
function keepString(key, value) {
    if (SHOPIFY_GID.test(value))
        return true;
    if (STORE_KEY.test(key))
        return STORE_ALIAS.test(value);
    if (ID_KEY.test(key))
        return NUMERIC_ID.test(value);
    if (ENUM_KEY.test(key))
        return ENUM_VALUE.test(value);
    return false;
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
export function auditArguments(value, options = {}, key = "", depth = 0) {
    if (depth > 20)
        return "[TRUNCATED]";
    if (key && SECRET_KEY.test(key))
        return "[REDACTED]";
    if (value === null || value === undefined)
        return value;
    if (depth === 1 && options.graphqlKeys?.includes(key) && typeof value === "string")
        return { graphql: summarizeGraphql(value) };
    if (key === "variables")
        return hashed(value);
    if (key && PII_KEY.test(key) && !STORE_KEY.test(key) && value !== "")
        return hashed(value);
    if (typeof value === "boolean" || typeof value === "number")
        return value;
    if (typeof value === "string")
        return keepString(key, value) ? value : hashed(value);
    if (Array.isArray(value))
        return value.slice(0, 1_000).map((item) => auditArguments(item, options, key, depth + 1));
    if (typeof value === "object") {
        const out = {};
        for (const [name, item] of Object.entries(value)) {
            // Object keys are argument names from the tool schema; anything odd is hashed too.
            const safeName = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) ? name : hashed(name);
            out[safeName] = auditArguments(item, options, name, depth + 1);
        }
        return out;
    }
    return hashed(String(value));
}
/** Serialize one audit line, dropping argument detail if the line would exceed AUDIT_MAX_LINE_BYTES. */
export function auditLine(entry) {
    let line = JSON.stringify(entry);
    if (Buffer.byteLength(line) <= AUDIT_MAX_LINE_BYTES)
        return line;
    const slim = { ...entry, truncated: true };
    delete slim.args;
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