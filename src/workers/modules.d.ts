/** wrangler.jsonc bundles *.json.gz files as Data modules: the raw bytes as an ArrayBuffer. */
declare module "*.json.gz" {
  const data: ArrayBuffer;
  export default data;
}
