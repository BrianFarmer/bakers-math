/**
 * Photos and videos for a bake. Captured or picked files are copied into the app's documents
 * folder right away, so they survive offline until they upload (on any connection).
 */
import { Directory, File, Paths, UploadType } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { Alert } from 'react-native';
import type { UploadTicket } from '../lib/syncEngine';
import { setLocalFileDeleter } from './db';
import { addMedia, newId } from './repo';

export const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
export const MAX_VIDEO_SECONDS = 180;

const mediaDir = () => {
  const dir = new Directory(Paths.document, 'media');
  if (!dir.exists) dir.create({ idempotent: true, intermediates: true });
  return dir;
};

setLocalFileDeleter((uri) => {
  if (!uri) return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch (e) {
    console.warn('could not delete media file', e);
  }
});

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
};
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};

function contentTypeOf(asset: ImagePicker.ImagePickerAsset): string | null {
  if (asset.mimeType && EXTENSIONS[asset.mimeType]) return asset.mimeType;
  const ext = (asset.fileName ?? asset.uri).split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[ext] ?? null;
}

/** Copies a picked asset into app storage and records it on the bake. Returns false if rejected. */
async function keepAsset(bakeId: string, asset: ImagePicker.ImagePickerAsset): Promise<boolean> {
  const kind = asset.type === 'video' ? 'video' : 'photo';
  const contentType = contentTypeOf(asset);
  if (!contentType || contentType.startsWith('video/') !== (kind === 'video')) {
    Alert.alert("Can't add this file", 'Photos can be JPEG, PNG, HEIC or WebP; videos MP4 or MOV.');
    return false;
  }
  const source = new File(asset.uri);
  const bytes = asset.fileSize ?? source.size ?? 0;
  const seconds = asset.duration ? asset.duration / 1000 : null;
  if (kind === 'photo' && bytes > MAX_PHOTO_BYTES) {
    Alert.alert('Photo too large', 'Photos can be up to 20 MB.');
    return false;
  }
  if (kind === 'video' && (bytes > MAX_VIDEO_BYTES || (seconds ?? 0) > MAX_VIDEO_SECONDS)) {
    Alert.alert('Video too long', 'Videos can be up to 3 minutes and 200 MB.');
    return false;
  }
  const id = newId();
  const dest = new File(mediaDir(), `${id}.${EXTENSIONS[contentType]}`);
  await source.copy(dest);
  await addMedia({
    id,
    bake_id: bakeId,
    kind,
    local_uri: dest.uri,
    content_type: contentType,
    bytes: dest.size ?? bytes,
    duration_seconds: kind === 'video' ? (seconds ?? 1) : null,
    width: asset.width || null,
    height: asset.height || null,
  });
  return true;
}

const pickerOptions: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['images', 'videos'],
  quality: 0.85,
  videoMaxDuration: MAX_VIDEO_SECONDS,
};

export async function captureMedia(bakeId: string) {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) {
    Alert.alert('Camera access needed', 'Allow camera access in Settings to take photos and videos of your bakes.');
    return;
  }
  const result = await ImagePicker.launchCameraAsync(pickerOptions);
  if (result.canceled) return;
  for (const asset of result.assets) await keepAsset(bakeId, asset);
}

export async function pickMedia(bakeId: string) {
  const result = await ImagePicker.launchImageLibraryAsync({ ...pickerOptions, allowsMultipleSelection: true });
  if (result.canceled) return;
  for (const asset of result.assets) await keepAsset(bakeId, asset);
}

/**
 * Uploads straight to storage with the presigned URL. On iOS the transfer runs in a background
 * session, so it carries on if the app is backgrounded; if it's cut off anyway, the next sync asks
 * for a fresh URL and tries again.
 */
export async function uploadFile(localUri: string, ticket: UploadTicket): Promise<number> {
  const file = new File(localUri);
  if (!file.exists) throw new Error('The file is no longer on this phone');
  // The native uploader sets Content-Length from the file, which is the size the URL was signed for.
  const headers = Object.fromEntries(Object.entries(ticket.headers).filter(([k]) => k.toLowerCase() !== 'content-length'));
  const res = await file.upload(ticket.url, {
    httpMethod: 'PUT',
    uploadType: UploadType.BINARY_CONTENT,
    headers,
    sessionType: 'background',
  });
  return res.status;
}
