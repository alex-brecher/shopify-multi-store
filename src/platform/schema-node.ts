import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

/** Node: read schemas/admin-<version>.json.gz from the package. Undefined when the file does not exist. */
export async function loadSchemaFile(version: string): Promise<string | undefined> {
  try {
    const compressed = await readFile(new URL(`../../schemas/admin-${version}.json.gz`, import.meta.url));
    return gunzipSync(compressed).toString();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
