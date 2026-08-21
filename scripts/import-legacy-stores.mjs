#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const sourcePath = process.argv[2];
if (!sourcePath) {
  process.stderr.write("Use: npm run import-legacy -- /absolute/path/to/stores.json\n");
  process.exit(1);
}
if (process.platform !== "darwin") {
  process.stderr.write("This import command needs macOS Keychain.\n");
  process.exit(1);
}

function aliasFor(label) {
  const normalizedLabel = String(label).trim().toLowerCase();
  const alias = normalizedLabel.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!alias) throw new Error(`Cannot create an alias for label: ${label}`);
  return alias;
}

const source = JSON.parse(readFileSync(resolve(sourcePath), "utf8"));
if (!source || !Array.isArray(source.stores) || source.stores.length === 0) {
  throw new Error("The source file has no stores.");
}

const apiVersion = /^\d{4}-\d{2}$/.test(source.api_version ?? "") ? source.api_version : "2026-07";
const stores = [];
for (const item of source.stores) {
  const alias = aliasFor(item.label);
  const shop = String(item.domain ?? "").trim().toLowerCase();
  const token = String(item.access_token ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw new Error(`Invalid shop domain for ${alias}.`);
  if (!token) throw new Error(`Missing token for ${alias}.`);
  execFileSync("security", [
    "add-generic-password",
    "-U",
    "-s", "codex-shopify-multi-store",
    "-a", alias,
    "-w", token
  ], { stdio: "ignore" });
  stores.push({ alias, shop, apiVersion });
}

const targetPath = process.env.SHOPIFY_MULTI_STORE_CONFIG
  ? resolve(process.env.SHOPIFY_MULTI_STORE_CONFIG)
  : resolve(homedir(), ".config", "codex-shopify-multi-store", "stores.json");
mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
writeFileSync(targetPath, `${JSON.stringify({ stores }, null, 2)}\n`, { mode: 0o600 });
chmodSync(targetPath, 0o600);
chmodSync(resolve(sourcePath), 0o600);
process.stdout.write(`Imported ${stores.length} stores. Tokens are in macOS Keychain.\n`);
process.stdout.write(`Config: ${targetPath}\n`);
