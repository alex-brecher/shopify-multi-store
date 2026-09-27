import type { IncomingMessage, ServerResponse } from "node:http";
export interface NodeAdapterOptions {
    /** Public origin used to build request URLs, so handlers never trust the Host header. */
    origin: string;
    maxBodyBytes: number;
}
/** Serve a web-standard fetch handler from node:http, streaming the response body (SSE included). */
export declare function toNodeListener(handler: (request: Request) => Promise<Response>, options: NodeAdapterOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
