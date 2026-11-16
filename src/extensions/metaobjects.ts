import { z } from "zod/v4";
import { registerGetResource, registerManageOperation, registerSearchResource } from "../extension-registry.js";
import type { Data, Workflow } from "../admin-workflows.js";

// Metaobject definitions, single metaobjects and metafield definitions. The listings
// "metaobjects" (by type) and "metafield_definitions" (by owner type) and the shopify_metafields
// tool (metafield values) already exist elsewhere and are not repeated here.

const DEFINITION_FIELDS = `id type name description displayNameKey metaobjectsCount
  access { admin storefront }
  capabilities { publishable { enabled } translatable { enabled } renderable { enabled } onlineStore { enabled } }
  fieldDefinitions { key name required type { name } }`;
const FULL_DEFINITION_FIELDS = `id type name description displayNameKey metaobjectsCount createdAt updatedAt
  access { admin storefront }
  capabilities { publishable { enabled } translatable { enabled } renderable { enabled } onlineStore { enabled } }
  fieldDefinitions { key name description required type { name category } validations { name type value } }`;
const OBJECT_FIELDS = `id handle type displayName updatedAt
  fields { key type value jsonValue }
  capabilities { publishable { status } onlineStore { templateSuffix } }`;
const METAFIELD_DEFINITION_FIELDS = "id name namespace key description ownerType type { name } validations { name value } pinnedPosition";

export const METAOBJECT_DOCS = {
  listDefinitions: `query MetaobjectDefinitionsList($first: Int!, $after: String) {
  metaobjectDefinitions(first: $first, after: $after) { nodes { ${DEFINITION_FIELDS} } pageInfo { hasNextPage endCursor } }
}`,
  getDefinition: `query MetaobjectDefinitionGet($id: ID!) { metaobjectDefinition(id: $id) { ${FULL_DEFINITION_FIELDS} } }`,
  getObject: `query MetaobjectGet($id: ID!) { metaobject(id: $id) { ${OBJECT_FIELDS} } }`,
  definitionByType: `query MetaobjectDefinitionByType($type: String!) {
  metaobjectDefinitionByType(type: $type) { id type name displayNameKey fieldDefinitions { key name required type { name } } capabilities { publishable { enabled } } }
}`,
  objectForWrite: `query MetaobjectForWrite($id: ID!) {
  metaobject(id: $id) { ${OBJECT_FIELDS} definition { id type fieldDefinitions { key name required type { name } } capabilities { publishable { enabled } } } }
}`,
  byHandle: `query MetaobjectByHandle($handle: MetaobjectHandleInput!) { metaobjectByHandle(handle: $handle) { ${OBJECT_FIELDS} } }`,
  create: `mutation MetaobjectCreate($metaobject: MetaobjectCreateInput!) {
  metaobjectCreate(metaobject: $metaobject) { metaobject { ${OBJECT_FIELDS} } userErrors { field message code } }
}`,
  update: `mutation MetaobjectUpdate($id: ID!, $metaobject: MetaobjectUpdateInput!) {
  metaobjectUpdate(id: $id, metaobject: $metaobject) { metaobject { ${OBJECT_FIELDS} } userErrors { field message code } }
}`,
  upsert: `mutation MetaobjectUpsert($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
  metaobjectUpsert(handle: $handle, metaobject: $metaobject) { metaobject { ${OBJECT_FIELDS} } userErrors { field message code } }
}`,
  delete: `mutation MetaobjectDelete($id: ID!) { metaobjectDelete(id: $id) { deletedId userErrors { field message code } } }`,
  sameMetafieldDefinition: `query SameMetafieldDefinition($ownerType: MetafieldOwnerType!, $namespace: String, $key: String) {
  metafieldDefinitions(ownerType: $ownerType, namespace: $namespace, key: $key, first: 5) { nodes { ${METAFIELD_DEFINITION_FIELDS} } }
}`,
  createMetafieldDefinition: `mutation MetafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition: $definition) { createdDefinition { ${METAFIELD_DEFINITION_FIELDS} } userErrors { field message code } }
}`,
};

const OBJECT_GID = /^gid:\/\/shopify\/Metaobject\/[0-9]+$/;
const TYPE = /^(\$app:)?[A-Za-z0-9_-]{3,255}$/;
const HANDLE = /^[A-Za-z0-9_-]{1,255}$/;
const KEY = /^[A-Za-z0-9_-]{2,64}$/;

registerSearchResource("metaobject_definitions", {
  document: METAOBJECT_DOCS.listDefinitions,
  scopes: ["read_metaobject_definitions"],
  description: "Metaobject definitions: type, name, displayNameKey, field definitions (key, name, type, required), entry count, access and capabilities. No query filter; page with after.",
});

registerGetResource("metaobject", {
  document: METAOBJECT_DOCS.getObject,
  root: "metaobject",
  types: ["Metaobject"],
  label: "Metaobject",
  scopes: ["read_metaobjects"],
  description: "One metaobject: handle, type, displayName, fields (key, type, value, jsonValue), updatedAt, capabilities. id: Metaobject GID.",
});

registerGetResource("metaobject_definition", {
  document: METAOBJECT_DOCS.getDefinition,
  root: "metaobjectDefinition",
  types: ["MetaobjectDefinition"],
  label: "Metaobject definition",
  scopes: ["read_metaobject_definitions"],
  description: "One metaobject definition with full field definitions and validations. id: MetaobjectDefinition GID.",
});

const fieldInput = z.object({
  key: z.string().regex(KEY, "field key must be 2 to 64 letters, digits, underscores or hyphens"),
  value: z.string().max(65535).describe("Always a string; JSON for lists and references, as Shopify expects for the field type"),
});

function checkFields(fields: Data[] | undefined, definition: Data, { requireAll }: { requireAll: boolean }): void {
  const defined: Data[] = definition.fieldDefinitions ?? [];
  const known = new Set(defined.map((f) => f.key));
  const given = (fields ?? []).map((f) => String(f.key));
  const dupes = given.filter((key, i) => given.indexOf(key) !== i);
  if (dupes.length) throw Error(`Field key given more than once: ${[...new Set(dupes)].join(", ")}.`);
  const unknown = given.filter((key) => !known.has(key));
  if (unknown.length)
    throw Error(`Unknown field key${unknown.length > 1 ? "s" : ""} for type ${definition.type}: ${unknown.join(", ")}. Defined keys: ${[...known].join(", ") || "(none)"}. Nothing was changed.`);
  if (requireAll) {
    const missing = defined.filter((f) => f.required && !given.includes(f.key)).map((f) => f.key);
    if (missing.length) throw Error(`Missing required field${missing.length > 1 ? "s" : ""} for type ${definition.type}: ${missing.join(", ")}. Nothing was changed.`);
  }
}

function capabilities(status: string | undefined, definition: Data): Data | undefined {
  if (!status) return undefined;
  if (!definition.capabilities?.publishable?.enabled) throw Error(`Type ${definition.type} does not have the publishable capability, so status cannot be set.`);
  return { publishable: { status } };
}

async function definitionFor(w: Workflow, type: string): Promise<Data> {
  const definition = (await w.run(METAOBJECT_DOCS.definitionByType, { type })).metaobjectDefinitionByType;
  if (!definition) throw Error(`No metaobject definition with type ${type} on this store. Check shopify_search resource metaobject_definitions.`);
  return definition;
}

const PREVIEW = "Nothing was changed. Pass dryRun:false to apply.";

registerManageOperation("metaobject", {
  description:
    "Create, update, upsert or delete one metaobject entry (metaobjectCreate / Update / Upsert / Delete). Reads the definition first and rejects unknown field keys before any write. create: type, optional handle, fields [{key, value}], optional status DRAFT or ACTIVE (publishable types). update: id plus fields and/or status. upsert: type plus handle plus fields. delete: id, needs confirm \"delete\".",
  shape: {
    action: z.enum(["create", "update", "upsert", "delete"]),
    id: z.string().regex(OBJECT_GID, "id must be a Metaobject GID").optional().describe("update and delete"),
    type: z.string().regex(TYPE, "type must be 3 to 255 letters, digits, underscores or hyphens").optional().describe("create and upsert"),
    handle: z.string().regex(HANDLE, "handle must be letters, digits, underscores or hyphens").optional().describe("create (optional) and upsert (required)"),
    fields: z.array(fieldInput).max(250).optional(),
    status: z.enum(["DRAFT", "ACTIVE"]).optional().describe("Publishable types only"),
  },
  scopes: ["write_metaobjects"],
  confirmWord: (a) => (a.action === "delete" ? "delete" : undefined),
  handler: async (w, a) => {
    const fields = a.fields as Data[] | undefined;
    if (a.action === "create") {
      if (!a.type) throw Error("create needs type.");
      if (!fields?.length && !a.status) throw Error("create needs fields.");
      const definition = await definitionFor(w, a.type);
      checkFields(fields, definition, { requireAll: true });
      const caps = capabilities(a.status, definition);
      if (a.handle) {
        const existing = (await w.run(METAOBJECT_DOCS.byHandle, { handle: { type: a.type, handle: a.handle } })).metaobjectByHandle;
        if (existing) throw Error(`A ${a.type} entry with handle ${a.handle} already exists (${existing.id}). Use update or upsert.`);
      }
      const input: Data = { type: a.type, ...(a.handle ? { handle: a.handle } : {}), fields: fields ?? [], ...(caps ? { capabilities: caps } : {}) };
      if (a.dryRun) return { dryRun: true, wouldCreate: input, message: PREVIEW };
      const d = await w.run(METAOBJECT_DOCS.create, { metaobject: input });
      return { dryRun: false, created: d.metaobjectCreate?.metaobject };
    }
    if (a.action === "upsert") {
      if (!a.type || !a.handle) throw Error("upsert needs type and handle.");
      if (!fields?.length && !a.status) throw Error("upsert needs fields.");
      const definition = await definitionFor(w, a.type);
      const current = (await w.run(METAOBJECT_DOCS.byHandle, { handle: { type: a.type, handle: a.handle } })).metaobjectByHandle;
      checkFields(fields, definition, { requireAll: !current });
      const caps = capabilities(a.status, definition);
      const input: Data = { fields: fields ?? [], ...(caps ? { capabilities: caps } : {}) };
      if (a.dryRun) return { dryRun: true, ...(current ? { current, wouldUpdate: input } : { wouldCreate: { type: a.type, handle: a.handle, ...input } }), message: PREVIEW };
      const d = await w.run(METAOBJECT_DOCS.upsert, { handle: { type: a.type, handle: a.handle }, metaobject: input });
      return { dryRun: false, ...(current ? { before: current } : {}), result: d.metaobjectUpsert?.metaobject };
    }
    if (!a.id) throw Error(`${a.action} needs id.`);
    const current = (await w.run(METAOBJECT_DOCS.objectForWrite, { id: a.id })).metaobject;
    if (!current) throw Error(`No metaobject ${a.id} on this store.`);
    const { definition, ...shown } = current;
    if (a.action === "update") {
      if (!fields?.length && !a.status) throw Error("update needs fields and/or status.");
      checkFields(fields, definition, { requireAll: false });
      const caps = capabilities(a.status, definition);
      const input: Data = { ...(fields?.length ? { fields } : {}), ...(caps ? { capabilities: caps } : {}) };
      if (a.dryRun) return { dryRun: true, current: shown, changes: input, message: PREVIEW };
      const d = await w.run(METAOBJECT_DOCS.update, { id: a.id, metaobject: input });
      return { dryRun: false, before: shown, updated: d.metaobjectUpdate?.metaobject };
    }
    if (a.dryRun) return { dryRun: true, wouldDelete: shown, message: "Nothing was changed. Pass dryRun:false and confirm:\"delete\" to apply. Deleting cannot be undone." };
    const d = await w.run(METAOBJECT_DOCS.delete, { id: a.id });
    return { dryRun: false, deleted: d.metaobjectDelete?.deletedId, was: shown };
  },
});

registerManageOperation("metafield_definition", {
  description:
    "Create one metafield definition (metafieldDefinitionCreate); create only. Refuses when ownerType, namespace and key already have a definition. The access scope depends on the owner type (for example write_products for PRODUCT, write_customers for CUSTOMER), so none is checked up front and Shopify rejects a missing one. type is a metafield type name such as single_line_text_field or list.single_line_text_field; validations are {name, value} pairs; pin puts it at the top of the admin page.",
  shape: {
    action: z.enum(["create"]),
    ownerType: z.string().regex(/^[A-Z][A-Z_]{2,40}$/, "ownerType is a MetafieldOwnerType such as PRODUCT or CUSTOMER"),
    namespace: z.string().regex(/^[A-Za-z0-9_-]{3,255}$/, "namespace must be 3 to 255 letters, digits, underscores or hyphens"),
    key: z.string().regex(KEY, "key must be 2 to 64 letters, digits, underscores or hyphens"),
    name: z.string().min(1).max(255),
    type: z.string().regex(/^[a-z][a-z0-9_.]{1,60}$/, "type is a metafield type name such as single_line_text_field"),
    description: z.string().max(255).optional(),
    validations: z.array(z.object({ name: z.string().min(1).max(100), value: z.string().max(2000) })).max(20).optional(),
    pin: z.boolean().optional(),
  },
  scopes: [],
  handler: async (w, a) => {
    const same = (await w.run(METAOBJECT_DOCS.sameMetafieldDefinition, { ownerType: a.ownerType, namespace: a.namespace, key: a.key })).metafieldDefinitions?.nodes ?? [];
    if (same.length) throw Error(`A ${a.ownerType} metafield definition ${a.namespace}.${a.key} already exists (${same[0].id}). Nothing was changed.`);
    const definition: Data = {};
    for (const k of ["ownerType", "namespace", "key", "name", "type", "description", "validations", "pin"]) if (a[k] !== undefined) definition[k] = a[k];
    if (a.dryRun) return { dryRun: true, wouldCreate: definition, message: PREVIEW };
    const d = await w.run(METAOBJECT_DOCS.createMetafieldDefinition, { definition });
    return { dryRun: false, created: d.metafieldDefinitionCreate?.createdDefinition };
  },
});
