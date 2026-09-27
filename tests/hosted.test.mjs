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
import { FileStore, MemoryStore } from "../dist/hosted/store.js";
import { enableHostedMode } from "../dist/runtime.js";

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
  const app = createHostedApp({
    issuer: ORIGIN,
    resource: RESOURCE,
    google: fakeGoogle(),
    allowedDomains: ["bariatricpal.com", "netrition.com"],
    policy: staticPolicy(POLICY),
    store: new MemoryStore(() => now),
    audit: new FileAuditLog(auditPath),
    now: () => now,
    log: () => {},
    ...overrides
  });
  t.after(() => app.close());
  return { app, auditPath, dir, advance: (ms) => { now += ms; } };
}

function call(app, path, init = {}) {
  return app.fetch(new Request(`${ORIGIN}${path}`, init));
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

async function authorize(app, { clientId, redirectUri = CLAUDE_CALLBACK, challenge, account, state = "client-state" }) {
  const query = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge,
    code_challenge_method: "S256", state, resource: RESOURCE, scope: "mcp"
  });
  const start = await call(app, `/authorize?${query}`);
  assert.equal(start.status, 302, await start.clone().text());
  const google = new URL(start.headers.get("location"));
  assert.equal(google.host, "accounts.google.test");
  const back = await call(app, `/oauth/google/callback?state=${encodeURIComponent(google.searchParams.get("state"))}&code=${encodeURIComponent(account)}`);
  assert.equal(back.status, 302);
  return new URL(back.headers.get("location"));
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
  const { app } = await setup(t, { fetchClientMetadata: async (url) => { fetched.push(url); return documents[url]; } });
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
  assert.equal(entry.args.mutation, mutation);
  assert.equal(entry.args.variables.accessToken, "[REDACTED]");
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
  assert.equal(readEntry.args, undefined);
  assert.ok(readEntry.query.startsWith(query.slice(0, 2000)));
  assert.ok(readEntry.query.length < 2100);

  const writeEntry = lines.find((line) => line.tool === "shopify_graphql_mutation");
  assert.match(writeEntry.args.variables.email, /^\[PII sha256:[0-9a-f]{64}\]$/);
  assert.match(writeEntry.args.variables.phone, /^\[PII sha256:[0-9a-f]{64}\]$/);
  assert.match(writeEntry.args.variables.shippingAddress, /^\[PII sha256:[0-9a-f]{64}\]$/);
  assert.ok(writeEntry.args.variables.note.length < 2100);
  const raw = await readFile(auditPath, "utf8");
  for (const secret of ["customer@example.com", "+15185551234", "1 Main St", tokens.access_token]) assert.ok(!raw.includes(secret), secret);
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
