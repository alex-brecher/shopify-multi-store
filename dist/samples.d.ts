type Catalog = {
    name: string;
    url: string;
    description: string;
};
export declare function catalogs(text: string): Catalog[];
export declare function sampleProducts(query: string, limit: number): Promise<{
    query: string;
    sampleData: boolean;
    sampleProducts: never[];
    catalogOnly: boolean;
    notice: string;
    sourceCatalogs?: undefined;
    complete?: undefined;
} | {
    query: string;
    sampleData: boolean;
    catalogOnly: boolean;
    sourceCatalogs: {
        url: string;
        failed: boolean;
    }[];
    complete: boolean;
    sampleProducts: any[];
    notice: string;
}>;
export {};
