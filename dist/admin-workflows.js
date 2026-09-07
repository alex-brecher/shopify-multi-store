import { getVariableValues } from "graphql/execution/values.js";
import { findStore } from "./config.js";
import { adminGraphql, hasGraphqlErrors } from "./shopify.js";
import { adminSchema, validateDocument } from "./schema.js";
import { operation } from "./operations.js";
import { DOCS } from "./admin-documents.js";
export class WorkflowError extends Error {
    details;
    constructor(message, details) {
        super(message);
        this.details = details;
    }
}
export class Workflow {
    store;
    completed = [];
    constructor(store) {
        this.store = store;
    }
    async run(document, variables = {}) {
        const { selected } = operation(document);
        // Shopify replaced legacy collection inputs in 2026-07. Keep those workflows on the supported 2026-04 contract.
        const target = document === DOCS.collectionCreate || document === DOCS.collectionUpdate
            ? { ...this.store, apiVersion: "2026-04" }
            : this.store;
        const errors = await validateDocument(document, target.apiVersion);
        if (errors.length)
            throw new WorkflowError("GraphQL schema validation failed before execution.", { errors });
        const checked = getVariableValues(await adminSchema(target.apiVersion), selected.variableDefinitions ?? [], variables);
        if (checked.errors)
            throw new WorkflowError("GraphQL variables failed validation before execution.", { errors: checked.errors.map((e) => e.message) });
        const writing = selected.operation === "mutation";
        let envelope;
        try {
            envelope = await adminGraphql(target, document, variables);
        }
        catch (error) {
            throw new WorkflowError(error instanceof Error ? error.message : String(error), {
                outcome: writing ? "unknown" : "failed",
                completedSteps: this.completed,
                ...(writing
                    ? {
                        notice: "Read the affected resource before retrying. The mutation might have applied.",
                    }
                    : {}),
            });
        }
        if (hasGraphqlErrors(envelope))
            throw new WorkflowError("Shopify rejected all or part of the operation.", {
                outcome: writing ? "rejected_or_partial" : "failed",
                response: envelope,
                completedSteps: this.completed,
            });
        if (!envelope.data || typeof envelope.data !== "object")
            throw new WorkflowError("Shopify returned no data.", {
                response: envelope,
                completedSteps: this.completed,
            });
        const data = envelope.data;
        if (writing)
            this.completed.push({
                operation: selected.name?.value,
                apiVersion: target.apiVersion,
                data,
            });
        return data;
    }
    async requireScopes(scopes) {
        const data = await this.run(DOCS.capabilities);
        if (data.shop?.myshopifyDomain?.toLowerCase() !==
            this.store.shop.toLowerCase())
            throw new Error("The token belongs to a different store.");
        const granted = new Set((data.currentAppInstallation?.accessScopes ?? []).map((s) => s.handle));
        const missing = scopes.filter((s) => !granted.has(s) &&
            !(s.startsWith("read_") && granted.has(s.replace(/^read_/, "write_"))));
        if (missing.length)
            throw new WorkflowError("The store connection lacks required access scopes.", { store: this.store.alias, missingScopes: missing });
        return data;
    }
    async all(document, variables, field, limit = 1000) {
        const nodes = [], seen = new Set();
        let after = null;
        do {
            const data = await this.run(document, { ...variables, after });
            const connection = data[field];
            if (!Array.isArray(connection?.nodes) ||
                typeof connection?.pageInfo?.hasNextPage !== "boolean")
                throw new Error(`Missing ${field} connection.`);
            nodes.push(...connection.nodes);
            if (nodes.length > limit)
                throw new Error(`More than ${limit} ${field} records. Narrow the selection.`);
            if (!connection.pageInfo.hasNextPage)
                return nodes;
            after = connection.pageInfo.endCursor;
            if (!after || seen.has(after))
                throw new Error("Invalid pagination cursor.");
            seen.add(after);
        } while (after);
        return nodes;
    }
    async product(id, first = 25, after, mediaAfter) {
        const data = await this.run(DOCS.product, { id, first, after, mediaAfter });
        if (!data.product)
            throw new Error("Product not found in the selected store.");
        return data;
    }
    async collection(id, first = 25, after) {
        const data = await this.run(DOCS.collection, { id, first, after });
        if (!data.collection)
            throw new Error("Collection not found in the selected store.");
        return data;
    }
    async publish(id, publicationIds) {
        if (publicationIds.length) {
            await this.run(DOCS.publish, {
                id,
                input: publicationIds.map((publicationId) => ({ publicationId })),
            });
            for (const publicationId of publicationIds) {
                const data = await this.run(DOCS.publicationRead, {
                    id,
                    publicationId,
                });
                if (data.node?.publishedOnPublication !== true)
                    throw new WorkflowError("Publication readback did not confirm the requested state.", { id, publicationId, completedSteps: this.completed });
            }
        }
    }
}
export async function workflow(alias) {
    return new Workflow(await findStore(alias));
}
export function textResult(value, isError = false) {
    if (JSON.stringify(value).length > 150_000) {
        return {
            isError: true,
            content: [
                {
                    type: "text",
                    text: "The response exceeded 150000 characters. Request fewer rows. If this followed a write, read back its outcome before retrying.",
                },
            ],
        };
    }
    return {
        ...(isError ? { isError: true } : {}),
        content: [{ type: "text", text: JSON.stringify(value) }],
        structuredContent: value,
    };
}
export function toolError(error) {
    return textResult({
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof WorkflowError ? error.details : {}),
    }, true);
}
//# sourceMappingURL=admin-workflows.js.map