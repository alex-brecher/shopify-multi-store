import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { configPath } from "./config.js";
import { cliJson } from "./cli-bridge.js";
import { serializeStore, withFileLock } from "./concurrency.js";
import { textResult, toolError } from "./admin-workflows.js";
import { UI_META } from "./ui.js";
const path = () => join(dirname(configPath()), "preview-stores.json");
async function records() {
    try {
        return JSON.parse(await readFile(path(), "utf8"));
    }
    catch (e) {
        if (e.code === "ENOENT")
            return [];
        throw e;
    }
}
async function save(items) {
    await mkdir(dirname(path()), { recursive: true });
    const temp = `${path()}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(items, null, 2), { mode: 0o600 });
    await rename(temp, path());
}
export async function previewStores() {
    return (await records())
        .filter((p) => p.state === "ready" && p.shop)
        .map((p) => ({
        alias: p.alias,
        shop: p.shop,
        apiVersion: "2026-07",
        auth: { type: "shopify_cli" },
    }));
}
export async function createPreview(a, run = cliJson) {
    return serializeStore(path(), () => withFileLock(path() + ".lock", async () => {
        const items = await records();
        const old = items.find((x) => x.requestId === a.requestId);
        if (old) {
            if (old.name !== a.name || old.country !== a.country)
                throw Error("requestId already belongs to a different preview request.");
            if (old.state !== "ready")
                throw Error("This creation has an uncertain outcome. Use Shopify CLI store auth list to recover it before creating another.");
            return { ...old, ...(await previewInfo(old.shop, run)) };
        }
        const item = {
            ...a,
            alias: `preview-${randomUUID().slice(0, 8)}`,
            state: "starting",
        };
        items.push(item);
        await save(items);
        try {
            const r = await run([
                "store",
                "create",
                "preview",
                "--name",
                a.name,
                "--country",
                a.country,
                "--json",
            ], 180_000);
            if (r.status !== "success" ||
                !/^[-a-z0-9]+\.myshopify\.com$/.test(r.store?.subdomain))
                throw Error("Preview creation did not return a valid Shopify store.");
            item.shop = r.store.subdomain;
            item.state = "ready";
            await save(items);
            return { ...item, ...(await previewInfo(item.shop, run)) };
        }
        catch (e) {
            if (item.state !== "ready") {
                item.state = "unknown";
                await save(items);
            }
            throw e;
        }
    }));
}
export async function previewInfo(shop, run = cliJson) {
    const r = await run(["store", "info", "--store", shop, "--json"]);
    return {
        shop,
        previewUrl: r.accessUrl,
        claimUrl: r.saveUrl,
        temporary: true,
    };
}
export function registerPreviewTools(server) {
    server.registerTool("shopify_create_preview_store", {
        description: "Create a real temporary Shopify store that a merchant can claim. No existing store is modified. Reuse requestId after interruptions to prevent duplicate creation.",
        _meta: UI_META,
        inputSchema: z
            .object({
            requestId: z.string().uuid(),
            name: z.string().min(1).max(100),
            country: z
                .string()
                .regex(/^[A-Z]{2}$/)
                .default("US"),
            userUnderstandsNewStoreOnly: z.literal(true),
        })
            .strict(),
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async (a) => {
        try {
            return textResult(await createPreview(a));
        }
        catch (e) {
            return toolError(e);
        }
    });
    server.registerTool("shopify_get_preview_store", {
        description: "Refresh preview and claim links for a temporary store created by this app.",
        _meta: UI_META,
        inputSchema: z.object({ store: z.string() }).strict(),
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async (a) => {
        try {
            const s = (await previewStores()).find((s) => s.alias === a.store);
            if (!s)
                throw Error("Unknown preview store alias.");
            return textResult({ store: s.alias, ...(await previewInfo(s.shop)) });
        }
        catch (e) {
            return toolError(e);
        }
    });
}
//# sourceMappingURL=previews.js.map