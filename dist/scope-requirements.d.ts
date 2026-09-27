export declare const REQUIRED_SCOPES: Record<string, string[]>;
/** The tool name of a REQUIRED_SCOPES key ("shopify_search:products" is shopify_search). */
export declare function toolOfScopeKey(key: string): string;
/**
 * Tools whose real scope need depends on a caller-supplied GraphQL document or
 * owner GID rather than a fixed resource. Their REQUIRED_SCOPES entry (often [])
 * understates what they might need; shopify_check_access flags them separately.
 */
export declare const VARIABLE_SCOPE_TOOLS: Record<string, string>;
/** The union of every scope handle any tool in REQUIRED_SCOPES might need, for generating a shopify.app.toml. */
export declare function allRequiredScopes(): string[];
/**
 * The "full" scope set: everything a Dev Dashboard app can reasonably request so that the
 * generic action tools (shopify_find_actions, shopify_describe_action, shopify_run_action)
 * can reach every Admin API mutation Shopify lets a third-party app use.
 *
 * A write_ scope implies its read_ scope, so mostly write_ is listed; a few read_ handles are
 * listed too because Shopify documents them separately.
 * In per-user mode Shopify further narrows each token to the scopes the signed-in staff member
 * holds (associated_user_scope), so requesting the full set never gives anyone more than
 * their own Shopify permissions.
 *
 * Scopes Shopify gates behind extra approval are marked. Requesting them without the approval
 * makes the install or version release fail for that scope; drop them with SHOPIFY_APP_SCOPES
 * if your app is not approved.
 */
export declare const FULL_SCOPES: readonly string[];
/** Scopes FULL_SCOPES leaves out on purpose, with the reason. Documented in docs/ACTIONS.md. */
export declare const EXCLUDED_SCOPES: Readonly<Record<string, string>>;
/** FULL_SCOPES plus every scope a dedicated tool needs, sorted and de-duplicated. */
export declare function fullScopes(): string[];
