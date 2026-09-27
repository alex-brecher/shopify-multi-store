#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

const directory = dirname(fileURLToPath(import.meta.url));
const [command = "start", ...args] = process.argv.slice(2);

if (command === "start") {
  await import("../dist/index.js");
} else if (command === "serve") {
  const { serve } = await import("../dist/serve.js");
  try {
    await serve();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
} else {
  const commandMap = {
    setup: ["configure-store.mjs", "add"],
    oauth: ["configure-store.mjs", "oauth"],
    list: ["configure-store.mjs", "list"],
    remove: ["configure-store.mjs", "remove"],
    doctor: ["configure-store.mjs", "doctor"],
    import: ["import-legacy-stores.mjs"],
    "install-shopify-skills": ["install-shopify-skills.mjs"]
  };
  const mapped = commandMap[command];
  if (!mapped) {
    process.stderr.write("Use: shopify-multi-store start, serve, setup, oauth, list, remove <alias>, doctor, import <file>, or install-shopify-skills.\n");
    process.exitCode = 1;
  } else {
    const result = spawnSync(process.execPath, [join(directory, mapped[0]), ...mapped.slice(1), ...args], {
      stdio: "inherit"
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
}
