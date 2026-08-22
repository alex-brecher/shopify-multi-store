import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export const configPath = process.env.SHOPIFY_MULTI_STORE_CONFIG
  ? resolve(process.env.SHOPIFY_MULTI_STORE_CONFIG)
  : resolve(homedir(), ".config", "codex-shopify-multi-store", "stores.json");

export function loadConfig() {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (!parsed || !Array.isArray(parsed.stores)) throw new Error("The store configuration is invalid.");
    return parsed;
  } catch (error) {
    if (error && error.code === "ENOENT") return { stores: [] };
    throw error;
  }
}

export function saveConfig(config) {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(configPath, 0o600);
}

export function upsertStore(store) {
  const config = loadConfig();
  const index = config.stores.findIndex((item) => item.alias === store.alias);
  if (index >= 0) config.stores[index] = store;
  else config.stores.push(store);
  saveConfig(config);
}

export async function collectHiddenInput(input) {
  let value = "";
  let submitted = false;
  outer: for await (const chunk of input) {
    for (const character of String(chunk)) {
      if (character === "\r" || character === "\n") {
        submitted = true;
        break outer;
      }
      if (character === "\u0003") throw new Error("Canceled.");
      if (character === "\u007f") value = value.slice(0, -1);
      else value += character;
    }
  }
  if (!submitted) throw new Error("Secret input ended before you pressed Enter. The secret was not saved.");
  return value;
}

export async function readHidden(prompt) {
  if (!process.stdin.isTTY) throw new Error("Run this command in an interactive terminal.");
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  try {
    return await collectHiddenInput(process.stdin);
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\n");
  }
}

export async function exchangeAuthorizationCode({ shop, clientId, clientSecret, code, timeoutMs = 30_000 }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Shopify token exchange did not respond within ${timeoutMs / 1_000} seconds.`);
    }
    throw new Error(`Shopify token exchange failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }

  const responseText = await response.text();
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error(`Shopify token exchange returned a non-JSON response. HTTP ${response.status}.`);
  }
  if (!response.ok || typeof payload?.access_token !== "string") {
    const message = typeof payload?.error_description === "string" ? payload.error_description : `HTTP ${response.status}`;
    throw new Error(`Shopify token exchange failed: ${message}`);
  }
  return payload.access_token;
}

export function validateAlias(alias) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(alias)) {
    throw new Error("Use a lowercase alias with letters, numbers, and hyphens.");
  }
}

export function normalizeShop(shop) {
  const normalized = shop.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(normalized)) {
    throw new Error("Use the permanent store domain, for example store-name.myshopify.com.");
  }
  return normalized;
}

export function validateApiVersion(apiVersion) {
  if (!/^\d{4}-\d{2}$/.test(apiVersion)) throw new Error("Use an API version in YYYY-MM format.");
}

export function aliasFor(label) {
  const alias = String(label).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!alias) throw new Error(`Cannot create an alias for label: ${label}`);
  validateAlias(alias);
  return alias;
}

export function parseLegacyStores(source) {
  if (!source || typeof source !== "object") throw new Error("The source file is invalid.");
  if (Array.isArray(source.stores)) {
    if (!source.stores.length) throw new Error("The source file has no stores.");
    return source.stores.map((item) => {
      const alias = aliasFor(item?.label ?? item?.alias);
      const shop = normalizeShop(String(item?.domain ?? item?.shop ?? ""));
      const token = String(item?.access_token ?? item?.accessToken ?? "").trim();
      if (!token) throw new Error(`Missing token for ${alias}.`);
      return { alias, shop, auth: { type: "access_token" }, credential: token };
    });
  }

  if (!source.stores || typeof source.stores !== "object") throw new Error("The source file has no stores.");
  const entries = Object.entries(source.stores);
  if (!entries.length) throw new Error("The source file has no stores.");
  const sharedApp = source.plus_app && typeof source.plus_app === "object" ? source.plus_app : {};
  const sharedClientId = String(sharedApp.client_id ?? sharedApp.clientId ?? "").trim();
  const sharedClientSecret = String(sharedApp.client_secret ?? sharedApp.clientSecret ?? "").trim();

  return entries.map(([label, value]) => {
    const alias = aliasFor(label);
    const details = value && typeof value === "object" ? value : {};
    const shop = normalizeShop(String(typeof value === "string" ? value : details.domain ?? details.shop ?? ""));
    const token = String(details.access_token ?? details.accessToken ?? "").trim();
    if (token) return { alias, shop, auth: { type: "access_token" }, credential: token };
    const clientId = String(details.client_id ?? details.clientId ?? sharedClientId).trim();
    const clientSecret = String(details.client_secret ?? details.clientSecret ?? sharedClientSecret).trim();
    if (!clientId || !clientSecret) {
      throw new Error(`Missing access token or client credentials for ${alias}.`);
    }
    return { alias, shop, auth: { type: "client_credentials", clientId }, credential: clientSecret };
  });
}

export async function importStoresWithRollback({
  imported,
  config,
  apiVersion,
  accountFor,
  readCredential,
  storeCredential,
  removeCredential,
  saveConfigValue = saveConfig
}) {
  const changedCredentials = [];
  try {
    for (const item of imported) {
      const { alias, shop, auth, credential } = item;
      const account = accountFor(item);
      const previous = await readCredential(account);
      await storeCredential(account, credential);
      changedCredentials.push({ account, previous });
      const store = { alias, shop, apiVersion, auth };
      const index = config.stores.findIndex((candidate) => candidate.alias === alias);
      if (index >= 0) config.stores[index] = store;
      else config.stores.push(store);
    }
    saveConfigValue(config);
  } catch (error) {
    const rollbackErrors = [];
    for (const { account, previous } of changedCredentials.reverse()) {
      try {
        if (previous === null) await removeCredential(account);
        else await storeCredential(account, previous);
      } catch (rollbackError) {
        rollbackErrors.push(`${account}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    const rollbackDetails = rollbackErrors.length ? ` Credential rollback errors: ${rollbackErrors.join("; ")}` : "";
    throw new Error(`The import failed and stored credentials were rolled back. ${error instanceof Error ? error.message : String(error)}${rollbackDetails}`);
  }
}

export async function verifyAccessToken({ shop, apiVersion, token }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let response;
  try {
    response = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
        "User-Agent": "shopify-multi-store-setup"
      },
      body: JSON.stringify({ query: "query VerifyStoreAccess { shop { name myshopifyDomain } }", variables: {} }),
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error(`Shopify did not respond within 30 seconds for ${shop}.`);
    throw new Error(`Shopify connection failed for ${shop}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Shopify returned a non-JSON response for ${shop}. HTTP ${response.status}.`);
  }
  if (!response.ok || !payload?.data?.shop?.myshopifyDomain || payload.errors?.length) {
    const details = Array.isArray(payload?.errors) ? ` ${JSON.stringify(payload.errors).slice(0, 1_000)}` : "";
    throw new Error(`Shopify rejected the access token for ${shop}. HTTP ${response.status}.${details}`);
  }
  if (String(payload.data.shop.myshopifyDomain).toLowerCase() !== shop) {
    throw new Error(`The access token belongs to ${payload.data.shop.myshopifyDomain}, not ${shop}.`);
  }
  return { name: String(payload.data.shop.name ?? shop), myshopifyDomain: String(payload.data.shop.myshopifyDomain) };
}
