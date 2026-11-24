/** Minimal server-rendered pages for sign-in, consent and personal tokens. No external assets. */
export function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
const STYLE = `
:root{color-scheme:light dark;--bg:#f7f7f5;--card:#fff;--text:#1d1d1b;--muted:#5f5f5a;--line:#e2e2dc;--accent:#1f5f46;--accent-text:#fff;--warn-bg:#fff4d6;--warn-line:#e0b84a;--danger:#a3261b;--ok-bg:#e3f2ea;--ok-text:#1f5f46;--off-bg:#ecece8;--bad-bg:#fbe4e1;--track:#ecece8}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#161615;--card:#20201e;--text:#ececea;--muted:#a6a6a0;--line:#34342f;--accent:#5bb38c;--accent-text:#0d1f17;--warn-bg:#3a3017;--warn-line:#8a6d1f;--danger:#ef8a80;--ok-bg:#1d3a2c;--ok-text:#8fd6b1;--off-bg:#2c2c29;--bad-bg:#43211d;--track:#34342f}}
:root[data-theme=light]{color-scheme:light}
:root[data-theme=dark]{color-scheme:dark;--bg:#161615;--card:#20201e;--text:#ececea;--muted:#a6a6a0;--line:#34342f;--accent:#5bb38c;--accent-text:#0d1f17;--warn-bg:#3a3017;--warn-line:#8a6d1f;--danger:#ef8a80;--ok-bg:#1d3a2c;--ok-text:#8fd6b1;--off-bg:#2c2c29;--bad-bg:#43211d;--track:#34342f}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:40rem;margin:3rem auto;padding:0 1rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:1.5rem}
h1{font-size:1.3rem;margin:0 0 1rem}
h2{font-size:1.05rem;margin:1.5rem 0 .5rem}
p{margin:.5rem 0}
.muted{color:var(--muted);font-size:.9rem}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.35rem 1rem;margin:1rem 0}
dt{color:var(--muted)}
dd{margin:0;overflow-wrap:anywhere}
code{font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.target{font-size:1.15rem;font-weight:600;overflow-wrap:anywhere}
.warn{background:var(--warn-bg);border:1px solid var(--warn-line);border-radius:8px;padding:.75rem 1rem;margin:1rem 0}
.actions{display:flex;gap:.75rem;margin-top:1.25rem;flex-wrap:wrap}
button{font:inherit;border-radius:8px;padding:.55rem 1.1rem;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}
button.danger{color:var(--danger)}
table{width:100%;border-collapse:collapse;margin:.5rem 0;font-size:.9rem}
th,td{text-align:left;padding:.4rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500}
input,select{font:inherit;padding:.4rem .5rem;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text)}
label{display:block;margin:.5rem 0 .25rem}
.secret{display:block;padding:.75rem;border:1px dashed var(--accent);border-radius:8px;margin:.5rem 0;user-select:all}
form.inline{display:inline;margin:0}
a.button{display:inline-block;font:inherit;border-radius:8px;padding:.55rem 1.1rem;border:1px solid var(--line);background:var(--card);color:var(--text);text-decoration:none}
a.button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}
button:disabled{opacity:.6;cursor:progress}
.pill{display:inline-block;font-size:.75rem;font-weight:600;line-height:1;padding:.3rem .55rem;border-radius:999px;vertical-align:.1em;white-space:nowrap;background:var(--off-bg);color:var(--muted)}
.pill.ok{background:var(--ok-bg);color:var(--ok-text)}
.pill.warn{background:var(--warn-bg);color:var(--text);box-shadow:inset 0 0 0 1px var(--warn-line)}
.pill.bad{background:var(--bad-bg);color:var(--danger)}
.bar{height:8px;border-radius:999px;background:var(--track);overflow:hidden;margin:.5rem 0}
.bar span{display:block;height:100%;background:var(--accent);border-radius:inherit;transition:width .4s ease}
.summary{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin:1rem 0;padding:1rem;border:1px solid var(--line);border-radius:8px}
.summary>div:first-child{flex:1 1 12rem}
.summary-count{font-weight:600}
ul.stores,ul.steps{list-style:none;margin:1rem 0;padding:0}
li.store{display:flex;justify-content:space-between;align-items:center;gap:.75rem;flex-wrap:wrap;padding:.75rem 0;border-bottom:1px solid var(--line)}
li.store:last-child{border-bottom:0}
.store-main{flex:1 1 14rem;min-width:0}
.store-name{font-weight:600;margin-bottom:.1rem}
.store-actions{display:flex;gap:.5rem;flex-wrap:wrap}
li.step{display:flex;align-items:center;gap:.6rem;padding:.35rem 0}
li.step .step-name{flex:1;overflow-wrap:anywhere}
li.step .dot{width:.7rem;height:.7rem;border-radius:50%;background:var(--track);flex:none}
li.step.ok .dot{background:var(--accent)}
li.step.bad .dot{background:var(--danger)}
li.step.now .dot{background:var(--accent);animation:pulse 1s ease-in-out infinite}
li.step.now .step-name{font-weight:600}
.spinner{display:inline-block;width:1rem;height:1rem;margin-right:.6rem;border:2px solid var(--track);border-top-color:var(--accent);border-radius:50%;vertical-align:-.1em;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes pulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.spinner,li.step.now .dot{animation:none}}
details{margin:.75rem 0}
nav.theme{display:flex;gap:.25rem;align-items:center;flex-wrap:wrap;margin-top:1rem;font-size:.85rem;color:var(--muted)}
nav.theme a{color:var(--muted);text-decoration:none;padding:.2rem .55rem;border-radius:999px;border:1px solid transparent}
nav.theme a[aria-current]{color:var(--text);border-color:var(--line);background:var(--bg)}
summary{cursor:pointer}
@media (max-width:480px){main{margin:1rem auto}.card{padding:1.1rem}.summary .primary{width:100%}.summary>div:last-child{flex:1 1 100%}}
`;
export const THEME_COOKIE = "__Host-sms_theme";
/** The theme the viewer picked on an earlier visit, from its cookie. */
export function themeFrom(request) {
    const value = readCookie(request, THEME_COOKIE);
    return value === "light" || value === "dark" ? value : "system";
}
/** Light, Dark and System links. The pages run no scripts, so each link sets a cookie on the server. */
export function themeSwitch(current, path) {
    const links = ["system", "light", "dark"].map((theme) => `<a href="${escapeHtml(path)}?theme=${theme}"${theme === current ? ' aria-current="true"' : ""}>${theme[0].toUpperCase()}${theme.slice(1)}</a>`);
    return `<nav class="theme" aria-label="Theme">Theme: ${links.join("")}</nav>`;
}
/** An HTML page that cannot be framed, cached, or load anything from elsewhere. */
export function htmlPage({ title, body, status = 200, headers = {}, formAction = "'self'", head = "", theme = "system" }) {
    const html = `<!doctype html><html lang="en"${theme === "system" ? "" : ` data-theme="${theme}"`}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">${head}<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
    return new Response(html, {
        status,
        headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            pragma: "no-cache",
            "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action ${formAction}`,
            "x-frame-options": "DENY",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            ...headers
        }
    });
}
/** Parse a Cookie header. */
export function readCookie(request, name) {
    const header = request.headers.get("cookie");
    if (!header)
        return undefined;
    for (const part of header.split(";")) {
        const eq = part.indexOf("=");
        if (eq < 0)
            continue;
        if (part.slice(0, eq).trim() === name)
            return part.slice(eq + 1).trim();
    }
    return undefined;
}
/** A host-only, HttpOnly, Secure, SameSite=Lax cookie. */
export function cookie(name, value, maxAgeSeconds) {
    return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}
/**
 * Same-origin check for form posts.
 *
 * Pages here send Referrer-Policy: no-referrer, so Chromium sends `Origin: null` even on a
 * same-origin form post. Sec-Fetch-Site is not affected by referrer policy, so it decides when
 * present: only same-origin (or a user-typed "none") passes, and a real Origin must still match.
 * Without Sec-Fetch-Site, a missing Origin is accepted because the CSRF token and cookie binding
 * still apply, and an opaque "null" Origin is refused.
 */
export function sameOrigin(request, origin) {
    const value = request.headers.get("origin");
    const site = request.headers.get("sec-fetch-site");
    if (site !== null) {
        if (site !== "same-origin" && site !== "none")
            return false;
        return value === null || value === "null" || value === origin;
    }
    return value === null || value === origin;
}
/** The CSP form-action source that lets a form post end in a redirect to this URI. */
export function formActionSource(uri) {
    try {
        const url = new URL(uri);
        if (url.protocol === "http:" || url.protocol === "https:")
            return `${url.protocol}//${url.host}`;
        return url.protocol;
    }
    catch {
        return "'none'";
    }
}
/** Include the www/apex sibling for HTTP(S) callback redirect chains. */
export function formActionSources(uri) {
    const source = formActionSource(uri);
    try {
        const url = new URL(uri);
        const hostname = url.hostname.replace(/\.$/, "");
        if ((url.protocol !== "http:" && url.protocol !== "https:") ||
            hostname === "localhost" || hostname.endsWith(".localhost") ||
            /^[\d.]+$/.test(hostname) ||
            !/^[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)*$/i.test(hostname))
            return source;
        url.hostname = url.hostname.startsWith("www.") ? url.hostname.slice(4) : `www.${url.hostname}`;
        return `${source} ${url.protocol}//${url.host}`;
    }
    catch {
        return source;
    }
}
//# sourceMappingURL=html.js.map