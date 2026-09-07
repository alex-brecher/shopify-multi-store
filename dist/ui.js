import { readFile } from "node:fs/promises";
export const UI_URI = "ui://shopify-multi-store/results";
export const UI_META = {
    ui: { resourceUri: UI_URI },
    "openai/outputTemplate": UI_URI,
};
export function registerUI(server) {
    server.registerResource("shopify-results", UI_URI, { mimeType: "text/html;profile=mcp-app" }, async () => ({
        contents: [
            {
                uri: UI_URI,
                mimeType: "text/html;profile=mcp-app",
                text: await readFile(new URL("./ui/app.html", import.meta.url), "utf8"),
                _meta: {
                    ui: {
                        csp: {
                            resourceDomains: ["https://cdn.shopify.com"],
                            connectDomains: [],
                        },
                    },
                },
            },
        ],
    }));
}
//# sourceMappingURL=ui.js.map