import { z } from "zod/v4";
declare const StoreConfigSchema: z.ZodObject<{
    alias: z.ZodString;
    shop: z.ZodString;
    apiVersion: z.ZodDefault<z.ZodString>;
    tokenEnv: z.ZodOptional<z.ZodString>;
    baseUrl: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type StoreConfig = z.infer<typeof StoreConfigSchema>;
export declare function configPath(): string;
export declare function loadStores(): Promise<StoreConfig[]>;
export declare function findStore(alias: string): Promise<StoreConfig>;
export declare function getAccessToken(store: StoreConfig): Promise<string>;
export declare function graphqlEndpoint(store: StoreConfig): string;
export {};
