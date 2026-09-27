import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Kind, parse, visit, type DocumentNode, type FragmentDefinitionNode, type SelectionSetNode } from "graphql";

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
  event:
    | "sign_in"
    | "sign_in_denied"
    | "consent_approved"
    | "consent_denied"
    | "personal_token_created"
    | "personal_token_revoked"
    | "token_issued"
    | "token_refreshed"
    | "refresh_denied"
    | "request_unauthorized"
    | "request_forbidden";
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
const ENUM_KEY = /(^status$|Status$|^sortKey$|^sortOrder$|^matchBy$|^layout$|^currencyCode$)/;
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
  if (typeof slim.error === "string") slim.error = capString(slim.error, 500);
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
