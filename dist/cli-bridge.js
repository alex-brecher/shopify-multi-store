import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export async function cliJson(args, timeout = 60_000) {
    try {
        const { stdout } = await exec(process.env.SHOPIFY_MULTI_STORE_CLI ?? "shopify", args, {
            timeout,
            maxBuffer: 1_000_000,
            env: {
                ...process.env,
                SHOPIFY_CLI_AGENT_INFO: "n:shopify-multi-store|v:1.6.0-beta.1|p:openai",
                SHOPIFY_CLI_AGENT_IDS: "r:preview-workflow",
                CI: "1",
                SHOPIFY_FLAG_VERBOSE: "0",
            },
        });
        return JSON.parse(stdout);
    }
    catch (error) {
        // CLI errors can contain tokens, access links, and customer data. Do not echo them.
        const e = error;
        throw Error(e.code === "ENOENT"
            ? "Shopify CLI is required. Install @shopify/cli and retry."
            : `Shopify CLI failed (${e.killed ? "timeout" : (e.code ?? "invalid response")}). A write might have applied. Inspect the store before retrying.`);
    }
}
//# sourceMappingURL=cli-bridge.js.map