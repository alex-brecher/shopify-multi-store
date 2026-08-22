export declare const CREDENTIAL_SERVICE = "codex-shopify-multi-store";
export declare function accessTokenAccount(alias: string): string;
export declare function clientSecretAccount(alias: string): string;
export declare function credentialBackend(): Promise<{
    id: string;
    name: string;
}>;
export declare function storeCredential(account: string, value: string): Promise<void>;
export declare function readCredential(account: string): Promise<string | null>;
export declare function removeCredential(account: string): Promise<void>;
export declare function isMissingCredentialError(error: unknown): boolean;
