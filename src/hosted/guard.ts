import type { McpServer } from "@modelcontextprotocol/server";
import { storeScope, type ActionAuditDetails, type UserShopifyAccess } from "../runtime.js";
import { auditArguments, auditError, canonicalJson, sha256Hex, type AuditLog } from "./audit.js";

/**
 * A signed-in hosted user. Hosted access has no roles or store lists of its own: every tool
 * call runs with the caller's own Shopify online token, so Shopify's staff permissions are
 * the only rule.
 */
export interface Principal {
  /** Lower-case, verified email of the caller's Shopify staff account. */
  email: string;
}

/**
 * Tools that need the local machine (Shopify CLI, local preview receipts).
 * They are not registered at all in hosted mode.
 */
export const HOSTED_DISABLED_TOOLS: ReadonlySet<string> = new Set<string>([]);

/** Arguments that refer to the server's local filesystem and are refused in hosted mode. */
export const HOSTED_DISABLED_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  shopify_upload_image: ["imageFile"]
};

/** Tools whose named arguments hold a GraphQL document. The audit log keeps only a summary of it. */
export const GRAPHQL_DOCUMENT_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  shopify_graphql_query: ["query"],
  shopify_graphql_query_many: ["query"],
  shopify_graphql_mutation: ["mutation"],
  shopify_run_action: ["document"]
};

/** Top-level argument names that select stores. */
const STORE_ARGUMENTS = ["store", "stores", "alias"] as const;

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
  /** The caller's own Shopify tokens. Every Admin API call uses them; there is no app token. */
  access: UserShopifyAccess;
}

function logAuditFailure(error: unknown): void {
  console.error(`Audit log write failed: ${error instanceof Error ? error.message : String(error)}`);
}

/**
 * Wrap McpServer.registerTool so every tool, including ones added later, runs in a store
 * scope carrying the caller's own Shopify tokens (loadStores() and every Admin API call use
 * them), refuses local-file arguments, and writes one audit line per call. Tools that need
 * the local machine are not registered. Must run before any tool is registered.
 */
export function guardServer(server: McpServer, { principal, audit, access }: GuardOptions): void {
  if (!access) throw new Error("A hosted tool call needs the caller's Shopify access.");
  const auditAction = async (details: ActionAuditDetails): Promise<void> => {
    try {
      await audit.write({ event: "action_run", timestamp: new Date().toISOString(), user: principal.email, ...details });
    } catch (error) {
      logAuditFailure(error);
    }
  };
  const register = server.registerTool.bind(server) as unknown as (name: string, config: ToolConfig, cb: AnyCallback) => unknown;

  const guarded = (name: string, config: ToolConfig, callback: AnyCallback): unknown => {
    if (HOSTED_DISABLED_TOOLS.has(name)) return undefined;
    const readOnly = config.annotations?.readOnlyHint === true;
    const hasInput = config.inputSchema !== undefined;

    const wrapped = async (...callArgs: unknown[]): Promise<unknown> => {
      const input = hasInput ? callArgs[0] : undefined;
      const stores = requestedStores(input);
      const started = Date.now();
      let result: unknown;
      let failure: unknown;
      try {
        // Connection metadata only; each store's token is decrypted when a call first uses it.
        await access.load();
        const blockedArgument = (HOSTED_DISABLED_ARGUMENTS[name] ?? []).find((key) => {
          const value = input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
          return value !== undefined && value !== null && value !== "";
        });
        if (blockedArgument) {
          result = denied(`${blockedArgument} refers to a file on the server and is not available on the hosted connector. Use sourceUrl with an HTTPS image URL instead.`);
        } else {
          // Every configured store is in scope; loadStores() then keeps only the stores the
          // caller has a live Shopify connection to, and Shopify decides what each call may do.
          result = await storeScope.run({ stores: "*", access, auditAction }, () => callback(...callArgs));
        }
        return result;
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        const isError = Boolean(failure) || Boolean(result && typeof result === "object" && (result as { isError?: boolean }).isError);
        // Never the message text: it can quote customer data back from Shopify.
        const errorInfo = failure ? auditError(failure) : isError ? auditError(undefined, result) : undefined;
        try {
          await audit.write({
            event: "tool_call",
            timestamp: new Date(started).toISOString(),
            user: principal.email,
            shopifyAccounts: shopifyAccounts(access, stores),
            tool: name,
            stores,
            readOnly,
            ok: !isError,
            ...(errorInfo ? { error: errorInfo } : {}),
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
          logAuditFailure(error);
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

