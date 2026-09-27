import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { decryptToken, encryptToken } from "../dist/hosted/shopify-connect.js";
import { MemoryStore } from "../dist/hosted/store.js";
import { hostedOptionsFromEnv } from "../dist/hosted/config.js";
import { fetchMetadataDocumentWithFetch } from "../dist/platform/cimd-fetch.js";
import { constantTimeEqual, hmacSha256Hex } from "../dist/platform/crypto.js";
import { isForbiddenAddress } from "../dist/platform/ip.js";
import { gzipSchemaSource, schemaAvailable, setSchemaSource } from "../dist/platform/schema-source.js";
import { adminSchema } from "../dist/schema.js";
import { loadStores } from "../dist/config.js";
import { enableHostedMode, runtimeEnv } from "../dist/runtime.js";

test("Web Crypto AES-GCM reads tokens written by the earlier node:crypto format (v2 and v1) and writes the same format", async () => {
  const key = { id: "k1", key: randomBytes(32) };
  const binding = { email: "pat@bariatricpal.com", alias: "Main", shop: "main.myshopify.com" };
  // Exactly what the previous version wrote with createCipheriv.
  const legacy = (format) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key.key, iv);
    cipher.setAAD(Buffer.from(format === "v1" ? `v1\0${binding.email}\0main\0${binding.shop}` : `v2\0k1\0${binding.email}\0main\0${binding.shop}`));
    const ciphertext = Buffer.concat([cipher.update("shpua_legacy", "utf8"), cipher.final()]);
    const parts = [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")];
    return format === "v1" ? ["v1", ...parts].join(".") : ["v2", "k1", ...parts].join(".");
  };
  assert.deepEqual(await decryptToken([key], legacy("v2"), binding), { token: "shpua_legacy", keyId: "k1" });
  assert.deepEqual(await decryptToken([{ id: "other", key: randomBytes(32) }, key], legacy("v1"), binding), { token: "shpua_legacy", keyId: "v1:k1" });
  const sealed = await encryptToken(key, "shpua_new", binding);
  const [format, keyId, iv, tag, ciphertext] = sealed.split(".");
  assert.equal(format, "v2");
  assert.equal(keyId, "k1");
  assert.equal(Buffer.from(iv, "base64url").length, 12);
  assert.equal(Buffer.from(tag, "base64url").length, 16);
  assert.equal(Buffer.from(ciphertext, "base64url").length, "shpua_new".length);
  await assert.rejects(decryptToken([key], `${format}.${keyId}.${iv}.${tag.slice(0, -2)}AA.${ciphertext}`, binding));
});

test("HMAC and constant-time comparison use Web Crypto", async () => {
  const { createHmac } = await import("node:crypto");
  assert.equal(await hmacSha256Hex("secret", "a=1&b=2"), createHmac("sha256", "secret").update("a=1&b=2").digest("hex"));
  assert.equal(constantTimeEqual("abc", "abc"), true);
  assert.equal(constantTimeEqual("abc", "abd"), false);
  assert.equal(constantTimeEqual("abc", "abcd"), false);
});

test("the pure IP check refuses every private, loopback, link-local, metadata and reserved form", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.100.100.200", "0.0.0.0", "255.255.255.255",
    "::1", "::", "::8.8.8.8", "fe80::1", "fd00:ec2::254", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe", "ff02::1", "[::1]",
    "2001:db8::1", "01.2.3.4", "1.2.3", "not-an-ip", "fe80::1%eth0"]) {
    assert.equal(isForbiddenAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "160.79.104.10", "2606:4700::6810:84e5", "64:ff9b::808:808", "::ffff:8.8.8.8", "[2606:4700::1]"]) {
    assert.equal(isForbiddenAddress(address), false, address);
  }
});

test("the fetch-based client metadata fetcher refuses redirects, big bodies, private literals and localhost", async () => {
  const calls = [];
  const respond = (response) => async (url, init) => { calls.push({ url, init }); return response(); };
  const ok = await fetchMetadataDocumentWithFetch("https://tools.example.org/c.json", respond(() => new Response(JSON.stringify({ client_id: "x" }))));
  assert.deepEqual(ok, { client_id: "x" });
  assert.equal(calls[0].init.redirect, "manual");
  await assert.rejects(fetchMetadataDocumentWithFetch("https://tools.example.org/c.json", respond(() => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }))), /Redirects are not followed/);
  await assert.rejects(fetchMetadataDocumentWithFetch("https://tools.example.org/c.json", respond(() => new Response("x".repeat(17 * 1024)))), /too large/);
  await assert.rejects(fetchMetadataDocumentWithFetch("https://tools.example.org/c.json", respond(() => new Response("{nope"))), /not valid JSON/);
  await assert.rejects(fetchMetadataDocumentWithFetch("https://tools.example.org/c.json", respond(() => new Response("{}", { status: 404 }))), /HTTP 404/);
  const before = calls.length;
  for (const url of ["https://127.0.0.1/c.json", "https://[::ffff:169.254.169.254]/c.json", "https://localhost/c.json", "https://a.localhost/c.json", "http://tools.example.org/c.json"]) {
    await assert.rejects(fetchMetadataDocumentWithFetch(url, respond(() => new Response("{}"))), url);
  }
  assert.equal(calls.length, before, "refused before any request");
});

test("store claim is atomic and single-winner, deleteMatching is declarative, and neither revives expired records", async () => {
  let now = 1_000;
  const store = new MemoryStore(() => now);
  assert.equal(await store.claim("refresh", "missing", "rotated"), undefined);
  await store.put("refresh", "k", { familyId: "f1" }, 5_000);
  const results = await Promise.all([1, 2, 3, 4].map(() => store.claim("refresh", "k", "rotated")));
  assert.equal(results.filter((result) => result.claimed).length, 1);
  assert.ok(results.every((result) => result.value.rotated === true && result.value.familyId === "f1"));
  await store.put("refresh", "k2", { familyId: "f1" }, 5_000);
  await store.put("refresh", "k3", { familyId: "f2" }, 5_000);
  assert.equal(await store.deleteMatching("refresh", { familyId: "f1" }), 2);
  assert.deepEqual((await store.entries("refresh")).map(([key]) => key), ["k3"]);
  now = 5_000;
  assert.equal(await store.claim("refresh", "k3", "rotated"), undefined, "expired records are not revived");
});

test("a gzipped schema source inflates one version lazily with DecompressionStream", async (t) => {
  const gz = await readFile(new URL("../schemas/admin-2026-07.json.gz", import.meta.url));
  let reads = 0;
  const source = gzipSchemaSource("2026-07", async () => { reads += 1; return gz; });
  assert.equal(reads, 0, "nothing is read until a tool needs the schema");
  assert.equal(await source.load("2026-04"), undefined, "other versions are not bundled");
  assert.equal(reads, 0);
  setSchemaSource(source);
  t.after(() => setSchemaSource(undefined));
  const schema = await adminSchema("2026-07");
  assert.ok(schema.getType("Product"));
  assert.equal(reads, 1);
  await adminSchema("2026-07");
  assert.equal(reads, 1, "the parsed schema is cached");
});

test("an offline schema source (the Worker's) never downloads a schema: an unbundled version fails at once", async (t) => {
  const gz = await readFile(new URL("../schemas/admin-2026-07.json.gz", import.meta.url));
  const original = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (input) => { fetched.push(String(input)); throw new Error("no network in this test"); };
  t.after(() => { globalThis.fetch = original; setSchemaSource(undefined); });
  setSchemaSource(gzipSchemaSource("2026-07", gz, { remote: false }));
  assert.equal(schemaAvailable("2026-07"), true);
  assert.equal(schemaAvailable("2025-10"), false);
  const started = Date.now();
  await assert.rejects(adminSchema("2025-10"), /2025-10 is not available on this deployment: it bundles only 2026-07 and does not download schemas at run time/);
  assert.ok(Date.now() - started < 1_000, "fails fast");
  assert.deepEqual(fetched, [], "shopify.dev is never called");
  assert.ok((await adminSchema("2026-07")).getType("Product"), "the bundled version still loads");
  // With no bundled schema at all (a Worker built without one), the error says so.
  setSchemaSource(gzipSchemaSource("2026-07", undefined, { remote: false }));
  await assert.rejects(adminSchema("2025-07"), /bundles no Admin API schema/);
  // The default (Node) source may still use the proxy for versions it does not ship.
  setSchemaSource(undefined);
  assert.equal(schemaAvailable("2025-10"), true);
});

test("hosted settings come from an env object, and store config follows the hosted env", async (t) => {
  const env = {
    MCP_PUBLIC_URL: "https://mcp.example.test",
    SHOPIFY_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    SHOPIFY_APP_CLIENT_ID: "cid",
    SHOPIFY_APP_CLIENT_SECRET: "csecret",
    SHOPIFY_CLIENT_SECRET_OUTLET: "outlet-secret",
    SHOPIFY_IDENTITY_STORE: "outlet",
    STORES_JSON: JSON.stringify({ stores: [{ alias: "main", shop: "main.myshopify.com" }, { alias: "outlet", shop: "outlet.myshopify.com" }] })
  };
  assert.equal(process.env.STORES_JSON, undefined);
  enableHostedMode(env);
  assert.equal(runtimeEnv(), env);
  assert.deepEqual((await loadStores()).map((store) => store.alias), ["main", "outlet"], "read from the env object, not process.env");
  const options = await hostedOptionsFromEnv(env, { loadStores });
  assert.equal(options.issuer, "https://mcp.example.test");
  assert.equal(options.resource, "https://mcp.example.test/mcp");
  assert.equal(options.shopifyConnect.identityStore, "outlet");
  const [main, outlet] = await loadStores();
  assert.equal(options.shopifyConnect.clientId(main), "cid");
  assert.equal(options.shopifyConnect.clientSecret(main), "csecret");
  assert.equal(options.shopifyConnect.clientSecret(outlet), "outlet-secret");
  await assert.rejects(hostedOptionsFromEnv({ ...env, MCP_PUBLIC_URL: "https://mcp.example.test/path" }, { loadStores }), /no path/);
  await assert.rejects(hostedOptionsFromEnv({ ...env, SHOPIFY_TOKEN_ENCRYPTION_KEY: undefined }, { loadStores }), /SHOPIFY_TOKEN_ENCRYPTION_KEY/);
});

test("local stdio code never loads the keychain or Workers code at import time, and hosted code never imports the keychain", async () => {
  const dist = new URL("../dist/", import.meta.url);
  const config = await readFile(new URL("config.js", dist), "utf8");
  assert.doesNotMatch(config, /^import .*credentials\.js/m, "config.js imports the keychain lazily");
  assert.match(config, /import\("\.\/credentials\.js"\)/);
  const files = async (dir) => (await readdir(new URL(dir, dist))).filter((name) => name.endsWith(".js")).map((name) => new URL(`${dir}${name}`, dist));
  for (const file of [...await files("hosted/"), ...await files("platform/")]) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /credentials\.js|cross-keychain/, file.pathname);
    assert.doesNotMatch(text, /workers\//, file.pathname);
  }
  for (const entry of ["index.js", "server.js", "config.js"]) {
    assert.doesNotMatch(await readFile(new URL(entry, dist), "utf8"), /workers\/|cloudflare:/, entry);
  }
});
