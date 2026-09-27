import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AUDIT_MAX_LINE_BYTES, auditLine } from "../dist/hosted/audit.js";
import { toNodeListener } from "../dist/hosted/node-adapter.js";
import { fetchMetadataDocument } from "../dist/platform/cimd-node.js";
import { isForbiddenAddress } from "../dist/platform/ip.js";
import { FileStore, MemoryStore, nodeDurableFs, writeFileDurable } from "../dist/hosted/store.js";
import { enableHostedMode } from "../dist/runtime.js";
import { requestSource, setRequestSource } from "../dist/hosted/request-source.js";
import { KNOWN_CLIENT_REDIRECTS, RedirectPolicy, isSafePrivateUseRedirect, redirectListFromEnv } from "../dist/hosted/known-clients.js";
import { buildHostedAppFromEnv } from "../dist/serve.js";
import {
  CLAUDE_CALLBACK, KEY, ORIGIN, RESOURCE, auditLines, authorize, authorizeQuery, call, chooseStore, consentForm, cookieNamed, login, loginCookie,
  mcpClient, pageSignIn, pkce, registerClient, setup, shopifyBack, shopifyMock, signedCallback, startToCallback, submitConsent, tokenRequest, ts, useStores
} from "./hosted-fixture.mjs";

// This file runs in its own process (node --test isolates files), so hosted mode stays contained.
enableHostedMode();

/** Environment for buildHostedAppFromEnv. */
async function serveEnv(extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sms-env-"));
  return { MCP_PUBLIC_URL: ORIGIN, SHOPIFY_TOKEN_ENCRYPTION_KEY: KEY.toString("base64"), SHOPIFY_MULTI_STORE_DATA_DIR: dir, ...extra };
}

test("serves protected resource and authorization server metadata", async (t) => {
  const { app } = await setup(t);
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const response = await call(app, path);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.resource, RESOURCE);
    assert.deepEqual(body.authorization_servers, [ORIGIN]);
  }
  const metadata = await (await call(app, "/.well-known/oauth-authorization-server")).json();
  assert.equal(metadata.issuer, ORIGIN);
  assert.equal(metadata.authorization_endpoint, `${ORIGIN}/authorize`);
  assert.equal(metadata.token_endpoint, `${ORIGIN}/token`);
  assert.equal(metadata.registration_endpoint, `${ORIGIN}/register`);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(metadata.response_types_supported, ["code"]);
  assert.equal(metadata.client_id_metadata_document_supported, true);
  for (const method of ["none", "client_secret_post", "client_secret_basic"]) assert.ok(metadata.token_endpoint_auth_methods_supported.includes(method), method);
  const health = await call(app, "/healthz");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
});

test("MCP endpoint answers 401 with WWW-Authenticate resource metadata", async (t) => {
  const { app } = await setup(t);
  const missing = await call(app, "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(missing.status, 401);
  const challenge = missing.headers.get("www-authenticate");
  assert.match(challenge, /^Bearer /);
  assert.match(challenge, new RegExp(`resource_metadata="${ORIGIN}/\\.well-known/oauth-protected-resource/mcp"`));
  assert.doesNotMatch(challenge, /error=/);
  const bad = await call(app, "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sms_at_nope" }, body: "{}" });
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get("www-authenticate"), /error="invalid_token"/);
  // Personal access tokens no longer exist: their prefix is just an invalid token.
  const pat = await call(app, "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer smsp_${"A".repeat(43)}` }, body: "{}" });
  assert.equal(pat.status, 401);
  assert.equal((await call(app, "/tokens")).status, 404);
  assert.equal((await call(app, "/oauth/google/callback?state=x&code=y")).status, 404);
});

test("dynamic client registration accepts allowed redirects and rejects others", async (t) => {
  const { app } = await setup(t);
  const { response, body } = await registerClient(app);
  assert.equal(response.status, 201);
  assert.match(body.client_id, /^sms_client_/);
  assert.deepEqual(body.redirect_uris, [CLAUDE_CALLBACK]);
  assert.equal(body.client_secret, undefined);

  const loopback = await registerClient(app, { redirect_uris: ["http://127.0.0.1:43123/callback"] });
  assert.equal(loopback.response.status, 201);

  const confidential = await registerClient(app, { token_endpoint_auth_method: "client_secret_basic" });
  assert.equal(confidential.response.status, 201);
  assert.match(confidential.body.client_secret, /^sms_cs_/);

  const evil = await registerClient(app, { redirect_uris: ["https://evil.example/callback"] });
  assert.equal(evil.response.status, 400);
  assert.equal(evil.body.error, "invalid_redirect_uri");
});

test("client ID metadata documents are validated and bad redirects rejected", async (t) => {
  const documents = {
    "https://claude.ai/oauth/good.json": { client_id: "https://claude.ai/oauth/good.json", client_name: "Claude", redirect_uris: [CLAUDE_CALLBACK] },
    "https://claude.ai/oauth/bad.json": { client_id: "https://claude.ai/oauth/bad.json", redirect_uris: ["https://evil.example/callback"] },
    "https://claude.ai/oauth/mismatch.json": { client_id: "https://claude.ai/oauth/other.json", redirect_uris: [CLAUDE_CALLBACK] }
  };
  const fetched = [];
  const { app } = await setup(t, { cimdAllowedHosts: ["claude.ai"], fetchClientMetadata: async (url) => { fetched.push(url); return documents[url]; } });
  const { challenge } = pkce();
  const start = (clientId, redirectUri = CLAUDE_CALLBACK) => call(app, `/authorize?${new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state: "s"
  })}`);

  const good = await start("https://claude.ai/oauth/good.json");
  assert.equal(good.status, 200, "the sign-in store chooser");
  assert.match(await good.text(), /Sign in with your Shopify staff account/);

  const bad = await start("https://claude.ai/oauth/bad.json", "https://evil.example/callback");
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get("location"), null);

  const unlisted = await start("https://claude.ai/oauth/good.json", "https://claude.com/api/mcp/auth_callback");
  assert.equal(unlisted.status, 400);

  assert.equal((await start("https://claude.ai/oauth/mismatch.json")).status, 400);
  const foreignHost = await start("https://attacker.example/client.json");
  assert.equal(foreignHost.status, 400);
  assert.ok(!fetched.includes("https://attacker.example/client.json"), "disallowed hosts are never fetched");
});

test("client metadata fetches refuse private, loopback, link-local, and metadata addresses", async (t) => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.100.100.200", "0.0.0.0",
    "::1", "::", "fe80::1", "fd00:ec2::254", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe", "ff02::1", "not-an-ip"]) {
    assert.equal(isForbiddenAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "160.79.104.10", "2606:4700::6810:84e5", "64:ff9b::808:808"]) assert.equal(isForbiddenAddress(address), false, address);

  await assert.rejects(fetchMetadataDocument("https://127.0.0.1/client.json"), /non-public/);
  await assert.rejects(fetchMetadataDocument("https://[::ffff:169.254.169.254]/client.json"), /non-public/);
  await assert.rejects(fetchMetadataDocument("https://localhost/client.json"), /non-public/);

  // With OAUTH_CIMD_ALLOWED_HOSTS=* and the built-in fetcher, a loopback client_id is refused before any connection.
  const logs = [];
  const { app } = await setup(t, { cimdAllowedHosts: ["*"], fetchClientMetadata: fetchMetadataDocument, log: (message) => logs.push(message) });
  const { challenge } = pkce();
  const query = new URLSearchParams({ response_type: "code", client_id: "https://localhost/client.json", redirect_uri: CLAUDE_CALLBACK, code_challenge: challenge, code_challenge_method: "S256", state: "s" });
  const response = await call(app, `/authorize?${query}`);
  assert.equal(response.status, 400);
  assert.ok(logs.some((message) => /non-public/.test(message)), logs.join("\n"));
});

test("authorization requires PKCE S256 and the token endpoint rejects a wrong verifier", async (t) => {
  const { app } = await setup(t);
  const { body: client } = await registerClient(app);
  const plain = await call(app, `/authorize?${new URLSearchParams({
    response_type: "code", client_id: client.client_id, redirect_uri: CLAUDE_CALLBACK, code_challenge: "x".repeat(43), code_challenge_method: "plain", state: "s"
  })}`);
  assert.equal(plain.status, 302);
  const plainRedirect = new URL(plain.headers.get("location"));
  assert.equal(plainRedirect.searchParams.get("error"), "invalid_request");
  assert.equal(plainRedirect.searchParams.get("state"), "s");

  const { challenge } = pkce();
  const redirect = await authorize(app, { clientId: client.client_id, challenge });
  const code = redirect.searchParams.get("code");
  const wrong = await tokenRequest(app, { grant_type: "authorization_code", code, code_verifier: pkce().verifier, redirect_uri: CLAUDE_CALLBACK, client_id: client.client_id });
  assert.equal(wrong.response.status, 400);
  assert.equal(wrong.body.error, "invalid_grant");
  // The code is single use even after a failed attempt.
  const again = await tokenRequest(app, { grant_type: "authorization_code", code, code_verifier: "a".repeat(43), redirect_uri: CLAUDE_CALLBACK, client_id: client.client_id });
  assert.equal(again.body.error, "invalid_grant");
});

test("sign-in shows a store chooser with the identity store first, or goes straight to Shopify with one store", async (t) => {
  const { app } = await setup(t, {}, { identityStore: "wholesale" });
  const { body: client } = await registerClient(app);
  const start = await call(app, `/authorize?${authorizeQuery({ clientId: client.client_id, challenge: pkce().challenge })}`);
  assert.equal(start.status, 200);
  const html = await start.clone().text();
  assert.match(start.headers.get("content-security-policy"), /form-action 'self' https:\/\/\*\.myshopify\.com/);
  const buttons = [...html.matchAll(/name="store" value="([^"]+)"><button( class="primary")?/g)].map((m) => [m[1], Boolean(m[2])]);
  assert.deepEqual(buttons, [["wholesale", true], ["main", false]], "the identity store is listed first and preselected");
  assert.ok(loginCookie(start), "the chooser binds the sign-in to this browser");
  const { authorize: shopify } = await chooseStore(app, start, "main");
  assert.equal(shopify.origin, "https://main.myshopify.com");
  assert.equal(shopify.pathname, "/admin/oauth/authorize");
  assert.equal(shopify.searchParams.get("client_id"), "app-client-id");
  assert.equal(shopify.searchParams.get("scope"), "write_products,write_orders");
  assert.equal(shopify.searchParams.get("redirect_uri"), `${ORIGIN}/shopify/callback`);
  assert.equal(shopify.searchParams.get("grant_options[]"), "per-user");

  useStores(t, [{ alias: "only", shop: "only.myshopify.com" }]);
  const single = await setup(t);
  const { body: other } = await registerClient(single.app);
  const direct = await call(single.app, `/authorize?${authorizeQuery({ clientId: other.client_id, challenge: pkce().challenge })}`);
  assert.equal(direct.status, 302);
  assert.equal(new URL(direct.headers.get("location")).host, "only.myshopify.com");
  assert.ok(loginCookie(direct));
});

test("Shopify sign-in: the principal is the verified staff email, lower-cased, and the login store is connected", async (t) => {
  const requests = await shopifyMock(t);
  const { app, store, oauth, auditPath } = await setup(t);
  const { accessToken } = await login(app, "Pat@BariatricPal.com", { token: "pat-login-main" });
  assert.equal(oauth.exchanges.length, 1);
  assert.equal(oauth.exchanges[0].url, "https://main.myshopify.com/admin/oauth/access_token");
  const records = await store.entries("shopify_token");
  assert.deepEqual(records.map(([, record]) => `${record.email}:${record.alias}`), ["pat@bariatricpal.com:main"]);
  assert.ok(!JSON.stringify(records).includes("pat-login-main"), "token stored only encrypted");

  // The token obtained at sign-in is already that store's connection.
  const client = await mcpClient(t, app, accessToken);
  const info = await client.callTool({ name: "shopify_get_shop_info", arguments: { store: "main" } });
  assert.notEqual(info.isError, true, JSON.stringify(info));
  assert.equal(requests.at(-1).token, "pat-login-main");
  const lines = await auditLines(auditPath);
  assert.equal(lines.find((line) => line.event === "sign_in").user, "pat@bariatricpal.com");
  assert.equal(lines.find((line) => line.tool === "shopify_get_shop_info").user, "pat@bariatricpal.com");
});

test("sign-in refuses unverified emails, offline tokens, a different shop, and bad signatures", async (t) => {
  const { app, store } = await setup(t);
  const { body: client } = await registerClient(app);
  const unverified = await authorize(app, { clientId: client.client_id, challenge: pkce().challenge, flag: "unverified" });
  assert.equal(unverified.searchParams.get("error"), "access_denied");
  assert.match(unverified.searchParams.get("error_description"), /verified email/);
  assert.equal(unverified.searchParams.get("state"), "client-state");
  assert.equal((await store.entries("shopify_token")).length, 0);

  const offline = await setup(t, {}, { offline: true });
  const { body: offlineClient } = await registerClient(offline.app);
  const refused = await authorize(offline.app, { clientId: offlineClient.client_id, challenge: pkce().challenge });
  assert.equal(refused.searchParams.get("error"), "access_denied");
  assert.match(refused.searchParams.get("error_description"), /per-user token/);

  // Chose main, but the callback is for wholesale (validly signed): refused.
  const start = await call(app, `/authorize?${authorizeQuery({ clientId: client.client_id, challenge: pkce().challenge })}`);
  const { authorize: shopify, cookie } = await chooseStore(app, start, "main");
  const swapped = await shopifyBack(app, shopify, { cookie, shop: "wholesale.myshopify.com" });
  assert.equal(swapped.status, 302);
  assert.match(new URL(swapped.headers.get("location")).searchParams.get("error_description"), /different store/);

  // A bad signature never reaches the state.
  const again = await call(app, `/authorize?${authorizeQuery({ clientId: client.client_id, challenge: pkce().challenge })}`);
  const chosen = await chooseStore(app, again, "main");
  assert.equal((await shopifyBack(app, chosen.authorize, { cookie: chosen.cookie, secret: "wrong" })).status, 400);
  assert.equal((await shopifyBack(app, chosen.authorize, { cookie: chosen.cookie, timestamp: String(Math.floor(Date.now() / 1000) - 600) })).status, 400);
  assert.equal((await store.entries("pending")).length, 1, "state not consumed by a rejected signature");
  const ok = await shopifyBack(app, chosen.authorize, { cookie: chosen.cookie });
  assert.equal(ok.status, 200, "consent page");
});

test("issues opaque tokens, rotates refresh tokens, and revokes the family on reuse", async (t) => {
  const { app } = await setup(t);
  const { client, tokens } = await login(app);
  assert.match(tokens.access_token, /^sms_at_/);
  assert.match(tokens.refresh_token, /^sms_rt_/);
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.expires_in, 3600);

  const first = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id, resource: RESOURCE });
  assert.equal(first.response.status, 200);
  assert.notEqual(first.body.refresh_token, tokens.refresh_token);
  assert.notEqual(first.body.access_token, tokens.access_token);

  const second = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: first.body.refresh_token, client_id: client.client_id });
  assert.equal(second.response.status, 200);

  // Replaying the first refresh token revokes every token in the family.
  const replay = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
  assert.equal(replay.body.error, "invalid_grant");
  const afterReplay = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: second.body.refresh_token, client_id: client.client_id });
  assert.equal(afterReplay.body.error, "invalid_grant");
  assert.equal(await app.auth.verifyAccessToken(second.body.access_token), undefined);

  const otherClient = (await registerClient(app)).body;
  const fresh = await login(app);
  const stolen = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: fresh.tokens.refresh_token, client_id: otherClient.client_id });
  assert.equal(stolen.body.error, "invalid_grant");
  const wrongResource = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: fresh.tokens.refresh_token, client_id: fresh.client.client_id, resource: "https://other.example/mcp" });
  assert.equal(wrongResource.body.error, "invalid_target");
  // Neither refusal burned the token: the rightful client can still use it once.
  const rightful = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: fresh.tokens.refresh_token, client_id: fresh.client.client_id });
  assert.equal(rightful.response.status, 200);
});

test("refresh token families have a maximum session age and require a new Shopify sign-in", async (t) => {
  const { app, advance } = await setup(t, { sessionMaxAgeSeconds: 7 * 24 * 3600 });
  const { client, tokens } = await login(app);
  let refresh = tokens.refresh_token;
  // Refreshing every 3 days keeps the session alive only until 7 days after sign-in.
  for (let day = 3; day < 7; day += 3) {
    advance(3 * 24 * 3600_000);
    const next = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: refresh, client_id: client.client_id });
    assert.equal(next.response.status, 200, JSON.stringify(next.body));
    refresh = next.body.refresh_token;
  }
  advance(24 * 3600_000 + 1);
  const expired = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: refresh, client_id: client.client_id });
  assert.equal(expired.response.status, 400);
  assert.equal(expired.body.error, "invalid_grant");
  // A fresh sign-in starts a new session.
  const again = await login(app);
  const refreshed = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: again.tokens.refresh_token, client_id: again.client.client_id });
  assert.equal(refreshed.response.status, 200);
});

test("concurrent use of one refresh token yields exactly one success and revokes the family", async (t) => {
  const { app } = await setup(t);
  const { client, tokens } = await login(app);
  const results = await Promise.all([1, 2, 3, 4].map(() =>
    tokenRequest(app, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id })));
  const ok = results.filter((r) => r.response.status === 200);
  assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.response.status)));
  assert.ok(results.filter((r) => r.response.status !== 200).every((r) => r.body.error === "invalid_grant"));
  // The reuse revoked the whole family, including the tokens the winning request received.
  assert.equal(await app.auth.verifyAccessToken(ok[0].body.access_token), undefined);
  const next = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: ok[0].body.refresh_token, client_id: client.client_id });
  assert.equal(next.body.error, "invalid_grant");
});

test("access tokens expire", async (t) => {
  const { app, advance } = await setup(t);
  const { tokens } = await login(app);
  assert.ok(await app.auth.verifyAccessToken(tokens.access_token));
  advance(3601_000);
  assert.equal(await app.auth.verifyAccessToken(tokens.access_token), undefined);
});

test("every hosted user gets the same tools; Shopify decides, and local-machine tools are absent", async (t) => {
  const requests = await shopifyMock(t);
  const { app } = await setup(t);
  const client = await mcpClient(t, app, (await login(app, "clerk@bariatricpal.com", { token: "clerk-main" })).accessToken);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of ["shopify_get_shop_info", "shopify_graphql_mutation", "shopify_run_action", "shopify_update_product"]) assert.ok(names.includes(name), name);
  for (const local of ["shopify_create_preview_store", "shopify_get_new_store_previews", "shopify_get_new_store_preview_status", "shopify_get_preview_store"]) assert.ok(!names.includes(local), local);
  // A store the person has not connected is simply not reachable; no static token is ever used.
  const other = await client.callTool({ name: "shopify_get_shop_info", arguments: { store: "wholesale" } });
  assert.equal(other.isError, true);
  assert.ok(other.content[0].text.includes(`${ORIGIN}/stores/reconnect`));
  assert.ok(!requests.some((request) => /app-token/.test(request.token ?? "")));
});

test("audit log records mutations with an argument hash and hosted mode refuses local files", async (t) => {
  await shopifyMock(t);
  const { app, auditPath } = await setup(t);
  const { accessToken } = await login(app);
  const client = await mcpClient(t, app, accessToken);

  const mutation = "mutation Update($id: ID!) { productUpdate(product: {id: $id}) { product { id } userErrors { field message } } }";
  const result = await client.callTool({ name: "shopify_graphql_mutation", arguments: { store: "main", mutation, variables: { id: "gid://shopify/Product/1", accessToken: "should-not-log" }, confirm: true } });
  assert.notEqual(result.isError, true, JSON.stringify(result));

  const upload = await client.callTool({ name: "shopify_upload_image", arguments: { store: "main", imageFile: "/etc/passwd", dryRun: false } });
  assert.equal(upload.isError, true);
  assert.match(upload.content[0].text, /not available on the hosted connector/);

  const lines = await auditLines(auditPath);
  const entry = lines.find((line) => line.tool === "shopify_graphql_mutation");
  assert.equal(entry.user, "pat@bariatricpal.com");
  assert.equal(entry.role, undefined, "no roles");
  assert.equal(entry.readOnly, false);
  assert.equal(entry.ok, true);
  assert.deepEqual(entry.stores, ["main"]);
  assert.deepEqual(entry.shopifyAccounts, { main: "pat@bariatricpal.com" });
  assert.match(entry.argsSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(entry.args.mutation.graphql.operations, [{ type: "mutation", rootFields: ["productUpdate"] }]);
  assert.equal(entry.args.mutation.graphql.documentSha256, createHash("sha256").update(mutation).digest("hex"));
  assert.match(entry.args.variables, /^\[sha256:[0-9a-f]{64}\]$/);
  assert.equal(entry.args.confirm, true);
  assert.equal(typeof entry.durationMs, "number");
  assert.ok(!JSON.stringify(lines).includes(accessToken));
  assert.ok(!JSON.stringify(lines).includes("should-not-log"));
});

test("audit log records read-only argument hashes, capped query text, and redacted mutation PII", async (t) => {
  await shopifyMock(t);
  const { app, auditPath } = await setup(t);
  const { accessToken } = await login(app);
  const client = await mcpClient(t, app, accessToken);

  const query = `{ shop { name } }\n#${"q".repeat(5000)}`;
  const read = await client.callTool({ name: "shopify_graphql_query", arguments: { store: "main", query } });
  assert.notEqual(read.isError, true, JSON.stringify(read));

  const mutation = "mutation Update($id: ID!) { productUpdate(product: {id: $id}) { product { id } userErrors { field message } } }";
  const variables = {
    id: "gid://shopify/Product/1",
    email: "customer@example.com",
    phone: "+15185551234",
    shippingAddress: { address1: "1 Main St", city: "Albany", zip: "12205" },
    note: "n".repeat(5000)
  };
  const write = await client.callTool({ name: "shopify_graphql_mutation", arguments: { store: "main", mutation, variables, confirm: true } });
  assert.notEqual(write.isError, true, JSON.stringify(write));

  const lines = await auditLines(auditPath);
  const readEntry = lines.find((line) => line.tool === "shopify_graphql_query");
  assert.match(readEntry.argsSha256, /^[0-9a-f]{64}$/);
  assert.equal(readEntry.query, undefined, "the raw query text is not stored");
  assert.deepEqual(readEntry.args.query.graphql.operations, [{ type: "query", rootFields: ["shop"] }]);
  assert.equal(readEntry.args.store, "main");

  const writeEntry = lines.find((line) => line.tool === "shopify_graphql_mutation");
  assert.match(writeEntry.args.variables, /^\[sha256:[0-9a-f]{64}\]$/);
  assert.equal(writeEntry.args.store, "main");
  const raw = await readFile(auditPath, "utf8");
  for (const secret of ["customer@example.com", "+15185551234", "1 Main St", "nnnnnnnnnn", "qqqqqqqqqq", accessToken]) assert.ok(!raw.includes(secret), secret);
});

test("audit lines never contain customer PII from GraphQL literals, variables, or search arguments", async (t) => {
  await shopifyMock(t);
  const { app, auditPath } = await setup(t);
  const { accessToken } = await login(app, "admin@example.com");
  const client = await mcpClient(t, app, accessToken);

  const pii = ["jane.doe@example.com", "+1 555 010 0199", "5550100199", "Jane", "Doe", "Janet Q. Sample", "12 Elm Street", "Springfield", "90210"];
  const search = 'email:jane.doe@example.com OR phone:5550100199 OR "Janet Q. Sample"';
  const readDocument = `query Lookup($q: String!) {
    customers(first: 5, query: "email:jane.doe@example.com") { nodes { id } }
    byName: customers(first: 5, query: "first_name:Jane last_name:Doe") { nodes { id } }
    orders(first: 1, query: $q) { nodes { id } }
    ...Extra
  }
  fragment Extra on QueryRoot { shop { name } }`;
  const mutation = `mutation {
    customerUpdate(input: { id: "gid://shopify/Customer/7", email: "jane.doe@example.com", phone: "+1 555 010 0199",
      firstName: "Jane", lastName: "Doe", addresses: [{ address1: "12 Elm Street", city: "Springfield", zip: "90210" }] }) {
      customer { id } userErrors { field message }
    }
  }`;
  const variables = { q: search, customer: { email: "jane.doe@example.com", phone: "+1 555 010 0199", firstName: "Jane", lastName: "Doe" } };

  const calls = [
    { name: "shopify_graphql_query", arguments: { store: "main", query: readDocument, variables } },
    { name: "shopify_graphql_query_many", arguments: { stores: ["main", "wholesale"], query: readDocument, variables } },
    { name: "shopify_graphql_mutation", arguments: { store: "main", mutation, variables, confirm: true } },
    { name: "shopify_search", arguments: { resource: "products", stores: ["main"], query: search, first: 5 } },
    { name: "shopify_search", arguments: { resource: "customers", store: "main", query: search } },
    { name: "shopify_search", arguments: { resource: "orders", store: "main", query: "email:jane.doe@example.com" } }
  ];
  for (const request of calls) await client.callTool(request);

  const raw = await readFile(auditPath, "utf8");
  const lines = await auditLines(auditPath);
  for (const request of calls) assert.ok(lines.some((line) => line.tool === request.name), request.name);
  // The signed-in staff email is example.com; customer PII still never appears.
  for (const value of pii) assert.ok(!raw.includes(value), `audit log contains ${value}`);
  assert.ok(!raw.includes("email:"), "no search expression survives");

  const query = lines.find((line) => line.tool === "shopify_graphql_query");
  assert.deepEqual(query.args.query.graphql.operations, [{ type: "query", rootFields: ["customers", "orders", "shop"] }]);
  assert.deepEqual(query.args.query.graphql.argumentNames, ["first", "query"]);
  assert.equal(query.args.query.graphql.documentSha256, createHash("sha256").update(readDocument).digest("hex"));
  assert.match(query.args.variables, /^\[sha256:[0-9a-f]{64}\]$/);
  assert.equal(query.args.store, "main");

  const many = lines.find((line) => line.tool === "shopify_graphql_query_many");
  assert.deepEqual(many.args.stores, ["main", "wholesale"]);

  const write = lines.find((line) => line.tool === "shopify_graphql_mutation");
  assert.deepEqual(write.args.mutation.graphql.operations, [{ type: "mutation", rootFields: ["customerUpdate"] }]);
  assert.deepEqual(write.args.mutation.graphql.argumentNames, ["input"]);

  const [searchEntry, customers, orders] = lines.filter((line) => line.tool === "shopify_search");
  assert.match(searchEntry.args.query, /^\[sha256:[0-9a-f]{64}\]$/);
  assert.equal(searchEntry.args.first, 5);
  assert.match(orders.args.query, /^\[sha256:[0-9a-f]{64}\]$/);
  assert.notEqual(orders.args.query, customers.args.query, "different searches hash differently");
});

test("audit lines record failed tool calls as structured codes, never the error text", async (t) => {
  const pii = ["jane.doe@example.com", "+1 555 010 0199", "Janet Q. Sample", "12 Elm Street", "Springfield"];
  const echo = `${pii[0]} ${pii[1]} ${pii[2]} ${pii[3]}, ${pii[4]}`;
  await shopifyMock(t, (body) => {
    if (/customerUpdate/.test(body.query)) {
      return { body: { data: { customerUpdate: { customer: null, userErrors: [{ field: ["input", "email"], code: "TAKEN", message: `Email ${echo} has already been taken` }] } } } };
    }
    return { status: 403, body: { errors: [{ message: `Access denied for ${echo}`, extensions: { code: "ACCESS_DENIED" } }] } };
  });
  const { app, auditPath } = await setup(t);
  const { accessToken } = await login(app, "admin@example.com");
  const client = await mcpClient(t, app, accessToken);

  const read = await client.callTool({ name: "shopify_graphql_query", arguments: { store: "main", query: "{ shop { name } }" } });
  assert.equal(read.isError, true);
  assert.ok(read.content[0].text.includes(pii[0]), "the caller still sees the full message");
  const mutation = "mutation Update($input: CustomerInput!) { customerUpdate(input: $input) { customer { id } userErrors { field code message } } }";
  const write = await client.callTool({ name: "shopify_graphql_mutation", arguments: { store: "main", mutation, variables: { input: { id: "gid://shopify/Customer/7", email: pii[0] } }, confirm: true } });
  assert.equal(write.isError, true);

  const raw = await readFile(auditPath, "utf8");
  for (const value of [...pii, "Access denied for", "already been taken"]) assert.ok(!raw.includes(value), `audit log contains ${value}`);
  const lines = await auditLines(auditPath);
  const readEntry = lines.find((line) => line.tool === "shopify_graphql_query");
  assert.equal(readEntry.ok, false);
  assert.equal(readEntry.error.class, "http_error");
  assert.equal(readEntry.error.httpStatus, 403);
  assert.deepEqual(readEntry.error.codes, ["ACCESS_DENIED"]);
  assert.match(readEntry.error.messageSha256, /^[0-9a-f]{64}$/);
  assert.equal(readEntry.error.messageSha256, createHash("sha256").update(read.content[0].text).digest("hex"));
  const writeEntry = lines.find((line) => line.tool === "shopify_graphql_mutation");
  assert.equal(writeEntry.ok, false);
  assert.equal(writeEntry.error.class, "user_errors");
  assert.deepEqual(writeEntry.error.codes, ["TAKEN"]);
  assert.deepEqual(writeEntry.error.fields, ["input.email"]);
});

test("audit log records sign-in, token, refresh, and 401 events without tokens", async (t) => {
  const { app, auditPath } = await setup(t);
  const { client, tokens } = await login(app);
  const refreshed = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
  assert.equal(refreshed.response.status, 200);
  const { body: other } = await registerClient(app);
  await authorize(app, { clientId: other.client_id, challenge: pkce().challenge, email: "stranger@bariatricpal.com", flag: "unverified" });
  const noToken = await call(app, "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(noToken.status, 401);
  const badToken = await call(app, "/mcp", { method: "POST", headers: { authorization: "Bearer sms_at_nope", "content-type": "application/json" }, body: "{}" });
  assert.equal(badToken.status, 401);

  const lines = await auditLines(auditPath);
  const events = lines.map((line) => line.event);
  for (const event of ["sign_in", "token_issued", "token_refreshed", "sign_in_denied", "request_unauthorized", "shopify_connected"]) assert.ok(events.includes(event), event);
  assert.equal(lines.find((line) => line.event === "sign_in").user, "pat@bariatricpal.com");
  assert.match(lines.find((line) => line.event === "sign_in_denied").reason, /verified email/);
  assert.equal(lines.filter((line) => line.event === "request_unauthorized").length, 2);
  const raw = await readFile(auditPath, "utf8");
  for (const secret of [tokens.access_token, tokens.refresh_token, refreshed.body.access_token, refreshed.body.refresh_token, "online-main-token"]) assert.ok(!raw.includes(secret));
});

test("file store persists atomically and serves over node:http", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sms-store-"));
  const path = join(dir, "oauth.json");
  const store = await FileStore.open(path);
  await store.put("client", "c1", { client_id: "c1" });
  await store.put("code", "expired", { x: 1 }, Date.now() - 1);
  const reopened = await FileStore.open(path);
  assert.deepEqual(await reopened.get("client", "c1"), { client_id: "c1" });
  assert.equal(await reopened.get("code", "expired"), undefined);
  assert.deepEqual(await reopened.take("client", "c1"), { client_id: "c1" });
  assert.equal(await (await FileStore.open(path)).get("client", "c1"), undefined);

  const { app } = await setup(t);
  const server = http.createServer(toNodeListener(app.fetch, { origin: ORIGIN, maxBodyBytes: 1024 }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const tooLarge = await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(4096) });
  assert.equal(tooLarge.status, 413);
});

test("registered clients expire after 30 idle days, and use pushes the expiry back", async (t) => {
  const { app, store, advance } = await setup(t);
  const { body: idle } = await registerClient(app);
  const { body: active } = await registerClient(app);
  assert.ok(await store.get("client", idle.client_id));
  const start = (clientId) => call(app, `/authorize?${authorizeQuery({ clientId, challenge: pkce().challenge })}`);
  advance(20 * 24 * 3600_000);
  assert.equal((await start(active.client_id)).status, 200, "used on day 20");
  advance(15 * 24 * 3600_000);
  assert.equal(await store.get("client", idle.client_id), undefined, "unused for 35 days: gone");
  const gone = await start(idle.client_id);
  assert.equal(gone.status, 400);
  assert.match(await gone.text(), /Unknown client_id/);
  assert.equal((await start(active.client_id)).status, 200, "used 15 days ago: still there");
  // A record written before client expiry existed (no last_used_at, no expiry) gets one on first use.
  await store.put("client", "sms_client_legacy", { client_id: "sms_client_legacy", redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] });
  assert.equal((await start("sms_client_legacy")).status, 200);
  assert.ok((await store.get("client", "sms_client_legacy")).last_used_at);
  advance(30 * 24 * 3600_000 + 1);
  assert.equal(await store.get("client", "sms_client_legacy"), undefined);
});

test("client registration is limited per source address per hour and by a total cap", async (t) => {
  const { app, advance } = await setup(t, { maxRegistrationsPerSourcePerHour: 2, maxRegisteredClients: 5 });
  const register = (source) => {
    const request = new Request(`${ORIGIN}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" }) });
    setRequestSource(request, source);
    return app.fetch(request);
  };
  assert.equal((await register("203.0.113.7")).status, 201);
  assert.equal((await register("203.0.113.7")).status, 201);
  const limited = await register("203.0.113.7");
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, "temporarily_unavailable");
  const retryAfter = Number(limited.headers.get("retry-after"));
  assert.ok(retryAfter >= 1 && retryAfter <= 3600, String(retryAfter));
  assert.equal((await register("198.51.100.9")).status, 201, "another address has its own allowance");
  advance(3600_000);
  assert.equal((await register("203.0.113.7")).status, 201, "the next hour starts fresh");
  assert.equal((await register("192.0.2.1")).status, 201);
  const full = await register("192.0.2.2");
  assert.equal(full.status, 503, "the total cap still applies");
  assert.match((await full.json()).error_description, /registration limit/);

  const open = (await setup(t, { maxRegistrationsPerSourcePerHour: 0 })).app;
  for (let i = 0; i < 5; i += 1) assert.equal((await registerClient(open)).response.status, 201, "0 turns the per-source limit off");
});

test("the Node adapter records the socket address as the request source, never a forwarding header", async (t) => {
  const seen = [];
  const server = http.createServer(toNodeListener(async (request) => { seen.push(requestSource(request)); return new Response("ok"); }, { origin: ORIGIN, maxBodyBytes: 1024 }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  await (await fetch(`http://127.0.0.1:${server.address().port}/`, { headers: { "x-forwarded-for": "203.0.113.50", "cf-connecting-ip": "203.0.113.51" } })).text();
  assert.equal(seen.length, 1);
  assert.match(seen[0], /127\.0\.0\.1$/);
});

test("OAUTH_CLIENT_IDLE_TTL_SECONDS and OAUTH_MAX_REGISTRATIONS_PER_SOURCE_PER_HOUR are read and checked", async () => {
  const { hostedOptionsFromEnv } = await import("../dist/hosted/config.js");
  const env = { MCP_PUBLIC_URL: ORIGIN, SHOPIFY_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") };
  const platform = { loadStores: async () => [] };
  const defaults = await hostedOptionsFromEnv(env, platform);
  assert.equal(defaults.clientIdleTtlSeconds, 30 * 24 * 3600);
  assert.equal(defaults.maxRegistrationsPerSourcePerHour, 30);
  const set = await hostedOptionsFromEnv({ ...env, OAUTH_CLIENT_IDLE_TTL_SECONDS: "86400", OAUTH_MAX_REGISTRATIONS_PER_SOURCE_PER_HOUR: "0" }, platform);
  assert.equal(set.clientIdleTtlSeconds, 86400);
  assert.equal(set.maxRegistrationsPerSourcePerHour, 0);
  await assert.rejects(hostedOptionsFromEnv({ ...env, OAUTH_MAX_REGISTRATIONS_PER_SOURCE_PER_HOUR: "-1" }, platform), /OAUTH_MAX_REGISTRATIONS_PER_SOURCE_PER_HOUR/);
});

test("MemoryStore.increment counts atomically up to a maximum and keeps the first expiry", async () => {
  let now = 1_000;
  const store = new MemoryStore(() => now);
  assert.deepEqual(await store.increment("counter", "k", { max: 2, expiresAt: 2_000 }), { value: 1, applied: true });
  assert.deepEqual(await store.increment("counter", "k", { max: 2, expiresAt: 9_000 }), { value: 2, applied: true });
  assert.deepEqual(await store.increment("counter", "k", { max: 2 }), { value: 2, applied: false });
  now = 2_000;
  assert.deepEqual(await store.increment("counter", "k", { max: 2, expiresAt: 3_000 }), { value: 1, applied: true }, "the first expiry held; a new window starts");
  const results = await Promise.all(Array.from({ length: 10 }, () => store.increment("counter", "race", { max: 3 })));
  assert.equal(results.filter((result) => result.applied).length, 3);
});

test("auditError keeps codes, statuses and field paths, never message text", async () => {
  const { auditError } = await import("../dist/hosted/audit.js");
  const thrown = new TypeError("Shopify throttled main for jane.doe@example.com at 12 Elm Street. Response: {\"errors\":[{\"message\":\"Jane Doe\",\"extensions\":{\"code\":\"THROTTLED\"}}]}");
  const info = auditError(thrown);
  assert.equal(info.class, "throttled");
  assert.equal(info.exception, "TypeError");
  assert.deepEqual(info.codes, ["THROTTLED"]);
  const text = JSON.stringify(info);
  for (const value of ["jane.doe@example.com", "12 Elm Street", "Jane Doe"]) assert.ok(!text.includes(value), value);
  const denied = auditError(undefined, { isError: true, content: [{ type: "text", text: "Access denied: jane@example.com is not allowed to use store \"x\"." }] });
  assert.equal(denied.class, "access_denied");
  assert.ok(!JSON.stringify(denied).includes("jane@example.com"));
  const odd = auditError(undefined, { isError: true, structuredContent: { userErrors: [{ field: ["input", "Jane Doe <jane@example.com>"], code: "not a code", message: "x" }] }, content: [{ type: "text", text: "failed" }] });
  assert.deepEqual(odd.fields, ["input.?"]);
  assert.equal(odd.codes, undefined);
});

test("audit argument reduction keeps only allowlisted scalars", async () => {
  const { auditArguments, summarizeGraphql } = await import("../dist/hosted/audit.js");
  const reduced = auditArguments({
    store: "main",
    stores: ["main", "Not An Alias!"],
    id: "gid://shopify/Product/1",
    productIds: ["gid://shopify/Product/2", "Jane Doe"],
    orderId: "12345",
    status: "ACTIVE",
    sortKey: "Jane Doe",
    first: 10,
    confirm: true,
    title: "Gift for Jane Doe",
    tags: ["vip", "jane.doe@example.com"],
    zip: 90210,
    customerName: "Janet Q. Sample",
    shipping: { address1: "12 Elm Street", note: "call +1 555 010 0199" },
    apiToken: "secret-value"
  });
  const text = JSON.stringify(reduced);
  for (const value of ["Jane", "Doe", "Janet", "jane.doe@example.com", "12 Elm Street", "90210", "555 010", "secret-value", "Not An Alias", "Gift", "vip"]) {
    assert.ok(!text.includes(value), value);
  }
  assert.equal(reduced.store, "main");
  assert.equal(reduced.stores[0], "main");
  assert.equal(reduced.id, "gid://shopify/Product/1");
  assert.equal(reduced.productIds[0], "gid://shopify/Product/2");
  assert.equal(reduced.orderId, "12345");
  assert.equal(reduced.status, "ACTIVE");
  assert.equal(reduced.first, 10);
  assert.equal(reduced.confirm, true);
  assert.equal(reduced.apiToken, "[REDACTED]");
  assert.match(reduced.zip, /^\[sha256:/);
  assert.match(summarizeGraphql("email:jane.doe@example.com"), /^\[sha256:[0-9a-f]{64}\]$/, "unparseable text is only hashed");
});

test("audit lines are capped at 64KB", () => {
  const huge = { timestamp: new Date().toISOString(), user: "a@b.com", role: "admin", tool: "x", stores: [], readOnly: false, ok: true, durationMs: 1, argsSha256: "0".repeat(64), args: { list: Array.from({ length: 200 }, () => "z".repeat(2000)) } };
  const line = auditLine(huge);
  assert.ok(Buffer.byteLength(line) <= AUDIT_MAX_LINE_BYTES);
  const parsed = JSON.parse(line);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.argsSha256, huge.argsSha256);
});

/** A filesystem that records every call and forwards to the real one, with optional injected failures. */
function recordingFs({ platform = process.platform, fail = {} } = {}) {
  const calls = [];
  const fs = {
    platform,
    async open(path, flags, mode) {
      calls.push({ op: "open", path, flags, mode });
      if (fail.open?.(path, flags)) throw Object.assign(new Error("open failed"), { code: fail.openCode ?? "EACCES" });
      const handle = await nodeDurableFs.open(path, flags, mode);
      return {
        async writeFile(data, options) { calls.push({ op: "write", path, flags }); return handle.writeFile(data, options); },
        async sync() {
          calls.push({ op: "sync", path, flags });
          if (fail.sync?.(path, flags)) throw Object.assign(new Error("sync failed"), { code: fail.syncCode });
          // A simulated POSIX directory fsync cannot run on a real Windows host (Windows cannot
          // fsync a directory handle); record it, and only perform real file syncs there.
          if (process.platform === "win32" && flags === "r") return;
          return handle.sync();
        },
        async close() { calls.push({ op: "close", path }); return handle.close(); }
      };
    },
    async rename(from, to) {
      calls.push({ op: "rename", from, to });
      if (fail.rename) throw Object.assign(new Error("rename failed"), { code: "EPERM" });
      return nodeDurableFs.rename(from, to);
    },
    async unlink(path) { calls.push({ op: "unlink", path }); return nodeDurableFs.unlink(path); }
  };
  return { fs, calls };
}

test("durable writes sync a writable handle, then rename, then sync the directory except on Windows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sms-durable-"));
  const path = join(dir, "state.json");

  const posix = recordingFs({ platform: "linux" });
  await writeFileDurable(path, "{\"a\":1}", posix.fs);
  assert.equal(await readFile(path, "utf8"), "{\"a\":1}");
  const ops = posix.calls.map((c) => c.op);
  assert.deepEqual(ops, ["open", "write", "sync", "close", "rename", "open", "sync", "close"]);
  const [openTemp, , syncTemp] = posix.calls;
  assert.equal(openTemp.flags, "wx", "the temp file is opened for writing, never read-only");
  assert.equal(openTemp.mode, 0o600);
  assert.equal(syncTemp.path, openTemp.path, "the synced handle is the one that was written");
  assert.equal(syncTemp.flags, "wx");
  assert.equal(posix.calls[4].from, openTemp.path);
  assert.equal(posix.calls[5].path, dir, "directory fsync after rename");
  assert.ok(!posix.calls.some((c) => c.op === "open" && c.flags === "r" && c.path !== dir), "no read-only reopen of the temp file");

  const windows = recordingFs({ platform: "win32" });
  await writeFileDurable(path, "{\"b\":2}", windows.fs);
  assert.deepEqual(windows.calls.map((c) => c.op), ["open", "write", "sync", "close", "rename"]);
  assert.equal(await readFile(path, "utf8"), "{\"b\":2}");

  // A filesystem without directory fsync is tolerated.
  const unsupported = recordingFs({ platform: "linux", fail: { sync: (p) => p === dir, syncCode: "EINVAL" } });
  await writeFileDurable(path, "{\"c\":3}", unsupported.fs);
  assert.equal(await readFile(path, "utf8"), "{\"c\":3}");
});

test("durable writes propagate every error other than unsupported directory fsync and leave no temp file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sms-durable-"));
  const path = join(dir, "state.json");
  const { readdir } = await import("node:fs/promises");

  const dirIo = recordingFs({ platform: "linux", fail: { sync: (p) => p === dir, syncCode: "EIO" } });
  await assert.rejects(writeFileDurable(path, "{}", dirIo.fs), /sync failed/);

  const fileSync = recordingFs({ platform: "win32", fail: { sync: (p) => p !== dir, syncCode: "EPERM" } });
  await assert.rejects(writeFileDurable(path, "{\"x\":1}", fileSync.fs), /sync failed/);
  assert.ok(fileSync.calls.some((c) => c.op === "unlink"), "temp file removed after a failed sync");

  const renameFails = recordingFs({ platform: "linux", fail: { rename: true } });
  await assert.rejects(writeFileDurable(path, "{\"y\":1}", renameFails.fs), /rename failed/);
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  assert.equal(await readFile(path, "utf8"), "{}", "the target keeps its last good content");

  // FileStore surfaces the failure to the caller and retries the change on the next write.
  const flaky = recordingFs({ platform: "linux", fail: { rename: true } });
  const store = await FileStore.open(join(dir, "oauth.json"), Date.now, flaky.fs);
  await assert.rejects(store.put("client", "c1", { client_id: "c1" }), /rename failed/);
  delete flaky.fs.rename;
  flaky.fs.rename = (from, to) => nodeDurableFs.rename(from, to);
  await store.put("client", "c2", { client_id: "c2" });
  const reopened = await FileStore.open(join(dir, "oauth.json"));
  assert.deepEqual(await reopened.get("client", "c1"), { client_id: "c1" });
  assert.deepEqual(await reopened.get("client", "c2"), { client_id: "c2" });
});

test("hosted mode refuses a store configuration with two aliases for one shop", async (t) => {
  const { loadStores } = await import("../dist/config.js");
  const previous = process.env.STORES_JSON;
  t.after(() => { if (previous === undefined) delete process.env.STORES_JSON; else process.env.STORES_JSON = previous; });
  process.env.STORES_JSON = JSON.stringify({ stores: [
    { alias: "retail", shop: "example-one.myshopify.com" },
    { alias: "outlet", shop: "example-two.myshopify.com" },
    { alias: "retail-alt", shop: "Example-One.myshopify.com" }
  ] });
  await assert.rejects(loadStores(), /"retail" and "retail-alt" both point to/);
  process.env.STORES_JSON = JSON.stringify({ stores: [
    { alias: "retail", shop: "example-one.myshopify.com" },
    { alias: "outlet", shop: "example-two.myshopify.com" }
  ] });
  assert.deepEqual((await loadStores()).map((store) => store.alias), ["retail", "outlet"]);
});

test("redirect policy accepts known MCP clients and loopback by default", async (t) => {
  const policy = new RedirectPolicy();
  for (const uri of [
    "https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback",
    "https://chatgpt.com/connector_platform_oauth_redirect", "https://vscode.dev/redirect",
    "https://insiders.vscode.dev/redirect", "cursor://anysphere.cursor-mcp/oauth/callback"
  ]) assert.equal(policy.classify(uri), "listed", uri);
  for (const uri of ["http://localhost:33418/callback", "http://127.0.0.1:8976/oauth/callback", "http://[::1]:1234/x"]) assert.equal(policy.classify(uri), "loopback", uri);
  for (const uri of ["https://evil.example/callback", "https://chatgpt.com/aip/g-1/oauth/callback", "http://evil.example/cb", "myapp://cb", "http://localhost:1/cb#frag"]) {
    assert.equal(policy.classify(uri), null, uri);
  }
  assert.ok(KNOWN_CLIENT_REDIRECTS.every((entry) => entry.client && entry.uri));

  const { app } = await setup(t);
  for (const uri of ["https://chatgpt.com/connector_platform_oauth_redirect", "cursor://anysphere.cursor-mcp/oauth/callback", "https://vscode.dev/redirect"]) {
    const { response } = await registerClient(app, { redirect_uris: [uri] });
    assert.equal(response.status, 201, uri);
  }
});

test("OAUTH_ALLOW_ANY_REDIRECT admits https and safe custom schemes but never dangerous ones", async (t) => {
  const policy = new RedirectPolicy({ allowAny: true });
  for (const uri of ["https://app.example.com/oauth/cb", "com.example.app:/oauth2redirect", "vendorapp://ide.example/mcp/callback"]) assert.equal(policy.classify(uri), "open", uri);
  for (const uri of [
    "javascript:alert(1)", "JavaScript://x/%0aalert(1)", "data:text/html,hi", "file:///etc/passwd", "http://evil.example/cb",
    "httpx://evil.example/cb", "https.evil://cb", "hxxps://cb", "vbscript:x", "blob:https://x/1", "ws://x/", "myapp://user:pw@host/cb",
    "myapp://host/cb#frag", "my app://cb", "https://user@evil.example/cb"
  ]) {
    assert.equal(policy.classify(uri), null, uri);
  }
  assert.equal(isSafePrivateUseRedirect("cursor://anysphere.cursor-mcp/oauth/callback"), true);

  const { app } = await setup(t, { allowAnyRedirect: true });
  assert.equal((await registerClient(app, { redirect_uris: ["https://app.example.com/cb"] })).response.status, 201);
  assert.equal((await registerClient(app, { redirect_uris: ["javascript:alert(1)"] })).response.status, 400);
});

test("OAUTH_REDIRECT_URIS adds to the built-ins unless OAUTH_REDIRECT_URIS_REPLACE is set", async (t) => {
  const added = redirectListFromEnv(["https://tools.example.com/cb"], false);
  assert.ok(new Set(added).has("https://claude.ai/api/mcp/auth_callback"));
  assert.ok(new Set(added).has("https://tools.example.com/cb"));
  assert.deepEqual(redirectListFromEnv(["https://tools.example.com/cb"], true), ["https://tools.example.com/cb"]);

  const base = await serveEnv();
  const additive = (await buildHostedAppFromEnv({ ...base, OAUTH_REDIRECT_URIS: "https://tools.example.com/cb" })).app;
  t.after(() => additive.close());
  assert.equal(additive.auth.redirectUriClass("https://tools.example.com/cb"), "listed");
  assert.equal(additive.auth.redirectUriClass("https://chatgpt.com/connector_platform_oauth_redirect"), "listed");
  assert.equal(additive.auth.redirectUriClass("https://other.example.com/cb"), null);
  const replaced = (await buildHostedAppFromEnv({ ...base, OAUTH_REDIRECT_URIS: "https://tools.example.com/cb", OAUTH_REDIRECT_URIS_REPLACE: "1" })).app;
  t.after(() => replaced.close());
  assert.equal(replaced.auth.redirectUriClass("https://claude.ai/api/mcp/auth_callback"), null);
  const open = (await buildHostedAppFromEnv({ ...base, OAUTH_ALLOW_ANY_REDIRECT: "1" })).app;
  t.after(() => open.close());
  assert.equal(open.auth.redirectUriClass("https://other.example.com/cb"), "open");
});

test("serve needs an encryption key, has no Google, policy, role or personal-token settings, and checks SHOPIFY_IDENTITY_STORE", async (t) => {
  const base = await serveEnv();
  const { SHOPIFY_TOKEN_ENCRYPTION_KEY, ...noKey } = base;
  await assert.rejects(buildHostedAppFromEnv(noKey), /SHOPIFY_TOKEN_ENCRYPTION_KEY/);
  const app = (await buildHostedAppFromEnv({ ...base })).app;
  t.after(() => app.close());
  assert.ok(app.shopify);
  assert.equal(app.tokens, undefined);
  assert.equal(app.accessMode, undefined);
  useStores(t);
  await assert.rejects(buildHostedAppFromEnv({ ...base, SHOPIFY_IDENTITY_STORE: "nope" }), /SHOPIFY_IDENTITY_STORE/);
  const identity = (await buildHostedAppFromEnv({ ...base, SHOPIFY_IDENTITY_STORE: "wholesale" })).app;
  t.after(() => identity.close());
  const source = (await readFile(new URL("../src/serve.ts", import.meta.url), "utf8")) + (await readFile(new URL("../src/hosted/config.ts", import.meta.url), "utf8"));
  for (const removed of ["GOOGLE_CLIENT_ID", "ALLOWED_EMAIL_DOMAINS", "SHOPIFY_MULTI_STORE_POLICY", "SHOPIFY_ACCESS_MODE", "PERSONAL_TOKEN"]) assert.ok(!source.includes(removed), removed);
});

test("the sign-in binding cookie is host-only, per sign-in, and required by the chooser", async (t) => {
  const { app, store, oauth } = await setup(t);
  const { body: client } = await registerClient(app);
  const start = await call(app, `/authorize?${authorizeQuery({ clientId: client.client_id, challenge: pkce().challenge })}`);
  const set = start.headers.getSetCookie().find((value) => value.startsWith("__Host-sms_login_"));
  assert.match(set, /^__Host-sms_login_[0-9a-f]{24}=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/);
  const storesStart = await call(app, "/stores");
  assert.ok(loginCookie(storesStart), "the /stores sign-in is bound too");
  assert.notEqual(loginCookie(storesStart).split("=")[0], loginCookie(start).split("=")[0], "one cookie per sign-in");

  // A chooser form forwarded to another browser: no cookie, no redirect to Shopify, state kept.
  const state = /name="state" value="([^"]+)"/.exec(await start.clone().text())[1];
  const post = (cookie, headers = {}) => call(app, "/login/shopify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, ...(cookie ? { cookie } : {}), ...headers }, body: new URLSearchParams({ state, store: "main" }) });
  const forwarded = await post(null);
  assert.equal(forwarded.status, 403);
  assert.equal(forwarded.headers.get("location"), null);
  assert.equal((await post(loginCookie(storesStart))).status, 403, "another sign-in's cookie does not fit");
  assert.equal((await post(loginCookie(start), { origin: "https://evil.example" })).status, 403);
  assert.equal((await store.entries("pending")).length, 2, "nothing consumed");
  assert.equal(oauth.exchanges.length, 0);
  assert.equal((await post(loginCookie(start))).status, 302);
});

test("a forwarded Shopify callback without the originating cookie creates no session and leaves the state unconsumed", async (t) => {
  const { app, oauth, store, auditPath } = await setup(t);
  const { body: client } = await registerClient(app);
  // The attacker starts a sign-in in their own browser and logs in to Shopify as themselves...
  const start = await call(app, `/authorize?${authorizeQuery({ clientId: client.client_id, challenge: pkce().challenge })}`);
  const { authorize: shopify, cookie } = await chooseStore(app, start, "main");
  // ...then sends the unredeemed callback URL to the victim, whose browser has no binding cookie.
  const forwarded = await shopifyBack(app, shopify, { email: "attacker@example.com" });
  assert.equal(forwarded.status, 403);
  assert.match(await forwarded.text(), /different browser/);
  assert.equal(forwarded.headers.get("location"), null, "no redirect with a code");
  assert.deepEqual(forwarded.headers.getSetCookie().filter((value) => /^__Host-sms_(consent|stores)=/.test(value)), [], "no consent or session cookie");
  assert.deepEqual(oauth.exchanges, [], "the Shopify code was not exchanged");
  assert.equal((await store.entries("pending")).length, 1, "state is not consumed by an unbound callback");
  assert.equal((await store.entries("code")).length, 0);
  assert.equal((await store.entries("shopify_token")).length, 0, "no token stored under anyone");

  // The victim's own unrelated sign-in cookie does not help: it binds a different state.
  const victimStart = await call(app, `/authorize?${authorizeQuery({ clientId: client.client_id, challenge: pkce().challenge })}`);
  const crossed = await shopifyBack(app, shopify, { email: "attacker@example.com", cookie: loginCookie(victimStart) });
  assert.equal(crossed.status, 403);
  const forged = await shopifyBack(app, shopify, { email: "attacker@example.com", cookie: `${cookie.split("=")[0]}=${"A".repeat(43)}` });
  assert.equal(forged.status, 403);
  assert.deepEqual(oauth.exchanges, []);

  const lines = await auditLines(auditPath);
  assert.ok(lines.some((line) => line.event === "sign_in_denied" && /not bound to this browser/.test(line.reason) && line.clientId === client.client_id));

  // In the browser that started it, the same state still works (and only for that browser's user).
  const own = await shopifyBack(app, shopify, { email: "attacker@example.com", cookie });
  assert.equal(own.status, 200);
  assert.ok((await consentForm(own)).html.includes("attacker@example.com"));
});

test("a bound Shopify callback is single use, expires, and clears the binding cookie", async (t) => {
  const { app, oauth, advance } = await setup(t);
  const { body: client } = await registerClient(app);
  const begin = async () => {
    const start = await call(app, `/authorize?${authorizeQuery({ clientId: client.client_id, challenge: pkce().challenge })}`);
    return chooseStore(app, start, "main");
  };
  const cleared = (response, cookie) => response.headers.getSetCookie().some((value) => value.startsWith(`${cookie.split("=")[0]}=;`) && /Max-Age=0/.test(value));

  const first = await begin();
  const done = await shopifyBack(app, first.authorize, { email: "victim@example.com", cookie: first.cookie });
  assert.equal(done.status, 200, "consent page");
  assert.ok(cleared(done, first.cookie), "success clears the binding cookie");
  assert.match(done.headers.getSetCookie().join("\n"), /__Host-sms_consent=/, "the consent cookie is still set");
  assert.equal(oauth.exchanges.length, 1);

  // A replay no longer names a pending sign-in, so it is treated as a store connection and refused.
  const replay = await shopifyBack(app, first.authorize, { email: "victim@example.com", cookie: first.cookie });
  assert.equal(replay.status, 400, "replay refused");
  assert.equal(oauth.exchanges.length, 1, "no second exchange");

  const late = await begin();
  advance(10 * 60_000 + 1);
  const expired = await shopifyBack(app, late.authorize, { email: "victim@example.com", cookie: late.cookie });
  assert.equal(expired.status, 400);
  assert.equal(oauth.exchanges.length, 1);
});

test("node:http keeps every Set-Cookie header of a response", async (t) => {
  const { app } = await setup(t);
  const { body: client } = await registerClient(app);
  const server = http.createServer(toNodeListener(app.fetch, { origin: ORIGIN, maxBodyBytes: 64 * 1024 }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const start = await fetch(`${base}/authorize?${authorizeQuery({ clientId: client.client_id, challenge: pkce().challenge })}`, { redirect: "manual" });
  const html = await start.text();
  const state = /name="state" value="([^"]+)"/.exec(html)[1];
  const cookie = loginCookie(start);
  const chosen = await fetch(`${base}/login/shopify`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie }, body: new URLSearchParams({ state, store: "main" }) });
  const search = signedCallback({ code: "victim@example.com|t", shop: "main.myshopify.com", state: new URL(chosen.headers.get("location")).searchParams.get("state"), timestamp: ts() });
  const back = await fetch(`${base}/shopify/callback?${search}`, { headers: { cookie }, redirect: "manual" });
  assert.equal(back.status, 200);
  const cookies = back.headers.getSetCookie();
  assert.equal(cookies.length, 2, cookies.join("\n"));
  assert.ok(cookies.some((value) => value.startsWith("__Host-sms_consent=")));
  assert.ok(cookies.some((value) => value.startsWith("__Host-sms_login_")));
});

test("consent screen shows the client, redirect host, and signed-in Shopify user, and escapes the client name", async (t) => {
  const { app } = await setup(t);
  const { body: client } = await registerClient(app, { client_name: "<script>alert(1)</script> Tool" });
  const page = await startToCallback(app, { clientId: client.client_id, email: "viewer@bariatricpal.com" });
  assert.equal(page.status, 200);
  const csp = page.headers.get("content-security-policy");
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /form-action 'self' https:\/\/claude\.ai/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.match(page.headers.get("cache-control"), /no-store/);
  assert.match(page.headers.getSetCookie().join("\n"), /__Host-sms_consent=.+; Path=\/; HttpOnly; Secure; SameSite=Lax/);
  const { html } = await consentForm(page);
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt; Tool"));
  for (const text of [client.client_id, "claude.ai", "viewer@bariatricpal.com", "Shopify, main", "Shopify staff permissions", "Shopify Multi-Store", "Approve", "Deny"]) assert.ok(html.includes(text), text);
  assert.ok(!/role/i.test(html), "no roles");
  assert.ok(!/<(script|img|link|iframe)\b/i.test(html), "no external assets or scripts");
});

test("consent deny returns access_denied and approve is remembered for 30 days", async (t) => {
  // Clients outlive the 30-day approval here; idle client expiry has its own test.
  const { app, advance } = await setup(t, { clientIdleTtlSeconds: 90 * 24 * 3600 });
  const { body: client } = await registerClient(app);
  const denied = await authorize(app, { clientId: client.client_id, challenge: pkce().challenge, decision: "deny" });
  assert.equal(denied.searchParams.get("error"), "access_denied");
  assert.equal(denied.searchParams.get("state"), "client-state");
  assert.equal(denied.searchParams.get("code"), null);

  const approved = await authorize(app, { clientId: client.client_id, challenge: pkce().challenge });
  assert.ok(approved.searchParams.get("code"));
  // Remembered: the next sign-in goes straight back with a code.
  const again = await startToCallback(app, { clientId: client.client_id });
  assert.equal(again.status, 302);
  assert.ok(new URL(again.headers.get("location")).searchParams.get("code"));
  // Another user, or after 30 days, sees the screen again.
  assert.equal((await startToCallback(app, { clientId: client.client_id, email: "sam@bariatricpal.com" })).status, 200);
  advance(30 * 24 * 3600_000 + 1);
  assert.equal((await startToCallback(app, { clientId: client.client_id })).status, 200);
});

test("consent CSRF token and cookie are bound, single use, and short-lived", async (t) => {
  const { app, advance } = await setup(t);
  const { body: client } = await registerClient(app);

  const wrongCsrf = await submitConsent(app, await startToCallback(app, { clientId: client.client_id }), "approve", { body: { csrf: "x".repeat(43) } });
  assert.equal(wrongCsrf.status, 403);
  const noCookie = await submitConsent(app, await startToCallback(app, { clientId: client.client_id }), "approve", { headers: { cookie: "__Host-sms_consent=other" } });
  assert.equal(noCookie.status, 403);
  const crossSite = await submitConsent(app, await startToCallback(app, { clientId: client.client_id }), "approve", { headers: { origin: "https://evil.example" } });
  assert.equal(crossSite.status, 403);

  const page = await startToCallback(app, { clientId: client.client_id });
  const form = await consentForm(page);
  const post = () => call(app, "/consent", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: form.cookie },
    body: new URLSearchParams({ consent: form.consent, csrf: form.csrf, decision: "approve" })
  });
  assert.equal((await post()).status, 303);
  assert.equal((await post()).status, 400, "single use");

  const { body: cli } = await registerClient(app, { redirect_uris: ["http://127.0.0.1:5555/cb"] });
  const late = await consentForm(await startToCallback(app, { clientId: cli.client_id, redirectUri: "http://127.0.0.1:5555/cb" }));
  advance(5 * 60_000 + 1);
  const expired = await call(app, "/consent", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: late.cookie },
    body: new URLSearchParams({ consent: late.consent, csrf: late.csrf, decision: "approve" })
  });
  assert.equal(expired.status, 400);
});

test("with OAUTH_ALLOW_ANY_REDIRECT, unlisted redirects always show consent with a warning", async (t) => {
  const { app } = await setup(t, { allowAnyRedirect: true });
  const redirectUri = "https://tools.example.com/oauth/cb";
  const { body: client } = await registerClient(app, { redirect_uris: [redirectUri], client_name: "Example Tool" });
  const first = await startToCallback(app, { clientId: client.client_id, redirectUri });
  assert.equal(first.status, 200);
  const { html } = await consentForm(first.clone());
  assert.match(html, /tools\.example\.com/);
  assert.match(html, /not on this server's list of known apps/);
  assert.ok(!html.includes("remembered for 30 days"));
  const decided = await submitConsent(app, first);
  assert.equal(decided.status, 303);
  assert.equal(new URL(decided.headers.get("location")).host, "tools.example.com");
  // Never remembered.
  assert.equal((await startToCallback(app, { clientId: client.client_id, redirectUri })).status, 200);

  const custom = "vendorapp://ide.example/mcp/callback";
  const { body: desktop } = await registerClient(app, { redirect_uris: [custom] });
  const page = await startToCallback(app, { clientId: desktop.client_id, redirectUri: custom });
  assert.match(page.headers.get("content-security-policy"), /form-action 'self' vendorapp:/);
  const back = await submitConsent(app, page);
  assert.equal(back.status, 303);
  assert.match(back.headers.get("location"), /^vendorapp:\/\/ide\.example\/mcp\/callback\?code=/);
});

test("client metadata documents are accepted from any HTTPS host by default", async (t) => {
  const url = "https://tools.example.org/.well-known/mcp-client.json";
  const fetched = [];
  const { app } = await setup(t, { fetchClientMetadata: async (u) => { fetched.push(u); return { client_id: url, client_name: "Example", redirect_uris: ["http://127.0.0.1:7777/cb"] }; } });
  const { challenge } = pkce();
  const response = await call(app, `/authorize?${new URLSearchParams({ response_type: "code", client_id: url, redirect_uri: "http://127.0.0.1:7777/cb", code_challenge: challenge, code_challenge_method: "S256", state: "s" })}`);
  assert.equal(response.status, 200);
  assert.deepEqual(fetched, [url]);
  const http = await call(app, `/authorize?${new URLSearchParams({ response_type: "code", client_id: "http://tools.example.org/c.json", redirect_uri: "http://127.0.0.1:7777/cb", code_challenge: challenge, code_challenge_method: "S256" })}`);
  assert.equal(http.status, 400);
});

test("named client metadata hosts get the same public-address checks as the wildcard", async (t) => {
  const logs = [];
  const { app } = await setup(t, { cimdAllowedHosts: ["localhost"], fetchClientMetadata: fetchMetadataDocument, log: (message) => logs.push(message) });
  const { challenge } = pkce();
  const response = await call(app, `/authorize?${new URLSearchParams({ response_type: "code", client_id: "https://localhost/client.json", redirect_uri: CLAUDE_CALLBACK, code_challenge: challenge, code_challenge_method: "S256", state: "s" })}`);
  assert.equal(response.status, 400);
  assert.ok(logs.some((message) => /non-public/.test(message)), logs.join("\n"));
});

test("SERVER_DISPLAY_NAME names the MCP server, resource metadata, sign-in, consent and stores pages", async (t) => {
  await shopifyMock(t);
  const { app } = await setup(t, { displayName: "Acme <Ops>" });
  const metadata = await (await call(app, "/.well-known/oauth-protected-resource")).json();
  assert.equal(metadata.resource_name, "Acme <Ops>");
  const { body: client } = await registerClient(app);
  const chooser = await call(app, `/authorize?${authorizeQuery({ clientId: client.client_id, challenge: pkce().challenge })}`);
  assert.ok((await chooser.clone().text()).includes("Sign in to Acme &lt;Ops&gt;"));
  const page = await startToCallback(app, { clientId: client.client_id });
  const { html } = await consentForm(page.clone());
  assert.ok(html.includes("Acme &lt;Ops&gt;") && !html.includes("Acme <Ops>"));
  const { accessToken } = await login(app);
  const mcp = await mcpClient(t, app, accessToken);
  assert.equal(mcp.getServerVersion().title, "Acme <Ops>");
  assert.equal(mcp.getServerVersion().name, "shopify-multi-store-mcp-server");
  const { session } = await pageSignIn(app);
  assert.ok((await (await call(app, "/stores", { headers: { cookie: session } })).text()).includes("Acme &lt;Ops&gt;"));

  const { app: plain } = await setup(t);
  assert.equal((await (await call(plain, "/.well-known/oauth-protected-resource")).json()).resource_name, "Shopify Multi-Store");

  const base = await serveEnv();
  const named = (await buildHostedAppFromEnv({ ...base, SERVER_DISPLAY_NAME: "Netrition Stores" })).app;
  t.after(() => named.close());
  assert.equal(named.auth.displayName, "Netrition Stores");
  const unnamed = (await buildHostedAppFromEnv(base)).app;
  t.after(() => unnamed.close());
  assert.equal(unnamed.auth.displayName, "Shopify Multi-Store");
  await assert.rejects(buildHostedAppFromEnv({ ...base, SERVER_DISPLAY_NAME: "bad\nname" }), /SERVER_DISPLAY_NAME/);
});

test("README: live version badge, real store limit, local setup steps, GitHub install builds, legacy name explained", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const server = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.match(readme, /img\.shields\.io\/npm\/v\/shopify-multi-store-mcp-server/, "the version badge reads npm");
  assert.doesNotMatch(readme, /badge\/npm-v\d/, "no hard-coded version badge");
  assert.doesNotMatch(readme, /@\d+\.\d+\.\d+\)/, "no link pinned to an old version");
  const max = Number(/StoreAliasesSchema = z\.array\(StoreAliasSchema\)\.min\(1\)\.max\((\d+)\)/.exec(server)[1]);
  assert.equal(max, 100);
  assert.match(readme, /across up to one hundred stores/);
  assert.doesNotMatch(readme, /up to ten stores/);
  assert.match(readme, /^### Connect your first store$/m);
  for (const text of ["dev.shopify.com", "client ID and client secret", "shopify-multi-store oauth", "client-credentials", "authorization-code", "Develop apps", "shpat_", "shopify-multi-store setup", "Settings > Domains"]) assert.ok(readme.includes(text), text);
  assert.equal(pkg.scripts.prepare, "npm run build");
  assert.match(readme, /npm install --global github:alex-brecher\/shopify-multi-store/);
  assert.match(readme, /`codex-shopify-multi-store` name[\s\S]*legacy name/);
  const deploy = await readFile(new URL("../docs/DEPLOY-CLOUDFLARE.md", import.meta.url), "utf8");
  assert.doesNotMatch(deploy, /ui:\/\//, "the MCP Apps UI was removed");
});

test("hosted docs cover every client and every serve setting", async () => {
  const hosted = await readFile(new URL("../docs/HOSTED.md", import.meta.url), "utf8");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const serveSource = (await readFile(new URL("../src/serve.ts", import.meta.url), "utf8")) + (await readFile(new URL("../src/hosted/config.ts", import.meta.url), "utf8"));
  assert.match(hosted, /^## Connect from your AI app$/m);
  for (const client of ["Claude", "ChatGPT", "Codex", "Claude Code", "Cursor", "VS Code", "Gemini CLI", "Windsurf"]) {
    assert.match(hosted, new RegExp(`^### ${client}\\b`, "m"), client);
  }
  assert.doesNotMatch(hosted, /^### Personal access tokens/m);
  assert.match(hosted, /per OpenAI's current terms/);
  assert.match(hosted, /codex mcp login shopify/);
  assert.match(hosted, /claude mcp add --transport http shopify https:\/\/<host>\/mcp/);
  const settings = new Set([...serveSource.matchAll(/env\.([A-Z][A-Z0-9_]+)|"([A-Z][A-Z0-9_]{3,})"/g)].map((m) => m[1] ?? m[2]).filter((name) => !name.endsWith("_FILE") && !["SIGTERM", "SIGINT"].includes(name)));
  for (const name of settings) assert.ok(hosted.includes(`\`${name}\``), `docs/HOSTED.md documents ${name}`);
  for (const removed of ["GOOGLE_CLIENT_ID", "ALLOWED_EMAIL_DOMAINS", "SHOPIFY_MULTI_STORE_POLICY", "SHOPIFY_ACCESS_MODE", "PERSONAL_TOKENS_ENABLED"]) {
    assert.ok(!new RegExp(`^\\| \`${removed}\``, "m").test(hosted), `${removed} is not documented as a setting`);
  }
  assert.ok(readme.includes("docs/HOSTED.md#connect-from-your-ai-app"));
  const deploy = await readFile(new URL("../docs/DEPLOY-CLOUDFLARE.md", import.meta.url), "utf8");
  for (const [name, text] of [["HOSTED.md", hosted], ["README.md", readme], ["DEPLOY-CLOUDFLARE.md", deploy]]) assert.ok(!text.includes("\u2014"), `${name} has no em dashes`);
  assert.match(readme, /deploy\.workers\.cloudflare\.com\/\?url=https:\/\/github\.com\/alex-brecher\/shopify-multi-store/);
  assert.match(deploy, /deploy\.workers\.cloudflare\.com\/\?url=/);
  for (const secret of ["SHOPIFY_APP_CLIENT_ID", "SHOPIFY_APP_CLIENT_SECRET", "SHOPIFY_TOKEN_ENCRYPTION_KEYS", "STORES_JSON"]) assert.ok(deploy.includes(`wrangler secret put ${secret}`), secret);
  assert.ok(deploy.includes("https://<worker-host>/shopify/callback"));
  // Cutover from earlier credentials is documented, as steps for the operator.
  assert.match(hosted, /^## Cutting off earlier credentials$/m);
  for (const step of [/Rotate the shared app's client secret in the Dev Dashboard/, /Uninstall the shared app from each store, then install it again/, /only credentials that work are Shopify online tokens/]) assert.match(hosted, step);
  assert.ok(deploy.includes("HOSTED.md#cutting-off-earlier-credentials"));
});
