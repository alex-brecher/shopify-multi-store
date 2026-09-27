import { z } from "zod/v4";
export type Role = "admin" | "editor" | "viewer";
/** An authenticated hosted user after policy resolution. */
export interface Principal {
    email: string;
    role: Role;
    stores: "*" | string[];
}
declare const PolicySchema: z.ZodObject<{
    users: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
        role: z.ZodEnum<{
            admin: "admin";
            editor: "editor";
            viewer: "viewer";
        }>;
        stores: z.ZodUnion<readonly [z.ZodLiteral<"*">, z.ZodArray<z.ZodString>]>;
    }, z.core.$strict>>>;
    domains: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
        role: z.ZodEnum<{
            admin: "admin";
            editor: "editor";
            viewer: "viewer";
        }>;
        stores: z.ZodUnion<readonly [z.ZodLiteral<"*">, z.ZodArray<z.ZodString>]>;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export type PolicyDocument = z.infer<typeof PolicySchema>;
/**
 * Maps a verified email to a role and store allowlist.
 * An exact user entry wins over a domain entry. Anyone not listed gets no access.
 */
export declare class Policy {
    private readonly users;
    private readonly domains;
    constructor(document: unknown);
    resolve(email: string): Principal | null;
}
export interface PolicySource {
    current(): Policy;
}
/**
 * Reads the policy file and re-reads it when its modification time changes,
 * so removing a user takes effect on their next request without a restart.
 * A policy file that becomes unreadable or invalid fails closed (nobody has access).
 */
export declare class FilePolicySource implements PolicySource {
    private readonly path;
    private cached?;
    private static readonly EMPTY;
    constructor(path: string);
    private read;
    current(): Policy;
}
export declare function staticPolicy(document: unknown): PolicySource;
export {};
