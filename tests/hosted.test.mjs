import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createHostedApp } from "../dist/hosted/app.js";
import { AUDIT_MAX_LINE_BYTES, FileAuditLog, auditLine } from "../dist/hosted/audit.js";
import { checkGoogleIdentity, verifyGoogleIdToken } from "../dist/hosted/google.js";
import { toNodeListener } from "../dist/hosted/node-adapter.js";
import { fetchMetadataDocument, isForbiddenAddress } from "../dist/hosted/oauth.js";
import { staticPolicy } from "../dist/hosted/policy.js";
import { FileStore, MemoryStore, nodeDurableFs, writeFileDurable } from "../dist/hosted/store.js";
import { enableHostedMode } from "../dist/runtime.js";
import { KNOWN_CLIENT_REDIRECTS, RedirectPolicy, isSafePrivateUseRedirect, redirectListFromEnv } from "../dist/hosted/known-clients.js";
import { buildHostedAppFromEnv } from "../dist/serve.js";
import { writeFile } from "node:fs/promises";

// This file runs in its own process (node --test isolates files), so hosted mode stays contained.
enableHostedMode();

const ORIGIN = "https://mcp.example.test";
const RESOURCE = `${ORIGIN}/mcp`;
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const POLICY = {
  users: {
    "admin@bariatricpal.com": { role: "admin", stores: "*" },
    "viewer@bariatricpal.com": { role: "viewer", stores: ["main"] },
    "editor@bariatricpal.com": { role: "editor", stores: ["main"] }
  },
  domains: {}
};

/** Fake Google: the authorization code we pass back names the account to sign in as. */
function fakeGoogle() {
  return {
    authorizationUrl: ({ state }) => `https://accounts.google.test/auth?state=${encodeURIComponent(state)}`,
    async exchange({ code, nonce }) {
      const [local, domain, hd = domain] = code.split("|");
      return { sub: `sub-${local}`, email: `${local}@${domain}`, email_verified: true, ...(hd === "none" ? {} : { hd }), nonce };
    }
  };
}

async function setup(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sms-hosted-"));
  const auditPath = join(dir, "audit.jsonl");
  let now = Date.now();
  const store = new MemoryStore(() => now);
  const app = createHostedApp({
    issuer: ORIGIN,
    resource: RESOURCE,
    google: fakeGoogle(),
    allowedDomains: ["bariatricpal.com", "netrition.com"],
    policy: staticPolicy(POLICY),
    store,
    audit: new FileAuditLog(auditPath),
    now: () => now,
    log: () => {},
    ...overrides
  });
  t.after(() => app.close());
  return { app, auditPath, dir, store: overrides.store ?? store, advance: (ms) => { now += ms; } };
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
function googleBack(app, start, account, { cookie = loginCookie(start) } = {}) {
  const google = new URL(start.headers.get("location"));
  return call(app, `/oauth/google/callback?state=${encodeURIComponent(google.searchParams.get("state"))}&code=${encodeURIComponent(account)}`, cookie ? { headers: { cookie } } : {});
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function registerClient(app, body = {}) {
  const response = await call(app, "/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none", client_name: "Claude", ...body })
  });
  return { response, body: await response.json() };
}

async function authorize(app, { clientId, redirectUri = CLAUDE_CALLBACK, challenge, account, state = "client-state", decision = "approve" }) {
  const query = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge,
    code_challenge_method: "S256", state, resource: RESOURCE, scope: "mcp"
  });
  const start = await call(app, `/authorize?${query}`);
  assert.equal(start.status, 302, await start.clone().text());
  const google = new URL(start.headers.get("location"));
  assert.equal(google.host, "accounts.google.test");
  const back = await googleBack(app, start, account);
  if (back.status === 200) {
    const decided = await submitConsent(app, back, decision);
    assert.equal(decided.status, 303, await decided.clone().text());
    return new URL(decided.headers.get("location"));
  }
  assert.equal(back.status, 302);
  return new URL(back.headers.get("location"));
}

/** Read the consent form out of a consent page. */
async function consentForm(page) {
  const html = await page.text();
  const field = (name) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1];
  const cookie = /^(__Host-sms_consent=[^;]+)/.exec(page.headers.get("set-cookie") ?? "")?.[1];
  return { html, consent: field("consent"), csrf: field("csrf"), cookie };
}

async function submitConsent(app, page, decision = "approve", tamper = {}) {
  const form = await consentForm(page);
  return call(app, "/consent", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, ...(form.cookie ? { cookie: form.cookie } : {}), ...(tamper.headers ?? {}) },
    body: new URLSearchParams({ consent: form.consent, csrf: form.csrf, decision, ...(tamper.body ?? {}) })
  });
}

/** Start an authorization and return the Google callback response (a consent page or a redirect). */
async function startToCallback(app, { clientId, redirectUri = CLAUDE_CALLBACK, challenge = pkce().challenge, account, state = "client-state" }) {
  const query = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge,
    code_challenge_method: "S256", state, resource: RESOURCE, scope: "mcp"
  });
  const start = await call(app, `/authorize?${query}`);
  assert.equal(start.status, 302, await start.clone().text());
  return googleBack(app, start, account);
}

async function tokenRequest(app, params) {
  const response = await call(app, "/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params)
  });
  return { response, body: await response.json() };
}

async function login(app, account) {
  const { body: client } = await registerClient(app);
  const { verifier, challenge } = pkce();
  const redirect = await authorize(app, { clientId: client.client_id, challenge, account });
  const code = redirect.searchParams.get("code");
  assert.ok(code, redirect.toString());
  const { response, body } = await tokenRequest(app, {
    grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CLAUDE_CALLBACK, client_id: client.client_id, resource: RESOURCE
  });
  assert.equal(response.status, 200, JSON.stringify(body));
  return { client, tokens: body };
}

async function mcpClient(t, app, accessToken) {
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
    fetch: (url, init) => app.fetch(new Request(url, init)),
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } }
  });
  const client = new Client({ name: "hosted-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

async function shopifyMock(t) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ token: request.headers["x-shopify-access-token"], body: JSON.parse(body) });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { shop: { name: "Mock Shop" }, productUpdate: { product: { id: "gid://shopify/Product/1" }, userErrors: [] } } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const previous = { STORES_JSON: process.env.STORES_JSON, insecure: process.env.SHOPIFY_MULTI_STORE_ALLOW_INSECURE_HTTP };
  process.env.STORES_JSON = JSON.stringify({ stores: [
    { alias: "main", shop: "main.myshopify.com", baseUrl: base },
    { alias: "wholesale", shop: "wholesale.myshopify.com", baseUrl: base }
  ] });
  process.env.SHOPIFY_MULTI_STORE_ALLOW_INSECURE_HTTP = "1";
  process.env.SHOPIFY_TOKEN_MAIN = "main-token";
  process.env.SHOPIFY_TOKEN_WHOLESALE = "wholesale-token";
  t.after(() => {
    server.close();
    if (previous.STORES_JSON === undefined) delete process.env.STORES_JSON; else process.env.STORES_JSON = previous.STORES_JSON;
    if (previous.insecure === undefined) delete process.env.SHOPIFY_MULTI_STORE_ALLOW_INSECURE_HTTP; else process.env.SHOPIFY_MULTI_STORE_ALLOW_INSECURE_HTTP = previous.insecure;
  });
  return requests;
}

async function auditLines(path) {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
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
  assert.equal(good.status, 302);
  assert.equal(new URL(good.headers.get("location")).host, "accounts.google.test");

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
  const { app } = await setup(t, { cimdAllowedHosts: ["*"], fetchClientMetadata: undefined, log: (message) => logs.push(message) });
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
  const redirect = await authorize(app, { clientId: client.client_id, challenge, account: "admin|bariatricpal.com" });
  const code = redirect.searchParams.get("code");
  const wrong = await tokenRequest(app, { grant_type: "authorization_code", code, code_verifier: pkce().verifier, redirect_uri: CLAUDE_CALLBACK, client_id: client.client_id });
  assert.equal(wrong.response.status, 400);
  assert.equal(wrong.body.error, "invalid_grant");
  // The code is single use even after a failed attempt.
  const again = await tokenRequest(app, { grant_type: "authorization_code", code, code_verifier: "a".repeat(43), redirect_uri: CLAUDE_CALLBACK, client_id: client.client_id });
  assert.equal(again.body.error, "invalid_grant");
});

test("sign-in rejects non-Workspace accounts, other domains, and users outside the policy", async (t) => {
  const { app } = await setup(t);
  const { body: client } = await registerClient(app);
  for (const [account, pattern] of [
    ["someone|bariatricpal.com|none", /Workspace/],
    ["someone|gmail.com|gmail.com", /not allowed/],
    ["stranger|bariatricpal.com", /not been granted access/]
  ]) {
    const redirect = await authorize(app, { clientId: client.client_id, challenge: pkce().challenge, account });
    assert.equal(redirect.searchParams.get("error"), "access_denied", account);
    assert.match(redirect.searchParams.get("error_description"), pattern);
    assert.equal(redirect.searchParams.get("code"), null);
    assert.equal(redirect.searchParams.get("state"), "client-state");
  }
});

test("issues opaque tokens, rotates refresh tokens, and revokes the family on reuse", async (t) => {
  const { app } = await setup(t);
  const { client, tokens } = await login(app, "admin|bariatricpal.com");
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
  const fresh = await login(app, "admin|bariatricpal.com");
  const stolen = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: fresh.tokens.refresh_token, client_id: otherClient.client_id });
  assert.equal(stolen.body.error, "invalid_grant");
  const wrongResource = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: fresh.tokens.refresh_token, client_id: fresh.client.client_id, resource: "https://other.example/mcp" });
  assert.equal(wrongResource.body.error, "invalid_target");
});

test("refresh token families have a maximum session age and require a new Google sign-in", async (t) => {
  const { app, advance } = await setup(t, { sessionMaxAgeSeconds: 7 * 24 * 3600 });
  const { client, tokens } = await login(app, "admin|bariatricpal.com");
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
  const again = await login(app, "admin|bariatricpal.com");
  const refreshed = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: again.tokens.refresh_token, client_id: again.client.client_id });
  assert.equal(refreshed.response.status, 200);
});

test("refresh re-evaluates the access policy and revokes a removed user's family", async (t) => {
  const policy = { users: { "admin@bariatricpal.com": { role: "admin", stores: "*" } } };
  const { app } = await setup(t, { policy: { current: () => new (class { resolve(email) { return policy.users[email] ? { email, ...policy.users[email] } : null; } })() } });
  const { client, tokens } = await login(app, "admin|bariatricpal.com");
  delete policy.users["admin@bariatricpal.com"];
  const refused = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
  assert.equal(refused.body.error, "invalid_grant");
  assert.equal(await app.auth.verifyAccessToken(tokens.access_token), undefined);
  policy.users["admin@bariatricpal.com"] = { role: "admin", stores: "*" };
  const stillRevoked = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
  assert.equal(stillRevoked.body.error, "invalid_grant");
});

test("concurrent use of one refresh token yields exactly one success and revokes the family", async (t) => {
  const { app } = await setup(t);
  const { client, tokens } = await login(app, "admin|bariatricpal.com");
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
  const { tokens } = await login(app, "admin|bariatricpal.com");
  assert.ok(await app.auth.verifyAccessToken(tokens.access_token));
  advance(3601_000);
  assert.equal(await app.auth.verifyAccessToken(tokens.access_token), undefined);
});

test("viewer sees only read-only tools and cannot call a mutation tool", async (t) => {
  const requests = await shopifyMock(t);
  const { app, auditPath } = await setup(t);
  const { tokens } = await login(app, "viewer|bariatricpal.com");
  const client = await mcpClient(t, app, tokens.access_token);
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes("shopify_get_shop_info"));
  assert.ok(!names.includes("shopify_graphql_mutation"));
  assert.ok(!names.includes("shopify_update_product"));
  assert.ok(!names.includes("shopify_create_preview_store"));
  assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));

  const blocked = await client.callTool({ name: "shopify_graphql_mutation", arguments: {
    store: "main", mutation: "mutation { productUpdate(product: {id: \"gid://shopify/Product/1\"}) { userErrors { message } } }", variables: {}, confirm: true
  } }).catch((error) => ({ isError: true, thrown: error }));
  assert.equal(blocked.isError, true);
  assert.ok(!requests.some((request) => request.body.query.includes("mutation")), "no mutation reached Shopify");

  const allowed = await client.callTool({ name: "shopify_get_shop_info", arguments: { store: "main" } });
  assert.notEqual(allowed.isError, true, JSON.stringify(allowed));
  assert.equal(requests.at(-1).token, "main-token");
  const lines = await auditLines(auditPath);
  const line = lines.find((entry) => entry.tool === "shopify_get_shop_info");
  assert.equal(line.user, "viewer@bariatricpal.com");
  assert.equal(line.ok, true);
});

test("store allowlist blocks other stores in arguments and in store listings", async (t) => {
  const requests = await shopifyMock(t);
  const { app, auditPath } = await setup(t);
  const { tokens } = await login(app, "editor|bariatricpal.com");
  const client = await mcpClient(t, app, tokens.access_token);

  const denied = await client.callTool({ name: "shopify_get_shop_info", arguments: { store: "wholesale" } });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /not allowed to use store "wholesale"/);
  const deniedMany = await client.callTool({ name: "shopify_graphql_query_many", arguments: { stores: ["main", "WHOLESALE"], query: "{ shop { name } }" } });
  assert.equal(deniedMany.isError, true);
  assert.ok(!requests.some((request) => request.token === "wholesale-token"));

  const listed = await client.callTool({ name: "shopify_list_stores", arguments: {} });
  assert.deepEqual(listed.structuredContent.stores.map((store) => store.alias), ["main"]);

  const lines = await auditLines(auditPath);
  const entry = lines.find((line) => line.tool === "shopify_get_shop_info");
  assert.equal(entry.ok, false);
  assert.deepEqual(entry.stores, ["wholesale"]);
});

test("audit log records mutations with an argument hash and hosted mode refuses local files", async (t) => {
  await shopifyMock(t);
  const { app, auditPath } = await setup(t);
  const { tokens } = await login(app, "admin|bariatricpal.com");
  const client = await mcpClient(t, app, tokens.access_token);
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes("shopify_graphql_mutation"));
  for (const local of ["shopify_create_preview_store", "shopify_get_new_store_previews", "shopify_get_preview_store"]) assert.ok(!names.includes(local), local);

  const mutation = "mutation Update($id: ID!) { productUpdate(product: {id: $id}) { product { id } userErrors { field message } } }";
  const result = await client.callTool({ name: "shopify_graphql_mutation", arguments: { store: "main", mutation, variables: { id: "gid://shopify/Product/1", accessToken: "should-not-log" }, confirm: true } });
  assert.notEqual(result.isError, true, JSON.stringify(result));

  const upload = await client.callTool({ name: "shopify_upload_image", arguments: { store: "main", imageFile: "/etc/passwd", confirm: true } });
  assert.equal(upload.isError, true);
  assert.match(upload.content[0].text, /not available on the hosted connector/);

  const lines = await auditLines(auditPath);
  const entry = lines.find((line) => line.tool === "shopify_graphql_mutation");
  assert.equal(entry.user, "admin@bariatricpal.com");
  assert.equal(entry.readOnly, false);
  assert.equal(entry.ok, true);
  assert.deepEqual(entry.stores, ["main"]);
  assert.match(entry.argsSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(entry.args.mutation.graphql.operations, [{ type: "mutation", rootFields: ["productUpdate"] }]);
  assert.equal(entry.args.mutation.graphql.documentSha256, createHash("sha256").update(mutation).digest("hex"));
  assert.match(entry.args.variables, /^\[sha256:[0-9a-f]{64}\]$/);
  assert.equal(entry.args.confirm, true);
  assert.equal(typeof entry.durationMs, "number");
  assert.ok(!JSON.stringify(lines).includes(tokens.access_token));
  assert.ok(!JSON.stringify(lines).includes("should-not-log"));
});

test("audit log records read-only argument hashes, capped query text, and redacted mutation PII", async (t) => {
  await shopifyMock(t);
  const { app, auditPath } = await setup(t);
  const { tokens } = await login(app, "admin|bariatricpal.com");
  const client = await mcpClient(t, app, tokens.access_token);

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
  for (const secret of ["customer@example.com", "+15185551234", "1 Main St", "nnnnnnnnnn", "qqqqqqqqqq", tokens.access_token]) assert.ok(!raw.includes(secret), secret);
});

test("audit lines never contain customer PII from GraphQL literals, variables, or search arguments", async (t) => {
  await shopifyMock(t);
  const { app, auditPath } = await setup(t, {
    allowedDomains: ["example.com"],
    policy: staticPolicy({ users: { "admin@example.com": { role: "admin", stores: "*" } }, domains: {} })
  });
  const { tokens } = await login(app, "admin|example.com");
  const client = await mcpClient(t, app, tokens.access_token);

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
    { name: "shopify_search_products_many", arguments: { stores: ["main"], query: search, first: 5 } },
    { name: "shopify_list_customers", arguments: { store: "main", query: search } },
    { name: "shopify_list_orders", arguments: { store: "main", query: "email:jane.doe@example.com" } }
  ];
  for (const request of calls) await client.callTool(request);

  const raw = await readFile(auditPath, "utf8");
  const lines = await auditLines(auditPath);
  for (const request of calls) assert.ok(lines.some((line) => line.tool === request.name), request.name);
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

  const searchEntry = lines.find((line) => line.tool === "shopify_search_products_many");
  assert.match(searchEntry.args.query, /^\[sha256:[0-9a-f]{64}\]$/);
  assert.equal(searchEntry.args.first, 5);
  const orders = lines.find((line) => line.tool === "shopify_list_orders");
  const customers = lines.find((line) => line.tool === "shopify_list_customers");
  assert.match(orders.args.query, /^\[sha256:[0-9a-f]{64}\]$/);
  assert.notEqual(orders.args.query, customers.args.query, "different searches hash differently");
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

test("audit log records sign-in, token, refresh, and 401/403 events without tokens", async (t) => {
  const policy = { users: { "admin@bariatricpal.com": { role: "admin", stores: "*" } } };
  const { app, auditPath } = await setup(t, { policy: { current: () => new (class { resolve(email) { return policy.users[email] ? { email, ...policy.users[email] } : null; } })() } });
  const { client, tokens } = await login(app, "admin|bariatricpal.com");
  const refreshed = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
  assert.equal(refreshed.response.status, 200);
  const { body: other } = await registerClient(app);
  const { challenge } = pkce();
  await authorize(app, { clientId: other.client_id, challenge, account: "stranger|bariatricpal.com" });
  const noToken = await call(app, "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(noToken.status, 401);
  const badToken = await call(app, "/mcp", { method: "POST", headers: { authorization: "Bearer sms_at_nope", "content-type": "application/json" }, body: "{}" });
  assert.equal(badToken.status, 401);
  delete policy.users["admin@bariatricpal.com"];
  const forbidden = await call(app, "/mcp", { method: "POST", headers: { authorization: `Bearer ${refreshed.body.access_token}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(forbidden.status, 403);

  const lines = await auditLines(auditPath);
  const events = lines.map((line) => line.event);
  for (const event of ["sign_in", "token_issued", "token_refreshed", "sign_in_denied", "request_unauthorized", "request_forbidden"]) assert.ok(events.includes(event), event);
  assert.equal(lines.find((line) => line.event === "sign_in").user, "admin@bariatricpal.com");
  assert.equal(lines.find((line) => line.event === "sign_in_denied").user, "stranger@bariatricpal.com");
  assert.equal(lines.filter((line) => line.event === "request_unauthorized").length, 2);
  assert.equal(lines.find((line) => line.event === "request_forbidden").status, 403);
  const raw = await readFile(auditPath, "utf8");
  for (const secret of [tokens.access_token, tokens.refresh_token, refreshed.body.access_token, refreshed.body.refresh_token]) assert.ok(!raw.includes(secret));
});

test("a user removed from the policy loses access on the next request", async (t) => {
  const policy = { users: { "admin@bariatricpal.com": { role: "admin", stores: "*" } } };
  const { app } = await setup(t, { policy: { current: () => new (class { resolve(email) { return policy.users[email] ? { email, ...policy.users[email] } : null; } })() } });
  const { tokens } = await login(app, "admin|bariatricpal.com");
  delete policy.users["admin@bariatricpal.com"];
  const response = await call(app, "/mcp", { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(response.status, 403);
});

test("verifies Google id_token signature, audience, expiry, and nonce; requires a Workspace domain", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const keys = { key: async (kid) => (kid === "k1" ? jwk : undefined) };
  const now = Date.now();
  const make = (claims, kid = "k1", key = privateKey) => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: "https://accounts.google.com", aud: "client-1", sub: "1", nonce: "n1",
      iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 300,
      email: "a@bariatricpal.com", email_verified: true, hd: "bariatricpal.com", ...claims
    })).toString("base64url");
    return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key).toString("base64url")}`;
  };
  const verify = (token) => verifyGoogleIdToken(token, { clientId: "client-1", nonce: "n1", keys, now: () => now });
  const claims = await verify(make({}));
  assert.equal(claims.email, "a@bariatricpal.com");
  await assert.rejects(verify(make({ aud: "other" })), /audience/);
  await assert.rejects(verify(make({ iss: "https://evil.example" })), /issuer/);
  await assert.rejects(verify(make({ exp: Math.floor(now / 1000) - 3600 })), /expired/);
  await assert.rejects(verify(make({ nonce: "n2" })), /nonce/);
  await assert.rejects(verify(make({}, "k2")), /signing key/);
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  await assert.rejects(verify(make({}, "k1", other)), /signature/);

  assert.deepEqual(checkGoogleIdentity(claims, ["bariatricpal.com"]), { email: "a@bariatricpal.com" });
  assert.ok("error" in checkGoogleIdentity({ ...claims, hd: undefined }, ["bariatricpal.com"]));
  assert.ok("error" in checkGoogleIdentity({ ...claims, email_verified: false }, ["bariatricpal.com"]));
  assert.ok("error" in checkGoogleIdentity(claims, ["netrition.com"]));
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
  assert.ok(added.includes("https://claude.ai/api/mcp/auth_callback"));
  assert.ok(added.includes("https://tools.example.com/cb"));
  assert.deepEqual(redirectListFromEnv(["https://tools.example.com/cb"], true), ["https://tools.example.com/cb"]);

  const dir = await mkdtemp(join(tmpdir(), "sms-env-"));
  const policyPath = join(dir, "policy.json");
  await writeFile(policyPath, JSON.stringify(POLICY));
  const base = {
    MCP_PUBLIC_URL: ORIGIN, ALLOWED_EMAIL_DOMAINS: "bariatricpal.com", SHOPIFY_MULTI_STORE_POLICY: policyPath,
    GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", SHOPIFY_MULTI_STORE_DATA_DIR: dir
  };
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

test("personal token settings come from PERSONAL_TOKENS_ENABLED and PERSONAL_TOKEN_MAX_DAYS", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sms-env-"));
  const policyPath = join(dir, "policy.json");
  await writeFile(policyPath, JSON.stringify(POLICY));
  const base = {
    MCP_PUBLIC_URL: ORIGIN, ALLOWED_EMAIL_DOMAINS: "bariatricpal.com", SHOPIFY_MULTI_STORE_POLICY: policyPath,
    GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", SHOPIFY_MULTI_STORE_DATA_DIR: dir
  };
  const defaults = (await buildHostedAppFromEnv({ ...base })).app;
  t.after(() => defaults.close());
  assert.equal(defaults.tokens.enabled, true);
  assert.equal(defaults.tokens.maxDays, 180);
  assert.deepEqual(defaults.tokens.expiryChoices, [30, 90, 180]);
  const off = (await buildHostedAppFromEnv({ ...base, PERSONAL_TOKENS_ENABLED: "0", PERSONAL_TOKEN_MAX_DAYS: "30" })).app;
  t.after(() => off.close());
  assert.equal(off.tokens.enabled, false);
  assert.equal(off.tokens.maxDays, 30);
  await assert.rejects(buildHostedAppFromEnv({ ...base, PERSONAL_TOKEN_MAX_DAYS: "0" }), /positive integer/);
});

/** A test app with only example.com accounts, and a fake Google that counts code exchanges. */
async function bindingSetup(t, overrides = {}) {
  const google = fakeGoogle();
  const exchanges = [];
  const counting = { ...google, async exchange(args) { exchanges.push(args.code); return google.exchange(args); } };
  const env = await setup(t, {
    google: counting,
    allowedDomains: ["example.com"],
    policy: staticPolicy({ users: { "attacker@example.com": { role: "admin", stores: "*" }, "victim@example.com": { role: "admin", stores: "*" } }, domains: {} }),
    ...overrides
  });
  return { ...env, exchanges };
}

async function startAuthorize(app, clientId) {
  const query = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: CLAUDE_CALLBACK, code_challenge: pkce().challenge,
    code_challenge_method: "S256", state: "client-state", resource: RESOURCE, scope: "mcp"
  });
  const start = await call(app, `/authorize?${query}`);
  assert.equal(start.status, 302);
  return start;
}

test("Google sign-in sets a browser binding cookie scoped to the callback", async (t) => {
  const { app } = await bindingSetup(t);
  const { body: client } = await registerClient(app);
  const start = await startAuthorize(app, client.client_id);
  const set = start.headers.getSetCookie().find((value) => value.startsWith("__Secure-sms_login_"));
  assert.match(set, /^__Secure-sms_login_[0-9a-f]{24}=[A-Za-z0-9_-]{43}; Path=\/oauth\/google\/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/);
  const tokensStart = await call(app, "/tokens");
  assert.equal(tokensStart.status, 302);
  assert.ok(loginCookie(tokensStart), "the tokens page sign-in is bound too");
  assert.notEqual(loginCookie(tokensStart).split("=")[0], loginCookie(start).split("=")[0], "one cookie per sign-in");
});

test("a forwarded Google callback without the originating cookie creates no session and leaves the state unconsumed", async (t) => {
  const { app, exchanges, store, auditPath } = await bindingSetup(t);
  const { body: client } = await registerClient(app);
  // The attacker starts a sign-in in their own browser and completes Google as themselves...
  const start = await startAuthorize(app, client.client_id);
  // ...then sends the unredeemed callback URL to the victim, whose browser has no binding cookie.
  const forwarded = await googleBack(app, start, "attacker|example.com", { cookie: null });
  assert.equal(forwarded.status, 403);
  assert.match(await forwarded.text(), /different browser/);
  assert.equal(forwarded.headers.get("location"), null, "no redirect with a code");
  assert.deepEqual(forwarded.headers.getSetCookie().filter((value) => /^__Host-sms_(consent|tokens)=/.test(value)), [], "no consent or session cookie");
  assert.deepEqual(exchanges, [], "the Google code was not exchanged");
  assert.equal((await store.entries("pending")).length, 1, "state is not consumed by an unbound callback");
  assert.equal((await store.entries("code")).length, 0);
  assert.equal((await store.entries("consent")).length, 0);

  // The victim's own unrelated sign-in cookie does not help: it binds a different state.
  const victimStart = await startAuthorize(app, client.client_id);
  const crossed = await googleBack(app, start, "attacker|example.com", { cookie: loginCookie(victimStart) });
  assert.equal(crossed.status, 403);
  assert.deepEqual(exchanges, []);

  const lines = await auditLines(auditPath);
  assert.ok(lines.some((line) => line.event === "sign_in_denied" && /not bound to this browser/.test(line.reason) && line.clientId === client.client_id));

  // In the browser that started it, the same state still works (and only for that browser's user).
  const own = await googleBack(app, start, "attacker|example.com");
  assert.equal(own.status, 200);
  assert.ok((await consentForm(own)).html.includes("attacker@example.com"));
});

test("a Google callback with a mismatched binding cookie is refused", async (t) => {
  const { app, exchanges, store } = await bindingSetup(t);
  const { body: client } = await registerClient(app);
  const start = await startAuthorize(app, client.client_id);
  const name = loginCookie(start).split("=")[0];
  const forged = await googleBack(app, start, "attacker|example.com", { cookie: `${name}=${"A".repeat(43)}` });
  assert.equal(forged.status, 403);
  assert.deepEqual(exchanges, []);
  assert.equal((await store.entries("pending")).length, 1);
});

test("a bound Google callback is single use, expires, and clears the binding cookie", async (t) => {
  const { app, exchanges, advance } = await bindingSetup(t);
  const { body: client } = await registerClient(app);
  const start = await startAuthorize(app, client.client_id);
  const cleared = (response, from = start) => {
    const name = loginCookie(from).split("=")[0];
    return response.headers.getSetCookie().some((value) => value.startsWith(`${name}=;`) && /Path=\/oauth\/google\/callback/.test(value) && /Max-Age=0/.test(value));
  };

  const first = await googleBack(app, start, "victim|example.com");
  assert.equal(first.status, 200, "consent page");
  assert.ok(cleared(first), "success clears the binding cookie");
  assert.match(first.headers.getSetCookie().join("\n"), /__Host-sms_consent=/, "the consent cookie is still set");
  assert.equal(exchanges.length, 1);

  const replay = await googleBack(app, start, "victim|example.com");
  assert.equal(replay.status, 400, "replay refused");
  assert.equal(exchanges.length, 1, "no second exchange");
  assert.ok(cleared(replay));

  const late = await startAuthorize(app, client.client_id);
  advance(10 * 60_000 + 1);
  const expired = await googleBack(app, late, "victim|example.com");
  assert.equal(expired.status, 400);
  assert.ok(cleared(expired, late), "terminal failure clears the binding cookie");
  assert.equal(exchanges.length, 1);

  // Google reporting an error is terminal too: the state is consumed and the cookie cleared.
  const cancelled = await startAuthorize(app, client.client_id);
  const google = new URL(cancelled.headers.get("location"));
  const denied = await call(app, `/oauth/google/callback?state=${encodeURIComponent(google.searchParams.get("state"))}&error=access_denied`, { headers: { cookie: loginCookie(cancelled) } });
  assert.equal(denied.status, 302);
  assert.equal(new URL(denied.headers.get("location")).searchParams.get("error"), "access_denied");
  assert.ok(denied.headers.getSetCookie().some((value) => value.startsWith(`${loginCookie(cancelled).split("=")[0]}=;`)));
});

test("the tokens page sign-in is bound to the browser that started it", async (t) => {
  const { app, exchanges } = await bindingSetup(t);
  const start = await call(app, "/tokens");
  const forwarded = await googleBack(app, start, "attacker|example.com", { cookie: null });
  assert.equal(forwarded.status, 403);
  assert.deepEqual(forwarded.headers.getSetCookie().filter((value) => value.startsWith("__Host-sms_tokens=")), []);
  assert.deepEqual(exchanges, []);
  const own = await googleBack(app, start, "attacker|example.com");
  assert.equal(own.status, 303);
  const cookies = own.headers.getSetCookie();
  assert.ok(cookies.some((value) => value.startsWith("__Host-sms_tokens=")));
  assert.ok(cookies.some((value) => value.startsWith(`${loginCookie(start).split("=")[0]}=;`)));
});

test("node:http keeps every Set-Cookie header of a response", async (t) => {
  const { app } = await bindingSetup(t);
  const { body: client } = await registerClient(app);
  const server = http.createServer(toNodeListener(app.fetch, { origin: ORIGIN, maxBodyBytes: 64 * 1024 }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const query = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: CLAUDE_CALLBACK, code_challenge: pkce().challenge, code_challenge_method: "S256", state: "s" });
  const start = await fetch(`${base}/authorize?${query}`, { redirect: "manual" });
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const back = await fetch(`${base}/oauth/google/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent("victim|example.com")}`, { headers: { cookie: loginCookie(start) }, redirect: "manual" });
  assert.equal(back.status, 200);
  const cookies = back.headers.getSetCookie();
  assert.equal(cookies.length, 2, cookies.join("\n"));
  assert.ok(cookies.some((value) => value.startsWith("__Host-sms_consent=")));
  assert.ok(cookies.some((value) => value.startsWith("__Secure-sms_login_")));
});

test("consent screen shows the client, redirect host, user, role and stores, and escapes the client name", async (t) => {
  const { app } = await setup(t);
  const { body: client } = await registerClient(app, { client_name: "<script>alert(1)</script> Tool" });
  const page = await startToCallback(app, { clientId: client.client_id, account: "viewer|bariatricpal.com" });
  assert.equal(page.status, 200);
  const csp = page.headers.get("content-security-policy");
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /form-action 'self' https:\/\/claude\.ai/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.match(page.headers.get("cache-control"), /no-store/);
  assert.match(page.headers.get("set-cookie"), /__Host-sms_consent=.+; Path=\/; HttpOnly; Secure; SameSite=Lax/);
  const { html } = await consentForm(page);
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt; Tool"));
  for (const text of [client.client_id, "claude.ai", "viewer@bariatricpal.com", "viewer", "main", "Shopify Multi-Store", "Approve", "Deny"]) assert.ok(html.includes(text), text);
  assert.ok(!/<(script|img|link|iframe)\b/i.test(html), "no external assets or scripts");
});

test("consent deny returns access_denied and approve is remembered for 30 days", async (t) => {
  const { app, advance } = await setup(t);
  const { body: client } = await registerClient(app);
  const denied = await authorize(app, { clientId: client.client_id, challenge: pkce().challenge, account: "admin|bariatricpal.com", decision: "deny" });
  assert.equal(denied.searchParams.get("error"), "access_denied");
  assert.equal(denied.searchParams.get("state"), "client-state");
  assert.equal(denied.searchParams.get("code"), null);

  const approved = await authorize(app, { clientId: client.client_id, challenge: pkce().challenge, account: "admin|bariatricpal.com" });
  assert.ok(approved.searchParams.get("code"));
  // Remembered: the next sign-in goes straight back with a code.
  const again = await startToCallback(app, { clientId: client.client_id, account: "admin|bariatricpal.com" });
  assert.equal(again.status, 302);
  assert.ok(new URL(again.headers.get("location")).searchParams.get("code"));
  // Another user, or after 30 days, sees the screen again.
  assert.equal((await startToCallback(app, { clientId: client.client_id, account: "editor|bariatricpal.com" })).status, 200);
  advance(30 * 24 * 3600_000 + 1);
  assert.equal((await startToCallback(app, { clientId: client.client_id, account: "admin|bariatricpal.com" })).status, 200);
});

test("consent CSRF token and cookie are bound, single use, and short-lived", async (t) => {
  const { app, advance } = await setup(t);
  const { body: client } = await registerClient(app);
  const account = "admin|bariatricpal.com";

  const wrongCsrf = await submitConsent(app, await startToCallback(app, { clientId: client.client_id, account }), "approve", { body: { csrf: "x".repeat(43) } });
  assert.equal(wrongCsrf.status, 403);
  const noCookie = await submitConsent(app, await startToCallback(app, { clientId: client.client_id, account }), "approve", { headers: { cookie: "__Host-sms_consent=other" } });
  assert.equal(noCookie.status, 403);
  const crossSite = await submitConsent(app, await startToCallback(app, { clientId: client.client_id, account }), "approve", { headers: { origin: "https://evil.example" } });
  assert.equal(crossSite.status, 403);

  const page = await startToCallback(app, { clientId: client.client_id, account });
  const form = await consentForm(page);
  const post = () => call(app, "/consent", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: form.cookie },
    body: new URLSearchParams({ consent: form.consent, csrf: form.csrf, decision: "approve" })
  });
  assert.equal((await post()).status, 303);
  assert.equal((await post()).status, 400, "single use");

  const { body: cli } = await registerClient(app, { redirect_uris: ["http://127.0.0.1:5555/cb"] });
  const late = await consentForm(await startToCallback(app, { clientId: cli.client_id, redirectUri: "http://127.0.0.1:5555/cb", account }));
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
  const first = await startToCallback(app, { clientId: client.client_id, redirectUri, account: "admin|bariatricpal.com" });
  assert.equal(first.status, 200);
  const { html } = await consentForm(first.clone());
  assert.ok(html.includes("tools.example.com"));
  assert.match(html, /not on this server's list of known apps/);
  assert.ok(!html.includes("remembered for 30 days"));
  const decided = await submitConsent(app, first);
  assert.equal(decided.status, 303);
  assert.equal(new URL(decided.headers.get("location")).host, "tools.example.com");
  // Never remembered.
  assert.equal((await startToCallback(app, { clientId: client.client_id, redirectUri, account: "admin|bariatricpal.com" })).status, 200);

  const custom = "vendorapp://ide.example/mcp/callback";
  const { body: desktop } = await registerClient(app, { redirect_uris: [custom] });
  const page = await startToCallback(app, { clientId: desktop.client_id, redirectUri: custom, account: "admin|bariatricpal.com" });
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
  assert.equal(response.status, 302);
  assert.deepEqual(fetched, [url]);
  const http = await call(app, `/authorize?${new URLSearchParams({ response_type: "code", client_id: "http://tools.example.org/c.json", redirect_uri: "http://127.0.0.1:7777/cb", code_challenge: challenge, code_challenge_method: "S256" })}`);
  assert.equal(http.status, 400);
});

test("named client metadata hosts get the same public-address checks as the wildcard", async (t) => {
  const logs = [];
  const { app } = await setup(t, { cimdAllowedHosts: ["localhost"], fetchClientMetadata: undefined, log: (message) => logs.push(message) });
  const { challenge } = pkce();
  const response = await call(app, `/authorize?${new URLSearchParams({ response_type: "code", client_id: "https://localhost/client.json", redirect_uri: CLAUDE_CALLBACK, code_challenge: challenge, code_challenge_method: "S256", state: "s" })}`);
  assert.equal(response.status, 400);
  assert.ok(logs.some((message) => /non-public/.test(message)), logs.join("\n"));
});

async function tokensSession(app, account) {
  const start = await call(app, "/tokens");
  assert.equal(start.status, 302);
  const google = new URL(start.headers.get("location"));
  assert.equal(google.host, "accounts.google.test");
  const back = await googleBack(app, start, account);
  if (back.status !== 303) return { denied: back };
  assert.equal(back.headers.get("location"), "/tokens");
  const setCookie = back.headers.getSetCookie().find((value) => value.startsWith("__Host-sms_tokens="));
  assert.match(setCookie, /^__Host-sms_tokens=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=\d+$/);
  const cookie = setCookie.split(";")[0];
  const page = await call(app, "/tokens", { headers: { cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
  const post = (fields, headers = {}) => call(app, "/tokens", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie, ...headers },
    body: new URLSearchParams({ csrf, ...fields })
  });
  const create = async (name = "Laptop", days = "90") => {
    const response = await post({ action: "create", name, days });
    const text = await response.text();
    return { response, text, token: /(smsp_[A-Za-z0-9_-]{43})/.exec(text)?.[1], id: /(pat_[A-Za-z0-9_-]{12})/.exec(text)?.[1] };
  };
  return { cookie, csrf, html, page, post, create, get: () => call(app, "/tokens", { headers: { cookie } }) };
}

function mcpPost(app, token) {
  return call(app, "/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
  });
}

test("personal access tokens: create once, use as bearer, audited by id, stored hashed, revocable", async (t) => {
  await shopifyMock(t);
  const store = new MemoryStore();
  const { app, auditPath } = await setup(t, { store });
  const session = await tokensSession(app, "editor|bariatricpal.com");
  assert.match(session.html, /Personal access tokens/);
  const created = await session.create("CI runner", "90");
  assert.equal(created.response.status, 200);
  assert.match(created.response.headers.get("cache-control"), /no-store/);
  assert.ok(created.token, "token shown once");
  assert.match(created.text, /will not be shown again/);
  // Not shown again on reload.
  assert.ok(!(await (await session.get()).text()).includes(created.token));
  // Stored only as a hash.
  const stored = await store.entries("pat");
  assert.equal(stored.length, 1);
  assert.ok(!JSON.stringify(stored).includes(created.token));
  assert.equal(stored[0][1].name, "CI runner");
  assert.equal(stored[0][1].expiresAt - stored[0][1].createdAt, 90 * 24 * 3600_000);

  const client = await mcpClient(t, app, created.token);
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === "shopify_get_shop_info"));
  assert.ok(!tools.some((tool) => tool.name === "shopify_graphql_mutation"), "editor role still applies");
  const result = await client.callTool({ name: "shopify_get_shop_info", arguments: { store: "main" } });
  assert.notEqual(result.isError, true);
  const lines = await auditLines(auditPath);
  const call1 = lines.find((line) => line.tool === "shopify_get_shop_info");
  assert.equal(call1.tokenId, created.id);
  assert.equal(call1.user, "editor@bariatricpal.com");
  assert.ok(lines.some((line) => line.event === "personal_token_created" && line.tokenId === created.id));
  assert.ok(!(await readFile(auditPath, "utf8")).includes(created.token));
  assert.ok((await store.entries("pat"))[0][1].lastUsedAt, "last use recorded");

  const revoked = await session.post({ action: "revoke", id: created.id });
  assert.equal(revoked.status, 303);
  assert.equal((await mcpPost(app, created.token)).status, 401);
  assert.ok((await auditLines(auditPath)).some((line) => line.event === "personal_token_revoked" && line.tokenId === created.id));
});

test("personal access tokens expire, follow the policy on every request, and respect the maximum lifetime", async (t) => {
  const policy = { users: { "admin@bariatricpal.com": { role: "admin", stores: "*" }, "editor@bariatricpal.com": { role: "editor", stores: ["main"] } } };
  const { app, advance } = await setup(t, {
    personalTokenMaxDays: 60,
    policy: { current: () => new (class { resolve(email) { return policy.users[email] ? { email, ...policy.users[email] } : null; } })() }
  });
  const session = await tokensSession(app, "editor|bariatricpal.com");
  assert.match(session.html, /<option value="30" selected>30 days<\/option>/);
  assert.ok(!session.html.includes('value="90"'));
  assert.equal((await session.create("Too long", "90")).response.status, 400);
  const { token } = await session.create("Short", "30");
  assert.ok(token);
  assert.notEqual((await mcpPost(app, token)).status, 401);

  delete policy.users["editor@bariatricpal.com"];
  assert.equal((await mcpPost(app, token)).status, 403);
  // The page session is dropped too.
  assert.equal((await session.get()).status, 302);
  policy.users["editor@bariatricpal.com"] = { role: "editor", stores: ["main"] };
  assert.notEqual((await mcpPost(app, token)).status, 403);

  advance(30 * 24 * 3600_000 + 1);
  assert.equal((await mcpPost(app, token)).status, 401);
  assert.equal((await mcpPost(app, `smsp_${"A".repeat(43)}`)).status, 401);
});

test("tokens page enforces CSRF, same origin, ownership, and gives admins every user's tokens", async (t) => {
  const { app } = await setup(t);
  const editor = await tokensSession(app, "editor|bariatricpal.com");
  const mine = await editor.create("Editor token");
  const viewer = await tokensSession(app, "viewer|bariatricpal.com");
  const theirs = await viewer.create("Viewer token");

  const noCsrf = await call(app, "/tokens", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: editor.cookie }, body: new URLSearchParams({ action: "create", name: "x", days: "90" }) });
  assert.equal(noCsrf.status, 403);
  assert.equal((await editor.post({ action: "create", name: "x", days: "90" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await editor.post({ action: "create", name: "x", days: "90" }, { cookie: "__Host-sms_tokens=forged" })).status, 401);
  // Someone else's token cannot be revoked by a non-admin, or seen.
  assert.equal((await editor.post({ action: "revoke", id: theirs.id })).status, 404);
  assert.ok(!(await (await editor.get()).text()).includes("Viewer token"));

  const admin = await tokensSession(app, "admin|bariatricpal.com");
  assert.ok(admin.html.includes("Editor token") && admin.html.includes("Viewer token"));
  assert.ok(admin.html.includes("viewer@bariatricpal.com"));
  assert.equal((await admin.post({ action: "revoke", id: theirs.id })).status, 303);
  assert.equal((await mcpPost(app, theirs.token)).status, 401);
  assert.notEqual((await mcpPost(app, mine.token)).status, 401);

  const signout = await editor.post({ action: "signout" });
  assert.match(signout.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await editor.get()).status, 302);

  const stranger = await tokensSession(app, "stranger|bariatricpal.com");
  assert.equal(stranger.denied.status, 403);
  const consumer = await tokensSession(app, "someone|gmail.com|gmail.com");
  assert.equal(consumer.denied.status, 403);
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** A store that can pause one personal-token read after it has read the record, to order a race exactly. */
class GatedStore extends MemoryStore {
  gate;
  async get(kind, key) {
    const value = await super.get(kind, key);
    if (kind === "pat" && this.gate) {
      const gate = this.gate;
      this.gate = undefined;
      gate.arrived.resolve();
      await gate.release.promise;
    }
    return value;
  }
}

const EXAMPLE_POLICY = { users: { "editor@example.com": { role: "editor", stores: ["main"] } }, domains: {} };

test("a personal token revoked while a request is being verified is not written back or accepted", async (t) => {
  const store = new GatedStore();
  const { app } = await setup(t, { store, allowedDomains: ["example.com"], policy: staticPolicy(EXAMPLE_POLICY) });
  const session = await tokensSession(app, "editor|example.com");
  const created = await session.create("Race");
  assert.ok(created.token);

  // Verification reads the record, then pauses; the token is revoked; then verification resumes.
  const gate = { arrived: deferred(), release: deferred() };
  store.gate = gate;
  const verifying = app.tokens.verify(created.token);
  await gate.arrived.promise;
  assert.equal((await session.post({ action: "revoke", id: created.id })).status, 303);
  assert.equal((await store.entries("pat")).length, 0);
  gate.release.resolve();

  assert.equal(await verifying, undefined, "the revoked token is refused");
  assert.equal((await store.entries("pat")).length, 0, "the last-used write did not recreate the revoked token");
  assert.equal((await mcpPost(app, created.token)).status, 401);

  // Without a revoke in the gap, the same ordering records the last use.
  const other = await session.create("Kept");
  const gate2 = { arrived: deferred(), release: deferred() };
  store.gate = gate2;
  const verifying2 = app.tokens.verify(other.token);
  await gate2.arrived.promise;
  gate2.release.resolve();
  const record = await verifying2;
  assert.equal(record.id, other.id);
  assert.equal(typeof (await store.entries("pat"))[0][1].lastUsedAt, "number");
});

test("store update is conditional on the live record and keeps its expiry", async () => {
  let now = 1_000;
  const store = new MemoryStore(() => now);
  assert.equal(await store.update("pat", "missing", (value) => ({ ...value, touched: true })), undefined);
  assert.equal(await store.get("pat", "missing"), undefined, "update never creates a record");
  await store.put("pat", "k", { id: "a" }, 2_000);
  assert.deepEqual(await store.update("pat", "k", (value) => ({ ...value, touched: true })), { id: "a", touched: true });
  assert.equal(await store.update("pat", "k", () => undefined), undefined);
  assert.deepEqual(await store.get("pat", "k"), { id: "a", touched: true });
  now = 2_000;
  assert.equal(await store.update("pat", "k", (value) => ({ ...value, late: true })), undefined, "expired records are not revived");
  assert.equal(await store.get("pat", "k"), undefined);
});

test("PERSONAL_TOKENS_ENABLED=0 turns off the page and bearer use", async (t) => {
  const { app } = await setup(t, { personalTokensEnabled: false });
  assert.equal((await call(app, "/tokens")).status, 404);
  assert.equal((await mcpPost(app, `smsp_${"A".repeat(43)}`)).status, 401);
});

test("SERVER_DISPLAY_NAME names the MCP server, resource metadata, consent and tokens pages", async (t) => {
  const { app } = await setup(t, { displayName: "Acme <Ops>" });
  const metadata = await (await call(app, "/.well-known/oauth-protected-resource")).json();
  assert.equal(metadata.resource_name, "Acme <Ops>");
  const { body: client } = await registerClient(app);
  const page = await startToCallback(app, { clientId: client.client_id, account: "admin|bariatricpal.com" });
  const { html } = await consentForm(page.clone());
  assert.ok(html.includes("Acme &lt;Ops&gt;") && !html.includes("Acme <Ops>"));
  const approved = await submitConsent(app, page);
  const code = new URL(approved.headers.get("location")).searchParams.get("code");
  assert.ok(code);
  const session = await tokensSession(app, "admin|bariatricpal.com");
  assert.ok(session.html.includes("Acme &lt;Ops&gt;"));
  const { token } = await session.create("display");
  const mcp = await mcpClient(t, app, token);
  assert.equal(mcp.getServerVersion().title, "Acme <Ops>");
  assert.equal(mcp.getServerVersion().name, "shopify-multi-store-mcp-server");

  const { app: plain } = await setup(t);
  assert.equal((await (await call(plain, "/.well-known/oauth-protected-resource")).json()).resource_name, "Shopify Multi-Store");

  const dir = await mkdtemp(join(tmpdir(), "sms-env-"));
  const policyPath = join(dir, "policy.json");
  await writeFile(policyPath, JSON.stringify(POLICY));
  const base = { MCP_PUBLIC_URL: ORIGIN, ALLOWED_EMAIL_DOMAINS: "bariatricpal.com", SHOPIFY_MULTI_STORE_POLICY: policyPath, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s", SHOPIFY_MULTI_STORE_DATA_DIR: dir };
  const named = (await buildHostedAppFromEnv({ ...base, SERVER_DISPLAY_NAME: "Netrition Stores" })).app;
  t.after(() => named.close());
  assert.equal(named.auth.displayName, "Netrition Stores");
  const unnamed = (await buildHostedAppFromEnv(base)).app;
  t.after(() => unnamed.close());
  assert.equal(unnamed.auth.displayName, "Shopify Multi-Store");
  await assert.rejects(buildHostedAppFromEnv({ ...base, SERVER_DISPLAY_NAME: "bad\nname" }), /SERVER_DISPLAY_NAME/);
});

test("hosted docs cover every client and every serve setting", async () => {
  const hosted = await readFile(new URL("../docs/HOSTED.md", import.meta.url), "utf8");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const serveSource = await readFile(new URL("../src/serve.ts", import.meta.url), "utf8");
  assert.match(hosted, /^## Connect from your AI app$/m);
  for (const client of ["Claude", "ChatGPT", "Codex", "Claude Code", "Cursor", "VS Code", "Gemini CLI", "Windsurf", "Personal access tokens"]) {
    assert.match(hosted, new RegExp(`^### ${client}\\b`, "m"), client);
  }
  assert.match(hosted, /per OpenAI's current terms/);
  assert.match(hosted, /codex mcp login shopify/);
  assert.match(hosted, /claude mcp add --transport http shopify https:\/\/<host>\/mcp/);
  const settings = new Set([...serveSource.matchAll(/env\.([A-Z][A-Z0-9_]+)|"([A-Z][A-Z0-9_]{3,})"/g)].map((m) => m[1] ?? m[2]).filter((name) => !name.endsWith("_FILE") && !["SIGTERM", "SIGINT"].includes(name)));
  for (const name of settings) assert.ok(hosted.includes(`\`${name}\``), `docs/HOSTED.md documents ${name}`);
  assert.ok(readme.includes("docs/HOSTED.md#connect-from-your-ai-app"));
  for (const [name, text] of [["HOSTED.md", hosted], ["README.md", readme]]) assert.ok(!text.includes("\u2014"), `${name} has no em dashes`);
});
