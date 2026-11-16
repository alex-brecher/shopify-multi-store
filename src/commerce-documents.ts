// Admin GraphQL documents for the commerce tools (commerce-tools.ts) and the extra
// shopify_get / shopify_search resources (read-tools.ts). Every document is validated
// against the bundled Admin schema before it runs (Workflow.run), and the tests run each
// one through that validation, so a field that does not exist fails before any request.
//
// Coverage was modelled on the tool list of GeLi2001/shopify-mcp (MIT). The documents
// are written for this repo; no code was copied (see THIRD_PARTY_NOTICES.md).

const PAGE = `pageInfo { hasNextPage endCursor }`;
const MONEY = `shopMoney { amount currencyCode }`;
const BAG = `shopMoney { amount currencyCode } presentmentMoney { amount currencyCode }`;
const ADDRESS = `id firstName lastName company address1 address2 city provinceCode countryCodeV2 zip phone`;
const DRAFT_FIELDS = `id name status email note2 tags invoiceUrl createdAt updatedAt completedAt order { id name } customer { id displayName email } subtotalPriceSet { ${MONEY} } totalTaxSet { ${MONEY} } totalShippingPriceSet { ${MONEY} } totalPriceSet { ${MONEY} }`;
const DRAFT_LINES = `lineItems(first:100) { nodes { id title quantity sku variant { id } originalUnitPriceSet { ${MONEY} } discountedTotalSet { ${MONEY} } } ${PAGE} }`;
const ORDER_STATE = `id name closed closedAt cancelledAt cancelReason canMarkAsPaid displayFinancialStatus displayFulfillmentStatus currentTotalPriceSet { ${MONEY} } totalOutstandingSet { ${MONEY} }`;
const VARIANT_DETAIL = `id title sku barcode price compareAtPrice position taxable taxCode inventoryPolicy inventoryQuantity availableForSale createdAt updatedAt selectedOptions { name value } image { url altText } inventoryItem { id tracked requiresShipping countryCodeOfOrigin provinceCodeOfOrigin harmonizedSystemCode unitCost { amount currencyCode } measurement { weight { value unit } } }`;

export const CDOCS = {
  // ---- reads: shopify_get ----
  customer: `query CommerceCustomer($id:ID!, $first:Int!, $after:String) { customer(id:$id) { id displayName firstName lastName email phone note tags state locale taxExempt verifiedEmail createdAt updatedAt numberOfOrders amountSpent { amount currencyCode } defaultAddress { ${ADDRESS} } addressesV2(first:25) { nodes { ${ADDRESS} } } emailMarketingConsent { marketingState consentUpdatedAt } orders(first:$first, after:$after, sortKey:CREATED_AT, reverse:true) { nodes { id name createdAt displayFinancialStatus displayFulfillmentStatus currentTotalPriceSet { ${MONEY} } } ${PAGE} } } }`,
  draftOrder: `query CommerceDraftOrder($id:ID!) { draftOrder(id:$id) { ${DRAFT_FIELDS} shippingAddress { ${ADDRESS} } ${DRAFT_LINES} } }`,
  orderTransactions: `query CommerceOrderTransactions($id:ID!) { order(id:$id) { id name displayFinancialStatus totalReceivedSet { ${MONEY} } totalRefundedSet { ${MONEY} } transactions(first:100) { id kind status gateway test errorCode createdAt processedAt authorizationCode parentTransaction { id kind } amountSet { ${MONEY} } } } }`,
  orderRefunds: `query CommerceOrderRefunds($id:ID!) { order(id:$id) { id name totalRefundedSet { ${MONEY} } refunds(first:50) { id createdAt note totalRefundedSet { ${MONEY} } refundLineItems(first:100) { nodes { quantity restockType restocked location { id name } lineItem { id title sku } subtotalSet { ${MONEY} } totalTaxSet { ${MONEY} } } ${PAGE} } transactions(first:20) { nodes { id kind status gateway amountSet { ${MONEY} } } } } } }`,
  fulfillmentOrders: `query CommerceFulfillmentOrders($id:ID!, $first:Int!, $after:String) { order(id:$id) { id name fulfillmentOrders(first:$first, after:$after) { nodes { id status requestStatus createdAt updatedAt fulfillAt fulfillBy assignedLocation { name location { id } } deliveryMethod { methodType } fulfillmentHolds { reason reasonNotes } lineItems(first:100) { nodes { id sku productTitle variantTitle totalQuantity remainingQuantity } ${PAGE} } } ${PAGE} } } }`,
  variants: `query CommerceVariants($id:ID!, $first:Int!, $after:String) { product(id:$id) { id title options { id name position optionValues { id name } } variants(first:$first, after:$after) { nodes { ${VARIANT_DETAIL} } ${PAGE} } } }`,

  // ---- reads: shopify_search ----
  listLocations: `query CommerceLocations($first:Int!, $after:String, $query:String) { locations(first:$first, after:$after, query:$query, includeInactive:true) { nodes { id name isActive fulfillsOnlineOrders shipsInventory hasActiveInventory address { address1 address2 city provinceCode countryCode zip phone } } ${PAGE} } }`,
  listPriceLists: `query CommercePriceLists($first:Int!, $after:String) { priceLists(first:$first, after:$after) { nodes { id name currency fixedPricesCount parent { adjustment { type value } } catalog { id title status } } ${PAGE} } }`,
  listMetafieldDefinitions: `query CommerceMetafieldDefinitions($type:MetafieldOwnerType!, $first:Int!, $after:String, $query:String) { metafieldDefinitions(ownerType:$type, first:$first, after:$after, query:$query) { nodes { id name namespace key description ownerType type { name } validations { name value } pinnedPosition } ${PAGE} } }`,
  listDraftOrders: `query CommerceDraftOrders($first:Int!, $after:String, $query:String) { draftOrders(first:$first, after:$after, query:$query, sortKey:UPDATED_AT, reverse:true) { nodes { ${DRAFT_FIELDS} } ${PAGE} } }`,

  // ---- variants and options ----
  productShape: `query CommerceProductShape($id:ID!) { product(id:$id) { id title status options { id name position optionValues { id name hasVariants } } variants(first:250) { nodes { id title sku price compareAtPrice selectedOptions { name value } } pageInfo { hasNextPage } } } }`,
  variantsCreate: `mutation CommerceVariantsCreate($productId:ID!, $variants:[ProductVariantsBulkInput!]!, $strategy:ProductVariantsBulkCreateStrategy) { productVariantsBulkCreate(productId:$productId, variants:$variants, strategy:$strategy) { productVariants { id title sku price } userErrors { field message } } }`,
  variantsUpdate: `mutation CommerceVariantsUpdate($productId:ID!, $variants:[ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId:$productId, variants:$variants) { productVariants { id title sku price } userErrors { field message } } }`,
  variantsDelete: `mutation CommerceVariantsDelete($productId:ID!, $variantsIds:[ID!]!) { productVariantsBulkDelete(productId:$productId, variantsIds:$variantsIds) { product { id } userErrors { field message } } }`,
  optionsCreate: `mutation CommerceOptionsCreate($productId:ID!, $options:[OptionCreateInput!]!, $variantStrategy:ProductOptionCreateVariantStrategy) { productOptionsCreate(productId:$productId, options:$options, variantStrategy:$variantStrategy) { product { id options { id name position optionValues { id name } } } userErrors { field message } } }`,
  optionUpdate: `mutation CommerceOptionUpdate($productId:ID!, $option:OptionUpdateInput!, $optionValuesToAdd:[OptionValueCreateInput!], $optionValuesToUpdate:[OptionValueUpdateInput!], $optionValuesToDelete:[ID!], $variantStrategy:ProductOptionUpdateVariantStrategy) { productOptionUpdate(productId:$productId, option:$option, optionValuesToAdd:$optionValuesToAdd, optionValuesToUpdate:$optionValuesToUpdate, optionValuesToDelete:$optionValuesToDelete, variantStrategy:$variantStrategy) { product { id options { id name position optionValues { id name } } } userErrors { field message } } }`,
  optionsDelete: `mutation CommerceOptionsDelete($productId:ID!, $options:[ID!]!, $strategy:ProductOptionDeleteStrategy) { productOptionsDelete(productId:$productId, options:$options, strategy:$strategy) { deletedOptionsIds product { id } userErrors { field message } } }`,

  // ---- deletes ----
  productSummary: `query CommerceProductSummary($id:ID!) { product(id:$id) { id title handle status totalInventory variantsCount { count } } }`,
  productDelete: `mutation CommerceProductDelete($input:ProductDeleteInput!) { productDelete(input:$input, synchronous:true) { deletedProductId userErrors { field message } } }`,
  customerSummary: `query CommerceCustomerSummary($id:ID!) { customer(id:$id) { id displayName email numberOfOrders amountSpent { amount currencyCode } } }`,
  customerDelete: `mutation CommerceCustomerDelete($input:CustomerDeleteInput!) { customerDelete(input:$input) { deletedCustomerId userErrors { field message } } }`,

  // ---- customers ----
  customerCreate: `mutation CommerceCustomerCreate($input:CustomerInput!) { customerCreate(input:$input) { customer { id displayName firstName lastName email phone tags note taxExempt } userErrors { field message } } }`,
  customerAddresses: `query CommerceCustomerAddresses($id:ID!) { customer(id:$id) { id displayName defaultAddress { id } addressesV2(first:50) { nodes { ${ADDRESS} } } } }`,
  addressCreate: `mutation CommerceAddressCreate($customerId:ID!, $address:MailingAddressInput!, $setAsDefault:Boolean) { customerAddressCreate(customerId:$customerId, address:$address, setAsDefault:$setAsDefault) { address { ${ADDRESS} } userErrors { field message } } }`,
  addressUpdate: `mutation CommerceAddressUpdate($customerId:ID!, $addressId:ID!, $address:MailingAddressInput!, $setAsDefault:Boolean) { customerAddressUpdate(customerId:$customerId, addressId:$addressId, address:$address, setAsDefault:$setAsDefault) { address { ${ADDRESS} } userErrors { field message } } }`,
  addressDefault: `mutation CommerceAddressDefault($customerId:ID!, $addressId:ID!) { customerUpdateDefaultAddress(customerId:$customerId, addressId:$addressId) { customer { id defaultAddress { id } } userErrors { field message } } }`,
  addressDelete: `mutation CommerceAddressDelete($customerId:ID!, $addressId:ID!) { customerAddressDelete(customerId:$customerId, addressId:$addressId) { deletedAddressId userErrors { field message } } }`,
  mergePreview: `query CommerceMergePreview($one:ID!, $two:ID!, $overrideFields:CustomerMergeOverrideFields) { customerMergePreview(customerOneId:$one, customerTwoId:$two, overrideFields:$overrideFields) { resultingCustomerId blockingFields { note tags } customerMergeErrors { errorFields message } defaultFields { firstName lastName displayName email { emailAddress } phoneNumber { phoneNumber } note tags } } }`,
  customerMerge: `mutation CommerceCustomerMerge($one:ID!, $two:ID!, $overrideFields:CustomerMergeOverrideFields) { customerMerge(customerOneId:$one, customerTwoId:$two, overrideFields:$overrideFields) { resultingCustomerId job { id done } userErrors { field message code } } }`,

  // ---- draft orders ----
  shopCurrency: `query CommerceShopCurrency { shop { currencyCode } }`,
  draftCalculate: `mutation CommerceDraftCalculate($input:DraftOrderInput!) { draftOrderCalculate(input:$input) { calculatedDraftOrder { currencyCode subtotalPriceSet { ${MONEY} } totalTaxSet { ${MONEY} } totalShippingPriceSet { ${MONEY} } totalPriceSet { ${MONEY} } lineItems { title quantity sku variant { id } originalUnitPriceSet { ${MONEY} } discountedTotalSet { ${MONEY} } } } userErrors { field message } } }`,
  draftCreate: `mutation CommerceDraftCreate($input:DraftOrderInput!) { draftOrderCreate(input:$input) { draftOrder { ${DRAFT_FIELDS} } userErrors { field message } } }`,
  draftComplete: `mutation CommerceDraftComplete($id:ID!, $paymentGatewayId:ID) { draftOrderComplete(id:$id, paymentGatewayId:$paymentGatewayId) { draftOrder { id status order { id name displayFinancialStatus } } userErrors { field message } } }`,

  // ---- order lifecycle and refunds ----
  orderState: `query CommerceOrderState($id:ID!) { order(id:$id) { ${ORDER_STATE} } }`,
  orderCancel: `mutation CommerceOrderCancel($orderId:ID!, $reason:OrderCancelReason!, $restock:Boolean!, $refundMethod:OrderCancelRefundMethodInput, $notifyCustomer:Boolean, $staffNote:String) { orderCancel(orderId:$orderId, reason:$reason, restock:$restock, refundMethod:$refundMethod, notifyCustomer:$notifyCustomer, staffNote:$staffNote) { job { id done } orderCancelUserErrors { field message code } } }`,
  orderClose: `mutation CommerceOrderClose($input:OrderCloseInput!) { orderClose(input:$input) { order { id closed closedAt } userErrors { field message } } }`,
  orderOpen: `mutation CommerceOrderOpen($input:OrderOpenInput!) { orderOpen(input:$input) { order { id closed closedAt } userErrors { field message } } }`,
  orderMarkAsPaid: `mutation CommerceOrderMarkAsPaid($input:OrderMarkAsPaidInput!) { orderMarkAsPaid(input:$input) { order { id displayFinancialStatus totalOutstandingSet { ${MONEY} } } userErrors { field message } } }`,
  suggestedRefund: `query CommerceSuggestedRefund($id:ID!, $refundLineItems:[RefundLineItemInput!], $refundShipping:Boolean, $shippingAmount:Money) { order(id:$id) { id name presentmentCurrencyCode totalRefundedSet { ${MONEY} } suggestedRefund(refundLineItems:$refundLineItems, refundShipping:$refundShipping, shippingAmount:$shippingAmount) { amountSet { ${BAG} } subtotalSet { ${BAG} } totalTaxSet { ${BAG} } shipping { amountSet { ${BAG} } maximumRefundableSet { ${BAG} } } refundLineItems { quantity restockType lineItem { id title sku } subtotalSet { ${BAG} } } suggestedTransactions { kind gateway amountSet { ${BAG} } maximumRefundableSet { ${BAG} } parentTransaction { id kind } } } } }`,
  refundCreate: `mutation CommerceRefundCreate($input:RefundInput!) { refundCreate(input:$input) { refund { id createdAt note totalRefundedSet { ${MONEY} } transactions(first:10) { nodes { id kind status gateway amountSet { ${MONEY} } } } } order { id displayFinancialStatus } userErrors { field message } } }`,
} as const;
