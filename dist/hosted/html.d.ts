/** Minimal server-rendered pages for sign-in, consent and personal tokens. No external assets. */
export declare function escapeHtml(value: string): string;
export interface PageOptions {
    title: string;
    body: string;
    status?: number;
    headers?: Record<string, string>;
    /** CSP form-action sources. Defaults to 'self'. */
    formAction?: string;
}
/** An HTML page that cannot be framed, cached, or load anything from elsewhere. */
export declare function htmlPage({ title, body, status, headers, formAction }: PageOptions): Response;
/** Parse a Cookie header. */
export declare function readCookie(request: Request, name: string): string | undefined;
/** A host-only, HttpOnly, Secure, SameSite=Lax cookie. */
export declare function cookie(name: string, value: string, maxAgeSeconds: number): string;
/**
 * Same-origin check for form posts. Browsers send Origin on POST; a missing Origin is accepted
 * because the CSRF token and cookie binding still apply.
 */
export declare function sameOrigin(request: Request, origin: string): boolean;
/** The CSP form-action source that lets a form post end in a redirect to this URI. */
export declare function formActionSource(uri: string): string;
