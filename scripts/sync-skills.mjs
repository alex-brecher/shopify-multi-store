#!/usr/bin/env node
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "skills", "shopify-multi-store");
const destination = join(root, ".claude", "skills", "shopify-multi-store");
await mkdir(dirname(destination), { recursive: true });
await cp(source, destination, { recursive: true, force: true });
process.stdout.write("Synced the Shopify multi-store skill for Claude.\n");
