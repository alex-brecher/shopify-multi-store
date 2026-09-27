// Shared helpers for the hosted connector tests (not a test file itself).
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createHostedApp } from "../dist/hosted/app.js";
import { FileAuditLog } from "../dist/hosted/audit.js";
import { MemoryStore } from "../dist/hosted/store.js";
import { loadStores } from "../dist/config.js";

export const ORIGIN = "https://mcp.example.test";
export const RESOURCE = `${ORIGIN}/mcp`;
export const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
export const SECRET = "shpss_test_secret";
export const KEY = randomBytes(32);
export const KEYS = [{ id: "k1", key: KEY }];
export const DEFAULT_STORES = [
  { alias: "main", shop: "main.myshopify.com" },
  { alias: "wholesale", shop: "wholesale.myshopify.com" }
];

/**
 * Shopify's token endpoint. Each exchanged code is "email|token" and names the staff email
 * Shopify reports; "email|token|unverified" reports it unverified.
 */
export function fakeShopifyOAuth(overrides = {}) {
  const exchanges = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    exchanges.push({ url, body });
    const [email, token, flag] = body.code.split("|");
    const payload = overrides.offline
      ? { access_token: token, scope: "write_products" }
      : {
          access_token: token, scope: "write_products,write_orders", expires_in: 86399, associated_user_scope: "write_products",
          associated_user: { id: 42, first_name: "Pat", last_name: "Lee", email, email_verified: flag !== "unverified", account_owner: false, locale: "en", collaborator: false }
        };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, exchanges };
}

/** Point STORES_JSON at the given stores for one test. */
export function useStores(t, stores = DEFAULT_STORES, extraEnv = {}) {
  const saved = { ...process.env };
  process.env.STORES_JSON = JSON.stringify({ stores });
  Object.assign(process.env, extraEnv);
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
}

/**
 * A local Admin API. Records the access token and body of every request; respond(body) may
 * return { status, body } to override the default answer.
 */
export async function shopifyMock(t, respond) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push({ token: request.headers["x-shopify-access-token"], body: parsed });
      const custom = respond?.(parsed);
      response.writeHead(custom?.status ?? 200, { "content-type": "application/json" });
      const ids = parsed.variables?.ids;
      response.end(JSON.stringify(custom?.body ?? { data: {
        ...(Array.isArray(ids) ? { nodes: ids.map((id) => ({ __typename: id.split("/")[3], id })) } : {}),
        shop: { name: "Mock Shop" },
        productUpdate: { product: { id: "gid://shopify/Product/1" }, userErrors: [] },
        tagsAdd: { node: { id: "gid://shopify/Product/1" }, userErrors: [] },
        productDelete: { deletedProductId: "gid://shopify/Product/1", userErrors: [] }
      } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  useStores(t, DEFAULT_STORES.map((store) => ({ ...store, baseUrl: base })), {
    SHOPIFY_MULTI_STORE_ALLOW_INSECURE_HTTP: "1",
    // Static tokens a hosted server must never use.
    SHOPIFY_TOKEN_MAIN: "main-app-token",
    SHOPIFY_TOKEN_WHOLESALE: "wholesale-app-token"
  });
  t.after(() => server.close());
  return requests;
}

/**
 * A hosted app with an in-memory store, a file audit log and a fake Shopify token endpoint.
 * overrides go to createHostedApp; connect goes to shopifyConnect (plus { offline }).
 */
export async function setup(t, overrides = {}, connect = {}) {
  if (!process.env.STORES_JSON) useStores(t);
  const dir = await mkdtemp(join(tmpdir(), "sms-hosted-"));
  const auditPath = join(dir, "audit.jsonl");
  let now = Date.now();
  const oauth = fakeShopifyOAuth(connect);
  const store = overrides.store ?? new MemoryStore(() => now);
  const { encryptionKeys, ...appOverrides } = overrides;
  const { offline, ...connectOverrides } = connect;
  const app = createHostedApp({
    issuer: ORIGIN,
    resource: RESOURCE,
    store,
    audit: new FileAuditLog(auditPath),
    now: () => now,
    log: () => {},
    shopifyConnect: {
      encryptionKeys: encryptionKeys ?? KEYS,
      loadStores,
      clientId: () => "app-client-id",
      clientSecret: () => SECRET,
      scopes: ["write_products", "write_orders"],
      fetch: oauth.fetch,
      ...connectOverrides
    },
    ...appOverrides,
    store
  });
  t.after(() => app.close());
  clocks.set(app, () => now);
  return { app, store, oauth, auditPath, dir, advance: (ms) => { now += ms; } };
}

/** Each app's clock, so Shopify callbacks carry a timestamp the app accepts after advance(). */
const clocks = new WeakMap();

export function call(app, path, init = {}) {
  return app.fetch(new Request(`${ORIGIN}${path}`, init));
}

/** The "name=value" of a cookie a response sets, by name prefix. */
export function cookieNamed(response, prefix) {
  const set = response.headers.getSetCookie().find((value) => value.startsWith(prefix));
  return set?.split(";")[0];
}

/** The login binding cookie a sign-in start sets. */
export function loginCookie(response) {
  return cookieNamed(response, "__Host-sms_login_");
}

/** Shopify callback timestamp: now, in seconds. */
export function ts(offsetSeconds = 0) {
  return String(Math.floor(Date.now() / 1000) + offsetSeconds);
}

export function signedCallback(params, secret = SECRET) {
  const search = new URLSearchParams(params);
  const message = [...search.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  search.set("hmac", createHmac("sha256", secret).update(message).digest("hex"));
  return search;
}

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/**
 * From a sign-in start (the store chooser, or a redirect straight to Shopify), pick a store and
 * return the Shopify authorize URL and the browser's login cookie.
 */
export async function chooseStore(app, start, alias = "main", { cookie = loginCookie(start) } = {}) {
  if (start.status === 302) return { authorize: new URL(start.headers.get("location")), cookie };
  assert.equal(start.status, 200, await start.clone().text());
  const html = await start.clone().text();
  const state = /name="state" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(state, html);
  const chosen = await call(app, "/login/shopify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams({ state, store: alias })
  });
  assert.equal(chosen.status, 302, await chosen.clone().text());
  return { authorize: new URL(chosen.headers.get("location")), cookie };
}

/** Shopify's signed redirect back for an authorize URL. */
export function shopifyBack(app, authorize, { email = "pat@bariatricpal.com", token = "online-token", cookie, shop = authorize.host, timestamp = String(Math.floor((clocks.get(app)?.() ?? Date.now()) / 1000)), secret = SECRET, flag } = {}) {
  const code = [email, token, ...(flag ? [flag] : [])].join("|");
  const search = signedCallback({ code, shop, state: authorize.searchParams.get("state"), timestamp, host: "abc" }, secret);
  return call(app, `/shopify/callback?${search}`, cookie ? { headers: { cookie } } : {});
}

/** Sign in to a page (/stores by default) with Shopify through a store; returns the /stores session cookie and the final response. */
export async function pageSignIn(app, { path = "/stores", alias = "main", email = "pat@bariatricpal.com", token = `online-${alias}-token` } = {}) {
  const start = await call(app, path);
  const { authorize, cookie } = await chooseStore(app, start, alias);
  const back = await shopifyBack(app, authorize, { email, token, cookie });
  return { back, session: cookieNamed(back, "__Host-sms_stores=") };
}

export async function storesSession(app, email = "pat@bariatricpal.com", alias = "main", token = `online-${alias}-token`) {
  const { back, session } = await pageSignIn(app, { email, alias, token });
  assert.equal(back.status, 303, await back.clone().text());
  assert.equal(back.headers.get("location"), "/stores");
  assert.match(session, /^__Host-sms_stores=/);
  return session;
}

export async function registerClient(app, body = {}) {
  const response = await call(app, "/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none", client_name: "Claude", ...body })
  });
  return { response, body: await response.json() };
}

export function authorizeQuery({ clientId, redirectUri = CLAUDE_CALLBACK, challenge, state = "client-state" }) {
  return new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge,
    code_challenge_method: "S256", state, resource: RESOURCE, scope: "mcp"
  });
}

/** Start an authorization and return the Shopify callback response (a consent page or a redirect). */
export async function startToCallback(app, { clientId, redirectUri = CLAUDE_CALLBACK, challenge = pkce().challenge, email = "pat@bariatricpal.com", alias = "main", token, state = "client-state", flag } = {}) {
  const start = await call(app, `/authorize?${authorizeQuery({ clientId, redirectUri, challenge, state })}`);
  const { authorize, cookie } = await chooseStore(app, start, alias);
  return shopifyBack(app, authorize, { email, token: token ?? `online-${alias}-token`, cookie, flag });
}

/** Read the consent form out of a consent page. */
export async function consentForm(page) {
  const html = await page.text();
  const field = (name) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1];
  const cookie = /(__Host-sms_consent=[^;]+)/.exec(page.headers.getSetCookie().join("\n"))?.[1];
  return { html, consent: field("consent"), csrf: field("csrf"), cookie };
}

export async function submitConsent(app, page, decision = "approve", tamper = {}) {
  const form = await consentForm(page);
  return call(app, "/consent", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, ...(form.cookie ? { cookie: form.cookie } : {}), ...(tamper.headers ?? {}) },
    body: new URLSearchParams({ consent: form.consent, csrf: form.csrf, decision, ...(tamper.body ?? {}) })
  });
}

/** A full authorization up to the client redirect (approving the consent page when shown). */
export async function authorize(app, { clientId, redirectUri = CLAUDE_CALLBACK, challenge, email = "pat@bariatricpal.com", alias = "main", token, state = "client-state", decision = "approve", flag } = {}) {
  const back = await startToCallback(app, { clientId, redirectUri, challenge, email, alias, token, state, flag });
  if (back.status === 200) {
    const decided = await submitConsent(app, back, decision);
    assert.equal(decided.status, 303, await decided.clone().text());
    return new URL(decided.headers.get("location"));
  }
  assert.equal(back.status, 302, await back.clone().text());
  return new URL(back.headers.get("location"));
}

export async function tokenRequest(app, params) {
  const response = await call(app, "/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params)
  });
  return { response, body: await response.json() };
}

/** Sign in from an AI app: returns the client, the OAuth tokens, and the access token. */
export async function login(app, email = "pat@bariatricpal.com", { alias = "main", token } = {}) {
  const { body: client } = await registerClient(app);
  const { verifier, challenge } = pkce();
  const redirect = await authorize(app, { clientId: client.client_id, challenge, email, alias, token });
  const code = redirect.searchParams.get("code");
  assert.ok(code, redirect.toString());
  const { response, body } = await tokenRequest(app, {
    grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CLAUDE_CALLBACK, client_id: client.client_id, resource: RESOURCE
  });
  assert.equal(response.status, 200, JSON.stringify(body));
  return { client, tokens: body, accessToken: body.access_token };
}

export async function mcpClient(t, app, accessToken) {
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
    fetch: (url, init) => app.fetch(new Request(url, init)),
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } }
  });
  const client = new Client({ name: "hosted-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

export async function auditLines(path) {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
