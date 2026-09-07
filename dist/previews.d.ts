import { McpServer } from "@modelcontextprotocol/server";
import { type StoreConfig } from "./config.js";
import { cliJson } from "./cli-bridge.js";
export declare function previewStores(): Promise<StoreConfig[]>;
export declare function createPreview(a: {
    requestId: string;
    name: string;
    country: string;
}, run?: typeof cliJson): Promise<{
    requestId: string;
    alias: string;
    name: string;
    country: string;
    state: "starting" | "ready" | "unknown";
    shop: string;
    previewUrl: any;
    claimUrl: any;
    temporary: boolean;
}>;
export declare function previewInfo(shop: string, run?: typeof cliJson): Promise<{
    shop: string;
    previewUrl: any;
    claimUrl: any;
    temporary: boolean;
}>;
export declare function registerPreviewTools(server: McpServer): void;
