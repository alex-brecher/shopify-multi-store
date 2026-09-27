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
 */
export function gzipSchemaSource(version, gzipped) {
    return {
        async load(requested) {
            if (requested !== version)
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