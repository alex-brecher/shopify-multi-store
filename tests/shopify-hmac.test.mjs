import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { shopifyHmacMessage, verifyShopifyHmac, safeEqual } from "../dist/shopify-hmac.js";

const secret = "fixture-secret";
const sign = (message) => createHmac("sha256", secret).update(message).digest("hex");

test("the shared Shopify HMAC verifier applies Shopify's escaping and array rules", () => {
  const params = new URLSearchParams();
  params.set("shop", "fixture.myshopify.com");
  params.set("state", "a&b=c%d");
  params.append("ids[]", "1");
  params.append("ids[]", "2");
  params.set("timestamp", "1700000000");
  const message = shopifyHmacMessage(params);
  assert.equal(message, 'ids=["1", "2"]&shop=fixture.myshopify.com&state=a%26b=c%25d&timestamp=1700000000');
  params.set("hmac", sign(message));
  assert.equal(verifyShopifyHmac(params, secret), true);
  assert.equal(verifyShopifyHmac(params, secret, { nowMs: 1700000000_000 }), true);
  assert.equal(verifyShopifyHmac(params, secret, { nowMs: 1700000000_000 + 3_600_000 }), false);
  assert.equal(verifyShopifyHmac(params, "wrong-secret"), false);
  // A naive join (no escaping) signs a different message, so its signature must not verify.
  const naive = [...params.entries()].filter(([k]) => k !== "hmac").sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&");
  params.set("hmac", sign(naive));
  assert.equal(verifyShopifyHmac(params, secret), false);
});

test("a repeated plain parameter is refused rather than guessed", () => {
  const params = new URLSearchParams("shop=a.myshopify.com&shop=b.myshopify.com");
  assert.equal(shopifyHmacMessage(params), undefined);
  params.set("hmac", "0".repeat(64));
  assert.equal(verifyShopifyHmac(params, secret), false);
});

test("safeEqual compares strings in constant time and rejects length mismatches", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
});

test("scripts/oauth-connect.mjs uses the shared verifier instead of its own", async () => {
  const source = await readFile(new URL("../scripts/oauth-connect.mjs", import.meta.url), "utf8");
  assert.match(source, /from "\.\.\/dist\/shopify-hmac\.js"/);
  assert.doesNotMatch(source, /createHmac/);
  assert.match(source, /verifyShopifyHmac\(url\.searchParams, clientSecret/);
});

test("the hosted connector uses the same HMAC implementation (no copy), with Web Crypto", async () => {
  const hmac = await import("../dist/shopify-hmac.js");
  const connect = await import("../dist/hosted/shopify-connect.js");
  assert.equal(connect.shopifyHmacMessage, hmac.shopifyHmacMessage, "one message builder");
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/hosted/shopify-connect.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /escapeKey|escapeValue|hmacSha256Hex/, "no second implementation in shopify-connect.ts");
  const { createHmac } = await import("node:crypto");
  const params = new URLSearchParams({ code: "c", shop: "main.myshopify.com", state: "s&=%", timestamp: "1700000000" });
  params.set("hmac", createHmac("sha256", "secret").update(hmac.shopifyHmacMessage(params)).digest("hex"));
  for (const [nowMs, expected] of [[undefined, true], [1700000000_000, true], [1700000000_000 + 301_000, false]]) {
    const options = nowMs === undefined ? {} : { nowMs };
    assert.equal(hmac.verifyShopifyHmac(params, "secret", options), expected);
    assert.equal(await hmac.verifyShopifyHmacAsync(params, "secret", options), expected);
    assert.equal(await connect.verifyShopifyHmac(params, "secret", nowMs), expected);
  }
  assert.equal(await hmac.verifyShopifyHmacAsync(params, "other"), false);
});
