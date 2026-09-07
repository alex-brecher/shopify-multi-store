import { cliCommand } from "../dist/cli-bridge.js";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createPreview, previewStores } from "../dist/previews.js";
import { registerAsyncPreview, buildDesign } from "../dist/preview-designs.js";
import { catalogs } from "../dist/samples.js";
import { registerDiscoveryTools } from "../dist/discovery-tools.js";
async function config(t) {
  const old = process.env.SHOPIFY_MULTI_STORE_CONFIG;
  const dir = await mkdtemp(join(tmpdir(), "preview-tests-"));
  process.env.SHOPIFY_MULTI_STORE_CONFIG = join(dir, "stores.json");
  t.after(async () => {
    if (old === undefined) delete process.env.SHOPIFY_MULTI_STORE_CONFIG;
    else process.env.SHOPIFY_MULTI_STORE_CONFIG = old;
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}
test("preview request IDs prevent duplicate stores and retain no access links", async (t) => {
  const dir = await config(t);
  let creates = 0;
  const run = async (args) => {
    if (args[1] === "create") {
      creates++;
      return { status: "success", store: { subdomain: "qa.myshopify.com" } };
    }
    return {
      accessUrl: "https://app.shopify.com/access?secret=test",
      saveUrl: "https://app.shopify.com/claim",
    };
  };
  const a = { requestId: randomUUID(), name: "QA", country: "US" };
  const r = await createPreview(a, run);
  await createPreview(a, run);
  assert.equal(creates, 1);
  assert.ok(r.claimUrl);
  assert.equal((await previewStores())[0].auth.type, "shopify_cli");
  assert.doesNotMatch(
    await readFile(join(dir, "preview-stores.json"), "utf8"),
    /secret|accessUrl|claimUrl/,
  );
  await assert.rejects(
    createPreview({ ...a, name: "Different" }, run),
    /different preview/,
  );
});
test("uncertain preview creation never blindly repeats", async (t) => {
  await config(t);
  let calls = 0;
  const run = async () => {
    calls++;
    throw Error("timeout");
  };
  const a = { requestId: randomUUID(), name: "QA", country: "US" };
  await assert.rejects(createPreview(a, run));
  await assert.rejects(createPreview(a, run), /uncertain outcome/);
  assert.equal(calls, 1);
});
test("Dawn designs escape input and preserve commerce templates", async (t) => {
  const dir = await buildDesign(
    {
      name: "Test",
      headline: "<script>bad</script>",
      description: "<img src=x>",
      background: "#ffffff",
      foreground: "#111111",
      accent: "#225533",
      buttonLabel: "#ffffff",
      layout: "products-first",
    },
    fileURLToPath(new URL("./fixtures/dawn", import.meta.url)),
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const index = JSON.parse(
    await readFile(join(dir, "templates/index.json"), "utf8"),
  );
  assert.equal(index.order[0], "featured_collection");
  assert.match(
    index.sections.image_banner.blocks.heading.settings.heading,
    /&lt;script&gt;/,
  );
  assert.ok(await readFile(join(dir, "templates/product.json"), "utf8"));
  const settings = JSON.parse(
    await readFile(join(dir, "config/settings_data.json"), "utf8"),
  );
  assert.equal(
    settings.current.color_schemes["scheme-1"].settings.button,
    "#225533",
  );
});
test("sample catalog parser accepts only official HTTPS hosts", () => {
  assert.equal(
    catalogs(
      "- [Coffee](https://coffee.mock.shop/api): Coffee beans\n- [Bad](https://mock.shop.evil.com/api): Fake",
    ).length,
    1,
  );
});
test("agent-generated concepts support arbitrary categories without a catalog request", async () => {
  const tools = new Map();
  registerDiscoveryTools({ registerTool: (n, d, c) => tools.set(n, { d, c }) });
  const t = tools.get("shopify_find_sample_product");
  const r = await t.c(
    t.d.inputSchema.parse({
      query: "hat for cat",
      generatedCandidates: [
        { title: "Cat sun hat", description: "An original example concept." },
      ],
    }),
  );
  assert.equal(r.structuredContent.generatedConcepts, true);
  assert.equal(r.structuredContent.sampleProducts[0].title, "Cat sun hat");
  assert.equal(r.structuredContent.catalogOnly, false);
});

test("Windows CLI launches the npm JavaScript entry without a shell", async (t) => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "cli-path-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, "node_modules", "@shopify", "cli", "bin", "run.js");
  await mkdir(join(dir, "node_modules", "@shopify", "cli", "bin"), {
    recursive: true,
  });
  await writeFile(script, "");
  const r = await cliCommand("win32", { PATH: dir });
  assert.equal(r.command, process.execPath);
  assert.deepEqual(r.prefix, [script]);
});

test("preview creation returns pending immediately and exposes background failures", async (t) => {
  await config(t);
  const { z } = await import("zod/v4");
  const tools = new Map();
  let finish;
  const deferred = new Promise((resolve) => {
    finish = resolve;
  });
  registerAsyncPreview(
    { registerTool: (n, d, c) => tools.set(n, { d, c }) },
    "start",
    { inputSchema: z.object({ requestId: z.string().uuid() }) },
    async () => {
      await deferred;
      return { isError: true, structuredContent: { error: "Fixture failure" } };
    },
  );
  const id = randomUUID();
  const first = await tools.get("start").c({ requestId: id });
  assert.equal(first.structuredContent.status, "pending");
  const check = tools.get("shopify_get_new_store_preview_status").c;
  assert.equal(
    (await check({ requestId: id })).structuredContent.status,
    "pending",
  );
  finish();
  let result;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 5));
    result = await check({ requestId: id });
    if (result.isError) break;
  }
  assert.equal(result.structuredContent.error, "Fixture failure");
});

test("receipt readers never observe partial JSON during replacement", async (t) => {
  const dir = await config(t);
  const { atomicJson, readJson } = await import("../dist/concurrency.js");
  const file = join(dir, "receipt.json");
  await atomicJson(file, { revision: 0 });
  let finished = false;
  const writer = (async () => {
    for (let revision = 1; revision <= 30; revision++) {
      await atomicJson(file, { revision, payload: "x".repeat(100000) });
    }
    finished = true;
  })();
  await Promise.all([writer, (async () => {
    while (!finished) {
      const receipt = await readJson(file);
      assert.equal(typeof receipt.revision, "number");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  })()]);
  assert.equal((await readJson(file)).revision, 30);
});
