// Builds the Worker with wrangler (the same bundle `wrangler deploy` uploads) and runs it in
// workerd through Miniflare: Durable Object (SQLite), D1, nodejs_compat, the bundled schema.
// Outbound requests to Shopify are answered locally; nothing leaves the machine.
// Skipped when wrangler or Miniflare is not installed, or SKIP_WORKERD=1.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { access, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const wrangler = join(root, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
const available = process.env.SKIP_WORKERD !== "1" && await access(wrangler).then(() => true, () => false) && await import("miniflare").then(() => true, () => false);

const ORIGIN = "https://shopify-multi-store-mcp.example.workers.dev";
const SECRET = "shpss_workerd_secret";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

function signed(params) {
  const search = new URLSearchParams(params);
  const message = [...search.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  search.set("hmac", createHmac("sha256", SECRET).update(message).digest("hex"));
  return search;
}

const MEASURE = process.env.SMS_MEASURE_HEAP === "1";

/**
 * V8 heap of the Worker isolate (used and reserved), read through workerd's inspector. Opt in
 * with SMS_MEASURE_HEAP=1; docs/DEPLOY-CLOUDFLARE.md quotes the numbers this prints. workerd's
 * inspector does not answer HeapProfiler.collectGarbage, so these include uncollected garbage.
 */
async function isolateHeap(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = targets.find((item) => item.id.startsWith("core:user:"));
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const usage = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("inspector did not answer")), 10_000);
    socket.onmessage = (event) => { const message = JSON.parse(event.data); if (message.id === 1) { clearTimeout(timer); resolve(message.result); } };
    socket.send(JSON.stringify({ id: 1, method: "Runtime.getHeapUsage" }));
  });
  socket.close();
  return { usedMB: +(usage.usedSize / 1048576).toFixed(1), totalMB: +(usage.totalSize / 1048576).toFixed(1) };
}

function cookieOf(response, prefix) {
  return response.headers.getSetCookie().find((value) => value.startsWith(prefix))?.split(";")[0];
}

test("the wrangler bundle runs in workerd: Shopify sign-in, Durable Object state, D1 audit, one bundled schema", { skip: !available && "wrangler or miniflare not installed", timeout: 240_000 }, async (t) => {
  const outdir = await mkdtemp(join(tmpdir(), "sms-wbuild-"));
  t.after(() => rm(outdir, { recursive: true, force: true }));
  await promisify(execFile)(wrangler, ["deploy", "--dry-run", "--outdir", outdir], { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, maxBuffer: 16 * 1024 * 1024 });
  const files = await readdir(outdir);
  const schemaFiles = files.filter((name) => name.endsWith(".json.gz"));
  assert.equal(schemaFiles.length, 1, "exactly one schema in the bundle");
  const script = (await stat(join(outdir, "index.js"))).size;
  assert.ok(script < 4 * 1024 * 1024, `script is ${script} bytes`);

  const { Miniflare, convertV4MiniflareOptions } = await import("miniflare");
  const upstream = { exchanges: [], admin: [], other: [] };
  // A small Admin API: answers each operation by name, keeping one variant's price.
  const variant = { id: "gid://shopify/ProductVariant/1", sku: "SKU-1", price: "10.00", compareAtPrice: null, product: { id: "gid://shopify/Product/1", title: "Workerd product" }, inventoryItem: { id: "gid://shopify/InventoryItem/1", sku: "SKU-1", unitCost: null } };
  const scopes = ["read_products", "write_products", "read_online_store_navigation"];
  const adminAnswer = (name, variables) => {
    switch (name) {
      case "StoreCapabilities":
      case "ParityCapabilities":
        return { shop: { id: "gid://shopify/Shop/1", name: "Workerd Shop", myshopifyDomain: "main.myshopify.com" }, currentAppInstallation: { id: "gid://shopify/AppInstallation/1", accessScopes: scopes.map((handle) => ({ handle })) } };
      case "FindVariantsBySku":
        return { productVariants: { nodes: variables.query.includes("SKU-1") ? [{ id: variant.id, sku: variant.sku }] : [], pageInfo: { hasNextPage: false, endCursor: null } } };
      case "VariantsForPricing":
        return { nodes: variables.ids.map((id) => (id === variant.id ? variant : null)) };
      case "UpdatePricesBulk":
        for (const input of variables.variants) if (input.id === variant.id && input.price) variant.price = input.price;
        return { productVariantsBulkUpdate: { productVariants: [variant], userErrors: [] } };
      case "ListRedirects":
        return { urlRedirects: { nodes: [{ id: "gid://shopify/UrlRedirect/1", path: "/old", target: "/new" }], pageInfo: { hasNextPage: false, endCursor: null } } };
      default:
        return { shop: { name: "Workerd Shop", myshopifyDomain: "main.myshopify.com" } };
    }
  };
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: "shopify-multi-store-mcp",
    modules: [{ type: "ESModule", path: join(outdir, "index.js") }, ...schemaFiles.map((name) => ({ type: "Data", path: join(outdir, name) }))],
    modulesRoot: outdir,
    compatibilityDate: "2026-09-01",
    // Settings must come from the Worker's env, not process.env: workerd fills process.env
    // only for recent compatibility dates, so the test turns that off to prove the code
    // does not depend on it (ACTIONS_DENYLIST below).
    compatibilityFlags: ["nodejs_compat", "nodejs_compat_do_not_populate_process_env"],
    ...(MEASURE ? { inspectorPort: 9239 } : {}),
    durableObjects: { OAUTH_STORE: { className: "OAuthStoreObject", useSQLite: true } },
    d1Databases: ["AUDIT_DB"],
    bindings: {
      MCP_PUBLIC_URL: "",
      STORES_JSON: JSON.stringify({ stores: [{ alias: "main", shop: "main.myshopify.com" }] }),
      SHOPIFY_APP_CLIENT_ID: "workerd-client",
      SHOPIFY_APP_CLIENT_SECRET: SECRET,
      SHOPIFY_TOKEN_ENCRYPTION_KEYS: `k1:${randomBytes(32).toString("base64")}`,
      SHOPIFY_APP_SCOPES: scopes.join(","),
      // An operator's extra denylist entry, set only in the Worker's env (never process.env).
      ACTIONS_DENYLIST: "tagsAdd"
    },
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/admin/oauth/access_token") {
        const body = await request.json();
        upstream.exchanges.push(body);
        const [email, token] = body.code.split("|");
        return Response.json({ access_token: token, scope: scopes.join(","), expires_in: 86399, associated_user_scope: scopes.join(","), associated_user: { id: 9, email, email_verified: true } });
      }
      const admin = /^\/admin\/api\/([\d-]+)\/graphql\.json$/.exec(url.pathname);
      if (admin) {
        const body = await request.json();
        const name = /^\s*(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1];
        upstream.admin.push({ host: url.host, token: request.headers.get("x-shopify-access-token"), version: admin[1], name, variables: body.variables });
        return Response.json({ data: adminAnswer(name, body.variables ?? {}) });
      }
      upstream.other.push(request.url);
      return new Response("unexpected outbound request", { status: 599 });
    }
  }));
  t.after(() => mf.dispose());
  const call = (path, init) => mf.dispatchFetch(`${ORIGIN}${path}`, { redirect: "manual", ...init });

  const health = await call("/healthz");
  assert.equal(health.status, 200);
  const register = await call("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" }) });
  const client = await register.json();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const start = await call(`/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256", state: "s" })}`);
  assert.equal(start.status, 302, await start.text());
  const shopify = new URL(start.headers.get("location"));
  assert.equal(shopify.host, "main.myshopify.com");
  assert.equal(shopify.searchParams.get("redirect_uri"), `${ORIGIN}/shopify/callback`);
  const login = cookieOf(start, "__Host-sms_login_");
  const callback = `/shopify/callback?${signed({ code: "pat@bariatricpal.com|workerd-online-token", shop: "main.myshopify.com", state: shopify.searchParams.get("state"), timestamp: String(Math.floor(Date.now() / 1000)) })}`;
  // A forwarded callback without the binding cookie is refused and does not consume the state.
  assert.equal((await call(callback)).status, 403);
  const back = await call(callback, { headers: { cookie: login } });
  assert.equal(back.status, 200, "consent page");
  assert.equal(upstream.exchanges.length, 1);
  const html = await back.text();
  const field = (name) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)[1];
  const decided = await call("/consent", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: cookieOf(back, "__Host-sms_consent=") }, body: new URLSearchParams({ consent: field("consent"), csrf: field("csrf"), decision: "approve" }) });
  assert.equal(decided.status, 303);
  const code = new URL(decided.headers.get("location")).searchParams.get("code");
  const tokenBody = new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CALLBACK, client_id: client.client_id });
  const tokens = await (await call("/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: tokenBody })).json();
  assert.match(tokens.access_token, /^sms_at_/);
  assert.equal((await (await call("/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: tokenBody })).json()).error, "invalid_grant", "codes are single use");

  const rpc = async (id, method, params) => {
    const response = await call("/mcp", { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    assert.equal(response.status, 200, await response.clone().text());
    const text = await response.text();
    const data = text.startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data: ")).slice(6);
    return JSON.parse(data);
  };
  const heapBefore = MEASURE ? await isolateHeap(9239) : undefined;
  const initialized = await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "workerd-test", version: "1" } });
  assert.equal(initialized.result.serverInfo.name, "shopify-multi-store-mcp-server");
  const listed = await rpc(2, "tools/list", {});
  const names = listed.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("shopify_get_shop_info") && names.includes("shopify_run_action"));
  assert.ok(!names.includes("shopify_create_preview_store"));
  const info = await rpc(3, "tools/call", { name: "shopify_get_shop_info", arguments: { store: "main" } });
  assert.notEqual(info.result.isError, true, JSON.stringify(info));
  const { host, token } = upstream.admin.at(-1);
  assert.deepEqual({ host, token }, { host: "main.myshopify.com", token: "workerd-online-token" });
  // The one bundled schema inflates inside workerd (DecompressionStream) within the memory limit.
  const schema = await rpc(4, "tools/call", { name: "shopify_graphql_schema", arguments: { store: "main", type_name: "Product" } });
  assert.notEqual(schema.result.isError, true, JSON.stringify(schema).slice(0, 400));
  const valid = await rpc(5, "tools/call", { name: "shopify_validate_graphql_codeblocks", arguments: { store: "main", codeblocks: [{ content: "{ shop { name } }" }] } });
  assert.equal(valid.result.structuredContent?.valid ?? JSON.parse(valid.result.content[0].text).valid, true, JSON.stringify(valid).slice(0, 400));

  // A guided write (dry run, then apply) and a pinned read run on the bundled version inside
  // workerd: no schema download, every Admin call on 2026-07.
  const body = (result) => result.result.structuredContent ?? JSON.parse(result.result.content[0].text);
  const preview = await rpc(10, "tools/call", { name: "shopify_update_prices", arguments: { store: "main", skus: [{ sku: "SKU-1", price: "12.00" }] } });
  assert.notEqual(preview.result.isError, true, JSON.stringify(preview).slice(0, 600));
  assert.equal(body(preview).dryRun, true);
  assert.equal(body(preview).wouldApply[0].requested.price, "12.00");
  assert.ok(!upstream.admin.some((request) => request.name === "UpdatePricesBulk"), "a dry run writes nothing");
  const applied = await rpc(11, "tools/call", { name: "shopify_update_prices", arguments: { store: "main", skus: [{ sku: "SKU-1", price: "12.00" }], dryRun: false } });
  assert.notEqual(applied.result.isError, true, JSON.stringify(applied).slice(0, 600));
  assert.equal(body(applied).results[0].outcome, "applied");
  assert.equal(body(applied).results[0].verification, "verified");
  assert.equal(variant.price, "12.00");
  const redirects = await rpc(12, "tools/call", { name: "shopify_search", arguments: { store: "main", resource: "redirects" } });
  assert.notEqual(redirects.result.isError, true, JSON.stringify(redirects).slice(0, 600));
  assert.equal(body(redirects).urlRedirects.nodes[0].path, "/old");
  assert.equal(body(redirects).apiVersion, "2026-07");
  const versions = new Set(upstream.admin.filter((request) => request.name).map((request) => request.version));
  assert.deepEqual([...versions], ["2026-07"], "guided tools call Shopify on the bundled version");
  assert.deepEqual(upstream.other, [], "no request left for shopify.dev or anywhere else");
  if (MEASURE) t.diagnostic(`isolate heap before the first tool call ${JSON.stringify(heapBefore)}, after a guided write and a pinned read ${JSON.stringify(await isolateHeap(9239))}`);
  // A call on an unbundled version fails at once instead of downloading a schema.
  const started = Date.now();
  const other = await rpc(13, "tools/call", { name: "shopify_describe_action", arguments: { mutation: "collectionCreate", apiVersion: "2026-04" } });
  assert.equal(other.result.isError, true);
  assert.match(JSON.stringify(other.result.content), /2026-04 is not available on this deployment/);
  assert.ok(Date.now() - started < 5_000, "no 30 s schema fetch");
  assert.deepEqual(upstream.other, [], "still no schema download");
  const ruleSet = await rpc(14, "tools/call", { name: "shopify_create_collection", arguments: { store: "main", title: "Smart", ruleSet: { appliedDisjunctively: false, rules: [{ column: "TAG", relation: "EQUALS", condition: "x" }] } } });
  assert.equal(ruleSet.result.isError, true);
  assert.match(JSON.stringify(ruleSet.result.content), /shopify_run_action/);

  // ACTIONS_DENYLIST comes from the Worker's env: the operator's entry is refused, dry run too.
  const denied = await rpc(15, "tools/call", { name: "shopify_run_action", arguments: { stores: ["main"], mutation: "tagsAdd", variables: { id: "gid://shopify/Product/1", tags: ["x"] } } });
  assert.match(JSON.stringify(denied.result), /tagsAdd is on this server's action denylist/);
  const found = await rpc(16, "tools/call", { name: "shopify_find_actions", arguments: { query: "tagsAdd", store: "main" } });
  const tagsAdd = body(found).actions.find((action) => action.name === "tagsAdd");
  assert.equal(tagsAdd?.denied, true, JSON.stringify(body(found)).slice(0, 400));

  const ui = await rpc(6, "resources/read", { uri: "ui://shopify-multi-store/results" });
  t.diagnostic(`ui resource on workerd: ${JSON.stringify(ui).slice(0, 300)}`);

  const db = await mf.getD1Database("AUDIT_DB");
  const rows = (await db.prepare("SELECT event, user, tool, line FROM audit ORDER BY id").all()).results;
  const events = rows.map((row) => row.event);
  for (const event of ["sign_in", "shopify_connected", "token_issued", "tool_call"]) assert.ok(events.includes(event), `${event} in ${events}`);
  assert.equal(rows.find((row) => row.tool === "shopify_get_shop_info").user, "pat@bariatricpal.com");
  assert.ok(!JSON.stringify(rows).includes("workerd-online-token"));
  assert.ok(!JSON.stringify(rows).includes(tokens.access_token));
});
