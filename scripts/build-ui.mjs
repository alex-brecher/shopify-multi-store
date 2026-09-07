import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
const result = await build({
  entryPoints: ["ui/app.ts"],
  bundle: true,
  write: false,
  format: "esm",
  target: "es2022",
  minify: true,
});
await mkdir("dist/ui", { recursive: true });
await writeFile(
  "dist/ui/app.html",
  `<!doctype html><html lang="en"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shopify Multi Store</title><style>${await readFile("ui/style.css", "utf8")}</style><main id="app" aria-live="polite">Loading store results…</main><script type="module">${result.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></html>`,
);
