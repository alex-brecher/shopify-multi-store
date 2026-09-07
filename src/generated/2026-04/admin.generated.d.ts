/* eslint-disable eslint-comments/disable-enable-pair */
/* eslint-disable eslint-comments/no-unlimited-disable */
/* eslint-disable */
import type * as AdminTypes from './admin.types.js';

export type UpdateCollectionMutationVariables = AdminTypes.Exact<{
  input: AdminTypes.CollectionInput;
}>;


export type UpdateCollectionMutation = { collectionUpdate?: AdminTypes.Maybe<{ collection?: AdminTypes.Maybe<Pick<AdminTypes.Collection, 'id' | 'title'>>, userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }> };

export type CreateCollectionMutationVariables = AdminTypes.Exact<{
  input: AdminTypes.CollectionInput;
}>;


export type CreateCollectionMutation = { collectionCreate?: AdminTypes.Maybe<{ collection?: AdminTypes.Maybe<Pick<AdminTypes.Collection, 'id' | 'title'>>, userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }> };

interface GeneratedQueryTypes {
}

interface GeneratedMutationTypes {
  "mutation UpdateCollection($input: CollectionInput!) {\n  collectionUpdate(input: $input) {\n    collection {\n      id\n      title\n    }\n    userErrors {\n      field\n      message\n    }\n  }\n}": {return: UpdateCollectionMutation, variables: UpdateCollectionMutationVariables},
  "mutation CreateCollection($input: CollectionInput!) {\n  collectionCreate(input: $input) {\n    collection {\n      id\n      title\n    }\n    userErrors {\n      field\n      message\n    }\n  }\n}": {return: CreateCollectionMutation, variables: CreateCollectionMutationVariables},
}
