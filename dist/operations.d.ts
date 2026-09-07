export declare function operation(document: string, expected?: "query" | "mutation"): {
    ast: import("graphql").DocumentNode;
    selected: import("graphql").OperationDefinitionNode;
};
/** Follow the actual selection tree so aliases and fragments cannot hide userErrors. */
export declare function mutationErrors(document: string, data: unknown): unknown[];
