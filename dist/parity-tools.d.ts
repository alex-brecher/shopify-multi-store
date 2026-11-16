import { McpServer } from "@modelcontextprotocol/server";
import { type Workflow, type Data } from "./admin-workflows.js";
import { PARITY_API_VERSION } from "./api-versions.js";
export { PARITY_API_VERSION };
/** True when two money values are equal as decimals; null and undefined equal only each other. */
export declare function sameMoney(a: unknown, b: unknown): boolean;
/** Derives a store-level status from every item's outcome. See src/parity-tools.ts task 8b. */
/**
 * Store-level status from item outcomes.
 * - ok: every item applied and verified by a fresh read (or was an explicit no-op).
 * - unverified: every item was accepted by Shopify, but the read-back that verifies the new
 *   state failed for at least one ("applied_unverified"). Not ok: read the variants back.
 * - partial: some items applied, others were rejected, mismatched, unknown or not found.
 * - unknown: nothing confirmed applied and at least one write's outcome is unknown.
 * - failed: nothing applied.
 * Only "ok" counts as success; the _many tools treat every other status as not ok.
 */
export declare function deriveStatus(outcomes: string[]): "ok" | "unverified" | "partial" | "failed" | "unknown";
/** A workflow for one store, pinned to PARITY_API_VERSION. */
export declare function parityWorkflow(alias: string): Promise<Workflow>;
/** A tool error that keeps the store, and any completed writes, in its details. */
export declare function failure(w: Workflow | undefined, error: unknown, write: boolean): {
    isError: boolean;
    content: {
        type: "text";
        text: string;
    }[];
} | {
    isError?: boolean | undefined;
    content: {
        type: "text";
        text: string;
    }[];
    structuredContent: Data;
};
export declare function registerParityTools(server: McpServer): void;
