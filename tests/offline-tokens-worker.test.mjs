// The Worker's cron handler for offline tokens. Its own process: createWorker() switches the
// process-wide settings source to the Worker env, which would leak into other tests.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { offlineKey } from "../dist/hosted/offline-tokens.js";
import { encryptToken } from "../dist/hosted/shopify-connect.js";
import { createWorker } from "../dist/workers/app.js";
import { DurableObjectStore, OAuthStoreObject } from "../dist/workers/do-store.js";

const PAT = "pat@bariatricpal.com";

/** A Durable Object namespace with one in-memory instance per name (as in workers.test.mjs). */
function fakeNamespace() {
  const objects = new Map();
  const memoryStorage = () => {
    const map = new Map();
    return {
      async get(key) { return structuredClone(map.get(key)); },
      async put(key, value) { map.set(key, structuredClone(value)); },
      async delete(keys) { const list = Array.isArray(keys) ? keys : [keys]; let n = 0; for (const key of list) if (map.delete(key)) n += 1; return Array.isArray(keys) ? n : n > 0; },
      async list({ prefix }) { return new Map([...map].filter(([key]) => key.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])); }
    };
  };
  return {
    idFromName: (name) => name,
    get(id) {
      if (!objects.has(id)) objects.set(id, { object: new OAuthStoreObject({ storage: memoryStorage() }), queue: Promise.resolve() });
      const entry = objects.get(id);
      return {
        fetch(input, init) {
          const run = entry.queue.then(() => entry.object.fetch(new Request(input, init)));
          entry.queue = run.catch(() => {});
          return run;
        }
      };
    }
  };
}

test("the Worker's cron handler refreshes offline tokens, and does nothing without OFFLINE_TOKEN_USERS", async (t) => {
  const key = randomBytes(32);
  const namespace = fakeNamespace();
  const env = {
    OAUTH_STORE: namespace,
    STORES_JSON: JSON.stringify({ stores: [{ alias: "main", shop: "main.myshopify.com" }] }),
    SHOPIFY_APP_CLIENT_ID: "worker-client",
    SHOPIFY_APP_CLIENT_SECRET: "shpss_worker",
    SHOPIFY_TOKEN_ENCRYPTION_KEYS: `k1:${key.toString("base64")}`,
    MCP_PUBLIC_URL: "https://shopify-mcp.example.com"
  };
  const store = new DurableObjectStore(namespace);
  const binding = (label) => ({ email: label, alias: "main", shop: "main.myshopify.com" });
  const day = 86_400_000;
  const now = Date.now();
  await store.put("shopify_offline", offlineKey("main"), {
    alias: "main", shop: "main.myshopify.com",
    encryptedToken: await encryptToken({ id: "k1", key }, "shpat_old", binding("offline-access")),
    encryptedRefreshToken: await encryptToken({ id: "k1", key }, "shprt_old", binding("offline-refresh")),
    scope: "read_products", authorizedBy: [PAT], connectedAt: now - 2 * day, issuedAt: now - 2 * day, expiresAt: now - 2 * day + 3600_000, refreshExpiresAt: now + 88 * day
  });
  const original = globalThis.fetch;
  const refreshes = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url === "https://main.myshopify.com/admin/oauth/access_token") {
      refreshes.push(Object.fromEntries(new URLSearchParams(init.body)));
      return new Response(JSON.stringify({ access_token: "shpat_new", refresh_token: "shprt_new", expires_in: 3600, refresh_token_expires_in: 7_776_000, scope: "read_products" }), { headers: { "content-type": "application/json" } });
    }
    return original(input, init);
  };
  t.after(() => { globalThis.fetch = original; });
  const waited = [];
  const ctx = { waitUntil: (promise) => waited.push(promise) };

  const worker = createWorker();
  await worker.scheduled({ cron: "17 */6 * * *" }, { ...env, OFFLINE_TOKEN_USERS: "" }, ctx);
  assert.equal(refreshes.length, 0);
  assert.equal(waited.length, 0, "no app is built and nothing is read without the allowlist");

  await worker.scheduled({ cron: "17 */6 * * *" }, { ...env, OFFLINE_TOKEN_USERS: PAT }, ctx);
  assert.equal(waited.length, 1);
  assert.deepEqual(refreshes, [{ client_id: "worker-client", client_secret: "shpss_worker", grant_type: "refresh_token", refresh_token: "shprt_old" }]);
  const after = await store.get("shopify_offline", offlineKey("main"));
  assert.ok(after.issuedAt >= now);
  assert.ok(after.refreshExpiresAt > now + 89 * day);
  assert.equal(after.failure, undefined);
});

