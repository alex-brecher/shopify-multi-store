import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
/** Tag arguments for update tools. replaceTags replaces the whole list; addTags and removeTags leave other tags alone. */
export declare const tagFields: {
    replaceTags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    addTags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    removeTags: z.ZodOptional<z.ZodArray<z.ZodString>>;
};
export declare function registerAdminTools(server: McpServer): void;
