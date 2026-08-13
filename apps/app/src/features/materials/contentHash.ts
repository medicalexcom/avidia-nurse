/**
 * Content hashing for duplicate detection (M3, spec J).
 *
 * Web has WebCrypto (`crypto.subtle`) and hashing is cheap there. React
 * Native's Hermes runtime does not expose `crypto.subtle`, and hashing large
 * binaries through expo-crypto requires string round-trips that are fragile
 * for 50 MB decks — so on native we intentionally return null and fall back
 * to name + size duplicate matching (documented deferment, ADR-0008; a native
 * hasher can slot into this same interface in M4 without schema changes).
 */

export type ContentHasher = (bytes: ArrayBuffer) => Promise<string | null>;

interface SubtleLike {
  digest(algorithm: string, data: ArrayBuffer): Promise<ArrayBuffer>;
}

function subtleCrypto(): SubtleLike | null {
  const maybe = (globalThis as { crypto?: { subtle?: SubtleLike } }).crypto?.subtle;
  return maybe && typeof maybe.digest === 'function' ? maybe : null;
}

/** SHA-256 hex of the file bytes, or null where the platform cannot hash. */
export const sha256Hex: ContentHasher = async (bytes) => {
  const subtle = subtleCrypto();
  if (!subtle) return null;
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};
