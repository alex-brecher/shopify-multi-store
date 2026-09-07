import { readFile, writeFile } from "node:fs/promises";
import { generate } from "@graphql-codegen/cli";
import { ApiType, preset } from "@shopify/api-codegen-preset";
import { printSchema } from "graphql";
import { adminSchema } from "../dist/schema.js";
import { DOCS } from "../dist/admin-documents.js";
for (const version of ["2026-04", "2026-07"]) {
  const documents = Object.entries(DOCS)
    .filter(([name]) =>
      version === "2026-04"
        ? /collectionCreate|collectionUpdate/.test(name)
        : !/collectionCreate|collectionUpdate/.test(name),
    )
    .map(([, document]) => document);
  await generate(
    {
      schema: printSchema(await adminSchema(version)),
      documents,
      generates: {
        [`src/generated/${version}/admin.types.d.ts`]: {
          plugins: ["typescript"],
        },
        [`src/generated/${version}/admin.generated.d.ts`]: {
          preset,
          presetConfig: { apiType: ApiType.Admin },
        },
      },
    },
    true,
  );
  // Legacy collection operation types are exported separately, without augmenting
  // the current-version client with a second version of the same type aliases.
  if (version === "2026-04") {
    const path = `src/generated/${version}/admin.generated.d.ts`;
    const source = await readFile(path, "utf8");
    await writeFile(path, source.replace(/declare module [\s\S]*$/, ""));
  }
}
