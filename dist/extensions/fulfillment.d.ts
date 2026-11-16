export declare const FULFILLMENT_DOCS: {
    get: string;
    trackingUpdate: string;
    cancel: string;
};
export declare const INVENTORY_DOCS: {
    bySku: string;
    item: string;
    adjust: string;
    moveStates: string;
    updateItem: string;
    activate: string;
    deactivate: string;
};
declare const QUANTITY_NAMES: readonly ["available", "on_hand", "damaged", "quality_control", "reserved", "safety_stock"];
type QuantityName = (typeof QUANTITY_NAMES)[number];
/**
 * A batch read of inventory levels, n item and location pairs in one query. Names and the
 * includeInactive flag come from fixed lists, never from caller text.
 */
export declare function levelsDocument(n: number, names: readonly QuantityName[], includeInactive?: boolean): string;
export {};
