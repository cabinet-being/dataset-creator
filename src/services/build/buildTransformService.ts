import type { AspectRatio, BuildTransformRecipe, CropFrame, EditedAsset } from '../../types';

type TransformResult = Pick<EditedAsset, 'imageData' | 'width' | 'height' | 'aspectRatio' | 'cropFrame'>;

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

const decodeImage = async (blob: Blob): Promise<ImageBitmap> => {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch { return createImageBitmap(blob); }
};

const toAspectRatio = (width: number, height: number): AspectRatio => {
  const ratio = width / height;
  if (Math.abs(ratio - 1) < 0.08) return '1:1';
  return ratio < 1 ? '2:3' : '3:2';
};

const canvasBlob = (canvas: HTMLCanvasElement): Promise<Blob> => new Promise((resolve, reject) => {
  canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('The transformed image could not be encoded.')), 'image/png');
});

export const getBuildTransformGeometry = (width: number, height: number, recipe: BuildTransformRecipe) => {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 ||
    !Number.isFinite(recipe.width) || !Number.isFinite(recipe.height) || recipe.width < 1 || recipe.height < 1) {
    throw new Error('Choose valid output dimensions.');
  }
  let sourceX = 0; let sourceY = 0; let sourceWidth = width; let sourceHeight = height;
  if (recipe.mode === 'crop') {
    const crop = recipe.crop ?? { x: 0, y: 0, width: 1, height: 1 };
    sourceX = Math.round(clamp(crop.x, 0, 1) * width);
    sourceY = Math.round(clamp(crop.y, 0, 1) * height);
    sourceWidth = Math.max(1, Math.round(clamp(crop.width, 0.001, 1 - clamp(crop.x, 0, 1)) * width));
    sourceHeight = Math.max(1, Math.round(clamp(crop.height, 0.001, 1 - clamp(crop.y, 0, 1)) * height));
    sourceX = Math.min(sourceX, width - 1); sourceY = Math.min(sourceY, height - 1);
    sourceWidth = Math.min(sourceWidth, width - sourceX); sourceHeight = Math.min(sourceHeight, height - sourceY);
    const targetRatio = recipe.width / recipe.height;
    if (sourceWidth / sourceHeight > targetRatio) {
      const fitted = Math.max(1, Math.round(sourceHeight * targetRatio));
      sourceX += Math.round((sourceWidth - fitted) / 2); sourceWidth = fitted;
    } else {
      const fitted = Math.max(1, Math.round(sourceWidth / targetRatio));
      sourceY += Math.round((sourceHeight - fitted) / 2); sourceHeight = fitted;
    }
  }
  const scale = Math.min(recipe.allowUpscale ? Number.POSITIVE_INFINITY : 1, recipe.width / sourceWidth, recipe.height / sourceHeight);
  return { sourceX, sourceY, sourceWidth, sourceHeight,
    outputWidth: Math.max(1, Math.round(sourceWidth * scale)), outputHeight: Math.max(1, Math.round(sourceHeight * scale)) };
};

export const renderBuildTransform = async (source: Blob, recipe: BuildTransformRecipe): Promise<TransformResult> => {
  const bitmap = await decodeImage(source);
  try {
    const { sourceX, sourceY, sourceWidth, sourceHeight, outputWidth, outputHeight } = getBuildTransformGeometry(bitmap.width, bitmap.height, recipe);
    const cropFrame: CropFrame | undefined = recipe.mode === 'crop'
      ? { id: `build-${sourceX}-${sourceY}-${sourceWidth}-${sourceHeight}`, x: sourceX, y: sourceY, width: sourceWidth, height: sourceHeight, aspectRatio: toAspectRatio(recipe.width, recipe.height) }
      : undefined;
    const canvas = document.createElement('canvas');
    canvas.width = outputWidth; canvas.height = outputHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Browser canvas is unavailable for image transforms.');
    context.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, outputWidth, outputHeight);
    return { imageData: await canvasBlob(canvas), width: outputWidth, height: outputHeight, aspectRatio: toAspectRatio(outputWidth, outputHeight), cropFrame };
  } finally { bitmap.close(); }
};

export const createBuildOutputAssetId = (assetId: string, revision: string, recipe: BuildTransformRecipe): string => {
  const input = `${assetId}:${revision}:${JSON.stringify(recipe)}`;
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) hash = Math.imul(31, hash) + input.charCodeAt(index) | 0;
  return `build-${(hash >>> 0).toString(36)}`;
};

/** Stable across project reloads and sensitive to equal-sized image replacements. */
export const getBuildImageDigest = async (source: Blob): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', await source.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};
