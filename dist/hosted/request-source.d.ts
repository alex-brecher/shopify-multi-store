export declare function setRequestSource(request: Request, address: string | undefined): void;
/** The recorded source address, or undefined when the platform did not record one. */
export declare function requestSource(request: Request): string | undefined;
