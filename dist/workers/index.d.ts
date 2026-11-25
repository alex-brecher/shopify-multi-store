export { OAuthStoreObject } from "./do-store.js";
declare const _default: {
    scheduled(_controller: unknown, env: import("./types.js").WorkerEnv, ctx?: import("./types.js").ExecutionContextLike): Promise<void>;
    fetch(request: Request, env: import("./types.js").WorkerEnv, _ctx?: import("./types.js").ExecutionContextLike): Promise<Response>;
};
export default _default;
