/**
 * Cloudflare Workers entry point (wrangler.jsonc `main`). Local stdio mode and `serve` never
 * import this file.
 *
 * The one bundled schema is the default API version's (see DEFAULT_API_VERSION in
 * src/constants.ts; a test keeps the two in step). It is bundled as a Data module, stays
 * gzipped in the script, and is inflated only when a tool first needs it. Stores on another
 * API version fetch that schema from Shopify's public schema proxy instead.
 */
import schemaGzip from "../../schemas/admin-2026-07.json.gz";
import { createWorker } from "./app.js";

export { OAuthStoreObject } from "./do-store.js";

export default createWorker({ schemaGzip });
