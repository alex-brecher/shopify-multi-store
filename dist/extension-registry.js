export const EXTRA_SEARCH = {};
export const EXTRA_GET = {};
/** Every shopify_manage operation, keyed by name (built-in ones included). */
export const MANAGE_OPERATIONS = {};
function unique(map, name, what) {
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(name))
        throw new Error(`Bad ${what} name ${name}.`);
    if (name in map)
        throw new Error(`${what} ${name} is registered twice.`);
}
export function registerSearchResource(name, def) {
    unique(EXTRA_SEARCH, name, "search resource");
    EXTRA_SEARCH[name] = def;
}
export function registerGetResource(name, def) {
    unique(EXTRA_GET, name, "get resource");
    EXTRA_GET[name] = def;
}
export function registerManageOperation(name, def) {
    unique(MANAGE_OPERATIONS, name, "manage operation");
    MANAGE_OPERATIONS[name] = def;
}
/** REQUIRED_SCOPES entries for every registered extension. */
export function extensionScopes() {
    return {
        ...Object.fromEntries(Object.entries(EXTRA_SEARCH).map(([name, def]) => [`shopify_search:${name}`, def.scopes])),
        ...Object.fromEntries(Object.entries(EXTRA_GET).map(([name, def]) => [`shopify_get:${name}`, def.scopes]))
    };
}
//# sourceMappingURL=extension-registry.js.map