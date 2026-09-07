import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { configPath } from "./config.js";
import { withFileLock } from "./concurrency.js";
const exec = promisify(execFile);
export const DAWN_COMMIT = "258f00f64365e2018ca4c62778a6bf55a5d3cd18";
export async function dawnSource() {
  const path = join(
    dirname(configPath()),
    "theme-sources",
    `dawn-${DAWN_COMMIT}`,
  );
  await mkdir(dirname(path), { recursive: true });
  return withFileLock(path + ".lock", async () => {
    try {
      await access(path);
      const r = await exec("git", ["-C", path, "rev-parse", "HEAD"]);
      if (r.stdout.trim() !== DAWN_COMMIT)
        throw Error("Pinned Dawn checkout changed.");
      return path;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const temp = path + "." + randomUUID();
    try {
      await exec(
        "git",
        [
          "clone",
          "--no-checkout",
          "--filter=blob:none",
          "https://github.com/Shopify/dawn.git",
          temp,
        ],
        { timeout: 120000, maxBuffer: 1000000 },
      );
      await exec("git", ["-C", temp, "checkout", "--detach", DAWN_COMMIT], {
        timeout: 120000,
        maxBuffer: 1000000,
      });
      await rename(temp, path);
      return path;
    } catch {
      await rm(temp, { recursive: true, force: true });
      throw Error(
        "Could not fetch the pinned Shopify Dawn source. Git and GitHub access are required.",
      );
    }
  });
}
