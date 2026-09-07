import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/server";
export declare const Design: z.ZodObject<{
    name: z.ZodString;
    headline: z.ZodString;
    description: z.ZodString;
    background: z.ZodString;
    foreground: z.ZodString;
    accent: z.ZodString;
    buttonLabel: z.ZodString;
    layout: z.ZodEnum<{
        editorial: "editorial";
        "hero-first": "hero-first";
        "products-first": "products-first";
    }>;
}, z.core.$strict>;
declare const PreviewProduct: z.ZodObject<{
    title: z.ZodString;
    description: z.ZodString;
    price: z.ZodString;
    imageUrl: z.ZodOptional<z.ZodURL>;
    imageAlt: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare function seedPreviewProducts(alias: string, products: z.infer<typeof PreviewProduct>[]): Promise<string[]>;
type DesignInput = z.infer<typeof Design>;
export declare function buildDesign(design: DesignInput, sourceDirectory?: string): Promise<string>;
export declare function registerPreviewDesignTools(server: McpServer): void;
export {};
