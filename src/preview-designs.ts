import { dawnSource } from "./theme-source.js";
import { DOCS } from "./admin-documents.js";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/server";
import { createPreview, previewInfo } from "./previews.js";
import { cliJson } from "./cli-bridge.js";
import { configPath } from "./config.js";
import { workflow, textResult, toolError } from "./admin-workflows.js";
import { serializeStore, withFileLock, atomicJson } from "./concurrency.js";
import { UI_META } from "./ui.js";
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const Design = z
  .object({
    name: z.string().min(1).max(40),
    headline: z.string().min(1).max(120),
    description: z.string().max(500),
    background: hex,
    foreground: hex,
    accent: hex,
    buttonLabel: hex,
    layout: z.enum(["hero-first", "products-first", "editorial"]),
  })
  .strict();
const PreviewProduct = z
  .object({
    title: z.string().min(1).max(255),
    description: z.string().max(2000),
    price: z.string().regex(/^\d+(\.\d{1,2})?$/),
    imageUrl: z.url().startsWith("https://cdn.shopify.com/").optional(),
    imageAlt: z.string().max(1000).optional(),
  })
  .strict();
export async function seedPreviewProducts(
  alias: string,
  products: z.infer<typeof PreviewProduct>[],
) {
  const w = await workflow(alias);
  if (w.store.auth.type !== "shopify_cli" || !alias.startsWith("preview-"))
    throw Error("Product seeding is restricted to new preview stores.");
  await w.requireScopes(["write_products", "write_publications"]);
  const pubs = await w.all(DOCS.publications, {}, "publications");
  const online = pubs.find((p) => p.name === "Online Store");
  if (!online) throw Error("Online Store publication is unavailable.");
  const ids: string[] = [];
  for (const p of products) {
    const created = await w.run(DOCS.productCreate, {
      input: {
        title: p.title,
        descriptionHtml: `<p>${escape(p.description)}</p>`,
        status: "ACTIVE",
        tags: ["preview-sample"],
      },
      media: p.imageUrl
        ? [
            {
              originalSource: p.imageUrl,
              alt: p.imageAlt ?? p.title,
              mediaContentType: "IMAGE",
            },
          ]
        : [],
    });
    const id = created.productCreate?.product?.id;
    if (!id) throw Error("No preview product ID returned.");
    ids.push(id);
    const product = await w.product(id);
    await w.run(DOCS.variantsUpdate, {
      productId: id,
      variants: [
        {
          id: product.product.variants.nodes[0].id,
          price: p.price,
          inventoryPolicy: "CONTINUE",
        },
      ],
    });
    await w.publish(id, [online.id]);
  }
  return ids;
}
type DesignInput = z.infer<typeof Design>;
const escape = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export async function buildDesign(
  design: DesignInput,
  sourceDirectory?: string,
) {
  const path = await mkdtemp(join(tmpdir(), "shopify-preview-theme-"));
  const source = sourceDirectory ?? (await dawnSource());
  for (const directory of [
    "assets",
    "config",
    "layout",
    "locales",
    "sections",
    "snippets",
    "templates",
  ])
    await cp(join(source, directory), join(path, directory), {
      recursive: true,
    });
  const settings = JSON.parse(
    await readFile(join(path, "config/settings_data.json"), "utf8"),
  );
  const current = settings.presets.Dawn;
  for (const scheme of Object.values(current.color_schemes) as any[])
    Object.assign(scheme.settings, {
      background: design.background,
      text: design.foreground,
      button: design.accent,
      button_label: design.buttonLabel,
      secondary_button_label: design.accent,
    });
  settings.current = current;
  await writeFile(
    join(path, "config/settings_data.json"),
    JSON.stringify(settings),
  );
  const index = JSON.parse(
    await readFile(join(path, "templates/index.json"), "utf8"),
  );
  // Dawn's native rich-text section remains editable and avoids a stock placeholder image.
  index.sections.image_banner = {
    type: "rich-text",
    blocks: {
      heading: {
        type: "heading",
        settings: { heading: escape(design.headline), heading_size: "h0" },
      },
      text: {
        type: "text",
        settings: { text: `<p>${escape(design.description)}</p>` },
      },
      button: {
        type: "button",
        settings: {
          button_label: "Shop all",
          button_link: "shopify://collections/all",
          button_style_secondary: false,
        },
      },
    },
    block_order: ["heading", "text", "button"],
    settings: {
      color_scheme: "scheme-1",
      content_alignment: design.layout === "editorial" ? "left" : "center",
      full_width: true,
      padding_top: 80,
      padding_bottom: 80,
    },
  };
  index.order = ["image_banner", "featured_collection"];
  if (design.layout === "products-first") index.order.reverse();
  index.sections.featured_collection.settings.columns_desktop =
    design.layout === "editorial" ? 2 : 4;
  // Keep only sections used by this layout.
  index.sections = Object.fromEntries(
    index.order.map((k: string) => [k, index.sections[k]]),
  );
  await writeFile(join(path, "templates/index.json"), JSON.stringify(index));
  return path;
}
async function resultLinks(job: any) {
  return {
    status: "complete",
    temporary: true,
    storefrontPreviews: await Promise.all(
      job.themes.map(async (t: any) => ({
        ...t,
        ...(await previewInfo(t.shop)),
      })),
    ),
    notice:
      "Each design is a separate temporary Shopify store. Claim the design you want to keep.",
  };
}
export function registerAsyncPreview(
  server: McpServer,
  name: string,
  definition: any,
  handler: (a: any) => Promise<any>,
) {
  const active = new Set<string>();
  const statusPath = (id: string) =>
    join(dirname(configPath()), `preview-design-${id}.status.json`);
  const pending = (id: string) =>
    textResult({
      status: "pending",
      requestId: id,
      notice:
        "Storefront previews are being built. Check status with shopify_get_new_store_preview_status.",
    });
  const readStatus = async (id: string) => {
    const status = JSON.parse(await readFile(statusPath(id), "utf8"));
    if (status.state === "complete") {
      const job = JSON.parse(
        await readFile(
          join(dirname(configPath()), `preview-design-${id}.json`),
          "utf8",
        ),
      );
      return textResult(await resultLinks(job));
    }
    if (status.state === "failed") return textResult(status.error, true);
    return active.has(id)
      ? pending(id)
      : textResult(
          {
            error:
              "Preview generation was interrupted. Inspect the creation receipts before recovery.",
            requestId: id,
          },
          true,
        );
  };
  server.registerTool(name, definition, async (args) => {
    const a = args as any;
    try {
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(a))
        .digest("hex");
      try {
        const existing = JSON.parse(
          await readFile(statusPath(a.requestId), "utf8"),
        );
        if (existing.fingerprint !== fingerprint)
          throw Error("requestId belongs to another preview request.");
        return await readStatus(a.requestId);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      await mkdir(dirname(statusPath(a.requestId)), { recursive: true });
      await atomicJson(
        statusPath(a.requestId),
        { state: "pending", fingerprint },
        true,
      );
      active.add(a.requestId);
      void handler(a)
        .then(async (result) => {
          await atomicJson(
            statusPath(a.requestId),
            {
              state: result.isError ? "failed" : "complete",
              fingerprint,
              ...(result.isError
                ? {
                    error: result.structuredContent ?? {
                      error: "Preview generation failed.",
                    },
                  }
                : {}),
            },
          );
        })
        .catch(async () => {
          await atomicJson(
            statusPath(a.requestId),
            {
              state: "failed",
              fingerprint,
              error: {
                error:
                  "Preview generation failed. Inspect the creation receipts before retrying.",
              },
            },
          ).catch(() => {});
        })
        .finally(() => active.delete(a.requestId));
      return pending(a.requestId);
    } catch (e) {
      return toolError(e);
    }
  });
  server.registerTool(
    "shopify_get_new_store_preview_status",
    {
      description:
        "Check an asynchronous storefront preview request and retrieve fresh preview and claim links.",
      _meta: UI_META,
      inputSchema: z.object({ requestId: z.string().uuid() }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (a) => {
      try {
        return await readStatus(a.requestId);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
export function registerPreviewDesignTools(server: McpServer) {
  registerAsyncPreview(
    server,
    "shopify_get_new_store_previews",
    {
      description:
        "Start an asynchronous build of 1–3 designed storefront previews on separate NEW temporary Shopify stores, with a real claim link. Generate concrete design specifications from the user brief. Uses Shopify Dawn; does not alter an existing store. Reuse requestId after interruption. Generate demo products and designs from the brief. Products, pricing, and storefront copy remain editable after claiming.",
      _meta: UI_META,
      inputSchema: z
        .object({
          requestId: z.string().uuid(),
          productOrService: z.string().min(1).max(78),
          targetAudience: z.string().min(1).max(78),
          brandStyle: z.string().min(1).max(78),
          name: z.string().min(1).max(100),
          country: z
            .string()
            .regex(/^[A-Z]{2}$/)
            .default("US"),
          userUnderstandsNewStoreOnly: z.literal(true),
          designs: z.array(Design).min(1).max(3),
          products: z
            .array(PreviewProduct)
            .min(1)
            .max(10)
            .describe(
              "Generate demo product concepts and proposed prices from the brief. Do not claim these are verified supplier offers.",
            ),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (a) => {
      const file = join(
        dirname(configPath()),
        `preview-design-${a.requestId}.json`,
      );
      return serializeStore(file, () =>
        withFileLock(file + ".lock", async () => {
          try {
            let job: any;
            try {
              job = JSON.parse(await readFile(file, "utf8"));
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
            }
            const fingerprint = JSON.stringify(a);
            if (job) {
              if (job.fingerprint !== fingerprint)
                throw Error("requestId belongs to a different design request.");
              if (job.state !== "complete")
                return textResult(
                  {
                    error:
                      "Preview design has an incomplete or uncertain outcome. Inspect existing themes before retrying.",
                    ...job,
                  },
                  true,
                );
              return textResult(await resultLinks(job));
            }
            const store = await createPreview(a);
            job = {
              fingerprint,
              state: "starting",
              shop: store.shop,
              store: store.alias,
              themes: [],
            };
            await mkdir(dirname(file), { recursive: true });
            await atomicJson(file, job);
            for (const [i, design] of a.designs.entries()) {
              const hash = createHash("sha256")
                .update(a.requestId + ":" + i)
                .digest("hex")
                .slice(0, 32);
              const childId = hash.replace(
                /(.{8})(.{4})(.{4})(.{4})(.{12})/,
                "$1-$2-$3-$4-$5",
              );
              const target =
                i === 0
                  ? store
                  : await createPreview({
                      requestId: childId,
                      name: `${a.name} ${i + 1}`,
                      country: a.country,
                    });
              const productIds = await seedPreviewProducts(
                target.alias,
                a.products,
              );
              job.products = {
                ...(job.products ?? {}),
                [target.alias]: productIds,
              };
              await atomicJson(file, job);
              const directory = await buildDesign(design);
              const r = await cliJson(
                [
                  "theme",
                  "push",
                  "--store",
                  target.shop,
                  "--path",
                  directory,
                  "--unpublished",
                  "--theme",
                  design.name,
                  "--json",
                ],
                180_000,
              );
              if (!r.theme?.id || !r.theme?.preview_url)
                throw Error("Shopify did not confirm the new preview theme.");
              const w = await workflow(target.alias);
              await w.run(
                "mutation PublishPreview($id:ID!){themePublish(id:$id){theme{id name role} userErrors{field message}}}",
                { id: `gid://shopify/OnlineStoreTheme/${r.theme.id}` },
              );
              const verified = await w.run(
                "query VerifyPreview($id:ID!){theme(id:$id){id role}}",
                { id: `gid://shopify/OnlineStoreTheme/${r.theme.id}` },
              );
              if (verified.theme?.role !== "MAIN")
                throw Error("Theme publication readback failed.");
              job.themes.push({
                name: design.name,
                themeId: String(r.theme.id),
                shop: target.shop,
                store: target.alias,
              });
              await atomicJson(file, job);
            }
            job.state = "complete";
            await atomicJson(file, job);
            return textResult(await resultLinks(job));
          } catch (e) {
            return toolError(e);
          }
        }),
      );
    },
  );
}
