/**
 * Stand-in for cross-keychain in the Worker bundle (wrangler.jsonc `alias`). A hosted server
 * never reads the OS keychain; config.ts only imports it on the local stdio path. If anything
 * ever calls it on a Worker, it fails loudly instead of loading native keychain code.
 */
function unavailable() {
    throw new Error("The OS keychain is not available on a hosted server.");
}
export class PasswordDeleteError extends Error {
}
export const deletePassword = unavailable;
export const diagnose = unavailable;
export const getPassword = unavailable;
export const setPassword = unavailable;
export const useBackend = unavailable;
//# sourceMappingURL=cross-keychain.js.map