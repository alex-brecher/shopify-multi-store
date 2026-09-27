/**
 * Admin API versions this server pins, in one place so a test can fail well before Shopify
 * stops supporting them. Shopify releases a stable version each quarter (January, April, July,
 * October) and supports each for twelve months from its release.
 */

import { DEFAULT_API_VERSION } from "./constants.js";

/**
 * Guided parity tools (prices, metafields, redirects, tags, orders, customers, fulfillment,
 * lists). They run on the default API version, the one schema a Cloudflare Worker bundles, so
 * a guided call never makes a Worker fetch and hold a second schema.
 */
export const PARITY_API_VERSION = DEFAULT_API_VERSION;

/**
 * Collection writes that set a legacy ruleSet (smart-collection rules). 2026-07 replaced the
 * rule set with typed collection sources, which have no one-to-one mapping from the column,
 * relation and condition rules this server accepts, so those writes stay on 2026-04 until they
 * are rewritten for sources. Collection writes without a ruleSet use 2026-07. This is the only
 * guided write not on the default version; a Cloudflare Worker (which bundles only the default
 * schema and never fetches one at run time) refuses it and points to shopify_run_action.
 */
export const LEGACY_COLLECTION_API_VERSION = "2026-04";

/** Collection writes without a ruleSet: the 2026-07 CollectionCreateInput and CollectionUpdateInput. */
export const COLLECTION_API_VERSION = DEFAULT_API_VERSION;

/** Every version pinned in source, with where it is used. */
export const PINNED_API_VERSIONS: Readonly<Record<string, string>> = {
  PARITY_API_VERSION,
  LEGACY_COLLECTION_API_VERSION,
  COLLECTION_API_VERSION,
};

/** Release date (UTC, first day of the quarter's month) of a quarterly version such as 2026-04. */
export function releaseDate(version: string): Date {
  const match = /^(\d{4})-(01|04|07|10)$/.exec(version);
  if (!match) throw new Error(`Not a quarterly Admin API version: ${version}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
}

/** First day Shopify no longer supports a version: twelve months after its release. */
export function endOfSupport(version: string): Date {
  const release = releaseDate(version);
  return new Date(Date.UTC(release.getUTCFullYear() + 1, release.getUTCMonth(), 1));
}

/** Whole days from now until a version's end of support (negative once it has passed). */
export function daysUntilEndOfSupport(version: string, now: Date = new Date()): number {
  return Math.floor((endOfSupport(version).getTime() - now.getTime()) / 86_400_000);
}
