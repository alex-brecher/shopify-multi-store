#!/usr/bin/env node
import { chmodSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { accessTokenAccount, clientSecretAccount, storeCredential } from "../dist/credentials.js";
import { configPath, loadConfig, parseLegacyStores, saveConfig } from "./config-helpers.mjs";

const sourcePath = process.argv[2];
if (!sourcePath) {
  process.stderr.write("Use: shopify-multi-store import /absolute/path/to/stores.json\n");
  process.exit(1);
}

const resolvedSourcePath = resolve(sourcePath);
const source = JSON.parse(readFileSync(resolvedSourcePath, "utf8"));
const apiVersion = /^\d{4}-\d{2}$/.test(source.api_version ?? "") ? source.api_version : "2026-07";
const imported = parseLegacyStores(source);

const duplicateAliases = imported.filter((item, index) => imported.findIndex((candidate) => candidate.alias === item.alias) !== index);
if (duplicateAliases.length) throw new Error(`Duplicate store alias in source: ${duplicateAliases[0].alias}`);

const config = loadConfig();
for (const item of imported) {
  const { alias, shop, auth, credential } = item;
  const account = auth.type === "client_credentials" ? clientSecretAccount(alias) : accessTokenAccount(alias);
  await storeCredential(account, credential);
  const store = { alias, shop, apiVersion, auth };
  const index = config.stores.findIndex((candidate) => candidate.alias === alias);
  if (index >= 0) config.stores[index] = store;
  else config.stores.push(store);
}

saveConfig(config);
chmodSync(resolvedSourcePath, 0o600);
process.stdout.write(`Imported ${imported.length} stores. Tokens are in the operating-system credential store.\n`);
process.stdout.write(`Config: ${configPath}\n`);
