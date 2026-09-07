import {
  Kind,
  parse,
  type SelectionSetNode,
  type FragmentDefinitionNode,
} from "graphql";

export function operation(document: string, expected?: "query" | "mutation") {
  const ast = parse(document, { maxTokens: 15_000 });
  const operations = ast.definitions.filter(
    (d) => d.kind === Kind.OPERATION_DEFINITION,
  );
  if (operations.length !== 1)
    throw new Error("Supply exactly one GraphQL operation.");
  const selected = operations[0];
  if (
    selected.operation === "subscription" ||
    (expected && selected.operation !== expected)
  ) {
    throw new Error(
      expected === "query"
        ? "The query tool does not accept mutations. Use shopify_graphql_mutation."
        : "The document must contain one mutation.",
    );
  }
  if (
    ast.definitions.some(
      (d) =>
        d.kind !== Kind.OPERATION_DEFINITION &&
        d.kind !== Kind.FRAGMENT_DEFINITION,
    )
  )
    throw new Error("Only executable GraphQL documents are accepted.");
  return { ast, selected };
}

/** Follow the actual selection tree so aliases and fragments cannot hide userErrors. */
export function mutationErrors(document: string, data: unknown): unknown[] {
  const { ast, selected } = operation(document);
  if (selected.operation !== "mutation") return [];
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const d of ast.definitions)
    if (d.kind === Kind.FRAGMENT_DEFINITION) fragments.set(d.name.value, d);
  const errors: unknown[] = [];
  function walk(
    set: SelectionSetNode,
    value: unknown,
    path: string[],
    active = new Set<string>(),
  ) {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(set, v, [...path, String(i)], active));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const field of set.selections) {
      if (field.kind === Kind.FRAGMENT_SPREAD) {
        if (active.has(field.name.value))
          throw new Error("Cyclic GraphQL fragment.");
        const fragment = fragments.get(field.name.value);
        if (fragment)
          walk(
            fragment.selectionSet,
            value,
            path,
            new Set([...active, field.name.value]),
          );
      } else if (field.kind === Kind.INLINE_FRAGMENT)
        walk(field.selectionSet, value, path, active);
      else {
        const key = field.alias?.value ?? field.name.value;
        const child = (value as Record<string, unknown>)[key];
        if (
          /^(userErrors|mediaUserErrors)$/.test(field.name.value) &&
          Array.isArray(child)
        ) {
          errors.push(
            ...child.map((error) => ({ path: [...path, key], error })),
          );
        } else if (field.selectionSet)
          walk(field.selectionSet, child, [...path, key], active);
      }
    }
  }
  walk(selected.selectionSet, data, []);
  return errors;
}
