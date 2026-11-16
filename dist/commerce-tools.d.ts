import "./extensions/index.js";
import { MANAGE_OPERATIONS } from "./extension-registry.js";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { type Data } from "./admin-workflows.js";
/** Tool variant arguments to ProductVariantsBulkInput: inventory fields move under inventoryItem. */
export declare function variantInput(v: Data): Data;
export { MANAGE_OPERATIONS };
/** The strict schema one operation's input is checked against (dryRun defaults to true). */
export declare function operationSchema(name: string): z.ZodObject<{
    dryRun: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>;
export declare function registerCommerceTools(server: McpServer): void;
