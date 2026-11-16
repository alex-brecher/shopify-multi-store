import { z } from "zod/v4";
import { registerGetResource, registerManageOperation, registerSearchResource } from "../extension-registry.js";
import type { Data } from "../admin-workflows.js";

// Online Store content: blogs (list, update), pages and articles (read, create, update, delete).
// Pages are already listed by the built-in "pages" resource and a blog's articles by "blog_articles".
// Shopify's page and article inputs have no SEO fields (those live in the global.title_tag and
// global.description_tag metafields), so seo is not offered here; use shopify_metafields for it.

const PAGE_FIELDS = "id title handle body bodySummary isPublished publishedAt templateSuffix createdAt updatedAt";
const ARTICLE_FIELDS =
  "id title handle body summary tags isPublished publishedAt templateSuffix createdAt updatedAt author { name } image { url altText } blog { id title handle }";
const BLOG_FIELDS = "id title handle commentPolicy templateSuffix tags articlesCount { count precision } createdAt updatedAt";
const ERRORS = "userErrors { field message }";

export const CONTENT_DOCS = {
  listBlogs: `query ListBlogs($first: Int!, $after: String, $query: String) {
  blogs(first: $first, after: $after, query: $query) { nodes { ${BLOG_FIELDS} } pageInfo { hasNextPage endCursor } }
}`,
  getPage: `query GetPage($id: ID!) { page(id: $id) { ${PAGE_FIELDS} } }`,
  getArticle: `query GetArticle($id: ID!) { article(id: $id) { ${ARTICLE_FIELDS} } }`,
  getBlog: `query GetBlog($id: ID!) { blog(id: $id) { ${BLOG_FIELDS} } }`,
  createPage: `mutation CreatePage($page: PageCreateInput!) { pageCreate(page: $page) { page { ${PAGE_FIELDS} } ${ERRORS} } }`,
  updatePage: `mutation UpdatePage($id: ID!, $page: PageUpdateInput!) { pageUpdate(id: $id, page: $page) { page { ${PAGE_FIELDS} } ${ERRORS} } }`,
  deletePage: `mutation DeletePage($id: ID!) { pageDelete(id: $id) { deletedPageId ${ERRORS} } }`,
  createArticle: `mutation CreateArticle($article: ArticleCreateInput!) { articleCreate(article: $article) { article { ${ARTICLE_FIELDS} } ${ERRORS} } }`,
  updateArticle: `mutation UpdateArticle($id: ID!, $article: ArticleUpdateInput!) { articleUpdate(id: $id, article: $article) { article { ${ARTICLE_FIELDS} } ${ERRORS} } }`,
  deleteArticle: `mutation DeleteArticle($id: ID!) { articleDelete(id: $id) { deletedArticleId ${ERRORS} } }`,
  updateBlog: `mutation UpdateBlog($id: ID!, $blog: BlogUpdateInput!) { blogUpdate(id: $id, blog: $blog) { blog { ${BLOG_FIELDS} } ${ERRORS} } }`,
};

const PAGE_ID = /^gid:\/\/shopify\/Page\/[0-9]+$/;
const ARTICLE_ID = /^gid:\/\/shopify\/Article\/[0-9]+$/;
const BLOG_ID = /^gid:\/\/shopify\/Blog\/[0-9]+$/;
const HANDLE = /^[a-z0-9][a-z0-9_-]{0,254}$/;
const PREVIEW = "Nothing was changed. Pass dryRun:false to apply.";

const publishDate = z
  .string()
  .max(40)
  .refine((value) => /^\d{4}-\d{2}-\d{2}(T|$)/.test(value) && !Number.isNaN(Date.parse(value)), "publishDate must be an ISO 8601 date or date time, such as 2026-12-01T09:00:00Z")
  .describe("ISO 8601 date time. Setting it publishes at that time; do not combine with isPublished:false.");
const handle = z.string().max(255).regex(HANDLE, "handle is lowercase letters, digits, hyphens and underscores").describe("URL handle, such as about-us");
const html = z.string().max(500_000);
const templateSuffix = z.string().max(255).regex(/^[A-Za-z0-9_.-]*$/).describe("Theme template suffix, such as contact. Empty string resets to the default template.");

registerSearchResource("blogs", {
  document: CONTENT_DOCS.listBlogs,
  scopes: ["read_content"],
  description: "Online Store blogs (query: such as \"handle:news\" or \"title:Recipes\"). Returns id, title, handle, commentPolicy, articlesCount, templateSuffix, updatedAt.",
});

registerGetResource("page", {
  document: CONTENT_DOCS.getPage,
  root: "page",
  types: ["Page"],
  label: "Page",
  scopes: ["read_content"],
  description: "One Online Store page with its HTML body, handle, isPublished, publishedAt and templateSuffix. id: Page GID.",
});

registerGetResource("article", {
  document: CONTENT_DOCS.getArticle,
  root: "article",
  types: ["Article"],
  label: "Article",
  scopes: ["read_content"],
  description: "One blog article with body, summary, author, tags, image, isPublished, publishedAt and its blog. id: Article GID.",
});

function pick(a: Data, keys: string[]): Data {
  const out: Data = {};
  for (const key of keys) if (a[key] !== undefined) out[key] = a[key];
  return out;
}

const PAGE_KEYS = ["title", "body", "handle", "isPublished", "publishDate", "templateSuffix"];

registerManageOperation("page", {
  description:
    "Create, update or delete an Online Store page (pageCreate / pageUpdate / pageDelete). body is HTML. update and delete read the page first; update previews current and changes. A handle change on update can leave the old URL redirecting (redirectNewHandle). delete cannot be undone and needs confirm:\"delete\". seo is not available: Shopify's page input has no SEO fields.",
  shape: {
    action: z.enum(["create", "update", "delete"]),
    id: z.string().regex(PAGE_ID).optional().describe("update and delete: Page GID"),
    title: z.string().min(1).max(255).optional().describe("create needs it"),
    body: html.optional(),
    handle: handle.optional(),
    isPublished: z.boolean().optional(),
    publishDate: publishDate.optional(),
    templateSuffix: templateSuffix.optional(),
    redirectNewHandle: z.boolean().optional().describe("update: redirect the old handle to the new one"),
  },
  scopes: ["write_content"],
  confirmWord: (a) => (a.action === "delete" ? "delete" : undefined),
  handler: async (w, a) => {
    if (a.action === "create") {
      if (!a.title) throw Error("create needs title.");
      const page = pick(a, PAGE_KEYS);
      if (a.dryRun) return { dryRun: true, wouldCreate: page, message: PREVIEW };
      const d = await w.run(CONTENT_DOCS.createPage, { page });
      return { dryRun: false, created: d.pageCreate?.page };
    }
    if (!a.id) throw Error(`${a.action} needs id.`);
    const current = (await w.run(CONTENT_DOCS.getPage, { id: a.id })).page;
    if (!current) throw Error(`No page ${a.id} on this store.`);
    if (a.action === "update") {
      const page = { ...pick(a, PAGE_KEYS), ...pick(a, ["redirectNewHandle"]) };
      if (!Object.keys(page).length) throw Error("update needs at least one of title, body, handle, isPublished, publishDate, templateSuffix.");
      if (a.dryRun) return { dryRun: true, current, changes: page, message: PREVIEW };
      const d = await w.run(CONTENT_DOCS.updatePage, { id: a.id, page });
      return { dryRun: false, before: current, updated: d.pageUpdate?.page };
    }
    if (a.dryRun) return { dryRun: true, wouldDelete: current, message: "Nothing was changed. Pass dryRun:false and confirm:\"delete\" to apply." };
    const d = await w.run(CONTENT_DOCS.deletePage, { id: a.id });
    return { dryRun: false, deleted: d.pageDelete?.deletedPageId, was: current };
  },
});

const ARTICLE_KEYS = ["title", "body", "summary", "handle", "isPublished", "publishDate", "templateSuffix", "tags", "blogId"];

function articleInput(a: Data): Data {
  const input = pick(a, ARTICLE_KEYS);
  if (a.author !== undefined) input.author = { name: a.author };
  if (a.imageUrl !== undefined) input.image = { url: a.imageUrl, ...(a.imageAlt !== undefined ? { altText: a.imageAlt } : {}) };
  else if (a.imageAlt !== undefined) input.image = { altText: a.imageAlt };
  return input;
}

registerManageOperation("article", {
  description:
    "Create, update or delete a blog article (articleCreate / articleUpdate / articleDelete). create needs blogId, title and author (a name). body and summary are HTML; imageUrl is a public https URL with imageAlt. update and delete read the article first; blogId on update moves it to another blog. delete cannot be undone and needs confirm:\"delete\".",
  shape: {
    action: z.enum(["create", "update", "delete"]),
    id: z.string().regex(ARTICLE_ID).optional().describe("update and delete: Article GID"),
    blogId: z.string().regex(BLOG_ID).optional().describe("create: the blog to post in. update: move to this blog"),
    title: z.string().min(1).max(255).optional().describe("create needs it"),
    body: html.optional(),
    summary: html.optional(),
    author: z.string().min(1).max(255).optional().describe("Author name; create needs it"),
    tags: z.array(z.string().min(1).max(255)).max(250).optional(),
    imageUrl: z.string().max(2000).refine((value) => { try { return new URL(value).protocol === "https:"; } catch { return false; } }, "imageUrl must be an https:// URL").optional(),
    imageAlt: z.string().max(512).optional().describe("Alt text for the image"),
    isPublished: z.boolean().optional(),
    publishDate: publishDate.optional(),
    handle: handle.optional(),
    templateSuffix: templateSuffix.optional(),
    redirectNewHandle: z.boolean().optional().describe("update: redirect the old handle to the new one"),
  },
  scopes: ["write_content"],
  confirmWord: (a) => (a.action === "delete" ? "delete" : undefined),
  handler: async (w, a) => {
    if (a.action === "create") {
      if (!a.blogId) throw Error("create needs blogId.");
      if (!a.title) throw Error("create needs title.");
      if (!a.author) throw Error("create needs author (a name).");
      const blog = (await w.run(CONTENT_DOCS.getBlog, { id: a.blogId })).blog;
      if (!blog) throw Error(`No blog ${a.blogId} on this store.`);
      const article = articleInput(a);
      if (a.dryRun) return { dryRun: true, blog: { id: blog.id, title: blog.title, handle: blog.handle }, wouldCreate: article, message: PREVIEW };
      const d = await w.run(CONTENT_DOCS.createArticle, { article });
      return { dryRun: false, created: d.articleCreate?.article };
    }
    if (!a.id) throw Error(`${a.action} needs id.`);
    const current = (await w.run(CONTENT_DOCS.getArticle, { id: a.id })).article;
    if (!current) throw Error(`No article ${a.id} on this store.`);
    if (a.action === "update") {
      const article = { ...articleInput(a), ...pick(a, ["redirectNewHandle"]) };
      if (!Object.keys(article).length) throw Error("update needs at least one field to change.");
      if (a.dryRun) return { dryRun: true, current, changes: article, message: PREVIEW };
      const d = await w.run(CONTENT_DOCS.updateArticle, { id: a.id, article });
      return { dryRun: false, before: current, updated: d.articleUpdate?.article };
    }
    if (a.dryRun) return { dryRun: true, wouldDelete: current, message: "Nothing was changed. Pass dryRun:false and confirm:\"delete\" to apply." };
    const d = await w.run(CONTENT_DOCS.deleteArticle, { id: a.id });
    return { dryRun: false, deleted: d.articleDelete?.deletedArticleId, was: current };
  },
});

registerManageOperation("blog", {
  description:
    "Update a blog's title, handle, commentPolicy (AUTO_PUBLISHED, MODERATED or CLOSED) or templateSuffix (blogUpdate). Update only: blogs are not created or deleted here. Reads the blog first; dryRun:true (the default) previews. redirectNewHandle and redirectArticles keep old URLs working after a handle change.",
  shape: {
    id: z.string().regex(BLOG_ID).describe("Blog GID"),
    title: z.string().min(1).max(255).optional(),
    handle: handle.optional(),
    commentPolicy: z.enum(["AUTO_PUBLISHED", "MODERATED", "CLOSED"]).optional(),
    templateSuffix: templateSuffix.optional(),
    redirectNewHandle: z.boolean().optional().describe("Redirect the old blog handle to the new one"),
    redirectArticles: z.boolean().optional().describe("Redirect the articles' old URLs to the new ones"),
  },
  scopes: ["write_content"],
  handler: async (w, a) => {
    const current = (await w.run(CONTENT_DOCS.getBlog, { id: a.id })).blog;
    if (!current) throw Error(`No blog ${a.id} on this store.`);
    const blog = pick(a, ["title", "handle", "commentPolicy", "templateSuffix", "redirectNewHandle", "redirectArticles"]);
    if (!Object.keys(blog).length) throw Error("update needs at least one of title, handle, commentPolicy, templateSuffix.");
    if (a.dryRun) return { dryRun: true, current, changes: blog, message: PREVIEW };
    const d = await w.run(CONTENT_DOCS.updateBlog, { id: a.id, blog });
    return { dryRun: false, before: current, updated: d.blogUpdate?.blog };
  },
});
