export declare const REQUIRED_SCOPES: Record<string, string[]>;
/**
 * Tools whose real scope need depends on a caller-supplied GraphQL document or
 * owner GID rather than a fixed resource. Their REQUIRED_SCOPES entry (often [])
 * understates what they might need; shopify_check_access flags them separately.
 */
export declare const VARIABLE_SCOPE_TOOLS: Record<string, string>;
/** The union of every scope handle any tool in REQUIRED_SCOPES might need, for generating a shopify.app.toml. */
export declare function allRequiredScopes(): string[];
