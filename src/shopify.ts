import { createHash } from "node:crypto";
import { serializeStore } from "./concurrency.js";
import { operation, mutationErrors } from "./operations.js";
import { createAdminApiClient } from "@shopify/admin-api-client";
import { readFileSync } from "node:fs";
import type { StoreConfig } from "./config.js";
import { getAccessToken, graphqlEndpoint } from "./config.js";

const CHARACTER_LIMIT = 50_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_THROTTLE_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 60_000;
export const PACKAGE_VERSION = String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "unknown");

export interface GraphqlEnvelope {
  store: string;
  shop: string;
  apiVersion: string;
  requestId?: string;
  elapsedMs: number;
  retryCount: number;
  data?: unknown;
  errors?: unknown;
  extensions?: unknown;
  userErrors?: unknown[];
}

export function retryDelay(response: Response | undefined, attempt: number, payload?: unknown): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(seconds * 1_000, 0);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay)) return Math.max(dateDelay, 0);
  }
  const cost = (payload as { extensions?: { cost?: { requestedQueryCost?: number; throttleStatus?: { currentlyAvailable?: number; restoreRate?: number } } } })?.extensions?.cost;
  const requested = cost?.requestedQueryCost;
  const available = cost?.throttleStatus?.currentlyAvailable;
  const restoreRate = cost?.throttleStatus?.restoreRate;
  if (typeof requested === "number" && typeof available === "number" && typeof restoreRate === "number" && restoreRate > 0) {
    return Math.max(250, Math.ceil((requested - available) / restoreRate * 1000) + 50);
  }
  return 250 * 2 ** attempt;
}

function hasThrottleError(payload: unknown): boolean {
  const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  if (!Array.isArray(body.errors)) return false;
  return body.errors.some((error) => {
    if (!error || typeof error !== "object") return false;
    const extensions = (error as Record<string, unknown>).extensions;
    return Boolean(extensions && typeof extensions === "object" && (extensions as Record<string, unknown>).code === "THROTTLED");
  });
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function graphqlRequest(store: StoreConfig, document: string, variables: Record<string, unknown>, token: string): Promise<{ response: Response; payload: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  let responseText: string;
  try {
    const client = createAdminApiClient({
      storeDomain: store.shop,
      apiVersion: store.apiVersion,
      accessToken: token,
      retries: 0,
      // Keep the existing endpoint override for local tests and the abort signal for body reads.
      customFetchApi: (_url, init) => fetch(graphqlEndpoint(store), {
        ...init, redirect: "error", signal: controller.signal,
        headers: { ...init?.headers, "User-Agent": `shopify-multi-store-mcp-server/${PACKAGE_VERSION}` }
      })
    });
    response = await client.fetch(document, { variables, retries: 0 });
    responseText = await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Shopify did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds for ${store.alias}.`);
    }
    throw new Error(`Shopify request failed for ${store.alias}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }

  const requestId = response.headers.get("x-request-id");
  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error(`Shopify returned a non-JSON response for ${store.alias}. HTTP ${response.status}. Request ID: ${requestId ?? "not provided"}`);
  }

  return { response, payload };
}

export async function adminGraphql(store: StoreConfig, document: string, variables: Record<string, unknown>): Promise<GraphqlEnvelope> {
  const token = await getAccessToken(store);
  const key = `${store.shop}\0${createHash("sha256").update(token).digest("hex")}`;
  return serializeStore(key, () => adminGraphqlWithToken(store, document, variables, token));
}

async function adminGraphqlWithToken(store: StoreConfig, document: string, variables: Record<string, unknown>, token: string): Promise<GraphqlEnvelope> {
  const startedAt = Date.now();
  let response: Response | undefined;
  let payload: unknown;
  let attempt = 0;

  for (; attempt <= MAX_THROTTLE_RETRIES; attempt += 1) {
    ({ response, payload } = await graphqlRequest(store, document, variables, token));
    const throttled = response.status === 429 || hasThrottleError(payload);
    // A mutation with partial data might already have applied changes. Never replay it.
    if (operation(document).selected.operation === "mutation" && payload && typeof payload === "object" && "data" in payload && payload.data != null) break;
    if (!throttled || attempt === MAX_THROTTLE_RETRIES) break;
    const delay = retryDelay(response, attempt, payload);
    if (delay > MAX_RETRY_DELAY_MS) {
      throw new Error(`Shopify asked ${store.alias} to retry after ${Math.ceil(delay / 1_000)} seconds, which exceeds the ${MAX_RETRY_DELAY_MS / 1_000}-second retry limit. Try again later.`);
    }
    await wait(delay);
  }

  if (!response) throw new Error(`Shopify returned no response for ${store.alias}.`);
  const requestId = response.headers.get("x-request-id");

  if (!response.ok) {
    const details = JSON.stringify(payload).slice(0, 2_000);
    throw new Error(`Shopify returned HTTP ${response.status} for ${store.alias}. Request ID: ${requestId ?? "not provided"}. Response: ${details}`);
  }

  if (hasThrottleError(payload) && !(operation(document).selected.operation === "mutation" && payload && typeof payload === "object" && "data" in payload && payload.data != null)) {
    const details = JSON.stringify(payload).slice(0, 2_000);
    throw new Error(`Shopify throttled ${store.alias} after ${MAX_THROTTLE_RETRIES + 1} attempts. Request ID: ${requestId ?? "not provided"}. Response: ${details}`);
  }

  const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const envelope: GraphqlEnvelope = {
    store: store.alias,
    shop: store.shop,
    apiVersion: store.apiVersion,
    ...(requestId ? { requestId } : {}),
    elapsedMs: Date.now() - startedAt,
    retryCount: Math.min(attempt, MAX_THROTTLE_RETRIES),
    ...(body.data !== undefined ? { data: body.data } : {}),
    ...(body.errors !== undefined ? { errors: body.errors } : {}),
    ...(body.extensions !== undefined ? { extensions: body.extensions } : {})
  };

  const userErrors = mutationErrors(document, body.data);
  if (userErrors.length) envelope.userErrors = userErrors;
  const serialized = JSON.stringify(envelope);
  if (serialized.length > CHARACTER_LIMIT) {
    throw new Error(`Shopify returned more than ${CHARACTER_LIMIT} characters for ${store.alias}. Add pagination or request fewer fields.`);
  }
  return envelope;
}

export function requireQuery(document: string): void { operation(document, "query"); }
export function requireMutation(document: string): void { operation(document, "mutation"); }

/** Keep partial data available while marking GraphQL failures for MCP callers. */
export function hasGraphqlErrors(result: GraphqlEnvelope): boolean {
  return (Array.isArray(result.errors) && result.errors.length > 0) || Boolean(result.userErrors?.length);
}
