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
} else {
  const commandMap = {
    setup: ["configure-store.mjs", "add"],
    oauth: ["configure-store.mjs", "oauth"],
    list: ["configure-store.mjs", "list"],
    remove: ["configure-store.mjs", "remove"],
    doctor: ["configure-store.mjs", "doctor"],
    import: ["import-legacy-stores.mjs"]
  };
  const mapped = commandMap[command];
  if (!mapped) {
    process.stderr.write("Use: shopify-multi-store start, setup, oauth, list, remove <alias>, doctor, or import <file>.\n");
    process.exitCode = 1;
  } else {
    const result = spawnSync(process.execPath, [join(directory, mapped[0]), ...mapped.slice(1), ...args], {
      stdio: "inherit"
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
}
