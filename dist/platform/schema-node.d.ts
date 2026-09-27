/** Node: read schemas/admin-<version>.json.gz from the package. Undefined when the file does not exist. */
export declare function loadSchemaFile(version: string): Promise<string | undefined>;
