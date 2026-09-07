/* eslint-disable eslint-comments/disable-enable-pair */
/* eslint-disable eslint-comments/no-unlimited-disable */
/* eslint-disable */
import type * as AdminTypes from './admin.types.js';

export type AddToCollectionMutationVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
  productIds: Array<AdminTypes.Scalars['ID']['input']> | AdminTypes.Scalars['ID']['input'];
}>;


export type AddToCollectionMutation = { collectionAddProducts?: AdminTypes.Maybe<{ collection?: AdminTypes.Maybe<Pick<AdminTypes.Collection, 'id' | 'title'>>, userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }> };

export type SearchProductsQueryVariables = AdminTypes.Exact<{
  query?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
  first: AdminTypes.Scalars['Int']['input'];
  after?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type SearchProductsQuery = { shop: Pick<AdminTypes.Shop, 'currencyCode'>, products: { nodes: Array<(
      Pick<AdminTypes.Product, 'id' | 'title' | 'handle' | 'descriptionHtml' | 'status' | 'vendor' | 'productType' | 'tags' | 'totalInventory' | 'updatedAt'>
      & { options: Array<Pick<AdminTypes.ProductOption, 'id' | 'name' | 'values'>>, featuredMedia?: AdminTypes.Maybe<(
        Pick<AdminTypes.ExternalVideo, 'id' | 'alt'>
        & { preview?: AdminTypes.Maybe<{ image?: AdminTypes.Maybe<Pick<AdminTypes.Image, 'url'>> }> }
      ) | (
        Pick<AdminTypes.MediaImage, 'id' | 'alt'>
        & { preview?: AdminTypes.Maybe<{ image?: AdminTypes.Maybe<Pick<AdminTypes.Image, 'url'>> }> }
      ) | (
        Pick<AdminTypes.Model3d, 'id' | 'alt'>
        & { preview?: AdminTypes.Maybe<{ image?: AdminTypes.Maybe<Pick<AdminTypes.Image, 'url'>> }> }
      ) | (
        Pick<AdminTypes.Video, 'id' | 'alt'>
        & { preview?: AdminTypes.Maybe<{ image?: AdminTypes.Maybe<Pick<AdminTypes.Image, 'url'>> }> }
      )> }
    )>, pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'> } };

export type DeleteProductMediaMutationVariables = AdminTypes.Exact<{
  productId: AdminTypes.Scalars['ID']['input'];
  mediaIds: Array<AdminTypes.Scalars['ID']['input']> | AdminTypes.Scalars['ID']['input'];
}>;


export type DeleteProductMediaMutation = { productDeleteMedia?: AdminTypes.Maybe<(
    Pick<AdminTypes.ProductDeleteMediaPayload, 'deletedMediaIds'>
    & { mediaUserErrors: Array<Pick<AdminTypes.MediaUserError, 'field' | 'message'>> }
  )> };

export type GetCollectionQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
  first: AdminTypes.Scalars['Int']['input'];
  after?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type GetCollectionQuery = { shop: Pick<AdminTypes.Shop, 'currencyCode'>, collection?: AdminTypes.Maybe<(
    Pick<AdminTypes.Collection, 'id' | 'title' | 'handle' | 'descriptionHtml' | 'sortOrder' | 'updatedAt'>
    & { productsCount?: AdminTypes.Maybe<Pick<AdminTypes.Count, 'count' | 'precision'>>, image?: AdminTypes.Maybe<Pick<AdminTypes.Image, 'url' | 'altText'>>, ruleSet?: AdminTypes.Maybe<(
      Pick<AdminTypes.CollectionRuleSet, 'appliedDisjunctively'>
      & { rules: Array<Pick<AdminTypes.CollectionRule, 'column' | 'relation' | 'condition'>> }
    )>, products: { nodes: Array<(
        Pick<AdminTypes.Product, 'id' | 'title' | 'status'>
        & { featuredMedia?: AdminTypes.Maybe<{ preview?: AdminTypes.Maybe<{ image?: AdminTypes.Maybe<Pick<AdminTypes.Image, 'url'>> }> }>, priceRangeV2: { minVariantPrice: Pick<AdminTypes.MoneyV2, 'amount' | 'currencyCode'> } }
      )>, pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'> } }
  )> };

export type StageFileMutationVariables = AdminTypes.Exact<{
  input: Array<AdminTypes.StagedUploadInput> | AdminTypes.StagedUploadInput;
}>;


export type StageFileMutation = { stagedUploadsCreate?: AdminTypes.Maybe<{ stagedTargets?: AdminTypes.Maybe<Array<(
      Pick<AdminTypes.StagedMediaUploadTarget, 'url' | 'resourceUrl'>
      & { parameters: Array<Pick<AdminTypes.StagedUploadParameter, 'name' | 'value'>> }
    )>>, userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }> };

export type CreateDiscountMutationVariables = AdminTypes.Exact<{
  input: AdminTypes.DiscountCodeBasicInput;
}>;


export type CreateDiscountMutation = { discountCodeBasicCreate?: AdminTypes.Maybe<{ codeDiscountNode?: AdminTypes.Maybe<Pick<AdminTypes.DiscountCodeNode, 'id'>>, userErrors: Array<Pick<AdminTypes.DiscountUserError, 'field' | 'message' | 'code'>> }> };

export type AnalyticsQueryVariables = AdminTypes.Exact<{
  query: AdminTypes.Scalars['String']['input'];
}>;


export type AnalyticsQuery = { shop: Pick<AdminTypes.Shop, 'currencyCode' | 'ianaTimezone'>, shopifyqlQuery?: AdminTypes.Maybe<(
    Pick<AdminTypes.ShopifyqlQueryResponse, 'parseErrors'>
    & { tableData?: AdminTypes.Maybe<(
      Pick<AdminTypes.ShopifyqlTableData, 'rows'>
      & { columns: Array<Pick<AdminTypes.ShopifyqlTableDataColumn, 'name' | 'dataType' | 'displayName'>> }
    )> }
  )> };

export type GetOrderQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
  first: AdminTypes.Scalars['Int']['input'];
  after?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type GetOrderQuery = { order?: AdminTypes.Maybe<(
    Pick<AdminTypes.Order, 'id' | 'name' | 'createdAt' | 'updatedAt' | 'displayFinancialStatus' | 'displayFulfillmentStatus'>
    & { currentTotalPriceSet: { shopMoney: Pick<AdminTypes.MoneyV2, 'amount' | 'currencyCode'> }, shippingAddress?: AdminTypes.Maybe<Pick<AdminTypes.MailingAddress, 'name' | 'address1' | 'address2' | 'city' | 'provinceCode' | 'countryCodeV2' | 'zip'>>, customer?: AdminTypes.Maybe<Pick<AdminTypes.Customer, 'id' | 'displayName' | 'email'>>, lineItems: { nodes: Array<(
        Pick<AdminTypes.LineItem, 'id' | 'title' | 'quantity' | 'sku'>
        & { variant?: AdminTypes.Maybe<Pick<AdminTypes.ProductVariant, 'id'>> }
      )>, pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'> }, fulfillments: Array<(
      Pick<AdminTypes.Fulfillment, 'id' | 'status'>
      & { trackingInfo: Array<Pick<AdminTypes.FulfillmentTrackingInfo, 'company' | 'number' | 'url'>> }
    )> }
  )> };

export type InventoryAtLocationQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
  location: AdminTypes.Scalars['ID']['input'];
}>;


export type InventoryAtLocationQuery = { inventoryItem?: AdminTypes.Maybe<(
    Pick<AdminTypes.InventoryItem, 'id' | 'tracked'>
    & { inventoryLevel?: AdminTypes.Maybe<{ location: Pick<AdminTypes.Location, 'id' | 'name'>, quantities: Array<Pick<AdminTypes.InventoryQuantity, 'name' | 'quantity'>> }> }
  )> };

export type PublishResourceMutationVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
  input: Array<AdminTypes.PublicationInput> | AdminTypes.PublicationInput;
}>;


export type PublishResourceMutation = { publishablePublish?: AdminTypes.Maybe<{ userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }> };

export type ListOrdersQueryVariables = AdminTypes.Exact<{
  query?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
  first: AdminTypes.Scalars['Int']['input'];
  after?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type ListOrdersQuery = { orders: { nodes: Array<(
      Pick<AdminTypes.Order, 'id' | 'name' | 'createdAt' | 'updatedAt' | 'displayFinancialStatus' | 'displayFulfillmentStatus'>
      & { currentTotalPriceSet: { shopMoney: Pick<AdminTypes.MoneyV2, 'amount' | 'currencyCode'> }, customer?: AdminTypes.Maybe<Pick<AdminTypes.Customer, 'id' | 'displayName'>> }
    )>, pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'> } };

export type ProductInventoryQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
  first: AdminTypes.Scalars['Int']['input'];
  after?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type ProductInventoryQuery = { product?: AdminTypes.Maybe<(
    Pick<AdminTypes.Product, 'id' | 'title'>
    & { variants: { nodes: Array<(
        Pick<AdminTypes.ProductVariant, 'id' | 'title'>
        & { inventoryItem: (
          Pick<AdminTypes.InventoryItem, 'id' | 'tracked'>
          & { inventoryLevels: { nodes: Array<(
              Pick<AdminTypes.InventoryLevel, 'id'>
              & { location: Pick<AdminTypes.Location, 'id' | 'name'>, quantities: Array<Pick<AdminTypes.InventoryQuantity, 'name' | 'quantity'>> }
            )>, pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'> } }
        ) }
      )>, pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'> } }
  )> };

export type UpdateProductMutationVariables = AdminTypes.Exact<{
  input: AdminTypes.ProductUpdateInput;
  media?: AdminTypes.InputMaybe<Array<AdminTypes.CreateMediaInput> | AdminTypes.CreateMediaInput>;
}>;


export type UpdateProductMutation = { productUpdate?: AdminTypes.Maybe<{ product?: AdminTypes.Maybe<Pick<AdminTypes.Product, 'id' | 'title' | 'status'>>, userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }> };

export type BulkStatusQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
}>;


export type BulkStatusQuery = { node?: AdminTypes.Maybe<Pick<AdminTypes.BulkOperation, 'id' | 'status' | 'errorCode' | 'objectCount' | 'rootObjectCount' | 'fileSize' | 'url' | 'partialDataUrl' | 'createdAt' | 'completedAt'>> };

export type StartBulkQueryMutationVariables = AdminTypes.Exact<{
  query: AdminTypes.Scalars['String']['input'];
}>;


export type StartBulkQueryMutation = { bulkOperationRunQuery?: AdminTypes.Maybe<{ bulkOperation?: AdminTypes.Maybe<Pick<AdminTypes.BulkOperation, 'id' | 'status'>>, userErrors: Array<Pick<AdminTypes.BulkOperationUserError, 'field' | 'message'>> }> };

export type SetInventoryMutationVariables = AdminTypes.Exact<{
  input: AdminTypes.InventorySetQuantitiesInput;
}>;


export type SetInventoryMutation = { inventorySetQuantities?: AdminTypes.Maybe<{ inventoryAdjustmentGroup?: AdminTypes.Maybe<(
      Pick<AdminTypes.InventoryAdjustmentGroup, 'createdAt'>
      & { changes: Array<Pick<AdminTypes.InventoryChange, 'name' | 'delta' | 'quantityAfterChange'>> }
    )>, userErrors: Array<Pick<AdminTypes.InventorySetQuantitiesUserError, 'field' | 'message' | 'code'>> }> };

export type GetProductQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
  first: AdminTypes.Scalars['Int']['input'];
  after?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
  mediaAfter?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type GetProductQuery = { shop: Pick<AdminTypes.Shop, 'currencyCode'>, product?: AdminTypes.Maybe<(
    Pick<AdminTypes.Product, 'id' | 'title' | 'handle' | 'descriptionHtml' | 'status' | 'vendor' | 'productType' | 'tags' | 'totalInventory' | 'updatedAt'>
    & { options: Array<Pick<AdminTypes.ProductOption, 'id' | 'name' | 'values'>>, featuredMedia?: AdminTypes.Maybe<(
      Pick<AdminTypes.ExternalVideo, 'id' | 'alt'>
      & { preview?: AdminTypes.Maybe<{ image?: AdminTypes.Maybe<Pick<AdminTypes.Image, 'url'>> }> }
    ) | (
      Pick<AdminTypes.MediaImage, 'id' | 'alt'>
      & { preview?: AdminTypes.Maybe<{ image?: AdminTypes.Maybe<Pick<AdminTypes.Image, 'url'>> }> }
    ) | (
      Pick<AdminTypes.Model3d, 'id' | 'alt'>
      & { preview?: AdminTypes.Maybe<{ image?: AdminTypes.Maybe<Pick<AdminTypes.Image, 'url'>> }> }
    ) | (
      Pick<AdminTypes.Video, 'id' | 'alt'>
      & { preview?: AdminTypes.Maybe<{ image?: AdminTypes.Maybe<Pick<AdminTypes.Image, 'url'>> }> }
    )>, variants: { nodes: Array<(
        Pick<AdminTypes.ProductVariant, 'id' | 'title' | 'sku' | 'barcode' | 'price' | 'compareAtPrice' | 'inventoryQuantity'>
        & { selectedOptions: Array<Pick<AdminTypes.SelectedOption, 'name' | 'value'>>, inventoryItem: Pick<AdminTypes.InventoryItem, 'id' | 'tracked'> }
      )>, pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'> }, media: { nodes: Array<(
        Pick<AdminTypes.ExternalVideo, 'id' | 'alt' | 'mediaContentType' | 'status'>
        & { preview?: AdminTypes.Maybe<{ image?: AdminTypes.Maybe<Pick<AdminTypes.Image, 'url'>> }> }
      ) | (
        Pick<AdminTypes.MediaImage, 'id' | 'alt' | 'mediaContentType' | 'status'>
        & { preview?: AdminTypes.Maybe<{ image?: AdminTypes.Maybe<Pick<AdminTypes.Image, 'url'>> }> }
      ) | (
        Pick<AdminTypes.Model3d, 'id' | 'alt' | 'mediaContentType' | 'status'>
        & { preview?: AdminTypes.Maybe<{ image?: AdminTypes.Maybe<Pick<AdminTypes.Image, 'url'>> }> }
      ) | (
        Pick<AdminTypes.Video, 'id' | 'alt' | 'mediaContentType' | 'status'>
        & { preview?: AdminTypes.Maybe<{ image?: AdminTypes.Maybe<Pick<AdminTypes.Image, 'url'>> }> }
      )>, pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'> } }
  )> };

export type InventoryItemLevelsQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
  first: AdminTypes.Scalars['Int']['input'];
  after?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type InventoryItemLevelsQuery = { inventoryItem?: AdminTypes.Maybe<(
    Pick<AdminTypes.InventoryItem, 'id' | 'tracked'>
    & { inventoryLevels: { nodes: Array<(
        Pick<AdminTypes.InventoryLevel, 'id'>
        & { location: Pick<AdminTypes.Location, 'id' | 'name'>, quantities: Array<Pick<AdminTypes.InventoryQuantity, 'name' | 'quantity'>> }
      )>, pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'> } }
  )> };

export type PublicationsQueryVariables = AdminTypes.Exact<{
  after?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type PublicationsQuery = { publications: { nodes: Array<Pick<AdminTypes.Publication, 'id' | 'name'>>, pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'> } };

export type GetFileQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
}>;


export type GetFileQuery = { node?: AdminTypes.Maybe<(
    Pick<AdminTypes.MediaImage, 'id' | 'fileStatus'>
    & { fileErrors: Array<Pick<AdminTypes.FileError, 'code' | 'message'>>, image?: AdminTypes.Maybe<Pick<AdminTypes.Image, 'url' | 'altText'>> }
  )> };

export type UpdateVariantsMutationVariables = AdminTypes.Exact<{
  productId: AdminTypes.Scalars['ID']['input'];
  variants: Array<AdminTypes.ProductVariantsBulkInput> | AdminTypes.ProductVariantsBulkInput;
}>;


export type UpdateVariantsMutation = { productVariantsBulkUpdate?: AdminTypes.Maybe<{ productVariants?: AdminTypes.Maybe<Array<Pick<AdminTypes.ProductVariant, 'id' | 'title' | 'price'>>>, userErrors: Array<Pick<AdminTypes.ProductVariantsBulkUpdateUserError, 'field' | 'message'>> }> };

export type ReadDiscountQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
}>;


export type ReadDiscountQuery = { codeDiscountNode?: AdminTypes.Maybe<(
    Pick<AdminTypes.DiscountCodeNode, 'id'>
    & { codeDiscount: Pick<AdminTypes.DiscountCodeBasic, 'title' | 'startsAt' | 'endsAt' | 'status'> }
  )> };

export type ListCustomersQueryVariables = AdminTypes.Exact<{
  query?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
  first: AdminTypes.Scalars['Int']['input'];
  after?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type ListCustomersQuery = { customers: { nodes: Array<(
      Pick<AdminTypes.Customer, 'id' | 'displayName' | 'firstName' | 'lastName' | 'email' | 'phone' | 'numberOfOrders'>
      & { amountSpent: Pick<AdminTypes.MoneyV2, 'amount' | 'currencyCode'> }
    )>, pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'> } };

export type CreateVariantsMutationVariables = AdminTypes.Exact<{
  productId: AdminTypes.Scalars['ID']['input'];
  variants: Array<AdminTypes.ProductVariantsBulkInput> | AdminTypes.ProductVariantsBulkInput;
}>;


export type CreateVariantsMutation = { productVariantsBulkCreate?: AdminTypes.Maybe<{ productVariants?: AdminTypes.Maybe<Array<Pick<AdminTypes.ProductVariant, 'id' | 'title' | 'price'>>>, userErrors: Array<Pick<AdminTypes.ProductVariantsBulkCreateUserError, 'field' | 'message'>> }> };

export type PublicationReadQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
  publicationId: AdminTypes.Scalars['ID']['input'];
}>;


export type PublicationReadQuery = { node?: AdminTypes.Maybe<Pick<AdminTypes.Collection, 'id' | 'publishedOnPublication'> | Pick<AdminTypes.Product, 'id' | 'publishedOnPublication'>> };

export type SegmentsQueryVariables = AdminTypes.Exact<{
  after?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type SegmentsQuery = { segments: { nodes: Array<Pick<AdminTypes.Segment, 'id' | 'name'>>, pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'> } };

export type StoreCapabilitiesQueryVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type StoreCapabilitiesQuery = { shop: Pick<AdminTypes.Shop, 'id' | 'name' | 'myshopifyDomain'>, currentAppInstallation: (
    Pick<AdminTypes.AppInstallation, 'id'>
    & { accessScopes: Array<Pick<AdminTypes.AccessScope, 'handle'>> }
  ) };

export type SearchCollectionsQueryVariables = AdminTypes.Exact<{
  query?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
  first: AdminTypes.Scalars['Int']['input'];
  after?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type SearchCollectionsQuery = { collections: { nodes: Array<(
      Pick<AdminTypes.Collection, 'id' | 'title' | 'handle' | 'descriptionHtml' | 'sortOrder' | 'updatedAt'>
      & { productsCount?: AdminTypes.Maybe<Pick<AdminTypes.Count, 'count' | 'precision'>>, image?: AdminTypes.Maybe<Pick<AdminTypes.Image, 'url' | 'altText'>>, ruleSet?: AdminTypes.Maybe<(
        Pick<AdminTypes.CollectionRuleSet, 'appliedDisjunctively'>
        & { rules: Array<Pick<AdminTypes.CollectionRule, 'column' | 'relation' | 'condition'>> }
      )> }
    )>, pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'> } };

export type CreateFileMutationVariables = AdminTypes.Exact<{
  files: Array<AdminTypes.FileCreateInput> | AdminTypes.FileCreateInput;
}>;


export type CreateFileMutation = { fileCreate?: AdminTypes.Maybe<{ files?: AdminTypes.Maybe<Array<Pick<AdminTypes.ExternalVideo, 'id' | 'fileStatus'> | Pick<AdminTypes.GenericFile, 'id' | 'fileStatus'> | Pick<AdminTypes.MediaImage, 'id' | 'fileStatus'> | Pick<AdminTypes.Model3d, 'id' | 'fileStatus'> | Pick<AdminTypes.Video, 'id' | 'fileStatus'>>>, userErrors: Array<Pick<AdminTypes.FilesUserError, 'field' | 'message' | 'code'>> }> };

export type CreateProductMutationVariables = AdminTypes.Exact<{
  input: AdminTypes.ProductCreateInput;
  media?: AdminTypes.InputMaybe<Array<AdminTypes.CreateMediaInput> | AdminTypes.CreateMediaInput>;
}>;


export type CreateProductMutation = { productCreate?: AdminTypes.Maybe<{ product?: AdminTypes.Maybe<Pick<AdminTypes.Product, 'id' | 'title' | 'status'>>, userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }> };

export type StoreIdentityQueryVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type StoreIdentityQuery = { shop: (
    Pick<AdminTypes.Shop, 'id' | 'name' | 'myshopifyDomain' | 'email' | 'currencyCode' | 'ianaTimezone'>
    & { billingAddress: Pick<AdminTypes.ShopAddress, 'countryCodeV2'>, plan: Pick<AdminTypes.ShopPlan, 'displayName'> }
  ) };

interface GeneratedQueryTypes {
  "query SearchProducts($query: String, $first: Int!, $after: String) {\n  shop {\n    currencyCode\n  }\n  products(first: $first, after: $after, query: $query) {\n    nodes {\n      id\n      title\n      handle\n      descriptionHtml\n      status\n      vendor\n      productType\n      tags\n      totalInventory\n      updatedAt\n      options {\n        id\n        name\n        values\n      }\n      featuredMedia {\n        id\n        alt\n        preview {\n          image {\n            url\n          }\n        }\n      }\n    }\n    pageInfo {\n      hasNextPage\n      endCursor\n    }\n  }\n}": {return: SearchProductsQuery, variables: SearchProductsQueryVariables},
  "query GetCollection($id: ID!, $first: Int!, $after: String) {\n  shop {\n    currencyCode\n  }\n  collection(id: $id) {\n    id\n    title\n    handle\n    descriptionHtml\n    sortOrder\n    updatedAt\n    productsCount {\n      count\n      precision\n    }\n    image {\n      url\n      altText\n    }\n    ruleSet {\n      appliedDisjunctively\n      rules {\n        column\n        relation\n        condition\n      }\n    }\n    products(first: $first, after: $after) {\n      nodes {\n        id\n        title\n        status\n        featuredMedia {\n          preview {\n            image {\n              url\n            }\n          }\n        }\n        priceRangeV2 {\n          minVariantPrice {\n            amount\n            currencyCode\n          }\n        }\n      }\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n    }\n  }\n}": {return: GetCollectionQuery, variables: GetCollectionQueryVariables},
  "query Analytics($query: String!) {\n  shop {\n    currencyCode\n    ianaTimezone\n  }\n  shopifyqlQuery(query: $query) {\n    tableData {\n      columns {\n        name\n        dataType\n        displayName\n      }\n      rows\n    }\n    parseErrors\n  }\n}": {return: AnalyticsQuery, variables: AnalyticsQueryVariables},
  "query GetOrder($id: ID!, $first: Int!, $after: String) {\n  order(id: $id) {\n    id\n    name\n    createdAt\n    updatedAt\n    displayFinancialStatus\n    displayFulfillmentStatus\n    currentTotalPriceSet {\n      shopMoney {\n        amount\n        currencyCode\n      }\n    }\n    shippingAddress {\n      name\n      address1\n      address2\n      city\n      provinceCode\n      countryCodeV2\n      zip\n    }\n    customer {\n      id\n      displayName\n      email\n    }\n    lineItems(first: $first, after: $after) {\n      nodes {\n        id\n        title\n        quantity\n        sku\n        variant {\n          id\n        }\n      }\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n    }\n    fulfillments {\n      id\n      status\n      trackingInfo {\n        company\n        number\n        url\n      }\n    }\n  }\n}": {return: GetOrderQuery, variables: GetOrderQueryVariables},
  "query InventoryAtLocation($id: ID!, $location: ID!) {\n  inventoryItem(id: $id) {\n    id\n    tracked\n    inventoryLevel(locationId: $location) {\n      location {\n        id\n        name\n      }\n      quantities(names: [\"available\"]) {\n        name\n        quantity\n      }\n    }\n  }\n}": {return: InventoryAtLocationQuery, variables: InventoryAtLocationQueryVariables},
  "query ListOrders($query: String, $first: Int!, $after: String) {\n  orders(\n    first: $first\n    after: $after\n    query: $query\n    sortKey: CREATED_AT\n    reverse: true\n  ) {\n    nodes {\n      id\n      name\n      createdAt\n      updatedAt\n      displayFinancialStatus\n      displayFulfillmentStatus\n      currentTotalPriceSet {\n        shopMoney {\n          amount\n          currencyCode\n        }\n      }\n      customer {\n        id\n        displayName\n      }\n    }\n    pageInfo {\n      hasNextPage\n      endCursor\n    }\n  }\n}": {return: ListOrdersQuery, variables: ListOrdersQueryVariables},
  "query ProductInventory($id: ID!, $first: Int!, $after: String) {\n  product(id: $id) {\n    id\n    title\n    variants(first: $first, after: $after) {\n      nodes {\n        id\n        title\n        inventoryItem {\n          id\n          tracked\n          inventoryLevels(first: 50) {\n            nodes {\n              id\n              location {\n                id\n                name\n              }\n              quantities(names: [\"available\", \"on_hand\", \"committed\"]) {\n                name\n                quantity\n              }\n            }\n            pageInfo {\n              hasNextPage\n              endCursor\n            }\n          }\n        }\n      }\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n    }\n  }\n}": {return: ProductInventoryQuery, variables: ProductInventoryQueryVariables},
  "query BulkStatus($id: ID!) {\n  node(id: $id) {\n    ... on BulkOperation {\n      id\n      status\n      errorCode\n      objectCount\n      rootObjectCount\n      fileSize\n      url\n      partialDataUrl\n      createdAt\n      completedAt\n    }\n  }\n}": {return: BulkStatusQuery, variables: BulkStatusQueryVariables},
  "query GetProduct($id: ID!, $first: Int!, $after: String, $mediaAfter: String) {\n  shop {\n    currencyCode\n  }\n  product(id: $id) {\n    id\n    title\n    handle\n    descriptionHtml\n    status\n    vendor\n    productType\n    tags\n    totalInventory\n    updatedAt\n    options {\n      id\n      name\n      values\n    }\n    featuredMedia {\n      id\n      alt\n      preview {\n        image {\n          url\n        }\n      }\n    }\n    variants(first: $first, after: $after) {\n      nodes {\n        id\n        title\n        sku\n        barcode\n        price\n        compareAtPrice\n        inventoryQuantity\n        selectedOptions {\n          name\n          value\n        }\n        inventoryItem {\n          id\n          tracked\n        }\n      }\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n    }\n    media(first: 50, after: $mediaAfter) {\n      nodes {\n        id\n        alt\n        mediaContentType\n        status\n        preview {\n          image {\n            url\n          }\n        }\n      }\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n    }\n  }\n}": {return: GetProductQuery, variables: GetProductQueryVariables},
  "query InventoryItemLevels($id: ID!, $first: Int!, $after: String) {\n  inventoryItem(id: $id) {\n    id\n    tracked\n    inventoryLevels(first: $first, after: $after) {\n      nodes {\n        id\n        location {\n          id\n          name\n        }\n        quantities(names: [\"available\", \"on_hand\", \"committed\"]) {\n          name\n          quantity\n        }\n      }\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n    }\n  }\n}": {return: InventoryItemLevelsQuery, variables: InventoryItemLevelsQueryVariables},
  "query Publications($after: String) {\n  publications(first: 100, after: $after) {\n    nodes {\n      id\n      name\n    }\n    pageInfo {\n      hasNextPage\n      endCursor\n    }\n  }\n}": {return: PublicationsQuery, variables: PublicationsQueryVariables},
  "query GetFile($id: ID!) {\n  node(id: $id) {\n    ... on MediaImage {\n      id\n      fileStatus\n      fileErrors {\n        code\n        message\n      }\n      image {\n        url\n        altText\n      }\n    }\n  }\n}": {return: GetFileQuery, variables: GetFileQueryVariables},
  "query ReadDiscount($id: ID!) {\n  codeDiscountNode(id: $id) {\n    id\n    codeDiscount {\n      ... on DiscountCodeBasic {\n        title\n        startsAt\n        endsAt\n        status\n      }\n    }\n  }\n}": {return: ReadDiscountQuery, variables: ReadDiscountQueryVariables},
  "query ListCustomers($query: String, $first: Int!, $after: String) {\n  customers(first: $first, after: $after, query: $query) {\n    nodes {\n      id\n      displayName\n      firstName\n      lastName\n      email\n      phone\n      numberOfOrders\n      amountSpent {\n        amount\n        currencyCode\n      }\n    }\n    pageInfo {\n      hasNextPage\n      endCursor\n    }\n  }\n}": {return: ListCustomersQuery, variables: ListCustomersQueryVariables},
  "query PublicationRead($id: ID!, $publicationId: ID!) {\n  node(id: $id) {\n    ... on Product {\n      id\n      publishedOnPublication(publicationId: $publicationId)\n    }\n    ... on Collection {\n      id\n      publishedOnPublication(publicationId: $publicationId)\n    }\n  }\n}": {return: PublicationReadQuery, variables: PublicationReadQueryVariables},
  "query Segments($after: String) {\n  segments(first: 100, after: $after) {\n    nodes {\n      id\n      name\n    }\n    pageInfo {\n      hasNextPage\n      endCursor\n    }\n  }\n}": {return: SegmentsQuery, variables: SegmentsQueryVariables},
  "query StoreCapabilities {\n  shop {\n    id\n    name\n    myshopifyDomain\n  }\n  currentAppInstallation {\n    id\n    accessScopes {\n      handle\n    }\n  }\n}": {return: StoreCapabilitiesQuery, variables: StoreCapabilitiesQueryVariables},
  "query SearchCollections($query: String, $first: Int!, $after: String) {\n  collections(first: $first, after: $after, query: $query) {\n    nodes {\n      id\n      title\n      handle\n      descriptionHtml\n      sortOrder\n      updatedAt\n      productsCount {\n        count\n        precision\n      }\n      image {\n        url\n        altText\n      }\n      ruleSet {\n        appliedDisjunctively\n        rules {\n          column\n          relation\n          condition\n        }\n      }\n    }\n    pageInfo {\n      hasNextPage\n      endCursor\n    }\n  }\n}": {return: SearchCollectionsQuery, variables: SearchCollectionsQueryVariables},
  "query StoreIdentity {\n  shop {\n    id\n    name\n    myshopifyDomain\n    email\n    currencyCode\n    ianaTimezone\n    billingAddress {\n      countryCodeV2\n    }\n    plan {\n      displayName\n    }\n  }\n}": {return: StoreIdentityQuery, variables: StoreIdentityQueryVariables},
}

interface GeneratedMutationTypes {
  "mutation AddToCollection($id: ID!, $productIds: [ID!]!) {\n  collectionAddProducts(id: $id, productIds: $productIds) {\n    collection {\n      id\n      title\n    }\n    userErrors {\n      field\n      message\n    }\n  }\n}": {return: AddToCollectionMutation, variables: AddToCollectionMutationVariables},
  "mutation DeleteProductMedia($productId: ID!, $mediaIds: [ID!]!) {\n  productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {\n    deletedMediaIds\n    mediaUserErrors {\n      field\n      message\n    }\n  }\n}": {return: DeleteProductMediaMutation, variables: DeleteProductMediaMutationVariables},
  "mutation StageFile($input: [StagedUploadInput!]!) {\n  stagedUploadsCreate(input: $input) {\n    stagedTargets {\n      url\n      resourceUrl\n      parameters {\n        name\n        value\n      }\n    }\n    userErrors {\n      field\n      message\n    }\n  }\n}": {return: StageFileMutation, variables: StageFileMutationVariables},
  "mutation CreateDiscount($input: DiscountCodeBasicInput!) {\n  discountCodeBasicCreate(basicCodeDiscount: $input) {\n    codeDiscountNode {\n      id\n    }\n    userErrors {\n      field\n      message\n      code\n    }\n  }\n}": {return: CreateDiscountMutation, variables: CreateDiscountMutationVariables},
  "mutation PublishResource($id: ID!, $input: [PublicationInput!]!) {\n  publishablePublish(id: $id, input: $input) {\n    userErrors {\n      field\n      message\n    }\n  }\n}": {return: PublishResourceMutation, variables: PublishResourceMutationVariables},
  "mutation UpdateProduct($input: ProductUpdateInput!, $media: [CreateMediaInput!]) {\n  productUpdate(product: $input, media: $media) {\n    product {\n      id\n      title\n      status\n    }\n    userErrors {\n      field\n      message\n    }\n  }\n}": {return: UpdateProductMutation, variables: UpdateProductMutationVariables},
  "mutation StartBulkQuery($query: String!) {\n  bulkOperationRunQuery(query: $query) {\n    bulkOperation {\n      id\n      status\n    }\n    userErrors {\n      field\n      message\n    }\n  }\n}": {return: StartBulkQueryMutation, variables: StartBulkQueryMutationVariables},
  "mutation SetInventory($input: InventorySetQuantitiesInput!) {\n  inventorySetQuantities(input: $input) {\n    inventoryAdjustmentGroup {\n      createdAt\n      changes {\n        name\n        delta\n        quantityAfterChange\n      }\n    }\n    userErrors {\n      field\n      message\n      code\n    }\n  }\n}": {return: SetInventoryMutation, variables: SetInventoryMutationVariables},
  "mutation UpdateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {\n  productVariantsBulkUpdate(productId: $productId, variants: $variants) {\n    productVariants {\n      id\n      title\n      price\n    }\n    userErrors {\n      field\n      message\n    }\n  }\n}": {return: UpdateVariantsMutation, variables: UpdateVariantsMutationVariables},
  "mutation CreateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {\n  productVariantsBulkCreate(\n    productId: $productId\n    variants: $variants\n    strategy: REMOVE_STANDALONE_VARIANT\n  ) {\n    productVariants {\n      id\n      title\n      price\n    }\n    userErrors {\n      field\n      message\n    }\n  }\n}": {return: CreateVariantsMutation, variables: CreateVariantsMutationVariables},
  "mutation CreateFile($files: [FileCreateInput!]!) {\n  fileCreate(files: $files) {\n    files {\n      id\n      fileStatus\n    }\n    userErrors {\n      field\n      message\n      code\n    }\n  }\n}": {return: CreateFileMutation, variables: CreateFileMutationVariables},
  "mutation CreateProduct($input: ProductCreateInput!, $media: [CreateMediaInput!]) {\n  productCreate(product: $input, media: $media) {\n    product {\n      id\n      title\n      status\n    }\n    userErrors {\n      field\n      message\n    }\n  }\n}": {return: CreateProductMutation, variables: CreateProductMutationVariables},
}
declare module '@shopify/admin-api-client' {
  type InputMaybe<T> = AdminTypes.InputMaybe<T>;
  interface AdminQueries extends GeneratedQueryTypes {}
  interface AdminMutations extends GeneratedMutationTypes {}
}
