import { loadStores } from "../config.js";
import { DEFAULT_API_VERSION } from "../constants.js";
import { createHostedApp, type HostedApp } from "../hosted/app.js";
import { hostedOptionsFromEnv, type HostedEnv } from "../hosted/config.js";
import { gzipSchemaSource, setSchemaSource } from "../platform/schema-source.js";
import { enableHostedMode } from "../runtime.js";
import { setRequestSource } from "../hosted/request-source.js";
import { D1AuditLog } from "./d1-audit.js";
import { DurableObjectStore } from "./do-store.js";
import { installRedirectErrorShim } from "./fetch-shim.js";
import type { ExecutionContextLike, WorkerEnv } from "./types.js";

export interface WorkerOptions {
  /** The one bundled Admin schema (gzipped), for DEFAULT_API_VERSION. Inflated on first use. */
  schemaGzip?: ArrayBuffer | Uint8Array;
}

/** The Worker's string settings (vars and secrets). Bindings such as OAUTH_STORE are objects and are left out. */
export function settingsFrom(env: WorkerEnv): HostedEnv {
  const settings: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (typeof value === "string") settings[name] = value;
  return settings;
}

/**
 * The hosted connector as a Cloudflare Worker: the same app `shopify-multi-store serve` runs,
 * with the OAuth store in a Durable Object, the audit log in D1, one bundled schema, and the
 * platform's fetch. Settings come from the Worker's env (see docs/DEPLOY-CLOUDFLARE.md).
 * MCP_PUBLIC_URL is optional here: without it the public origin is the origin the request
 * arrived on (the workers.dev host or a custom domain), so a Deploy to Cloudflare install
 * works before its host name is known.
 */
export function createWorker(options: WorkerOptions = {}) {
  installRedirectErrorShim();
  const apps = new Map<string, Promise<HostedApp>>();

  async function appFor(env: WorkerEnv, origin: string): Promise<HostedApp> {
    if (!env.OAUTH_STORE) throw new Error("The OAUTH_STORE Durable Object binding is missing. See docs/DEPLOY-CLOUDFLARE.md.");
    const settings = settingsFrom(env);
    const withOrigin: HostedEnv = settings.MCP_PUBLIC_URL?.trim() ? settings : { ...settings, MCP_PUBLIC_URL: origin };
    enableHostedMode(withOrigin);
    // Offline: the Worker never downloads a schema at run time (see gzipSchemaSource).
    setSchemaSource(gzipSchemaSource(DEFAULT_API_VERSION, options.schemaGzip, { remote: false }));
    const hosted = await hostedOptionsFromEnv(withOrigin, { loadStores });
    return createHostedApp({ ...hosted, store: new DurableObjectStore(env.OAUTH_STORE), audit: new D1AuditLog(env.AUDIT_DB) });
  }

  return {
    async fetch(request: Request, env: WorkerEnv, _ctx?: ExecutionContextLike): Promise<Response> {
      const origin = new URL(request.url).origin;
      const configured = typeof env.MCP_PUBLIC_URL === "string" && env.MCP_PUBLIC_URL.trim() ? "configured" : origin;
      let app = apps.get(configured);
      if (!app) {
        app = appFor(env, origin);
        apps.set(configured, app);
        // A configuration error is reported on every request until it is fixed and the Worker redeployed.
        app.catch(() => apps.delete(configured));
      }
      // Cloudflare's edge sets CF-Connecting-IP to the client's address; a client cannot set it.
      setRequestSource(request, request.headers.get("cf-connecting-ip") ?? undefined);
      try {
        return await (await app).fetch(request);
      } catch (error) {
        console.error(`Worker setup failed: ${error instanceof Error ? error.message : String(error)}`);
        return new Response(JSON.stringify({ error: "server_misconfigured", error_description: error instanceof Error ? error.message : String(error) }), {
          status: 500,
          headers: { "content-type": "application/json" }
        });
      }
    }
  };
}
