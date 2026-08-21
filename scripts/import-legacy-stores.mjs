#!/usr/bin/env node
import { chmodSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { accessTokenAccount, storeCredential } from "../dist/credentials.js";
import { configPath, loadConfig, saveConfig } from "./config-helpers.mjs";

const sourcePath = process.argv[2];
if (!sourcePath) {
  process.stderr.write("Use: shopify-multi-store import /absolute/path/to/stores.json\n");
  process.exit(1);
}

function aliasFor(label) {
  const alias = String(label).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!alias) throw new Error(`Cannot create an alias for label: ${label}`);
  return alias;
}

const resolvedSourcePath = resolve(sourcePath);
const source = JSON.parse(readFileSync(resolvedSourcePath, "utf8"));
if (!source || !Array.isArray(source.stores) || source.stores.length === 0) {
  throw new Error("The source file has no stores.");
}

const apiVersion = /^\d{4}-\d{2}$/.test(source.api_version ?? "") ? source.api_version : "2026-07";
const imported = source.stores.map((item) => {
  const alias = aliasFor(item.label);
  const shop = String(item.domain ?? "").trim().toLowerCase();
  const token = String(item.access_token ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw new Error(`Invalid shop domain for ${alias}.`);
  if (!token) throw new Error(`Missing token for ${alias}.`);
  return { alias, shop, token };
});

const duplicateAliases = imported.filter((item, index) => imported.findIndex((candidate) => candidate.alias === item.alias) !== index);
if (duplicateAliases.length) throw new Error(`Duplicate store alias in source: ${duplicateAliases[0].alias}`);

const config = loadConfig();
for (const item of imported) {
  const { alias, shop, token } = item;
  await storeCredential(accessTokenAccount(alias), token);
  const store = { alias, shop, apiVersion, auth: { type: "access_token" } };
  const index = config.stores.findIndex((candidate) => candidate.alias === alias);
  if (index >= 0) config.stores[index] = store;
  else config.stores.push(store);
}

saveConfig(config);
chmodSync(resolvedSourcePath, 0o600);
process.stdout.write(`Imported ${imported.length} stores. Tokens are in the operating-system credential store.\n`);
process.stdout.write(`Config: ${configPath}\n`);
