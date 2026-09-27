import { storeAllowed, storeScope } from "../runtime.js";
import { auditArguments, auditError, canonicalJson, sha256Hex } from "./audit.js";
/** Tools only an admin may call in hosted mode, whatever their annotations say. */
export const ADMIN_ONLY_TOOLS = new Set([
    "shopify_graphql_mutation",
    "shopify_run_action",
    "shopify_create_preview_store",
    "shopify_get_new_store_previews"
]);
/**
 * Generic write tools that are admin-only with the shared app token, but open to every
 * non-viewer in per-user mode, where the caller's own Shopify permissions limit them.
 */
export const PER_USER_OPEN_TOOLS = new Set([
    "shopify_graphql_mutation",
    "shopify_run_action"
]);
/**
 * Tools that need the local machine (Shopify CLI, local preview receipts).
 * They are not registered at all in hosted mode.
 */
export const HOSTED_DISABLED_TOOLS = new Set([
    "shopify_create_preview_store",
    "shopify_get_new_store_previews",
    "shopify_get_new_store_preview_status",
    "shopify_get_preview_store"
]);
/** Arguments that refer to the server's local filesystem and are refused in hosted mode. */
export const HOSTED_DISABLED_ARGUMENTS = {
    shopify_upload_image: ["imageFile"]
};
/** Tools whose named arguments hold a GraphQL document. The audit log keeps only a summary of it. */
export const GRAPHQL_DOCUMENT_ARGUMENTS = {
    shopify_graphql_query: ["query"],
    shopify_graphql_query_many: ["query"],
    shopify_graphql_mutation: ["mutation"],
    shopify_bulk_export_start: ["query"]
};
/** Top-level argument names that select stores. */
const STORE_ARGUMENTS = ["store", "stores", "alias"];
export function toolAllowedForRole(role, tool, readOnly, mode = "app") {
    if (role === "admin")
        return true;
    const adminOnly = ADMIN_ONLY_TOOLS.has(tool) && !(mode === "per_user" && PER_USER_OPEN_TOOLS.has(tool));
    if (role === "editor")
        return !adminOnly;
    return readOnly && !adminOnly;
}
export function requestedStores(args) {
    if (!args || typeof args !== "object")
        return [];
    const found = [];
    for (const key of STORE_ARGUMENTS) {
        const value = args[key];
        if (typeof value === "string")
            found.push(value);
        else if (Array.isArray(value))
            for (const item of value)
                if (typeof item === "string")
                    found.push(item);
    }
    return found;
}
function denied(message) {
    return { isError: true, content: [{ type: "text", text: message }] };
}
/**
 * Wrap McpServer.registerTool so every tool, including ones added later, gets:
 * role filtering (tools the role cannot call are not registered), a store allowlist
 * check on store/stores/alias arguments, a store-scoped context for loadStores(),
 * refusal of local-file arguments, and one audit line per call.
 * Must run before any tool is registered.
 */
export function guardServer(server, { principal, audit, tokenId, accessMode = "app", access }) {
    if (accessMode === "per_user" && !access)
        throw new Error("Per-user mode requires the caller's Shopify access.");
    const auditAction = async (details) => {
        try {
            await audit.write({ event: "action_run", timestamp: new Date().toISOString(), user: principal.email, role: principal.role, ...(tokenId ? { tokenId } : {}), ...details });
        }
        catch (error) {
            process.stderr.write(`Audit log write failed: ${error instanceof Error ? error.message : String(error)}\n`);
        }
    };
    const register = server.registerTool.bind(server);
    const guarded = (name, config, callback) => {
        if (HOSTED_DISABLED_TOOLS.has(name))
            return undefined;
        const readOnly = config.annotations?.readOnlyHint === true;
        if (!toolAllowedForRole(principal.role, name, readOnly, accessMode))
            return undefined;
        const hasInput = config.inputSchema !== undefined;
        const wrapped = async (...callArgs) => {
            const input = hasInput ? callArgs[0] : undefined;
            const stores = requestedStores(input);
            const started = Date.now();
            let result;
            let failure;
            try {
                // Re-check at call time as a second line of defense.
                if (!toolAllowedForRole(principal.role, name, readOnly, accessMode)) {
                    result = denied(`Access denied: role ${principal.role} cannot call ${name}.`);
                }
                else {
                    const blockedStore = stores.find((store) => !storeAllowed(store, { stores: principal.stores }));
                    const blockedArgument = (HOSTED_DISABLED_ARGUMENTS[name] ?? []).find((key) => {
                        const value = input && typeof input === "object" ? input[key] : undefined;
                        return value !== undefined && value !== null && value !== "";
                    });
                    if (blockedStore !== undefined) {
                        result = denied(`Access denied: ${principal.email} is not allowed to use store "${blockedStore}".`);
                    }
                    else if (blockedArgument) {
                        result = denied(`${blockedArgument} refers to a file on the server and is not available on the hosted connector. Use sourceUrl with an HTTPS image URL instead.`);
                    }
                    else {
                        result = await storeScope.run({ stores: principal.stores, ...(access ? { access } : {}), auditAction }, () => callback(...callArgs));
                    }
                }
                return result;
            }
            catch (error) {
                failure = error;
                throw error;
            }
            finally {
                const isError = Boolean(failure) || Boolean(result && typeof result === "object" && result.isError);
                // Never the message text: it can quote customer data back from Shopify.
                const errorInfo = failure ? auditError(failure) : isError ? auditError(undefined, result) : undefined;
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
                }
                catch (error) {
                    process.stderr.write(`Audit log write failed: ${error instanceof Error ? error.message : String(error)}\n`);
                }
            }
        };
        return register(name, config, wrapped);
    };
    server.registerTool = guarded;
}
/** Store alias to Shopify staff email for the stores a call names, or every connected store when it names none. */
function shopifyAccounts(access, stores) {
    const out = {};
    const wanted = stores.length ? stores.map((store) => store.toLowerCase()) : [...access.tokens.keys()];
    for (const alias of wanted) {
        const email = access.tokens.get(alias)?.shopifyEmail;
        if (email)
            out[alias] = email;
    }
    return out;
}
//# sourceMappingURL=guard.js.map