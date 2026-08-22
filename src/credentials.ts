import { deletePassword, diagnose, getPassword, PasswordDeleteError, setPassword, useBackend } from "cross-keychain";

export const CREDENTIAL_SERVICE = "codex-shopify-multi-store";

const SECURE_BACKENDS = new Set([
  "native-macos",
  "macos",
  "native-windows",
  "windows",
  "native-linux",
  "secret-service"
]);

let backendPromise: Promise<{ id: string; name: string }> | undefined;

export function accessTokenAccount(alias: string): string {
  return alias;
}

export function clientSecretAccount(alias: string): string {
  return `${alias}:client-secret`;
}

export async function credentialBackend(): Promise<{ id: string; name: string }> {
  backendPromise ??= (async () => {
    if (process.platform === "darwin") await useBackend("macos");
    const details = await diagnose();
    const id = String(details.id ?? "unknown");
    const name = String(details.name ?? id);
    if (!SECURE_BACKENDS.has(id) && process.env.SHOPIFY_MULTI_STORE_ALLOW_FILE_KEYRING !== "1") {
      throw new Error(
        `A secure operating-system credential store is unavailable. Detected backend: ${name} (${id}). ` +
        "Install or unlock macOS Keychain, Windows Credential Manager, or Linux Secret Service."
      );
    }
    return { id, name };
  })();
  return backendPromise;
}

export async function storeCredential(account: string, value: string): Promise<void> {
  await credentialBackend();
  await setPassword(CREDENTIAL_SERVICE, account, value);
}

export async function readCredential(account: string): Promise<string | null> {
  await credentialBackend();
  return getPassword(CREDENTIAL_SERVICE, account);
}

export async function removeCredential(account: string): Promise<void> {
  await credentialBackend();
  try {
    await deletePassword(CREDENTIAL_SERVICE, account);
  } catch (error) {
    if (isMissingCredentialError(error)) return;
    throw error;
  }
}

export function isMissingCredentialError(error: unknown): boolean {
  return error instanceof PasswordDeleteError && error.message === "Password not found";
}
