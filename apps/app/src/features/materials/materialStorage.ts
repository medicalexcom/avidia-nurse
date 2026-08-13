import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase Storage access for course materials (M3).
 *
 * The bucket is PRIVATE; storage policies restrict every operation to the
 * caller's own {user_id}/... folder (migration 0003). Reads use short-lived
 * signed URLs generated on demand — signed URLs are never persisted; the
 * canonical reference is always the storage key on the document row.
 */

export const MATERIALS_BUCKET = 'course-materials';

/** Seconds a signed download URL stays valid. Short-lived by design. */
export const SIGNED_URL_TTL_SECONDS = 300;

export async function uploadMaterialObject(
  client: SupabaseClient,
  storageKey: string,
  body: ArrayBuffer | Blob,
  contentType: string
): Promise<void> {
  const { error } = await client.storage.from(MATERIALS_BUCKET).upload(storageKey, body, {
    contentType,
    // Objects are immutable: replacing a material is delete + new upload.
    upsert: false,
  });
  if (error) throw error;
}

/**
 * Remove stored objects. Supabase treats removal of a missing key as a no-op,
 * which makes deletion retries idempotent (see deletion strategy, ADR-0008).
 */
export async function removeMaterialObjects(
  client: SupabaseClient,
  storageKeys: string[]
): Promise<void> {
  if (storageKeys.length === 0) return;
  const { error } = await client.storage.from(MATERIALS_BUCKET).remove(storageKeys);
  if (error) throw error;
}

/** Short-lived signed URL for viewing/downloading an owned material. */
export async function createMaterialSignedUrl(
  client: SupabaseClient,
  storageKey: string,
  expiresInSeconds: number = SIGNED_URL_TTL_SECONDS
): Promise<string> {
  const { data, error } = await client.storage
    .from(MATERIALS_BUCKET)
    .createSignedUrl(storageKey, expiresInSeconds);
  if (error) throw error;
  return data.signedUrl;
}
