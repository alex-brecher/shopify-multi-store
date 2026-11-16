// Every feature area that adds shopify_search / shopify_get resources or shopify_manage
// operations through src/extension-registry.ts. Import order sets the order they are listed in.
import "./webhooks.js";
import "./content.js";
import "./metaobjects.js";
import "./drafts-files.js";
import "./fulfillment.js";
import "./discounts.js";
