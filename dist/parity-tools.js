import { z } from "zod/v4";
import { workflow, textResult, toolError, WorkflowError, applyTagChanges, checkTagArgs, tagPreview, } from "./admin-workflows.js";
import { PDOCS } from "./parity-documents.js";
import { PARITY_API_VERSION } from "./api-versions.js";
import { tagFields } from "./admin-tools.js";
import { mapConcurrent } from "./concurrency.js";
import { resolveStoreTargets } from "./config.js";
import { REQUIRED_SCOPES, VARIABLE_SCOPE_TOOLS } from "./scope-requirements.js";
// These tools pin their Admin GraphQL operations to PARITY_API_VERSION (see api-versions.ts)
// rather than following each store's own configured apiVersion, so their behavior stays fixed
// regardless of what a store is otherwise configured for.
export { PARITY_API_VERSION };
const store = z.string().min(1).max(64);
const gid = (type) => z.string().regex(new RegExp(`^gid://shopify/${type}/[0-9]+$`));
// Some ids returned by these tools (delivery zones, method definitions, rate
// definitions, files) come from Shopify object types that are not worth naming
// individually here, so this accepts any well-formed Admin API GID.
const anyGid = z.string().regex(/^gid:\/\/shopify\/[A-Za-z]+\/[0-9]+$/);
const first = z.number().int().min(1).max(100).default(25);
const after = z.string().max(1000).optional();
const page = { first, after };
const money = z.string().regex(/^\d+(\.\d{1,4})?$/);
const dryRunField = z
    .boolean()
    .default(true)
    .describe("True (the default) returns a before/after preview without changing anything in Shopify. Pass false to apply the change; the tool then reads the result back.");
const skuEntry = z
    .object({
    sku: z.string().min(1).max(255),
    price: money.optional(),
    compareAtPrice: money.nullable().optional(),
    unitCost: money.optional(),
})
    .strict();
const skusField = z.array(skuEntry).min(1).max(250);
const allowDuplicatesField = z
    .boolean()
    .default(false)
    .describe("When a SKU exactly matches more than one variant it is reported in ambiguousSkus and skipped. Pass true to update every exact match instead.");
// Builds a Shopify mutation input from an explicit allowlist of tool arguments so
// tool-only fields (dryRun, allowLiveTheme, ...) never leak into GraphQL inputs.
function pick(a, keys) {
    const out = {};
    for (const key of keys)
        if (a[key] !== undefined)
            out[key] = a[key];
    return out;
}
const ORDER_INPUT_FIELDS = ["note", "email", "shippingAddress"];
const CUSTOMER_INPUT_FIELDS = ["note", "email"];
/**
 * Canonical form of a decimal money string ("12", "12.0" and "12.00" all become "12"),
 * compared as text so there is no floating-point rounding. Returns undefined for
 * anything that is not a plain decimal.
 */
function canonicalDecimal(value) {
    if (typeof value === "number" && Number.isFinite(value))
        value = String(value);
    if (typeof value !== "string")
        return undefined;
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
    if (!match)
        return undefined;
    const whole = match[2].replace(/^0+(?=\d)/, "");
    const fraction = (match[3] ?? "").replace(/0+$/, "");
    const zero = /^0+$/.test(whole) && fraction === "";
    return `${zero ? "" : match[1]}${whole}${fraction ? `.${fraction}` : ""}`;
}
/** True when two money values are equal as decimals; null and undefined equal only each other. */
export function sameMoney(a, b) {
    if (a === null || a === undefined || b === null || b === undefined)
        return (a ?? null) === (b ?? null);
    const left = canonicalDecimal(a);
    return left !== undefined && left === canonicalDecimal(b);
}
const SKU_LOOKUP_MAX_PAGES = 20;
// Variants per nodes(ids:) read. Shopify responses are capped at 50,000 characters here (see
// shopify.ts), and a variant with a long product title can take about 700, so 100 per read could
// fail the verification read-back after a successful write.
const VARIANT_READ_BATCH = 50;
/**
 * Every variant whose SKU exactly equals `sku` (case-sensitive, surrounding whitespace
 * ignored). Shopify's `sku:` search is a prefix match, so results are filtered here, and
 * a full page is followed to the next one so no exact match is missed.
 */
async function findVariantsByExactSku(w, sku) {
    const wanted = sku.trim();
    const ids = await findVariantIdsByExactSku(w, wanted);
    const variants = [];
    for (let i = 0; i < ids.length; i += VARIANT_READ_BATCH) {
        const d = await w.run(PDOCS.variantsForPricing, { ids: ids.slice(i, i + VARIANT_READ_BATCH) });
        for (const v of d.nodes ?? [])
            if (v?.id && typeof v.sku === "string" && v.sku.trim() === wanted)
                variants.push(v);
    }
    return variants;
}
async function findVariantIdsByExactSku(w, wanted) {
    const matches = [];
    let after;
    for (let page = 0; page < SKU_LOOKUP_MAX_PAGES; page++) {
        const d = await w.run(PDOCS.findVariantsBySku, {
            query: `sku:${JSON.stringify(wanted)}`,
            ...(after ? { after } : {}),
        });
        const connection = d.productVariants ?? {};
        for (const v of connection.nodes ?? [])
            if (typeof v.sku === "string" && v.sku.trim() === wanted)
                matches.push(v.id);
        if (!connection.pageInfo?.hasNextPage || !connection.pageInfo.endCursor)
            return matches;
        after = connection.pageInfo.endCursor;
    }
    throw new WorkflowError(`SKU lookup for "${wanted}" returned more than ${SKU_LOOKUP_MAX_PAGES * 250} candidate variants; refusing to guess.`, { sku: wanted });
}
/** True when two SKU entries request the same price/compareAtPrice/unitCost. */
function sameEntryValues(a, b) {
    return (sameMoney(a.price, b.price) &&
        sameMoney(a.compareAtPrice, b.compareAtPrice) &&
        sameMoney(a.unitCost, b.unitCost));
}
/**
 * Collapses exact-duplicate SKU rows and rejects the whole call (before any write) when
 * duplicate rows for the same SKU disagree on what to write.
 */
function dedupeSkuEntries(skus) {
    const groups = new Map();
    for (const raw of skus) {
        const entry = { ...raw, sku: raw.sku.trim() };
        const list = groups.get(entry.sku) ?? [];
        list.push(entry);
        groups.set(entry.sku, list);
    }
    const entries = [];
    const collapsedSkus = [];
    const conflicts = [];
    for (const [sku, group] of groups) {
        if (group.length === 1) {
            entries.push(group[0]);
            continue;
        }
        if (group.every((e) => sameEntryValues(e, group[0]))) {
            entries.push(group[0]);
            collapsedSkus.push(sku);
        }
        else {
            conflicts.push({ sku, entries: group });
        }
    }
    if (conflicts.length)
        throw new WorkflowError(`Duplicate SKU rows with conflicting values: ${conflicts.map((c) => c.sku).join(", ")}. No changes were made; fix the input and resubmit.`, { conflicts });
    return { entries, collapsedSkus };
}
/** Derives a store-level status from every item's outcome. See src/parity-tools.ts task 8b. */
/**
 * Store-level status from item outcomes.
 * - ok: every item applied and verified by a fresh read (or was an explicit no-op).
 * - unverified: every item was accepted by Shopify, but the read-back that verifies the new
 *   state failed for at least one ("applied_unverified"). Not ok: read the variants back.
 * - partial: some items applied, others were rejected, mismatched, unknown or not found.
 * - unknown: nothing confirmed applied and at least one write's outcome is unknown.
 * - failed: nothing applied.
 * Only "ok" counts as success; the _many tools treat every other status as not ok.
 */
export function deriveStatus(outcomes) {
    const total = outcomes.length;
    const applied = outcomes.filter((o) => o === "applied" || o === "skipped").length;
    const unverified = outcomes.filter((o) => o === "applied_unverified").length;
    if (total === 0 || applied === total)
        return "ok";
    if (unverified > 0 && applied + unverified === total)
        return "unverified";
    if (applied + unverified === 0) {
        return outcomes.includes("unknown") ? "unknown" : "failed";
    }
    return "partial";
}
function itemOutcome(outcome) {
    return { outcome, ok: outcome === "applied" };
}
/**
 * The outcome of one write that threw: "unknown" when the request may have reached Shopify
 * (network error or timeout after sending), otherwise "rejected".
 */
function failedItem(error) {
    const unknown = error instanceof WorkflowError && error.details?.outcome === "unknown";
    return {
        ...itemOutcome(unknown ? "unknown" : "rejected"),
        error: error instanceof Error ? error.message : String(error),
        ...(unknown
            ? { doNotBlindlyRetry: "The write may or may not have applied. Read it back before retrying." }
            : {}),
    };
}
/** Store status and counts for per-item writes, derived like shopify_update_prices. */
function itemSummary(results) {
    const status = deriveStatus(results.map((r) => r.outcome));
    return {
        dryRun: false,
        status,
        results,
        succeeded: results.filter((r) => r.outcome === "applied").length,
        failed: results.filter((r) => r.outcome === "rejected").length,
        unknown: results.filter((r) => r.outcome === "unknown").length,
        ...(status === "unknown" || status === "partial"
            ? { notice: "Items with outcome unknown may have applied. Read them back before retrying; retry only rejected items." }
            : {}),
    };
}
async function updatePricesCore(w, a) {
    const needsCost = a.skus.some((s) => s.unitCost !== undefined);
    await w.requireScopes([
        "read_products",
        "write_products",
        ...(needsCost ? ["write_inventory"] : []),
    ]);
    const { entries: uniqueEntries, collapsedSkus } = dedupeSkuEntries(a.skus);
    const notFound = [];
    const ambiguous = [];
    const skipped = [];
    const resolved = [];
    for (const entry of uniqueEntries) {
        if (!entry.price && entry.compareAtPrice === undefined && !entry.unitCost) {
            skipped.push(entry.sku); // nothing requested for this SKU; an explicit no-op
            continue;
        }
        const matches = await findVariantsByExactSku(w, entry.sku);
        if (matches.length === 0) {
            notFound.push(entry.sku);
        }
        else if (matches.length > 1 && !a.allowDuplicates) {
            ambiguous.push(entry.sku);
        }
        else {
            for (const variant of matches)
                resolved.push({ entry, variant });
        }
    }
    const preview = resolved.map(({ entry, variant }) => ({
        sku: entry.sku,
        productId: variant.product.id,
        variantId: variant.id,
        before: {
            price: variant.price,
            compareAtPrice: variant.compareAtPrice,
            unitCost: variant.inventoryItem?.unitCost?.amount,
        },
        requested: {
            ...(entry.price ? { price: entry.price } : {}),
            ...(entry.compareAtPrice !== undefined
                ? { compareAtPrice: entry.compareAtPrice }
                : {}),
            ...(entry.unitCost ? { unitCost: entry.unitCost } : {}),
        },
    }));
    if (a.dryRun) {
        return {
            dryRun: true,
            wouldApply: preview,
            notFound,
            skippedSkus: skipped,
            collapsedDuplicateSkus: collapsedSkus,
            duplicateSkus: collapsedSkus,
            ambiguousSkus: ambiguous,
            notice: ambiguous.length
                ? "Pass dryRun:false to apply these changes. SKUs in ambiguousSkus match more than one variant and are skipped unless allowDuplicates:true."
                : "Pass dryRun:false to apply these changes.",
        };
    }
    const byProduct = new Map();
    for (const r of resolved) {
        const list = byProduct.get(r.variant.product.id) ?? [];
        list.push(r);
        byProduct.set(r.variant.product.id, list);
    }
    const requestedOf = (entry) => ({
        ...(entry.price ? { price: entry.price } : {}),
        ...(entry.compareAtPrice !== undefined ? { compareAtPrice: entry.compareAtPrice } : {}),
        ...(entry.unitCost ? { unitCost: entry.unitCost } : {}),
    });
    const results = [];
    // Entries whose mutation response looked fine and now need an independent readback.
    const provisional = [];
    for (const [productId, entries] of byProduct) {
        const variants = entries.map(({ entry, variant }) => ({
            id: variant.id,
            ...(entry.price ? { price: entry.price } : {}),
            ...(entry.compareAtPrice !== undefined
                ? { compareAtPrice: entry.compareAtPrice }
                : {}),
            ...(entry.unitCost ? { inventoryItem: { cost: entry.unitCost } } : {}),
        }));
        let d;
        try {
            d = await w.run(PDOCS.variantsBulkUpdatePrices, { productId, variants });
        }
        catch (error) {
            const unknown = error instanceof WorkflowError && error.details?.outcome === "unknown";
            if (unknown) {
                for (const { entry, variant } of entries)
                    results.push({
                        sku: entry.sku,
                        productId,
                        variantId: variant.id,
                        outcome: "unknown",
                        doNotBlindlyRetry: "The write may or may not have applied. Read the variant back before retrying instead of resending the same write.",
                        error: error instanceof Error ? error.message : String(error),
                    });
                continue;
            }
            // Shopify can reject some variants in a batch (userErrors) while still applying the
            // rest; that partial data travels in the thrown error's details, not a return value.
            const partial = error instanceof WorkflowError && error.details?.outcome === "rejected_or_partial"
                ? error.details.response?.data
                : undefined;
            if (!partial) {
                for (const { entry, variant } of entries)
                    results.push({
                        sku: entry.sku,
                        productId,
                        variantId: variant.id,
                        outcome: "rejected",
                        error: error instanceof Error ? error.message : String(error),
                    });
                continue;
            }
            d = partial;
        }
        const bulkUserErrors = d.productVariantsBulkUpdate?.userErrors ?? [];
        const after = d.productVariantsBulkUpdate?.productVariants ?? [];
        for (const { entry, variant } of entries) {
            const mutationResponse = after.find((v) => v.id === variant.id);
            if (!mutationResponse) {
                results.push({
                    sku: entry.sku,
                    productId,
                    variantId: variant.id,
                    outcome: "rejected",
                    error: bulkUserErrors.length
                        ? bulkUserErrors.map((e) => e.message).join("; ")
                        : "Shopify did not return this variant in the mutation response.",
                });
                continue;
            }
            provisional.push({ entry, productId, variant, mutationResponse });
        }
    }
    // Independent verification (task 10): a fresh query for the affected variants, never just
    // an inspection of the mutation response, which Shopify can return looking fine while the
    // actual state disagrees.
    const verified = new Map();
    let verificationFailed = false;
    if (provisional.length) {
        const ids = [...new Set(provisional.map((p) => p.variant.id))];
        try {
            for (let i = 0; i < ids.length; i += VARIANT_READ_BATCH) {
                const d = await w.run(PDOCS.variantsForPricing, { ids: ids.slice(i, i + VARIANT_READ_BATCH) });
                for (const v of d.nodes ?? [])
                    if (v?.id)
                        verified.set(v.id, v);
            }
        }
        catch {
            verificationFailed = true;
        }
    }
    for (const { entry, productId, variant, mutationResponse } of provisional) {
        if (verificationFailed) {
            results.push({
                sku: entry.sku,
                productId,
                variantId: variant.id,
                requested: requestedOf(entry),
                outcome: "applied_unverified",
                verification: "verification_failed",
                mutationResponse,
            });
            continue;
        }
        const verifiedState = verified.get(variant.id);
        const mismatch = !verifiedState ||
            (entry.price !== undefined && !sameMoney(verifiedState.price, entry.price)) ||
            (entry.compareAtPrice !== undefined &&
                !sameMoney(verifiedState.compareAtPrice, entry.compareAtPrice)) ||
            (entry.unitCost !== undefined &&
                !sameMoney(verifiedState.inventoryItem?.unitCost?.amount, entry.unitCost));
        results.push({
            sku: entry.sku,
            productId,
            variantId: variant.id,
            requested: requestedOf(entry),
            outcome: mismatch ? "mismatch" : "applied",
            verification: mismatch ? "mismatch" : "verified",
            mutationResponse,
            verifiedState,
        });
    }
    const itemOutcomes = [
        ...results.map((r) => r.outcome),
        ...notFound.map(() => "not_found"),
        ...ambiguous.map(() => "ambiguous"),
        ...skipped.map(() => "skipped"),
    ];
    const status = deriveStatus(itemOutcomes);
    return {
        dryRun: false,
        status,
        results,
        notFound,
        skippedSkus: skipped,
        collapsedDuplicateSkus: collapsedSkus,
        duplicateSkus: collapsedSkus,
        ambiguousSkus: ambiguous,
        succeeded: results.filter((r) => r.outcome === "applied").length,
        unverified: results.filter((r) => r.outcome === "applied_unverified").length,
        failed: results.filter((r) => r.outcome !== "applied" && r.outcome !== "applied_unverified").length,
        ...(results.some((r) => r.outcome === "applied_unverified")
            ? {
                verificationNotice: "Shopify accepted at least one write, but the read-back that verifies the new prices failed. Those items are applied_unverified: read the variants back before treating them as done or retrying.",
            }
            : {}),
        ...(status === "unknown"
            ? {
                notice: "At least one write's outcome is unknown (network error, timeout, or throttled response after the request was sent) and none could be confirmed applied. Read the affected variants back before retrying; do not blindly resend the same write.",
            }
            : {}),
    };
}
/** A workflow for one store, pinned to PARITY_API_VERSION. */
async function parityWorkflow(alias) {
    const w = await workflow(alias);
    w.store = { ...w.store, apiVersion: PARITY_API_VERSION };
    return w;
}
/** A tool error that keeps the store, and any completed writes, in its details. */
function failure(w, error, write) {
    if (!w)
        return toolError(error, write);
    return toolError(new WorkflowError(error instanceof Error ? error.message : String(error), {
        store: w.store.alias,
        shop: w.store.shop,
        ...(w.completed.length
            ? {
                completedSteps: w.completed,
                outcome: "partial",
                notice: "Some writes succeeded. Read back before retrying.",
            }
            : {}),
        ...(error instanceof WorkflowError ? error.details : {}),
    }), write);
}
export function registerParityTools(server) {
    function register(name, description, shape, write, handler) {
        server.registerTool(`shopify_${name}`, {
            description,
            inputSchema: z
                .object({ store, ...shape, ...(write ? { dryRun: dryRunField } : {}) })
                .strict(),
            annotations: {
                readOnlyHint: !write,
                destructiveHint: write,
                idempotentHint: !write,
                openWorldHint: true,
            },
        }, async (args) => {
            const a = args;
            let w;
            try {
                w = await parityWorkflow(a.store);
                const { store: _store, ...input } = a;
                const result = await handler(w, input);
                return textResult({ store: w.store.alias, shop: w.store.shop, apiVersion: w.store.apiVersion, ...result }, false, write);
            }
            catch (error) {
                return failure(w, error, write);
            }
        });
    }
    // 1. Prices (one store or several)
    server.registerTool("shopify_update_prices", {
        description: "Set price, compareAtPrice and/or unit cost for up to 250 SKUs on one store (store) or the same list on several stores in parallel (stores). Resolves each SKU to the variants whose SKU matches exactly (Shopify search is a prefix match) and groups writes by product. A SKU shared by several variants is skipped unless allowDuplicates:true. Duplicate SKU rows with conflicting values are rejected before any write; identical duplicates are collapsed. After a write, verifies each variant with a separate read-back query and reports per-item outcome (applied, applied_unverified, rejected, not_found, ambiguous, unknown, skipped, mismatch) and a store status (ok, unverified, partial, failed, unknown). Large results are trimmed, never dropped: status, counts and every item that did not apply are always returned. Defaults to dryRun:true.",
        inputSchema: z
            .object({
            store: store.optional().describe("One store alias. Give store or stores."),
            stores: z.array(store).min(1).max(50).optional().describe("Several store aliases; each store gets its own outcome."),
            skus: skusField,
            allowDuplicates: allowDuplicatesField,
            dryRun: dryRunField,
        })
            .strict(),
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
        },
    }, async (args) => {
        const a = args;
        const write = !a.dryRun;
        if (Boolean(a.store) === Boolean(a.stores))
            return toolError(new Error("Give exactly one of store or stores."));
        if (a.store) {
            let w;
            try {
                w = await parityWorkflow(a.store);
                const result = await updatePricesCore(w, { skus: a.skus, dryRun: a.dryRun, allowDuplicates: a.allowDuplicates });
                return textResult({ store: w.store.alias, shop: w.store.shop, apiVersion: w.store.apiVersion, ...result }, false, write);
            }
            catch (error) {
                return failure(w, error, write);
            }
        }
        try {
            // Refuses two aliases for one shop, so no price change runs twice.
            const requested = (await resolveStoreTargets(a.stores)).map((target) => target.store?.alias ?? target.requestedAlias);
            const results = await mapConcurrent(requested, async (alias) => {
                try {
                    const w = await parityWorkflow(alias);
                    const result = await updatePricesCore(w, {
                        skus: a.skus,
                        dryRun: a.dryRun,
                        allowDuplicates: a.allowDuplicates,
                    });
                    // The store is ok only when its own status is ok: "unverified" (read-back failed)
                    // and "partial" are not.
                    const ok = a.dryRun ? true : result.status === "ok";
                    return { store: w.store.alias, ok, ...result };
                }
                catch (error) {
                    return {
                        store: alias,
                        ok: false,
                        status: "failed",
                        error: error instanceof Error ? error.message : String(error),
                        ...(error instanceof WorkflowError ? error.details : {}),
                    };
                }
            }, 5);
            return textResult({
                dryRun: a.dryRun,
                stores: results,
                succeeded: results.filter((r) => r.ok).length,
                unverified: results.filter((r) => !r.ok && r.status === "unverified").length,
                failed: results.filter((r) => !r.ok).length,
            }, false, write);
        }
        catch (error) {
            return toolError(error, write);
        }
    });
    // 2. Metafields
    register("metafields", "Set (metafieldsSet) and/or delete (metafieldsDelete) up to 25 metafields each, for any owner GID. Read them with shopify_get resource metafields. Defaults to dryRun:true.", {
        set: z
            .array(z
            .object({
            ownerId: anyGid,
            namespace: z.string().min(1).default("custom"),
            key: z.string().min(1),
            value: z.string().min(1),
            type: z.string().min(1).optional(),
        })
            .strict())
            .min(1)
            .max(25)
            .optional(),
        delete: z
            .array(z
            .object({
            ownerId: anyGid,
            namespace: z.string().min(1),
            key: z.string().min(1),
        })
            .strict())
            .min(1)
            .max(25)
            .optional(),
    }, true, async (w, a) => {
        if (!a.set?.length && !a.delete?.length)
            throw Error("Supply set and/or delete.");
        if (a.dryRun)
            return {
                dryRun: true,
                ...(a.set ? { wouldSet: a.set } : {}),
                ...(a.delete ? { wouldDelete: a.delete } : {}),
                notice: "Pass dryRun:false to apply.",
            };
        const out = { dryRun: false };
        if (a.set?.length) {
            const d = await w.run(PDOCS.metafieldsSet, { metafields: a.set });
            out.metafields = d.metafieldsSet?.metafields;
        }
        if (a.delete?.length) {
            const d = await w.run(PDOCS.metafieldsDelete, { metafields: a.delete });
            out.deletedMetafields = d.metafieldsDelete?.deletedMetafields;
        }
        return out;
    });
    // 3. Redirects
    register("redirects", "Create and/or delete up to 100 URL redirects each, with a per-redirect outcome (applied, rejected or unknown) and a store status. List them with shopify_search resource redirects. Requires write_online_store_navigation. Defaults to dryRun:true.", {
        create: z
            .array(z
            .object({ path: z.string().min(1), target: z.string().min(1) })
            .strict())
            .min(1)
            .max(100)
            .optional(),
        delete: z.array(gid("UrlRedirect")).min(1).max(100).optional().describe("Redirect IDs to delete."),
    }, true, async (w, a) => {
        if (!a.create?.length && !a.delete?.length)
            throw Error("Supply create and/or delete.");
        await w.requireScopes(["write_online_store_navigation"]);
        if (a.dryRun)
            return {
                dryRun: true,
                ...(a.create ? { wouldCreate: a.create } : {}),
                ...(a.delete ? { wouldDelete: a.delete } : {}),
                notice: "Pass dryRun:false to apply.",
            };
        const results = [];
        for (const r of a.create ?? []) {
            try {
                const d = await w.run(PDOCS.createRedirect, { urlRedirect: r });
                results.push({ action: "create", ...r, ...itemOutcome("applied"), urlRedirect: d.urlRedirectCreate?.urlRedirect });
            }
            catch (error) {
                results.push({ action: "create", ...r, ...failedItem(error) });
            }
        }
        for (const id of a.delete ?? []) {
            try {
                const d = await w.run(PDOCS.deleteRedirect, { id });
                results.push({
                    action: "delete",
                    id,
                    ...itemOutcome("applied"),
                    deletedUrlRedirectId: d.urlRedirectDelete?.deletedUrlRedirectId,
                });
            }
            catch (error) {
                results.push({ action: "delete", id, ...failedItem(error) });
            }
        }
        return itemSummary(results);
    });
    // 4. Orders
    register("update_order", "Update order note, email, shipping address and tags (orderUpdate). dryRun:true (the default) returns the current order and the change without applying it; dryRun:false applies it and returns before and after. Tags: addTags and removeTags change only the named tags; replaceTags replaces all tags. Requires write_orders.", {
        id: gid("Order"),
        ...tagFields,
        note: z.string().max(5000).nullable().optional(),
        email: z.string().email().optional(),
        shippingAddress: z
            .object({
            address1: z.string().optional(),
            address2: z.string().optional(),
            city: z.string().optional(),
            company: z.string().optional(),
            countryCode: z.string().optional(),
            firstName: z.string().optional(),
            lastName: z.string().optional(),
            phone: z.string().optional(),
            provinceCode: z.string().optional(),
            zip: z.string().optional(),
        })
            .strict()
            .optional(),
    }, true, async (w, a) => {
        checkTagArgs(a);
        await w.requireScopes(["write_orders"]);
        const before = await w.run(PDOCS.getOrderTagsNote, { id: a.id });
        if (!before.order)
            throw Error("Order not found in this store.");
        const fields = { ...pick(a, ORDER_INPUT_FIELDS), ...(a.replaceTags ? { tags: a.replaceTags } : {}) };
        if (a.dryRun)
            return {
                dryRun: true,
                before: before.order,
                wouldApply: { ...pick(a, ORDER_INPUT_FIELDS), ...tagPreview(a, before.order.tags) },
                notice: "Pass dryRun:false to apply.",
            };
        if (Object.keys(fields).length)
            await w.run(PDOCS.updateOrder, { input: { id: a.id, ...fields } });
        await applyTagChanges(w, a.id, a);
        const after = await w.run(PDOCS.getOrderTagsNote, { id: a.id });
        return { dryRun: false, before: before.order, after: after.order };
    });
    register("tags", "Add and/or remove tags on a product, order, customer or draft order by GID (tagsAdd/tagsRemove). Defaults to dryRun:true.", {
        ownerId: anyGid,
        add: z.array(z.string().min(1)).max(50).optional(),
        remove: z.array(z.string().min(1)).max(50).optional(),
    }, true, async (w, a) => {
        if (!a.add?.length && !a.remove?.length)
            throw Error("Supply add and/or remove tags.");
        if (a.dryRun)
            return {
                dryRun: true,
                wouldAdd: a.add ?? [],
                wouldRemove: a.remove ?? [],
                notice: "Pass dryRun:false to apply.",
            };
        let node;
        if (a.add?.length) {
            const d = await w.run(PDOCS.tagsAdd, { id: a.ownerId, tags: a.add });
            node = d.tagsAdd?.node;
        }
        if (a.remove?.length) {
            const d = await w.run(PDOCS.tagsRemove, {
                id: a.ownerId,
                tags: a.remove,
            });
            node = d.tagsRemove?.node;
        }
        return { dryRun: false, node };
    });
    // 5. Customers
    register("update_customer", "Update customer note, email and tags (customerUpdate). dryRun:true (the default) returns the current customer and the change without applying it; dryRun:false applies it and returns before and after. Tags: addTags and removeTags change only the named tags; replaceTags replaces all tags. Email marketing consent is out of scope. Requires write_customers.", {
        id: gid("Customer"),
        ...tagFields,
        note: z.string().max(5000).optional(),
        email: z.string().email().optional(),
    }, true, async (w, a) => {
        checkTagArgs(a);
        await w.requireScopes(["write_customers"]);
        const before = await w.run(PDOCS.getCustomer, { id: a.id });
        if (!before.customer)
            throw Error("Customer not found in this store.");
        const fields = { ...pick(a, CUSTOMER_INPUT_FIELDS), ...(a.replaceTags ? { tags: a.replaceTags } : {}) };
        if (a.dryRun)
            return {
                dryRun: true,
                before: before.customer,
                wouldApply: { ...pick(a, CUSTOMER_INPUT_FIELDS), ...tagPreview(a, before.customer.tags) },
                notice: "Pass dryRun:false to apply.",
            };
        if (Object.keys(fields).length)
            await w.run(PDOCS.updateCustomer, { input: { id: a.id, ...fields } });
        await applyTagChanges(w, a.id, a);
        const after = await w.run(PDOCS.getCustomer, { id: a.id });
        return { dryRun: false, before: before.customer, after: after.customer };
    });
    // 6. Fulfillment
    register("create_fulfillment", "Fulfill the remaining quantities of an order's OPEN and IN_PROGRESS fulfillment orders with optional tracking. notifyCustomer defaults to false. Requires read_merchant_managed_fulfillment_orders and write_merchant_managed_fulfillment_orders (Shopify reports any other missing scope, such as for fulfillment orders assigned to a fulfillment service). Defaults to dryRun:true.", {
        orderId: gid("Order"),
        trackingNumber: z.string().min(1).optional(),
        trackingCompany: z.string().min(1).optional(),
        trackingUrl: z.string().url().optional(),
        notifyCustomer: z.boolean().default(false),
    }, true, async (w, a) => {
        // No local scope check: the scope Shopify needs depends on who the fulfillment
        // orders are assigned to (merchant-managed or a fulfillment service), so Shopify's own
        // access error is the accurate one. scope-requirements.ts lists the merchant-managed
        // scopes for shopify_check_access.
        const d = await w.run(PDOCS.getOrderFulfillmentOrders, { id: a.orderId });
        if (!d.order)
            throw Error("Order not found in this store.");
        // IN_PROGRESS fulfillment orders are partially fulfilled; fulfill what remains.
        const open = (d.order.fulfillmentOrders?.nodes ?? [])
            .filter((fo) => fo.status === "OPEN" || fo.status === "IN_PROGRESS")
            .map((fo) => ({
            id: fo.id,
            status: fo.status,
            // With more line items than one page, omit them so Shopify fulfills everything remaining.
            lineItems: fo.lineItems?.pageInfo?.hasNextPage
                ? undefined
                : (fo.lineItems?.nodes ?? [])
                    .filter((li) => li.remainingQuantity > 0)
                    .map((li) => ({ id: li.id, quantity: li.remainingQuantity })),
        }))
            .filter((fo) => fo.lineItems === undefined || fo.lineItems.length > 0);
        if (!open.length)
            throw Error("No open or in-progress fulfillment orders with remaining quantity on this order.");
        if (a.dryRun)
            return {
                dryRun: true,
                openFulfillmentOrders: open.map((o) => o.id),
                fulfillmentOrders: open,
                notifyCustomer: a.notifyCustomer,
                notice: "Pass dryRun:false to apply.",
            };
        const fulfillment = {
            notifyCustomer: a.notifyCustomer,
            lineItemsByFulfillmentOrder: open.map((o) => ({
                fulfillmentOrderId: o.id,
                ...(o.lineItems ? { fulfillmentOrderLineItems: o.lineItems } : {}),
            })),
            ...(a.trackingNumber || a.trackingCompany || a.trackingUrl
                ? {
                    trackingInfo: {
                        number: a.trackingNumber,
                        company: a.trackingCompany,
                        url: a.trackingUrl,
                    },
                }
                : {}),
        };
        const result = await w.run(PDOCS.createFulfillment, { fulfillment });
        return {
            dryRun: false,
            fulfillment: result.fulfillmentCreateV2?.fulfillment,
        };
    });
    // 7. Access-scope diagnostics
    server.registerTool("shopify_check_access", {
        description: "For one or many stores, report the shop identity and granted Admin API access scopes, compare them against every tool's requirement (see src/scope-requirements.ts; tools with several resources or reports are listed as tool:resource), and report missing scopes and which tools would fail. Omit stores to check every configured store.",
        inputSchema: z
            .object({ stores: z.array(store).min(1).max(50).optional() })
            .strict(),
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async (args) => {
        const a = args;
        try {
            const aliases = (await resolveStoreTargets(a.stores)).map((target) => target.store?.alias ?? target.requestedAlias);
            const results = await mapConcurrent(aliases, async (alias) => {
                try {
                    const w = await parityWorkflow(alias);
                    const data = await w.run(PDOCS.capabilities);
                    const granted = new Set((data.currentAppInstallation?.accessScopes ?? []).map((s) => s.handle));
                    const hasScope = (s) => granted.has(s) ||
                        (s.startsWith("read_") &&
                            granted.has(s.replace(/^read_/, "write_")));
                    const failingTools = Object.entries(REQUIRED_SCOPES)
                        .map(([tool, required]) => ({
                        tool,
                        missingScopes: required.filter((s) => !hasScope(s)),
                    }))
                        .filter((t) => t.missingScopes.length);
                    return {
                        store: w.store.alias,
                        ok: true,
                        shop: data.shop,
                        grantedScopes: [...granted].sort(),
                        missingScopes: [
                            ...new Set(failingTools.flatMap((t) => t.missingScopes)),
                        ].sort(),
                        failingTools,
                        variableScopeTools: Object.entries(VARIABLE_SCOPE_TOOLS).map(([tool, note]) => ({ tool, note })),
                    };
                }
                catch (error) {
                    return {
                        store: alias,
                        ok: false,
                        error: error instanceof Error ? error.message : String(error),
                    };
                }
            }, 5);
            return textResult({ stores: results });
        }
        catch (error) {
            return toolError(error);
        }
    });
}
//# sourceMappingURL=parity-tools.js.map