import { isAssetManifestName, isProjectManifestName } from './assetManifestService';
import { isLegacyDatasetFileName } from './legacyDatasetFileService';

export type ProjectAssetKind = 'image' | 'text' | 'json' | 'video' | 'psd' | 'unknown';

const IMAGE_EXTENSIONS = new Set(['bmp', 'gif', 'jpeg', 'jpg', 'png', 'webp']);
const TEXT_EXTENSIONS = new Set(['txt']);
const JSON_EXTENSIONS = new Set(['json']);
const PHOTOSHOP_EXTENSIONS = new Set(['psd']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm']);

const IMAGE_MIME_TYPES_BY_EXTENSION = new Map([
  ['bmp', 'image/bmp'],
  ['gif', 'image/gif'],
  ['jpeg', 'image/jpeg'],
  ['jpg', 'image/jpeg'],
  ['png', 'image/png'],
  ['webp', 'image/webp'],
]);

export const SUPPORTED_PROJECT_ASSET_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  ...TEXT_EXTENSIONS,
  ...JSON_EXTENSIONS,
  ...PHOTOSHOP_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
]);

export const SUPPORTED_PROJECT_ASSET_ACCEPT = [
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/plain',
  'application/json',
  'image/vnd.adobe.photoshop',
  'video/mp4',
  'video/webm',
  '.bmp',
  '.gif',
  '.jpeg',
  '.jpg',
  '.json',
  '.mp4',
  '.png',
  '.psd',
  '.txt',
  '.webm',
  '.webp',
];

export const getProjectAssetExtension = (name: string): string =>
  name.split('.').pop()?.toLowerCase() ?? '';

export const getProjectAssetMimeType = (name: string, fallback = ''): string => {
  const extension = getProjectAssetExtension(name);
  return IMAGE_MIME_TYPES_BY_EXTENSION.get(extension) ?? fallback;
};

export const isInternalProjectFileName = (fileName: string): boolean =>
  isProjectManifestName(fileName) || isAssetManifestName(fileName) || isLegacyDatasetFileName(fileName);

export const resolveProjectAssetKind = (name: string, mimeType = ''): ProjectAssetKind => {
  const extension = getProjectAssetExtension(name);

  if (PHOTOSHOP_EXTENSIONS.has(extension)) {
    return 'psd';
  }

  if (mimeType.startsWith('image/') || IMAGE_EXTENSIONS.has(extension)) {
    return 'image';
  }

  if (JSON_EXTENSIONS.has(extension) || mimeType === 'application/json') {
    return 'json';
  }

  if (TEXT_EXTENSIONS.has(extension) || mimeType.startsWith('text/')) {
    return 'text';
  }

  if (mimeType.startsWith('video/') || VIDEO_EXTENSIONS.has(extension)) {
    return 'video';
  }

  return 'unknown';
};

export const isSupportedProjectAsset = (name: string, mimeType = ''): boolean =>
  !isInternalProjectFileName(name) && resolveProjectAssetKind(name, mimeType) !== 'unknown';
