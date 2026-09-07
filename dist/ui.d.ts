import { McpServer } from "@modelcontextprotocol/server";
export declare const UI_URI = "ui://shopify-multi-store/results";
export declare const UI_META: {
    ui: {
        resourceUri: string;
    };
    "openai/outputTemplate": string;
};
export declare function registerUI(server: McpServer): void;
