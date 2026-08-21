#!/usr/bin/env node
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "skills", "shopify-multi-store", "SKILL.md");
const destination = join(root, ".claude", "skills", "shopify-multi-store", "SKILL.md");
await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
process.stdout.write("Synced the Shopify multi-store skill for Claude.\n");
