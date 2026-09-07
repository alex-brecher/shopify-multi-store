import { App } from "@modelcontextprotocol/ext-apps";
import { render } from "./render.js";
const app = new App({ name: "Shopify Multi Store", version: "1.6.0-beta.1" }, {});
const root = document.getElementById("app")!;
const show = (result: any) =>
  render(
    result.structuredContent ?? {
      error:
        result.content?.find((c: any) => c.type === "text")?.text ?? "No data",
    },
    root,
    async (name, args) => {
      const r = await app.callServerTool({ name, arguments: args });
      return (
        r.structuredContent ?? {
          error: r.content?.find((c: any) => c.type === "text")?.text,
        }
      );
    },
    result._meta?.uiContext,
  );
app.ontoolresult = show;
app.onhostcontextchanged = (context) => {
  if (context.theme) document.documentElement.dataset.theme = context.theme;
};
app.connect().catch((error) => {
  root.textContent = `Could not connect to the host: ${error.message}`;
});
