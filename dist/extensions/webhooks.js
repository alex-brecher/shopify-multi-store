import { z } from "zod/v4";
import { registerGetResource, registerManageOperation, registerSearchResource } from "../extension-registry.js";
import { runtimeEnv, storeScope } from "../runtime.js";
// Webhook subscriptions of this server's Shopify app. Shopify shows an app only the
// subscriptions it created, so subscriptions made by other apps or in the admin are not listed.
const FIELDS = "id topic name uri format filter includeFields metafieldNamespaces apiVersion { handle } createdAt updatedAt";
const NOTE = "Shopify shows an app only the webhook subscriptions it created; other apps' subscriptions are not listed.";
const TOPIC = /^[A-Z][A-Z0-9_]{2,80}$/;
/** Where Shopify can deliver: an HTTPS URL, a Google Pub/Sub topic, or an Amazon EventBridge source. */
export function validWebhookUri(uri) {
    if (/^pubsub:\/\/[a-z0-9-]+:[A-Za-z0-9._~%+-]+$/.test(uri))
        return true;
    if (/^arn:aws:events:[a-z0-9-]+::event-source\/aws\.partner\/shopify\.com(\.test)?\/\d+\/[A-Za-z0-9._\/-]+$/.test(uri))
        return true;
    try {
        const url = new URL(uri);
        return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
    }
    catch {
        return false;
    }
}
export const WEBHOOK_DOCS = {
    list: `query ListWebhooks($first: Int!, $after: String, $query: String) {
  webhookSubscriptions(first: $first, after: $after, query: $query) { nodes { ${FIELDS} } pageInfo { hasNextPage endCursor } }
}`,
    get: `query GetWebhook($id: ID!) { webhookSubscription(id: $id) { ${FIELDS} } }`,
    same: `query SameWebhooks($topics: [WebhookSubscriptionTopic!], $uri: String) {
  webhookSubscriptions(first: 10, topics: $topics, uri: $uri) { nodes { id topic uri } }
}`,
    create: `mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { ${FIELDS} } userErrors { field message } }
}`,
    update: `mutation UpdateWebhook($id: ID!, $sub: WebhookSubscriptionInput!) {
  webhookSubscriptionUpdate(id: $id, webhookSubscription: $sub) { webhookSubscription { ${FIELDS} } userErrors { field message } }
}`,
    delete: `mutation DeleteWebhook($id: ID!) { webhookSubscriptionDelete(id: $id) { deletedWebhookSubscriptionId userErrors { field message } } }`,
};
registerSearchResource("webhooks", {
    document: WEBHOOK_DOCS.list,
    scopes: [],
    description: `This app's webhook subscriptions (query: such as "topic:ORDERS_CREATE"). ${NOTE}`,
});
registerGetResource("webhook", {
    document: WEBHOOK_DOCS.get,
    root: "webhookSubscription",
    types: ["WebhookSubscription"],
    label: "Webhook subscription",
    scopes: [],
    description: "One webhook subscription of this app. id: WebhookSubscription GID.",
});
/**
 * SHOPIFY_WEBHOOK_ALLOWED_HOSTS (comma list of host names; a leading "." also allows subdomains)
 * limits where webhooks may deliver. A subscription belongs to the app, not to the person who made
 * it, and keeps delivering store data after that person loses access, so a team server should
 * name its own receivers. Pub/Sub and EventBridge targets are allowed only with "pubsub" or
 * "eventbridge" in the list.
 */
export function webhookTargetAllowed(uri, env = runtimeEnv()) {
    const allowed = (env.SHOPIFY_WEBHOOK_ALLOWED_HOSTS ?? "").split(/[\s,;]+/).map((host) => host.trim().toLowerCase()).filter(Boolean);
    if (!allowed.length)
        return true;
    if (uri.startsWith("pubsub://"))
        return allowed.includes("pubsub");
    if (uri.startsWith("arn:aws:events:"))
        return allowed.includes("eventbridge");
    const host = new URL(uri).hostname.toLowerCase();
    return allowed.some((entry) => (entry.startsWith(".") ? host.endsWith(entry) || host === entry.slice(1) : host === entry));
}
function checkTarget(uri) {
    if (uri && !webhookTargetAllowed(uri))
        throw Error(`This server only delivers webhooks to ${runtimeEnv().SHOPIFY_WEBHOOK_ALLOWED_HOSTS} (SHOPIFY_WEBHOOK_ALLOWED_HOSTS). No request sent.`);
}
/** The subscription name records who created or last changed it, so a stray subscription can be traced. */
function signedName(name) {
    const user = storeScope.getStore()?.user;
    const base = (name ?? "").replace(/\s*\(by [^)]*\)$/, "").trim();
    if (!user)
        return base || undefined;
    return `${base ? `${base} ` : ""}(by ${user})`.slice(0, 100);
}
function subscriptionInput(a) {
    const input = {};
    for (const key of ["uri", "format", "filter", "includeFields", "metafieldNamespaces", "name"])
        if (a[key] !== undefined)
            input[key] = a[key];
    return input;
}
registerManageOperation("webhook", {
    description: `Create, update or delete one of this app's webhook subscriptions (webhookSubscriptionCreate / Update / Delete). Deliver to an HTTPS URL, Google Pub/Sub (pubsub://project:topic) or Amazon EventBridge. A subscription keeps sending store data to its uri until it is deleted, whoever made it, so create, and an update that changes uri, need confirm:"webhook"; delete needs confirm:"delete". create refuses a duplicate topic and uri. The name records who made the change. ${NOTE}`,
    shape: {
        action: z.enum(["create", "update", "delete"]),
        id: z.string().regex(/^gid:\/\/shopify\/WebhookSubscription\/[0-9]+$/).optional().describe("update and delete"),
        topic: z.string().max(80).optional().describe("create: such as ORDERS_CREATE or PRODUCTS_UPDATE"),
        uri: z.string().max(2000).refine(validWebhookUri, "uri must be an https:// URL without user name or password, pubsub://project:topic, or an EventBridge event source ARN").optional(),
        format: z.enum(["JSON", "XML"]).optional(),
        filter: z.string().max(1000).optional().describe("Shopify search filter, such as \"status:active\""),
        includeFields: z.array(z.string().min(1).max(100)).max(100).optional(),
        metafieldNamespaces: z.array(z.string().min(1).max(100)).max(50).optional(),
        name: z.string().max(100).optional(),
    },
    scopes: [],
    confirmWord: (a) => (a.action === "delete" ? "delete" : a.action === "create" || (a.action === "update" && a.uri !== undefined) ? "webhook" : undefined),
    handler: async (w, a) => {
        if (a.action === "create") {
            const topic = String(a.topic ?? "").toUpperCase();
            if (!TOPIC.test(topic))
                throw Error("create needs topic, such as ORDERS_CREATE.");
            if (!a.uri)
                throw Error("create needs uri.");
            checkTarget(a.uri);
            const input = { format: "JSON", ...subscriptionInput(a), name: signedName(a.name) };
            const duplicates = (await w.run(WEBHOOK_DOCS.same, { topics: [topic], uri: a.uri })).webhookSubscriptions?.nodes ?? [];
            if (duplicates.length)
                throw Error(`This app already sends ${topic} to that uri (${duplicates.map((item) => item.id).join(", ")}). Update or delete that subscription instead.`);
            if (a.dryRun)
                return { dryRun: true, wouldCreate: { topic, ...input }, message: "Nothing was changed. Pass dryRun:false to apply." };
            const d = await w.run(WEBHOOK_DOCS.create, { topic, sub: input });
            return { dryRun: false, created: d.webhookSubscriptionCreate?.webhookSubscription };
        }
        if (!a.id)
            throw Error(`${a.action} needs id.`);
        const current = (await w.run(WEBHOOK_DOCS.get, { id: a.id })).webhookSubscription;
        if (!current)
            throw Error(`No webhook subscription ${a.id} on this store belongs to this app.`);
        if (a.action === "update") {
            checkTarget(a.uri);
            const fields = subscriptionInput(a);
            if (!Object.keys(fields).length)
                throw Error("update needs at least one of uri, format, filter, includeFields, metafieldNamespaces or name.");
            const input = { ...fields, name: signedName(a.name ?? current.name ?? undefined) };
            if (a.dryRun)
                return { dryRun: true, current, changes: input, message: "Nothing was changed. Pass dryRun:false to apply." };
            const d = await w.run(WEBHOOK_DOCS.update, { id: a.id, sub: input });
            return { dryRun: false, before: current, updated: d.webhookSubscriptionUpdate?.webhookSubscription };
        }
        if (a.dryRun)
            return { dryRun: true, wouldDelete: current, message: "Nothing was changed. Pass dryRun:false and confirm:\"delete\" to apply." };
        const d = await w.run(WEBHOOK_DOCS.delete, { id: a.id });
        return { dryRun: false, deleted: d.webhookSubscriptionDelete?.deletedWebhookSubscriptionId, was: current };
    },
});
//# sourceMappingURL=webhooks.js.map