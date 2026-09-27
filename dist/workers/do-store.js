import { matches } from "../hosted/store.js";
const KINDS = new Set(["client", "pending", "code", "access", "refresh", "consent", "approval", "session", "shopify_state", "shopify_token", "revoked_family"]);
/** How often the object sweeps expired records. */
const SWEEP_MS = 6 * 3600_000;
function storageKey(kind, key) {
    return `${kind}\u0000${key}`;
}
function json(body, status = 200) {
    return new Response(JSON.stringify(body ?? null), { status, headers: { "content-type": "application/json" } });
}
/**
 * The Durable Object class (wrangler.jsonc binds it as OAUTH_STORE). It speaks a small JSON
 * protocol over fetch, so it needs no Workers-only import and can be tested in Node with an
 * in-memory storage.
 */
export class OAuthStoreObject {
    storage;
    now;
    constructor(state, _env, now = Date.now) {
        this.storage = state.storage;
        this.now = now;
    }
    async live(kind, key) {
        const entry = await this.storage.get(storageKey(kind, key));
        if (!entry)
            return undefined;
        if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
            await this.storage.delete(storageKey(kind, key));
            return undefined;
        }
        return entry;
    }
    async all(kind) {
        const prefix = storageKey(kind, "");
        const listed = await this.storage.list({ prefix });
        const now = this.now();
        const out = [];
        const expired = [];
        for (const [key, entry] of listed) {
            if (entry.expiresAt !== undefined && entry.expiresAt <= now)
                expired.push(key);
            else
                out.push([key.slice(prefix.length), entry]);
        }
        if (expired.length)
            await this.deleteKeys(expired);
        return out;
    }
    async deleteKeys(keys) {
        // storage.delete takes at most 128 keys per call.
        for (let i = 0; i < keys.length; i += 128)
            await this.storage.delete(keys.slice(i, i + 128));
    }
    /** Run one store operation. Exposed for tests; fetch() is the Durable Object entry point. */
    async run(operation) {
        if (!operation || typeof operation !== "object" || !KINDS.has(operation.kind))
            throw new Error("Unknown record kind.");
        const { kind } = operation;
        switch (operation.op) {
            case "get":
                return (await this.live(kind, operation.key))?.value;
            case "put":
                await this.storage.put(storageKey(kind, operation.key), { value: operation.value, ...(operation.expiresAt !== undefined ? { expiresAt: operation.expiresAt } : {}) });
                await this.scheduleSweep();
                return null;
            case "take": {
                const entry = await this.live(kind, operation.key);
                if (!entry)
                    return undefined;
                await this.storage.delete(storageKey(kind, operation.key));
                return entry.value;
            }
            case "delete":
                await this.storage.delete(storageKey(kind, operation.key));
                return null;
            case "claim": {
                const entry = await this.live(kind, operation.key);
                if (!entry)
                    return undefined;
                const value = entry.value;
                if (value[operation.flag] === true)
                    return { value, claimed: false };
                const next = { ...value, [operation.flag]: true };
                await this.storage.put(storageKey(kind, operation.key), { value: next, ...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {}) });
                return { value: next, claimed: true };
            }
            case "deleteMatching": {
                const doomed = (await this.all(kind)).filter(([, entry]) => matches(entry.value, operation.match)).map(([key]) => storageKey(kind, key));
                await this.deleteKeys(doomed);
                return doomed.length;
            }
            case "count":
                return (await this.all(kind)).length;
            case "entries":
                return (await this.all(kind)).map(([key, entry]) => [key, entry.value]);
            default:
                throw new Error("Unknown operation.");
        }
    }
    async fetch(request) {
        if (request.method !== "POST")
            return json({ error: "method_not_allowed" }, 405);
        try {
            const result = await this.run(await request.json());
            return json({ result: result === undefined ? null : result, found: result !== undefined });
        }
        catch (error) {
            return json({ error: error instanceof Error ? error.message : String(error) }, 400);
        }
    }
    async scheduleSweep() {
        if (!this.storage.getAlarm || !this.storage.setAlarm)
            return;
        if ((await this.storage.getAlarm()) === null)
            await this.storage.setAlarm(this.now() + SWEEP_MS);
    }
    /** Durable Object alarm: drop expired records of every kind, then schedule the next sweep. */
    async alarm() {
        for (const kind of KINDS)
            await this.all(kind);
        if (this.storage.setAlarm)
            await this.storage.setAlarm(this.now() + SWEEP_MS);
    }
}
/** OAuthStore backed by the OAuthStoreObject Durable Object. */
export class DurableObjectStore {
    namespace;
    name;
    constructor(namespace, name = "oauth") {
        this.namespace = namespace;
        this.name = name;
    }
    async call(operation) {
        // A stub is an I/O object tied to the request that made it, and the hosted app outlives
        // requests, so each operation gets its own stub (cheap: the id is derived from the name).
        const stub = this.namespace.get(this.namespace.idFromName(this.name));
        const response = await stub.fetch("https://oauth-store.internal/", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(operation)
        });
        const body = await response.json();
        if (!response.ok || body.error)
            throw new Error(`OAuth store: ${body.error ?? `HTTP ${response.status}`}`);
        return body.found ? body.result : undefined;
    }
    get(kind, key) {
        return this.call({ op: "get", kind, key });
    }
    async put(kind, key, value, expiresAt) {
        await this.call({ op: "put", kind, key, value, ...(expiresAt !== undefined ? { expiresAt } : {}) });
    }
    take(kind, key) {
        return this.call({ op: "take", kind, key });
    }
    async delete(kind, key) {
        await this.call({ op: "delete", kind, key });
    }
    claim(kind, key, flag) {
        return this.call({ op: "claim", kind, key, flag });
    }
    async deleteMatching(kind, match) {
        return (await this.call({ op: "deleteMatching", kind, match })) ?? 0;
    }
    async count(kind) {
        return (await this.call({ op: "count", kind })) ?? 0;
    }
    async entries(kind) {
        return (await this.call({ op: "entries", kind })) ?? [];
    }
}
//# sourceMappingURL=do-store.js.map