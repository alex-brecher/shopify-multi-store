import { deletePassword, diagnose, getPassword, setPassword, useBackend } from "cross-keychain";
export const CREDENTIAL_SERVICE = "codex-shopify-multi-store";
const SECURE_BACKENDS = new Set([
    "native-macos",
    "macos",
    "native-windows",
    "windows",
    "native-linux",
    "secret-service"
]);
const credentialCache = new Map();
let backendPromise;
export function accessTokenAccount(alias) {
    return alias;
}
export function clientSecretAccount(alias) {
    return `${alias}:client-secret`;
}
export async function credentialBackend() {
    backendPromise ??= (async () => {
        if (process.platform === "darwin")
            await useBackend("macos");
        const details = await diagnose();
        const id = String(details.id ?? "unknown");
        const name = String(details.name ?? id);
        if (!SECURE_BACKENDS.has(id) && process.env.SHOPIFY_MULTI_STORE_ALLOW_FILE_KEYRING !== "1") {
            throw new Error(`A secure operating-system credential store is unavailable. Detected backend: ${name} (${id}). ` +
                "Install or unlock macOS Keychain, Windows Credential Manager, or Linux Secret Service.");
        }
        return { id, name };
    })();
    return backendPromise;
}
export async function storeCredential(account, value) {
    await credentialBackend();
    await setPassword(CREDENTIAL_SERVICE, account, value);
    credentialCache.set(account, value);
}
export async function readCredential(account) {
    const cached = credentialCache.get(account);
    if (cached)
        return cached;
    await credentialBackend();
    const value = await getPassword(CREDENTIAL_SERVICE, account);
    if (value)
        credentialCache.set(account, value);
    return value;
}
export async function removeCredential(account) {
    await credentialBackend();
    credentialCache.delete(account);
    try {
        await deletePassword(CREDENTIAL_SERVICE, account);
    }
    catch {
        // Configuration removal remains valid when the credential does not exist.
    }
}
//# sourceMappingURL=credentials.js.map