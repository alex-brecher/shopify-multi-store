import type { StoreConfig } from "../config.js";
import { type AuthAuditEntry } from "./audit.js";
import type { OAuthStore } from "./store.js";
import { type EncryptionKey } from "./shopify-connect.js";
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
export declare const OFFLINE_REFRESH_WITHIN_MS: number;
/** The scheduled job refreshes a store whose token pair is at least this old. */
export declare const SCHEDULED_REFRESH_AFTER_MS: number;
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
    failure?: {
        reason: string;
        at: number;
    };
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
export declare class OfflineTokenError extends Error {
    readonly kind: "refused" | "unreadable" | "transient" | "busy" | "missing";
    constructor(kind: "refused" | "unreadable" | "transient" | "busy" | "missing", message: string);
}
export declare function offlineKey(alias: string): string;
/**
 * Validate an authorization-code or refresh response. Only an expiring offline token is accepted:
 * no associated_user (that would be an online token) and a refresh token with an expiry.
 */
export declare function expiringOfflineToken(payload: Record<string, unknown>, refresh?: boolean): ExpiringOfflineToken | {
    error: string;
};
export declare class OfflineTokens {
    private readonly options;
    private readonly sleep;
    /** Refreshes in flight in this isolate, per store, so concurrent callers share one. */
    private readonly inflight;
    constructor(options: OfflineTokensOptions);
    private get now();
    record(store: StoreConfig): Promise<OfflineTokenRecord | undefined>;
    /** The store's record if this person approved offline access on it. */
    authorizedFor(email: string, store: StoreConfig): Promise<OfflineTokenRecord | undefined>;
    private put;
    /** POST a form to the store's token endpoint, with one retry on a network error, timeout, 429 or 5xx. */
    private post;
    /** Exchange an authorization code (from an authorize URL without per-user) for an expiring offline token. */
    exchange(store: StoreConfig, code: string): Promise<ExpiringOfflineToken | {
        error: string;
        failed?: unknown;
    }>;
    /** Take the store's lease. Of concurrent callers on any isolate, exactly one gets it. */
    private lease;
    private release;
    /**
     * Run work holding the store's lease, waiting for another holder to finish first. done(record)
     * returns { value } when the wait already produced what the caller needs (another isolate
     * refreshed), and work is then skipped. Throws OfflineTokenError "busy" when the lease never
     * came free.
     */
    private withLease;
    /**
     * Keep a newly approved token for the store and add the person to its approvers. Holds the
     * lease so it never races a refresh: Shopify retires whichever pair was issued first.
     */
    approve(email: string, store: StoreConfig, code: string): Promise<ExpiringOfflineToken | {
        error: string;
        failed?: unknown;
    }>;
    /** Take one person off a store's approvers; with nobody left the record is deleted. */
    remove(email: string, store: StoreConfig): Promise<void>;
    private encryptPair;
    /**
     * A usable access token for the store: the stored one, or a refreshed one when it has under
     * OFFLINE_REFRESH_WITHIN_MS left. Throws OfflineTokenError when there is none.
     */
    accessToken(store: StoreConfig): Promise<string>;
    private decryptAccess;
    /**
     * Refresh the store's pair if it is still stale once this caller holds the lease. Callers in
     * this isolate share one attempt; callers on other isolates wait on the lease.
     */
    refreshIfStale(store: StoreConfig, trigger: "use" | "scheduled"): Promise<OfflineTokenRecord | undefined>;
    /** One refresh call. The caller holds the store's lease. */
    private refresh;
    /** Mark the store's offline connection as stopped, with the reason, and audit it. */
    private fail;
    /**
     * The scheduled job: refresh every store approved by someone still on the allowlist whose
     * pair is SCHEDULED_REFRESH_AFTER_MS old, so a store nobody uses stays alive for as long as
     * the job runs. Failures are recorded per store; one store never stops the rest.
     */
    refreshAll(stores: StoreConfig[], allowed: (email: string) => boolean): Promise<{
        refreshed: string[];
        failed: string[];
        skipped: string[];
    }>;
}
