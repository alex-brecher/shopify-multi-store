import { McpServer } from "@modelcontextprotocol/server";
/** True when two money values are equal as decimals; null and undefined equal only each other. */
export declare function sameMoney(a: unknown, b: unknown): boolean;
export declare function registerParityTools(server: McpServer): void;
