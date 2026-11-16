import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { buildClientSchema, parse, validate } from "graphql";
import { EXPORT_QUERIES, exportQuery } from "../dist/ops-tools.js";
import { WEBHOOK_DOCS, validWebhookUri } from "../dist/extensions/webhooks.js";

const raw = JSON.parse(gunzipSync(readFileSync(new URL("../schemas/admin-2026-07.json.gz", import.meta.url))));
const schema = buildClientSchema(raw.data ?? raw);

test("every bulk export query is valid against Admin API 2026-07, with and without a filter", () => {
  for (const resource of Object.keys(EXPORT_QUERIES)) {
    for (const filter of [undefined, 'created_at:>=2026-10-01 AND tag:"VIP \\"gold\\""']) {
      const errors = validate(schema, parse(exportQuery(resource, filter)));
      assert.deepEqual(errors.map((error) => error.message), [], resource);
    }
  }
  assert.match(exportQuery("orders", 'tag:"a"'), /orders\(query: "tag:\\"a\\""\)/);
  assert.throws(() => exportQuery("nope"), /Unknown resource/);
});

test("webhook delivery targets: https, Pub/Sub, EventBridge; nothing else", () => {
  assert.equal(validWebhookUri("https://hooks.example.com/shopify"), true);
  assert.equal(validWebhookUri("pubsub://my-project:shopify-orders"), true);
  assert.equal(validWebhookUri("arn:aws:events:us-east-1::event-source/aws.partner/shopify.com/123/orders"), true);
  for (const bad of ["http://hooks.example.com", "https://user:pw@hooks.example.com", "javascript:alert(1)", "ftp://x", "pubsub://"]) assert.equal(validWebhookUri(bad), false, bad);
});

test("webhook documents are valid against Admin API 2026-07", () => {
  for (const [name, document] of Object.entries(WEBHOOK_DOCS)) assert.deepEqual(validate(schema, parse(document)).map((error) => error.message), [], name);
});
