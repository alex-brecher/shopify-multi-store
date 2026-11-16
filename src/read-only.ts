import { Kind } from "graphql";
import { operation } from "./operations.js";
import { runtimeEnv, storeScope } from "./runtime.js";

/**
 * Read-only mode: block every Admin API write for the whole server, for chosen stores, or for
 * chosen people. Set with plain settings, never secrets, so the rules are visible in the
 * deployment config:
 *
 * - SHOPIFY_READ_ONLY=true            no writes for anyone, on any store
 * - SHOPIFY_READ_ONLY_STORES=a,b       no writes on stores a and b, for anyone
 * - SHOPIFY_READ_ONLY_USERS=x@y.com    no writes for that person (hosted server only)
 *   SHOPIFY_READ_ONLY_USERS=x@y.com:a  no writes for that person on store a only
 *
 * Enforced where every Shopify call is sent (adminGraphql), so no tool can get around it.
 */

/** Mutations that change nothing in the store: previews and read-only exports. */
export const READ_SAFE_MUTATIONS: ReadonlySet<string> = new Set(["draftOrderCalculate", "bulkOperationRunQuery"]);

type Env = Readonly<Record<string, string | undefined>>;

interface Rules {
  all: boolean;
  stores: Set<string>;
  /** email -> "*" (every store) or the store aliases that are read-only for them. */
  users: Map<string, "*" | Set<string>>;
}

function items(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function rules(env: Env = runtimeEnv()): Rules {
  const users = new Map<string, "*" | Set<string>>();
  for (const item of items(env.SHOPIFY_READ_ONLY_USERS)) {
    const at = item.lastIndexOf(":");
    const email = at > 0 ? item.slice(0, at) : item;
    const alias = at > 0 ? item.slice(at + 1) : "";
    const current = users.get(email);
    if (!alias || current === "*") users.set(email, "*");
    else users.set(email, new Set([...(current ?? []), alias]));
  }
  return { all: /^(1|true|yes|on)$/i.test((env.SHOPIFY_READ_ONLY ?? "").trim()), stores: new Set(items(env.SHOPIFY_READ_ONLY_STORES)), users };
}

/** The signed-in person on a hosted tool call, if any. */
function currentEmail(): string | undefined {
  return storeScope.getStore()?.user;
}

/** Whether writes to this store are blocked for this person (default: the caller of the current tool call). */
export function isReadOnly(alias: string, email: string | undefined = currentEmail(), env?: Env): boolean {
  const { all, stores, users } = rules(env);
  const store = alias.toLowerCase();
  if (all || stores.has(store)) return true;
  const user = email ? users.get(email.toLowerCase()) : undefined;
  return user === "*" || Boolean(user?.has(store));
}

/** Whether this person can write nowhere, so write tools can be left out of their tool list. */
export function readOnlyEverywhere(email: string | undefined = currentEmail(), env?: Env): boolean {
  const { all, users } = rules(env);
  return all || Boolean(email && users.get(email.toLowerCase()) === "*");
}

export class ReadOnlyError extends Error {
  override name = "ReadOnlyError";
}

/** Refuse a mutation on a read-only store before it reaches Shopify. Queries and read-safe mutations pass. */
export function assertWritable(alias: string, document: string): void {
  const { selected } = operation(document);
  if (selected.operation !== "mutation") return;
  const roots = selected.selectionSet.selections;
  const safe = roots.length > 0 && roots.every((node) => node.kind === Kind.FIELD && READ_SAFE_MUTATIONS.has(node.name.value));
  if (safe || !isReadOnly(alias)) return;
  throw new ReadOnlyError(`Read-only: changes to ${alias} are turned off for you on this server, so nothing was sent to Shopify. Ask the server operator if you need write access.`);
}
