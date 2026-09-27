import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createHostedApp } from "../dist/hosted/app.js";
import { FileAuditLog } from "../dist/hosted/audit.js";
import { openDomainPolicy, staticPolicy } from "../dist/hosted/policy.js";
import { decryptToken, encryptToken, parseEncryptionKey, parseEncryptionKeys, shopifyHmacMessage, verifyShopifyHmac } from "../dist/hosted/shopify-connect.js";
import { MemoryStore } from "../dist/hosted/store.js";
import { loadStores } from "../dist/config.js";
import { enableHostedMode } from "../dist/runtime.js";
import { buildHostedAppFromEnv } from "../dist/serve.js";

// Per-user Shopify access (SHOPIFY_ACCESS_MODE=per_user). Runs in its own process.
enableHostedMode();

const ORIGIN = "https://mcp.example.test";
const RESOURCE = `${ORIGIN}/mcp`;
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const SECRET = "shpss_test_secret";
const KEY = randomBytes(32);
const KEYS = [{ id: "k1", key: KEY }];

function fakeGoogle() {
  return {
    authorizationUrl: ({ state }) => `https://accounts.google.test/auth?state=${encodeURIComponent(state)}`,
    async exchange({ code, nonce }) {
      const [local, domain] = code.split("|");
      return { sub: `sub-${local}`, email: `${local}@${domain}`, email_verified: true, hd: domain, nonce };
    }
  };
}

/** Shopify's token endpoint. Each exchanged code names the Shopify staff email to report. */
function fakeShopifyOAuth(overrides = {}) {
  const exchanges = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    exchanges.push({ url, body });
    const [email, token] = body.code.split("|");
    const payload = overrides.offline
      ? { access_token: token, scope: "write_products" }
      : {
          access_token: token, scope: "write_products,write_orders", expires_in: 86399, associated_user_scope: "write_products",
          associated_user: { id: 42, first_name: "Pat", last_name: "Lee", email, email_verified: true, account_owner: false, locale: "en", collaborator: false }
        };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, exchanges };
}

async function shopifyMock(t) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ token: request.headers["x-shopify-access-token"], body: JSON.parse(body) });
      response.writeHead(200, { "content-type": "application/json" });
      // Every mutation root these tests send gets a clean payload, so per-root outcomes read "applied".
      const ids = JSON.parse(body).variables?.ids;
      response.end(JSON.stringify({ data: { ...(Array.isArray(ids) ? { nodes: ids.map((id) => ({ __typename: id.split("/")[3], id })) } : {}), shop: { name: "Mock Shop" }, productUpdate: { product: { id: "gid://shopify/Product/1" }, userErrors: [] }, tagsAdd: { node: { id: "gid://shopify/Product/1" }, userErrors: [] }, productDelete: { deletedProductId: "gid://shopify/Product/1", userErrors: [] } } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const saved = { ...process.env };
  process.env.STORES_JSON = JSON.stringify({ stores: [
    { alias: "main", shop: "main.myshopify.com", baseUrl: base },
    { alias: "wholesale", shop: "wholesale.myshopify.com", baseUrl: base }
  ] });
  process.env.SHOPIFY_MULTI_STORE_ALLOW_INSECURE_HTTP = "1";
  process.env.SHOPIFY_TOKEN_MAIN = "main-app-token";
  process.env.SHOPIFY_TOKEN_WHOLESALE = "wholesale-app-token";
  t.after(() => {
    server.close();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  return requests;
}

async function setup(t, overrides = {}, connect = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sms-per-user-"));
  const auditPath = join(dir, "audit.jsonl");
  let now = Date.now();
  const oauth = fakeShopifyOAuth(connect);
  const store = overrides.store ?? new MemoryStore(() => now);
  const { encryptionKeys, ...appOverrides } = overrides;
  const app = createHostedApp({
    issuer: ORIGIN,
    resource: RESOURCE,
    google: fakeGoogle(),
    allowedDomains: ["bariatricpal.com"],
    policy: openDomainPolicy(["bariatricpal.com"]),
    store,
    audit: new FileAuditLog(auditPath),
    now: () => now,
    log: () => {},
    shopifyAccessMode: "per_user",
    shopifyConnect: {
      encryptionKeys: encryptionKeys ?? KEYS,
      loadStores,
      clientId: () => "app-client-id",
      clientSecret: () => SECRET,
      scopes: ["write_products", "write_orders"],
      requireEmailMatch: Boolean(connect.requireEmailMatch),
      fetch: oauth.fetch
    },
    ...appOverrides,
    store
  });
  t.after(() => app.close());
  return { app, store, oauth, auditPath, advance: (ms) => { now += ms; } };
}

function call(app, path, init = {}) {
  return app.fetch(new Request(`${ORIGIN}${path}`, init));
}

/** The "name=value" of the login binding cookie a sign-in start response sets. */
function loginCookie(response) {
  const set = response.headers.getSetCookie().find((value) => value.startsWith("__Secure-sms_login_"));
  return set?.split(";")[0];
}

/** Follow a sign-in start (a redirect to Google) back to the callback, from the same browser. */
function googleBack(app, start, account) {
  const google = new URL(start.headers.get("location"));
  const cookie = loginCookie(start);
  return call(app, `/oauth/google/callback?state=${encodeURIComponent(google.searchParams.get("state"))}&code=${encodeURIComponent(account)}`, cookie ? { headers: { cookie } } : {});
}

/** The "name=value" of a named cookie from a response. */
function cookieNamed(response, prefix) {
  const set = response.headers.getSetCookie().find((value) => value.startsWith(prefix));
  return set?.split(";")[0];
}

/** Shopify callback timestamp: now, in seconds. */
function ts(offsetSeconds = 0) {
  return String(Math.floor(Date.now() / 1000) + offsetSeconds);
}

function signedCallback(params, secret = SECRET) {
  const search = new URLSearchParams(params);
  const message = [...search.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  search.set("hmac", createHmac("sha256", secret).update(message).digest("hex"));
  return search;
}

/** Sign in to /stores with Google and return the session cookie. */
async function storesSession(app, account) {
  const start = await call(app, "/stores");
  assert.equal(start.status, 302);
  const back = await googleBack(app, start, account);
  assert.equal(back.status, 303, await back.clone().text());
  assert.equal(back.headers.get("location"), "/stores");
  const cookie = cookieNamed(back, "__Host-sms_stores=");
  assert.match(cookie, /^__Host-sms_stores=/);
  return cookie;
}

/** The confirm page's CSRF token for a /stores session. */
async function connectCsrf(app, cookie, alias = "main", chain = false) {
  const page = await call(app, `/shopify/connect?store=${alias}${chain ? "&chain=1" : ""}`, { headers: { cookie } });
  assert.equal(page.status, 200, await page.clone().text());
  const html = await page.text();
  assert.match(page.headers.get("content-security-policy"), /form-action 'self' https:\/\/\*\.myshopify\.com/);
  return /name="csrf" value="([^"]+)"/.exec(html)[1];
}

function postConnect(app, cookie, fields, headers = {}) {
  return call(app, "/shopify/connect", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie, ...headers }, body: new URLSearchParams(fields) });
}

/** Start a Shopify connection (confirm page, then POST) and return the state Shopify would echo back. */
async function startConnect(app, cookie, alias = "main", chain = false) {
  const csrf = await connectCsrf(app, cookie, alias, chain);
  const response = await postConnect(app, cookie, { csrf, store: alias, ...(chain ? { chain: "1" } : {}) });
  assert.equal(response.status, 302, await response.clone().text());
  return new URL(response.headers.get("location"));
}

async function connectStore(app, cookie, { alias = "main", shop = `${alias}.myshopify.com`, shopifyEmail = "pat@bariatricpal.com", token = `online-${alias}-token` } = {}) {
  const authorize = await startConnect(app, cookie, alias);
  const search = signedCallback({ code: `${shopifyEmail}|${token}`, shop, state: authorize.searchParams.get("state"), timestamp: ts(), host: "abc" });
  return call(app, `/shopify/callback?${search}`, { headers: { cookie } });
}

async function login(app, account) {
  const reg = await (await call(app, "/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [CALLBACK], token_endpoint_auth_method: "none", client_name: "Claude" }) })).json();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const start = await call(app, `/authorize?${new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256", state: "s", resource: RESOURCE, scope: "mcp" })}`);
  const consent = await googleBack(app, start, account);
  const html = await consent.text();
  const field = (name) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1];
  const consentCookie = cookieNamed(consent, "__Host-sms_consent=");
  const decided = await call(app, "/consent", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: consentCookie }, body: new URLSearchParams({ consent: field("consent"), csrf: field("csrf"), decision: "approve" }) });
  const code = new URL(decided.headers.get("location")).searchParams.get("code");
  const tokens = await (await call(app, "/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CALLBACK, client_id: reg.client_id, resource: RESOURCE }) })).json();
  assert.ok(tokens.access_token, JSON.stringify(tokens));
  return tokens.access_token;
}

async function mcpClient(t, app, accessToken) {
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
    fetch: (url, init) => app.fetch(new Request(url, init)),
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } }
  });
  const client = new Client({ name: "per-user-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

test("Shopify HMAC verification accepts a correct signature and rejects any change", () => {
  const good = signedCallback({ code: "c", shop: "main.myshopify.com", state: "s", timestamp: ts() });
  assert.equal(verifyShopifyHmac(good, SECRET), true);
  assert.equal(verifyShopifyHmac(good, "other-secret"), false);
  const tampered = new URLSearchParams(good);
  tampered.set("shop", "evil.myshopify.com");
  assert.equal(verifyShopifyHmac(tampered, SECRET), false);
  const missing = new URLSearchParams(good);
  missing.delete("hmac");
  assert.equal(verifyShopifyHmac(missing, SECRET), false);
  const junk = new URLSearchParams(good);
  junk.set("hmac", "zz");
  assert.equal(verifyShopifyHmac(junk, SECRET), false);
});

test("online tokens round-trip through AES-256-GCM and are bound to their user and store", () => {
  const binding = { email: "pat@bariatricpal.com", alias: "main", shop: "main.myshopify.com" };
  const sealed = encryptToken(KEYS[0], "shpua_secret", binding);
  assert.match(sealed, /^v2\.k1\./);
  assert.ok(!sealed.includes("shpua_secret"));
  assert.notEqual(sealed, encryptToken(KEYS[0], "shpua_secret", binding), "random IV");
  assert.deepEqual(decryptToken(KEYS, sealed, binding), { token: "shpua_secret", keyId: "k1" });
  assert.throws(() => decryptToken(KEYS, sealed, { ...binding, email: "other@bariatricpal.com" }));
  assert.throws(() => decryptToken(KEYS, sealed, { ...binding, alias: "wholesale" }));
  assert.throws(() => decryptToken([{ id: "k1", key: randomBytes(32) }], sealed, binding));
  assert.throws(() => decryptToken([{ id: "k2", key: KEY }], sealed, binding), /k1 is not configured/);
  // A different key id cannot be swapped in for the same key.
  assert.throws(() => decryptToken([{ id: "k2", key: KEY }], sealed.replace("v2.k1.", "v2.k2."), binding));
  assert.equal(parseEncryptionKey(KEY.toString("base64")).length, 32);
  assert.throws(() => parseEncryptionKey(undefined), /SHOPIFY_TOKEN_ENCRYPTION_KEY/);
  assert.throws(() => parseEncryptionKey(randomBytes(16).toString("base64")), /32 random bytes/);
});

test("connect redirects to Shopify for a per-user grant and the callback stores an encrypted online token", async (t) => {
  await shopifyMock(t);
  const { app, store, oauth, auditPath } = await setup(t);
  const cookie = await storesSession(app, "pat|bariatricpal.com");
  const before = await (await call(app, "/stores", { headers: { cookie } })).text();
  assert.match(before, /Not connected/);
  assert.match(before, /Connect all 2 unconnected stores/);
  assert.ok(!before.includes('href="/shopify/connect'), "connect is a form post, not a link");

  const authorize = await startConnect(app, cookie);
  assert.equal(authorize.origin, "https://main.myshopify.com");
  assert.equal(authorize.pathname, "/admin/oauth/authorize");
  assert.equal(authorize.searchParams.get("client_id"), "app-client-id");
  assert.equal(authorize.searchParams.get("scope"), "write_products,write_orders");
  assert.equal(authorize.searchParams.get("redirect_uri"), `${ORIGIN}/shopify/callback`);
  assert.equal(authorize.searchParams.get("grant_options[]"), "per-user");
  assert.match(authorize.searchParams.get("state"), /^[A-Za-z0-9_-]{43}$/);

  const search = signedCallback({ code: "pat@bariatricpal.com|shpua_live", shop: "main.myshopify.com", state: authorize.searchParams.get("state"), timestamp: ts() });
  const done = await call(app, `/shopify/callback?${search}`, { headers: { cookie } });
  assert.equal(done.status, 303, await done.clone().text());
  assert.equal(done.headers.get("location"), "/stores");
  assert.equal(oauth.exchanges.length, 1);
  assert.equal(oauth.exchanges[0].url, "https://main.myshopify.com/admin/oauth/access_token");
  assert.deepEqual(oauth.exchanges[0].body, { client_id: "app-client-id", client_secret: SECRET, code: "pat@bariatricpal.com|shpua_live" });

  const records = await store.entries("shopify_token");
  assert.equal(records.length, 1);
  assert.ok(!JSON.stringify(records).includes("shpua_live"), "token stored only encrypted");
  assert.equal(records[0][1].associatedUser.email, "pat@bariatricpal.com");
  assert.equal(records[0][1].associatedUser.accountOwner, false);
  assert.equal(records[0][1].associatedUserScope, "write_products");

  const after = await (await call(app, "/stores", { headers: { cookie } })).text();
  assert.match(after, /Connected as pat@bariatricpal\.com/);
  assert.match(after, /signed in with Google as pat@bariatricpal\.com/);
  assert.match(after, /Reconnect/);
  const audit = await readFile(auditPath, "utf8");
  assert.match(audit, /"event":"shopify_connected"/);
  assert.ok(!audit.includes("shpua_live"));
});

test("callback state is single use, short lived, and bound to the browser session that started it", async (t) => {
  await shopifyMock(t);
  const { app, store, advance } = await setup(t);
  const cookie = await storesSession(app, "pat|bariatricpal.com");
  const other = await storesSession(app, "sam|bariatricpal.com");

  // Replayed state.
  let authorize = await startConnect(app, cookie);
  let search = signedCallback({ code: "pat@bariatricpal.com|t1", shop: "main.myshopify.com", state: authorize.searchParams.get("state"), timestamp: ts() });
  assert.equal((await call(app, `/shopify/callback?${search}`, { headers: { cookie } })).status, 303);
  assert.equal((await call(app, `/shopify/callback?${search}`, { headers: { cookie } })).status, 400);

  // State finished in another user's browser.
  authorize = await startConnect(app, cookie, "wholesale");
  search = signedCallback({ code: "pat@bariatricpal.com|t2", shop: "wholesale.myshopify.com", state: authorize.searchParams.get("state"), timestamp: ts() });
  assert.equal((await call(app, `/shopify/callback?${search}`, { headers: { cookie: other } })).status, 400);
  // ...and it is now used up for the right browser too.
  assert.equal((await call(app, `/shopify/callback?${search}`, { headers: { cookie } })).status, 400);

  // No session cookie at all.
  authorize = await startConnect(app, cookie, "wholesale");
  search = signedCallback({ code: "pat@bariatricpal.com|t3", shop: "wholesale.myshopify.com", state: authorize.searchParams.get("state"), timestamp: ts() });
  assert.equal((await call(app, `/shopify/callback?${search}`)).status, 400);

  // Expired state.
  authorize = await startConnect(app, cookie, "wholesale");
  advance(11 * 60_000);
  search = signedCallback({ code: "pat@bariatricpal.com|t4", shop: "wholesale.myshopify.com", state: authorize.searchParams.get("state"), timestamp: ts() });
  assert.equal((await call(app, `/shopify/callback?${search}`, { headers: { cookie } })).status, 400);

  // Bad signature, and a shop that does not match the state.
  const fresh = await storesSession(app, "pat|bariatricpal.com");
  authorize = await startConnect(app, fresh, "wholesale");
  search = signedCallback({ code: "pat@bariatricpal.com|t5", shop: "wholesale.myshopify.com", state: authorize.searchParams.get("state"), timestamp: ts() }, "wrong-secret");
  assert.equal((await call(app, `/shopify/callback?${search}`, { headers: { cookie: fresh } })).status, 400);
  search = signedCallback({ code: "pat@bariatricpal.com|t5", shop: "main.myshopify.com", state: authorize.searchParams.get("state"), timestamp: ts() });
  assert.equal((await call(app, `/shopify/callback?${search}`, { headers: { cookie: fresh } })).status, 400);
  search = signedCallback({ code: "pat@bariatricpal.com|t5", shop: "evil.myshopify.com", state: "x", timestamp: ts() });
  assert.equal((await call(app, `/shopify/callback?${search}`, { headers: { cookie: fresh } })).status, 400);

  const connected = (await store.entries("shopify_token")).map(([, record]) => `${record.email}:${record.alias}`);
  assert.deepEqual(connected, ["pat@bariatricpal.com:main"]);
});

test("offline tokens and mismatched Shopify emails are refused", async (t) => {
  await shopifyMock(t);
  const offline = await setup(t, {}, { offline: true });
  let cookie = await storesSession(offline.app, "pat|bariatricpal.com");
  assert.equal((await connectStore(offline.app, cookie)).status, 502);
  assert.equal((await offline.store.entries("shopify_token")).length, 0);

  const strict = await setup(t, {}, { requireEmailMatch: true });
  cookie = await storesSession(strict.app, "pat|bariatricpal.com");
  const refused = await connectStore(strict.app, cookie, { shopifyEmail: "someone@else.com" });
  assert.equal(refused.status, 403);
  assert.match(await refused.text(), /someone@else\.com/);
  assert.equal((await strict.store.entries("shopify_token")).length, 0);
  assert.equal((await connectStore(strict.app, cookie, { shopifyEmail: "PAT@bariatricpal.com" })).status, 303);
  assert.equal((await strict.store.entries("shopify_token")).length, 1);
});

test("per-user mode calls Shopify with the caller's own token, never the app token", async (t) => {
  const requests = await shopifyMock(t);
  const { app } = await setup(t);
  const cookie = await storesSession(app, "pat|bariatricpal.com");
  assert.equal((await connectStore(app, cookie, { token: "pat-online-main" })).status, 303);
  const client = await mcpClient(t, app, await login(app, "pat|bariatricpal.com"));

  const info = await client.callTool({ name: "shopify_get_shop_info", arguments: { store: "main" } });
  assert.notEqual(info.isError, true, JSON.stringify(info));
  assert.equal(requests.at(-1).token, "pat-online-main");

  // Stores the user has not connected: an error with the exact connect URL, and no request at all.
  const count = requests.length;
  const other = await client.callTool({ name: "shopify_get_shop_info", arguments: { store: "wholesale" } });
  assert.equal(other.isError, true);
  assert.match(other.content[0].text, /not connected store "wholesale"/);
  assert.ok(other.content[0].text.includes(`${ORIGIN}/shopify/connect?store=wholesale`));
  assert.equal(requests.length, count);
  assert.ok(!requests.some((request) => /app-token/.test(request.token)));

  const listed = await client.callTool({ name: "shopify_list_stores", arguments: {} });
  assert.deepEqual(listed.structuredContent.stores.map((store) => store.alias), ["main"]);
  assert.deepEqual(listed.structuredContent.notConnected.map((store) => store.alias), ["wholesale"]);
  assert.ok(listed.structuredContent.hint.includes(`${ORIGIN}/stores`));

  // The generic mutation tool is open to non-admins here, because Shopify enforces permissions.
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === "shopify_graphql_mutation"));
});

test("an expired token returns the reconnect URL instead of falling back to the app token", async (t) => {
  const requests = await shopifyMock(t);
  const { app, advance } = await setup(t);
  const cookie = await storesSession(app, "pat|bariatricpal.com");
  await connectStore(app, cookie);
  advance(86_400_000);
  const client = await mcpClient(t, app, await login(app, "pat|bariatricpal.com"));
  const result = await client.callTool({ name: "shopify_get_shop_info", arguments: { store: "main" } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /expired/);
  assert.ok(result.content[0].text.includes(`${ORIGIN}/shopify/connect?store=main`));
  assert.equal(requests.length, 0);
  const listed = await client.callTool({ name: "shopify_list_stores", arguments: {} });
  assert.equal(listed.structuredContent.count, 0);
  assert.deepEqual(listed.structuredContent.notConnected.map((store) => store.status), ["expired", "not_connected"]);
});

test("connect all chains through every unconnected store", async (t) => {
  await shopifyMock(t);
  const { app, store } = await setup(t);
  const cookie = await storesSession(app, "pat|bariatricpal.com");
  let authorize = await startConnect(app, cookie, "main", true);
  let done = await call(app, `/shopify/callback?${signedCallback({ code: "pat@bariatricpal.com|a", shop: "main.myshopify.com", state: authorize.searchParams.get("state"), timestamp: ts() })}`, { headers: { cookie } });
  assert.equal(done.headers.get("location"), "/shopify/connect?store=wholesale&chain=1");
  authorize = await startConnect(app, cookie, "wholesale", true);
  assert.equal(authorize.host, "wholesale.myshopify.com");
  done = await call(app, `/shopify/callback?${signedCallback({ code: "pat@bariatricpal.com|b", shop: "wholesale.myshopify.com", state: authorize.searchParams.get("state"), timestamp: ts() })}`, { headers: { cookie } });
  assert.equal(done.headers.get("location"), "/stores");
  assert.equal((await store.entries("shopify_token")).length, 2);
});

test("a policy file still restricts stores and roles in per-user mode", async (t) => {
  await shopifyMock(t);
  const { app } = await setup(t, { policy: staticPolicy({ users: { "pat@bariatricpal.com": { role: "viewer", stores: ["main"] } } }) });
  const cookie = await storesSession(app, "pat|bariatricpal.com");
  const page = await (await call(app, "/stores", { headers: { cookie } })).text();
  assert.ok(!page.includes("wholesale.myshopify.com"));
  assert.equal((await call(app, "/shopify/connect?store=wholesale", { headers: { cookie } })).status, 404);
  await connectStore(app, cookie);
  const client = await mcpClient(t, app, await login(app, "pat|bariatricpal.com"));
  const { tools } = await client.listTools();
  assert.ok(!tools.some((tool) => tool.name === "shopify_graphql_mutation"), "viewer stays read-only");
});

test("serve mode defaults to per_user, needs an encryption key there, and needs a policy only in app mode", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sms-env-"));
  const base = { MCP_PUBLIC_URL: ORIGIN, ALLOWED_EMAIL_DOMAINS: "bariatricpal.com", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s", SHOPIFY_MULTI_STORE_DATA_DIR: dir };
  await assert.rejects(buildHostedAppFromEnv({ ...base }), /SHOPIFY_TOKEN_ENCRYPTION_KEY/);
  const perUser = (await buildHostedAppFromEnv({ ...base, SHOPIFY_TOKEN_ENCRYPTION_KEY: KEY.toString("base64") })).app;
  t.after(() => perUser.close());
  assert.equal(perUser.accessMode, "per_user");
  assert.ok(perUser.shopify);
  await assert.rejects(buildHostedAppFromEnv({ ...base, SHOPIFY_ACCESS_MODE: "app" }), /SHOPIFY_MULTI_STORE_POLICY/);
  const policyPath = join(dir, "policy.json");
  await writeFile(policyPath, JSON.stringify({ users: { "a@bariatricpal.com": { role: "admin", stores: "*" } } }));
  const appMode = (await buildHostedAppFromEnv({ ...base, SHOPIFY_ACCESS_MODE: "app", SHOPIFY_MULTI_STORE_POLICY: policyPath })).app;
  t.after(() => appMode.close());
  assert.equal(appMode.accessMode, "app");
  assert.equal((await appMode.fetch(new Request(`${ORIGIN}/stores`))).status, 404);
  await assert.rejects(buildHostedAppFromEnv({ ...base, SHOPIFY_ACCESS_MODE: "bogus" }), /per_user or app/);
});

test("shopify_run_action is open to editors in per-user mode, runs with the user's token, and is audited", async (t) => {
  const requests = await shopifyMock(t);
  const { app, auditPath } = await setup(t);
  const cookie = await storesSession(app, "pat|bariatricpal.com");
  await connectStore(app, cookie, { token: "pat-online-main" });
  const client = await mcpClient(t, app, await login(app, "pat|bariatricpal.com"));
  const { tools } = await client.listTools();
  for (const name of ["shopify_find_actions", "shopify_describe_action", "shopify_run_action"]) assert.ok(tools.some((tool) => tool.name === name), name);

  const variables = { id: "gid://shopify/Product/1", tags: ["sale"] };
  const applied = await client.callTool({ name: "shopify_run_action", arguments: { stores: ["main"], mutation: "tagsAdd", variables, dryRun: false } });
  assert.notEqual(applied.isError, true, JSON.stringify(applied));
  assert.ok(requests.length > 0 && requests.every((request) => request.token === "pat-online-main"));

  const unconnected = await client.callTool({ name: "shopify_run_action", arguments: { stores: ["main", "wholesale"], mutation: "tagsAdd", variables, dryRun: false } });
  assert.equal(unconnected.isError, true);
  assert.ok(unconnected.content[0].text.includes(`${ORIGIN}/shopify/connect?store=wholesale`));
  assert.ok(!requests.some((request) => /app-token/.test(request.token)));

  const lines = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const runs = lines.filter((line) => line.event === "action_run");
  assert.equal(runs.length, 2);
  assert.equal(runs[0].user, "pat@bariatricpal.com");
  assert.deepEqual(runs[0].mutations, ["tagsAdd"]);
  assert.deepEqual(runs[0].stores, ["main"]);
  assert.equal(runs[0].dryRun, false);
  assert.match(runs[0].variablesSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(runs[0].outcome, [{ store: "main", ok: true, shopifyEmail: "pat@bariatricpal.com" }]);
  assert.equal(runs[1].outcome.find((entry) => entry.store === "wholesale").ok, false);
  assert.equal(runs[1].outcome.find((entry) => entry.store === "wholesale").shopifyEmail, undefined);
  const call = lines.find((line) => line.tool === "shopify_run_action");
  assert.deepEqual(call.shopifyAccounts, { main: "pat@bariatricpal.com" });
});

test("action_run audit lines hold no PII when customerCreate fails preflight with customer data in its input", async (t) => {
  const requests = await shopifyMock(t);
  const { app, auditPath } = await setup(t);
  const cookie = await storesSession(app, "pat|bariatricpal.com");
  await connectStore(app, cookie, { token: "pat-online-main" });
  const client = await mcpClient(t, app, await login(app, "pat|bariatricpal.com"));
  const pii = ["jane.doe@example.com", "+15550100199", "Janet", "Samplesworth", "12 Elm Street", "Springfield", "90210"];
  // notAField makes variable coercion fail; GraphQL's error message quotes the whole input back.
  const variables = { input: { email: pii[0], phone: pii[1], firstName: pii[2], lastName: pii[3], addresses: [{ address1: pii[4], city: pii[5], zip: pii[6] }], notAField: pii[2] } };
  for (const dryRun of [false, true]) {
    const result = await client.callTool({ name: "shopify_run_action", arguments: { stores: ["main"], mutation: "customerCreate", variables, dryRun } });
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.ok(result.content[0].text.includes(pii[0]), "the caller still sees the coercion error in full");
  }
  assert.equal(requests.length, 0, "nothing reached Shopify");

  const raw = await readFile(auditPath, "utf8");
  for (const value of pii) assert.ok(!raw.includes(value), `audit log contains ${value}`);
  assert.ok(!raw.includes("got invalid value"), "no error text in the audit log");
  const lines = raw.trim().split("\n").map((line) => JSON.parse(line));
  const runs = lines.filter((line) => line.event === "action_run");
  assert.equal(runs.length, 2);
  const [applyRun, dryRunRun] = runs;
  assert.equal(applyRun.outcome[0].ok, false);
  assert.equal(applyRun.outcome[0].error.class, "preflight");
  assert.match(applyRun.outcome[0].error.messageSha256, /^[0-9a-f]{64}$/);
  assert.equal(dryRunRun.outcome[0].error.class, "dry_run_problems");
  const calls = lines.filter((line) => line.tool === "shopify_run_action");
  assert.equal(calls.length, 2);
  for (const entry of calls) assert.equal(typeof entry.error.class, "string");
});

test("the raw mutation tool honors the action denylist on a hosted server", async (t) => {
  const requests = await shopifyMock(t);
  const { app } = await setup(t);
  const cookie = await storesSession(app, "pat|bariatricpal.com");
  await connectStore(app, cookie);
  const client = await mcpClient(t, app, await login(app, "pat|bariatricpal.com"));
  const mutation = "mutation { ...F } fragment F on Mutation { delegateAccessTokenCreate(input: { delegateAccessScope: [\"write_products\"] }) { delegateAccessToken { accessToken } } }";
  const refused = await client.callTool({ name: "shopify_graphql_mutation", arguments: { store: "main", mutation, variables: {}, confirm: true } });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /denylist/);
  assert.equal(requests.length, 0);
});

test("personal access tokens carry no Shopify access in per-user mode unless enabled, and are then capped at 30 days", async (t) => {
  const requests = await shopifyMock(t);
  const createToken = async (app, days) => {
    const start = await call(app, "/tokens");
    const back = await googleBack(app, start, "pat|bariatricpal.com");
    const tokenCookie = cookieNamed(back, "__Host-sms_tokens=");
    const html = await (await call(app, "/tokens", { headers: { cookie: tokenCookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
    const created = await call(app, "/tokens", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: tokenCookie }, body: new URLSearchParams({ csrf, action: "create", name: "ci", days }) });
    return { html, status: created.status, token: /(smsp_[A-Za-z0-9_-]{43})/.exec(await created.text())?.[1] };
  };

  const off = await setup(t);
  await connectStore(off.app, await storesSession(off.app, "pat|bariatricpal.com"));
  const { token } = await createToken(off.app, "90");
  const client = await mcpClient(t, off.app, token);
  const refused = await client.callTool({ name: "shopify_get_shop_info", arguments: { store: "main" } });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /PERSONAL_TOKENS_SHOPIFY_ACCESS/);
  const listed = await client.callTool({ name: "shopify_list_stores", arguments: {} });
  assert.equal(listed.structuredContent.count, 0);
  assert.match(listed.structuredContent.hint, /Personal access tokens cannot use Shopify/);
  assert.equal(requests.length, 0);

  const on = await setup(t, { personalTokensShopifyAccess: true });
  await connectStore(on.app, await storesSession(on.app, "pat|bariatricpal.com"), { token: "pat-online-main" });
  const page = await createToken(on.app, "90");
  assert.equal(page.status, 400, "90 days is over the cap");
  assert.ok(!page.html.includes('value="90"'));
  const short = await createToken(on.app, "30");
  const allowed = await (await mcpClient(t, on.app, short.token)).callTool({ name: "shopify_get_shop_info", arguments: { store: "main" } });
  assert.notEqual(allowed.isError, true, JSON.stringify(allowed));
  assert.equal(requests.at(-1).token, "pat-online-main");
});

test("the raw mutation tool applies run_action's destructive confirm check in per-user mode", async (t) => {
  const requests = await shopifyMock(t);
  const { app } = await setup(t);
  const cookie = await storesSession(app, "pat|bariatricpal.com");
  await connectStore(app, cookie);
  const client = await mcpClient(t, app, await login(app, "pat|bariatricpal.com"));
  const mutation = "mutation Del($input: ProductDeleteInput!) { productDelete(input: $input) { deletedProductId userErrors { field message } } }";
  const args = { store: "main", mutation, variables: { input: { id: "gid://shopify/Product/1" } } };
  const plain = await client.callTool({ name: "shopify_graphql_mutation", arguments: { ...args, confirm: true } });
  assert.equal(plain.isError, true);
  assert.match(plain.content[0].text, /productDelete is destructive.*confirm: "productDelete"/);
  const wrong = await client.callTool({ name: "shopify_graphql_mutation", arguments: { ...args, confirm: "yes" } });
  assert.equal(wrong.isError, true);
  assert.equal(requests.length, 0);
  const named = await client.callTool({ name: "shopify_graphql_mutation", arguments: { ...args, confirm: "productDelete" } });
  assert.notEqual(named.isError, true, JSON.stringify(named));
  assert.equal(requests.length, 1);
  // Non-destructive mutations still take confirm: true.
  const update = await client.callTool({ name: "shopify_graphql_mutation", arguments: { store: "main", mutation: "mutation { productUpdate(product: {id: \"gid://shopify/Product/1\"}) { userErrors { message } } }", variables: {}, confirm: true } });
  assert.notEqual(update.isError, true, JSON.stringify(update));
});

test("Shopify HMAC escapes names and values, formats array parameters, and rejects stale timestamps", () => {
  const params = new URLSearchParams();
  params.append("shop", "main.myshopify.com");
  params.append("note", "a&b%c=d");
  params.append("we=ird", "x");
  params.append("ids[]", "1");
  params.append("ids[]", "2");
  params.append("timestamp", ts());
  const message = shopifyHmacMessage(params);
  assert.equal(message, `ids=["1", "2"]&note=a%26b%25c=d&shop=main.myshopify.com&timestamp=${params.get("timestamp")}&we%3Dird=x`);
  params.set("hmac", createHmac("sha256", SECRET).update(message).digest("hex"));
  assert.equal(verifyShopifyHmac(params, SECRET, Date.now()), true);
  const repeated = new URLSearchParams(params);
  repeated.append("shop", "evil.myshopify.com");
  assert.equal(verifyShopifyHmac(repeated, SECRET), false);

  const stale = signedCallback({ code: "c", shop: "main.myshopify.com", state: "s", timestamp: ts(-301) });
  assert.equal(verifyShopifyHmac(stale, SECRET), true, "signature itself is fine");
  assert.equal(verifyShopifyHmac(stale, SECRET, Date.now()), false);
  assert.equal(verifyShopifyHmac(signedCallback({ code: "c", shop: "main.myshopify.com", state: "s", timestamp: ts(-200) }), SECRET, Date.now()), true);
  assert.equal(verifyShopifyHmac(signedCallback({ code: "c", shop: "main.myshopify.com", state: "s", timestamp: ts(400) }), SECRET, Date.now()), false);
});

test("a stale Shopify callback is refused even with a valid state", async (t) => {
  await shopifyMock(t);
  const { app, store } = await setup(t);
  const cookie = await storesSession(app, "pat|bariatricpal.com");
  const authorize = await startConnect(app, cookie);
  const search = signedCallback({ code: "pat@bariatricpal.com|t", shop: "main.myshopify.com", state: authorize.searchParams.get("state"), timestamp: ts(-600) });
  assert.equal((await call(app, `/shopify/callback?${search}`, { headers: { cookie } })).status, 400);
  assert.equal((await store.entries("shopify_token")).length, 0);
});

test("/shopify/connect starts Shopify only from a same-origin POST with the CSRF token", async (t) => {
  await shopifyMock(t);
  const { app, store } = await setup(t);
  const cookie = await storesSession(app, "pat|bariatricpal.com");
  const page = await call(app, "/shopify/connect?store=main", { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Continue to Shopify/);
  assert.equal((await store.entries("shopify_state")).length, 0, "GET creates no state");
  const csrf = await connectCsrf(app, cookie);
  assert.equal((await postConnect(app, cookie, { store: "main" })).status, 403);
  assert.equal((await postConnect(app, cookie, { csrf: "forged", store: "main" })).status, 403);
  assert.equal((await postConnect(app, cookie, { csrf, store: "main" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await postConnect(app, "__Host-sms_stores=forged", { csrf, store: "main" })).status, 401);
  assert.equal((await store.entries("shopify_state")).length, 0);
  assert.equal((await postConnect(app, cookie, { csrf, store: "main" })).status, 302);
  assert.equal((await store.entries("shopify_state")).length, 1);
});

test("SHOPIFY_TOKEN_ENCRYPTION_KEYS rotates keys: the first encrypts, all decrypt, and old tokens are re-encrypted on use", async (t) => {
  const oldKey = { id: "old", key: randomBytes(32) };
  const newKey = { id: "new", key: randomBytes(32) };
  assert.deepEqual(parseEncryptionKeys({ SHOPIFY_TOKEN_ENCRYPTION_KEYS: `new:${newKey.key.toString("base64")}, old:${oldKey.key.toString("base64url")}` }), [newKey, oldKey]);
  assert.deepEqual(parseEncryptionKeys({ SHOPIFY_TOKEN_ENCRYPTION_KEY: KEY.toString("base64") }), [{ id: "default", key: KEY }]);
  assert.throws(() => parseEncryptionKeys({}), /SHOPIFY_TOKEN_ENCRYPTION_KEY/);
  assert.throws(() => parseEncryptionKeys({ SHOPIFY_TOKEN_ENCRYPTION_KEYS: KEY.toString("base64") }), /id:base64key/);
  assert.throws(() => parseEncryptionKeys({ SHOPIFY_TOKEN_ENCRYPTION_KEYS: `a:${KEY.toString("base64")},a:${KEY.toString("base64")}` }), /repeats/);

  const requests = await shopifyMock(t);
  const first = await setup(t, { encryptionKeys: [oldKey] });
  await connectStore(first.app, await storesSession(first.app, "pat|bariatricpal.com"), { token: "pat-online-main" });
  const [[key, record]] = await first.store.entries("shopify_token");
  assert.match(record.encryptedToken, /^v2\.old\./);

  // Same data, new key first: still works, and the record is re-encrypted with the new key.
  const rotated = await setup(t, { store: first.store, encryptionKeys: [newKey, oldKey] });
  let result = await (await mcpClient(t, rotated.app, await login(rotated.app, "pat|bariatricpal.com"))).callTool({ name: "shopify_get_shop_info", arguments: { store: "main" } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(requests.at(-1).token, "pat-online-main");
  assert.match((await first.store.get("shopify_token", key)).encryptedToken, /^v2\.new\./);

  // The old key can now be dropped.
  const retired = await setup(t, { store: first.store, encryptionKeys: [newKey] });
  result = await (await mcpClient(t, retired.app, await login(retired.app, "pat|bariatricpal.com"))).callTool({ name: "shopify_get_shop_info", arguments: { store: "main" } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
});

test("a Google callback forwarded to another browser cannot give it the attacker's /stores session or store its Shopify token under the attacker", async (t) => {
  await shopifyMock(t);
  const { app } = await setup(t);
  // Attacker starts a /stores sign-in and finishes Google as themselves, but does not open the callback.
  const start = await call(app, "/stores");
  const google = new URL(start.headers.get("location"));
  const forwarded = `/oauth/google/callback?state=${encodeURIComponent(google.searchParams.get("state"))}&code=${encodeURIComponent("mallory|bariatricpal.com")}`;
  // Victim opens the forwarded link: no binding cookie, so no session is issued.
  const victim = await call(app, forwarded);
  assert.equal(victim.status, 403, await victim.clone().text());
  assert.equal(cookieNamed(victim, "__Host-sms_stores="), undefined);
  // Without a session the victim cannot start a Shopify connection at all.
  const connect = await call(app, "/shopify/connect?store=main");
  assert.equal(connect.status, 302);
  assert.match(connect.headers.get("location"), /accounts\.google\.com|oauth\/google|google/i);
  // The attacker's own browser (with its binding cookie) still completes normally, proving the state was not consumed by the refusal.
  const own = await googleBack(app, start, "mallory|bariatricpal.com");
  assert.equal(own.status, 303);
});
