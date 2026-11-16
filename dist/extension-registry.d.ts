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
export declare const EXTRA_SEARCH: Record<string, SearchExtension>;
export declare const EXTRA_GET: Record<string, GetExtension>;
/** Every shopify_manage operation, keyed by name (built-in ones included). */
export declare const MANAGE_OPERATIONS: Record<string, ManageOperation>;
export declare function registerSearchResource(name: string, def: SearchExtension): void;
export declare function registerGetResource(name: string, def: GetExtension): void;
export declare function registerManageOperation(name: string, def: ManageOperation): void;
/** REQUIRED_SCOPES entries for every registered extension. */
export declare function extensionScopes(): Record<string, string[]>;
