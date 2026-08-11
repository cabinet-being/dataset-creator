/**
 * Export Service
 * Generates PNG + TXT files for export
 */

import JSZip from 'jszip';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import type { OperationLogger } from '../logging/applicationLog';
import { shouldLogProgress } from '../logging/applicationLog';

interface ExportConfig {
  datasetKeyword: string;
  items: WorkspaceImage[];
}

export const getExportBasename = (item: WorkspaceImage): string =>
  item.fileName.replace(/\.[^.]+$/, '') || item.id.replace(/^(source|synthetic):/, '');

/**
 * Generate tag string for item
 */
export const generateTagString = (
  item: WorkspaceImage,
  datasetKeyword: string,
  blacklist: string[]
): string => {
  const keyword = datasetKeyword.toLowerCase();
  let tags = [keyword];

  if (item.tags) {
    const seen = new Set(tags);
    const normalizedBlacklist = new Set(blacklist.map((tag) => tag.toLowerCase()));
    const filtered = item.tags
      .map((tag) => tag.toLowerCase())
      .filter((tag) => tag !== keyword)
      .filter((tag) => !normalizedBlacklist.has(tag))
      .filter((tag) => {
        if (seen.has(tag)) {
          return false;
        }
        seen.add(tag);
        return true;
      });
    tags.push(...filtered);
  }

  if (import.meta.env.DEV) {
    console.log('[export] dataset keyword inserted at export time only');
    console.log(`[export] editable tags excluded duplicate dataset keyword: ${item.tags?.includes(keyword) ?? false}`);
  }

  return tags.join(', ');
};

/**
 * Export as ZIP
 */
export const exportAsZip = async (
  config: ExportConfig,
  blacklist: string[] = [],
  logger?: OperationLogger
): Promise<Blob> => {
  const zip = new JSZip();

  for (let i = 0; i < config.items.length; i++) {
    const item = config.items[i];
    const basename = getExportBasename(item);

    // Add PNG
    zip.file(`${basename}.png`, item.imageData);

    // Generate and add TXT
    const tagString = generateTagString(item, config.datasetKeyword, blacklist);
    zip.file(`${basename}.txt`, tagString + '\n');

    const current = i + 1;
    if (logger && shouldLogProgress(current, config.items.length)) {
      logger.progress({ current, total: config.items.length, label: 'prepared files' });
    }
  }

  logger?.info('compressing ZIP');
  return await zip.generateAsync({ type: 'blob' });
};

/**
 * Save file directly (if File System Access API is available)
 */
export const saveDirectoryViaFilesystemAPI = async (
  config: ExportConfig,
  blacklist: string[],
  logger?: OperationLogger
): Promise<boolean> => {
  // Check if File System Access API is available
  if (!('showDirectoryPicker' in window)) {
    logger?.warning('directory export unavailable in this browser');
    return false;
  }

  try {
    const dirHandle = await (window as any).showDirectoryPicker();

    for (let i = 0; i < config.items.length; i++) {
      const item = config.items[i];
      const basename = getExportBasename(item);

      // Write PNG
      const pngHandle = await dirHandle.getFileHandle(`${basename}.png`, { create: true });
      const pngWriter = await pngHandle.createWritable();
      await pngWriter.write(item.imageData);
      await pngWriter.close();

      // Write TXT
      const tagString = generateTagString(item, config.datasetKeyword, blacklist);
      const txtHandle = await dirHandle.getFileHandle(`${basename}.txt`, { create: true });
      const txtWriter = await txtHandle.createWritable();
      await txtWriter.write(tagString + '\n');
      await txtWriter.close();

      const current = i + 1;
      if (logger && shouldLogProgress(current, config.items.length)) {
        logger.progress({ current, total: config.items.length, label: 'wrote images' });
      }
    }

    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      logger?.warning('directory export canceled');
    } else {
      logger?.error(error instanceof Error ? error.message : 'directory export failed');
    }
    return false;
  }
};

/**
 * Download ZIP file
 */
export const downloadZipFile = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};
