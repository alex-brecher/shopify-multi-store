/**
 * Admin API versions this server pins, in one place so a test can fail well before Shopify
 * stops supporting them. Shopify releases a stable version each quarter (January, April, July,
 * October) and supports each for twelve months from its release.
 */
/** Guided parity tools (prices, metafields, redirects, tags, orders, customers, fulfillment, lists). */
export const PARITY_API_VERSION = "2026-04";
/**
 * Collection writes that set a legacy ruleSet (smart-collection rules). 2026-07 replaced the
 * rule set with typed collection sources, which have no one-to-one mapping from the column,
 * relation and condition rules this server accepts, so those writes stay on 2026-04 until they
 * are rewritten for sources. Collection writes without a ruleSet use 2026-07.
 */
export const LEGACY_COLLECTION_API_VERSION = "2026-04";
/** Collection writes without a ruleSet: the 2026-07 CollectionCreateInput and CollectionUpdateInput. */
export const COLLECTION_API_VERSION = "2026-07";
/** Every version pinned in source, with where it is used. */
export const PINNED_API_VERSIONS = {
    PARITY_API_VERSION,
    LEGACY_COLLECTION_API_VERSION,
    COLLECTION_API_VERSION,
};
/** Release date (UTC, first day of the quarter's month) of a quarterly version such as 2026-04. */
export function releaseDate(version) {
    const match = /^(\d{4})-(01|04|07|10)$/.exec(version);
    if (!match)
        throw new Error(`Not a quarterly Admin API version: ${version}`);
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
}
/** First day Shopify no longer supports a version: twelve months after its release. */
export function endOfSupport(version) {
    const release = releaseDate(version);
    return new Date(Date.UTC(release.getUTCFullYear() + 1, release.getUTCMonth(), 1));
}
/** Whole days from now until a version's end of support (negative once it has passed). */
export function daysUntilEndOfSupport(version, now = new Date()) {
    return Math.floor((endOfSupport(version).getTime() - now.getTime()) / 86_400_000);
}
//# sourceMappingURL=api-versions.js.map