/**
 * Cloudflare Workers entry point (wrangler.jsonc `main`). Local stdio mode and `serve` never
 * import this file.
 *
 * The one bundled schema is the default API version's (see DEFAULT_API_VERSION in
 * src/constants.ts; a test keeps the two in step). It is bundled as a Data module, stays
 * gzipped in the script, and is inflated only when a tool first needs it. Every guided tool
 * runs on this version. The Worker never downloads another version's schema at run time: a
 * store or call on another version gets a clear error instead, and the legacy smart-collection
 * ruleSet write (2026-04) is refused with a pointer to shopify_run_action.
 */
import schemaGzip from "../../schemas/admin-2026-07.json.gz";
import { createWorker } from "./app.js";
export { OAuthStoreObject } from "./do-store.js";
export default createWorker({ schemaGzip });
//# sourceMappingURL=index.js.map