import { z } from "zod/v4";
declare const StoreConfigSchema: z.ZodObject<{
    alias: z.ZodString;
    shop: z.ZodString;
    apiVersion: z.ZodDefault<z.ZodString>;
    auth: z.ZodDefault<z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"access_token">;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"client_credentials">;
        clientId: z.ZodString;
    }, z.core.$strict>], "type">>;
    tokenEnv: z.ZodOptional<z.ZodString>;
    baseUrl: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type StoreConfig = z.infer<typeof StoreConfigSchema>;
export declare function configPath(): string;
export declare function loadStores(): Promise<StoreConfig[]>;
/**
 * Per-user mode: allowed stores the caller has not connected, or whose token expired, with the
 * URL that connects each. Empty outside per-user mode.
 */
export declare function unconnectedStores(): Promise<Array<{
    alias: string;
    status: "expired" | "not_connected";
    connectUrl: string;
}>>;
/** Names the first two aliases that point to the same shop, or undefined when every shop is distinct. */
export declare function duplicateShopError(stores: readonly StoreConfig[]): string | undefined;
export interface StoreTarget {
    requestedAlias: string;
    store?: StoreConfig;
    error?: string;
}
/**
 * Resolve the stores a multi-store tool should act on. Requested aliases are matched without
 * case and deduplicated; unknown aliases come back with an error for that entry. Two requested
 * aliases that point to the same shop are refused, naming both, so no action runs twice on one
 * shop. With no aliases, every configured store is used once per shop.
 */
export declare function resolveStoreTargets(aliases?: readonly string[]): Promise<StoreTarget[]>;
export declare function findStore(alias: string): Promise<StoreConfig>;
export declare function getAccessToken(store: StoreConfig): Promise<string>;
export declare function graphqlEndpoint(store: StoreConfig): string;
export {};
