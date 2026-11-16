// Temporary probe (removed before merge): how often does an early 413 from workerd reach the client?
import http from "node:http";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const LIMIT = 1024 * 1024;
const script = `
export default {
  async fetch(request) {
    const length = request.headers.get("content-length");
    if (Number(length) > ${LIMIT}) return new Response("too large", { status: 413 });
    let received = 0;
    if (request.body) {
      const reader = request.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > ${LIMIT}) return new Response("too large", { status: 413 });
      }
    }
    return new Response("ok " + received);
  }
};`;
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate: "2026-09-01" }));
const url = await mf.ready;
const body = JSON.stringify({ padding: "x".repeat(LIMIT) });
const N = Number(process.env.N ?? 40);

const describe = (error) => `${error.message} ${error.cause?.code ?? ""} ${error.cause?.message ?? ""}`.trim();

async function variant(name, once) {
  const tally = {};
  for (let i = 0; i < N; i++) {
    let key;
    try { key = `status ${await once()}`; } catch (error) { key = describe(error); }
    tally[key] = (tally[key] ?? 0) + 1;
  }
  console.log(`${process.platform} ${name}: ${JSON.stringify(tally)}`);
}

await variant("dispatchFetch, content-length", async () => (await mf.dispatchFetch("http://x/mcp", { method: "POST", body })).status);
await variant("global fetch to mf url", async () => (await fetch(url, { method: "POST", body })).status);
await variant("node:http, response wins over write error", () => new Promise((resolve, reject) => {
  const req = http.request(url, { method: "POST", headers: { "content-length": Buffer.byteLength(body), connection: "close" } }, (res) => { res.resume(); resolve(res.statusCode); });
  req.on("error", (error) => setTimeout(() => reject(error), 50));
  req.end(body);
}));
await mf.dispose();
