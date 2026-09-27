/**
 * Stand-in for cross-keychain in the Worker bundle (wrangler.jsonc `alias`). A hosted server
 * never reads the OS keychain; config.ts only imports it on the local stdio path. If anything
 * ever calls it on a Worker, it fails loudly instead of loading native keychain code.
 */
declare function unavailable(): never;
export declare class PasswordDeleteError extends Error {
}
export declare const deletePassword: typeof unavailable;
export declare const diagnose: typeof unavailable;
export declare const getPassword: typeof unavailable;
export declare const setPassword: typeof unavailable;
export declare const useBackend: typeof unavailable;
export {};
