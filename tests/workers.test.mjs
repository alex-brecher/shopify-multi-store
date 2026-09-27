// The Cloudflare Workers entry, run in Node with an in-memory Durable Object and a fake D1.
// tests/workers-miniflare.test.mjs runs the real wrangler bundle in workerd as well.
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { DEFAULT_API_VERSION } from "../dist/constants.js";
import { createWorker } from "../dist/workers/app.js";
import { DurableObjectStore, OAuthStoreObject } from "../dist/workers/do-store.js";

const ORIGIN = "https://shopify-mcp.example.workers.dev";
const SECRET = "shpss_worker_secret";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

/** Durable Object storage in memory. */
function memoryStorage() {
  const map = new Map();
  let alarm = null;
  return {
    map,
    async get(key) { return structuredClone(map.get(key)); },
    async put(key, value) { map.set(key, structuredClone(value)); },
    async delete(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      let n = 0;
      for (const key of list) if (map.delete(key)) n += 1;
      return Array.isArray(keys) ? n : n > 0;
    },
    async list({ prefix }) { return new Map([...map].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, structuredClone(v)])); },
    async getAlarm() { return alarm; },
    async setAlarm(time) { alarm = time; }
  };
}

/**
 * A Durable Object namespace with one instance per name. Like the real runtime, an instance
 * handles one request at a time (its only awaits are storage calls, which input gates keep
 * from interleaving), so requests are queued here.
 */
function fakeNamespace() {
  const objects = new Map();
  return {
    objects,
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

function fakeD1() {
  const statements = [];
  return {
    statements,
    prepare(sql) {
      const statement = { sql, values: [] };
      return {
        bind(...values) { statement.values = values; return this; },
        async run() { statements.push(statement); return { success: true }; }
      };
    }
  };
}

async function shopifyAdmin(t) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ token: request.headers["x-shopify-access-token"], body: JSON.parse(body) });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { shop: { name: "Worker Shop" } } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { requests, base: `http://127.0.0.1:${server.address().port}` };
}

/** Intercept Shopify's token endpoint on the global fetch the Worker code uses. */
function interceptTokenExchange(t) {
  const original = globalThis.fetch;
  const exchanges = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (/\.myshopify\.com\/admin\/oauth\/access_token$/.test(url)) {
      const body = JSON.parse(init.body);
      exchanges.push(body);
      const [email, token] = body.code.split("|");
      return new Response(JSON.stringify({ access_token: token, scope: "read_products", expires_in: 86399, associated_user_scope: "read_products", associated_user: { id: 7, email, email_verified: true } }), { headers: { "content-type": "application/json" } });
    }
    return original(input, init);
  };
  t.after(() => { globalThis.fetch = original; });
  return exchanges;
}

function workerEnv(base, extra = {}) {
  return {
    OAUTH_STORE: fakeNamespace(),
    AUDIT_DB: fakeD1(),
    STORES_JSON: JSON.stringify({ stores: [{ alias: "main", shop: "main.myshopify.com", baseUrl: base }] }),
    SHOPIFY_MULTI_STORE_ALLOW_INSECURE_HTTP: "1",
    SHOPIFY_APP_CLIENT_ID: "worker-client",
    SHOPIFY_APP_CLIENT_SECRET: SECRET,
    SHOPIFY_TOKEN_ENCRYPTION_KEYS: `k1:${randomBytes(32).toString("base64")}`,
    SHOPIFY_APP_SCOPES: "read_products",
    ...extra
  };
}

function cookieOf(response, prefix) {
  return response.headers.getSetCookie().find((value) => value.startsWith(prefix))?.split(";")[0];
}

function signed(params) {
  const search = new URLSearchParams(params);
  const message = [...search.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  search.set("hmac", createHmac("sha256", SECRET).update(message).digest("hex"));
  return search;
}

/** Sign in through the Worker from an AI app and return the MCP access token. */
async function signIn(worker, env, origin = ORIGIN) {
  const call = (path, init) => worker.fetch(new Request(`${origin}${path}`, init), env, { waitUntil() {} });
  const client = await (await call("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" }) })).json();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const start = await call(`/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256", state: "s" })}`);
  assert.equal(start.status, 302, await start.clone().text());
  const shopify = new URL(start.headers.get("location"));
  assert.equal(shopify.host, "main.myshopify.com");
  assert.equal(shopify.searchParams.get("redirect_uri"), `${origin}/shopify/callback`);
  const login = cookieOf(start, "__Host-sms_login_");
  const back = await call(`/shopify/callback?${signed({ code: "pat@bariatricpal.com|worker-online-token", shop: "main.myshopify.com", state: shopify.searchParams.get("state"), timestamp: String(Math.floor(Date.now() / 1000)) })}`, { headers: { cookie: login } });
  assert.equal(back.status, 200, await back.clone().text());
  const html = await back.text();
  const field = (name) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)[1];
  const decided = await call("/consent", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie: cookieOf(back, "__Host-sms_consent=") }, body: new URLSearchParams({ consent: field("consent"), csrf: field("csrf"), decision: "approve" }) });
  const code = new URL(decided.headers.get("location")).searchParams.get("code");
  const tokens = await (await call("/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CALLBACK, client_id: client.client_id }) })).json();
  assert.match(tokens.access_token, /^sms_at_/);
  return { tokens, client, call };
}

test("the Worker signs in with Shopify, keeps OAuth state in the Durable Object, audits to D1, and calls Shopify with the user's token", async (t) => {
  const admin = await shopifyAdmin(t);
  const exchanges = interceptTokenExchange(t);
  const gz = await readFile(new URL(`../schemas/admin-${DEFAULT_API_VERSION}.json.gz`, import.meta.url));
  const worker = createWorker({ schemaGzip: gz });
  const env = workerEnv(admin.base, { ACTIONS_DENYLIST: "tagsAdd" });
  assert.equal(process.env.ACTIONS_DENYLIST, undefined, "only the Worker env sets it");
  const { tokens, client, call } = await signIn(worker, env);
  assert.equal(exchanges.length, 1);
  assert.deepEqual(exchanges[0].client_id, "worker-client");

  // Every record lives in the one Durable Object instance.
  const [[name, { object }]] = [...env.OAUTH_STORE.objects];
  assert.equal(name, "oauth");
  assert.equal((await object.run({ op: "entries", kind: "shopify_token" })).length, 1);
  const stored = JSON.stringify([...env.OAUTH_STORE.objects.get("oauth").object.storage.map]);
  assert.ok(!stored.includes("worker-online-token"), "Shopify token stored only encrypted");
  assert.ok(!stored.includes(tokens.access_token) && !stored.includes(tokens.refresh_token), "OAuth tokens stored only as hashes");

  const mcp = new Client({ name: "worker-test", version: "1.0.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    fetch: (url, init) => worker.fetch(new Request(url, init), env, { waitUntil() {} }),
    requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } }
  }));
  t.after(() => mcp.close());
  const info = await mcp.callTool({ name: "shopify_get_shop_info", arguments: { store: "main" } });
  assert.notEqual(info.isError, true, JSON.stringify(info));
  assert.equal(admin.requests.at(-1).token, "worker-online-token");
  // The bundled schema is inflated on first use.
  const schema = await mcp.callTool({ name: "shopify_graphql_schema", arguments: { store: "main", type_name: "Product" } });
  assert.notEqual(schema.isError, true, JSON.stringify(schema).slice(0, 500));
  // The operator's ACTIONS_DENYLIST is read from the Worker env.
  const denied = await mcp.callTool({ name: "shopify_run_action", arguments: { stores: ["main"], mutation: "tagsAdd", variables: { id: "gid://shopify/Product/1", tags: ["x"] } } });
  assert.match(JSON.stringify(denied), /tagsAdd is on this server's action denylist/);
  // The legacy smart-collection write needs 2026-04, which the Worker does not bundle or download.
  const before = admin.requests.length;
  const ruleSet = await mcp.callTool({ name: "shopify_update_collection", arguments: { store: "main", id: "gid://shopify/Collection/1", ruleSet: { appliedDisjunctively: false, rules: [{ column: "TAG", relation: "EQUALS", condition: "x" }] } } });
  assert.equal(ruleSet.isError, true);
  assert.match(ruleSet.content[0].text, /bundles only the default API schema\. Use shopify_run_action with collectionCreate or collectionUpdate/);
  assert.equal(admin.requests.length, before, "refused before any Shopify call, dry run included");

  // Refresh rotation and reuse detection through the Durable Object.
  const refresh = (token) => call("/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: client.client_id }) });
  const results = await Promise.all([1, 2, 3].map(() => refresh(tokens.refresh_token)));
  assert.equal(results.filter((response) => response.status === 200).length, 1, "exactly one concurrent refresh wins");
  const unauthorized = await call("/mcp", { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(unauthorized.status, 401, "reuse revoked the family");

  const audit = env.AUDIT_DB.statements;
  assert.ok(audit.some((statement) => /CREATE TABLE IF NOT EXISTS audit/.test(statement.sql)));
  const inserts = audit.filter((statement) => /^INSERT INTO audit/.test(statement.sql));
  const events = inserts.map((statement) => statement.values[1]);
  for (const event of ["sign_in", "shopify_connected", "token_issued", "tool_call", "refresh_denied"]) assert.ok(events.includes(event), event);
  const toolLine = JSON.parse(inserts.find((statement) => statement.values[3] === "shopify_get_shop_info").values[5]);
  assert.equal(toolLine.user, "pat@bariatricpal.com");
  assert.deepEqual(toolLine.shopifyAccounts, { main: "pat@bariatricpal.com" });
  assert.ok(!JSON.stringify(inserts).includes("worker-online-token"));
});

test("without MCP_PUBLIC_URL the Worker uses the origin it is reached on; a missing binding or key is a clear 500", async (t) => {
  const admin = await shopifyAdmin(t);
  interceptTokenExchange(t);
  const worker = createWorker();
  const env = workerEnv(admin.base);
  const metadata = await (await worker.fetch(new Request("https://custom.example.com/.well-known/oauth-authorization-server"), env)).json();
  assert.equal(metadata.issuer, "https://custom.example.com");
  const configured = createWorker();
  const pinned = { ...workerEnv(admin.base), MCP_PUBLIC_URL: "https://mcp.example.com" };
  assert.equal((await (await configured.fetch(new Request("https://other.workers.dev/.well-known/oauth-authorization-server"), pinned)).json()).issuer, "https://mcp.example.com");

  const broken = createWorker();
  const noStore = await broken.fetch(new Request(`${ORIGIN}/healthz`), { ...workerEnv(admin.base), OAUTH_STORE: undefined });
  assert.equal(noStore.status, 500);
  assert.match((await noStore.json()).error_description, /OAUTH_STORE/);
  const noKey = await createWorker().fetch(new Request(`${ORIGIN}/healthz`), { ...workerEnv(admin.base), SHOPIFY_TOKEN_ENCRYPTION_KEYS: undefined });
  assert.equal(noKey.status, 500);
  assert.match((await noKey.json()).error_description, /SHOPIFY_TOKEN_ENCRYPTION_KEY/);
});

test("the Durable Object store keeps single-use and expiry semantics", async () => {
  let now = 1_000;
  const storage = memoryStorage();
  const object = new OAuthStoreObject({ storage }, {}, () => now);
  const namespace = { idFromName: (n) => n, get: () => ({ fetch: (input, init) => object.fetch(new Request(input, init)) }) };
  const store = new DurableObjectStore(namespace);
  await store.put("code", "c1", { a: 1 }, 2_000);
  assert.deepEqual(await store.take("code", "c1"), { a: 1 });
  assert.equal(await store.take("code", "c1"), undefined, "single use");
  await store.put("code", "c2", { a: 2 }, 2_000);
  now = 2_000;
  assert.equal(await store.get("code", "c2"), undefined, "expired");
  await store.put("access", "t1", { familyId: "f" });
  await store.put("access", "t2", { familyId: "g" });
  assert.equal(await store.count("access"), 2);
  assert.equal(await store.deleteMatching("access", { familyId: "f" }), 1);
  assert.deepEqual(await store.entries("access"), [["t2", { familyId: "g" }]]);
  assert.equal(await store.get("client", "nope"), undefined);
  await store.put("client", "falsy", 0);
  assert.equal(await store.get("client", "falsy"), 0, "falsy values survive the round trip");
  assert.equal(await storage.getAlarm(), 1_000 + 6 * 3600_000, "a sweep is scheduled");
  await store.put("pending", "p1", { x: 1 }, now + 60_000);
  now += 120_000;
  await object.alarm();
  assert.deepEqual([...storage.map.keys()].map((key) => key.split("\u0000")[0]).sort(), ["access", "client"], "the sweep drops expired records only");
  const bad = await object.fetch(new Request("https://x/", { method: "POST", body: JSON.stringify({ op: "get", kind: "nope", key: "k" }) }));
  assert.equal(bad.status, 400);
});

test("the Durable Object keeps the client count in a counter (no listing), and increments atomically", async () => {
  let now = 1_000;
  const storage = memoryStorage();
  let lists = 0;
  const list = storage.list;
  storage.list = (options) => { lists += 1; return list(options); };
  const object = new OAuthStoreObject({ storage }, {}, () => now);
  const namespace = { idFromName: (n) => n, get: () => ({ fetch: (input, init) => object.fetch(new Request(input, init)) }) };
  const store = new DurableObjectStore(namespace);
  // An object from before the counter existed: two clients already stored.
  await storage.put("client\u0000old1", { value: { client_id: "old1" } });
  await storage.put("client\u0000old2", { value: { client_id: "old2" }, expiresAt: 5_000 });
  assert.equal(await store.count("client"), 2, "built once by listing");
  assert.equal(lists, 1);
  await store.put("client", "c1", { client_id: "c1" }, 10_000);
  await store.put("client", "c1", { client_id: "c1", touched: true }, 20_000);
  assert.equal(await store.count("client"), 3, "a rewrite of the same client is not a new one");
  await store.delete("client", "old1");
  await store.delete("client", "never-there");
  assert.equal(await store.take("client", "c1").then((value) => value.touched), true);
  assert.equal(await store.count("client"), 1);
  now = 6_000;
  assert.equal(await store.get("client", "old2"), undefined, "expired on read");
  assert.equal(await store.count("client"), 0);
  await store.put("client", "c2", { client_id: "c2" }, 7_000);
  await store.put("client", "c3", { client_id: "c3" }, 70_000);
  assert.equal(await store.count("client"), 2);
  assert.equal(lists, 1, "no listing after the counter exists");
  now = 8_000;
  await object.alarm();
  assert.equal(await store.count("client"), 1, "the sweep takes expired clients off the counter");

  assert.deepEqual(await store.increment("counter", "r", { max: 2, expiresAt: 9_000 }), { value: 1, applied: true });
  assert.deepEqual(await store.increment("counter", "r", { max: 2 }), { value: 2, applied: true });
  assert.deepEqual(await store.increment("counter", "r", { max: 2 }), { value: 2, applied: false });
  now = 9_000;
  assert.deepEqual(await store.increment("counter", "r", { max: 2, expiresAt: 10_000 }), { value: 1, applied: true }, "expired counters restart");
});

test("on the Worker, registrations are limited per CF-Connecting-IP", async (t) => {
  const admin = await shopifyAdmin(t);
  const worker = createWorker();
  const env = workerEnv(admin.base, { OAUTH_MAX_REGISTRATIONS_PER_SOURCE_PER_HOUR: "2" });
  const register = (ip) => worker.fetch(new Request(`${ORIGIN}/register`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" }) }), env, { waitUntil() {} });
  assert.equal((await register("203.0.113.7")).status, 201);
  assert.equal((await register("203.0.113.7")).status, 201);
  assert.equal((await register("203.0.113.7")).status, 429);
  assert.equal((await register("198.51.100.9")).status, 201);
});

test("wrangler.jsonc: nodejs_compat, the Durable Object and D1 bindings, one bundled schema, and the package version", async () => {
  const text = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(config.main, "src/workers/index.ts");
  assert.ok(config.compatibility_flags.includes("nodejs_compat"));
  assert.deepEqual(config.durable_objects.bindings, [{ name: "OAUTH_STORE", class_name: "OAuthStoreObject" }]);
  assert.deepEqual(config.migrations, [{ tag: "v1", new_sqlite_classes: ["OAuthStoreObject"] }]);
  assert.equal(config.d1_databases[0].binding, "AUDIT_DB");
  assert.equal(config.define.__SMS_PACKAGE_VERSION__, JSON.stringify(pkg.version), "keep define in step with package.json");
  assert.equal(config.alias["cross-keychain"], "./src/workers/stubs/cross-keychain.ts");
  for (const secret of ["SHOPIFY_APP_CLIENT_SECRET", "SHOPIFY_TOKEN_ENCRYPTION_KEYS", "STORES_JSON", "SHOPIFY_APP_CLIENT_ID"]) {
    assert.ok(!(secret in (config.vars ?? {})), `${secret} is a secret, not a var`);
  }
  const entry = await readFile(new URL("../src/workers/index.ts", import.meta.url), "utf8");
  const bundled = [...entry.matchAll(/schemas\/admin-(\d{4}-\d{2})\.json\.gz/g)].map((m) => m[1]);
  assert.deepEqual(bundled, [DEFAULT_API_VERSION], "exactly one schema, the default API version");
});

test("graphql is imported from its package root only, so a bundle never holds two copies", async () => {
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(new URL("../src/", import.meta.url), { recursive: true })).filter((name) => name.endsWith(".ts"));
  for (const file of files) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from "graphql\//, `${file} imports a graphql subpath`);
  }
});

test("the D1 database is created explicitly in the CLI steps, and the Deploy button metadata describes every binding", async () => {
  const deploy = await readFile(new URL("../docs/DEPLOY-CLOUDFLARE.md", import.meta.url), "utf8");
  const cli = /### With the CLI\n\n```bash\n([\s\S]*?)```/.exec(deploy)[1];
  const create = cli.indexOf("npx wrangler d1 create shopify-multi-store-audit");
  assert.ok(create > 0 && create < cli.indexOf("npx wrangler deploy"), "d1 create comes before deploy");
  assert.match(cli, /database_id/);
  assert.doesNotMatch(deploy, /creates the D1 database the first time/);
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const config = JSON.parse((await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")).replace(/^\s*\/\/.*$/gm, ""));
  assert.equal(config.d1_databases[0].database_name, "shopify-multi-store-audit");
  const described = Object.keys(pkg.cloudflare.bindings);
  for (const name of ["AUDIT_DB", "OAUTH_STORE", "SHOPIFY_APP_CLIENT_ID", "SHOPIFY_APP_CLIENT_SECRET", "SHOPIFY_TOKEN_ENCRYPTION_KEYS", "STORES_JSON"]) assert.ok(described.includes(name), name);
  assert.match(pkg.cloudflare.bindings.AUDIT_DB.description, /wrangler d1 create shopify-multi-store-audit/);
});

test("the Worker's fetch shim turns redirect: \"error\" into manual plus a refusal, and leaves other requests alone", async () => {
  const { installRedirectErrorShim } = await import("../dist/workers/fetch-shim.js");
  const seen = [];
  const target = { fetch: async (input, init) => { seen.push(init?.redirect); return new Response(null, { status: String(input).includes("moved") ? 302 : 200, headers: { location: "https://evil.example/" } }); } };
  installRedirectErrorShim(target);
  installRedirectErrorShim(target);
  assert.equal((await target.fetch("https://shop.example/ok", { redirect: "error" })).status, 200);
  await assert.rejects(target.fetch("https://shop.example/moved", { redirect: "error" }), /redirect \(HTTP 302\)/);
  assert.equal((await target.fetch("https://shop.example/moved", { redirect: "manual" })).status, 302);
  assert.equal((await target.fetch("https://shop.example/ok")).status, 200);
  assert.deepEqual(seen, ["manual", "manual", "manual", undefined], "installed once; error becomes manual");
});
