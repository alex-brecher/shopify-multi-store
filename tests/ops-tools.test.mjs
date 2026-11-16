import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { buildClientSchema, parse, validate } from "graphql";
import { EXPORT_QUERIES, exportQuery } from "../dist/ops-tools.js";
import { WEBHOOK_DOCS, validWebhookUri, webhookTargetAllowed } from "../dist/extensions/webhooks.js";
import { exportTicket } from "../dist/ops-tools.js";

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

test("export filters keep $ sequences exactly as typed", () => {
  for (const filter of ["tag:$$promo", "title:$&x", "note:$'tail", "a:$`b"]) {
    const document = exportQuery("orders", filter);
    const parsed = parse(document);
    const argument = parsed.definitions[0].selectionSet.selections[0].arguments[0].value.value;
    assert.equal(argument, filter);
  }
});

test("SHOPIFY_WEBHOOK_ALLOWED_HOSTS limits delivery targets", () => {
  const env = { SHOPIFY_WEBHOOK_ALLOWED_HOSTS: "hooks.netrition.com, .workers.dev, pubsub" };
  assert.equal(webhookTargetAllowed("https://anything.example.com/x", {}), true, "no list allows any valid target");
  assert.equal(webhookTargetAllowed("https://hooks.netrition.com/orders", env), true);
  assert.equal(webhookTargetAllowed("https://a.b.workers.dev/x", env), true);
  assert.equal(webhookTargetAllowed("https://evil.example.com/x", env), false);
  assert.equal(webhookTargetAllowed("https://hooks.netrition.com.evil.com/x", env), false);
  assert.equal(webhookTargetAllowed("pubsub://p:t", env), true);
  assert.equal(webhookTargetAllowed("arn:aws:events:us-east-1::event-source/aws.partner/shopify.com/1/x", env), false);
});

test("bulk export tickets bind person, shop and operation", () => {
  const a = exportTicket("pat@x.com", "main.myshopify.com", "gid://shopify/BulkOperation/7", "k");
  assert.equal(a, exportTicket("PAT@x.com", "main.myshopify.com", "gid://shopify/BulkOperation/7", "k"));
  assert.notEqual(a, exportTicket("sam@x.com", "main.myshopify.com", "gid://shopify/BulkOperation/7", "k"));
  assert.notEqual(a, exportTicket("pat@x.com", "main.myshopify.com", "gid://shopify/BulkOperation/8", "k"));
});
