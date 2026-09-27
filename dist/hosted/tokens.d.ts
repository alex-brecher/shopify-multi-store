import { type AuthorizationServer } from "./oauth.js";
import type { PolicySource } from "./policy.js";
import type { OAuthStore } from "./store.js";
/**
 * Personal access tokens, for MCP clients that can only send a static
 * Authorization: Bearer header. Users manage their own at /tokens after Google sign-in;
 * admins can see and revoke everyone's. Tokens are stored only as sha256 hashes.
 */
export declare const PERSONAL_TOKEN_PREFIX = "smsp_";
export interface PersonalTokenRecord {
    /** Public identifier used in the audit log and on the page. Not a secret. */
    id: string;
    email: string;
    name: string;
    createdAt: number;
    expiresAt: number;
    lastUsedAt?: number;
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
export declare class PersonalTokens {
    private readonly options;
    readonly enabled: boolean;
    readonly maxDays: number;
    private readonly now;
    constructor(options: PersonalTokenOptions);
    /** Lifetimes offered on the page, capped at maxDays. */
    get expiryChoices(): number[];
    /** Look up a personal access token. Returns its record if it is live. The caller re-checks the policy. */
    verify(token: string): Promise<PersonalTokenRecord | undefined>;
    handle(request: Request): Promise<Response>;
    private signedIn;
    private session;
    private tokensFor;
    private render;
    private action;
    private create;
    private revoke;
}
