import { type HostedEnv } from "../hosted/config.js";
import type { ExecutionContextLike, WorkerEnv } from "./types.js";
export interface WorkerOptions {
    /** The one bundled Admin schema (gzipped), for DEFAULT_API_VERSION. Inflated on first use. */
    schemaGzip?: ArrayBuffer | Uint8Array;
}
/** The Worker's string settings (vars and secrets). Bindings such as OAUTH_STORE are objects and are left out. */
export declare function settingsFrom(env: WorkerEnv): HostedEnv;
/**
 * The hosted connector as a Cloudflare Worker: the same app `shopify-multi-store serve` runs,
 * with the OAuth store in a Durable Object, the audit log in D1, one bundled schema, and the
 * platform's fetch. Settings come from the Worker's env (see docs/DEPLOY-CLOUDFLARE.md).
 * MCP_PUBLIC_URL is optional here: without it the public origin is the origin the request
 * arrived on (the workers.dev host or a custom domain), so a Deploy to Cloudflare install
 * works before its host name is known.
 */
export declare function createWorker(options?: WorkerOptions): {
    fetch(request: Request, env: WorkerEnv, _ctx?: ExecutionContextLike): Promise<Response>;
};
