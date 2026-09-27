import { readFileSync } from "node:fs";
import http from "node:http";
import { resolve } from "node:path";
import { createHostedApp, type HostedApp } from "./hosted/app.js";
import { FileAuditLog } from "./hosted/audit.js";
import { hostedOptionsFromEnv, positiveInt } from "./hosted/config.js";
import { toNodeListener } from "./hosted/node-adapter.js";
import { FileStore } from "./hosted/store.js";
import { loadStores } from "./config.js";
import { fetchMetadataDocument } from "./platform/cimd-node.js";
import { enableHostedMode } from "./runtime.js";

/**
 * `shopify-multi-store serve`: the hosted connector on any server (Node or Docker). The
 * settings are shared with the Cloudflare Worker (src/hosted/config.ts); this file adds the
 * Node parts: secret files, the JSON file store, the file audit log, the DNS-pinned client
 * metadata fetcher, and node:http.
 */

const FILE_SUFFIX_TARGETS = /^(SHOPIFY_CLIENT_SECRET_[A-Z0-9_]+|SHOPIFY_APP_CLIENT_SECRET|SHOPIFY_TOKEN_ENCRYPTION_KEYS?|STORES_JSON)_FILE$/;

/**
 * Support secret mounts: for NAME_FILE=/run/secrets/x, set NAME from the file contents
 * unless NAME is already set. Limited to credential and store-config variables.
 */
export function loadFileSecrets(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, path] of Object.entries(env)) {
    const match = FILE_SUFFIX_TARGETS.exec(key);
    if (!match || !path) continue;
    const target = match[1]!;
    if (env[target]) continue;
    env[target] = readFileSync(path, "utf8").trim();
  }
}

export interface ServeConfig {
  publicUrl: string;
  host: string;
  port: number;
}

export async function buildHostedAppFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<{ app: HostedApp; config: ServeConfig }> {
  loadFileSecrets(env);
  const options = await hostedOptionsFromEnv(env, { loadStores });
  const dataDir = resolve(env.SHOPIFY_MULTI_STORE_DATA_DIR ?? "data");
  const store = await FileStore.open(resolve(env.SHOPIFY_MULTI_STORE_OAUTH_STORE ?? `${dataDir}/oauth-store.json`));
  const audit = new FileAuditLog(resolve(env.SHOPIFY_MULTI_STORE_AUDIT_LOG ?? `${dataDir}/audit.jsonl`));
  const app = createHostedApp({ ...options, store, audit, fetchClientMetadata: fetchMetadataDocument });
  return {
    app,
    config: { publicUrl: options.issuer, host: env.HOST ?? "0.0.0.0", port: positiveInt(env, "PORT", 8080) }
  };
}

export async function serve(env: NodeJS.ProcessEnv = process.env): Promise<http.Server> {
  enableHostedMode(env);
  const { app, config } = await buildHostedAppFromEnv(env);
  const server = http.createServer(toNodeListener(app.fetch, { origin: config.publicUrl, maxBodyBytes: 4 * 1024 * 1024 }));
  server.headersTimeout = 30_000;
  server.requestTimeout = 60_000;
  await new Promise<void>((resolveListen) => server.listen(config.port, config.host, resolveListen));
  process.stderr.write(`shopify-multi-store serving ${config.publicUrl}/mcp on ${config.host}:${config.port}\n`);
  const shutdown = () => {
    server.close();
    void app.close();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return server;
}
