import type { McpServer } from "@modelcontextprotocol/server";
import { storeAllowed, storeScope, type ActionAuditDetails, type UserShopifyAccess } from "../runtime.js";
import { auditArguments, canonicalJson, capString, sha256Hex, type AuditLog } from "./audit.js";
import type { Principal, Role } from "./policy.js";

/** Tools only an admin may call in hosted mode, whatever their annotations say. */
export const ADMIN_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "shopify_graphql_mutation",
  "shopify_run_action",
  "shopify_create_preview_store",
  "shopify_get_new_store_previews"
]);

/**
 * Generic write tools that are admin-only with the shared app token, but open to every
 * non-viewer in per-user mode, where the caller's own Shopify permissions limit them.
 */
export const PER_USER_OPEN_TOOLS: ReadonlySet<string> = new Set([
  "shopify_graphql_mutation",
  "shopify_run_action"
]);

export type ShopifyAccessMode = "per_user" | "app";

/**
 * Tools that need the local machine (Shopify CLI, local preview receipts).
 * They are not registered at all in hosted mode.
 */
export const HOSTED_DISABLED_TOOLS: ReadonlySet<string> = new Set([
  "shopify_create_preview_store",
  "shopify_get_new_store_previews",
  "shopify_get_new_store_preview_status",
  "shopify_get_preview_store"
]);

/** Arguments that refer to the server's local filesystem and are refused in hosted mode. */
export const HOSTED_DISABLED_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  shopify_upload_image: ["imageFile"]
};

/** Tools whose named arguments hold a GraphQL document. The audit log keeps only a summary of it. */
export const GRAPHQL_DOCUMENT_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  shopify_graphql_query: ["query"],
  shopify_graphql_query_many: ["query"],
  shopify_graphql_mutation: ["mutation"],
  shopify_bulk_export_start: ["query"]
};

/** Top-level argument names that select stores. */
const STORE_ARGUMENTS = ["store", "stores", "alias"] as const;

export function toolAllowedForRole(role: Role, tool: string, readOnly: boolean, mode: ShopifyAccessMode = "app"): boolean {
  if (role === "admin") return true;
  const adminOnly = ADMIN_ONLY_TOOLS.has(tool) && !(mode === "per_user" && PER_USER_OPEN_TOOLS.has(tool));
  if (role === "editor") return !adminOnly;
  return readOnly && !adminOnly;
}

export function requestedStores(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const found: string[] = [];
  for (const key of STORE_ARGUMENTS) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string") found.push(value);
    else if (Array.isArray(value)) for (const item of value) if (typeof item === "string") found.push(item);
  }
  return found;
}

function denied(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

type AnyCallback = (...args: unknown[]) => unknown;
type ToolConfig = { inputSchema?: unknown; annotations?: { readOnlyHint?: boolean } };

export interface GuardOptions {
  principal: Principal;
  audit: AuditLog;
  /** Personal access token id when the request used one. Recorded in the audit log; never the value. */
  tokenId?: string;
  /** "per_user" when every call uses the caller's own Shopify token. Defaults to "app". */
  accessMode?: ShopifyAccessMode;
  /** The caller's own Shopify tokens (per-user mode). */
  access?: UserShopifyAccess;
}

/**
 * Wrap McpServer.registerTool so every tool, including ones added later, gets:
 * role filtering (tools the role cannot call are not registered), a store allowlist
 * check on store/stores/alias arguments, a store-scoped context for loadStores(),
 * refusal of local-file arguments, and one audit line per call.
 * Must run before any tool is registered.
 */
export function guardServer(server: McpServer, { principal, audit, tokenId, accessMode = "app", access }: GuardOptions): void {
  if (accessMode === "per_user" && !access) throw new Error("Per-user mode requires the caller's Shopify access.");
  const auditAction = async (details: ActionAuditDetails): Promise<void> => {
    try {
      await audit.write({ event: "action_run", timestamp: new Date().toISOString(), user: principal.email, role: principal.role, ...(tokenId ? { tokenId } : {}), ...details });
    } catch (error) {
      process.stderr.write(`Audit log write failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };
  const register = server.registerTool.bind(server) as unknown as (name: string, config: ToolConfig, cb: AnyCallback) => unknown;

  const guarded = (name: string, config: ToolConfig, callback: AnyCallback): unknown => {
    if (HOSTED_DISABLED_TOOLS.has(name)) return undefined;
    const readOnly = config.annotations?.readOnlyHint === true;
    if (!toolAllowedForRole(principal.role, name, readOnly, accessMode)) return undefined;
    const hasInput = config.inputSchema !== undefined;

    const wrapped = async (...callArgs: unknown[]): Promise<unknown> => {
      const input = hasInput ? callArgs[0] : undefined;
      const stores = requestedStores(input);
      const started = Date.now();
      let result: unknown;
      let failure: unknown;
      try {
        // Re-check at call time as a second line of defense.
        if (!toolAllowedForRole(principal.role, name, readOnly, accessMode)) {
          result = denied(`Access denied: role ${principal.role} cannot call ${name}.`);
        } else {
          const blockedStore = stores.find((store) => !storeAllowed(store, { stores: principal.stores }));
          const blockedArgument = (HOSTED_DISABLED_ARGUMENTS[name] ?? []).find((key) => {
            const value = input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
            return value !== undefined && value !== null && value !== "";
          });
          if (blockedStore !== undefined) {
            result = denied(`Access denied: ${principal.email} is not allowed to use store "${blockedStore}".`);
          } else if (blockedArgument) {
            result = denied(`${blockedArgument} refers to a file on the server and is not available on the hosted connector. Use sourceUrl with an HTTPS image URL instead.`);
          } else {
            result = await storeScope.run({ stores: principal.stores, ...(access ? { access } : {}), auditAction }, () => callback(...callArgs));
          }
        }
        return result;
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        const isError = Boolean(failure) || Boolean(result && typeof result === "object" && (result as { isError?: boolean }).isError);
        const errorText = failure
          ? (failure instanceof Error ? failure.message : String(failure))
          : isError ? errorMessage(result) : undefined;
        try {
          await audit.write({
            event: "tool_call",
            timestamp: new Date(started).toISOString(),
            user: principal.email,
            role: principal.role,
            ...(tokenId ? { tokenId } : {}),
            ...(access ? { shopifyAccounts: shopifyAccounts(access, stores) } : {}),
            tool: name,
            stores,
            readOnly,
            ok: !isError,
            ...(errorText ? { error: errorText.slice(0, 500) } : {}),
            durationMs: Date.now() - started,
            // Every call records a hash of its arguments and the arguments reduced by
            // auditArguments(): GraphQL documents summarized, variables and free text hashed,
            // only ids, store aliases, enums, numbers and booleans kept as they are.
            ...(input !== undefined ? {
              argsSha256: sha256Hex(canonicalJson(input)),
              args: auditArguments(input, { graphqlKeys: GRAPHQL_DOCUMENT_ARGUMENTS[name] ?? [] })
            } : {})
          });
        } catch (error) {
          process.stderr.write(`Audit log write failed: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
    };
    return register(name, config, wrapped);
  };

  (server as unknown as { registerTool: typeof guarded }).registerTool = guarded;
}

/** Store alias to Shopify staff email for the stores a call names, or every connected store when it names none. */
function shopifyAccounts(access: UserShopifyAccess, stores: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const wanted = stores.length ? stores.map((store) => store.toLowerCase()) : [...access.tokens.keys()];
  for (const alias of wanted) {
    const email = access.tokens.get(alias)?.shopifyEmail;
    if (email) out[alias] = email;
  }
  return out;
}

function errorMessage(result: unknown): string | undefined {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  const text = content?.find((item) => item.type === "text")?.text;
  return typeof text === "string" ? text : "Tool returned an error.";
}
