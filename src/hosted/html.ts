/** Minimal server-rendered pages for sign-in, consent and personal tokens. No external assets. */

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f7f7f5;--card:#fff;--text:#1d1d1b;--muted:#5f5f5a;--line:#e2e2dc;--accent:#1f5f46;--accent-text:#fff;--warn-bg:#fff4d6;--warn-line:#e0b84a;--danger:#a3261b}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#20201e;--text:#ececea;--muted:#a6a6a0;--line:#34342f;--accent:#5bb38c;--accent-text:#0d1f17;--warn-bg:#3a3017;--warn-line:#8a6d1f;--danger:#ef8a80}}
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
`;

export interface PageOptions {
  title: string;
  body: string;
  status?: number;
  headers?: Record<string, string>;
  /** CSP form-action sources. Defaults to 'self'. */
  formAction?: string;
}

/** An HTML page that cannot be framed, cached, or load anything from elsewhere. */
export function htmlPage({ title, body, status = 200, headers = {}, formAction = "'self'" }: PageOptions): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
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
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** A host-only, HttpOnly, Secure, SameSite=Lax cookie. */
export function cookie(name: string, value: string, maxAgeSeconds: number): string {
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
export function sameOrigin(request: Request, origin: string): boolean {
  const value = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) {
    if (site !== "same-origin" && site !== "none") return false;
    return value === null || value === "null" || value === origin;
  }
  return value === null || value === origin;
}

/** The CSP form-action source that lets a form post end in a redirect to this URI. */
export function formActionSource(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.protocol === "http:" || url.protocol === "https:") return `${url.protocol}//${url.host}`;
    return url.protocol;
  } catch {
    return "'none'";
  }
}
