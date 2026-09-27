/**
 * Where the bundled Shopify Admin GraphQL introspection schemas come from. Node reads the
 * gzipped files under schemas/; a Cloudflare Worker bundles one version and inflates it with
 * DecompressionStream the first time a tool needs it. schema.ts asks the current source first
 * and fetches Shopify's public schema proxy only when the source does not have the version.
 */
export interface SchemaSource {
  /** The introspection result JSON text for a quarterly version, or undefined when not available here. */
  load(version: string): Promise<string | undefined>;
  /** The versions this source holds, when it knows them up front (the Worker's bundle). */
  readonly versions?: readonly string[];
  /** false: never fetch a missing version from Shopify's schema proxy. Default true. */
  readonly remote?: boolean;
}

let current: SchemaSource | undefined;

export function setSchemaSource(source: SchemaSource | undefined): void {
  current = source;
}

/** The configured source, or Node's file source (loaded lazily, so a Worker never runs it). */
export function schemaSource(): SchemaSource {
  return current ?? { load: async (version) => (await import("./schema-node.js")).loadSchemaFile(version) };
}

/**
 * A source holding exactly one gzipped schema version, for example a file bundled into a
 * Worker. It is inflated once, on first use, with the web-standard DecompressionStream, and
 * the text is not kept: schema.ts caches the parsed schema.
 *
 * With remote: false (the Worker), schema.ts never fetches another version from shopify.dev:
 * a second 6 MB download parsed next to the bundled one would crowd the 128 MB isolate, so an
 * unbundled version fails at once with an error naming the bundled one.
 */
/**
 * Whether a schema for this version can be loaded here without a network fetch being refused:
 * true unless the source is offline-only (remote: false) and does not bundle the version.
 */
export function schemaAvailable(version: string): boolean {
  const source = schemaSource();
  return source.remote !== false || Boolean(source.versions?.includes(version));
}

export function gzipSchemaSource(
  version: string,
  gzipped: ArrayBuffer | Uint8Array | (() => Promise<ArrayBuffer | Uint8Array>) | undefined,
  options: { remote?: boolean } = {}
): SchemaSource {
  return {
    versions: gzipped ? [version] : [],
    remote: options.remote ?? true,
    async load(requested) {
      if (requested !== version || !gzipped) return undefined;
      const bytes = typeof gzipped === "function" ? await gzipped() : gzipped;
      return gunzipText(bytes);
    }
  };
}

export async function gunzipText(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const stream = new Blob([bytes instanceof Uint8Array ? new Uint8Array(bytes) : bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}
