#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const command = process.platform === "win32" ? "npx.cmd" : "npx";
const requestedAgents = process.argv.slice(2);
const selection = requestedAgents.length ? requestedAgents : ["--agent", "*"];
process.stdout.write("This installs Shopify's official Admin GraphQL and ShopifyQL skills.\n");
process.stdout.write("The Shopify skills send usage telemetry by default. Set OPT_OUT_INSTRUMENTATION=true to turn it off.\n");

const result = spawnSync(command, [
  "-y",
  "skills",
  "add",
  "Shopify/shopify-ai-toolkit",
  "--skill",
  "shopify-admin",
  "shopify-shopifyql",
  "--global",
  ...selection,
  "--yes"
], { stdio: "inherit" });

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
