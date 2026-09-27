/**
 * Admin API versions this server pins, in one place so a test can fail well before Shopify
 * stops supporting them. Shopify releases a stable version each quarter (January, April, July,
 * October) and supports each for twelve months from its release.
 */
/**
 * Guided parity tools (prices, metafields, redirects, tags, orders, customers, fulfillment,
 * lists). They run on the default API version, the one schema a Cloudflare Worker bundles, so
 * a guided call never makes a Worker fetch and hold a second schema.
 */
export declare const PARITY_API_VERSION = "2026-07";
/**
 * Collection writes that set a legacy ruleSet (smart-collection rules). 2026-07 replaced the
 * rule set with typed collection sources, which have no one-to-one mapping from the column,
 * relation and condition rules this server accepts, so those writes stay on 2026-04 until they
 * are rewritten for sources. Collection writes without a ruleSet use 2026-07. This is the only
 * guided write not on the default version; a Cloudflare Worker (which bundles only the default
 * schema and never fetches one at run time) refuses it and points to shopify_run_action.
 */
export declare const LEGACY_COLLECTION_API_VERSION = "2026-04";
/** Collection writes without a ruleSet: the 2026-07 CollectionCreateInput and CollectionUpdateInput. */
export declare const COLLECTION_API_VERSION = "2026-07";
/** Every version pinned in source, with where it is used. */
export declare const PINNED_API_VERSIONS: Readonly<Record<string, string>>;
/** Release date (UTC, first day of the quarter's month) of a quarterly version such as 2026-04. */
export declare function releaseDate(version: string): Date;
/** First day Shopify no longer supports a version: twelve months after its release. */
export declare function endOfSupport(version: string): Date;
/** Whole days from now until a version's end of support (negative once it has passed). */
export declare function daysUntilEndOfSupport(version: string, now?: Date): number;
