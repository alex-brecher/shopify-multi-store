#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { accessTokenAccount, clientSecretAccount, readCredential, removeCredential, storeCredential } from "../dist/credentials.js";
import { configPath, importStoresWithRollback, loadConfig, parseLegacyStores } from "./config-helpers.mjs";

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
await importStoresWithRollback({
  imported,
  config,
  apiVersion,
  accountFor: ({ alias, auth }) => auth.type === "client_credentials" ? clientSecretAccount(alias) : accessTokenAccount(alias),
  readCredential,
  storeCredential,
  removeCredential
});
process.stdout.write(`Imported ${imported.length} stores. Tokens are in the operating-system credential store.\n`);
process.stdout.write(`Config: ${configPath}\n`);
