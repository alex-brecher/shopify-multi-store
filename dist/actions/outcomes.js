import { getNamedType, isInterfaceType, isListType, isNonNullType, isObjectType, Kind, print, TypeInfo, visit, visitWithTypeInfo, parse, } from "graphql";
/**
 * Per-root mutation outcomes.
 *
 * Before a mutation is sent, every top-level mutation field gets its payload's error lists
 * (userErrors and any other *Errors list of objects with a message) added under a reserved
 * alias, `smsUserErrors_<field>`. Detection then never depends on how the caller selected or
 * aliased the error list, or whether they selected it at all. The injected keys are removed from
 * the data handed back. Each root is judged on its own, so one failing root in a document never
 * hides another that applied.
 */
export const RESERVED_ALIAS_PREFIX = "smsUserErrors";
const MAX_DEPTH = 30;
function errorFieldsOf(field) {
    const payload = getNamedType(field.type);
    if (!isObjectType(payload) && !isInterfaceType(payload))
        return [];
    return Object.values(payload.getFields())
        .filter((candidate) => {
        if (!/errors$/i.test(candidate.name) || candidate.args.some((arg) => isNonNullType(arg.type)))
            return false;
        let type = candidate.type;
        if (isNonNullType(type))
            type = type.ofType;
        if (!isListType(type))
            return false;
        const item = getNamedType(type);
        return (isObjectType(item) || isInterfaceType(item)) && "message" in item.getFields();
    })
        .map((candidate) => candidate.name);
}
function errorSelection(field, name) {
    const payload = getNamedType(field.type);
    const itemType = getNamedType(payload.getFields()[name].type);
    const picked = ["field", "message", "code"].filter((sub) => {
        const subField = itemType.getFields()[sub];
        if (!subField || subField.args.some((arg) => isNonNullType(arg.type)))
            return false;
        const named = getNamedType(subField.type);
        return !isObjectType(named) && !isInterfaceType(named);
    });
    return {
        kind: Kind.FIELD,
        alias: { kind: Kind.NAME, value: `${RESERVED_ALIAS_PREFIX}_${name}` },
        name: { kind: Kind.NAME, value: name },
        selectionSet: {
            kind: Kind.SELECTION_SET,
            selections: picked.map((sub) => ({ kind: Kind.FIELD, name: { kind: Kind.NAME, value: sub } })),
        },
    };
}
function conditionValue(directive, variables) {
    const arg = directive.arguments?.find((candidate) => candidate.name.value === "if");
    if (!arg)
        return undefined;
    if (arg.value.kind === Kind.BOOLEAN)
        return arg.value.value;
    if (arg.value.kind === Kind.VARIABLE) {
        const value = variables[arg.value.name.value];
        return typeof value === "boolean" ? value : undefined;
    }
    return undefined;
}
/** False only when @skip/@include on the node itself definitely leave it out. */
export function included(node, variables) {
    for (const directive of node.directives ?? []) {
        const value = conditionValue(directive, variables);
        if (directive.name.value === "skip" && value === true)
            return false;
        if (directive.name.value === "include" && value === false)
            return false;
    }
    return true;
}
/**
 * Add the payload's error lists under reserved aliases to every top-level mutation field, found
 * with TypeInfo so fields inside inline fragments and fragments on Mutation count too. The
 * document must already be valid against the schema.
 */
export function instrumentMutation(schema, ast, variables = {}) {
    const mutationType = schema.getMutationType();
    if (!mutationType)
        throw new Error("This schema has no mutations.");
    visit(ast, {
        Field(node) {
            if (node.alias?.value.startsWith(RESERVED_ALIAS_PREFIX)) {
                throw new Error(`Aliases starting with ${RESERVED_ALIAS_PREFIX} are reserved for this server's error detection.`);
            }
        },
    });
    const roots = new Map();
    const typeInfo = new TypeInfo(schema);
    const instrumented = visit(ast, visitWithTypeInfo(typeInfo, {
        Field: {
            enter(node) {
                if (typeInfo.getParentType() !== mutationType)
                    return undefined;
                const field = typeInfo.getFieldDef();
                if (!field || node.name.value === "__typename")
                    return undefined;
                const errorFields = errorFieldsOf(field);
                const key = node.alias?.value ?? node.name.value;
                if (included(node, variables) && !roots.has(key)) {
                    roots.set(key, { key, mutation: field.name, errorFields: errorFields.map((name) => ({ field: name, alias: `${RESERVED_ALIAS_PREFIX}_${name}` })) });
                }
                if (!errorFields.length || !node.selectionSet)
                    return undefined;
                return {
                    ...node,
                    selectionSet: {
                        ...node.selectionSet,
                        selections: [...node.selectionSet.selections, ...errorFields.map((name) => errorSelection(field, name))],
                    },
                };
            },
        },
    }));
    return { document: print(instrumented), roots: [...roots.values()] };
}
function errorPath(error) {
    const path = error?.path;
    return Array.isArray(path) ? path : undefined;
}
function errorCode(error) {
    return error?.extensions?.code;
}
function stripInjected(value, depth = 0) {
    if (depth > MAX_DEPTH || !value || typeof value !== "object")
        return value;
    if (Array.isArray(value))
        return value.map((item) => stripInjected(item, depth + 1));
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !key.startsWith(RESERVED_ALIAS_PREFIX))
        .map(([key, child]) => [key, stripInjected(child, depth + 1)]));
}
/** Judge each root of an instrumented mutation from Shopify's response, then the store as a whole. */
export function evaluateOutcome(roots, envelope) {
    const data = envelope.data && typeof envelope.data === "object" ? envelope.data : undefined;
    const errors = Array.isArray(envelope.errors) ? envelope.errors : [];
    const pathless = errors.filter((error) => !errorPath(error)?.length);
    const allUserErrors = [];
    const results = roots.map((root) => {
        const value = data?.[root.key];
        const own = errors.filter((error) => errorPath(error)?.[0] === root.key);
        if (value === null || value === undefined) {
            const denied = (own.length > 0 && own.every((error) => errorCode(error) === "ACCESS_DENIED"))
                || (own.length === 0 && pathless.length > 0 && pathless.every((error) => errorCode(error) === "ACCESS_DENIED"));
            if (denied)
                return { key: root.key, mutation: root.mutation, outcome: "rejected", reason: "access denied", errors: own.length ? own : pathless };
            return {
                key: root.key,
                mutation: root.mutation,
                outcome: "unknown",
                reason: own.length ? "Shopify returned an error for this field and no result." : value === null ? "Shopify returned no result for this field." : "The response has no entry for this field.",
                ...(own.length || pathless.length ? { errors: own.length ? own : pathless } : {}),
            };
        }
        const userErrors = [];
        if (typeof value === "object" && !Array.isArray(value)) {
            for (const { field, alias } of root.errorFields) {
                const list = value[alias];
                if (Array.isArray(list))
                    for (const error of list) {
                        userErrors.push(error);
                        allUserErrors.push({ path: [root.key, field], error });
                    }
            }
        }
        return {
            key: root.key,
            mutation: root.mutation,
            outcome: userErrors.length ? "rejected" : "applied",
            ...(userErrors.length ? { userErrors } : {}),
            ...(own.length ? { errors: own } : {}),
        };
    });
    const keys = (outcome) => results.filter((result) => result.outcome === outcome).map((result) => result.key);
    const applied = keys("applied");
    const rejected = keys("rejected");
    const unknown = keys("unknown");
    const outcome = !results.length
        ? "unknown"
        : applied.length === results.length ? "applied"
            : rejected.length === results.length ? "rejected"
                : applied.length ? "partial"
                    : "unknown";
    return { outcome, roots: results, userErrors: allUserErrors, data: stripInjected(envelope.data), applied, rejected, unknown, ...(adviceFor(outcome, applied, rejected, unknown) ? { advice: adviceFor(outcome, applied, rejected, unknown) } : {}) };
}
function adviceFor(outcome, applied, rejected, unknown) {
    const list = (keys) => keys.join(", ");
    if (outcome === "applied")
        return undefined;
    if (outcome === "rejected")
        return "Shopify rejected every mutation in this document, so nothing was applied on this store. Fix the user errors and run it again.";
    const parts = [`Do not run this document again${applied.length ? `: ${list(applied)} already applied` : ""}.`];
    if (unknown.length)
        parts.push(`Read the affected records for ${list(unknown)} first; ${unknown.length === 1 ? "it" : "they"} might have applied.`);
    if (rejected.length)
        parts.push(`Retry only ${list(rejected)}, in a new document, after fixing ${rejected.length === 1 ? "its" : "their"} user errors.`);
    return parts.join(" ");
}
/** Every list of objects that all have a "message" key, anywhere under a payload. */
function messageLists(value, depth = 0, out = []) {
    if (depth > 8 || !value || typeof value !== "object")
        return out;
    if (Array.isArray(value)) {
        if (value.length && value.every((item) => item && typeof item === "object" && !Array.isArray(item) && "message" in item)) {
            out.push(...value);
            return out;
        }
        for (const item of value)
            messageLists(item, depth + 1, out);
        return out;
    }
    for (const child of Object.values(value))
        messageLists(child, depth + 1, out);
    return out;
}
/** Top-level response keys and mutation names of a document, fragments included. */
function documentRoots(document) {
    try {
        const ast = parse(document, { noLocation: true, maxTokens: 50_000 });
        const operations = ast.definitions.filter((definition) => definition.kind === Kind.OPERATION_DEFINITION);
        if (operations.length !== 1 || operations[0].kind !== Kind.OPERATION_DEFINITION)
            return undefined;
        const fragments = new Map(ast.definitions.flatMap((definition) => definition.kind === Kind.FRAGMENT_DEFINITION ? [[definition.name.value, definition]] : []));
        const roots = new Map();
        const walk = (set, seen) => {
            for (const selection of set.selections) {
                if (selection.kind === Kind.FIELD)
                    roots.set(selection.alias?.value ?? selection.name.value, selection.name.value);
                else if (selection.kind === Kind.INLINE_FRAGMENT)
                    walk(selection.selectionSet, seen);
                else if (!seen.has(selection.name.value)) {
                    const fragment = fragments.get(selection.name.value);
                    if (fragment)
                        walk(fragment.selectionSet, new Set([...seen, selection.name.value]));
                }
            }
        };
        walk(operations[0].selectionSet, new Set());
        return [...roots].map(([key, mutation]) => ({ key, mutation }));
    }
    catch {
        return undefined;
    }
}
/**
 * Judge a mutation response without the Admin schema (it could not be loaded, or the document
 * or variables did not validate, so no error lists were injected). The check is structural and
 * alias-agnostic: under each top-level response key, any list of objects that have a "message"
 * key is that root's user errors, whatever it was aliased to. A root is:
 * - rejected when such a list is non-empty (or access was denied);
 * - applied only when its payload is present, it has no errors on its path, and it holds an
 *   empty list under a key ending in "errors", so an error list was selected and came back empty;
 * - unknown otherwise: nothing shows whether it applied. It is never reported as applied.
 */
export function evaluateOutcomeStructural(document, envelope) {
    const data = envelope.data && typeof envelope.data === "object" ? envelope.data : undefined;
    const errors = Array.isArray(envelope.errors) ? envelope.errors : [];
    const pathless = errors.filter((error) => !errorPath(error)?.length);
    const roots = documentRoots(document) ?? Object.keys(data ?? {}).map((key) => ({ key, mutation: key }));
    const allUserErrors = [];
    const results = roots.map((root) => {
        const value = data?.[root.key];
        const own = errors.filter((error) => errorPath(error)?.[0] === root.key);
        if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
            const denied = (own.length > 0 && own.every((error) => errorCode(error) === "ACCESS_DENIED"))
                || (own.length === 0 && pathless.length > 0 && pathless.every((error) => errorCode(error) === "ACCESS_DENIED"));
            if (denied)
                return { key: root.key, mutation: root.mutation, outcome: "rejected", reason: "access denied", errors: own.length ? own : pathless };
            return {
                key: root.key,
                mutation: root.mutation,
                outcome: "unknown",
                reason: own.length ? "Shopify returned an error for this field and no result." : value === null ? "Shopify returned no result for this field." : "The response has no entry for this field.",
                ...(own.length || pathless.length ? { errors: own.length ? own : pathless } : {}),
            };
        }
        const userErrors = messageLists(value);
        for (const error of userErrors)
            allUserErrors.push({ path: [root.key], error });
        if (userErrors.length)
            return { key: root.key, mutation: root.mutation, outcome: "rejected", userErrors, ...(own.length ? { errors: own } : {}) };
        const emptyErrorList = Object.entries(value).some(([key, child]) => /errors$/i.test(key) && Array.isArray(child) && child.length === 0);
        if (emptyErrorList && !own.length && !pathless.length)
            return { key: root.key, mutation: root.mutation, outcome: "applied" };
        return {
            key: root.key,
            mutation: root.mutation,
            outcome: "unknown",
            reason: "The Admin schema was not available, and the response shows no error list for this field, so whether it applied is unknown.",
            ...(own.length || pathless.length ? { errors: own.length ? own : pathless } : {}),
        };
    });
    const keys = (outcome) => results.filter((result) => result.outcome === outcome).map((result) => result.key);
    const applied = keys("applied");
    const rejected = keys("rejected");
    const unknown = keys("unknown");
    const outcome = !results.length
        ? "unknown"
        : applied.length === results.length ? "applied"
            : rejected.length === results.length ? "rejected"
                : applied.length ? "partial"
                    : "unknown";
    const advice = adviceFor(outcome, applied, rejected, unknown);
    return { outcome, roots: results, userErrors: allUserErrors, data: envelope.data, applied, rejected, unknown, ...(advice ? { advice } : {}) };
}
//# sourceMappingURL=outcomes.js.map