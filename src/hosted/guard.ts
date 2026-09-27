import type { McpServer } from "@modelcontextprotocol/server";
import { storeAllowed, storeScope } from "../runtime.js";
import { auditArguments, canonicalJson, capString, sha256Hex, type AuditLog } from "./audit.js";
import type { Principal, Role } from "./policy.js";

/** Tools only an admin may call in hosted mode, whatever their annotations say. */
export const ADMIN_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "shopify_graphql_mutation",
  "shopify_create_preview_store",
  "shopify_get_new_store_previews"
]);

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

/** Top-level argument names that select stores. */
const STORE_ARGUMENTS = ["store", "stores", "alias"] as const;

export function toolAllowedForRole(role: Role, tool: string, readOnly: boolean): boolean {
  if (role === "admin") return true;
  if (role === "editor") return !ADMIN_ONLY_TOOLS.has(tool);
  return readOnly && !ADMIN_ONLY_TOOLS.has(tool);
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
}

/**
 * Wrap McpServer.registerTool so every tool, including ones added later, gets:
 * role filtering (tools the role cannot call are not registered), a store allowlist
 * check on store/stores/alias arguments, a store-scoped context for loadStores(),
 * refusal of local-file arguments, and one audit line per call.
 * Must run before any tool is registered.
 */
export function guardServer(server: McpServer, { principal, audit, tokenId }: GuardOptions): void {
  const register = server.registerTool.bind(server) as unknown as (name: string, config: ToolConfig, cb: AnyCallback) => unknown;

  const guarded = (name: string, config: ToolConfig, callback: AnyCallback): unknown => {
    if (HOSTED_DISABLED_TOOLS.has(name)) return undefined;
    const readOnly = config.annotations?.readOnlyHint === true;
    if (!toolAllowedForRole(principal.role, name, readOnly)) return undefined;
    const hasInput = config.inputSchema !== undefined;

    const wrapped = async (...callArgs: unknown[]): Promise<unknown> => {
      const input = hasInput ? callArgs[0] : undefined;
      const stores = requestedStores(input);
      const started = Date.now();
      let result: unknown;
      let failure: unknown;
      try {
        // Re-check at call time as a second line of defense.
        if (!toolAllowedForRole(principal.role, name, readOnly)) {
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
            result = await storeScope.run({ stores: principal.stores }, () => callback(...callArgs));
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
          const query = input && typeof input === "object" ? (input as Record<string, unknown>).query : undefined;
          await audit.write({
            event: "tool_call",
            timestamp: new Date(started).toISOString(),
            user: principal.email,
            role: principal.role,
            ...(tokenId ? { tokenId } : {}),
            tool: name,
            stores,
            readOnly,
            ok: !isError,
            ...(errorText ? { error: errorText.slice(0, 500) } : {}),
            durationMs: Date.now() - started,
            // Every call records a hash of its arguments. Read-only calls add only the start of a
            // query argument; mutations add the arguments with secrets and customer contact
            // fields redacted and long strings capped.
            ...(input !== undefined ? { argsSha256: sha256Hex(canonicalJson(input)) } : {}),
            ...(readOnly && typeof query === "string" ? { query: capString(query) } : {}),
            ...(!readOnly && input !== undefined ? { args: auditArguments(input) } : {})
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

function errorMessage(result: unknown): string | undefined {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  const text = content?.find((item) => item.type === "text")?.text;
  return typeof text === "string" ? text : "Tool returned an error.";
}
