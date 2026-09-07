type Data = Record<string, any>;
const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  return e;
};
function display(v: unknown): string {
  return v === null || v === undefined
    ? ""
    : typeof v === "object"
      ? JSON.stringify(v)
      : String(v);
}
function table(parent: HTMLElement, rows: Data[], columns?: string[]) {
  if (!rows.length) {
    parent.append(element("p", "No results."));
    return;
  }
  const keys =
    columns ??
    [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) =>
      rows.some((r) => r[k] === null || typeof r[k] !== "object"),
    );
  const wrap = element("div");
  wrap.className = "table-wrap";
  const t = element("table");
  const head = element("tr");
  keys.forEach((k) => head.append(element("th", k)));
  const thead = element("thead");
  thead.append(head);
  t.append(thead);
  const body = element("tbody");
  rows.forEach((r) => {
    const tr = element("tr");
    keys.forEach((k) => tr.append(element("td", display(r[k]))));
    body.append(tr);
  });
  t.append(body);
  wrap.append(t);
  parent.append(wrap);
}
export function render(
  data: Data,
  root: HTMLElement,
  call?: (name: string, args: Data) => Promise<Data>,
  context?: Data,
) {
  root.replaceChildren();
  const header = element("header");
  header.append(
    element("h1", "Shopify Multi Store"),
    element(
      "p",
      data.shop
        ? `${data.store} · ${data.shop}`
        : data.sampleData
          ? "Sample products"
          : "Store results",
    ),
  );
  root.append(header);
  if (data.notice) root.append(element("p", data.notice));
  if (data.error) {
    root.append(element("p", data.error));
    const details = element("pre", JSON.stringify(data, null, 2));
    root.append(details);
    return;
  }
  if (data.complete === false || data.partial || data.failed) {
    const note = element(
      "p",
      "These results are incomplete or contain failed operations. Review the details before you act.",
    );
    note.className = "notice";
    root.append(note);
  }
  if (data.storefrontPreviews || data.previewUrl) {
    const previews = data.storefrontPreviews ?? [data];
    for (const p of previews) {
      const card = element("article");
      card.append(element("h2", p.name ?? p.shop ?? "New store preview"));
      for (const [label, url] of [
        ["Open preview", p.previewUrl],
        ["Claim this store", p.claimUrl],
      ]) {
        if (!url) continue;
        try {
          const u = new URL(url);
          if (
            u.protocol !== "https:" ||
            !/(^|\.)(shopify\.com|myshopify\.com|shopifypreview\.com)$/.test(
              u.hostname,
            )
          )
            continue;
          const link = element("a", label);
          link.href = url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          card.append(link, element("span", " "));
        } catch {}
      }
      root.append(card);
    }
    root.append(
      element(
        "p",
        data.notice ?? "Temporary Shopify store. Claim it to keep it.",
      ),
    );
    return;
  }
  if (data.columns && Array.isArray(data.rows)) {
    const names = data.columns.map((c: Data) => c.name);
    const rows = data.rows.map((r: Data | unknown[]) =>
      Array.isArray(r)
        ? Object.fromEntries(names.map((n: string, i: number) => [n, r[i]]))
        : r,
    );
    if (data.chartHint && rows.length) {
      const hint = data.chartHint;
      const label = names[hint.xAxisColumnIndex];
      const metrics = hint.yAxisColumnIndices.map((i: number) => names[i]);
      const select = element("select");
      select.setAttribute("aria-label", "Chart metric");
      metrics.forEach((m: string) => {
        const o = element("option", m);
        o.value = m;
        select.append(o);
      });
      root.append(select);
      const chart = element("div");
      chart.className = "chart";
      root.append(chart);
      const draw = () => {
        chart.replaceChildren();
        const metric = select.value;
        const values = rows.map((r: Data) => Number(r[metric]));
        const max = Math.max(...values.map(Math.abs), 1);
        if (hint.type === "line" && values.every(Number.isFinite)) {
          const ns = "http://www.w3.org/2000/svg";
          const svg = document.createElementNS(ns, "svg");
          svg.setAttribute("viewBox", "0 0 600 220");
          svg.setAttribute("role", "img");
          svg.setAttribute("aria-label", `${metric} over time`);
          const min = Math.min(0, ...values),
            range = Math.max(...values) - min || 1;
          const points = values.map((v: number, i: number) => [
            30 + (i * 540) / Math.max(values.length - 1, 1),
            190 - ((v - min) / range) * 160,
          ]);
          const line = document.createElementNS(ns, "polyline");
          line.setAttribute(
            "points",
            points.map((p: number[]) => p.join(",")).join(" "),
          );
          line.setAttribute("fill", "none");
          line.setAttribute("stroke", "#287958");
          line.setAttribute("stroke-width", "3");
          svg.append(line);
          points.forEach((p: number[], i: number) => {
            const dot = document.createElementNS(ns, "circle");
            dot.setAttribute("cx", String(p[0]));
            dot.setAttribute("cy", String(p[1]));
            dot.setAttribute("r", "5");
            dot.setAttribute("fill", "#287958");
            const title = document.createElementNS(ns, "title");
            title.textContent = `${rows[i][label]}: ${values[i]}`;
            dot.append(title);
            svg.append(dot);
          });
          chart.append(svg);
        }
        rows.forEach((r: Data, i: number) => {
          const bar = element("div");
          bar.className = "bar-row";
          bar.append(element("span", display(r[label])));
          const meter = element("div");
          meter.className = "meter";
          const fill = element("div");
          fill.style.width = `${(Math.abs(values[i]) / max) * 100}%`;
          fill.className = values[i] < 0 ? "negative" : "";
          meter.append(fill);
          bar.append(
            meter,
            element(
              "span",
              Number.isFinite(values[i])
                ? values[i].toLocaleString()
                : "Unavailable",
            ),
          );
          chart.append(bar);
        });
      };
      select.onchange = draw;
      draw();
    }
    table(root, rows, names);
    return;
  }
  const products =
    data.sampleProducts ??
    data.products?.nodes ??
    (data.product ? [data.product] : undefined);
  if (products) {
    const cards = element("div");
    cards.className = "cards";
    root.append(cards);
    products.forEach((p: Data) => {
      const card = element("article");
      const image = p.featuredImage ?? p.featuredMedia?.preview?.image;
      const u = image?.url;
      if (u) {
        try {
          const parsed = new URL(u);
          if (
            parsed.protocol === "https:" &&
            parsed.hostname === "cdn.shopify.com"
          ) {
            const img = element("img");
            img.src = u;
            img.alt = image.altText ?? p.title ?? "";
            card.append(img);
          }
        } catch {}
      }
      card.append(
        element("h2", p.title ?? "Product"),
        element("p", p.status ?? "Sample"),
        element("p", p.vendor ?? ""),
      );
      if (call && data.store && p.id && !data.sampleData) {
        const button = element("button", "View product");
        button.onclick = async () => {
          button.disabled = true;
          try {
            const result = await call("shopify_get_product", {
              store: data.store,
              id: p.id,
            });
            render(result, root, call, {
              toolName: "shopify_get_product",
              args: { store: data.store, id: p.id },
            });
          } catch (e) {
            card.append(element("p", String(e)));
          } finally {
            button.disabled = false;
          }
        };
        card.append(button);
      }
      if (call && data.sampleData) {
        const add = element("button", "Add as a draft");
        add.onclick = async () => {
          add.disabled = true;
          try {
            const stores = await call("shopify_list_stores", {});
            if (!Array.isArray(stores.stores))
              throw Error(stores.error ?? "Could not list stores.");
            const form = element("form");
            const select = element("select");
            select.setAttribute("aria-label", "Destination store");
            stores.stores.forEach((s: Data) => {
              const o = element("option", `${s.alias} · ${s.shop}`);
              o.value = s.alias;
              select.append(o);
            });
            const price = element("input");
            price.type = "number";
            price.min = "0";
            price.step = "0.01";
            price.required = true;
            price.placeholder = "Price in destination store currency";
            price.setAttribute(
              "aria-label",
              "Price in destination store currency",
            );
            const info = element(
              "p",
              "Choose the destination store and enter its product price.",
            );
            const submit = element("button", "Confirm draft creation");
            submit.type = "submit";
            form.append(select, price, info, submit);
            card.append(form);
            form.onsubmit = async (event) => {
              event.preventDefault();
              submit.disabled = true;
              try {
                const created = await call("shopify_create_product", {
                  store: select.value,
                  confirm: true,
                  title: p.title,
                  descriptionHtml: (p.description ?? "")
                    .replaceAll("&", "&amp;")
                    .replaceAll("<", "&lt;")
                    .replaceAll(">", "&gt;"),
                  price: price.value,
                  status: "DRAFT",
                  ...(u
                    ? {
                        images: [
                          { url: u, altText: image?.altText ?? p.title },
                        ],
                      }
                    : {}),
                });
                if (created.error) throw Error(created.error);
                render(created, root, call);
              } catch (e) {
                info.textContent = String(e);
                submit.disabled = false;
              }
            };
          } catch (e) {
            card.append(element("p", String(e)));
            add.disabled = false;
          }
        };
        card.append(add);
      }
      if (p.variants?.nodes)
        table(card, p.variants.nodes, [
          "title",
          "sku",
          "price",
          "inventoryQuantity",
        ]);
      cards.append(card);
    });
    const connection = data.products ?? data.product?.variants;
    if (connection?.pageInfo?.hasNextPage && call && context) {
      const next = element("button", "Next page");
      next.onclick = async () => {
        next.disabled = true;
        const args = { ...context.args, after: connection.pageInfo.endCursor };
        try {
          render(await call(context.toolName, args), root, call, {
            ...context,
            args,
          });
        } catch (e) {
          root.append(element("p", String(e)));
        } finally {
          next.disabled = false;
        }
      };
      root.append(next);
    }
  } else {
    const collection =
      data.collections?.nodes ??
      data.orders?.nodes ??
      data.customers?.nodes ??
      data.results ??
      data.summaries ??
      data.publications;
    if (Array.isArray(collection)) table(root, collection);
  }
  const details = element("details");
  details.append(element("summary", "Details"));
  const pre = element("pre", JSON.stringify(data, null, 2));
  details.append(pre);
  root.append(details);
}
