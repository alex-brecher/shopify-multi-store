// Each operation is validated against the pinned Shopify schema during CI.
export const PRODUCT_FIELDS = `id title handle descriptionHtml status vendor productType tags totalInventory updatedAt options { id name values } featuredMedia { id alt preview { image { url } } }`;
export const VARIANT_FIELDS = `id title sku barcode price compareAtPrice inventoryQuantity selectedOptions { name value } inventoryItem { id tracked }`;
export const COLLECTION_FIELDS = `id title handle descriptionHtml sortOrder updatedAt productsCount { count precision } image { url altText } ruleSet { appliedDisjunctively rules { column relation condition } }`;
export const ORDER_FIELDS = `id name createdAt updatedAt displayFinancialStatus displayFulfillmentStatus currentTotalPriceSet { shopMoney { amount currencyCode } }`;
export const PAGE = `pageInfo { hasNextPage endCursor }`;
export const DOCS = {
  shop: `query StoreIdentity { shop { id name myshopifyDomain email currencyCode ianaTimezone billingAddress { countryCodeV2 } plan { displayName } } }`,
  capabilities: `query StoreCapabilities { shop { id name myshopifyDomain } currentAppInstallation { id accessScopes { handle } } }`,
  products: `query SearchProducts($query: String, $first: Int!, $after: String) { shop { currencyCode } products(first:$first, after:$after, query:$query) { nodes { ${PRODUCT_FIELDS} } ${PAGE} } }`,
  product: `query GetProduct($id: ID!, $first: Int!, $after: String, $mediaAfter: String) { shop { currencyCode } product(id:$id) { ${PRODUCT_FIELDS} variants(first:$first, after:$after) { nodes { ${VARIANT_FIELDS} } ${PAGE} } media(first:50, after:$mediaAfter) { nodes { id alt mediaContentType status preview { image { url } } } ${PAGE} } } }`,
  collections: `query SearchCollections($query: String, $first: Int!, $after: String) { collections(first:$first, after:$after, query:$query) { nodes { ${COLLECTION_FIELDS} } ${PAGE} } }`,
  collection: `query GetCollection($id: ID!, $first: Int!, $after: String) { shop { currencyCode } collection(id:$id) { ${COLLECTION_FIELDS} products(first:$first, after:$after) { nodes { id title status featuredMedia { preview { image { url } } } priceRangeV2 { minVariantPrice { amount currencyCode } } } ${PAGE} } } }`,
  orders: `query ListOrders($query: String, $first: Int!, $after: String) { orders(first:$first, after:$after, query:$query, sortKey:CREATED_AT, reverse:true) { nodes { ${ORDER_FIELDS} customer { id displayName } } ${PAGE} } }`,
  order: `query GetOrder($id: ID!, $first: Int!, $after: String) { order(id:$id) { ${ORDER_FIELDS} shippingAddress { name address1 address2 city provinceCode countryCodeV2 zip } customer { id displayName email } lineItems(first:$first, after:$after) { nodes { id title quantity sku variant { id } } ${PAGE} } fulfillments { id status trackingInfo { company number url } } } }`,
  customers: `query ListCustomers($query: String, $first: Int!, $after: String) { customers(first:$first, after:$after, query:$query) { nodes { id displayName firstName lastName email phone numberOfOrders amountSpent { amount currencyCode } } ${PAGE} } }`,
  inventory: `query ProductInventory($id: ID!, $first: Int!, $after: String) { product(id:$id) { id title variants(first:$first, after:$after) { nodes { id title inventoryItem { id tracked inventoryLevels(first:50) { nodes { id location { id name } quantities(names:["available","on_hand","committed"]) { name quantity } } ${PAGE} } } } ${PAGE} } } }`,
  inventoryItem: `query InventoryItemLevels($id:ID!, $first:Int!, $after:String) { inventoryItem(id:$id) { id tracked inventoryLevels(first:$first,after:$after) { nodes { id location { id name } quantities(names:["available","on_hand","committed"]) { name quantity } } ${PAGE} } } }`,
  inventoryAt: `query InventoryAtLocation($id:ID!, $location:ID!) { inventoryItem(id:$id) { id tracked inventoryLevel(locationId:$location) { location { id name } quantities(names:["available"]) { name quantity } } } }`,
  setInventory: `mutation SetInventory($input:InventorySetQuantitiesInput!, $idempotencyKey:String!) { inventorySetQuantities(input:$input) @idempotent(key:$idempotencyKey) { inventoryAdjustmentGroup { createdAt changes { name delta quantityAfterChange } } userErrors { field message code } } }`,
  productCreate: `mutation CreateProduct($input:ProductCreateInput!, $media:[CreateMediaInput!]) { productCreate(product:$input,media:$media) { product { id title status } userErrors { field message } } }`,
  productUpdate: `mutation UpdateProduct($input:ProductUpdateInput!, $media:[CreateMediaInput!]) { productUpdate(product:$input,media:$media) { product { id title status } userErrors { field message } } }`,
  variantsCreate: `mutation CreateVariants($productId:ID!, $variants:[ProductVariantsBulkInput!]!) { productVariantsBulkCreate(productId:$productId,variants:$variants,strategy:REMOVE_STANDALONE_VARIANT) { productVariants { id title price } userErrors { field message } } }`,
  variantsUpdate: `mutation UpdateVariants($productId:ID!, $variants:[ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId:$productId,variants:$variants) { productVariants { id title price } userErrors { field message } } }`,
  mediaDelete: `mutation DeleteProductMedia($productId:ID!, $mediaIds:[ID!]!) { productDeleteMedia(productId:$productId,mediaIds:$mediaIds) { deletedMediaIds mediaUserErrors { field message } } }`,
  collectionCreate: `mutation CreateCollection($input:CollectionInput!) { collectionCreate(input:$input) { collection { id title } userErrors { field message } } }`,
  collectionUpdate: `mutation UpdateCollection($input:CollectionInput!) { collectionUpdate(input:$input) { collection { id title } userErrors { field message } } }`,
  addCollection: `mutation AddToCollection($id:ID!, $productIds:[ID!]!) { collectionAddProducts(id:$id,productIds:$productIds) { collection { id title } userErrors { field message } } }`,
  publications: `query Publications($after:String) { publications(first:100,after:$after) { nodes { id name } ${PAGE} } }`,
  publicationRead: `query PublicationRead($id:ID!, $publicationId:ID!) { node(id:$id) { ... on Product { id publishedOnPublication(publicationId:$publicationId) } ... on Collection { id publishedOnPublication(publicationId:$publicationId) } } }`,
  publish: `mutation PublishResource($id:ID!, $input:[PublicationInput!]!) { publishablePublish(id:$id,input:$input) { userErrors { field message } } }`,
  discount: `mutation CreateDiscount($input:DiscountCodeBasicInput!) { discountCodeBasicCreate(basicCodeDiscount:$input) { codeDiscountNode { id } userErrors { field message code } } }`,
  discountRead: `query ReadDiscount($id:ID!) { codeDiscountNode(id:$id) { id codeDiscount { ... on DiscountCodeBasic { title startsAt endsAt status } } } }`,
  segments: `query Segments($after:String) { segments(first:100,after:$after) { nodes { id name } ${PAGE} } }`,
  analytics: `query Analytics($query:String!) { shop { currencyCode ianaTimezone } shopifyqlQuery(query:$query) { tableData { columns { name dataType displayName } rows } parseErrors } }`,
  stage: `mutation StageFile($input:[StagedUploadInput!]!) { stagedUploadsCreate(input:$input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } } }`,
  file: `mutation CreateFile($files:[FileCreateInput!]!) { fileCreate(files:$files) { files { id fileStatus } userErrors { field message code } } }`,
  fileRead: `query GetFile($id:ID!) { node(id:$id) { ... on MediaImage { id fileStatus fileErrors { code message } image { url altText } } } }`,
  bulkStart: `mutation StartBulkQuery($query:String!) { bulkOperationRunQuery(query:$query) { bulkOperation { id status } userErrors { field message } } }`,
  bulkRead: `query BulkStatus($id:ID!) { node(id:$id) { ... on BulkOperation { id status errorCode objectCount rootObjectCount fileSize url partialDataUrl createdAt completedAt } } }`,
} as const;
