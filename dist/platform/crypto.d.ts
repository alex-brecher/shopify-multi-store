/**
 * Web Crypto helpers shared by the hosted code on Node and on Cloudflare Workers. Everything
 * here uses only globals both runtimes provide (crypto.getRandomValues, crypto.subtle,
 * TextEncoder), so no Node-only crypto API is needed for secrets, AES-GCM, or HMAC.
 */
export declare function bytesToBase64Url(bytes: Uint8Array): string;
export declare function base64UrlToBytes(value: string): Uint8Array;
/** `length` random bytes, base64url encoded. */
export declare function randomToken(length?: number): string;
export declare function randomUuid(): string;
/** Constant-time string comparison (the length is not secret). */
export declare function constantTimeEqual(a: string, b: string): boolean;
/** Lower-case hex HMAC-SHA256 of a UTF-8 message. */
export declare function hmacSha256Hex(secret: string, message: string): Promise<string>;
/** AES-256-GCM seal with a 12-byte IV and 16-byte tag. Returns the pieces separately. */
export declare function aesGcmSeal(rawKey: Uint8Array, plaintext: string, aad: Uint8Array): Promise<{
    iv: Uint8Array;
    tag: Uint8Array;
    ciphertext: Uint8Array;
}>;
/** AES-256-GCM open. Throws when the key, AAD, IV, tag, or ciphertext do not match. */
export declare function aesGcmOpen(rawKey: Uint8Array, aad: Uint8Array, iv: Uint8Array, tag: Uint8Array, ciphertext: Uint8Array): Promise<string>;
