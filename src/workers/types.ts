/**
 * The few Cloudflare Workers runtime shapes this code uses, typed structurally so the project
 * needs no Workers type package and the same modules can run in Node tests with fakes.
 */

export interface DurableObjectStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string | string[]): Promise<boolean | number>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  getAlarm?(): Promise<number | null>;
  setAlarm?(time: number): Promise<void>;
}

export interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  run(): Promise<unknown>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  exec?(query: string): Promise<unknown>;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

/** The Worker's bindings and settings (wrangler.jsonc vars and `wrangler secret put` secrets). */
export interface WorkerEnv {
  OAUTH_STORE: DurableObjectNamespaceLike;
  AUDIT_DB?: D1DatabaseLike;
  [name: string]: unknown;
}
