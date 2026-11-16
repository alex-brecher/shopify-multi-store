import type { Data } from "../admin-workflows.js";
export declare const DISCOUNT_DOCS: Record<string, string>;
/** A lookup document for n codes at once, so add_codes checks every code in few requests. */
export declare function codeLookupDocument(n: number): string;
/** The exact discount a create call would make, in plain words. */
export declare function describeCreate(a: Data): string;
/** The Discount*Input for a create call. */
export declare function buildInput(a: Data): Data;
