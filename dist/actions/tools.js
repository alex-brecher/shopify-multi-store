import { getNamedType, isEnumType, isObjectType, isScalarType, Kind, parse, validate, } from "graphql";
import { getVariableValues } from "graphql/execution/values.js";
import { z } from "zod/v4";
import { mapConcurrent } from "../concurrency.js";
import { findStore } from "../config.js";
import { DEFAULT_API_VERSION } from "../constants.js";
import { canonicalJson, sha256Hex } from "../hosted/audit.js";
import { fitMultiStoreResults } from "../result-limits.js";
import { currentUserAccess, storeScope } from "../runtime.js";
import { adminSchema } from "../schema.js";
import { adminGraphql } from "../shopify.js";
import { actionCatalog, buildDocument, CATEGORIES, describeAction, denylist, findMutation, isDenied, isDestructive, scopeHint, searchCatalog, } from "./catalog.js";
const StoreAlias = z.string().min(1).max(64);
const ApiVersion = z.string().regex(/^\d{4}-(01|04|07|10)$/).describe("Admin API version, such as 2026-04. Defaults to the store's version, or the server default.");
const Variables = z.record(z.string(), z.unknown());
const RUN_CONCURRENCY = 4;
const RESULT_CHARACTER_LIMIT = 100_000;
const MAX_RESOLVED_IDS = 250;
const LABEL_FIELDS = ["title", "name", "displayName", "email", "handle", "sku", "status"];
const GID = /^gid:\/\/shopify\/([A-Za-z][A-Za-z0-9]*)\/[^\s]+$/;
function ok(value) {
    return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}
function fail(message, details) {
    return {
        isError: true,
        content: [{ type: "text", text: details ? `${message}\n${JSON.stringify(details)}` : message }],
        ...(details ? { structuredContent: { error: message, ...details } } : {}),
    };
}
async function resolveVersion(apiVersion, store) {
    if (apiVersion)
        return apiVersion;
    if (store)
        return (await findStore(store)).apiVersion;
    return DEFAULT_API_VERSION;
}
/** Parse a caller-supplied document: exactly one operation, a mutation, executable definitions only. */
export function parseActionDocument(document) {
    const ast = parse(document, { maxTokens: 15_000 });
    const operations = ast.definitions.filter((definition) => definition.kind === Kind.OPERATION_DEFINITION);
    if (operations.length !== 1)
        throw new Error("Supply exactly one GraphQL operation.");
    if (ast.definitions.some((definition) => definition.kind !== Kind.OPERATION_DEFINITION && definition.kind !== Kind.FRAGMENT_DEFINITION)) {
        throw new Error("Only executable GraphQL documents are accepted.");
    }
    const operation = operations[0];
    if (operation.operation !== "mutation") {
        throw new Error(`shopify_run_action runs mutations only; this document is a ${operation.operation}. Use shopify_graphql_query for reads.`);
    }
    const fragments = new Map();
    for (const definition of ast.definitions)
        if (definition.kind === Kind.FRAGMENT_DEFINITION)
            fragments.set(definition.name.value, definition);
    const rootFields = [];
    const walk = (set, active) => {
        for (const selection of set.selections) {
            if (selection.kind === Kind.FIELD) {
                if (selection.name.value !== "__typename" && !rootFields.includes(selection.name.value))
                    rootFields.push(selection.name.value);
            }
            else if (selection.kind === Kind.INLINE_FRAGMENT) {
                walk(selection.selectionSet, active);
            }
            else {
                const name = selection.name.value;
                if (active.has(name))
                    throw new Error("Cyclic GraphQL fragment.");
                const fragment = fragments.get(name);
                if (fragment)
                    walk(fragment.selectionSet, new Set([...active, name]));
            }
        }
    };
    walk(operation.selectionSet, new Set());
    if (!rootFields.length)
        throw new Error("The mutation selects no fields.");
    return { ast, operation, rootFields };
}
/** Every Shopify GID string anywhere in a value. */
export function collectGids(value, found = new Set(), depth = 0) {
    if (depth > 30)
        return found;
    if (typeof value === "string") {
        if (GID.test(value))
            found.add(value);
    }
    else if (Array.isArray(value)) {
        for (const item of value)
            collectGids(item, found, depth + 1);
    }
    else if (value && typeof value === "object") {
        for (const item of Object.values(value))
            collectGids(item, found, depth + 1);
    }
    return found;
}
/** A nodes(ids:) query with a small label selection for each GID type the schema knows. */
export function resolveQuery(schema, ids) {
    const types = new Set();
    for (const id of ids) {
        const typeName = GID.exec(id)?.[1];
        if (typeName)
            types.add(typeName);
    }
    const fragments = [];
    for (const typeName of [...types].sort()) {
        const type = schema.getType(typeName);
        if (!isObjectType(type) || !type.getInterfaces().some((iface) => iface.name === "Node"))
            continue;
        const fields = LABEL_FIELDS.filter((name) => {
            const field = type.getFields()[name];
            if (!field || field.args.some((arg) => arg.type.toString().endsWith("!")) || field.deprecationReason != null)
                return false;
            const named = getNamedType(field.type);
            return isScalarType(named) || isEnumType(named);
        });
        if (fields.length)
            fragments.push(`... on ${typeName} { ${fields.join(" ")} }`);
    }
    return `query ResolveActionTargets($ids: [ID!]!) { nodes(ids: $ids) { __typename id ${fragments.join(" ")} } }`;
}
/** Every entry of every *userErrors list in the response data. */
export function collectUserErrors(value, path = [], out = [], depth = 0) {
    if (depth > 30 || !value || typeof value !== "object")
        return out;
    if (Array.isArray(value)) {
        value.forEach((item, index) => collectUserErrors(item, [...path, String(index)], out, depth + 1));
        return out;
    }
    for (const [key, child] of Object.entries(value)) {
        if (/userErrors$/i.test(key) && Array.isArray(child))
            out.push(...child.map((error) => ({ path: [...path, key], error })));
        else
            collectUserErrors(child, [...path, key], out, depth + 1);
    }
    return out;
}
/** Turn Shopify ACCESS_DENIED errors (or HTTP 403) into a plain sentence naming the scope and store. */
export function accessDeniedMessage(errors, alias, mutations) {
    const list = Array.isArray(errors) ? errors : [];
    const denied = list.filter((error) => {
        const code = error?.extensions?.code;
        return code === "ACCESS_DENIED";
    });
    if (!denied.length)
        return undefined;
    const text = JSON.stringify(denied);
    const named = [...new Set([...text.matchAll(/\b((?:read|write)_[a-z_]+[a-z])\b/g)].map((match) => match[1]))];
    const scopes = named.length ? named : [...new Set(mutations.flatMap((name) => scopeHint(name)))];
    return lacksMessage(scopes, alias);
}
function lacksMessage(scopes, alias) {
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
export function actionPolicyError(mutations, confirm, applying) {
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
// ---------- Tools ----------
export function registerActionTools(server) {
    server.registerTool("shopify_find_actions", {
        title: "Find Shopify Admin Actions",
        description: "Search every Shopify Admin API mutation (hundreds of write actions, most without a dedicated tool) by keyword and optional category. Returns each action's name, one-line description, category, whether it is destructive, which dedicated tools already cover it, and a scope hint. Next: shopify_describe_action for the full signature, then shopify_run_action.",
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
    }, async (args) => {
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
        }
        catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
        }
    });
    server.registerTool("shopify_describe_action", {
        title: "Describe a Shopify Admin Action",
        description: "Full signature of one Admin API mutation: arguments with types, the expanded input object fields (required markers, enum values, descriptions), the payload fields, a ready-to-edit GraphQL document with a default selection, a variables template with the required fields, a scope hint, and whether it is destructive (then shopify_run_action needs confirm set to the mutation name).",
        inputSchema: z.object({
            mutation: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).describe("Mutation name, such as orderCancel"),
            store: StoreAlias.optional().describe("Use this store's API version."),
            apiVersion: ApiVersion.optional(),
            depth: z.number().int().min(1).max(6).default(3).describe("How many levels of nested input objects to expand"),
        }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (args) => {
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
        }
        catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
        }
    });
    server.registerTool("shopify_run_action", {
        title: "Run a Shopify Admin Action",
        description: "Run any Shopify Admin API mutation on one to one hundred stores. Give a mutation name (a default document is built) or a full single-mutation document, plus variables shared by every store and/or variablesByStore (IDs differ per store). dryRun (the default) validates the document and variables against each store's API version and looks up every record ID in the variables, so the preview shows exactly what would be touched; nothing is changed. dryRun false applies it. Destructive actions (delete, cancel, refund and similar) need confirm set to the mutation name. Mutations are never retried automatically. On a hosted server in per-user mode, Shopify limits this to what your own staff account may do.",
        inputSchema: z.object({
            stores: z.array(StoreAlias).min(1).max(100),
            mutation: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional().describe("Mutation name. Required unless document is given; if both are given, the document must call it."),
            document: z.string().min(1).max(100_000).optional().describe("A full GraphQL document with exactly one mutation operation."),
            variables: Variables.optional().describe("Variables used for every store."),
            variablesByStore: z.record(z.string(), Variables).optional().describe("Per-store variables by alias, merged over variables."),
            dryRun: z.boolean().default(true),
            confirm: z.string().max(2_000).optional().describe("For destructive actions: the mutation name (several destructive mutations: comma-separated, in document order)."),
        }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async (args) => {
        const auditAction = storeScope.getStore()?.auditAction;
        const variablesSha256 = sha256Hex(canonicalJson({ variables: args.variables ?? {}, variablesByStore: args.variablesByStore ?? {} }));
        let mutations = args.mutation ? [args.mutation] : [];
        const aliases = [...new Map(args.stores.map((alias) => [alias.toLowerCase(), alias])).values()];
        const audit = async (outcome) => {
            if (auditAction)
                await auditAction({ mutations, stores: aliases, dryRun: args.dryRun, variablesSha256, outcome });
        };
        const refuse = async (message, details) => {
            await audit(aliases.map((store) => ({ store, ok: false, error: message.slice(0, 300) })));
            return fail(message, details);
        };
        try {
            if (!args.mutation && !args.document)
                return await refuse("Give a mutation name or a document.");
            const byStoreKeys = Object.keys(args.variablesByStore ?? {});
            const unknownKeys = byStoreKeys.filter((key) => !aliases.some((alias) => alias.toLowerCase() === key.toLowerCase()));
            if (unknownKeys.length)
                return await refuse(`variablesByStore names stores that are not in stores: ${unknownKeys.join(", ")}.`);
            // The document is parsed once for its shape; it is validated per API version below.
            let parsed;
            if (args.document) {
                parsed = parseActionDocument(args.document);
                mutations = parsed.rootFields;
                if (args.mutation && !parsed.rootFields.includes(args.mutation)) {
                    return await refuse(`The document does not call ${args.mutation}; it calls ${parsed.rootFields.join(", ")}.`);
                }
            }
            const policyError = actionPolicyError(mutations, args.confirm, !args.dryRun);
            if (policyError)
                return await refuse(policyError);
            const destructive = mutations.filter(isDestructive);
            const expectedConfirm = destructive.join(",");
            const plans = await mapConcurrent(aliases, async (alias) => {
                const plan = { alias, errors: [], warnings: [] };
                try {
                    const store = await findStore(alias);
                    plan.store = store;
                    const schema = await adminSchema(store.apiVersion);
                    plan.schema = schema;
                    let document = args.document;
                    if (!document) {
                        const field = findMutation(schema, args.mutation);
                        if (!field)
                            throw new Error(`Unknown mutation ${args.mutation} in Admin API ${store.apiVersion}. Use shopify_find_actions.`);
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
                    const merged = { ...(args.variables ?? {}), ...(byStore ?? {}) };
                    const declared = new Set((shape.operation.variableDefinitions ?? []).map((definition) => definition.variable.name.value));
                    const unused = Object.keys(merged).filter((name) => !declared.has(name));
                    if (unused.length)
                        plan.warnings.push(`Ignored variables the document does not declare: ${unused.join(", ")}.`);
                    const variables = Object.fromEntries(Object.entries(merged).filter(([name]) => declared.has(name)));
                    const coerced = getVariableValues(schema, shape.operation.variableDefinitions ?? [], variables);
                    if (coerced.errors)
                        plan.errors.push(...coerced.errors.slice(0, 20).map((error) => `Variables: ${error.message}`));
                    plan.variables = variables;
                }
                catch (error) {
                    plan.errors.push(error instanceof Error ? error.message : String(error));
                }
                return plan;
            }, RUN_CONCURRENCY);
            const invalid = plans.filter((plan) => plan.errors.length);
            if (args.dryRun) {
                const previews = await mapConcurrent(plans, async (plan) => {
                    if (plan.errors.length || !plan.store || !plan.schema)
                        return { store: plan.alias, ok: false, errors: plan.errors, warnings: plan.warnings };
                    const ids = [...collectGids(plan.variables)];
                    let touched = [];
                    let resolveErrors = [];
                    if (ids.length) {
                        const lookup = ids.slice(0, MAX_RESOLVED_IDS);
                        try {
                            const envelope = await adminGraphql(plan.store, resolveQuery(plan.schema, lookup), { ids: lookup });
                            const nodes = (envelope.data?.nodes ?? []);
                            touched = lookup.map((id, index) => nodes[index] ?? { id, found: false });
                            if (Array.isArray(envelope.errors) && envelope.errors.length) {
                                resolveErrors = [accessDeniedMessage(envelope.errors, plan.alias, ["nodes"]) ?? JSON.stringify(envelope.errors).slice(0, 1_000)];
                            }
                        }
                        catch (error) {
                            resolveErrors = [error instanceof Error ? error.message : String(error)];
                        }
                        if (ids.length > MAX_RESOLVED_IDS)
                            plan.warnings.push(`Only the first ${MAX_RESOLVED_IDS} of ${ids.length} IDs were looked up.`);
                    }
                    const missing = touched.filter((node) => node.found === false).length;
                    return {
                        store: plan.alias,
                        ok: resolveErrors.length === 0 && missing === 0,
                        apiVersion: plan.store.apiVersion,
                        document: plan.document,
                        variables: plan.variables,
                        touchedRecords: touched,
                        ...(missing ? { notFound: missing } : {}),
                        ...(resolveErrors.length ? { resolveErrors } : {}),
                        ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
                    };
                }, RUN_CONCURRENCY);
                await audit(previews.map((preview) => ({ store: preview.store, ok: preview.ok, ...(preview.ok ? {} : { error: "dry run found problems" }) })));
                const value = {
                    dryRun: true,
                    mutations,
                    destructive: destructive.length > 0,
                    ...(destructive.length ? { confirmRequired: expectedConfirm } : {}),
                    nextStep: invalid.length
                        ? "Fix the errors above, then run the dry run again."
                        : `Nothing was changed. To apply, call shopify_run_action again with the same arguments and dryRun: false${destructive.length ? `, confirm: "${expectedConfirm}"` : ""}.`,
                    results: previews,
                };
                const fitted = JSON.stringify(value).length > RESULT_CHARACTER_LIMIT
                    ? { ...value, results: previews.map((preview) => ({ ...preview, touchedRecords: undefined, notice: "Record previews omitted to fit the response." })) }
                    : value;
                return { ...ok(fitted), ...(invalid.length ? { isError: true } : {}) };
            }
            if (invalid.length) {
                await audit(plans.map((plan) => ({ store: plan.alias, ok: false, ...(plan.errors.length ? { error: plan.errors[0].slice(0, 300) } : { error: "not run: another store failed preflight" }) })));
                return fail("Nothing was changed: some stores failed preflight. Fix these and run again.", {
                    results: plans.map((plan) => ({ store: plan.alias, ok: plan.errors.length === 0, errors: plan.errors, warnings: plan.warnings })),
                });
            }
            const outcomes = await mapConcurrent(plans, async (plan) => {
                let envelope;
                try {
                    envelope = await adminGraphql(plan.store, plan.document, plan.variables);
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    const forbidden = /HTTP 403\b/.test(message);
                    return {
                        store: plan.alias,
                        ok: false,
                        outcome: forbidden ? "failed" : "unknown",
                        error: forbidden ? lacksMessage([...new Set(mutations.flatMap((name) => scopeHint(name)))], plan.alias) : message,
                        ...(forbidden ? {} : { notice: "Read the affected records before retrying. The mutation might have applied." }),
                    };
                }
                const userErrors = collectUserErrors(envelope.data);
                const errors = Array.isArray(envelope.errors) ? envelope.errors : [];
                const denied = accessDeniedMessage(errors, plan.alias, mutations);
                const success = errors.length === 0 && userErrors.length === 0;
                return {
                    store: plan.alias,
                    ok: success,
                    // "rejected": Shopify returned userErrors (normally nothing changed). "partial": top-level
                    // errors alongside data, so some of a multi-field document may have applied.
                    outcome: success ? "applied" : errors.length ? (envelope.data && Object.values(envelope.data).some((value) => value != null) ? "partial" : "failed") : "rejected",
                    ...(denied ? { error: denied } : {}),
                    ...(userErrors.length ? { userErrors } : {}),
                    ...(errors.length ? { errors } : {}),
                    ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
                    result: { data: envelope.data, requestId: envelope.requestId, elapsedMs: envelope.elapsedMs },
                };
            }, RUN_CONCURRENCY);
            await audit(outcomes.map((outcome) => ({
                store: outcome.store,
                ok: outcome.ok,
                ...("error" in outcome && outcome.error ? { error: String(outcome.error).slice(0, 300) } : {}),
                ...("userErrors" in outcome && outcome.userErrors ? { userErrors: outcome.userErrors.length } : {}),
            })));
            const fitted = fitMultiStoreResults(outcomes, RESULT_CHARACTER_LIMIT);
            return { ...ok({ dryRun: false, mutations, ...fitted }), ...(outcomes.some((outcome) => !outcome.ok) ? { isError: true } : {}) };
        }
        catch (error) {
            return await refuse(error instanceof Error ? error.message : String(error));
        }
    });
}
//# sourceMappingURL=tools.js.map