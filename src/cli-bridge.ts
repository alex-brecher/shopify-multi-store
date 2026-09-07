import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export async function cliCommand(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
) {
  const configured = env.SHOPIFY_MULTI_STORE_CLI;
  if (configured && /\.[mc]?js$/i.test(configured))
    return { command: process.execPath, prefix: [configured] };
  if (platform !== "win32" || configured?.toLowerCase().endsWith(".exe"))
    return { command: configured ?? "shopify", prefix: [] };
  // npm's Windows .cmd shim needs a shell. Run its JavaScript entry directly instead.
  const dirs = configured
    ? [dirname(configured)]
    : (env.PATH ?? env.Path ?? "").split(";");
  for (const dir of dirs) {
    const script = join(
      dir,
      "node_modules",
      "@shopify",
      "cli",
      "bin",
      "run.js",
    );
    try {
      await access(script);
      return { command: process.execPath, prefix: [script] };
    } catch {}
  }
  throw Error(
    "Shopify CLI was not found. Install @shopify/cli or set SHOPIFY_MULTI_STORE_CLI to its bin/run.js file.",
  );
}

export async function cliJson(
  args: string[],
  timeout = 60_000,
): Promise<Record<string, any>> {
  const launch = await cliCommand();
  try {
    const { stdout } = await exec(launch.command, [...launch.prefix, ...args], {
      timeout,
      maxBuffer: 1_000_000,
      env: {
        ...process.env,
        SHOPIFY_CLI_AGENT_INFO: "n:shopify-multi-store|v:1.6.0|p:openai",
        SHOPIFY_CLI_AGENT_IDS: "r:preview-workflow",
        CI: "1",
        SHOPIFY_FLAG_VERBOSE: "0",
      },
    });
    return JSON.parse(stdout);
  } catch (error) {
    // CLI errors can contain tokens, access links, and customer data. Do not echo them.
    const e = error as { code?: string | number; killed?: boolean };
    throw Error(
      e.code === "ENOENT"
        ? "Shopify CLI is required. Install @shopify/cli and retry."
        : `Shopify CLI failed (${e.killed ? "timeout" : (e.code ?? "invalid response")}). A write might have applied. Inspect the store before retrying.`,
    );
  }
}
