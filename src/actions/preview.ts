// getArgumentValues from the package root, not graphql/execution/values.js: a bundler that
// picks the ESM build for "graphql" would otherwise load two copies and fail instanceof checks.
import { getArgumentValues, TypeInfo, visit, visitWithTypeInfo, type DocumentNode, type GraphQLSchema } from "graphql";
import { included } from "./outcomes.js";

/**
 * Dry-run target analysis for shopify_run_action: which records a document names, and whether
 * that list can be the whole impact. A document whose targets come from a search, a saved search,
 * a filter, or an "all" flag cannot be previewed record by record.
 */

type Data = Record<string, unknown>;

const SEARCH_ARGUMENTS = new Set(["query", "search", "savedSearchId", "filter", "filters", "where"]);
/** Mutations whose query argument defines something rather than selecting records to change. */
const QUERY_DEFINES = new Set(["segmentCreate", "segmentUpdate", "bulkOperationRunQuery"]);
const NON_ENUMERABLE_NAME = /(BySearch|BySavedSearch|DeleteAll|BulkSearch)$/;
const ALL_FLAG = /(^all|All)(?=[A-Z]|$)/;

/**
 * Why a document's targets cannot be listed from its IDs: search, saved-search, filter, or
 * "all" style mutations and arguments. Empty when every target is named by ID.
 */
export function nonEnumerableReasons(schema: GraphQLSchema, ast: DocumentNode, variables: Data): string[] {
  const mutationType = schema.getMutationType();
  const reasons: string[] = [];
  const typeInfo = new TypeInfo(schema);
  visit(ast, visitWithTypeInfo(typeInfo, {
    Field(node) {
      if (typeInfo.getParentType() !== mutationType) return;
      const field = typeInfo.getFieldDef();
      if (!field || !included(node, variables)) return;
      if (NON_ENUMERABLE_NAME.test(field.name)) {
        reasons.push(`${field.name} changes every record matching a search or the whole set, not a list of IDs.`);
        return;
      }
      let args: Data;
      try {
        args = getArgumentValues(field, node, variables) as Data;
      } catch {
        reasons.push(`${field.name}: its arguments could not be read to list the targets.`);
        return;
      }
      for (const [name, value] of Object.entries(args)) {
        if (value === null || value === undefined) continue;
        if (SEARCH_ARGUMENTS.has(name) && !(name === "query" && QUERY_DEFINES.has(field.name))) {
          const idsOnly = name === "where" && value && typeof value === "object" && Object.keys(value).every((key) => key === "ids");
          if (!idsOnly) reasons.push(`${field.name} selects its targets with the ${name} argument, so they cannot be listed in advance.`);
        } else if (ALL_FLAG.test(name) && value === true) {
          reasons.push(`${field.name} has ${name}: true, which reaches records not named in the document.`);
        }
      }
    },
  }));
  return [...new Set(reasons)];
}

/** Every Shopify GID written as a string literal in the document. */
export function literalGids(ast: DocumentNode, test: (value: string) => boolean): string[] {
  const found = new Set<string>();
  visit(ast, {
    StringValue(node) {
      if (test(node.value)) found.add(node.value);
    },
  });
  return [...found];
}
