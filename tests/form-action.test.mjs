import assert from "node:assert/strict";
import test from "node:test";
import { formActionSources } from "../dist/hosted/html.js";

test("formActionSources allows www/apex callback redirect hops with the same scheme and port", () => {
  assert.equal(formActionSources("https://www.cursor.com/agents/mcp/oauth/callback"), "https://www.cursor.com https://cursor.com");
  assert.equal(formActionSources("https://claude.ai/oauth/callback"), "https://claude.ai https://www.claude.ai");
  assert.equal(formActionSources("http://tools.example.com:8080/callback"), "http://tools.example.com:8080 http://www.tools.example.com:8080");
  assert.equal(formActionSources("https://www.example.com:8443/callback"), "https://www.example.com:8443 https://example.com:8443");
});

test("formActionSources keeps custom schemes and loopback/IP hosts single-source", () => {
  for (const [uri, expected] of [
    ["cursor://oauth/callback", "cursor:"],
    ["vendorapp:callback", "vendorapp:"],
    ["http://127.0.0.1:3000/callback", "http://127.0.0.1:3000"],
    ["http://localhost:1234/callback", "http://localhost:1234"],
    ["http://[::1]:3000/callback", "http://[::1]:3000"],
    ["https://192.0.2.1/callback", "https://192.0.2.1"],
    ["invalid", "'none'"]
  ]) assert.equal(formActionSources(uri), expected);
});
