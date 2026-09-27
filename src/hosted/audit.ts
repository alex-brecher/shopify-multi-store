import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Kind, parse, visit, type DocumentNode, type FragmentDefinitionNode, type SelectionSetNode } from "graphql";

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
  event:
    | "sign_in"
    | "sign_in_denied"
    | "consent_approved"
    | "consent_denied"
    | "token_issued"
    | "token_refreshed"
    | "refresh_denied"
    | "request_unauthorized"
    | "request_forbidden"
    | "shopify_connected"
    | "shopify_connect_denied"
    | "shopify_disconnected";
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
  outcome: Array<{ store: string; ok: boolean; error?: AuditErrorInfo; userErrors?: number; shopifyEmail?: string }>;
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

const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
/** Codes recognized in plain text. Only underscore-joined upper-case tokens and a few known words. */
const TEXT_ERROR_CODE = /\b(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|THROTTLED|UNAUTHORIZED|FORBIDDEN)\b/g;
const FIELD_SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_]{0,63}|\d{1,9})$/;
const MAX_ERROR_ITEMS = 20;

function collectErrorDetail(value: unknown, codes: Set<string>, fields: Set<string>, flags: { graphql: boolean; user: boolean }, depth = 0): void {
  if (depth > 12 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) collectErrorDetail(item, codes, fields, flags, depth + 1);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "code" && typeof item === "string" && ERROR_CODE.test(item)) codes.add(item);
    else if (key === "field" && Array.isArray(item) && item.length) {
      fields.add(item.slice(0, 10).map((part) => (typeof part === "string" || typeof part === "number") && FIELD_SEGMENT.test(String(part)) ? String(part) : "?").join("."));
    }
    if (key === "errors" && Array.isArray(item) && item.length) flags.graphql = true;
    if (key === "userErrors" && Array.isArray(item) && item.length) flags.user = true;
    collectErrorDetail(item, codes, fields, flags, depth + 1);
  }
}

/**
 * Reduce a tool failure to structured, PII-free audit detail. `thrown` is an exception the tool
 * raised; `result` is an isError tool result. Codes and field paths come from structured content
 * (and from JSON embedded in the message); free text only contributes the HTTP status and
 * upper-case error codes. The full message is kept only as a sha256.
 */
export function auditError(thrown: unknown, result?: unknown, errorClass?: string): AuditErrorInfo {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  const message = thrown !== undefined
    ? (thrown instanceof Error ? thrown.message : String(thrown))
    : content?.find((item) => item.type === "text")?.text ?? "Tool returned an error.";
  const codes = new Set<string>();
  const fields = new Set<string>();
  const flags = { graphql: false, user: false };
  const structured = (result as { structuredContent?: unknown } | undefined)?.structuredContent;
  if (structured !== undefined) collectErrorDetail(structured, codes, fields, flags);
  // Messages often embed a JSON body ("Response: {...}") or are JSON themselves.
  for (const start of [message.indexOf("{"), message.indexOf("[")].filter((index) => index >= 0)) {
    try {
      collectErrorDetail(JSON.parse(message.slice(start)), codes, fields, flags);
      break;
    } catch {
      // Not JSON (or truncated JSON); fall back to the text scan below.
    }
  }
  for (const match of message.matchAll(TEXT_ERROR_CODE)) codes.add(match[0]);
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
export function capString(value: string, max = AUDIT_MAX_STRING): string {
  return value.length <= max ? value : `${value.slice(0, max)}...[truncated ${value.length - max} chars]`;
}

function hashed(value: unknown): string {
  return `[sha256:${sha256Hex(canonicalJson(value))}]`;
}

/** What the audit log keeps of a GraphQL document: its shape, never its literal values. */
export interface GraphqlAuditSummary {
  operations: Array<{ type: string; rootFields: string[] }>;
  argumentNames: string[];
  documentSha256: string;
}

const MAX_NAMES = 100;

/**
 * Summarize a GraphQL document for the audit log: operation types, root field names (not
 * aliases), and argument names, plus a sha256 of the full text. Literal values, aliases,
 * operation names and variables never appear. Unparseable input is only hashed.
 */
export function summarizeGraphql(document: string): GraphqlAuditSummary | string {
  let ast: DocumentNode;
  try {
    ast = parse(document, { noLocation: true, maxTokens: 50_000 });
  } catch {
    return hashed(document);
  }
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of ast.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) fragments.set(definition.name.value, definition);
  }
  const rootFields = (selectionSet: SelectionSetNode, seen: Set<string>, out: Set<string>): void => {
    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FIELD) out.add(selection.name.value);
      else if (selection.kind === Kind.INLINE_FRAGMENT) rootFields(selection.selectionSet, seen, out);
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
  const operations: GraphqlAuditSummary["operations"] = [];
  for (const definition of ast.definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) continue;
    const fields = new Set<string>();
    rootFields(definition.selectionSet, new Set(), fields);
    operations.push({ type: definition.operation, rootFields: [...fields].sort().slice(0, MAX_NAMES) });
  }
  const argumentNames = new Set<string>();
  visit(ast, { Argument: (node) => { argumentNames.add(node.name.value); } });
  return {
    operations: operations.slice(0, MAX_NAMES),
    argumentNames: [...argumentNames].sort().slice(0, MAX_NAMES),
    documentSha256: sha256Hex(document)
  };
}

function keepString(key: string, value: string): boolean {
  if (SHOPIFY_GID.test(value)) return true;
  if (STORE_KEY.test(key)) return STORE_ALIAS.test(value);
  if (ID_KEY.test(key)) return NUMERIC_ID.test(value);
  if (ENUM_KEY.test(key)) return ENUM_VALUE.test(value);
  return false;
}

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
export function auditArguments(value: unknown, options: AuditArgumentOptions = {}, key = "", depth = 0): unknown {
  if (depth > 20) return "[TRUNCATED]";
  if (key && SECRET_KEY.test(key)) return "[REDACTED]";
  if (value === null || value === undefined) return value;
  if (depth === 1 && options.graphqlKeys?.includes(key) && typeof value === "string") return { graphql: summarizeGraphql(value) };
  if (key === "variables") return hashed(value);
  if (key && PII_KEY.test(key) && !STORE_KEY.test(key) && value !== "") return hashed(value);
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return keepString(key, value) ? value : hashed(value);
  if (Array.isArray(value)) return value.slice(0, 1_000).map((item) => auditArguments(item, options, key, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
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
export function auditLine(entry: AuditRecord): string {
  let line = JSON.stringify(entry);
  if (Buffer.byteLength(line) <= AUDIT_MAX_LINE_BYTES) return line;
  const slim: Record<string, unknown> = { ...entry, truncated: true };
  delete slim.args;
  if (typeof slim.reason === "string") slim.reason = capString(slim.reason, 500);
  line = JSON.stringify(slim);
  if (Buffer.byteLength(line) <= AUDIT_MAX_LINE_BYTES) return line;
  return JSON.stringify({ event: (entry as { event?: string }).event ?? "tool_call", timestamp: entry.timestamp, truncated: true });
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

  write(entry: AuditRecord): Promise<void> {
    const line = `${auditLine(entry)}\n`;
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
