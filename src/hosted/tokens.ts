import { randomBytes, timingSafeEqual } from "node:crypto";
import { cookie, escapeHtml, htmlPage, readCookie, sameOrigin } from "./html.js";
import { PAGE_SIGN_IN_CLIENT, sha256, type AuthorizationServer } from "./oauth.js";
import type { Principal, PolicySource } from "./policy.js";
import type { OAuthStore } from "./store.js";

/**
 * Personal access tokens, for MCP clients that can only send a static
 * Authorization: Bearer header. Users manage their own at /tokens after Google sign-in;
 * admins can see and revoke everyone's. Tokens are stored only as sha256 hashes.
 */

export const PERSONAL_TOKEN_PREFIX = "smsp_";
const TOKEN_PATTERN = /^smsp_[A-Za-z0-9_-]{43}$/;
const SESSION_COOKIE = "__Host-sms_tokens";
const SESSION_TTL_MS = 30 * 60_000;
const LAST_USED_WRITE_INTERVAL_MS = 5 * 60_000;
const EXPIRY_CHOICES_DAYS = [30, 90, 180];
const DEFAULT_EXPIRY_DAYS = 90;
const MAX_TOKENS_PER_USER = 20;
const DAY_MS = 24 * 3600_000;

export interface PersonalTokenRecord {
  /** Public identifier used in the audit log and on the page. Not a secret. */
  id: string;
  email: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt?: number;
}

interface SessionRecord {
  email: string;
}

export interface PersonalTokenOptions {
  auth: AuthorizationServer;
  store: OAuthStore;
  policy: PolicySource;
  enabled?: boolean;
  /** Longest lifetime a user may choose, in days. Defaults to 180. */
  maxDays?: number;
  now?: () => number;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function formatTime(ms: number | undefined): string {
  if (ms === undefined) return "Never";
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

interface Session {
  key: string;
  email: string;
  principal: Principal;
  csrf: string;
}

export class PersonalTokens {
  readonly enabled: boolean;
  readonly maxDays: number;
  private readonly now: () => number;

  constructor(private readonly options: PersonalTokenOptions) {
    this.enabled = options.enabled ?? true;
    this.maxDays = options.maxDays ?? 180;
    this.now = options.now ?? Date.now;
    if (this.enabled) options.auth.onPageSignIn = (_purpose, email) => this.signedIn(email);
  }

  /** Lifetimes offered on the page, capped at maxDays. */
  get expiryChoices(): number[] {
    const choices = EXPIRY_CHOICES_DAYS.filter((days) => days <= this.maxDays);
    return choices.length ? choices : [this.maxDays];
  }

  // ---------- Bearer verification ----------

  /** Look up a personal access token. Returns its record if it is live. The caller re-checks the policy. */
  async verify(token: string): Promise<PersonalTokenRecord | undefined> {
    if (!this.enabled || !TOKEN_PATTERN.test(token)) return undefined;
    const key = sha256(token);
    const record = await this.options.store.get<PersonalTokenRecord>("pat", key);
    if (!record || record.expiresAt <= this.now()) return undefined;
    const now = this.now();
    // Record last use, at most every few minutes so busy clients do not rewrite the store constantly.
    if (record.lastUsedAt === undefined || now - record.lastUsedAt >= LAST_USED_WRITE_INTERVAL_MS) {
      await this.options.store.put<PersonalTokenRecord>("pat", key, { ...record, lastUsedAt: now }, record.expiresAt);
    }
    return record;
  }

  // ---------- /tokens page ----------

  async handle(request: Request): Promise<Response> {
    if (!this.enabled) return htmlPage({ status: 404, title: "Not found", body: `<div class="card"><h1>Not found</h1><p>Personal access tokens are turned off on this server.</p></div>` });
    const method = request.method.toUpperCase();
    if (method === "GET") {
      const session = await this.session(request);
      if (!session) return this.options.auth.startPageSignIn("tokens");
      return this.render(session);
    }
    if (method === "POST") return this.action(request);
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json" } });
  }

  private async signedIn(email: string): Promise<Response> {
    const value = randomBytes(32).toString("base64url");
    await this.options.store.put<SessionRecord>("session", sha256(value), { email }, this.now() + SESSION_TTL_MS);
    await this.options.auth.auditAuth({ event: "sign_in", user: email, clientId: PAGE_SIGN_IN_CLIENT });
    return new Response(null, {
      status: 303,
      headers: { location: "/tokens", "cache-control": "no-store", "set-cookie": cookie(SESSION_COOKIE, value, SESSION_TTL_MS / 1000) }
    });
  }

  private async session(request: Request): Promise<Session | undefined> {
    const value = readCookie(request, SESSION_COOKIE);
    if (!value || value.length > 100) return undefined;
    const key = sha256(value);
    const record = await this.options.store.get<SessionRecord>("session", key);
    if (!record) return undefined;
    // The policy is re-checked on every page load and form post.
    const principal = this.options.policy.current().resolve(record.email);
    if (!principal) {
      await this.options.store.delete("session", key);
      return undefined;
    }
    return { key, email: record.email, principal, csrf: sha256(`csrf:${value}`) };
  }

  private async tokensFor(session: Session): Promise<Array<[string, PersonalTokenRecord]>> {
    const all = await this.options.store.entries<PersonalTokenRecord>("pat");
    const now = this.now();
    return all
      .filter(([, record]) => record.expiresAt > now && (session.principal.role === "admin" || record.email === session.email))
      .sort((a, b) => b[1].createdAt - a[1].createdAt);
  }

  private async render(session: Session, extra: { created?: { token: string; record: PersonalTokenRecord }; message?: string; status?: number } = {}): Promise<Response> {
    const displayName = this.options.auth.displayName;
    const admin = session.principal.role === "admin";
    const tokens = await this.tokensFor(session);
    const own = tokens.filter(([, record]) => record.email === session.email);
    const others = tokens.filter(([, record]) => record.email !== session.email);
    const csrfField = `<input type="hidden" name="csrf" value="${session.csrf}">`;
    const row = ([, record]: [string, PersonalTokenRecord], showOwner: boolean) => `<tr>
<td>${escapeHtml(record.name)}<br><code class="muted">${escapeHtml(record.id)}</code></td>
${showOwner ? `<td>${escapeHtml(record.email)}</td>` : ""}
<td>${formatTime(record.createdAt)}</td><td>${formatTime(record.expiresAt)}</td><td>${formatTime(record.lastUsedAt)}</td>
<td><form class="inline" method="post" action="/tokens">${csrfField}<input type="hidden" name="action" value="revoke"><input type="hidden" name="id" value="${escapeHtml(record.id)}"><button class="danger" type="submit">Revoke</button></form></td>
</tr>`;
    const table = (rows: Array<[string, PersonalTokenRecord]>, showOwner: boolean) => rows.length
      ? `<table><thead><tr><th>Name</th>${showOwner ? "<th>Owner</th>" : ""}<th>Created</th><th>Expires</th><th>Last used</th><th></th></tr></thead><tbody>${rows.map((entry) => row(entry, showOwner)).join("")}</tbody></table>`
      : `<p class="muted">None.</p>`;
    const choices = this.expiryChoices;
    const selected = choices.includes(DEFAULT_EXPIRY_DAYS) ? DEFAULT_EXPIRY_DAYS : choices[choices.length - 1];
    const created = extra.created
      ? `<div class="warn"><p>Copy this token now. It will not be shown again.</p><code class="secret">${escapeHtml(extra.created.token)}</code><p class="muted">Send it as <code>Authorization: Bearer ${escapeHtml(PERSONAL_TOKEN_PREFIX)}...</code> to <code>${escapeHtml(this.options.auth.resource)}</code>. It expires ${formatTime(extra.created.record.expiresAt)}.</p></div>`
      : "";
    const body = `<div class="card">
<h1>Personal access tokens</h1>
<p class="muted">${escapeHtml(displayName)} - signed in as ${escapeHtml(session.email)} (${escapeHtml(session.principal.role)})</p>
<p>Use a personal access token only with apps that cannot sign in with OAuth and accept a fixed Authorization header. A token acts as you, with your role and stores, until it expires or you revoke it.</p>
${extra.message ? `<div class="warn"><p>${escapeHtml(extra.message)}</p></div>` : ""}
${created}
<h2>Create a token</h2>
<form method="post" action="/tokens">${csrfField}<input type="hidden" name="action" value="create">
<label for="name">Name</label><input id="name" name="name" required maxlength="80" placeholder="Laptop - Cursor">
<label for="days">Expires after</label><select id="days" name="days">${choices.map((days) => `<option value="${days}"${days === selected ? " selected" : ""}>${days} days</option>`).join("")}</select>
<div class="actions"><button class="primary" type="submit">Create token</button></div>
</form>
<h2>Your tokens</h2>
${table(own, false)}
${admin ? `<h2>All users' tokens</h2>${table(others, true)}` : ""}
<form method="post" action="/tokens">${csrfField}<input type="hidden" name="action" value="signout"><div class="actions"><button type="submit">Sign out</button></div></form>
</div>`;
    return htmlPage({ status: extra.status ?? 200, title: `Personal access tokens - ${displayName}`, body });
  }

  private async action(request: Request): Promise<Response> {
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      return htmlPage({ status: 400, title: "Bad request", body: `<div class="card"><p>Unsupported form submission.</p></div>` });
    }
    if (!sameOrigin(request, this.options.auth.issuer)) {
      return htmlPage({ status: 403, title: "Forbidden", body: `<div class="card"><p>This form was submitted from another site.</p></div>` });
    }
    const session = await this.session(request);
    if (!session) {
      return htmlPage({ status: 401, title: "Signed out", body: `<div class="card"><h1>Signed out</h1><p>Your session ended. <a href="/tokens">Sign in again</a>.</p></div>` });
    }
    const form = new URLSearchParams(await request.text());
    if (!safeEqual(form.get("csrf") ?? "", session.csrf)) {
      return htmlPage({ status: 403, title: "Forbidden", body: `<div class="card"><p>This form could not be verified. <a href="/tokens">Reload the page</a> and try again.</p></div>` });
    }
    const action = form.get("action");
    if (action === "create") return this.create(session, form);
    if (action === "revoke") return this.revoke(session, form.get("id") ?? "");
    if (action === "signout") {
      await this.options.store.delete("session", session.key);
      return htmlPage({ title: "Signed out", body: `<div class="card"><h1>Signed out</h1><p><a href="/tokens">Sign in again</a>.</p></div>`, headers: { "set-cookie": cookie(SESSION_COOKIE, "", 0) } });
    }
    return this.render(session, { status: 400, message: "Unknown action." });
  }

  private async create(session: Session, form: URLSearchParams): Promise<Response> {
    const name = (form.get("name") ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (!name || name.length > 80) return this.render(session, { status: 400, message: "Give the token a name of 1 to 80 characters." });
    const days = Number(form.get("days") ?? DEFAULT_EXPIRY_DAYS);
    if (!this.expiryChoices.includes(days)) return this.render(session, { status: 400, message: `Choose an expiry of ${this.expiryChoices.join(", ")} days.` });
    const mine = (await this.options.store.entries<PersonalTokenRecord>("pat")).filter(([, record]) => record.email === session.email && record.expiresAt > this.now());
    if (mine.length >= MAX_TOKENS_PER_USER) return this.render(session, { status: 400, message: `You already have ${MAX_TOKENS_PER_USER} tokens. Revoke one first.` });

    const token = `${PERSONAL_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const now = this.now();
    const record: PersonalTokenRecord = { id: `pat_${randomBytes(9).toString("base64url")}`, email: session.email, name, createdAt: now, expiresAt: now + days * DAY_MS };
    await this.options.store.put("pat", sha256(token), record, record.expiresAt);
    await this.options.auth.auditAuth({ event: "personal_token_created", user: session.email, tokenId: record.id, reason: `expires in ${days} days` });
    return this.render(session, { created: { token, record } });
  }

  private async revoke(session: Session, id: string): Promise<Response> {
    const entry = (await this.options.store.entries<PersonalTokenRecord>("pat")).find(([, record]) => record.id === id);
    if (!entry || (entry[1].email !== session.email && session.principal.role !== "admin")) {
      return this.render(session, { status: 404, message: "That token was not found." });
    }
    await this.options.store.delete("pat", entry[0]);
    await this.options.auth.auditAuth({
      event: "personal_token_revoked",
      user: session.email,
      tokenId: id,
      ...(entry[1].email !== session.email ? { reason: `admin revoked a token owned by ${entry[1].email}` } : {})
    });
    return new Response(null, { status: 303, headers: { location: "/tokens", "cache-control": "no-store" } });
  }
}
