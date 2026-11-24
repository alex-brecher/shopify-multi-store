/** Minimal server-rendered pages for sign-in, consent and personal tokens. No external assets. */
export declare function escapeHtml(value: string): string;
export interface PageOptions {
    title: string;
    body: string;
    status?: number;
    headers?: Record<string, string>;
    /** CSP form-action sources. Defaults to 'self'. */
    formAction?: string;
    /** Extra trusted markup for <head>, such as a meta refresh. Escape any values in it. */
    head?: string;
    /** The viewer's chosen theme; "system" (the default) follows the device. */
    theme?: Theme;
}
export type Theme = "system" | "light" | "dark";
export declare const THEME_COOKIE = "__Host-sms_theme";
/** The theme the viewer picked on an earlier visit, from its cookie. */
export declare function themeFrom(request: Request): Theme;
/** Light, Dark and System links. The pages run no scripts, so each link sets a cookie on the server. */
export declare function themeSwitch(current: Theme, path: string): string;
/** An HTML page that cannot be framed, cached, or load anything from elsewhere. */
export declare function htmlPage({ title, body, status, headers, formAction, head, theme }: PageOptions): Response;
/** Parse a Cookie header. */
export declare function readCookie(request: Request, name: string): string | undefined;
/** A host-only, HttpOnly, Secure, SameSite=Lax cookie. */
export declare function cookie(name: string, value: string, maxAgeSeconds: number): string;
/**
 * Same-origin check for form posts.
 *
 * Pages here send Referrer-Policy: no-referrer, so Chromium sends `Origin: null` even on a
 * same-origin form post. Sec-Fetch-Site is not affected by referrer policy, so it decides when
 * present: only same-origin (or a user-typed "none") passes, and a real Origin must still match.
 * Without Sec-Fetch-Site, a missing Origin is accepted because the CSRF token and cookie binding
 * still apply, and an opaque "null" Origin is refused.
 */
export declare function sameOrigin(request: Request, origin: string): boolean;
/** The CSP form-action source that lets a form post end in a redirect to this URI. */
export declare function formActionSource(uri: string): string;
/** Include the www/apex sibling for HTTP(S) callback redirect chains. */
export declare function formActionSources(uri: string): string;
