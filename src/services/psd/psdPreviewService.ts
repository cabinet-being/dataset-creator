import { readPsd } from 'ag-psd';

const PSD_PREVIEW_SIZE = 512;
const PSD_PREVIEW_MEMORY_LIMIT = 512 * 1024 * 1024;

const canvasToBlob = (canvas: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Failed to encode PSD preview'));
      }
    }, type, quality);
  });

const scaleCanvas = (source: HTMLCanvasElement, maxSize = PSD_PREVIEW_SIZE): HTMLCanvasElement => {
  const ratio = source.width / source.height;
  const canvas = document.createElement('canvas');

  if (ratio > 1) {
    canvas.width = Math.min(maxSize, source.width);
    canvas.height = Math.max(1, Math.round(canvas.width / ratio));
  } else {
    canvas.height = Math.min(maxSize, source.height);
    canvas.width = Math.max(1, Math.round(canvas.height * ratio));
  }

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Failed to create PSD preview canvas');
  }

  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
};

const readPsdThumbnailCanvas = (buffer: ArrayBuffer): HTMLCanvasElement | undefined => {
  const psd = readPsd(buffer, {
    skipLayerImageData: true,
    skipCompositeImageData: true,
    skipLinkedFilesData: true,
    totalMemoryLimit: PSD_PREVIEW_MEMORY_LIMIT,
  });

  return psd.imageResources?.thumbnail;
};

const readPsdCompositeCanvas = (buffer: ArrayBuffer): HTMLCanvasElement | undefined => {
  const psd = readPsd(buffer, {
    skipLayerImageData: true,
    skipThumbnail: true,
    skipLinkedFilesData: true,
    totalMemoryLimit: PSD_PREVIEW_MEMORY_LIMIT,
  });

  return psd.canvas;
};

export const createPsdPreview = async (blob: Blob): Promise<Blob | undefined> => {
  const buffer = await blob.arrayBuffer();
  let canvas: HTMLCanvasElement | undefined;

  try {
    canvas = readPsdCompositeCanvas(buffer);
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('[psd-preview] unable to read composite image', error);
    }
  }

  try {
    canvas = canvas ?? readPsdThumbnailCanvas(buffer);
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('[psd-preview] unable to read embedded thumbnail', error);
    }
  }

  if (!canvas || canvas.width <= 0 || canvas.height <= 0) {
    return undefined;
  }

  return canvasToBlob(scaleCanvas(canvas));
};
