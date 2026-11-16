import type { z } from "zod/v4";
import type { Data, Workflow } from "./admin-workflows.js";

/**
 * Extension points so each feature area (webhooks, content, discounts, ...) lives in its own
 * file under src/extensions/ and adds to the existing tools without editing shared files:
 *
 * - registerSearchResource: a new shopify_search resource (one list document)
 * - registerGetResource:    a new shopify_get resource (one by-ID document)
 * - registerManageOperation: a new shopify_manage operation (guarded write)
 *
 * Every registration carries its Shopify scopes, which REQUIRED_SCOPES picks up, so
 * shopify_check_access and print-scopes stay complete. src/extensions/index.ts imports every
 * area; the tool modules import that index before they read these maps.
 */

export interface SearchExtension {
  /** A query document with $first and $after, plus $query and/or $type when it takes them. */
  document: string;
  scopes: string[];
  description: string;
  /** "type" when the listing needs the type argument. */
  requires?: "type";
}

export interface GetExtension {
  /** A query document with $id (and optionally $first/$after). */
  document: string;
  /** The top-level field the record comes back under. */
  root: string;
  /** Allowed GID types for id, such as ["WebhookSubscription"]. */
  types: string[];
  label: string;
  scopes: string[];
  description: string;
}

export interface ManageOperation {
  description: string;
  shape: z.ZodRawShape;
  scopes: string[];
  handler: (w: Workflow, a: Data) => Promise<Data>;
  /** For irreversible operations: the word confirm must equal before dryRun:false runs. */
  confirmWord?: (a: Data) => string | undefined;
}

export const EXTRA_SEARCH: Record<string, SearchExtension> = {};
export const EXTRA_GET: Record<string, GetExtension> = {};
/** Every shopify_manage operation, keyed by name (built-in ones included). */
export const MANAGE_OPERATIONS: Record<string, ManageOperation> = {};

function unique(map: Record<string, unknown>, name: string, what: string): void {
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(name)) throw new Error(`Bad ${what} name ${name}.`);
  if (name in map) throw new Error(`${what} ${name} is registered twice.`);
}

export function registerSearchResource(name: string, def: SearchExtension): void {
  unique(EXTRA_SEARCH, name, "search resource");
  EXTRA_SEARCH[name] = def;
}

export function registerGetResource(name: string, def: GetExtension): void {
  unique(EXTRA_GET, name, "get resource");
  EXTRA_GET[name] = def;
}

export function registerManageOperation(name: string, def: ManageOperation): void {
  unique(MANAGE_OPERATIONS, name, "manage operation");
  MANAGE_OPERATIONS[name] = def;
}

/** REQUIRED_SCOPES entries for every registered extension. */
export function extensionScopes(): Record<string, string[]> {
  return {
    ...Object.fromEntries(Object.entries(EXTRA_SEARCH).map(([name, def]) => [`shopify_search:${name}`, def.scopes])),
    ...Object.fromEntries(Object.entries(EXTRA_GET).map(([name, def]) => [`shopify_get:${name}`, def.scopes]))
  };
}
