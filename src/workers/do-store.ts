import type { OAuthStore, RecordKind } from "../hosted/store.js";
import { matches } from "../hosted/store.js";
import type { DurableObjectNamespaceLike, DurableObjectStateLike, DurableObjectStorageLike } from "./types.js";

/**
 * The hosted OAuth store on Cloudflare: one Durable Object instance ("oauth") holds every
 * record. A Durable Object runs one request at a time per instance, and its storage calls do
 * not let other requests interleave (input gates), so each operation below (take, claim,
 * deleteMatching) is atomic and strongly consistent for every Worker isolate. That is what
 * single-use authorization codes and login states, refresh token rotation, and reuse
 * detection need. Workers KV is eventually consistent and would let a code or refresh token
 * be used twice, so it is not used.
 */

interface Entry {
  value: unknown;
  expiresAt?: number;
}

type Operation =
  | { op: "get" | "take" | "delete"; kind: RecordKind; key: string }
  | { op: "put"; kind: RecordKind; key: string; value: unknown; expiresAt?: number }
  | { op: "claim"; kind: RecordKind; key: string; flag: string }
  | { op: "deleteMatching"; kind: RecordKind; match: Record<string, string | number | boolean> }
  | { op: "count" | "entries"; kind: RecordKind };

const KINDS: ReadonlySet<string> = new Set<RecordKind>(["client", "pending", "code", "access", "refresh", "consent", "approval", "session", "shopify_state", "shopify_token", "revoked_family"]);
/** How often the object sweeps expired records. */
const SWEEP_MS = 6 * 3600_000;

function storageKey(kind: RecordKind, key: string): string {
  return `${kind}\u0000${key}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body ?? null), { status, headers: { "content-type": "application/json" } });
}

/**
 * The Durable Object class (wrangler.jsonc binds it as OAUTH_STORE). It speaks a small JSON
 * protocol over fetch, so it needs no Workers-only import and can be tested in Node with an
 * in-memory storage.
 */
export class OAuthStoreObject {
  private readonly storage: DurableObjectStorageLike;
  private readonly now: () => number;

  constructor(state: DurableObjectStateLike, _env?: unknown, now: () => number = Date.now) {
    this.storage = state.storage;
    this.now = now;
  }

  private async live(kind: RecordKind, key: string): Promise<Entry | undefined> {
    const entry = await this.storage.get<Entry>(storageKey(kind, key));
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      await this.storage.delete(storageKey(kind, key));
      return undefined;
    }
    return entry;
  }

  private async all(kind: RecordKind): Promise<Array<[string, Entry]>> {
    const prefix = storageKey(kind, "");
    const listed = await this.storage.list<Entry>({ prefix });
    const now = this.now();
    const out: Array<[string, Entry]> = [];
    const expired: string[] = [];
    for (const [key, entry] of listed) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) expired.push(key);
      else out.push([key.slice(prefix.length), entry]);
    }
    if (expired.length) await this.deleteKeys(expired);
    return out;
  }

  private async deleteKeys(keys: string[]): Promise<void> {
    // storage.delete takes at most 128 keys per call.
    for (let i = 0; i < keys.length; i += 128) await this.storage.delete(keys.slice(i, i + 128));
  }

  /** Run one store operation. Exposed for tests; fetch() is the Durable Object entry point. */
  async run(operation: Operation): Promise<unknown> {
    if (!operation || typeof operation !== "object" || !KINDS.has(operation.kind)) throw new Error("Unknown record kind.");
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
        if (!entry) return undefined;
        await this.storage.delete(storageKey(kind, operation.key));
        return entry.value;
      }
      case "delete":
        await this.storage.delete(storageKey(kind, operation.key));
        return null;
      case "claim": {
        const entry = await this.live(kind, operation.key);
        if (!entry) return undefined;
        const value = entry.value as Record<string, unknown>;
        if (value[operation.flag] === true) return { value, claimed: false };
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

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    try {
      const result = await this.run(await request.json() as Operation);
      return json({ result: result === undefined ? null : result, found: result !== undefined });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  private async scheduleSweep(): Promise<void> {
    if (!this.storage.getAlarm || !this.storage.setAlarm) return;
    if ((await this.storage.getAlarm()) === null) await this.storage.setAlarm(this.now() + SWEEP_MS);
  }

  /** Durable Object alarm: drop expired records of every kind, then schedule the next sweep. */
  async alarm(): Promise<void> {
    for (const kind of KINDS) await this.all(kind as RecordKind);
    if (this.storage.setAlarm) await this.storage.setAlarm(this.now() + SWEEP_MS);
  }
}

/** OAuthStore backed by the OAuthStoreObject Durable Object. */
export class DurableObjectStore implements OAuthStore {
  constructor(private readonly namespace: DurableObjectNamespaceLike, private readonly name = "oauth") {}

  private async call<T>(operation: Operation): Promise<T | undefined> {
    // A stub is an I/O object tied to the request that made it, and the hosted app outlives
    // requests, so each operation gets its own stub (cheap: the id is derived from the name).
    const stub = this.namespace.get(this.namespace.idFromName(this.name));
    const response = await stub.fetch("https://oauth-store.internal/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(operation)
    });
    const body = await response.json() as { result?: T; found?: boolean; error?: string };
    if (!response.ok || body.error) throw new Error(`OAuth store: ${body.error ?? `HTTP ${response.status}`}`);
    return body.found ? body.result : undefined;
  }

  get<T>(kind: RecordKind, key: string): Promise<T | undefined> {
    return this.call<T>({ op: "get", kind, key });
  }

  async put<T>(kind: RecordKind, key: string, value: T, expiresAt?: number): Promise<void> {
    await this.call({ op: "put", kind, key, value, ...(expiresAt !== undefined ? { expiresAt } : {}) });
  }

  take<T>(kind: RecordKind, key: string): Promise<T | undefined> {
    return this.call<T>({ op: "take", kind, key });
  }

  async delete(kind: RecordKind, key: string): Promise<void> {
    await this.call({ op: "delete", kind, key });
  }

  claim<T>(kind: RecordKind, key: string, flag: string): Promise<{ value: T; claimed: boolean } | undefined> {
    return this.call<{ value: T; claimed: boolean }>({ op: "claim", kind, key, flag });
  }

  async deleteMatching(kind: RecordKind, match: Record<string, string | number | boolean>): Promise<number> {
    return (await this.call<number>({ op: "deleteMatching", kind, match })) ?? 0;
  }

  async count(kind: RecordKind): Promise<number> {
    return (await this.call<number>({ op: "count", kind })) ?? 0;
  }

  async entries<T>(kind: RecordKind): Promise<Array<[string, T]>> {
    return (await this.call<Array<[string, T]>>({ op: "entries", kind })) ?? [];
  }
}
