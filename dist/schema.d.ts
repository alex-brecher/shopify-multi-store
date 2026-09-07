import { type GraphQLSchema } from "graphql";
export declare function adminSchema(version: string): Promise<GraphQLSchema>;
export declare function validateDocument(document: string, version: string): Promise<{
    message: string;
    locations: readonly import("graphql").SourceLocation[] | undefined;
}[] | {
    message: string;
}[]>;
export declare function inspectType(name: string, version: string): Promise<{
    apiVersion: string;
    name: string;
    description: import("graphql/jsutils/Maybe.js").Maybe<string>;
    fields?: {
        name: any;
        type: string;
        description: any;
        args?: any;
    }[] | undefined;
    values?: {
        name: string;
        description: import("graphql/jsutils/Maybe.js").Maybe<string>;
    }[] | undefined;
}>;
