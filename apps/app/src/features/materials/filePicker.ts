import * as DocumentPicker from 'expo-document-picker';
import { SUPPORTED_MATERIAL_FORMATS } from '@avidia/domain';

/**
 * Platform-neutral file selection (M3, spec G).
 *
 * expo-document-picker drives the browser file input on web and the native
 * document pickers on iOS/Android, so the same Expo app serves every
 * platform. Everything after selection (validation, hashing, upload) is
 * shared; only the byte-extraction differs (web File vs native content URI)
 * and that difference is isolated here.
 */

export interface PickedMaterialFile {
  name: string;
  size: number | null;
  mimeType: string | null;
  bytes: ArrayBuffer;
}

export type PickResult = { kind: 'picked'; file: PickedMaterialFile } | { kind: 'cancelled' };

const ACCEPTED_MIME_TYPES = Object.values(SUPPORTED_MATERIAL_FORMATS).flat();

export async function pickMaterialFile(): Promise<PickResult> {
  const result = await DocumentPicker.getDocumentAsync({
    type: [...ACCEPTED_MIME_TYPES],
    multiple: false,
    copyToCacheDirectory: true,
  });
  if (result.canceled || result.assets.length === 0) return { kind: 'cancelled' };

  const asset = result.assets[0]!;
  // Web exposes the File directly; native exposes a local cache URI that
  // fetch() can read on every Expo platform.
  const bytes = asset.file
    ? await asset.file.arrayBuffer()
    : await (await fetch(asset.uri)).arrayBuffer();

  return {
    kind: 'picked',
    file: {
      name: asset.name,
      size: asset.size ?? bytes.byteLength,
      mimeType: asset.mimeType ?? null,
      bytes,
    },
  };
}
