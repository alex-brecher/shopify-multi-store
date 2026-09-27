import type { McpServer } from "@modelcontextprotocol/server";
import {
  getNamedType,
  isEnumType,
  isObjectType,
  isScalarType,
  Kind,
  parse,
  validate,
  type DocumentNode,
  type FragmentDefinitionNode,
  type GraphQLSchema,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from "graphql";
import { getVariableValues } from "graphql/execution/values.js";
import { z } from "zod/v4";
import { mapConcurrent } from "../concurrency.js";
import { findStore, type StoreConfig } from "../config.js";
import { DEFAULT_API_VERSION } from "../constants.js";
import { auditError, canonicalJson, sha256Hex } from "../hosted/audit.js";
import { fitMultiStoreResults } from "../result-limits.js";
import { currentUserAccess, storeScope } from "../runtime.js";
import { adminSchema } from "../schema.js";
import { adminGraphql, MutationThrottledError, type GraphqlEnvelope } from "../shopify.js";
import {
  actionCatalog,
  buildDocument,
  CATEGORIES,
  describeAction,
  denylist,
  findMutation,
  isDenied,
  isDestructive,
  scopeHint,
  searchCatalog,
} from "./catalog.js";
import { literalGids, nonEnumerableReasons } from "./preview.js";
import { evaluateOutcome, instrumentMutation, RESERVED_ALIAS_PREFIX, type MutationRoot } from "./outcomes.js";

const StoreAlias = z.string().min(1).max(64);
const ApiVersion = z.string().regex(/^\d{4}-(01|04|07|10)$/).describe("Admin API version, such as 2026-04. Defaults to the store's version, or the server default.");
const Variables = z.record(z.string(), z.unknown());
const RUN_CONCURRENCY = 4;
const RESULT_CHARACTER_LIMIT = 100_000;
const MAX_RESOLVED_IDS = 250;
const LABEL_FIELDS = ["title", "name", "displayName", "email", "handle", "sku", "status"];
const GID = /^gid:\/\/shopify\/([A-Za-z][A-Za-z0-9]*)\/[^\s]+$/;

type Data = Record<string, unknown>;

function ok(value: Data) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
}

function fail(message: string, details?: Data) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: details ? `${message}\n${JSON.stringify(details)}` : message }],
    ...(details ? { structuredContent: { error: message, ...details } } : {}),
  };
}

async function resolveVersion(apiVersion: string | undefined, store: string | undefined): Promise<string> {
  if (apiVersion) return apiVersion;
  if (store) return (await findStore(store)).apiVersion;
  return DEFAULT_API_VERSION;
}

// ---------- Document analysis ----------

interface ParsedAction {
  ast: DocumentNode;
  operation: OperationDefinitionNode;
  /** Root mutation fields in document order, fragments included. */
  rootFields: string[];
}

/** Parse a caller-supplied document: exactly one operation, a mutation, executable definitions only. */
export function parseActionDocument(document: string): ParsedAction {
  const ast = parse(document, { maxTokens: 15_000 });
  const operations = ast.definitions.filter((definition): definition is OperationDefinitionNode => definition.kind === Kind.OPERATION_DEFINITION);
  if (operations.length !== 1) throw new Error("Supply exactly one GraphQL operation.");
  if (ast.definitions.some((definition) => definition.kind !== Kind.OPERATION_DEFINITION && definition.kind !== Kind.FRAGMENT_DEFINITION)) {
    throw new Error("Only executable GraphQL documents are accepted.");
  }
  const operation = operations[0]!;
  if (operation.operation !== "mutation") {
    throw new Error(`shopify_run_action runs mutations only; this document is a ${operation.operation}. Use shopify_graphql_query for reads.`);
  }
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of ast.definitions) if (definition.kind === Kind.FRAGMENT_DEFINITION) fragments.set(definition.name.value, definition);
  const rootFields: string[] = [];
  const walk = (set: SelectionSetNode, active: Set<string>) => {
    for (const selection of set.selections) {
      if (selection.kind === Kind.FIELD) {
        if (selection.name.value !== "__typename" && !rootFields.includes(selection.name.value)) rootFields.push(selection.name.value);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        walk(selection.selectionSet, active);
      } else {
        const name = selection.name.value;
        if (active.has(name)) throw new Error("Cyclic GraphQL fragment.");
        const fragment = fragments.get(name);
        if (fragment) walk(fragment.selectionSet, new Set([...active, name]));
      }
    }
  };
  walk(operation.selectionSet, new Set());
  if (!rootFields.length) throw new Error("The mutation selects no fields.");
  return { ast, operation, rootFields };
}

/** Every Shopify GID string anywhere in a value. */
export function collectGids(value: unknown, found = new Set<string>(), depth = 0): Set<string> {
  if (depth > 30) return found;
  if (typeof value === "string") {
    if (GID.test(value)) found.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectGids(item, found, depth + 1);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectGids(item, found, depth + 1);
  }
  return found;
}

/** A nodes(ids:) query with a small label selection for each GID type the schema knows. */
export function resolveQuery(schema: GraphQLSchema, ids: Iterable<string>): string {
  const types = new Set<string>();
  for (const id of ids) {
    const typeName = GID.exec(id)?.[1];
    if (typeName) types.add(typeName);
  }
  const fragments: string[] = [];
  for (const typeName of [...types].sort()) {
    const type = schema.getType(typeName);
    if (!isObjectType(type) || !type.getInterfaces().some((iface) => iface.name === "Node")) continue;
    const fields = LABEL_FIELDS.filter((name) => {
      const field = type.getFields()[name];
      if (!field || field.args.some((arg) => arg.type.toString().endsWith("!")) || field.deprecationReason != null) return false;
      const named = getNamedType(field.type);
      return isScalarType(named) || isEnumType(named);
    });
    if (fields.length) fragments.push(`... on ${typeName} { ${fields.join(" ")} }`);
  }
  return `query ResolveActionTargets($ids: [ID!]!) { nodes(ids: $ids) { __typename id ${fragments.join(" ")} } }`;
}

/** Turn Shopify ACCESS_DENIED errors (or HTTP 403) into a plain sentence naming the scope and store. */
export function accessDeniedMessage(errors: unknown, alias: string, mutations: string[]): string | undefined {
  const list = Array.isArray(errors) ? errors : [];
  const denied = list.filter((error) => {
    const code = (error as { extensions?: { code?: unknown } })?.extensions?.code;
    return code === "ACCESS_DENIED";
  });
  if (!denied.length) return undefined;
  const text = JSON.stringify(denied);
  const named = [...new Set([...text.matchAll(/\b((?:read|write)_[a-z_]+[a-z])\b/g)].map((match) => match[1]!))];
  const scopes = named.length ? named : [...new Set(mutations.flatMap((name) => scopeHint(name)))];
  return lacksMessage(scopes, alias);
}

function lacksMessage(scopes: string[], alias: string): string {
  const scopeText = scopes.length ? scopes.join(" or ") : "the permission this action needs";
  const access = currentUserAccess();
  const fix = access
    ? `Ask a store owner to give your Shopify staff account that permission (or add the scope to the app), then reconnect at ${access.connectUrl(alias)}.`
    : "Add the scope to the app and reinstall or re-authorize it.";
  return `Your Shopify account or the app lacks ${scopeText} on ${alias}. ${fix}`;
}

/**
 * The shared write policy for shopify_run_action and (in per-user mode) shopify_graphql_mutation:
 * refuse denylisted mutations, and require confirm equal to the destructive mutation names
 * (comma-separated, in document order) before applying. Returns the refusal, or undefined.
 */
export function actionPolicyError(mutations: string[], confirm: unknown, applying: boolean): string | undefined {
  const denied = mutations.filter((name) => isDenied(name, denylist()));
  if (denied.length) {
    return `Refused: ${denied.join(", ")} ${denied.length === 1 ? "is" : "are"} on this server's action denylist (mutations that mint credentials, change this app's own installation or billing, create lasting subscriptions, or hide other mutations).`;
  }
  const destructive = mutations.filter(isDestructive);
  const expected = destructive.join(",");
  if (applying && destructive.length && confirm !== expected) {
    return `${expected} is destructive. Run a dry run first, then pass confirm: "${expected}" with dryRun: false.`;
  }
  return undefined;
}

/**
 * Send one mutation document to one store with every root's error lists injected, and judge each
 * root on its own. Used by shopify_graphql_mutation. When the document cannot be checked against
 * the schema (it does not validate, or the schema cannot be loaded), it is sent unchanged, as
 * before, and the result says the outcome was not analyzed.
 */
export async function sendMutationWithOutcome(store: StoreConfig, document: string, variables: Data): Promise<Data & { outcome?: string }> {
  let instrumented: ReturnType<typeof instrumentMutation> | undefined;
  let skipped = "";
  try {
    const schema = await adminSchema(store.apiVersion);
    const shape = parseActionDocument(document);
    const validation = validate(schema, shape.ast);
    const coerced = validation.length ? undefined : getVariableValues(schema, shape.operation.variableDefinitions ?? [], variables);
    if (validation.length) skipped = `The document does not validate against Admin API ${store.apiVersion}.`;
    else if (coerced?.errors) skipped = "The variables do not match the document.";
    else instrumented = instrumentMutation(schema, shape.ast, coerced?.coerced ?? {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(RESERVED_ALIAS_PREFIX)) throw error;
    skipped = message;
  }
  const envelope = await adminGraphql(store, instrumented?.document ?? document, variables);
  if (!instrumented) {
    return { ...(envelope as unknown as Data), outcomeNotice: `Per-field outcome not analyzed: ${skipped}`.slice(0, 500) };
  }
  const report = evaluateOutcome(instrumented.roots, envelope);
  const { userErrors: _ignored, ...rest } = envelope;
  void _ignored;
  return {
    ...(rest as unknown as Data),
    data: report.data,
    ...(report.userErrors.length ? { userErrors: report.userErrors } : {}),
    outcome: report.outcome,
    roots: report.roots,
    ...(report.outcome === "partial" || report.outcome === "unknown" ? { applied: report.applied, rejected: report.rejected, unknown: report.unknown } : {}),
    ...(report.advice ? { advice: report.advice } : {}),
  };
}

// ---------- Tools ----------

export function registerActionTools(server: McpServer): void {
  server.registerTool(
    "shopify_find_actions",
    {
      title: "Find Shopify Admin Actions",
      description:
        "Search every Shopify Admin API mutation (hundreds of write actions, most without a dedicated tool) by keyword and optional category. Returns each action's name, one-line description, category, whether it is destructive, which dedicated tools already cover it, and a scope hint. Next: shopify_describe_action for the full signature, then shopify_run_action.",
      inputSchema: z.object({
        query: z.string().max(200).optional().describe("Keywords, such as \"cancel order\" or \"gift card\". Omit to list a category."),
        category: z.enum(CATEGORIES).optional(),
        store: StoreAlias.optional().describe("Use this store's API version."),
        apiVersion: ApiVersion.optional(),
        includeDeprecated: z.boolean().default(false),
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).max(10_000).default(0),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const version = await resolveVersion(args.apiVersion, args.store);
        const result = searchCatalog(await actionCatalog(version), {
          ...(args.query ? { query: args.query } : {}),
          ...(args.category ? { category: args.category } : {}),
          includeDeprecated: args.includeDeprecated,
          limit: args.limit,
          offset: args.offset,
        });
        return ok({ apiVersion: version, categories: [...CATEGORIES], ...result });
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "shopify_describe_action",
    {
      title: "Describe a Shopify Admin Action",
      description:
        "Full signature of one Admin API mutation: arguments with types, the expanded input object fields (required markers, enum values, descriptions), the payload fields, a ready-to-edit GraphQL document with a default selection, a variables template with the required fields, a scope hint, and whether it is destructive (then shopify_run_action needs confirm set to the mutation name).",
      inputSchema: z.object({
        mutation: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).describe("Mutation name, such as orderCancel"),
        store: StoreAlias.optional().describe("Use this store's API version."),
        apiVersion: ApiVersion.optional(),
        depth: z.number().int().min(1).max(6).default(3).describe("How many levels of nested input objects to expand"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const version = await resolveVersion(args.apiVersion, args.store);
        let depth = args.depth;
        let described = await describeAction(args.mutation, version, depth);
        // Large inputs (productSet, orderCreate) can explode at depth; shrink until it fits.
        while (JSON.stringify(described).length > 80_000 && depth > 1) {
          depth -= 1;
          described = await describeAction(args.mutation, version, depth);
        }
        return ok({ ...described, ...(depth !== args.depth ? { depth, notice: `Input expansion reduced to depth ${depth} to fit the response. Describe nested types with shopify_graphql_schema.` } : { depth }) });
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "shopify_run_action",
    {
      title: "Run a Shopify Admin Action",
      description:
        "Run any Shopify Admin API mutation on one to one hundred stores. Give a mutation name (a default document is built) or a full single-mutation document, plus variables shared by every store and/or variablesByStore (IDs differ per store). dryRun (the default) validates the document and variables against each store's API version and looks up every record ID in the variables and the document; nothing is changed. The preview says whether it is complete: targets chosen by a search, saved search, filter, or \"all\" flag, more than 250 IDs, or IDs that do not resolve make it incomplete, and then applying also needs acknowledgeIncompletePreview: true. dryRun false applies it. Destructive actions (delete, cancel, refund and similar) need confirm set to the mutation name. Mutations are never retried automatically. On a hosted server in per-user mode, Shopify limits this to what your own staff account may do.",
      inputSchema: z.object({
        stores: z.array(StoreAlias).min(1).max(100),
        mutation: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional().describe("Mutation name. Required unless document is given; if both are given, the document must call it."),
        document: z.string().min(1).max(100_000).optional().describe("A full GraphQL document with exactly one mutation operation."),
        variables: Variables.optional().describe("Variables used for every store."),
        variablesByStore: z.record(z.string(), Variables).optional().describe("Per-store variables by alias, merged over variables."),
        dryRun: z.boolean().default(true),
        confirm: z.string().max(2_000).optional().describe("For destructive actions: the mutation name (several destructive mutations: comma-separated, in document order)."),
        acknowledgeIncompletePreview: z.boolean().default(false).describe("Required, with dryRun false, when the targets cannot all be listed in advance (search, saved search, filter, or \"all\" style arguments, or more than 250 IDs). Prefer narrowing the document to explicit IDs instead."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const auditAction = storeScope.getStore()?.auditAction;
      const variablesSha256 = sha256Hex(canonicalJson({ variables: args.variables ?? {}, variablesByStore: args.variablesByStore ?? {} }));
      let mutations: string[] = args.mutation ? [args.mutation] : [];
      const aliases = [...new Map(args.stores.map((alias) => [alias.toLowerCase(), alias])).values()];
      // Audit entries never hold error text: preflight and Shopify messages can quote the
      // input back (a customer's email in a coercion error, a userErrors message). Each
      // failure becomes a class, codes, field paths, HTTP status and a sha256 of the message.
      interface AuditFailure { class: string; message: string; detail?: unknown }
      const audit = async (outcome: Array<{ store: string; ok: boolean; failure?: AuditFailure; userErrors?: number }>) => {
        if (!auditAction) return;
        const access = currentUserAccess();
        const entries = outcome.map(({ failure, ...entry }) => {
          const shopifyEmail = access?.tokens.get(entry.store.toLowerCase())?.shopifyEmail;
          return {
            ...entry,
            ...(failure ? { error: auditError(undefined, { content: [{ type: "text", text: failure.message }], structuredContent: failure.detail }, failure.class) } : {}),
            ...(shopifyEmail ? { shopifyEmail } : {}),
          };
        });
        await auditAction({ mutations, stores: aliases, dryRun: args.dryRun, variablesSha256, outcome: entries });
      };
      const refuse = async (message: string, details?: Data) => {
        await audit(aliases.map((store) => ({ store, ok: false, failure: { class: "refused", message, detail: details } })));
        return fail(message, details);
      };
      try {
        if (!args.mutation && !args.document) return await refuse("Give a mutation name or a document.");
        const byStoreKeys = Object.keys(args.variablesByStore ?? {});
        const unknownKeys = byStoreKeys.filter((key) => !aliases.some((alias) => alias.toLowerCase() === key.toLowerCase()));
        if (unknownKeys.length) return await refuse(`variablesByStore names stores that are not in stores: ${unknownKeys.join(", ")}.`);

        // The document is parsed once for its shape; it is validated per API version below.
        let parsed: ParsedAction | undefined;
        if (args.document) {
          parsed = parseActionDocument(args.document);
          mutations = parsed.rootFields;
          if (args.mutation && !parsed.rootFields.includes(args.mutation)) {
            return await refuse(`The document does not call ${args.mutation}; it calls ${parsed.rootFields.join(", ")}.`);
          }
        }
        const policyError = actionPolicyError(mutations, args.confirm, !args.dryRun);
        if (policyError) return await refuse(policyError);
        const destructive = mutations.filter(isDestructive);
        const expectedConfirm = destructive.join(",");

        // Preflight every store before any change: connection, schema validation, variables.
        interface Plan { alias: string; store?: StoreConfig; document?: string; ast?: DocumentNode; unlisted?: string[]; sent?: string; roots?: MutationRoot[]; variables?: Data; schema?: GraphQLSchema; errors: string[]; warnings: string[] }
        const plans: Plan[] = await mapConcurrent(aliases, async (alias) => {
          const plan: Plan = { alias, errors: [], warnings: [] };
          try {
            const store = await findStore(alias);
            plan.store = store;
            const schema = await adminSchema(store.apiVersion);
            plan.schema = schema;
            let document = args.document;
            if (!document) {
              const field = findMutation(schema, args.mutation!);
              if (!field) throw new Error(`Unknown mutation ${args.mutation} in Admin API ${store.apiVersion}. Use shopify_find_actions.`);
              document = buildDocument(field);
            }
            plan.document = document;
            const shape = parsed ?? parseActionDocument(document);
            const validation = validate(schema, shape.ast);
            if (validation.length) {
              plan.errors.push(...validation.slice(0, 20).map((error) => `GraphQL validation (${store.apiVersion}): ${error.message}`));
              return plan;
            }
            const byStore = Object.entries(args.variablesByStore ?? {}).find(([key]) => key.toLowerCase() === alias.toLowerCase())?.[1];
            const merged: Data = { ...(args.variables ?? {}), ...(byStore ?? {}) };
            const declared = new Set((shape.operation.variableDefinitions ?? []).map((definition) => definition.variable.name.value));
            const unused = Object.keys(merged).filter((name) => !declared.has(name));
            if (unused.length) plan.warnings.push(`Ignored variables the document does not declare: ${unused.join(", ")}.`);
            const variables = Object.fromEntries(Object.entries(merged).filter(([name]) => declared.has(name)));
            const coerced = getVariableValues(schema, shape.operation.variableDefinitions ?? [], variables);
            if (coerced.errors) plan.errors.push(...coerced.errors.slice(0, 20).map((error) => `Variables: ${error.message}`));
            plan.variables = variables;
            // The document actually sent carries every root's error lists under reserved aliases.
            const instrumented = instrumentMutation(schema, shape.ast, coerced.coerced ?? {});
            plan.sent = instrumented.document;
            plan.ast = shape.ast;
            plan.unlisted = nonEnumerableReasons(schema, shape.ast, coerced.coerced ?? {});
            plan.roots = instrumented.roots;
          } catch (error) {
            plan.errors.push(error instanceof Error ? error.message : String(error));
          }
          return plan;
        }, RUN_CONCURRENCY);
        const invalid = plans.filter((plan) => plan.errors.length);

        const targetIds = (plan: Plan) => [...new Set([...collectGids(plan.variables), ...(plan.ast ? literalGids(plan.ast, (value) => GID.test(value)) : [])])];
        // What makes a preview incomplete without looking anything up: targets from a search,
        // saved search, filter, or "all" flag, or more IDs than one lookup covers.
        const staticGaps = (plan: Plan) => {
          const reasons = [...(plan.unlisted ?? [])];
          const count = targetIds(plan).length;
          if (count > MAX_RESOLVED_IDS) reasons.push(`The document names ${count} record IDs; only the first ${MAX_RESOLVED_IDS} can be looked up, so the rest are not previewed.`);
          return reasons;
        };
        const NARROW = "Do not apply without narrowing: name the records by ID (at most 250 per store), or split the change.";

        if (args.dryRun) {
          const previews = await mapConcurrent(plans, async (plan) => {
            if (plan.errors.length || !plan.store || !plan.schema) return { store: plan.alias, ok: false, errors: plan.errors, warnings: plan.warnings };
            const ids = targetIds(plan);
            const reasons = staticGaps(plan);
            let touched: unknown[] = [];
            let resolveErrors: string[] = [];
            let unresolved: string[] = [];
            if (ids.length) {
              const lookup = ids.slice(0, MAX_RESOLVED_IDS);
              try {
                const envelope = await adminGraphql(plan.store, resolveQuery(plan.schema, lookup), { ids: lookup });
                const nodes = ((envelope.data as { nodes?: unknown[] } | undefined)?.nodes ?? []);
                touched = lookup.map((id, index) => nodes[index] ?? { id, found: false });
                unresolved = lookup.filter((_id, index) => nodes[index] == null);
                if (Array.isArray(envelope.errors) && envelope.errors.length) {
                  resolveErrors = [accessDeniedMessage(envelope.errors, plan.alias, ["nodes"]) ?? JSON.stringify(envelope.errors).slice(0, 1_000)];
                }
              } catch (error) {
                resolveErrors = [error instanceof Error ? error.message : String(error)];
              }
            }
            if (unresolved.length) reasons.push(`${unresolved.length} ID${unresolved.length === 1 ? "" : "s"} did not resolve to a record (deleted, from another store, or not visible to this account).`);
            if (resolveErrors.length) reasons.push("The record lookup returned errors, so the targets could not be confirmed.");
            const complete = reasons.length === 0;
            return {
              store: plan.alias,
              ok: resolveErrors.length === 0 && unresolved.length === 0,
              apiVersion: plan.store.apiVersion,
              document: plan.document,
              variables: plan.variables,
              preview: {
                complete,
                targets: ids.length,
                resolved: touched.length - unresolved.length,
                ...(unresolved.length ? { unresolved } : {}),
                ...(reasons.length ? { reasons } : {}),
                recommendation: !complete
                  ? NARROW
                  : ids.length
                    ? "These are the records the document names by ID. Review them before applying."
                    : "The document names no existing record by ID; it changes only what its arguments describe.",
              },
              touchedRecords: touched,
              ...(unresolved.length ? { notFound: unresolved.length } : {}),
              ...(resolveErrors.length ? { resolveErrors } : {}),
              ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
            };
          }, RUN_CONCURRENCY);
          await audit(previews.map((preview) => ({
            store: preview.store,
            ok: preview.ok,
            ...(preview.ok ? {} : { failure: { class: "dry_run_problems", message: JSON.stringify(preview), detail: preview } }),
          })));
          const incomplete = previews.some((preview) => "preview" in preview && preview.preview && !preview.preview.complete);
          const applyArgs = `dryRun: false${destructive.length ? `, confirm: "${expectedConfirm}"` : ""}`;
          const value: Data = {
            dryRun: true,
            mutations,
            destructive: destructive.length > 0,
            ...(destructive.length ? { confirmRequired: expectedConfirm } : {}),
            complete: !incomplete,
            ...(incomplete ? { recommendation: NARROW } : {}),
            nextStep: invalid.length
              ? "Fix the errors above, then run the dry run again."
              : incomplete
                ? `Nothing was changed. The preview is incomplete (see each store's preview.reasons). ${NARROW} Applying anyway needs ${applyArgs}, acknowledgeIncompletePreview: true.`
                : `Nothing was changed. To apply, call shopify_run_action again with the same arguments and ${applyArgs}.`,
            results: previews,
          };
          const fitted = JSON.stringify(value).length > RESULT_CHARACTER_LIMIT
            ? { ...value, results: previews.map((preview) => ({ ...preview, touchedRecords: undefined, notice: "Record previews omitted to fit the response." })) }
            : value;
          return { ...ok(fitted), ...(invalid.length ? { isError: true } : {}) };
        }

        const gaps = plans.flatMap((plan) => staticGaps(plan).map((reason) => `${plan.alias}: ${reason}`));
        if (!invalid.length && gaps.length && !args.acknowledgeIncompletePreview) {
          return await refuse(`Nothing was changed: the targets of this document cannot all be listed in advance. ${NARROW} To apply anyway, pass acknowledgeIncompletePreview: true as well.`, { reasons: gaps });
        }

        if (invalid.length) {
          await audit(plans.map((plan) => ({
            store: plan.alias,
            ok: false,
            failure: plan.errors.length
              ? { class: "preflight", message: plan.errors.join("\n") }
              : { class: "not_run", message: "not run: another store failed preflight" },
          })));
          return fail("Nothing was changed: some stores failed preflight. Fix these and run again.", {
            results: plans.map((plan) => ({ store: plan.alias, ok: plan.errors.length === 0, errors: plan.errors, warnings: plan.warnings })),
          });
        }

        const outcomes = await mapConcurrent(plans, async (plan) => {
          let envelope: GraphqlEnvelope;
          try {
            envelope = await adminGraphql(plan.store!, plan.sent!, plan.variables!);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (error instanceof MutationThrottledError) {
              return { store: plan.alias, ok: false, outcome: "throttled", error: message, retryAfterMs: error.retryAfterMs };
            }
            const forbidden = /HTTP 403\b/.test(message);
            return {
              store: plan.alias,
              ok: false,
              outcome: forbidden ? "failed" : "unknown",
              error: forbidden ? lacksMessage([...new Set(mutations.flatMap((name) => scopeHint(name)))], plan.alias) : message,
              ...(forbidden ? {} : { notice: "Read the affected records before retrying. The mutation might have applied." }),
            };
          }
          const errors = Array.isArray(envelope.errors) ? envelope.errors : [];
          const denied = accessDeniedMessage(errors, plan.alias, mutations);
          const report = evaluateOutcome(plan.roots!, envelope);
          return {
            store: plan.alias,
            ok: report.outcome === "applied",
            // Judged per root: "applied" (every root applied), "rejected" (every root refused,
            // nothing changed), "partial" (some applied), "unknown" (none known to have applied).
            outcome: report.outcome,
            roots: report.roots,
            ...(report.outcome === "partial" || report.outcome === "unknown" ? { applied: report.applied, rejected: report.rejected, unknown: report.unknown } : {}),
            ...(report.advice ? { advice: report.advice } : {}),
            ...(denied ? { error: denied } : {}),
            ...(report.userErrors.length ? { userErrors: report.userErrors } : {}),
            ...(errors.length ? { errors } : {}),
            ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
            result: { data: report.data, requestId: envelope.requestId, elapsedMs: envelope.elapsedMs },
          };
        }, RUN_CONCURRENCY);
        await audit(outcomes.map((outcome) => ({
          store: outcome.store,
          ok: outcome.ok,
          ...(!outcome.ok
            ? { failure: { class: outcome.outcome, message: "error" in outcome && outcome.error ? String(outcome.error) : `outcome ${outcome.outcome}`, detail: { userErrors: "userErrors" in outcome ? outcome.userErrors : undefined, errors: "errors" in outcome ? outcome.errors : undefined } } }
            : {}),
          ...("userErrors" in outcome && outcome.userErrors ? { userErrors: outcome.userErrors.length } : {}),
        })));
        const fitted = fitMultiStoreResults(outcomes, RESULT_CHARACTER_LIMIT);
        return { ...ok({ dryRun: false, mutations, ...fitted }), ...(outcomes.some((outcome) => !outcome.ok) ? { isError: true } : {}) };
      } catch (error) {
        return await refuse(error instanceof Error ? error.message : String(error));
      }
    },
  );
}
