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

export async function readHidden(prompt) {
  if (!process.stdin.isTTY) throw new Error("Run this command in an interactive terminal.");
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  let value = "";
  try {
    for await (const character of process.stdin) {
      if (character === "\r" || character === "\n") break;
      if (character === "\u0003") throw new Error("Canceled.");
      if (character === "\u007f") value = value.slice(0, -1);
      else value += character;
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\n");
  }
  return value;
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
