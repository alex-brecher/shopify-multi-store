import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { type Data, type Workflow } from "./admin-workflows.js";
/** Tool variant arguments to ProductVariantsBulkInput: inventory fields move under inventoryItem. */
export declare function variantInput(v: Data): Data;
interface Operation {
    description: string;
    shape: z.ZodRawShape;
    scopes: string[];
    handler: (w: Workflow, a: Data) => Promise<Data>;
    /** For irreversible operations: the word confirm must equal before dryRun:false runs. */
    confirmWord?: (a: Data) => string | undefined;
}
/** Every shopify_manage operation, keyed by name. Exported for tests and docs. */
export declare const MANAGE_OPERATIONS: Record<string, Operation>;
/** The strict schema one operation's input is checked against (dryRun defaults to true). */
export declare function operationSchema(name: string): z.ZodObject<{
    dryRun: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>;
export declare function registerCommerceTools(server: McpServer): void;
export {};
