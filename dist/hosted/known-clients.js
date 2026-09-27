/**
 * Redirect URI policy for the hosted connector.
 *
 * The hosted server is meant to work with any MCP client that speaks OAuth, on any plan.
 * By default it accepts the exact callbacks below, plus loopback redirects (RFC 8252 section 7.3)
 * used by command-line and desktop clients. Operators can add more with OAUTH_REDIRECT_URIS,
 * or accept any safe redirect with OAUTH_ALLOW_ANY_REDIRECT=1 (the consent screen is then
 * mandatory for redirects that are not on a list).
 */
/** Exact redirect URIs of known MCP clients. Menu paths and URLs are vendor-controlled and may change. */
export const KNOWN_CLIENT_REDIRECTS = Object.freeze([
    // Claude (claude.ai web, Desktop and mobile), custom connectors on any plan.
    { uri: "https://claude.ai/api/mcp/auth_callback", client: "Claude" },
    // Claude, on the claude.com domain.
    { uri: "https://claude.com/api/mcp/auth_callback", client: "Claude" },
    // ChatGPT connectors and apps (developer mode MCP servers).
    { uri: "https://chatgpt.com/connector_platform_oauth_redirect", client: "ChatGPT" },
    // VS Code (desktop and vscode.dev) remote MCP servers, through the vscode.dev redirector.
    { uri: "https://vscode.dev/redirect", client: "VS Code" },
    // VS Code Insiders, through the insiders.vscode.dev redirector.
    { uri: "https://insiders.vscode.dev/redirect", client: "VS Code Insiders" },
    // Cursor remote MCP servers, through its registered private-use URI scheme.
    { uri: "cursor://anysphere.cursor-mcp/oauth/callback", client: "Cursor" }
    // TODO: Windsurf. Its native remote-MCP OAuth callback scheme is not published; when it is
    // known, add it here. Until then Windsurf works through loopback (for example mcp-remote)
    // or a personal access token.
]);
/** The exact URIs from KNOWN_CLIENT_REDIRECTS. */
export const KNOWN_REDIRECT_URIS = Object.freeze(KNOWN_CLIENT_REDIRECTS.map((entry) => entry.uri));
/** Loopback redirect per RFC 8252 section 7.3: http, a loopback host, any port and path. Claude Code, Codex, Gemini CLI and desktop apps. */
export function isLoopbackRedirect(uri) {
    let url;
    try {
        url = new URL(uri);
    }
    catch {
        return false;
    }
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && !url.username && !url.password && !url.hash;
}
/**
 * Schemes a private-use redirect may never use: web schemes and their lookalikes, and schemes
 * that run code or read local data in a browser.
 */
const FORBIDDEN_SCHEMES = new Set([
    "http", "https", "ws", "wss", "ftp", "javascript", "vbscript", "data", "file", "blob", "about",
    "filesystem", "view-source", "mailto", "tel", "sms", "intent", "chrome", "chrome-extension",
    "moz-extension", "ms-browser-extension", "resource", "jar"
]);
/**
 * A private-use (custom scheme) redirect such as cursor://host/path or com.example.app:/cb.
 * The scheme must not be a web scheme or look like one (httpx, https.evil, ...), and the URI
 * must carry no credentials or fragment.
 */
export function isSafePrivateUseRedirect(uri) {
    if (uri.length > 2000 || /[\s\u0000-\u001f\u007f\\]/.test(uri))
        return false;
    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(uri)?.[1]?.toLowerCase();
    if (!scheme)
        return false;
    if (FORBIDDEN_SCHEMES.has(scheme))
        return false;
    if (/^(https?|wss?|hxxps?)/.test(scheme) || scheme.includes("script"))
        return false;
    let url;
    try {
        url = new URL(uri);
    }
    catch {
        return false;
    }
    return !url.username && !url.password && !url.hash;
}
/** An https redirect with a host and no credentials or fragment. */
export function isSafeHttpsRedirect(uri) {
    let url;
    try {
        url = new URL(uri);
    }
    catch {
        return false;
    }
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password && !url.hash;
}
export class RedirectPolicy {
    exact;
    allowLoopback;
    allowAny;
    constructor(options = {}) {
        this.exact = options.exact ?? KNOWN_REDIRECT_URIS;
        this.allowLoopback = options.allowLoopback ?? true;
        this.allowAny = options.allowAny ?? false;
    }
    classify(uri) {
        if (this.exact.includes(uri))
            return "listed";
        if (this.allowLoopback && isLoopbackRedirect(uri))
            return "loopback";
        if (this.allowAny && (isSafeHttpsRedirect(uri) || isSafePrivateUseRedirect(uri)))
            return "open";
        return null;
    }
    allowed(uri) {
        return this.classify(uri) !== null;
    }
}
/** Build the exact list from OAUTH_REDIRECT_URIS: additive to the built-ins unless replace is set. */
export function redirectListFromEnv(configured, replace) {
    if (replace)
        return configured ?? [];
    return [...new Set([...KNOWN_REDIRECT_URIS, ...(configured ?? [])])];
}
/** A short label for a redirect target: the host for web URIs, scheme://host for custom schemes. */
export function redirectDisplayHost(uri) {
    try {
        const url = new URL(uri);
        if (url.protocol === "http:" || url.protocol === "https:")
            return url.host;
        return `${url.protocol}//${url.host || url.pathname.split("/")[0]}`;
    }
    catch {
        return uri;
    }
}
//# sourceMappingURL=known-clients.js.map