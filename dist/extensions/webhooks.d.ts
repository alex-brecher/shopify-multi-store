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
