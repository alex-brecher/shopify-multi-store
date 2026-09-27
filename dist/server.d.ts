import { McpServer } from "@modelcontextprotocol/server";
export interface CreateServerOptions {
    /**
     * Runs after the server is constructed and before any tool is registered.
     * Hosted mode uses it to wrap registerTool with policy, audit, and safety checks.
     * Stdio mode passes nothing, so local behavior is unchanged.
     */
    beforeRegister?: (server: McpServer) => void;
}
/** Build a fully registered MCP server. Used by stdio (one per process) and HTTP (one per request). */
export declare function createServer(options?: CreateServerOptions): McpServer;
