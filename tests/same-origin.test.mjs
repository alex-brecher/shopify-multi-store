import assert from "node:assert/strict";
import test from "node:test";
import { sameOrigin } from "../dist/hosted/html.js";

const ORIGIN = "https://mcp.example.com";
const post = (headers) => new Request(`${ORIGIN}/login/shopify`, { method: "POST", headers });

test("sameOrigin accepts a Chromium same-origin post sent with Origin: null under no-referrer", () => {
  assert.equal(sameOrigin(post({ origin: "null", "sec-fetch-site": "same-origin" }), ORIGIN), true);
  assert.equal(sameOrigin(post({ origin: ORIGIN, "sec-fetch-site": "same-origin" }), ORIGIN), true);
  assert.equal(sameOrigin(post({ "sec-fetch-site": "none" }), ORIGIN), true);
});

test("sameOrigin refuses cross-site and mismatched posts", () => {
  assert.equal(sameOrigin(post({ origin: "null", "sec-fetch-site": "cross-site" }), ORIGIN), false);
  assert.equal(sameOrigin(post({ origin: "null", "sec-fetch-site": "same-site" }), ORIGIN), false);
  assert.equal(sameOrigin(post({ origin: "https://evil.example", "sec-fetch-site": "same-origin" }), ORIGIN), false);
  assert.equal(sameOrigin(post({ origin: "https://evil.example" }), ORIGIN), false);
  assert.equal(sameOrigin(post({ origin: "null" }), ORIGIN), false);
});

test("sameOrigin keeps accepting clients that send neither header", () => {
  assert.equal(sameOrigin(post({}), ORIGIN), true);
  assert.equal(sameOrigin(post({ origin: ORIGIN }), ORIGIN), true);
});
