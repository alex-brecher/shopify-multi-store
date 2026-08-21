#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const configPath = process.env.SHOPIFY_MULTI_STORE_CONFIG
  ? resolve(process.env.SHOPIFY_MULTI_STORE_CONFIG)
  : resolve(homedir(), ".config", "codex-shopify-multi-store", "stores.json");

function loadConfig() {
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return { stores: [] };
    throw error;
  }
}

function saveConfig(config) {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

async function readHidden(prompt) {
  if (!stdin.isTTY) throw new Error("Run this command in an interactive terminal.");
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  let value = "";
  try {
    for await (const character of stdin) {
      if (character === "\r" || character === "\n") break;
      if (character === "\u0003") throw new Error("Canceled.");
      if (character === "\u007f") value = value.slice(0, -1);
      else value += character;
    }
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    stdout.write("\n");
  }
  return value;
}

function validateAlias(alias) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(alias)) throw new Error("Use a lowercase alias with letters, numbers, and hyphens.");
}

function normalizeShop(shop) {
  const normalized = shop.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(normalized)) {
    throw new Error("Use the permanent store domain, for example store-name.myshopify.com.");
  }
  return normalized;
}

async function addStore(args) {
  const rl = createInterface({ input: stdin, output: stdout });
  const alias = (args[0] ?? await rl.question("Store alias: ")).trim().toLowerCase();
  const shop = normalizeShop(args[1] ?? await rl.question("Permanent *.myshopify.com domain: "));
  const apiVersion = (args[2] ?? "2026-07").trim();
  rl.close();
  validateAlias(alias);
  if (!/^\d{4}-\d{2}$/.test(apiVersion)) throw new Error("Use an API version in YYYY-MM format.");
  if (process.platform !== "darwin") throw new Error("This configuration command needs macOS Keychain.");

  const token = await readHidden("Shopify Admin API access token: ");
  if (!token) throw new Error("The access token cannot be empty.");
  execFileSync("security", ["add-generic-password", "-U", "-s", "codex-shopify-multi-store", "-a", alias, "-w", token], { stdio: "ignore" });

  const config = loadConfig();
  const store = { alias, shop, apiVersion };
  const index = config.stores.findIndex((item) => item.alias === alias);
  if (index >= 0) config.stores[index] = store;
  else config.stores.push(store);
  saveConfig(config);
  stdout.write(`Saved ${alias} (${shop}).\n`);
}

function listStores() {
  const config = loadConfig();
  if (!config.stores.length) {
    stdout.write("No stores are configured.\n");
    return;
  }
  for (const store of config.stores) stdout.write(`${store.alias}\t${store.shop}\t${store.apiVersion}\n`);
}

function removeStore(alias) {
  validateAlias(alias);
  const config = loadConfig();
  const next = config.stores.filter((item) => item.alias !== alias);
  if (next.length === config.stores.length) throw new Error(`Unknown store alias: ${alias}`);
  config.stores = next;
  saveConfig(config);
  if (process.platform === "darwin") {
    try {
      execFileSync("security", ["delete-generic-password", "-s", "codex-shopify-multi-store", "-a", alias], { stdio: "ignore" });
    } catch {
      // The config removal remains valid when the Keychain item does not exist.
    }
  }
  stdout.write(`Removed ${alias}.\n`);
}

const [command = "list", ...args] = process.argv.slice(2);
try {
  if (command === "add") await addStore(args);
  else if (command === "list") listStores();
  else if (command === "remove" && args[0]) removeStore(args[0]);
  else throw new Error("Use: npm run configure -- add [alias] [shop.myshopify.com] [api-version], list, or remove <alias>.");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
