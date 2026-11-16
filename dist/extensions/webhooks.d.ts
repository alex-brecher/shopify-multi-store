/** Where Shopify can deliver: an HTTPS URL, a Google Pub/Sub topic, or an Amazon EventBridge source. */
export declare function validWebhookUri(uri: string): boolean;
export declare const WEBHOOK_DOCS: {
    list: string;
    get: string;
    same: string;
    create: string;
    update: string;
    delete: string;
};
/**
 * SHOPIFY_WEBHOOK_ALLOWED_HOSTS (comma list of host names; a leading "." also allows subdomains)
 * limits where webhooks may deliver. A subscription belongs to the app, not to the person who made
 * it, and keeps delivering store data after that person loses access, so a team server should
 * name its own receivers. Pub/Sub and EventBridge targets are allowed only with "pubsub" or
 * "eventbridge" in the list.
 */
export declare function webhookTargetAllowed(uri: string, env?: Readonly<Record<string, string | undefined>>): boolean;
