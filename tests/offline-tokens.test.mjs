// Self-renewing Shopify offline tokens for people on OFFLINE_TOKEN_USERS. Runs in its own process.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { hostedOptionsFromEnv } from "../dist/hosted/config.js";
import { offlineKey } from "../dist/hosted/offline-tokens.js";
import { encryptToken } from "../dist/hosted/shopify-connect.js";
import { MemoryStore } from "../dist/hosted/store.js";
import { enableHostedMode } from "../dist/runtime.js";
import { createWorker } from "../dist/workers/app.js";
import { DurableObjectStore, OAuthStoreObject } from "../dist/workers/do-store.js";
import { loadStores } from "../dist/config.js";
import {
  ORIGIN, auditLines, call, connectHop, login, mcpClient, setup, shopifyBack, shopifyMock, storesSession, useStores
} from "./hosted-fixture.mjs";

enableHostedMode();

const PAT = "pat@bariatricpal.com";
const SAM = "sam@bariatricpal.com";
const fastSleep = () => new Promise((resolve) => setTimeout(resolve, 2));

/**
 * Shopify's token endpoint. JSON bodies are per-user code exchanges ("email|token" codes, as in
 * the shared fixture). Form bodies are offline: a code exchange with expiring=1, or a refresh.
 * Only the newest refresh token per shop is accepted (rotation); refuse() makes every refresh a 401.
 */
function fakeShopify() {
  const calls = [];
  const current = new Map();
  let issued = 0;
  let refusing = false;
  let override;
  let gate;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url, init) => {
    const shop = new URL(url).host;
    if (init.headers["content-type"] === "application/json") {
      const body = JSON.parse(init.body);
      calls.push({ shop, kind: "online", body });
      const [email, token] = body.code.split("|");
      return json({
        access_token: token, scope: "write_products,write_orders", expires_in: 86399, associated_user_scope: "write_products",
        associated_user: { id: 42, email, email_verified: true, account_owner: false, collaborator: false }
      });
    }
    assert.equal(init.headers["content-type"], "application/x-www-form-urlencoded");
    const body = Object.fromEntries(new URLSearchParams(init.body));
    const kind = body.grant_type === "refresh_token" ? "refresh" : "offline";
    calls.push({ shop, kind, body });
    if (kind === "refresh") {
      if (gate) await gate;
      if (override) return json(override.body, override.status);
      if (refusing || current.get(shop) !== body.refresh_token) return json({ error: "invalid_request", error_description: "This request requires an active refresh_token" }, 401);
    } else {
      assert.equal(body.expiring, "1", "an offline code exchange asks for an expiring token");
      assert.ok(body.code && !body.grant_type);
    }
    issued += 1;
    const pair = { access_token: `shpat_off_${shop.split(".")[0]}_${issued}`, refresh_token: `shprt_${shop.split(".")[0]}_${issued}`, expires_in: 3600, refresh_token_expires_in: 7_776_000, scope: "write_products,write_orders" };
    current.set(shop, pair.refresh_token);
    return json(pair);
  };
  return {
    fetch,
    calls,
    current,
    refuse() { refusing = true; },
    answer(status, body) { override = status ? { status, body } : undefined; },
    hold() { let open; gate = new Promise((resolve) => { open = resolve; }); return () => { gate = undefined; open(); }; }
  };
}

async function offlineApp(t, users = [PAT], overrides = {}) {
  const shopify = fakeShopify();
  const env = await setup(t, overrides, { fetch: shopify.fetch, ...(users ? { offlineTokenUsers: users } : {}), sleep: fastSleep });
  return { ...env, shopify };
}

/** Press Reconnect all on /stores and follow every Shopify leg to the end. */
async function reconnectAll(app, cookie, email = PAT) {
  const html = await (await call(app, "/stores", { headers: { cookie } })).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
  const first = /name="store" value="([^"]+)"><input type="hidden" name="chain" value="1">/.exec(html)?.[1];
  assert.ok(first, "Reconnect all is offered");
  let response = await call(app, "/shopify/connect", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie }, body: new URLSearchParams({ csrf, store: first, chain: "1" }) });
  const legs = [];
  while (response.status !== 303) {
    const authorize = await connectHop(response);
    legs.push(`${authorize.host.split(".")[0]}:${authorize.searchParams.getAll("grant_options[]").includes("per-user") ? "per-user" : "offline"}`);
    response = await shopifyBack(app, authorize, { cookie, email, token: `online-${authorize.host.split(".")[0]}-${email.split("@")[0]}` });
    assert.ok([200, 303].includes(response.status), await response.clone().text());
  }
  return { legs, location: response.headers.get("location") };
}

async function storesPage(app, cookie) {
  return (await call(app, "/stores", { headers: { cookie } })).text();
}

test("an allowlisted person's connect stores a refreshable offline token per store, and use refreshes it", async (t) => {
  const requests = await shopifyMock(t);
  const { app, store, shopify, advance, auditPath } = await offlineApp(t);
  const cookie = await storesSession(app, PAT);
  // The sign-in leg is per-user (it proves who Pat is); Reconnect all then moves both stores to offline.
  assert.deepEqual(shopify.calls.map((c) => `${c.shop.split(".")[0]}:${c.kind}`), ["main:online"]);
  const run = await reconnectAll(app, cookie);
  // main was verified at sign-in, so it goes straight to offline; wholesale is verified first.
  assert.deepEqual(run.legs, ["main:offline", "wholesale:per-user", "wholesale:offline"]);
  assert.equal(run.location, "/stores");

  const records = await store.entries("shopify_offline");
  assert.equal(records.length, 2);
  for (const [key, record] of records) {
    assert.equal(key, offlineKey(record.alias));
    assert.deepEqual(record.authorizedBy, [PAT]);
    assert.equal(record.refreshExpiresAt - record.issuedAt, 7_776_000_000);
    assert.equal(record.expiresAt - record.issuedAt, 3_600_000);
    assert.doesNotMatch(JSON.stringify(record), /shpat_|shprt_/, "tokens are stored only encrypted");
  }
  const page = await storesPage(app, cookie);
  assert.equal((page.match(/Connected, renews automatically/g) ?? []).length, 2);
  assert.doesNotMatch(page, /Expires in/);
  assert.match(page, /All set/);

  const client = await mcpClient(t, app, (await login(app, PAT, { alias: "main", token: "pat-online-main-2" })).accessToken);
  const info = await client.callTool({ name: "shopify_get_shop_info", arguments: { store: "wholesale" } });
  assert.notEqual(info.isError, true, JSON.stringify(info));
  assert.equal(requests.at(-1).token, "shpat_off_wholesale_2");

  // Two days later: the per-user tokens are long gone, the offline token is refreshed on use.
  advance(2 * 86_400_000);
  const before = shopify.current.get("wholesale.myshopify.com");
  const laterClient = await mcpClient(t, app, (await login(app, PAT, { alias: "main", token: "pat-online-main-3" })).accessToken);
  const later = await laterClient.callTool({ name: "shopify_get_shop_info", arguments: { store: "wholesale" } });
  assert.notEqual(later.isError, true, JSON.stringify(later));
  const refresh = shopify.calls.at(-1);
  assert.equal(refresh.kind, "refresh");
  assert.deepEqual(Object.keys(refresh.body).sort(), ["client_id", "client_secret", "grant_type", "refresh_token"]);
  assert.equal(refresh.body.refresh_token, before);
  assert.equal(requests.at(-1).token, `shpat_off_wholesale_${shopify.current.get("wholesale.myshopify.com").split("_").at(-1)}`);
  const renewed = await store.get("shopify_offline", offlineKey("wholesale"));
  assert.notEqual(renewed.encryptedRefreshToken, records.find(([, r]) => r.alias === "wholesale")[1].encryptedRefreshToken, "the rotated refresh token is kept");

  const lines = (await auditLines(auditPath)).map((line) => JSON.stringify(line)).join("\n");
  assert.doesNotMatch(lines, /shpat_|shprt_/, "no token in the audit log");
  assert.match(lines, /"event":"shopify_token_refreshed","store":"wholesale"/);
  assert.match(lines, /"event":"shopify_connected"[^\n]*"shopifyEmail":"app:offline-token"/);
});

test("a token with under 5 minutes left is refreshed before use; one with more is not", async (t) => {
  const { app, shopify, advance } = await offlineApp(t);
  await reconnectAll(app, await storesSession(app, PAT));
  const refreshes = () => shopify.calls.filter((c) => c.kind === "refresh").length;
  const use = async () => { const access = app.shopify.accessFor(PAT); await access.load(); return access.token("main"); };
  advance(3600_000 - 6 * 60_000);
  assert.equal(await use(), "shpat_off_main_1");
  assert.equal(refreshes(), 0);
  advance(2 * 60_000);
  const fresh = await use();
  assert.equal(refreshes(), 1);
  assert.notEqual(fresh, "shpat_off_main_1");
  assert.equal(await use(), fresh, "the new token is used until it nears its end");
  assert.equal(refreshes(), 1);
});

for (const backend of ["memory", "durable object"]) {
  test(`concurrent requests on two isolates refresh a store once (${backend} store)`, async (t) => {
    const shared = backend === "memory" ? new MemoryStore() : new DurableObjectStore(fakeNamespace());
    const first = await offlineApp(t, [PAT], { store: shared });
    const shopify = first.shopify;
    await reconnectAll(first.app, await storesSession(first.app, PAT));
    // A second isolate: its own app over the same store and the same Shopify.
    const second = await setup(t, { store: shared }, { fetch: shopify.fetch, offlineTokenUsers: [PAT], sleep: fastSleep });
    first.advance(2 * 3600_000);
    second.advance(2 * 3600_000);
    const open = shopify.hold();
    const pending = [];
    for (const { app } of [first, second, first, second, first, second]) {
      const access = app.shopify.accessFor(PAT);
      pending.push(access.load().then(() => access.token("main")));
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    open();
    const tokens = await Promise.all(pending);
    assert.equal(shopify.calls.filter((c) => c.kind === "refresh").length, 1, "exactly one refresh spent the refresh token");
    assert.equal(new Set(tokens).size, 1, "every request got the same new token");
    assert.match(tokens[0], /^shpat_off_main_/);
    assert.notEqual(tokens[0], "shpat_off_main_1");
    assert.equal(await shared.get("counter", (await import("../dist/hosted/oauth.js")).sha256("shopify-offline-lease\0main")), undefined, "the lease is released");
  });
}

test("a refused refresh shows the store as Not connected with the reason, is audited, and falls back to nothing", async (t) => {
  const requests = await shopifyMock(t);
  const { app, shopify, advance, auditPath } = await offlineApp(t);
  const cookie = await storesSession(app, PAT);
  await reconnectAll(app, cookie);
  shopify.refuse();
  advance(2 * 3600_000);
  // Signing in again leaves Pat a live per-user token for main, which must not be used either.
  const client = await mcpClient(t, app, (await login(app, PAT, { alias: "main", token: "pat-online-main-2" })).accessToken);
  const count = requests.length;
  const result = await client.callTool({ name: "shopify_get_shop_info", arguments: { store: "main" } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not connected store "main"/);
  assert.ok(result.content[0].text.includes(`${ORIGIN}/stores/reconnect`));
  assert.equal(requests.length, count, "nothing reached Shopify's Admin API");
  const again = await client.callTool({ name: "shopify_get_shop_info", arguments: { store: "main" } });
  assert.equal(again.isError, true);
  assert.equal(requests.length, count);

  const page = await storesPage(app, await storesSession(app, PAT, "wholesale", "online-wholesale-again"));
  assert.match(page, /main <span class="pill bad">Not connected<\/span>/);
  assert.match(page, /Automatic renewal stopped: Shopify refused the refresh token: it expired, was revoked, or the app was uninstalled\. Reconnect the store\./);
  assert.match(page, /Reconnect all \(\d stores?\)/);
  const failed = (await auditLines(auditPath)).filter((line) => line.event === "shopify_refresh_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].store, "main");
  assert.equal(failed[0].status, 401);
});

test("a person not on the allowlist keeps 24-hour per-user tokens exactly as before", async (t) => {
  const requests = await shopifyMock(t);
  const { app, store, shopify } = await offlineApp(t, [SAM]);
  const cookie = await storesSession(app, PAT);
  const html = await storesPage(app, cookie);
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
  const started = await call(app, "/shopify/connect", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie }, body: new URLSearchParams({ csrf, store: "wholesale" }) });
  const authorize = await connectHop(started);
  assert.deepEqual(authorize.searchParams.getAll("grant_options[]"), ["per-user"]);
  const back = await shopifyBack(app, authorize, { cookie, token: "pat-online-wholesale" });
  assert.equal(back.status, 303);
  assert.deepEqual(shopify.calls.map((c) => c.kind), ["online", "online"]);
  assert.equal((await store.entries("shopify_offline")).length, 0);
  const page = await storesPage(app, cookie);
  assert.equal((page.match(/Expires in 2\d h/g) ?? []).length, 2);
  assert.doesNotMatch(page, /renews automatically/);
  const client = await mcpClient(t, app, (await login(app, PAT, { alias: "main", token: "pat-online-main-2" })).accessToken);
  await client.callTool({ name: "shopify_get_shop_info", arguments: { store: "wholesale" } });
  assert.equal(requests.at(-1).token, "pat-online-wholesale");
});

/** A store that records which record kinds each operation touches. */
function recordingStore() {
  const inner = new MemoryStore();
  const kinds = [];
  const wrapped = {};
  for (const method of ["get", "put", "take", "delete", "claim", "deleteMatching", "count", "increment", "entries"]) {
    wrapped[method] = (kind, ...rest) => { kinds.push(`${method}:${kind}`); return inner[method](kind, ...rest); };
  }
  return { store: wrapped, kinds };
}

/** Sign-in, a single connect, the stores page and a tool call, normalized for comparison. */
async function scenario(t, users) {
  const requests = await shopifyMock(t);
  const { store, kinds } = recordingStore();
  const { app, shopify } = await offlineApp(t, users, { store });
  const cookie = await storesSession(app, PAT);
  const html = await storesPage(app, cookie);
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
  const started = await call(app, "/shopify/connect", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie }, body: new URLSearchParams({ csrf, store: "wholesale", chain: "1" }) });
  const startedHtml = await started.clone().text();
  const authorize = await connectHop(started);
  const back = await shopifyBack(app, authorize, { cookie, token: "pat-online-wholesale" });
  const client = await mcpClient(t, app, (await login(app, PAT, { alias: "main", token: "pat-online-main-2" })).accessToken);
  await client.callTool({ name: "shopify_get_shop_info", arguments: { store: "wholesale" } });
  const strip = (text) => text.replace(/[A-Za-z0-9_-]{40,}/g, "<random>").replace(/state=[^&"]+/g, "state=<random>");
  const query = new URLSearchParams(authorize.search);
  query.delete("state");
  return {
    page: strip(html),
    progress: strip(startedHtml),
    authorize: `${authorize.origin}${authorize.pathname}?${query}`,
    back: [back.status, back.headers.get("location")],
    finalPage: strip(await storesPage(app, cookie)),
    exchanges: shopify.calls.map((c) => ({ kind: c.kind, body: c.body })),
    kinds,
    adminTokens: requests.map((request) => request.token),
    refresh: await app.shopify.refreshOfflineTokens()
  };
}

test("an empty or unset OFFLINE_TOKEN_USERS behaves exactly as before: same pages, URLs, Shopify calls and store reads", async (t) => {
  const runs = {};
  for (const [name, users] of [["unset", null], ["empty", []]]) {
    await t.test(name, async (sub) => { runs[name] = await scenario(sub, users); });
  }
  for (const field of Object.keys(runs.unset)) assert.deepEqual(runs.empty[field], runs.unset[field], field);
  const run = runs.unset;
  assert.match(run.authorize, /grant_options%5B%5D=per-user/);
  assert.ok(!run.kinds.some((kind) => kind.endsWith(":shopify_offline")), "no offline record is ever read or written");
  assert.ok(run.exchanges.every((exchange) => exchange.kind === "online"));
  assert.deepEqual(run.refresh, { refreshed: [], failed: [], skipped: [] });
  assert.doesNotMatch(run.finalPage, /renews automatically|Automatic renewal/);

  // Settings: an empty variable configures nothing, exactly like an unset one.
  useStores(t);
  const base = { MCP_PUBLIC_URL: ORIGIN, SHOPIFY_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
  const without = await hostedOptionsFromEnv(base, { loadStores });
  const empty = await hostedOptionsFromEnv({ ...base, OFFLINE_TOKEN_USERS: " , " }, { loadStores });
  assert.ok(!("offlineTokenUsers" in without.shopifyConnect));
  assert.ok(!("offlineTokenUsers" in empty.shopifyConnect));
  const listed = await hostedOptionsFromEnv({ ...base, OFFLINE_TOKEN_USERS: " Pat@BariatricPal.com ,sam@bariatricpal.com,pat@bariatricpal.com" }, { loadStores });
  assert.deepEqual(listed.shopifyConnect.offlineTokenUsers, [PAT, SAM], "emails are matched without regard to case");
  await assert.rejects(hostedOptionsFromEnv({ ...base, OFFLINE_TOKEN_USERS: "pat" }, { loadStores }), /OFFLINE_TOKEN_USERS must be/);
});

test("allowlist emails match without regard to case", async (t) => {
  const { app, store } = await offlineApp(t, ["Pat@BariatricPal.COM"]);
  await reconnectAll(app, await storesSession(app, PAT));
  assert.equal((await store.entries("shopify_offline")).length, 2);
});

test("an allowlisted person cannot use a store they did not approve themselves, nor skip the per-user check", async (t) => {
  const requests = await shopifyMock(t);
  const { app, store } = await offlineApp(t, [PAT, SAM]);
  await reconnectAll(app, await storesSession(app, PAT));
  // Sam is allowlisted too and signs in through wholesale only.
  const samCookie = await storesSession(app, SAM, "wholesale", "online-wholesale-sam");
  const page = await storesPage(app, samCookie);
  assert.doesNotMatch(page, /renews automatically/, "Pat's approvals do not count for Sam");
  const client = await mcpClient(t, app, (await login(app, SAM, { alias: "wholesale", token: "online-wholesale-sam-2" })).accessToken);
  const count = requests.length;
  const main = await client.callTool({ name: "shopify_get_shop_info", arguments: { store: "main" } });
  assert.equal(main.isError, true);
  assert.match(main.content[0].text, /not connected store "main"/);
  assert.equal(requests.length, count, "Pat's offline token is never used for Sam");
  // Sam's own wholesale call uses Sam's per-user token, not the store's offline token.
  await client.callTool({ name: "shopify_get_shop_info", arguments: { store: "wholesale" } });
  assert.equal(requests.at(-1).token, "online-wholesale-sam-2");

  // Connecting main starts with Sam's own per-user authorization, never straight at offline.
  const html = await storesPage(app, samCookie);
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
  const started = await call(app, "/shopify/connect", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: samCookie }, body: new URLSearchParams({ csrf, store: "main" }) });
  const first = await connectHop(started);
  assert.deepEqual(first.searchParams.getAll("grant_options[]"), ["per-user"]);
  // A per-user answer for someone else's staff account is refused, and nothing is approved.
  const refused = await shopifyBack(app, first, { cookie: samCookie, email: PAT, token: "wrong-person" });
  assert.equal(refused.status, 403);
  assert.deepEqual((await store.get("shopify_offline", offlineKey("main"))).authorizedBy, [PAT]);

  // Sam approves main personally: both are approvers, Sam can now use it, and Disconnect takes Sam off again.
  await reconnectAll(app, samCookie, SAM);
  assert.deepEqual((await store.get("shopify_offline", offlineKey("main"))).authorizedBy, [PAT, SAM]);
  const used = await client.callTool({ name: "shopify_get_shop_info", arguments: { store: "main" } });
  assert.notEqual(used.isError, true, JSON.stringify(used));
  assert.match(requests.at(-1).token, /^shpat_off_main_/);
  const csrf2 = /name="csrf" value="([^"]+)"/.exec(await storesPage(app, samCookie))[1];
  await call(app, "/stores", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: samCookie }, body: new URLSearchParams({ csrf: csrf2, action: "disconnect", store: "main" }) });
  assert.deepEqual((await store.get("shopify_offline", offlineKey("main"))).authorizedBy, [PAT]);
});

test("the scheduled refresh renews day-old pairs, skips fresh ones, and skips stores nobody on the allowlist approved", async (t) => {
  const { app, store, shopify, advance } = await offlineApp(t);
  await reconnectAll(app, await storesSession(app, PAT));
  const fresh = await app.shopify.refreshOfflineTokens();
  assert.deepEqual([fresh.refreshed, fresh.failed, fresh.skipped.sort()], [[], [], ["main", "wholesale"]]);
  advance(25 * 3600_000);
  const result = await app.shopify.refreshOfflineTokens();
  assert.deepEqual(result.refreshed.sort(), ["main", "wholesale"]);
  assert.equal(shopify.calls.filter((c) => c.kind === "refresh").length, 2);
  // A store approved only by someone since taken off the allowlist is left alone.
  const record = await store.get("shopify_offline", offlineKey("main"));
  await store.put("shopify_offline", offlineKey("main"), { ...record, authorizedBy: ["gone@bariatricpal.com"], issuedAt: 0 });
  advance(25 * 3600_000);
  const next = await app.shopify.refreshOfflineTokens();
  assert.deepEqual(next.refreshed, ["wholesale"]);
  assert.ok(next.skipped.includes("main"));
});

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

test("only a dead refresh token stops a store: a wrong client secret or a 403 is retried later, and a 200 without lifetimes is kept", async (t) => {
  const { app, store, shopify, advance, auditPath } = await offlineApp(t);
  const cookie = await storesSession(app, PAT);
  await reconnectAll(app, cookie);
  const use = async () => { const access = app.shopify.accessFor(PAT); await access.load(); return access.token("main"); };
  advance(2 * 3600_000);
  for (const [status, body] of [[401, { error: "invalid_client" }], [403, { errors: "Forbidden" }], [402, {}]]) {
    shopify.answer(status, body);
    await assert.rejects(use(), /did not renew the connection to store "main" just now/);
    assert.equal((await store.get("shopify_offline", offlineKey("main"))).failure, undefined, `HTTP ${status} does not stop the store`);
  }
  const notices = (await auditLines(auditPath)).filter((line) => line.event === "shopify_refresh_failed");
  assert.equal(notices.length, 3);
  assert.match(notices[0].reason, /HTTP 401 invalid_client\); check the app credentials/);
  // Fixed: the next use refreshes with the refresh token still held. A 200 without lifetimes is kept.
  const held = shopify.current.get("main.myshopify.com");
  shopify.answer(200, { access_token: "shpat_bare", refresh_token: "shprt_bare" });
  assert.equal(await use(), "shpat_bare");
  assert.equal(shopify.calls.at(-1).body.refresh_token, held);
  const record = await store.get("shopify_offline", offlineKey("main"));
  assert.equal(record.expiresAt - record.issuedAt, 3_600_000);
  assert.equal(record.refreshExpiresAt - record.issuedAt, 7_776_000_000);
  // Shopify's answer for a dead refresh token does stop it.
  shopify.answer(undefined);
  advance(2 * 3600_000);
  shopify.answer(401, { error: "invalid_request", error_description: "This request requires an active refresh_token" });
  assert.equal(await use(), undefined);
  assert.match((await store.get("shopify_offline", offlineKey("main"))).failure.reason, /Shopify refused the refresh token/);
});

test("the stores page tells allowlisted people they act with the app's access, and others the 24-hour rule", async (t) => {
  const { app } = await offlineApp(t, [PAT]);
  const pat = await storesPage(app, await storesSession(app, PAT));
  assert.match(pat, /act with the app's full access, not only your staff permissions/);
  assert.doesNotMatch(pat, /Shopify ends each connection after 24 hours/);
  const sam = await storesPage(app, await storesSession(app, SAM, "wholesale", "online-wholesale-sam"));
  assert.match(sam, /Shopify ends each connection after 24 hours/);
  assert.doesNotMatch(sam, /renew automatically/);
});
