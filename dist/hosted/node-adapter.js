import { setRequestSource } from "./request-source.js";
/** Serve a web-standard fetch handler from node:http, streaming the response body (SSE included). */
export function toNodeListener(handler, options) {
    return async (req, res) => {
        const abort = new AbortController();
        res.on("close", () => abort.abort());
        try {
            const method = (req.method ?? "GET").toUpperCase();
            const chunks = [];
            let size = 0;
            if (method !== "GET" && method !== "HEAD") {
                for await (const chunk of req) {
                    size += chunk.length;
                    if (size > options.maxBodyBytes) {
                        res.writeHead(413, { "content-type": "application/json", connection: "close" }).end(JSON.stringify({ error: "payload_too_large" }));
                        req.destroy();
                        return;
                    }
                    chunks.push(chunk);
                }
            }
            const headers = new Headers();
            for (let i = 0; i + 1 < req.rawHeaders.length; i += 2)
                headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
            const url = new URL(req.url ?? "/", options.origin);
            const request = new Request(url, {
                method,
                headers,
                ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
                signal: abort.signal
            });
            // The socket's peer, never a forwarding header. Behind a reverse proxy this is the proxy.
            setRequestSource(request, req.socket.remoteAddress);
            const response = await handler(request);
            const outHeaders = {};
            response.headers.forEach((value, key) => { if (key !== "set-cookie")
                outHeaders[key] = value; });
            // Each cookie stays its own Set-Cookie header; forEach would keep only the last one.
            const cookies = response.headers.getSetCookie();
            if (cookies.length)
                outHeaders["set-cookie"] = cookies;
            res.writeHead(response.status, outHeaders);
            if (!response.body || method === "HEAD") {
                res.end();
                return;
            }
            const reader = response.body.getReader();
            abort.signal.addEventListener("abort", () => { reader.cancel().catch(() => { }); }, { once: true });
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                if (!res.write(value)) {
                    await new Promise((resolve) => { res.once("drain", resolve); res.once("close", resolve); });
                    if (abort.signal.aborted)
                        return;
                }
            }
            res.end();
        }
        catch (error) {
            if (abort.signal.aborted)
                return;
            process.stderr.write(`HTTP adapter error: ${error instanceof Error ? error.message : String(error)}\n`);
            if (!res.headersSent)
                res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "server_error" }));
            else
                res.destroy();
        }
    };
}
//# sourceMappingURL=node-adapter.js.map