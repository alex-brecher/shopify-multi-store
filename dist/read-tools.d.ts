import { McpServer } from "@modelcontextprotocol/server";
/** Everything shopify_search lists. Keep in step with scope-requirements.ts. */
export declare const SEARCH_RESOURCES: {
    readonly products: {
        readonly document: "query SearchProducts($query: String, $first: Int!, $after: String) { shop { currencyCode } products(first:$first, after:$after, query:$query) { nodes { id title handle descriptionHtml status vendor productType tags totalInventory updatedAt options { id name values } featuredMedia { id alt preview { image { url } } } } pageInfo { hasNextPage endCursor } } }";
        readonly scopes: [];
        readonly description: "Products (query: Shopify product search syntax).";
    };
    readonly collections: {
        readonly document: "query SearchCollections($query: String, $first: Int!, $after: String) { collections(first:$first, after:$after, query:$query) { nodes { id title handle descriptionHtml sortOrder updatedAt productsCount { count precision } image { url altText } ruleSet { appliedDisjunctively rules { column relation condition } } } pageInfo { hasNextPage endCursor } } }";
        readonly scopes: [];
        readonly description: "Manual and smart collections.";
    };
    readonly orders: {
        readonly document: "query ListOrders($query: String, $first: Int!, $after: String) { orders(first:$first, after:$after, query:$query, sortKey:CREATED_AT, reverse:true) { nodes { id name createdAt updatedAt displayFinancialStatus displayFulfillmentStatus currentTotalPriceSet { shopMoney { amount currencyCode } } customer { id displayName } } pageInfo { hasNextPage endCursor } } }";
        readonly scopes: [];
        readonly description: "Orders, newest first (query: Shopify order search syntax).";
    };
    readonly customers: {
        readonly document: "query ListCustomers($query: String, $first: Int!, $after: String) { customers(first:$first, after:$after, query:$query) { nodes { id displayName firstName lastName email phone numberOfOrders amountSpent { amount currencyCode } } pageInfo { hasNextPage endCursor } } }";
        readonly scopes: [];
        readonly description: "Customers. Protected customer data permissions apply.";
    };
    readonly publications: {
        readonly document: "query Publications($after:String) { publications(first:100,after:$after) { nodes { id name } pageInfo { hasNextPage endCursor } } }";
        readonly scopes: [];
        readonly description: "Sales channel publication IDs (no query; 100 per page).";
    };
    readonly redirects: {
        readonly document: "query ListRedirects($query:String, $first:Int!, $after:String) { urlRedirects(first:$first, after:$after, query:$query) { nodes { id path target } pageInfo { hasNextPage endCursor } } }";
        readonly scopes: ["read_online_store_navigation"];
        readonly pinned: true;
        readonly description: "URL redirects.";
    };
    readonly pages: {
        readonly document: "query ListPages($query:String, $first:Int!, $after:String) { pages(first:$first, after:$after, query:$query) { nodes { id handle title isPublished updatedAt } pageInfo { hasNextPage endCursor } } }";
        readonly scopes: ["read_content"];
        readonly pinned: true;
        readonly description: "Online Store pages.";
    };
    readonly files: {
        readonly document: "query ListFiles($query:String, $first:Int!, $after:String) { files(first:$first, after:$after, query:$query) { nodes { id alt fileStatus createdAt ... on GenericFile { url mimeType originalFileSize } ... on MediaImage { image { url } } } pageInfo { hasNextPage endCursor } } }";
        readonly scopes: ["read_files"];
        readonly pinned: true;
        readonly description: "Files (images, videos, generic files).";
    };
    readonly metaobjects: {
        readonly document: "query ListMetaobjects($type:String!, $first:Int!, $after:String) { metaobjects(type:$type, first:$first, after:$after) { nodes { id handle type displayName updatedAt fields { key value type } } pageInfo { hasNextPage endCursor } } }";
        readonly scopes: ["read_metaobjects"];
        readonly pinned: true;
        readonly requires: "type";
        readonly description: "Metaobjects of one type (type required).";
    };
    readonly markets: {
        readonly document: "query ListMarkets($first:Int!, $after:String) { markets(first:$first, after:$after) { nodes { id name handle type status enabled primary } pageInfo { hasNextPage endCursor } } }";
        readonly scopes: ["read_markets"];
        readonly pinned: true;
        readonly description: "Markets (no query).";
    };
    readonly themes: {
        readonly document: "query ListThemes($first:Int!, $after:String) { themes(first:$first, after:$after) { nodes { id name role createdAt updatedAt } pageInfo { hasNextPage endCursor } } }";
        readonly scopes: ["read_themes"];
        readonly pinned: true;
        readonly description: "Themes with their role; MAIN is live (no query).";
    };
    readonly delivery_profiles: {
        readonly document: "query ListDeliveryProfiles($first:Int!, $after:String) { deliveryProfiles(first:$first, after:$after) { nodes { id name default profileLocationGroups { locationGroup { id locations(first:10) { nodes { id name } } } locationGroupZones(first:20) { nodes { zone { id name countries { name code { countryCode restOfWorld } } } methodDefinitions(first:20) { nodes { id name active rateProvider { ... on DeliveryRateDefinition { id price { amount currencyCode } } } } } } } } } pageInfo { hasNextPage endCursor } } }";
        readonly scopes: ["read_shipping"];
        readonly pinned: true;
        readonly description: "Delivery profiles with zones, methods and flat rates (no query).";
    };
};
export type SearchResource = keyof typeof SEARCH_RESOURCES;
/** Everything shopify_get reads by ID. Keep in step with scope-requirements.ts. */
export declare const GET_RESOURCES: {
    readonly product: "Product details, variants (first/after) and media (mediaAfter). id: Product GID.";
    readonly collection: "Collection details, rules and a page of products. id: Collection GID.";
    readonly order: "Order, shipping, fulfillment, tracking and a page of line items. id: Order GID.";
    readonly inventory: "Inventory by product (id: Product GID) or inventory item (id: InventoryItem GID, pages through locations).";
    readonly metafields: "Metafields of any owner (id: owner GID); optional namespace and key.";
    readonly theme_files: "Theme file contents. id: OnlineStoreTheme GID; optional filenames, else pages through every file.";
    readonly blog_articles: "A blog's articles. id: Blog GID.";
    readonly uploaded_image: "Image processing status and CDN URL. id: MediaImage GID.";
    readonly bulk_operation: "A bulk operation's status and result URLs. id: BulkOperation GID. Partial exports stay marked incomplete.";
};
export type GetResource = keyof typeof GET_RESOURCES;
export declare function registerReadTools(server: McpServer): void;
