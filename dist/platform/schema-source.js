let current;
export function setSchemaSource(source) {
    current = source;
}
/** The configured source, or Node's file source (loaded lazily, so a Worker never runs it). */
export function schemaSource() {
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
export function schemaAvailable(version) {
    const source = schemaSource();
    return source.remote !== false || Boolean(source.versions?.includes(version));
}
export function gzipSchemaSource(version, gzipped, options = {}) {
    return {
        versions: gzipped ? [version] : [],
        remote: options.remote ?? true,
        async load(requested) {
            if (requested !== version || !gzipped)
                return undefined;
            const bytes = typeof gzipped === "function" ? await gzipped() : gzipped;
            return gunzipText(bytes);
        }
    };
}
export async function gunzipText(bytes) {
    const stream = new Blob([bytes instanceof Uint8Array ? new Uint8Array(bytes) : bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
}
//# sourceMappingURL=schema-source.js.map