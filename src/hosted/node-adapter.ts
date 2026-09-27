import type { IncomingMessage, ServerResponse } from "node:http";

export interface NodeAdapterOptions {
  /** Public origin used to build request URLs, so handlers never trust the Host header. */
  origin: string;
  maxBodyBytes: number;
}

/** Serve a web-standard fetch handler from node:http, streaming the response body (SSE included). */
export function toNodeListener(handler: (request: Request) => Promise<Response>, options: NodeAdapterOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    try {
      const method = (req.method ?? "GET").toUpperCase();
      const chunks: Buffer[] = [];
      let size = 0;
      if (method !== "GET" && method !== "HEAD") {
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > options.maxBodyBytes) {
            res.writeHead(413, { "content-type": "application/json", connection: "close" }).end(JSON.stringify({ error: "payload_too_large" }));
            req.destroy();
            return;
          }
          chunks.push(chunk as Buffer);
        }
      }
      const headers = new Headers();
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
      const url = new URL(req.url ?? "/", options.origin);
      const request = new Request(url, {
        method,
        headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        signal: abort.signal
      });
      const response = await handler(request);
      const outHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => { outHeaders[key] = value; });
      res.writeHead(response.status, outHeaders);
      if (!response.body || method === "HEAD") {
        res.end();
        return;
      }
      const reader = response.body.getReader();
      abort.signal.addEventListener("abort", () => { reader.cancel().catch(() => {}); }, { once: true });
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(value)) {
          await new Promise<void>((resolve) => { res.once("drain", resolve); res.once("close", resolve); });
          if (abort.signal.aborted) return;
        }
      }
      res.end();
    } catch (error) {
      if (abort.signal.aborted) return;
      process.stderr.write(`HTTP adapter error: ${error instanceof Error ? error.message : String(error)}\n`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "server_error" }));
      else res.destroy();
    }
  };
}
