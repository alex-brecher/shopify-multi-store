/**
 * Web Crypto helpers shared by the hosted code on Node and on Cloudflare Workers. Everything
 * here uses only globals both runtimes provide (crypto.getRandomValues, crypto.subtle,
 * TextEncoder), so no Node-only crypto API is needed for secrets, AES-GCM, or HMAC.
 */
const encoder = new TextEncoder();
export function bytesToBase64Url(bytes) {
    let binary = "";
    for (const byte of bytes)
        binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function base64UrlToBytes(value) {
    if (!/^[A-Za-z0-9_-]*$/.test(value))
        throw new Error("Invalid base64url.");
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1)
        bytes[i] = binary.charCodeAt(i);
    return bytes;
}
/** `length` random bytes, base64url encoded. */
export function randomToken(length = 32) {
    return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(length)));
}
export function randomUuid() {
    return crypto.randomUUID();
}
/** Constant-time string comparison (the length is not secret). */
export function constantTimeEqual(a, b) {
    const left = encoder.encode(a);
    const right = encoder.encode(b);
    if (left.length !== right.length)
        return false;
    let diff = 0;
    for (let i = 0; i < left.length; i += 1)
        diff |= left[i] ^ right[i];
    return diff === 0;
}
/** Lower-case hex HMAC-SHA256 of a UTF-8 message. */
export async function hmacSha256Hex(secret, message) {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
    return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** A copy backed by a plain ArrayBuffer, as Web Crypto's types require. */
function own(bytes) {
    return new Uint8Array(bytes);
}
const aesKeys = new WeakMap();
function aesKey(raw) {
    let key = aesKeys.get(raw);
    if (!key) {
        key = crypto.subtle.importKey("raw", own(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
        aesKeys.set(raw, key);
    }
    return key;
}
/** AES-256-GCM seal with a 12-byte IV and 16-byte tag. Returns the pieces separately. */
export async function aesGcmSeal(rawKey, plaintext, aad) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: own(aad), tagLength: 128 }, await aesKey(rawKey), encoder.encode(plaintext)));
    // Web Crypto appends the tag to the ciphertext; the stored format keeps them apart.
    return { iv, tag: sealed.slice(sealed.length - 16), ciphertext: sealed.slice(0, sealed.length - 16) };
}
/** AES-256-GCM open. Throws when the key, AAD, IV, tag, or ciphertext do not match. */
export async function aesGcmOpen(rawKey, aad, iv, tag, ciphertext) {
    if (iv.length !== 12 || tag.length !== 16)
        throw new Error("Malformed ciphertext.");
    const joined = new Uint8Array(ciphertext.length + tag.length);
    joined.set(ciphertext, 0);
    joined.set(tag, ciphertext.length);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: own(iv), additionalData: own(aad), tagLength: 128 }, await aesKey(rawKey), joined);
    return new TextDecoder("utf-8", { fatal: true }).decode(plain);
}
//# sourceMappingURL=crypto.js.map