import type { StoreConfig } from "../config.js";
import { auditError, type AuthAuditEntry } from "./audit.js";
import { sha256 } from "./oauth.js";
import type { OAuthStore } from "./store.js";
import { randomToken } from "../platform/crypto.js";
import { decryptToken, decryptWithAnyKey, encryptToken, type EncryptionKey } from "./shopify-connect.js";

/**
 * Shopify expiring offline access tokens for the people on OFFLINE_TOKEN_USERS.
 *
 * Shopify keeps one current expiring offline token per app and store, so the token is stored
 * once per store (not per person), with the list of allowlisted people who personally
 * approved it on that store. The access token lives 1 hour; the refresh token 90 days, and
 * every refresh returns a new pair. A refresh is single-flight per store across every Worker
 * isolate: a short lease kept in the OAuth store (a Durable Object on Cloudflare) decides who
 * refreshes, and everyone else waits for the new pair, so two requests never spend the same
 * rotating refresh token.
 *
 * Docs:
 * https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens
 * https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
 * https://shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange#refresh-an-expiring-offline-token
 */

/** Refresh before use when the access token has less than this left. */
export const OFFLINE_REFRESH_WITHIN_MS = 5 * 60_000;
/** The scheduled job refreshes a store whose token pair is at least this old. */
export const SCHEDULED_REFRESH_AFTER_MS = 24 * 3600_000;
/** How long one refresh may hold a store's lease before another isolate may take over. */
const LEASE_MS = 60_000;
/** How often and how many times a request polls while another one refreshes the same store. */
const WAIT_STEP_MS = 200;
const WAIT_STEPS = 100;
/** Keep a record this long after its refresh token ends, so /stores can say why it stopped. */
const RECORD_GRACE_MS = 30 * 24 * 3600_000;
/** Shopify's documented refresh token lifetime (90 days), used if a response leaves it out. */
const DEFAULT_REFRESH_LIFETIME_S = 7_776_000;
/** Shopify's documented access token lifetime (1 hour), used if a refresh response leaves it out. */
const DEFAULT_ACCESS_LIFETIME_S = 3600;

/** One store's expiring offline token pair, both encrypted. */
export interface OfflineTokenRecord {
  alias: string;
  shop: string;
  encryptedToken: string;
  encryptedRefreshToken: string;
  scope: string;
  /** Verified, lower-case emails of the allowlisted people who approved offline access on this store. */
  authorizedBy: string[];
  /** Last approval through Shopify's authorization page. */
  connectedAt: number;
  /** When the current pair was issued (approval or refresh). */
  issuedAt: number;
  /** Access token expiry (ms). */
  expiresAt: number;
  /** Refresh token expiry (ms): the connection lasts until then unless it is refreshed. */
  refreshExpiresAt: number;
  /** Set when Shopify refused a refresh (or the stored pair cannot be read). The store is then not connected. */
  failure?: { reason: string; at: number };
}

/** A checked token response with an expiring offline token. */
export interface ExpiringOfflineToken {
  accessToken: string;
  refreshToken: string;
  scope?: string;
  expiresIn: number;
  refreshExpiresIn: number;
}

export interface OfflineTokensOptions {
  store: OAuthStore;
  encryptionKeys: EncryptionKey[];
  clientId: (store: StoreConfig) => string | undefined;
  clientSecret: (store: StoreConfig) => string | undefined;
  audit: (entry: Omit<AuthAuditEntry, "timestamp">) => Promise<void>;
  fetch: typeof fetch;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Why a token could not be returned. "refused" and "unreadable" mark the record failed; "busy" and "transient" do not. */
export class OfflineTokenError extends Error {
  constructor(readonly kind: "refused" | "unreadable" | "transient" | "busy" | "missing", message: string) {
    super(message);
  }
}

export function offlineKey(alias: string): string {
  return sha256(`shopify-offline\0${alias.toLowerCase()}`);
}

export function leaseKey(alias: string): string {
  return sha256(`shopify-offline-lease\0${alias.toLowerCase()}`);
}

// Distinct AAD labels (no "@", so never an email) keep the access and refresh ciphertexts from
// being swapped with each other or with any person's online token.
const ACCESS_LABEL = "offline-access";
const REFRESH_LABEL = "offline-refresh";

function binding(label: string, store: { alias: string; shop: string }) {
  return { email: label, alias: store.alias, shop: store.shop };
}

/**
 * Validate an authorization-code or refresh response. Only an expiring offline token is accepted:
 * no associated_user (that would be an online token) and a refresh token with an expiry.
 */
export function expiringOfflineToken(payload: Record<string, unknown>, refresh = false): ExpiringOfflineToken | { error: string } {
  if (typeof payload.access_token !== "string" || !payload.access_token) return { error: "Shopify did not return an access token." };
  if (payload.associated_user) return { error: "Shopify returned a per-user token instead of an offline token. It was discarded." };
  if (typeof payload.refresh_token !== "string" || !payload.refresh_token) {
    return { error: "Shopify returned an offline token that does not expire, so it cannot be renewed. It was discarded." };
  }
  // A refresh answer with both tokens is always kept (Shopify rotated already); a missing lifetime
  // falls back to the documented 1 hour. A code exchange must state it.
  const expiresIn = typeof payload.expires_in === "number" && payload.expires_in > 0 ? payload.expires_in : refresh ? DEFAULT_ACCESS_LIFETIME_S : undefined;
  if (expiresIn === undefined) return { error: "Shopify returned an offline token that does not expire, so it cannot be renewed. It was discarded." };
  const refreshExpiresIn = typeof payload.refresh_token_expires_in === "number" && payload.refresh_token_expires_in > 0
    ? payload.refresh_token_expires_in
    : refresh ? DEFAULT_REFRESH_LIFETIME_S : undefined;
  if (refreshExpiresIn === undefined) return { error: "Shopify did not say when the refresh token expires. It was discarded." };
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    ...(typeof payload.scope === "string" ? { scope: payload.scope } : {}),
    expiresIn,
    refreshExpiresIn
  };
}

type PostResult = { ok: true; payload: Record<string, unknown> } | { ok: false; status?: number; code?: string; final: boolean; error: unknown };

export class OfflineTokens {
  private readonly sleep: (ms: number) => Promise<void>;
  /** Refreshes in flight in this isolate, per store, so concurrent callers share one. */
  private readonly inflight = new Map<string, Promise<OfflineTokenRecord | undefined>>();

  constructor(private readonly options: OfflineTokensOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private get now(): number {
    return this.options.now();
  }

  async record(store: StoreConfig): Promise<OfflineTokenRecord | undefined> {
    const record = await this.options.store.get<OfflineTokenRecord>("shopify_offline", offlineKey(store.alias));
    return record && record.shop === store.shop ? record : undefined;
  }

  /** The store's record if this person approved offline access on it. */
  async authorizedFor(email: string, store: StoreConfig): Promise<OfflineTokenRecord | undefined> {
    const record = await this.record(store);
    return record && record.authorizedBy.includes(email.toLowerCase()) ? record : undefined;
  }

  private async put(record: OfflineTokenRecord): Promise<void> {
    await this.options.store.put("shopify_offline", offlineKey(record.alias), record, record.refreshExpiresAt + RECORD_GRACE_MS);
  }

  // ---------- Shopify token endpoint ----------

  /**
   * POST a form to the store's token endpoint, with one retry on a network error, timeout, 429 or
   * 5xx. Shopify documents that retry as safe for a refresh too: the presented refresh token stays
   * usable until the app uses the newer one.
   */
  private async post(store: StoreConfig, fields: Record<string, string>): Promise<PostResult> {
    let last: PostResult = { ok: false, final: false, error: new Error("not attempted") };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.options.fetch(`https://${store.shop}/admin/oauth/access_token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams(fields).toString(),
          redirect: "manual",
          signal: AbortSignal.timeout(10_000)
        });
        const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (response.ok) return { ok: true, payload };
        // 4xx other than 429 is Shopify's final answer; retrying returns the same thing.
        const final = response.status >= 400 && response.status < 500 && response.status !== 429;
        const code = typeof payload.error === "string" ? payload.error : undefined;
        last = { ok: false, status: response.status, ...(code ? { code } : {}), final, error: Object.assign(new Error(`HTTP ${response.status}`), { status: response.status }) };
        if (final) return last;
      } catch (error) {
        last = { ok: false, final: false, error };
      }
    }
    return last;
  }

  /** Exchange an authorization code (from an authorize URL without per-user) for an expiring offline token. */
  async exchange(store: StoreConfig, code: string): Promise<ExpiringOfflineToken | { error: string; failed?: unknown }> {
    const clientId = this.options.clientId(store);
    const secret = this.options.clientSecret(store);
    if (!clientId || !secret) return { error: "This server has no Shopify app for this store." };
    const result = await this.post(store, { client_id: clientId, client_secret: secret, code, expiring: "1" });
    if (!result.ok) return { error: "Shopify did not issue a token. Try again.", failed: result.error };
    return expiringOfflineToken(result.payload);
  }

  // ---------- Single-flight lease ----------

  /**
   * Take the store's lease. Of concurrent callers on any isolate, exactly one gets it. Returns the
   * lease id, which release() needs, or undefined when someone else holds it.
   */
  private async lease(store: StoreConfig): Promise<string | undefined> {
    const id = randomToken(16);
    return (await this.options.store.putIfAbsent("shopify_lease", leaseKey(store.alias), { id }, this.now + LEASE_MS)) ? id : undefined;
  }

  /** Release only a lease this caller still owns (one that expired and was taken over is left alone). */
  private async release(id: string): Promise<void> {
    await this.options.store.deleteMatching("shopify_lease", { id });
  }

  /**
   * Run work holding the store's lease, waiting for another holder to finish first. done(record)
   * returns { value } when the wait already produced what the caller needs (another isolate
   * refreshed), and work is then skipped. Throws OfflineTokenError "busy" when the lease never
   * came free.
   */
  private async withLease<T>(store: StoreConfig, work: () => Promise<T>, done?: (record: OfflineTokenRecord | undefined) => { value: T } | undefined): Promise<T> {
    for (let step = 0; step <= WAIT_STEPS; step += 1) {
      const id = await this.lease(store);
      if (id) {
        try {
          return await work();
        } finally {
          await this.release(id).catch(() => {});
        }
      }
      if (step === WAIT_STEPS) break;
      await this.sleep(WAIT_STEP_MS);
      if (done) {
        const finished = done(await this.record(store));
        if (finished) return finished.value;
      }
    }
    throw new OfflineTokenError("busy", `Another request is renewing the Shopify connection to store "${store.alias}". Try again in a minute.`);
  }

  // ---------- Approval ----------

  /**
   * Keep a newly approved token for the store and add the person to its approvers. Holds the
   * lease so it never races a refresh: Shopify retires whichever pair was issued first.
   */
  async approve(email: string, store: StoreConfig, code: string): Promise<ExpiringOfflineToken | { error: string; failed?: unknown }> {
    return this.withLease(store, async () => {
      const token = await this.exchange(store, code);
      if ("error" in token) return token;
      const now = this.now;
      const previous = await this.record(store);
      const approvers = new Set([...(previous && !previous.failure ? previous.authorizedBy : []), email.toLowerCase()]);
      const [encryptedToken, encryptedRefreshToken] = await this.encryptPair(store, token);
      await this.put({
        alias: store.alias,
        shop: store.shop,
        encryptedToken,
        encryptedRefreshToken,
        scope: token.scope ?? "",
        authorizedBy: [...approvers].sort(),
        connectedAt: now,
        issuedAt: now,
        expiresAt: now + token.expiresIn * 1000,
        refreshExpiresAt: now + token.refreshExpiresIn * 1000
      });
      return token;
    });
  }

  /** Take one person off a store's approvers; with nobody left the record is deleted. */
  async remove(email: string, store: StoreConfig): Promise<void> {
    if (!(await this.authorizedFor(email, store))) return;
    // Under the lease, so a refresh finishing at the same moment is not written over.
    await this.withLease(store, async () => {
      const record = await this.record(store);
      if (!record) return;
      const rest = record.authorizedBy.filter((approver) => approver !== email.toLowerCase());
      if (rest.length === record.authorizedBy.length) return;
      if (rest.length) await this.put({ ...record, authorizedBy: rest });
      else await this.options.store.delete("shopify_offline", offlineKey(store.alias));
    });
  }

  private async encryptPair(store: StoreConfig, token: ExpiringOfflineToken): Promise<[string, string]> {
    const key = this.options.encryptionKeys[0]!;
    return Promise.all([
      encryptToken(key, token.accessToken, binding(ACCESS_LABEL, store)),
      encryptToken(key, token.refreshToken, binding(REFRESH_LABEL, store))
    ]);
  }

  // ---------- Use ----------

  /**
   * A usable access token for the store: the stored one, or a refreshed one when it has under
   * OFFLINE_REFRESH_WITHIN_MS left. Throws OfflineTokenError when there is none.
   */
  async accessToken(store: StoreConfig): Promise<string> {
    const stored = await this.record(store);
    if (!stored) throw new OfflineTokenError("missing", `Store "${store.alias}" has no offline connection.`);
    if (stored.failure) throw new OfflineTokenError("refused", stored.failure.reason);
    let record: OfflineTokenRecord | undefined = stored;
    if (stored.expiresAt - this.now < OFFLINE_REFRESH_WITHIN_MS) {
      try {
        record = await this.refreshIfStale(store, "use");
      } catch (error) {
        // A refresh that could not run right now: the current token still works if it has not ended.
        if (error instanceof OfflineTokenError && (error.kind === "transient" || error.kind === "busy") && stored.expiresAt > this.now) {
          return this.decryptAccess(store, stored);
        }
        throw error;
      }
      if (!record) throw new OfflineTokenError("missing", `Store "${store.alias}" has no offline connection.`);
      if (record.failure) throw new OfflineTokenError("refused", record.failure.reason);
    }
    return this.decryptAccess(store, record);
  }

  /**
   * Decrypt one stored token. undefined only when no configured key can read it (the key was
   * removed, or the value is damaged); any other failure throws a transient error and changes nothing.
   */
  private async readable(store: StoreConfig, value: string, label: string): Promise<string | undefined> {
    try {
      return (await decryptToken(this.options.encryptionKeys, value, binding(label, store))).token;
    } catch {
      // Try every configured key before calling it unreadable.
    }
    try {
      const token = await decryptWithAnyKey(this.options.encryptionKeys, value, binding(label, store));
      if (token !== undefined) {
        console.error(`Offline token for ${store.alias} was read with a key other than the one it names.`);
        return token;
      }
    } catch (error) {
      await this.options.audit({ event: "shopify_refresh_failed", store: store.alias, reason: "stored token could not be decrypted just now; will retry", error: auditError(error) });
      throw new OfflineTokenError("transient", `The connection to store "${store.alias}" could not be read just now. Try again in a minute.`);
    }
    return undefined;
  }

  private async decryptAccess(store: StoreConfig, record: OfflineTokenRecord): Promise<string> {
    const token = await this.readable(store, record.encryptedToken, ACCESS_LABEL);
    if (token !== undefined) return token;
    const reason = "The stored token could not be read (encryption key changed). Reconnect the store.";
    // Read outside the lease: mark it failed only if the pair is still the one that failed.
    await this.withLease(store, async () => {
      const current = await this.record(store);
      if (current && !current.failure && current.encryptedToken === record.encryptedToken) await this.fail(store, current, reason, "unreadable").catch(() => {});
    }).catch(() => {});
    throw new OfflineTokenError("unreadable", reason);
  }

  /**
   * Refresh the store's pair if it is still stale once this caller holds the lease. Callers in
   * this isolate share one attempt; callers on other isolates wait on the lease.
   */
  refreshIfStale(store: StoreConfig, trigger: "use" | "scheduled" | "forced"): Promise<OfflineTokenRecord | undefined> {
    const key = `${trigger}\0${store.alias.toLowerCase()}`;
    let pending = this.inflight.get(key);
    if (!pending) {
      // forced: an operator's "Renew now" (the post-deploy canary); always spends the refresh token.
      const stale = (record: OfflineTokenRecord) => trigger === "forced"
        ? true
        : trigger === "use"
          ? record.expiresAt - this.now < OFFLINE_REFRESH_WITHIN_MS
          : this.now - record.issuedAt >= SCHEDULED_REFRESH_AFTER_MS;
      pending = this.withLease(
        store,
        async () => {
          const record = await this.record(store);
          if (!record || record.failure || !stale(record)) return record;
          return this.refresh(store, record, trigger);
        },
        (record) => (!record || record.failure || !stale(record) ? { value: record } : undefined)
      );
      this.inflight.set(key, pending);
      void pending.finally(() => this.inflight.delete(key)).catch(() => {});
    }
    return pending;
  }

  /** One refresh call. The caller holds the store's lease. */
  private async refresh(store: StoreConfig, record: OfflineTokenRecord, trigger: "use" | "scheduled" | "forced"): Promise<OfflineTokenRecord> {
    const clientId = this.options.clientId(store);
    const secret = this.options.clientSecret(store);
    if (!clientId || !secret) throw new OfflineTokenError("transient", `This server has no Shopify app credentials for store "${store.alias}".`);
    const refreshToken = await this.readable(store, record.encryptedRefreshToken, REFRESH_LABEL);
    if (refreshToken === undefined) {
      return this.fail(store, record, "The stored refresh token could not be read (encryption key changed). Reconnect the store.", "unreadable");
    }
    const result = await this.post(store, { client_id: clientId, client_secret: secret, grant_type: "refresh_token", refresh_token: refreshToken });
    if (!result.ok) {
      // Only Shopify's documented answer for a dead refresh token, HTTP 401 with error
      // invalid_request (unknown, replaced, expired, revoked or uninstalled), stops the store.
      // Anything else (any 400, 401 invalid_client, a frozen shop, 403, 404, an HTML body, 5xx)
      // is logged and retried later, so one bad setting or a Shopify hiccup disconnects nothing.
      const refused = result.status === 401 && result.code === "invalid_request";
      if (refused) {
        const reason = "Shopify refused the refresh token: it expired, was revoked, or the app was uninstalled. Reconnect the store.";
        return this.fail(store, record, reason, "refused", result.error, result.status);
      }
      await this.options.audit({ event: "shopify_refresh_failed", store: store.alias, reason: `${result.final ? `not renewed (HTTP ${result.status}${result.code ? ` ${result.code}` : ""}); check the app credentials` : "temporary failure"} (${trigger}); will retry`, error: auditError(result.error), ...(result.status ? { status: result.status } : {}) });
      throw new OfflineTokenError("transient", `Shopify did not renew the connection to store "${store.alias}" just now. Try again in a minute.`);
    }
    const token = expiringOfflineToken(result.payload, true);
    if ("error" in token) {
      await this.options.audit({ event: "shopify_refresh_failed", store: store.alias, reason: `unexpected refresh response (${trigger}): ${token.error}` });
      throw new OfflineTokenError("transient", `Shopify did not renew the connection to store "${store.alias}" just now. Try again in a minute.`);
    }
    const now = this.now;
    const [encryptedToken, encryptedRefreshToken] = await this.encryptPair(store, token);
    const next: OfflineTokenRecord = {
      ...record,
      encryptedToken,
      encryptedRefreshToken,
      ...(token.scope !== undefined ? { scope: token.scope } : {}),
      issuedAt: now,
      expiresAt: now + token.expiresIn * 1000,
      refreshExpiresAt: now + token.refreshExpiresIn * 1000
    };
    delete next.failure;
    await this.put(next);
    await this.options.audit({ event: "shopify_token_refreshed", store: store.alias, reason: `${trigger}; refresh token expires ${new Date(next.refreshExpiresAt).toISOString()}` });
    return next;
  }

  /** Mark the store's offline connection as stopped, with the reason, and audit it. */
  private async fail(store: StoreConfig, record: OfflineTokenRecord, reason: string, kind: "refused" | "unreadable", error?: unknown, status?: number): Promise<never> {
    await this.put({ ...record, failure: { reason, at: this.now } });
    await this.options.audit({ event: "shopify_refresh_failed", store: store.alias, reason, ...(error ? { error: auditError(error) } : {}), ...(status ? { status } : {}) });
    throw new OfflineTokenError(kind, reason);
  }

  /**
   * The scheduled job: refresh every store approved by someone still on the allowlist whose
   * pair is SCHEDULED_REFRESH_AFTER_MS old, so a store nobody uses stays alive for as long as
   * the job runs. Failures are recorded per store; one store never stops the rest.
   */
  async refreshAll(stores: StoreConfig[], allowed: (email: string) => boolean): Promise<{ refreshed: string[]; failed: string[]; skipped: string[] }> {
    const out = { refreshed: [] as string[], failed: [] as string[], skipped: [] as string[] };
    for (const [, record] of await this.options.store.entries<OfflineTokenRecord>("shopify_offline")) {
      const store = stores.find((candidate) => candidate.alias.toLowerCase() === record.alias.toLowerCase() && candidate.shop === record.shop);
      if (!store || record.failure || !record.authorizedBy.some(allowed) || this.now - record.issuedAt < SCHEDULED_REFRESH_AFTER_MS) {
        out.skipped.push(record.alias);
        continue;
      }
      try {
        const after = await this.refreshIfStale(store, "scheduled");
        (after && !after.failure ? out.refreshed : out.failed).push(store.alias);
      } catch {
        out.failed.push(store.alias);
      }
    }
    return out;
  }
}
