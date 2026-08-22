#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import {
  accessTokenAccount,
  clientSecretAccount,
  credentialBackend,
  removeCredential,
  storeCredential
} from "../dist/credentials.js";
import { getAccessToken } from "../dist/config.js";
import { adminGraphql } from "../dist/shopify.js";
import {
  configPath,
  loadConfig,
  normalizeShop,
  readHidden,
  saveConfig,
  upsertStore,
  validateAlias,
  validateApiVersion,
  verifyAccessToken
} from "./config-helpers.mjs";

process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

async function addStore(args) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const alias = (args[0] ?? await rl.question("Store alias: ")).trim().toLowerCase();
  const shop = normalizeShop(args[1] ?? await rl.question("Permanent *.myshopify.com domain: "));
  const apiVersion = (args[2] ?? "2026-07").trim();
  rl.close();
  validateAlias(alias);
  validateApiVersion(apiVersion);

  const token = await readHidden("Shopify Admin API access token: ");
  if (!token) throw new Error("The access token cannot be empty.");
  const verified = await verifyAccessToken({ shop, apiVersion, token });
  await storeCredential(accessTokenAccount(alias), token);
  upsertStore({ alias, shop, apiVersion, auth: { type: "access_token" } });
  process.stdout.write(`Saved ${alias} (${verified.name}, ${shop}).\n`);
}

function listStores() {
  const config = loadConfig();
  if (!config.stores.length) {
    process.stdout.write("No stores are configured.\n");
    return;
  }
  for (const store of config.stores) {
    const authType = store.auth?.type ?? "access_token";
    process.stdout.write(`${store.alias}\t${store.shop}\t${store.apiVersion}\t${authType}\n`);
  }
}

async function removeStore(alias) {
  alias = alias.trim().toLowerCase();
  validateAlias(alias);
  const config = loadConfig();
  const next = config.stores.filter((item) => item.alias !== alias);
  if (next.length === config.stores.length) throw new Error(`Unknown store alias: ${alias}`);
  config.stores = next;
  saveConfig(config);
  await Promise.all([
    removeCredential(accessTokenAccount(alias)),
    removeCredential(clientSecretAccount(alias))
  ]);
  process.stdout.write(`Removed ${alias}.\n`);
}

async function doctor() {
  const backend = await credentialBackend();
  const config = loadConfig();
  process.stdout.write(`Credential store: ${backend.name} (${backend.id})\n`);
  process.stdout.write(`Configuration: ${configPath}\n`);
  process.stdout.write(`Configured stores: ${config.stores.length}\n`);
  let failures = 0;
  for (const configured of config.stores) {
    const store = {
      ...configured,
      apiVersion: configured.apiVersion ?? "2026-07",
      auth: configured.auth ?? { type: "access_token" }
    };
    try {
      await getAccessToken(store);
      const result = await adminGraphql(store, "query DoctorStoreCheck { shop { name myshopifyDomain } }", {});
      const shop = result.data?.shop;
      process.stdout.write(`${store.alias}\tOK\t${shop?.name ?? store.shop}\t${result.elapsedMs}ms\n`);
    } catch (error) {
      failures += 1;
      process.stdout.write(`${store.alias}\tFAIL\t${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  if (failures) throw new Error(`Doctor found ${failures} store connection failure${failures === 1 ? "" : "s"}.`);
}

const [command = "list", ...args] = process.argv.slice(2);
try {
  if (command === "add") await addStore(args);
  else if (command === "oauth") await import("./oauth-connect.mjs");
  else if (command === "list") listStores();
  else if (command === "remove" && args[0]) await removeStore(args[0]);
  else if (command === "doctor") await doctor();
  else throw new Error("Use: shopify-multi-store setup, oauth, list, remove <alias>, or doctor.");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
