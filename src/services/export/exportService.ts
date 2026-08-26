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

type WorkspaceExportPlan = {
  kind: 'workspace';
  item: WorkspaceImage;
  basename: string;
  originalBasename: string;
  imageFileName: string;
  textFileName: string;
};

type PsdExportPlan = {
  kind: 'psd';
  asset: ExportPsdAsset;
  basename: string;
  originalBasename: string;
  imageFileName: string;
  textFileName: string;
};

export type ExportFilePlan = {
  workspaceItems: WorkspaceExportPlan[];
  psdItems: PsdExportPlan[];
};

const PHOTOPEA_ORIGIN = 'https://www.photopea.com';
const PHOTOPEA_EXPORT_TIMEOUT_MS = 45000;

export const getExportBasename = (item: WorkspaceImage): string =>
  item.fileName.replace(/\.[^.]+$/, '') || item.id.replace(/^(source|synthetic):/, '');

const getPsdExportBasename = (asset: ExportPsdAsset): string =>
  asset.fileName.replace(/\.[^.]+$/, '') || 'photoshop-document';

const getUniqueExportBasename = (preferredBasename: string, usedBasenames: Set<string>): string => {
  const trimmedBasename = preferredBasename.trim() || 'asset';
  let basename = trimmedBasename;
  let index = 2;

  while (usedBasenames.has(basename.toLowerCase())) {
    basename = `${trimmedBasename}-${index}`;
    index += 1;
  }

  usedBasenames.add(basename.toLowerCase());
  return basename;
};

export const createExportFilePlan = (config: ExportConfig): ExportFilePlan => {
  const usedBasenames = new Set<string>();

  const workspaceItems = config.items.map((item): WorkspaceExportPlan => {
    const originalBasename = getExportBasename(item);
    const basename = getUniqueExportBasename(originalBasename, usedBasenames);
    return {
      kind: 'workspace',
      item,
      basename,
      originalBasename,
      imageFileName: `${basename}.png`,
      textFileName: `${basename}.txt`,
    };
  });

  const psdItems = (config.psdAssets ?? []).map((asset): PsdExportPlan => {
    const originalBasename = getPsdExportBasename(asset);
    const basename = getUniqueExportBasename(originalBasename, usedBasenames);
    return {
      kind: 'psd',
      asset,
      basename,
      originalBasename,
      imageFileName: `${basename}.png`,
      textFileName: `${basename}.txt`,
    };
  });

  return { workspaceItems, psdItems };
};

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

export const convertPsdToPng = async (asset: ExportPsdAsset, logger?: OperationLogger): Promise<Blob> =>
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
      settle(() => reject(new Error(`Timed out converting "${asset.fileName}" after ${PHOTOPEA_EXPORT_TIMEOUT_MS / 1000}s.`)));
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
        logger?.info(`sending "${asset.fileName}" to Photopea`);
        asset.file
          .arrayBuffer()
          .then((buffer) => iframe.contentWindow?.postMessage(buffer, PHOTOPEA_ORIGIN, [buffer]))
          .catch((error) => settle(() => reject(error)));
        return;
      }

      if (!exportRequested) {
        exportRequested = true;
        logger?.info(`requesting PNG export for "${asset.fileName}"`);
        iframe.contentWindow?.postMessage('app.activeDocument.saveToOE("png");', PHOTOPEA_ORIGIN);
      }
    };

    window.addEventListener('message', handleMessage);
    logger?.info(`waiting for Photopea to load "${asset.fileName}"`);
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
  const plan = createExportFilePlan(config);

  for (let i = 0; i < plan.workspaceItems.length; i++) {
    const filePlan = plan.workspaceItems[i];
    zip.file(filePlan.imageFileName, filePlan.item.imageData);
    zip.file(filePlan.textFileName, generateTagString(filePlan.item, config.datasetKeyword, blacklist) + '\n');

    const current = i + 1;
    if (logger && shouldLogProgress(current, plan.workspaceItems.length)) {
      logger.progress({ current, total: plan.workspaceItems.length, label: 'prepared files' });
    }
  }

  for (let i = 0; i < plan.psdItems.length; i++) {
    const filePlan = plan.psdItems[i];
    const current = i + 1;
    logger?.progress({ current, total: plan.psdItems.length, label: `converting PSD ${current}/${plan.psdItems.length}` });
    const png = await convertPsdToPng(filePlan.asset, logger);
    zip.file(filePlan.imageFileName, png);
    zip.file(
      filePlan.textFileName,
      generateTagString({ fileName: filePlan.asset.fileName } as WorkspaceImage, config.datasetKeyword, blacklist) + '\n'
    );
    logger?.info(`converted "${filePlan.asset.fileName}" as ${filePlan.imageFileName}`);
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
    const plan = createExportFilePlan(config);

    for (let i = 0; i < plan.workspaceItems.length; i++) {
      const filePlan = plan.workspaceItems[i];
      const pngHandle = await dirHandle.getFileHandle(filePlan.imageFileName, { create: true });
      const pngWriter = await pngHandle.createWritable();
      await pngWriter.write(filePlan.item.imageData);
      await pngWriter.close();

      const tagString = generateTagString(filePlan.item, config.datasetKeyword, blacklist);
      const txtHandle = await dirHandle.getFileHandle(filePlan.textFileName, { create: true });
      const txtWriter = await txtHandle.createWritable();
      await txtWriter.write(tagString + '\n');
      await txtWriter.close();

      const current = i + 1;
      if (logger && shouldLogProgress(current, plan.workspaceItems.length)) {
        logger.progress({ current, total: plan.workspaceItems.length, label: 'wrote images' });
      }
    }

    for (let i = 0; i < plan.psdItems.length; i++) {
      const filePlan = plan.psdItems[i];
      const current = i + 1;
      logger?.progress({ current, total: plan.psdItems.length, label: `converting PSD ${current}/${plan.psdItems.length}` });
      const png = await convertPsdToPng(filePlan.asset, logger);
      const pngHandle = await dirHandle.getFileHandle(filePlan.imageFileName, { create: true });
      const pngWriter = await pngHandle.createWritable();
      await pngWriter.write(png);
      await pngWriter.close();

      const txtHandle = await dirHandle.getFileHandle(filePlan.textFileName, { create: true });
      const txtWriter = await txtHandle.createWritable();
      await txtWriter.write(generateTagString({ fileName: filePlan.asset.fileName } as WorkspaceImage, config.datasetKeyword, blacklist) + '\n');
      await txtWriter.close();
      logger?.info(`converted "${filePlan.asset.fileName}" as ${filePlan.imageFileName}`);
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
