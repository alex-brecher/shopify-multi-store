import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import {
  buildClientSchema,
  getIntrospectionQuery,
  parse,
  validate,
  isObjectType,
  isInputObjectType,
  isEnumType,
  type GraphQLArgument,
  type GraphQLSchema,
  type IntrospectionQuery,
} from "graphql";
const cache = new Map<string, Promise<GraphQLSchema>>();

export function adminSchema(version: string): Promise<GraphQLSchema> {
  if (!/^\d{4}-(01|04|07|10)$/.test(version))
    throw new Error("Invalid quarterly API version.");
  let pending = cache.get(version);
  if (!pending) {
    pending = (async () => {
      try {
        const compressed = await readFile(
          new URL(`../schemas/admin-${version}.json.gz`, import.meta.url),
        );
        return buildClientSchema(JSON.parse(gunzipSync(compressed).toString()));
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          throw error;
      }
      const response = await fetch(
        `https://shopify.dev/admin-graphql-direct-proxy/${version}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: getIntrospectionQuery() }),
          signal: AbortSignal.timeout(30_000),
          redirect: "error",
        },
      );
      const value = (await response.json()) as {
        data?: IntrospectionQuery;
        errors?: unknown;
      };
      if (!response.ok || !value.data?.__schema || value.errors)
        throw new Error(`Could not load Shopify Admin schema ${version}.`);
      return buildClientSchema(value.data);
    })();
    cache.set(version, pending);
    pending.catch(() => {
      cache.delete(version);
    });
  }
  return pending;
}

export async function validateDocument(document: string, version: string) {
  const schema = await adminSchema(version);
  try {
    return validate(schema, parse(document, { maxTokens: 15_000 })).map(
      (e) => ({ message: e.message, locations: e.locations }),
    );
  } catch (error) {
    return [
      { message: error instanceof Error ? error.message : String(error) },
    ];
  }
}

export async function inspectType(name: string, version: string) {
  const schema = await adminSchema(version);
  const type = schema.getType(name);
  if (!type) throw new Error(`Unknown GraphQL type ${name} in ${version}.`);
  return {
    apiVersion: version,
    name,
    description: type.description,
    ...(isObjectType(type) || isInputObjectType(type)
      ? {
          fields: Object.values(type.getFields()).map((f) => ({
            name: f.name,
            type: String(f.type),
            description: f.description,
            ...("args" in f
              ? {
                  args: f.args.map((a: GraphQLArgument) => ({
                    name: a.name,
                    type: String(a.type),
                    defaultValue: a.defaultValue,
                  })),
                }
              : {}),
          })),
        }
      : {}),
    ...(isEnumType(type)
      ? {
          values: type
            .getValues()
            .map((v) => ({ name: v.name, description: v.description })),
        }
      : {}),
  };
}
