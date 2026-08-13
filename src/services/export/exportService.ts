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
  psdAssets?: ExportPsdAsset[];
}

export type ExportPsdAsset = {
  fileName: string;
  file: Blob;
};

const PHOTOPEA_ORIGIN = 'https://www.photopea.com';
const PHOTOPEA_EXPORT_TIMEOUT_MS = 45000;

export const getExportBasename = (item: WorkspaceImage): string =>
  item.fileName.replace(/\.[^.]+$/, '') || item.id.replace(/^(source|synthetic):/, '');

const getPsdExportBasename = (asset: ExportPsdAsset): string =>
  asset.fileName.replace(/\.[^.]+$/, '') || 'photoshop-document';

const createPhotopeaExportUrl = () => {
  const config = {
    environment: {
      intro: false,
      localsave: false,
      customIO: {
        open: 'app.echoToOE("Open");',
        save: 'app.echoToOE("Save");',
        exportAs: true,
      },
      panels: [0, 2],
    },
  };

  return `${PHOTOPEA_ORIGIN}#${encodeURIComponent(JSON.stringify(config))}`;
};

export const convertPsdToPng = async (asset: ExportPsdAsset): Promise<Blob> =>
  new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.src = createPhotopeaExportUrl();
    iframe.title = `PSD export converter for ${asset.fileName}`;
    iframe.style.position = 'fixed';
    iframe.style.left = '-10000px';
    iframe.style.top = '0';
    iframe.style.width = '1px';
    iframe.style.height = '1px';
    iframe.style.opacity = '0';
    iframe.style.pointerEvents = 'none';

    let opened = false;
    let exportRequested = false;
    let settled = false;

    const cleanup = () => {
      window.removeEventListener('message', handleMessage);
      iframe.remove();
      window.clearTimeout(timeout);
    };

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };

    const timeout = window.setTimeout(() => {
      settle(() => reject(new Error(`Timed out converting ${asset.fileName}`)));
    }, PHOTOPEA_EXPORT_TIMEOUT_MS);

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow || event.origin !== PHOTOPEA_ORIGIN) {
        return;
      }

      if (event.data instanceof ArrayBuffer && exportRequested) {
        const png = new Blob([event.data], { type: 'image/png' });
        settle(() => resolve(png));
        return;
      }

      if (event.data !== 'done') {
        return;
      }

      if (!opened) {
        opened = true;
        asset.file
          .arrayBuffer()
          .then((buffer) => iframe.contentWindow?.postMessage(buffer, PHOTOPEA_ORIGIN, [buffer]))
          .catch((error) => settle(() => reject(error)));
        return;
      }

      if (!exportRequested) {
        exportRequested = true;
        iframe.contentWindow?.postMessage('app.activeDocument.saveToOE("png");', PHOTOPEA_ORIGIN);
      }
    };

    window.addEventListener('message', handleMessage);
    document.body.appendChild(iframe);
  });

/**
 * Generate tag string for item
 */
export const generateTagString = (
  item: WorkspaceImage,
  datasetKeyword: string,
  blacklist: string[]
): string => {
  const keyword = datasetKeyword.trim().toLowerCase();
  let tags = keyword ? [keyword] : [];

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

  for (let i = 0; i < (config.psdAssets ?? []).length; i++) {
    const asset = config.psdAssets![i];
    const basename = getPsdExportBasename(asset);
    logger?.info(`converting PSD "${asset.fileName}" to PNG`);
    const png = await convertPsdToPng(asset);
    zip.file(`${basename}.png`, png);
    zip.file(`${basename}.txt`, generateTagString({ fileName: asset.fileName } as WorkspaceImage, config.datasetKeyword, blacklist) + '\n');
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

    for (let i = 0; i < (config.psdAssets ?? []).length; i++) {
      const asset = config.psdAssets![i];
      const basename = getPsdExportBasename(asset);
      logger?.info(`converting PSD "${asset.fileName}" to PNG`);
      const png = await convertPsdToPng(asset);
      const pngHandle = await dirHandle.getFileHandle(`${basename}.png`, { create: true });
      const pngWriter = await pngHandle.createWritable();
      await pngWriter.write(png);
      await pngWriter.close();

      const txtHandle = await dirHandle.getFileHandle(`${basename}.txt`, { create: true });
      const txtWriter = await txtHandle.createWritable();
      await txtWriter.write(generateTagString({ fileName: asset.fileName } as WorkspaceImage, config.datasetKeyword, blacklist) + '\n');
      await txtWriter.close();
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
