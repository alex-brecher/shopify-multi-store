import { getNamedType, isInterfaceType, isListType, isNonNullType, isObjectType, Kind, print, TypeInfo, visit, visitWithTypeInfo, } from "graphql";
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
function included(node, variables) {
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
//# sourceMappingURL=outcomes.js.map