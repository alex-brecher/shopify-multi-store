import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { buildClientSchema, parse, validate } from "graphql";
import { CONTENT_DOCS } from "../dist/extensions/content.js";
import { EXTRA_GET, EXTRA_SEARCH, MANAGE_OPERATIONS, extensionScopes } from "../dist/extension-registry.js";
import "../dist/commerce-tools.js";
import { login, mcpClient, setup, shopifyMock } from "./hosted-fixture.mjs";

const raw = JSON.parse(gunzipSync(readFileSync(new URL("../schemas/admin-2026-07.json.gz", import.meta.url))));
const schema = buildClientSchema(raw.data ?? raw);

test("every content document validates against Admin API 2026-07", () => {
  for (const [name, document] of Object.entries(CONTENT_DOCS)) assert.deepEqual(validate(schema, parse(document)).map((error) => error.message), [], name);
});

test("content resources and operations are registered with their scopes", () => {
  assert.deepEqual(EXTRA_SEARCH.blogs.scopes, ["read_content"]);
  for (const name of ["page", "article"]) {
    assert.deepEqual(EXTRA_GET[name].scopes, ["read_content"]);
    assert.deepEqual(MANAGE_OPERATIONS[name].scopes, ["write_content"]);
  }
  assert.deepEqual(MANAGE_OPERATIONS.blog.scopes, ["write_content"]);
  assert.deepEqual(EXTRA_GET.page.types, ["Page"]);
  assert.deepEqual(EXTRA_GET.article.types, ["Article"]);
  assert.deepEqual(extensionScopes()["shopify_get:page"], ["read_content"]);
  assert.equal(MANAGE_OPERATIONS.page.confirmWord({ action: "delete" }), "delete");
  assert.equal(MANAGE_OPERATIONS.article.confirmWord({ action: "update" }), undefined);
  assert.equal(MANAGE_OPERATIONS.blog.confirmWord, undefined);
});

test("zod rejects bad GIDs, handles, dates and image URLs", async () => {
  const { z } = await import("zod/v4");
  const page = z.object(MANAGE_OPERATIONS.page.shape);
  const article = z.object(MANAGE_OPERATIONS.article.shape);
  const blog = z.object(MANAGE_OPERATIONS.blog.shape);
  assert.ok(page.safeParse({ action: "delete", id: "gid://shopify/Page/12" }).success);
  for (const id of ["gid://shopify/Article/12", "gid://shopify/Page/abc", "12", "gid://shopify/Page/1/extra"]) assert.equal(page.safeParse({ action: "delete", id }).success, false, id);
  assert.equal(article.safeParse({ action: "create", blogId: "gid://shopify/Page/1" }).success, false);
  assert.equal(article.safeParse({ action: "delete", id: "gid://shopify/Blog/1" }).success, false);
  assert.equal(blog.safeParse({ id: "gid://shopify/Article/1" }).success, false);
  assert.ok(blog.safeParse({ id: "gid://shopify/Blog/1", commentPolicy: "CLOSED" }).success);
  assert.equal(blog.safeParse({ id: "gid://shopify/Blog/1", commentPolicy: "OPEN" }).success, false);
  assert.equal(page.safeParse({ action: "create", title: "x", handle: "Bad Handle" }).success, false);
  assert.equal(page.safeParse({ action: "create", title: "x", publishDate: "tomorrow" }).success, false);
  assert.ok(page.safeParse({ action: "create", title: "x", publishDate: "2026-12-01T09:00:00Z" }).success);
  assert.equal(article.safeParse({ action: "create", imageUrl: "http://example.com/a.jpg" }).success, false);
});

test("content end to end: reads, dry runs send no write, delete needs confirm, apply sends the input", async (t) => {
  const page = { id: "gid://shopify/Page/5", title: "About", handle: "about", body: "<p>Hi</p>", isPublished: true };
  const article = { id: "gid://shopify/Article/9", title: "News", handle: "news", blog: { id: "gid://shopify/Blog/3", title: "Blog", handle: "blog" } };
  const blog = { id: "gid://shopify/Blog/3", title: "Blog", handle: "blog", commentPolicy: "CLOSED" };
  const requests = await shopifyMock(t, (body) => {
    const q = body.query ?? "";
    if (/StoreCapabilities/.test(q)) return { body: { data: { shop: { id: "gid://shopify/Shop/1", name: "Mock", myshopifyDomain: "main.myshopify.com" }, currentAppInstallation: { id: "gid://shopify/AppInstallation/1", accessScopes: [{ handle: "read_content" }, { handle: "write_content" }] } } } };
    if (/query ListBlogs/.test(q)) return { body: { data: { blogs: { nodes: [blog], pageInfo: { hasNextPage: false, endCursor: null } } } } };
    if (/query GetPage/.test(q)) return { body: { data: { page } } };
    if (/query GetArticle/.test(q)) return { body: { data: { article } } };
    if (/query GetBlog/.test(q)) return { body: { data: { blog } } };
    if (/mutation CreatePage/.test(q)) return { body: { data: { pageCreate: { page: { ...page, id: "gid://shopify/Page/6" }, userErrors: [] } } } };
    if (/mutation UpdateArticle/.test(q)) return { body: { data: { articleUpdate: { article: { ...article, title: "Newer" }, userErrors: [] } } } };
    if (/mutation DeletePage/.test(q)) return { body: { data: { pageDelete: { deletedPageId: page.id, userErrors: [] } } } };
    if (/mutation DeleteArticle/.test(q)) return { body: { data: { articleDelete: { deletedArticleId: article.id, userErrors: [] } } } };
    return undefined;
  });
  const { app } = await setup(t);
  const client = await mcpClient(t, app, (await login(app, "pat@bariatricpal.com", { alias: "main", token: "pat-online-main" })).accessToken);
  const manage = (operation, input, extra = {}) => client.callTool({ name: "shopify_manage", arguments: { store: "main", operation, input, ...extra } });
  const writes = (from) => requests.slice(from).filter((request) => /^\s*mutation/.test(request.body.query));

  const blogs = await client.callTool({ name: "shopify_search", arguments: { resource: "blogs", store: "main" } });
  assert.notEqual(blogs.isError, true, JSON.stringify(blogs));
  assert.equal(blogs.structuredContent.blogs.nodes[0].handle, "blog");
  const got = await client.callTool({ name: "shopify_get", arguments: { resource: "page", store: "main", id: page.id } });
  assert.notEqual(got.isError, true, JSON.stringify(got));
  assert.equal(got.structuredContent.title, "About");
  const wrongType = await client.callTool({ name: "shopify_get", arguments: { resource: "article", store: "main", id: page.id } });
  assert.equal(wrongType.isError, true);
  assert.equal((await client.callTool({ name: "shopify_get", arguments: { resource: "article", store: "main", id: article.id } })).structuredContent.title, "News");

  const before = requests.length;
  const previews = [
    await manage("page", { action: "create", title: "New", body: "<p>x</p>" }),
    await manage("page", { action: "update", id: page.id, title: "About us" }),
    await manage("page", { action: "delete", id: page.id }),
    await manage("article", { action: "create", blogId: blog.id, title: "T", author: "Pat", imageUrl: "https://example.com/a.jpg", imageAlt: "A" }),
    await manage("article", { action: "update", id: article.id, tags: ["a"] }),
    await manage("article", { action: "delete", id: article.id }),
    await manage("blog", { id: blog.id, commentPolicy: "MODERATED" }),
  ];
  for (const preview of previews) {
    assert.notEqual(preview.isError, true, JSON.stringify(preview));
    assert.equal(JSON.parse(preview.content[0].text).dryRun, true);
  }
  assert.deepEqual(JSON.parse(previews[3].content[0].text).wouldCreate.image, { url: "https://example.com/a.jpg", altText: "A" });
  assert.deepEqual(JSON.parse(previews[3].content[0].text).wouldCreate.author, { name: "Pat" });
  assert.equal(writes(before).length, 0, "dry runs send no mutation");
  assert.ok(requests.slice(before).some((request) => /query GetPage/.test(request.body.query)), "update and delete read the page first");

  for (const [operation, input] of [["page", { action: "delete", id: page.id }], ["article", { action: "delete", id: article.id }]]) {
    const mark = requests.length;
    const refused = await manage(operation, input, { dryRun: false });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /requiredConfirm.*delete/);
    assert.equal(requests.length, mark, "a refused delete sends no request");
  }

  const created = await manage("page", { action: "create", title: "New", handle: "new" }, { dryRun: false });
  assert.notEqual(created.isError, true, JSON.stringify(created));
  const create = requests.find((request) => /mutation CreatePage/.test(request.body.query));
  assert.deepEqual(create.body.variables, { page: { title: "New", handle: "new" } });
  const updated = await manage("article", { action: "update", id: article.id, title: "Newer" }, { dryRun: false });
  assert.notEqual(updated.isError, true, JSON.stringify(updated));
  assert.deepEqual(requests.find((request) => /mutation UpdateArticle/.test(request.body.query)).body.variables, { id: article.id, article: { title: "Newer" } });
  const deleted = await manage("page", { action: "delete", id: page.id }, { dryRun: false, confirm: "delete" });
  assert.notEqual(deleted.isError, true, JSON.stringify(deleted));
  assert.equal(JSON.parse(deleted.content[0].text).deleted, page.id);

  const bad = await manage("page", { action: "delete", id: "gid://shopify/Product/1" });
  assert.equal(bad.isError, true);
  const tools = (await client.listTools()).tools;
  assert.match(tools.find((tool) => tool.name === "shopify_search").description, /- blogs:/);
  assert.match(tools.find((tool) => tool.name === "shopify_get").description, /- article:/);
  assert.equal(tools.length, 31);
});
