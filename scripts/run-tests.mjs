import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const directory = new URL("../tests/", import.meta.url);
const files = (await readdir(directory))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => fileURLToPath(new URL(name, directory)));
if (!files.length) throw new Error("No unit test files found.");
const child = spawn(process.execPath, ["--test", ...files], {
  stdio: "inherit",
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
