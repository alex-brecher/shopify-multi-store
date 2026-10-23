import assert from "node:assert/strict";
import test from "node:test";
import { HOSTED_MAX_REQUEST_BODY_BYTES, HOSTED_MAX_TOOL_INPUT_ELEMENTS } from "../dist/hosted/app.js";
import { enableHostedMode } from "../dist/runtime.js";
import { call, login, mcpClient, setup, shopifyMock } from "./hosted-fixture.mjs";

enableHostedMode();

test("authenticated MCP bodies over the hosted byte limit are rejected before Shopify calls", async (t) => {
  const requests = await shopifyMock(t);
  const { app } = await setup(t);
  const { accessToken } = await login(app);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: "shopify_graphql_query", arguments: { store: "main", query: "query { shop { name } }", variables: { padding: "x".repeat(HOSTED_MAX_REQUEST_BODY_BYTES) } }
  } });
  const response = await call(app, "/mcp", { method: "POST", headers: {
    authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream"
  }, body });
  assert.equal(response.status, 413);
  assert.equal(requests.length, 0);
});

test("authenticated MCP inputs with too many elements are rejected before Shopify calls", async (t) => {
  const requests = await shopifyMock(t);
  const { app } = await setup(t);
  const client = await mcpClient(t, app, (await login(app)).accessToken);
  const result = await client.callTool({ name: "shopify_graphql_query", arguments: {
    store: "main", query: "query { shop { name } }", variables: { entries: Array(HOSTED_MAX_TOOL_INPUT_ELEMENTS).fill(null) }
  } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /elements|10000/);
  assert.equal(requests.length, 0);
});

test("a normal 250-element Shopify input still uses only the caller's store token", async (t) => {
  const requests = await shopifyMock(t);
  const { app } = await setup(t);
  const client = await mcpClient(t, app, (await login(app, "reader@example.test", { token: "synthetic-reader-token" })).accessToken);
  const result = await client.callTool({ name: "shopify_graphql_query", arguments: {
    store: "main", query: "query { shop { name } }", variables: { entries: Array(250).fill({ field: "value" }) }
  } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].token, "synthetic-reader-token");
});
