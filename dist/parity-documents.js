// Fixed GraphQL operations for the parity tools. Each is validated in tests against the
// bundled Admin API schema (see PARITY_API_VERSION in parity-tools.ts).
export const PAGE = `pageInfo { hasNextPage endCursor }`;
export const PDOCS = {
    capabilities: `query ParityCapabilities { shop { id myshopifyDomain } currentAppInstallation { id accessScopes { handle } } }`,
    // Prices
    // Candidate pass: Shopify's sku: search is a prefix match, so fetch a full page of slim
    // candidates, filter to exact SKUs in code, then load details for the exact matches only.
    findVariantsBySku: `query FindVariantsBySku($query:String!, $after:String) { productVariants(first:250, after:$after, query:$query) { nodes { id sku } ${PAGE} } }`,
    variantsForPricing: `query VariantsForPricing($ids:[ID!]!) { nodes(ids:$ids) { ... on ProductVariant { id sku price compareAtPrice product { id title } inventoryItem { id sku unitCost { amount currencyCode } } } } }`,
    variantsBulkUpdatePrices: `mutation UpdatePricesBulk($productId:ID!, $variants:[ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId:$productId, variants:$variants) { productVariants { id sku price compareAtPrice inventoryItem { id sku unitCost { amount currencyCode } } } userErrors { field message } } }`,
    // Metafields
    getMetafields: `query GetMetafields($id:ID!, $first:Int!, $after:String, $namespace:String) { node(id:$id) { id ... on HasMetafields { metafields(first:$first, after:$after, namespace:$namespace) { nodes { id namespace key value type } ${PAGE} } } } }`,
    metafieldsSet: `mutation SetMetafields($metafields:[MetafieldsSetInput!]!) { metafieldsSet(metafields:$metafields) { metafields { id namespace key value type } userErrors { field message code } } }`,
    metafieldsDelete: `mutation DeleteMetafields($metafields:[MetafieldIdentifierInput!]!) { metafieldsDelete(metafields:$metafields) { deletedMetafields { ownerId namespace key } userErrors { field message } } }`,
    // Metaobjects
    listMetaobjects: `query ListMetaobjects($type:String!, $first:Int!, $after:String) { metaobjects(type:$type, first:$first, after:$after) { nodes { id handle type displayName updatedAt fields { key value type } } ${PAGE} } }`,
    // Redirects
    listRedirects: `query ListRedirects($query:String, $first:Int!, $after:String) { urlRedirects(first:$first, after:$after, query:$query) { nodes { id path target } ${PAGE} } }`,
    createRedirect: `mutation CreateRedirect($urlRedirect:UrlRedirectInput!) { urlRedirectCreate(urlRedirect:$urlRedirect) { urlRedirect { id path target } userErrors { field message } } }`,
    deleteRedirect: `mutation DeleteRedirect($id:ID!) { urlRedirectDelete(id:$id) { deletedUrlRedirectId userErrors { field message } } }`,
    // Delivery profiles
    listDeliveryProfiles: `query ListDeliveryProfiles($first:Int!, $after:String) { deliveryProfiles(first:$first, after:$after) { nodes { id name default profileLocationGroups { locationGroup { id locations(first:10) { nodes { id name } } } locationGroupZones(first:20) { nodes { zone { id name countries { name code { countryCode restOfWorld } } } methodDefinitions(first:20) { nodes { id name active rateProvider { ... on DeliveryRateDefinition { id price { amount currencyCode } } } } } } } } } ${PAGE} } }`,
    // Themes
    listThemes: `query ListThemes($first:Int!, $after:String) { themes(first:$first, after:$after) { nodes { id name role createdAt updatedAt } ${PAGE} } }`,
    getThemeFiles: `query GetThemeFiles($id:ID!, $filenames:[String!], $first:Int!, $after:String) { theme(id:$id) { id name role files(filenames:$filenames, first:$first, after:$after) { nodes { filename checksumMd5 contentType size body { ... on OnlineStoreThemeFileBodyText { content } ... on OnlineStoreThemeFileBodyBase64 { contentBase64 } } } ${PAGE} } } }`,
    // Files
    listFiles: `query ListFiles($query:String, $first:Int!, $after:String) { files(first:$first, after:$after, query:$query) { nodes { id alt fileStatus createdAt ... on GenericFile { url mimeType originalFileSize } ... on MediaImage { image { url } } } ${PAGE} } }`,
    // Orders
    getOrderTagsNote: `query GetOrderTagsNote($id:ID!) { order(id:$id) { id name tags note email } }`,
    updateOrder: `mutation UpdateOrder($input:OrderInput!) { orderUpdate(input:$input) { order { id name tags note email } userErrors { field message } } }`,
    getOrderFulfillmentOrders: `query GetOrderFulfillmentOrders($id:ID!) { order(id:$id) { id name fulfillmentOrders(first:50) { nodes { id status lineItems(first:250) { nodes { id remainingQuantity } pageInfo { hasNextPage } } } } } }`,
    createFulfillment: `mutation CreateFulfillment($fulfillment:FulfillmentV2Input!) { fulfillmentCreateV2(fulfillment:$fulfillment) { fulfillment { id status trackingInfo { company number url } } userErrors { field message } } }`,
    // Generic tags
    tagsAdd: `mutation AddTags($id:ID!, $tags:[String!]!) { tagsAdd(id:$id, tags:$tags) { node { id ... on Product { tags } ... on Order { tags } ... on Customer { tags } ... on DraftOrder { tags } } userErrors { field message } } }`,
    tagsRemove: `mutation RemoveTags($id:ID!, $tags:[String!]!) { tagsRemove(id:$id, tags:$tags) { node { id ... on Product { tags } ... on Order { tags } ... on Customer { tags } ... on DraftOrder { tags } } userErrors { field message } } }`,
    // Customers
    getCustomer: `query GetCustomer($id:ID!) { customer(id:$id) { id displayName email tags note } }`,
    updateCustomer: `mutation UpdateCustomer($input:CustomerInput!) { customerUpdate(input:$input) { customer { id displayName email tags note } userErrors { field message } } }`,
    // Pages
    listPages: `query ListPages($query:String, $first:Int!, $after:String) { pages(first:$first, after:$after, query:$query) { nodes { id handle title isPublished updatedAt } ${PAGE} } }`,
    // Blog articles
    listBlogArticles: `query ListBlogArticles($id:ID!, $first:Int!, $after:String) { blog(id:$id) { id title articles(first:$first, after:$after) { nodes { id handle title isPublished publishedAt } ${PAGE} } } }`,
    // Markets
    listMarkets: `query ListMarkets($first:Int!, $after:String) { markets(first:$first, after:$after) { nodes { id name handle type status enabled primary } ${PAGE} } }`,
};
//# sourceMappingURL=parity-documents.js.map