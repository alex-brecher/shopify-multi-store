import { mapConcurrent } from "./concurrency.js";
type Catalog = { name: string; url: string; description: string };
export function catalogs(text: string): Catalog[] {
  return [
    ...text.matchAll(
      /^- \[([^\]]+)\]\((https:\/\/(?:[a-z0-9-]+\.)?mock\.shop\/api)\): (.+)$/gm,
    ),
  ].map((m) => ({ name: m[1]!, url: m[2]!, description: m[3]! }));
}
const terms = (text: string) =>
  text
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((t) => !["a", "an", "the", "for", "of", "and", "with"].includes(t))
    .map((t) => (t.length > 3 ? t.replace(/s$/, "") : t)) ?? [];
let cached: { until: number; items: Catalog[] } | undefined;
async function catalogList() {
  if (cached && cached.until > Date.now()) return cached.items;
  const r = await fetch("https://mock.shop/llms.txt", {
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  });
  if (!r.ok) throw Error("Could not load sample catalog index.");
  const items = catalogs(await r.text());
  if (!items.length) throw Error("No published sample catalogs returned.");
  cached = { until: Date.now() + 3600000, items };
  return items;
}
export async function sampleProducts(query: string, limit: number) {
  const tokens = terms(query);
  const score = (text: string) =>
    tokens.filter((t) => terms(text).includes(t)).length;
  const selected = (await catalogList())
    .map((c) => ({
      ...c,
      score:
        score(c.name + " " + c.description) +
        5 * score(new URL(c.url).hostname.split(".")[0]!),
    }))
    .sort((a, b) => b.score - a.score)
    .filter((c, i) => c.score > 0 && i < 3);
  if (!selected.length)
    return {
      query,
      sampleData: true,
      sampleProducts: [],
      catalogOnly: true,
      notice:
        "No matching published demo catalog. Describe a broader product category.",
    };
  const results = await mapConcurrent(
    selected,
    async (c) => {
      try {
        const r = await fetch(c.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query:
              "{products(first:100){nodes{id title description featuredImage{url altText} priceRange{minVariantPrice{amount currencyCode}}}}}",
          }),
          signal: AbortSignal.timeout(30000),
          redirect: "error",
        });
        const b = (await r.json()) as any;
        if (!r.ok || b.errors || !Array.isArray(b.data?.products?.nodes))
          throw Error("Catalog request failed.");
        return {
          catalog: c.url,
          products: b.data.products.nodes.map((p: any) => ({
            ...p,
            source: c.url,
            score: score(p.title + " " + p.description) + c.score,
          })),
        };
      } catch {
        return { catalog: c.url, products: [], failed: true };
      }
    },
    3,
  );
  const products = results
    .flatMap((r) => r.products)
    .sort((a, b) => b.score - a.score);
  const unique = [
    ...new Map(products.map((p) => [`${p.source}:${p.id}`, p])).values(),
  ];
  return {
    query,
    sampleData: true,
    catalogOnly: true,
    sourceCatalogs: results.map((r) => ({
      url: r.catalog,
      failed: !!r.failed,
    })),
    complete: results.every((r) => !r.failed),
    sampleProducts: unique
      .filter((p) => p.score > 0)
      .slice(0, limit)
      .map(({ score, ...p }) => p),
    notice:
      "Demo product concepts from published Shopify catalogs. Review copy, images, claims, and pricing before selling.",
  };
}
