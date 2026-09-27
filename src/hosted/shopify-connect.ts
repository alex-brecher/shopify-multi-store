import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { StoreConfig } from "../config.js";
import type { ShopifyUserToken, UserShopifyAccess } from "../runtime.js";
import { auditError } from "./audit.js";
import { cookie, escapeHtml, htmlPage, readCookie, sameOrigin } from "./html.js";
import { PAGE_SIGN_IN_CLIENT, appendSetCookie, sha256, type AuthorizationServer, type PageSignInPurpose } from "./oauth.js";
import type { OAuthStore } from "./store.js";

/**
 * Shopify sign-in and per-user Shopify access for the hosted connector.
 *
 * People sign in with Shopify: they pick a configured store and log in to its admin, and the
 * server receives an online (per-user) access token through Shopify's authorization-code flow.
 * The token's associated_user is the verified Shopify staff identity, and the token itself is
 * kept as that person's connection to the store. Each further store is connected the same way
 * (one click reconnects every store). An online token carries only that person's Shopify
 * permissions, so Shopify decides what every tool call may do. Tokens are encrypted at rest
 * with AES-256-GCM and never leave the server. Shopify ends online tokens after 24 hours, or
 * when the person logs out of the Shopify admin.
 */

const SESSION_COOKIE = "__Host-sms_stores";
const SESSION_TTL_MS = 30 * 60_000;
const STATE_TTL_MS = 10 * 60_000;
/** Keep an expired token record this long so /stores can say "Expired" rather than "Not connected". */
const EXPIRED_RECORD_GRACE_MS = 30 * 24 * 3600_000;
const TOKEN_FORMAT = "v2";
const SHOP_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
/** Connect forms post to this server, which redirects to the store's Shopify admin. */
const CONNECT_FORM_ACTION = "'self' https://*.myshopify.com";
/** Shopify callbacks older than this (or this far in the future) are refused. */
export const CALLBACK_MAX_AGE_SECONDS = 300;

export interface ShopifyAssociatedUser {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  accountOwner?: boolean;
  collaborator?: boolean;
  emailVerified?: boolean;
}

/** Stored per (signed-in email, store alias). The token is stored only encrypted. */
export interface ShopifyTokenRecord {
  email: string;
  alias: string;
  shop: string;
  encryptedToken: string;
  scope: string;
  associatedUserScope: string;
  associatedUser: ShopifyAssociatedUser;
  connectedAt: number;
  expiresAt: number;
}

interface StateRecord {
  email: string;
  alias: string;
  shop: string;
  /** Hash of the /stores session cookie that started the connection. */
  sessionSha256: string;
  chain: boolean;
}

interface SessionRecord {
  email: string;
  purpose: "stores";
}

/** A Shopify online token response, checked. */
interface OnlineToken {
  accessToken: string;
  scope: string;
  associatedUserScope: string;
  associatedUser: ShopifyAssociatedUser;
  expiresIn: number;
}

interface Session {
  key: string;
  email: string;
  csrf: string;
}

export interface ShopifyConnectOptions {
  auth: AuthorizationServer;
  store: OAuthStore;
  /** AES-256-GCM keys, newest first. The first encrypts; all decrypt. */
  encryptionKeys: EncryptionKey[];
  /** Every configured store (unfiltered). */
  loadStores: () => Promise<StoreConfig[]>;
  /** The Shopify app client id for a store: its auth.clientId, else SHOPIFY_APP_CLIENT_ID. */
  clientId: (store: StoreConfig) => string | undefined;
  /** The Shopify app client secret for a store. */
  clientSecret: (store: StoreConfig) => string | undefined;
  /** Scopes to request, comma-separated handles. */
  scopes: string[];
  /** Alias of the store listed first (preselected) on the sign-in chooser. Defaults to the first configured store. */
  identityStore?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

// ---------- Encryption ----------

/** One AES-256-GCM key with the id stored next to each ciphertext it produced. */
export interface EncryptionKey {
  id: string;
  key: Buffer;
}

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

/** Parse one 32-byte key, base64 or base64url. */
export function parseEncryptionKey(value: string | undefined, name = "SHOPIFY_TOKEN_ENCRYPTION_KEY"): Buffer {
  const text = value?.trim() ?? "";
  const key = Buffer.from(text, text.includes("-") || text.includes("_") ? "base64url" : "base64");
  if (!text || key.length !== 32) {
    throw new Error(`${name} must be 32 random bytes, base64 encoded (for example: openssl rand -base64 32).`);
  }
  return key;
}

/**
 * The token encryption keys, newest first. SHOPIFY_TOKEN_ENCRYPTION_KEYS is a comma list of
 * id:base64key; the first key encrypts and every key decrypts, so a key can be rotated by
 * prepending a new one and dropping the old one once every token has been re-encrypted (tokens
 * are re-encrypted with the first key on use, and online tokens live about a day).
 * SHOPIFY_TOKEN_ENCRYPTION_KEY is the single-key form, with id "default".
 */
export function parseEncryptionKeys(env: { SHOPIFY_TOKEN_ENCRYPTION_KEYS?: string | undefined; SHOPIFY_TOKEN_ENCRYPTION_KEY?: string | undefined }): EncryptionKey[] {
  const list = env.SHOPIFY_TOKEN_ENCRYPTION_KEYS?.trim();
  if (!list) {
    if (!env.SHOPIFY_TOKEN_ENCRYPTION_KEY?.trim()) {
      throw new Error("SHOPIFY_TOKEN_ENCRYPTION_KEY (or SHOPIFY_TOKEN_ENCRYPTION_KEYS) is required in per-user mode: 32 random bytes, base64 encoded (for example: openssl rand -base64 32).");
    }
    return [{ id: "default", key: parseEncryptionKey(env.SHOPIFY_TOKEN_ENCRYPTION_KEY) }];
  }
  const keys: EncryptionKey[] = [];
  for (const entry of list.split(",").map((item) => item.trim()).filter(Boolean)) {
    const colon = entry.indexOf(":");
    const id = colon > 0 ? entry.slice(0, colon) : "";
    if (!KEY_ID.test(id)) throw new Error("SHOPIFY_TOKEN_ENCRYPTION_KEYS entries must be id:base64key, with ids of 1 to 32 letters, digits, - or _.");
    if (keys.some((key) => key.id === id)) throw new Error(`SHOPIFY_TOKEN_ENCRYPTION_KEYS repeats key id ${id}.`);
    keys.push({ id, key: parseEncryptionKey(entry.slice(colon + 1), `SHOPIFY_TOKEN_ENCRYPTION_KEYS key ${id}`) });
  }
  if (!keys.length) throw new Error("SHOPIFY_TOKEN_ENCRYPTION_KEYS is empty.");
  return keys;
}

type Binding = { email: string; alias: string; shop: string };

function tokenAad(format: string, keyId: string, { email, alias, shop }: Binding): Buffer {
  // Binds the ciphertext to its record and key id, so a token cannot be moved to another user or store.
  return Buffer.from(format === "v1" ? `v1\0${email}\0${alias.toLowerCase()}\0${shop}` : `${format}\0${keyId}\0${email}\0${alias.toLowerCase()}\0${shop}`);
}

/** Encrypt with the given key: v2.<keyId>.<iv>.<tag>.<ciphertext>. */
export function encryptToken(key: EncryptionKey, token: string, binding: Binding): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.key, iv);
  cipher.setAAD(tokenAad(TOKEN_FORMAT, key.id, binding));
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [TOKEN_FORMAT, key.id, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function open(key: Buffer, aad: Buffer, iv: string, tag: string, ciphertext: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

/** Decrypt with whichever configured key produced the value. keyId says which one. */
export function decryptToken(keys: EncryptionKey[], value: string, binding: Binding): { token: string; keyId: string } {
  const parts = value.split(".");
  if (parts[0] === TOKEN_FORMAT && parts.length === 5) {
    const [, keyId, iv, tag, ciphertext] = parts as [string, string, string, string, string];
    const key = keys.find((candidate) => candidate.id === keyId);
    if (!key) throw new Error(`Encryption key ${keyId} is not configured.`);
    return { token: open(key.key, tokenAad(TOKEN_FORMAT, keyId, binding), iv, tag, ciphertext), keyId };
  }
  if (parts[0] === "v1" && parts.length === 4) {
    // Written before key ids existed: try each key.
    const [, iv, tag, ciphertext] = parts as [string, string, string, string];
    for (const key of keys) {
      try {
        return { token: open(key.key, tokenAad("v1", "", binding), iv, tag, ciphertext), keyId: `v1:${key.id}` };
      } catch {
        // Try the next key.
      }
    }
    throw new Error("No configured key decrypts this token.");
  }
  throw new Error("Unknown encrypted token format.");
}

// ---------- Shopify request signatures ----------

/**
 * The message Shopify signs for an OAuth redirect: every parameter except hmac and signature,
 * with "%", "&" and "=" escaped in names and "%" and "&" escaped in values, array parameters
 * (name[]) written as name=["a", "b"], sorted by name, joined as name=value with "&".
 */
export function shopifyHmacMessage(params: URLSearchParams): string | undefined {
  const escapeKey = (value: string) => value.replace(/%/g, "%25").replace(/&/g, "%26").replace(/=/g, "%3D");
  const escapeValue = (value: string) => value.replace(/%/g, "%25").replace(/&/g, "%26");
  const grouped = new Map<string, string[]>();
  for (const [name, value] of params.entries()) {
    if (name === "hmac" || name === "signature") continue;
    grouped.set(name, [...(grouped.get(name) ?? []), value]);
  }
  const pairs: Array<[string, string]> = [];
  for (const [name, values] of grouped) {
    if (name.endsWith("[]")) {
      pairs.push([escapeKey(name.slice(0, -2)), escapeValue(`[${values.map((value) => `"${value}"`).join(", ")}]`)]);
    } else {
      // A repeated plain parameter is ambiguous; refuse rather than guess.
      if (values.length !== 1) return undefined;
      pairs.push([escapeKey(name), escapeValue(values[0]!)]);
    }
  }
  return pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, value]) => `${name}=${value}`).join("&");
}

/**
 * Verify the hmac Shopify adds to OAuth redirects (hex HMAC-SHA256 of shopifyHmacMessage, keyed
 * with the app's client secret). With nowMs, also require a timestamp no older than
 * CALLBACK_MAX_AGE_SECONDS (and no more than that in the future).
 */
export function verifyShopifyHmac(params: URLSearchParams, secret: string, nowMs?: number): boolean {
  const received = params.get("hmac") ?? "";
  if (!/^[0-9a-f]{64}$/i.test(received) || !secret) return false;
  const message = shopifyHmacMessage(params);
  if (message === undefined) return false;
  const expected = createHmac("sha256", secret).update(message).digest("hex");
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received.toLowerCase(), "hex"))) return false;
  if (nowMs !== undefined) {
    const timestamp = Number(params.get("timestamp"));
    if (!Number.isInteger(timestamp) || Math.abs(nowMs / 1000 - timestamp) > CALLBACK_MAX_AGE_SECONDS) return false;
  }
  return true;
}

function tokenKey(email: string, alias: string): string {
  return sha256(`shopify\0${email}\0${alias.toLowerCase()}`);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function formatTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Validate a token response: only an online token with a verified staff email is accepted. */
function onlineToken(payload: Record<string, unknown>): OnlineToken | { error: string; offline?: boolean } {
  // Only an online token carries the person's own permissions. An offline token would act as the app.
  const rawUser = payload.associated_user as Record<string, unknown> | undefined;
  if (typeof payload.access_token !== "string" || !rawUser || (typeof rawUser.id !== "number" && typeof rawUser.id !== "string") || typeof payload.expires_in !== "number") {
    return { error: "Shopify returned an app-level token instead of a per-user token. It was discarded.", offline: true };
  }
  if (typeof rawUser.email !== "string" || !rawUser.email.includes("@") || rawUser.email_verified !== true) {
    return { error: "Shopify did not report a verified email address for your staff account. Verify your email in Shopify, then try again." };
  }
  const associatedUser: ShopifyAssociatedUser = {
    id: String(rawUser.id),
    email: rawUser.email.trim().toLowerCase(),
    emailVerified: true,
    ...(typeof rawUser.first_name === "string" ? { firstName: rawUser.first_name } : {}),
    ...(typeof rawUser.last_name === "string" ? { lastName: rawUser.last_name } : {}),
    ...(typeof rawUser.account_owner === "boolean" ? { accountOwner: rawUser.account_owner } : {}),
    ...(typeof rawUser.collaborator === "boolean" ? { collaborator: rawUser.collaborator } : {})
  };
  return {
    accessToken: payload.access_token,
    scope: typeof payload.scope === "string" ? payload.scope : "",
    associatedUserScope: typeof payload.associated_user_scope === "string" ? payload.associated_user_scope : "",
    associatedUser,
    expiresIn: payload.expires_in
  };
}

function page(status: number, title: string, message: string): Response {
  return htmlPage({ status, title, body: `<div class="card"><h1>${escapeHtml(title)}</h1><p>${message}</p><p><a href="/stores">Back to your stores</a></p></div>` });
}

function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store", ...headers } });
}

export class ShopifyConnections {
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: ShopifyConnectOptions) {
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    options.auth.startLogin = (loginState) => this.startLogin(loginState);
  }

  get storesUrl(): string {
    return `${this.options.auth.issuer}/stores`;
  }

  /** One link that signs in if needed and reconnects every expired or unconnected store. */
  get reconnectUrl(): string {
    return `${this.options.auth.issuer}/stores/reconnect`;
  }

  // ---------- Per-request access ----------

  /** The caller's decrypted tokens for every store, for one MCP request. */
  async accessFor(email: string): Promise<UserShopifyAccess> {
    const tokens = new Map<string, ShopifyUserToken>();
    for (const store of await this.options.loadStores()) {
      const record = await this.options.store.get<ShopifyTokenRecord>("shopify_token", tokenKey(email, store.alias));
      if (!record || record.shop !== store.shop) continue;
      try {
        const binding = { email, alias: store.alias, shop: store.shop };
        const { token, keyId } = decryptToken(this.options.encryptionKeys, record.encryptedToken, binding);
        const primary = this.options.encryptionKeys[0]!;
        if (keyId !== primary.id) {
          // Rotation: re-encrypt with the newest key so the old key can be retired.
          await this.options.store.put<ShopifyTokenRecord>("shopify_token", tokenKey(email, store.alias), { ...record, encryptedToken: encryptToken(primary, token, binding) }, record.expiresAt + EXPIRED_RECORD_GRACE_MS);
        }
        tokens.set(store.alias.toLowerCase(), { token, expiresAt: record.expiresAt, ...(record.associatedUser.email ? { shopifyEmail: record.associatedUser.email } : {}) });
      } catch {
        // A rotated encryption key or a tampered record reads as "not connected".
        console.error(`Stored Shopify token for ${store.alias} could not be decrypted; the user must reconnect.`);
      }
    }
    // Every "not connected" or "expired" tool error carries the one reconnect link.
    return { tokens, storesUrl: this.storesUrl, connectUrl: () => this.reconnectUrl, now: this.now };
  }

  // ---------- Sign-in with Shopify ----------

  /** Stores a person can sign in through: *.myshopify.com, with app credentials on this server. */
  private async loginStores(): Promise<StoreConfig[]> {
    const stores = (await this.options.loadStores()).filter((store) => SHOP_HOST.test(store.shop) && this.options.clientId(store) && this.options.clientSecret(store));
    const preferred = this.options.identityStore?.toLowerCase();
    const index = preferred ? stores.findIndex((store) => store.alias.toLowerCase() === preferred) : -1;
    if (index > 0) stores.unshift(...stores.splice(index, 1));
    return stores;
  }

  /**
   * The login step of a sign-in: with one store, straight to its Shopify admin; with several,
   * a chooser listing them, the identity store (or the first) preselected.
   */
  private async startLogin(loginState: string): Promise<Response> {
    const stores = await this.loginStores();
    if (!stores.length) return page(503, "Sign-in unavailable", "No store on this server can be used to sign in. Ask the operator to configure the Shopify app credentials.");
    if (stores.length === 1) return this.redirectLogin(loginState, stores[0]!);
    const displayName = escapeHtml(this.options.auth.displayName);
    const state = escapeHtml(loginState);
    const buttons = stores.map((store, index) => `<form class="inline" method="post" action="/login/shopify"><input type="hidden" name="state" value="${state}"><input type="hidden" name="store" value="${escapeHtml(store.alias)}"><button${index === 0 ? ` class="primary"` : ""} type="submit">${escapeHtml(store.alias)}</button></form>`).join(" ");
    const body = `<div class="card">
<h1>Sign in to ${displayName}</h1>
<p>Sign in with your Shopify staff account. Choose a store you work in; you will log in to its Shopify admin, and that store is connected right away.</p>
<div class="actions">${buttons}</div>
<p class="muted">What you can do in each store is exactly what your Shopify staff permissions there allow.</p>
</div>`;
    return htmlPage({ title: `Sign in - ${this.options.auth.displayName}`, body, formAction: CONNECT_FORM_ACTION });
  }

  /** POST /login/shopify: the store picked on the chooser. The browser must hold the sign-in's binding cookie. */
  async chooseLogin(request: Request): Promise<Response> {
    if (request.method.toUpperCase() !== "POST") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json" } });
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      return htmlPage({ status: 400, title: "Bad request", body: `<div class="card"><p>Unsupported form submission.</p></div>` });
    }
    if (!sameOrigin(request, this.options.auth.issuer)) {
      return htmlPage({ status: 403, title: "Forbidden", body: `<div class="card"><p>This form was submitted from another site.</p></div>` });
    }
    const form = new URLSearchParams(await request.text());
    const loginState = form.get("state") ?? "";
    const peeked = await this.options.auth.peekLogin(request, loginState);
    if ("response" in peeked) return peeked.response;
    const alias = (form.get("store") ?? "").toLowerCase();
    const store = (await this.loginStores()).find((candidate) => candidate.alias.toLowerCase() === alias);
    if (!store) return page(400, "Sign-in problem", "That store cannot be used to sign in on this server.");
    return this.redirectLogin(loginState, store);
  }

  private async redirectLogin(loginState: string, store: StoreConfig): Promise<Response> {
    await this.options.auth.setLoginStore(loginState, store.alias);
    return new Response(null, { status: 302, headers: { location: this.authorizeUrl(store, loginState), "cache-control": "no-store" } });
  }

  private authorizeUrl(store: StoreConfig, state: string): string {
    const target = new URL(`https://${store.shop}/admin/oauth/authorize`);
    target.searchParams.set("client_id", this.options.clientId(store)!);
    target.searchParams.set("scope", this.options.scopes.join(","));
    target.searchParams.set("redirect_uri", `${this.options.auth.issuer}/shopify/callback`);
    target.searchParams.set("state", state);
    target.searchParams.append("grant_options[]", "per-user");
    return target.toString();
  }

  // ---------- /stores session ----------

  /** A page sign-in finished: open a /stores session, then show the page or reconnect every store. */
  async signedIn(email: string, purpose: PageSignInPurpose = "stores"): Promise<Response> {
    const value = randomBytes(32).toString("base64url");
    const key = sha256(value);
    await this.options.store.put<SessionRecord>("session", key, { email, purpose: "stores" }, this.now() + SESSION_TTL_MS);
    await this.options.auth.auditAuth({ event: "sign_in", user: email, clientId: PAGE_SIGN_IN_CLIENT, reason: purpose === "reconnect" ? "reconnect all stores" : "stores page" });
    const setCookie = { "set-cookie": cookie(SESSION_COOKIE, value, SESSION_TTL_MS / 1000) };
    if (purpose === "reconnect") {
      const next = await this.nextUnconnected(email);
      if (next) {
        const response = await this.startConnection({ key, email }, next, true);
        return appendSetCookie(response, setCookie["set-cookie"]);
      }
    }
    return redirect("/stores", setCookie);
  }

  private async session(request: Request): Promise<Session | undefined> {
    const value = readCookie(request, SESSION_COOKIE);
    if (!value || value.length > 100) return undefined;
    const key = sha256(value);
    const record = await this.options.store.get<SessionRecord>("session", key);
    if (!record || record.purpose !== "stores") return undefined;
    return { key, email: record.email, csrf: sha256(`csrf:${value}`) };
  }

  /** Every configured store. Whether the person may use one is up to Shopify. */
  private visibleStores(): Promise<StoreConfig[]> {
    return this.options.loadStores();
  }

  private async record(email: string, store: StoreConfig): Promise<ShopifyTokenRecord | undefined> {
    const record = await this.options.store.get<ShopifyTokenRecord>("shopify_token", tokenKey(email, store.alias));
    return record && record.shop === store.shop ? record : undefined;
  }

  /** The next store that is not connected, or whose connection expired. */
  private async nextUnconnected(email: string): Promise<StoreConfig | undefined> {
    for (const store of await this.visibleStores()) {
      if (!SHOP_HOST.test(store.shop) || !this.options.clientId(store) || !this.options.clientSecret(store)) continue;
      const record = await this.record(email, store);
      if (!record || record.expiresAt <= this.now()) return store;
    }
    return undefined;
  }

  // ---------- /stores ----------

  async handleStoresPage(request: Request): Promise<Response> {
    const method = request.method.toUpperCase();
    if (method === "GET") {
      const session = await this.session(request);
      if (!session) return this.options.auth.startPageSignIn("stores");
      return this.render(session);
    }
    if (method === "POST") return this.action(request);
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json" } });
  }

  /**
   * GET /stores/reconnect: the one link tool errors return. Signed out, it signs in with Shopify
   * and then reconnects every expired or unconnected store in a row. Signed in, it shows the
   * stores page, where one "Reconnect all" click does the same.
   */
  async handleReconnect(request: Request): Promise<Response> {
    if (request.method.toUpperCase() !== "GET") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json" } });
    const session = await this.session(request);
    if (!session) return this.options.auth.startPageSignIn("reconnect");
    return redirect("/stores");
  }

  private async render(session: Session, message?: string, status = 200): Promise<Response> {
    const displayName = this.options.auth.displayName;
    const stores = await this.visibleStores();
    const csrfField = `<input type="hidden" name="csrf" value="${session.csrf}">`;
    const now = this.now();
    let unconnected = 0;
    const rows: string[] = [];
    for (const store of stores) {
      const record = await this.record(session.email, store);
      const live = record && record.expiresAt > now;
      if (!live) unconnected += 1;
      const user = record?.associatedUser;
      const who = user ? `${escapeHtml(user.email ?? `Shopify user ${user.id}`)}${user.accountOwner ? " (store owner)" : ""}${user.collaborator ? " (collaborator)" : ""}` : "";
      const statusText = !record
        ? "Not connected"
        : live
          ? `Connected as ${who}<br><span class="muted">Expires ${formatTime(record.expiresAt)}</span>`
          : `Expired<br><span class="muted">Was ${who}, expired ${formatTime(record.expiresAt)}</span>`;
      const connect = this.connectForm(session, store.alias, false, record ? "Reconnect" : "Connect");
      const disconnect = record
        ? ` <form class="inline" method="post" action="/stores">${csrfField}<input type="hidden" name="action" value="disconnect"><input type="hidden" name="store" value="${escapeHtml(store.alias)}"><button class="danger" type="submit">Disconnect</button></form>`
        : "";
      rows.push(`<tr><td>${escapeHtml(store.alias)}<br><code class="muted">${escapeHtml(store.shop)}</code></td><td>${statusText}</td><td>${connect}${disconnect}</td></tr>`);
    }
    const first = unconnected ? await this.nextUnconnected(session.email) : undefined;
    const body = `<div class="card">
<h1>Your Shopify stores</h1>
<p class="muted">${escapeHtml(displayName)} - signed in with Shopify as ${escapeHtml(session.email)}</p>
<p>AI apps act as you in each connected store, and Shopify allows only what your staff permissions allow. Shopify ends each connection after 24 hours, or when you log out of the Shopify admin. Reconnect all takes one click; while you are logged in to Shopify, every store reconnects without further clicks.</p>
${message ? `<div class="warn"><p>${escapeHtml(message)}</p></div>` : ""}
${first ? `<div class="actions">${this.connectForm(session, first.alias, true, `Reconnect all (${unconnected} ${unconnected === 1 ? "store" : "stores"})`, "primary")}</div>` : ""}
${stores.length ? `<table><thead><tr><th>Store</th><th>Status</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table>` : `<p class="muted">No stores are configured on this server.</p>`}
<form method="post" action="/stores">${csrfField}<input type="hidden" name="action" value="signout"><div class="actions"><button type="submit">Sign out</button></div></form>
</div>`;
    return htmlPage({ status, title: `Your Shopify stores - ${displayName}`, body, formAction: CONNECT_FORM_ACTION });
  }

  private async action(request: Request): Promise<Response> {
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      return htmlPage({ status: 400, title: "Bad request", body: `<div class="card"><p>Unsupported form submission.</p></div>` });
    }
    if (!sameOrigin(request, this.options.auth.issuer)) {
      return htmlPage({ status: 403, title: "Forbidden", body: `<div class="card"><p>This form was submitted from another site.</p></div>` });
    }
    const session = await this.session(request);
    if (!session) return page(401, "Signed out", `Your session ended. <a href="/stores">Sign in again</a>.`);
    const form = new URLSearchParams(await request.text());
    if (!safeEqual(form.get("csrf") ?? "", session.csrf)) {
      return page(403, "Forbidden", `This form could not be verified. Reload the page and try again.`);
    }
    const action = form.get("action");
    if (action === "signout") {
      await this.options.store.delete("session", session.key);
      return htmlPage({ title: "Signed out", body: `<div class="card"><h1>Signed out</h1><p><a href="/stores">Sign in again</a>.</p></div>`, headers: { "set-cookie": cookie(SESSION_COOKIE, "", 0) } });
    }
    if (action === "disconnect") {
      const alias = form.get("store") ?? "";
      const store = (await this.visibleStores()).find((candidate) => candidate.alias.toLowerCase() === alias.toLowerCase());
      if (!store) return this.render(session, "That store was not found.", 404);
      await this.options.store.delete("shopify_token", tokenKey(session.email, store.alias));
      await this.options.auth.auditAuth({ event: "shopify_disconnected", user: session.email, store: store.alias });
      return redirect("/stores");
    }
    return this.render(session, "Unknown action.", 400);
  }

  // ---------- /shopify/connect ----------

  /**
   * GET shows a confirmation button; only a POST with the /stores CSRF token creates the state and
   * redirects to Shopify, so another site cannot start a Shopify authorization in the user's name.
   */
  async connect(request: Request): Promise<Response> {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "POST") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json" } });
    if (method === "GET") {
      const url = new URL(request.url);
      const session = await this.session(request);
      if (!session) return this.options.auth.startPageSignIn("stores");
      const checked = await this.connectableStore(session, url.searchParams.get("store") ?? "");
      if ("error" in checked) return checked.error;
      const chain = url.searchParams.get("chain") === "1";
      const body = `<div class="card">
<h1>Connect ${escapeHtml(checked.store.alias)}</h1>
<p>You will sign in to <code>${escapeHtml(checked.store.shop)}</code> with your Shopify staff account. AI apps will then act as you in this store, limited by your Shopify permissions.</p>
${this.connectForm(session, checked.store.alias, chain, "Continue to Shopify", "primary")}
<p><a href="/stores">Back to your stores</a></p>
</div>`;
      return htmlPage({ title: `Connect ${checked.store.alias}`, body, formAction: CONNECT_FORM_ACTION });
    }
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      return htmlPage({ status: 400, title: "Bad request", body: `<div class="card"><p>Unsupported form submission.</p></div>` });
    }
    if (!sameOrigin(request, this.options.auth.issuer)) {
      return htmlPage({ status: 403, title: "Forbidden", body: `<div class="card"><p>This form was submitted from another site.</p></div>` });
    }
    const session = await this.session(request);
    if (!session) return page(401, "Signed out", `Your session ended. <a href="/stores">Sign in again</a>.`);
    const form = new URLSearchParams(await request.text());
    if (!safeEqual(form.get("csrf") ?? "", session.csrf)) {
      return page(403, "Forbidden", `This form could not be verified. Reload the page and try again.`);
    }
    const checked = await this.connectableStore(session, form.get("store") ?? "");
    if ("error" in checked) return checked.error;
    return this.startConnection(session, checked.store, form.get("chain") === "1");
  }

  /** Create a single-use connection state bound to the /stores session and send the browser to Shopify. */
  private async startConnection(session: { key: string; email: string }, store: StoreConfig, chain: boolean): Promise<Response> {
    const state = randomBytes(32).toString("base64url");
    const record: StateRecord = { email: session.email, alias: store.alias, shop: store.shop, sessionSha256: session.key, chain };
    await this.options.store.put("shopify_state", sha256(state), record, this.now() + STATE_TTL_MS);
    return new Response(null, { status: 302, headers: { location: this.authorizeUrl(store, state), "cache-control": "no-store" } });
  }

  private connectForm(session: Session, alias: string, chain: boolean, label: string, style = ""): string {
    return `<form class="inline" method="post" action="/shopify/connect"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="store" value="${escapeHtml(alias)}">${chain ? `<input type="hidden" name="chain" value="1">` : ""}<button${style ? ` class="${style}"` : ""} type="submit">${escapeHtml(label)}</button></form>`;
  }

  private async connectableStore(session: Session, alias: string): Promise<{ store: StoreConfig } | { error: Response }> {
    const store = (await this.visibleStores()).find((candidate) => candidate.alias.toLowerCase() === alias.toLowerCase());
    if (!store) return { error: await this.render(session, `Store "${alias}" is not configured on this server.`, 404) };
    if (!SHOP_HOST.test(store.shop)) return { error: await this.render(session, `Store ${store.alias} does not use a *.myshopify.com domain, so it cannot be connected.`, 400) };
    if (!this.options.clientId(store) || !this.options.clientSecret(store)) {
      return { error: await this.render(session, `Store ${store.alias} has no Shopify app client id and secret on this server. Ask the operator to set SHOPIFY_APP_CLIENT_ID and SHOPIFY_APP_CLIENT_SECRET.`, 500) };
    }
    return { store };
  }

  // ---------- /shopify/callback ----------

  /**
   * Shopify's redirect back, for a sign-in or a store connection. The signature (keyed with the
   * store's app secret) and timestamp are checked first; the state then says which flow it is.
   */
  async callback(request: Request): Promise<Response> {
    if (request.method.toUpperCase() !== "GET") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json" } });
    const url = new URL(request.url);
    const params = url.searchParams;
    const shop = (params.get("shop") ?? "").toLowerCase();
    const stores = await this.options.loadStores();
    // The shop must be a configured store. Its secret verifies the signature.
    const store = SHOP_HOST.test(shop) ? stores.find((candidate) => candidate.shop.toLowerCase() === shop) : undefined;
    const secret = store ? this.options.clientSecret(store) : undefined;
    if (!store || !secret || !verifyShopifyHmac(params, secret, this.now())) {
      await this.options.auth.auditAuth({ event: "shopify_connect_denied", reason: "invalid Shopify signature, stale timestamp, or unknown shop", ...(store ? { store: store.alias } : {}) });
      return page(400, "Connection failed", "Shopify's response could not be verified. Start again from the stores page.");
    }
    const stateValue = params.get("state") ?? "";
    if (await this.options.auth.isLogin(stateValue)) return this.loginCallback(request, stateValue, store, secret);
    return this.connectionCallback(request, stateValue, store, secret);
  }

  /** Exchange an authorization code for an online token. */
  private async exchange(store: StoreConfig, secret: string, code: string): Promise<OnlineToken | { error: string; offline?: boolean; failed?: unknown }> {
    let payload: Record<string, unknown>;
    try {
      const response = await this.fetcher(`https://${store.shop}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ client_id: this.options.clientId(store), client_secret: secret, code }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000)
      });
      payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok || typeof payload.access_token !== "string") throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      return { error: "Shopify did not issue a token. Try again.", failed: error };
    }
    return onlineToken(payload);
  }

  /** Keep an online token as the person's connection to a store. */
  private async saveToken(email: string, store: StoreConfig, token: OnlineToken): Promise<void> {
    const now = this.now();
    const expiresAt = now + token.expiresIn * 1000;
    const record: ShopifyTokenRecord = {
      email,
      alias: store.alias,
      shop: store.shop,
      encryptedToken: encryptToken(this.options.encryptionKeys[0]!, token.accessToken, { email, alias: store.alias, shop: store.shop }),
      scope: token.scope,
      associatedUserScope: token.associatedUserScope,
      associatedUser: token.associatedUser,
      connectedAt: now,
      expiresAt
    };
    await this.options.store.put("shopify_token", tokenKey(email, store.alias), record, expiresAt + EXPIRED_RECORD_GRACE_MS);
    await this.options.auth.auditAuth({ event: "shopify_connected", user: email, store: store.alias, shopifyUserId: token.associatedUser.id, shopifyEmail: token.associatedUser.email!, reason: `expires ${new Date(expiresAt).toISOString()}` });
  }

  /** Shopify callback for a sign-in: the verified staff email becomes the person's identity. */
  private async loginCallback(request: Request, loginState: string, store: StoreConfig, secret: string): Promise<Response> {
    const auth = this.options.auth;
    const taken = await auth.takeLogin(request, loginState);
    if ("response" in taken) return taken.response;
    const { record } = taken;
    const done = (response: Response) => auth.clearLogin(response, loginState);
    if (!record.loginStore || record.loginStore.toLowerCase() !== store.alias.toLowerCase()) {
      return done(await auth.denyLogin(record, "Shopify returned a different store than the one you chose."));
    }
    const code = new URL(request.url).searchParams.get("code");
    if (!code) return done(await auth.denyLogin(record, "Shopify did not return an authorization code."));
    const token = await this.exchange(store, secret, code);
    if ("error" in token) {
      await auth.auditAuth({ event: "shopify_connect_denied", store: store.alias, reason: token.offline ? "Shopify returned an offline token" : token.failed ? "token exchange failed" : "no verified staff email", ...(token.failed ? { error: auditError(token.failed) } : {}) });
      return done(await auth.denyLogin(record, token.error));
    }
    const email = token.associatedUser.email!;
    await this.saveToken(email, store, token);
    return done(await auth.completeLogin(record, email));
  }

  /** Shopify callback for connecting one more store from the /stores session. */
  private async connectionCallback(request: Request, stateValue: string, store: StoreConfig, secret: string): Promise<Response> {
    const params = new URL(request.url).searchParams;
    const state = stateValue ? await this.options.store.take<StateRecord>("shopify_state", sha256(stateValue)) : undefined;
    const session = await this.session(request);
    if (!state || !session || !safeEqual(state.sessionSha256, session.key) || state.email !== session.email) {
      await this.options.auth.auditAuth({ event: "shopify_connect_denied", store: store.alias, reason: "missing, expired, reused, or foreign state", ...(session ? { user: session.email } : {}) });
      return page(400, "Connection failed", "This connection link expired, was already used, or was started in another browser. Start again from the stores page.");
    }
    if (state.shop !== store.shop || state.alias.toLowerCase() !== store.alias.toLowerCase()) {
      await this.options.auth.auditAuth({ event: "shopify_connect_denied", user: session.email, store: store.alias, reason: "shop does not match the store being connected" });
      return page(400, "Connection failed", "Shopify returned a different store than the one you were connecting.");
    }
    const code = params.get("code");
    if (!code) return page(400, "Connection failed", "Shopify did not return an authorization code.");
    const token = await this.exchange(store, secret, code);
    if ("error" in token) {
      await this.options.auth.auditAuth({ event: "shopify_connect_denied", user: session.email, store: store.alias, reason: token.offline ? "Shopify returned an offline token" : token.failed ? "token exchange failed" : "no verified staff email", ...(token.failed ? { error: auditError(token.failed) } : {}) });
      return page(502, "Connection failed", escapeHtml(token.error));
    }
    // One identity per person: every store connection must be the same verified Shopify email
    // the person signed in with, so nobody can act through someone else's staff account.
    if (token.associatedUser.email !== session.email) {
      await this.options.auth.auditAuth({ event: "shopify_connect_denied", user: session.email, store: store.alias, shopifyUserId: token.associatedUser.id, shopifyEmail: token.associatedUser.email!, reason: "Shopify email does not match the signed-in email" });
      return page(403, "Connection refused", `You are signed in as ${escapeHtml(session.email)}, but Shopify reported ${escapeHtml(token.associatedUser.email!)} for ${escapeHtml(store.alias)}. Log in to that store's admin with the same staff email, then try again.`);
    }
    await this.saveToken(session.email, store, token);
    if (state.chain) {
      // Reconnect all: go straight on to the next store. With an active Shopify admin session
      // Shopify redirects back without asking, so the whole chain needs no further clicks.
      const next = await this.nextUnconnected(session.email);
      if (next) return this.startConnection(session, next, true);
    }
    return redirect("/stores");
  }
}
