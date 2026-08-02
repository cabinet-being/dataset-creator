import { useState, useCallback, useRef } from 'react';
import JSZip from 'jszip';
import { useProjectStore } from '../../stores/useProjectStore';
import { useUIStore } from '../../stores/useUIStore';
import { createSourceImage, createStandardImageFileName, type SourceImage } from '../../types';
import {
  getWorkspaceKindBadgeClass,
  getWorkspaceKindFrameClass,
  getWorkspaceKindFrameOverlayClass,
  getWorkspaceKindFrameOverlayStyle,
  getWorkspaceKindFrameStyle,
} from '../../lib/workspaceImages';
import { getImageDimensions, createThumbnail } from '../../services/image/imageProcessor';
import { generateEmbedding, generateImageHash } from '../../services/image/embeddingService';

import { Upload, Trash2 } from 'lucide-react';

const SUPPORTED_FORMATS = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const SUPPORTED_ARCHIVE_FORMATS = ['application/zip', 'application/x-zip-compressed'];
const IMAGE_EXTENSION_TYPES = new Map([
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);

const getArchivePathStem = (path: string): string => path.replace(/\.[^/.]+$/, '');
const getArchiveFileName = (path: string): string => path.split('/').pop() ?? path;
const getArchiveFileStem = (path: string): string => getArchiveFileName(path).replace(/\.[^.]+$/, '');
const getArchiveExtension = (path: string): string => {
  const match = path.toLowerCase().match(/\.[^.]+$/);
  return match?.[0] ?? '';
};
const isArchiveFile = (file: File): boolean =>
  SUPPORTED_ARCHIVE_FORMATS.includes(file.type) || file.name.toLowerCase().endsWith('.zip');
const parseCaptionTags = (caption: string): string[] =>
  caption
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);

export const ImportStage = () => {
  const {
    addSourceImages,
    removeSourceImage,
    updateSourceImage,
  } = useProjectStore();

  const sourceImages = useProjectStore((state) => state.sourceImages);
  const images = Object.values(sourceImages);

  const { addNotification } = useUIStore();
  
  const [isLoading, setIsLoading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const archiveInputRef = useRef<HTMLInputElement>(null);

  const logDev = useCallback((scope: string, message: string, value: number) => {
    if (import.meta.env.DEV) {
      console.log(`[${scope}] ${message}: ${value}`);
    }
  }, []);

  const processImportedFile = useCallback(
    async (file: File, tags: string[] = []): Promise<SourceImage | null> => {
      if (!SUPPORTED_FORMATS.includes(file.type)) {
        console.warn(`Skipping ${file.name}: unsupported format`);
        return null;
      }

      const { width, height } = await getImageDimensions(file);
      const thumbnail = await createThumbnail(file);
      const embedding = await generateEmbedding(file);
      const hash = await generateImageHash(file);
      const previewUrl = URL.createObjectURL(file);

      const sourceImage = createSourceImage(
        file,
        file.name,
        width,
        height,
        previewUrl
      );

      sourceImage.thumbnail = thumbnail;
      sourceImage.embedding = embedding;
      sourceImage.hash = hash;
      sourceImage.tags = tags;

      return sourceImage;
    },
    []
  );

  const processArchiveFile = useCallback(
    async (file: File): Promise<SourceImage[]> => {
      const zip = await JSZip.loadAsync(file);
      const entries = Object.values(zip.files).filter((entry) => !entry.dir);
      const captionsByPathStem = new Map<string, JSZip.JSZipObject>();
      const captionsByFileStem = new Map<string, JSZip.JSZipObject>();

      for (const entry of entries) {
        if (getArchiveExtension(entry.name) !== '.txt') {
          continue;
        }

        captionsByPathStem.set(getArchivePathStem(entry.name), entry);
        captionsByFileStem.set(getArchiveFileStem(entry.name), entry);
      }

      const importedImages: SourceImage[] = [];

      for (const entry of entries) {
        const extension = getArchiveExtension(entry.name);
        const mimeType = IMAGE_EXTENSION_TYPES.get(extension);

        if (!mimeType) {
          continue;
        }

        const imageBlob = await entry.async('blob');
        const imageFile = new File([imageBlob], getArchiveFileName(entry.name), { type: mimeType });
        const captionEntry =
          captionsByPathStem.get(getArchivePathStem(entry.name)) ??
          captionsByFileStem.get(getArchiveFileStem(entry.name));
        const tags = captionEntry ? parseCaptionTags(await captionEntry.async('string')) : [];
        const sourceImage = await processImportedFile(imageFile, tags);

        if (sourceImage) {
          importedImages.push(sourceImage);
        }
      }

      return importedImages;
    },
    [processImportedFile]
  );

  const importImages = useCallback(
    async (files: File[]): Promise<number> => {
      if (files.length === 0) {
        return 0;
      }

      setIsLoading(true);
      logDev('import', 'received files', files.length);
      const newImages: SourceImage[] = [];

      try {
        for (const file of files) {
          try {
            if (isArchiveFile(file)) {
              const archiveImages = await processArchiveFile(file);
              newImages.push(...archiveImages);
              continue;
            }

            const sourceImage = await processImportedFile(file);

            if (sourceImage) {
              newImages.push(sourceImage);
            }
          } catch (error) {
            console.error(`Failed to process ${file.name}:`, error);
            addNotification('error', `Failed to process ${file.name}`);
          }
        }

        if (newImages.length > 0) {
          addSourceImages(newImages);
          logDev('import', 'processed images', newImages.length);
          logDev(
            'import',
            'store image count',
            Object.keys(useProjectStore.getState().sourceImages).length
          );
          addNotification(
            'success',
            `Imported ${newImages.length} image${newImages.length !== 1 ? 's' : ''}`
          );
        }

        return newImages.length;
      } finally {
        setIsLoading(false);
      }
    },
    [addNotification, addSourceImages, logDev, processArchiveFile, processImportedFile]
  );

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = input.files ? Array.from(input.files) : [];
    logDev('picker', 'selected files', files.length);
    logDev('picker', 'normalized files', files.length);

    try {
      const processedCount = await importImages(files);
      logDev('picker', 'processed images', processedCount);
      logDev(
        'picker',
        'store image count',
        Object.keys(useProjectStore.getState().sourceImages).length
      );
    } finally {
      input.value = '';
    }
  };

  const handleFolderSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = input.files ? Array.from(input.files) : [];
    logDev('folder', 'selected files', files.length);

    try {
      const processedCount = await importImages(files);
      logDev('folder', 'processed images', processedCount);
      logDev(
        'folder',
        'store image count',
        Object.keys(useProjectStore.getState().sourceImages).length
      );
    } finally {
      input.value = '';
    }
  };

  const handleArchiveSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = input.files ? Array.from(input.files) : [];
    logDev('archive', 'selected files', files.length);

    try {
      const processedCount = await importImages(files);
      logDev('archive', 'processed images', processedCount);
      logDev(
        'archive',
        'store image count',
        Object.keys(useProjectStore.getState().sourceImages).length
      );
    } finally {
      input.value = '';
    }
  };

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(async (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);

    const files = Array.from(event.dataTransfer.files ?? []);
    logDev('drop', 'selected files', files.length);

    const processedCount = await importImages(files);
    logDev('drop', 'processed images', processedCount);
    logDev(
      'drop',
      'store image count',
      Object.keys(useProjectStore.getState().sourceImages).length
    );
  }, [importImages, logDev]);

  const handleRemoveImage = (id: string) => {
    removeSourceImage(id);
    addNotification('info', 'Source and related Synthetic images removed');
  };

  const handleRestoreImage = (id: string) => {
    updateSourceImage(id, { hidden: false });
    addNotification('success', 'Source restored to tools');
  };

  return (
    <div className="space-y-6">
      {/* Upload Section */}
      <div 
        className={`rounded-lg border-2 border-dashed transition-colors ${
          isDragOver 
            ? 'border-primary bg-primary/5' 
            : 'border-border bg-card hover:border-primary/50'
        } p-8`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="text-center">
          <Upload className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-semibold mb-2">Import</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Select individual files, a folder, or a ZIP archive to begin
          </p>
          
          <div className="flex gap-4 justify-center mb-4">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isLoading}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {isLoading ? 'Processing...' : 'Select Files'}
            </button>
            
            <button
              onClick={() => folderInputRef.current?.click()}
              disabled={isLoading}
              className="px-4 py-2 bg-secondary text-foreground rounded-md hover:bg-muted disabled:opacity-50 transition-colors"
            >
              {isLoading ? 'Processing...' : 'Select Folder'}
            </button>

            <button
              onClick={() => archiveInputRef.current?.click()}
              disabled={isLoading}
              className="px-4 py-2 bg-secondary text-foreground rounded-md hover:bg-muted disabled:opacity-50 transition-colors"
            >
              {isLoading ? 'Processing...' : 'Select ZIP'}
            </button>
          </div>

          {isDragOver && (
            <p className="text-sm text-primary font-medium mb-4">
              Drop files here to import
            </p>
          )}

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={SUPPORTED_FORMATS.join(',')}
            onChange={handleFileSelect}
            className="hidden"
          />
          
          <input
            ref={folderInputRef}
            type="file"
            multiple
            accept={SUPPORTED_FORMATS.join(',')}
            {...{ webkitdirectory: 'true', mozdirectory: 'true' } as any}
            onChange={handleFolderSelect}
            className="hidden"
          />

          <input
            ref={archiveInputRef}
            type="file"
            multiple
            accept=".zip,application/zip,application/x-zip-compressed"
            onChange={handleArchiveSelect}
            className="hidden"
          />
        </div>
      </div>

      {/* Gallery */}
      {images.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">
              Source ({images.length})
            </h3>
            <span className="text-sm text-muted-foreground">
              Embeddings generated • Source only
            </span>
          </div>

          <div className="gallery-masonry">
            {images.map((image) => (
              <div
                key={image.id}
                className={`gallery-masonry-item rounded-lg overflow-hidden ${getWorkspaceKindFrameClass('source')} ${
                  image.hidden ? 'opacity-60' : ''
                }`}
                style={getWorkspaceKindFrameStyle('source')}
              >
                <div className="group relative bg-secondary transition-colors">
                  <div className="relative min-h-[12rem] bg-black flex items-center justify-center overflow-hidden">
                  {typeof image.previewUrl === 'string' && image.previewUrl ? (
                    <img
                      src={image.previewUrl}
                      alt={createStandardImageFileName(image.id, image.fileName, image.mimeType)}
                      className="w-full h-auto object-contain"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-muted text-muted-foreground p-2 text-center">
                      <span className="text-xs font-medium">
                        Preview unavailable
                      </span>
                    </div>
                  )}
                  <div
                    className={getWorkspaceKindFrameOverlayClass()}
                    style={getWorkspaceKindFrameOverlayStyle('source')}
                  />
                </div>

                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-2">
                  {image.hidden && (
                    <button
                      onClick={() => handleRestoreImage(image.id)}
                      className="px-3 py-2 bg-primary text-primary-foreground rounded-md hover:opacity-90 transition-opacity text-sm font-medium"
                    >
                      Restore
                    </button>
                  )}
                  <button
                    onClick={() => handleRemoveImage(image.id)}
                    className="p-2 bg-destructive text-destructive-foreground rounded-md hover:opacity-90 transition-opacity"
                    title="Remove image"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>

                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2">
                  <div className="flex items-end justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-xs text-white">
                        {createStandardImageFileName(image.id, image.fileName, image.mimeType)}
                      </p>
                      <p className="text-xs text-gray-300">
                        {image.width} × {image.height}
                      </p>
                    </div>
                    <span className={getWorkspaceKindBadgeClass('source')}>Source</span>
                  </div>
                  {image.hidden && (
                    <p className="mt-1 text-[11px] font-medium text-yellow-300">Hidden from tools</p>
                  )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 p-4 rounded-lg bg-secondary/50 border border-border">
            <p className="text-sm text-muted-foreground">
              <strong>{images.length}</strong> images ready •{' '}
              <strong>{(
                images.reduce((sum, img) => {
                  return sum + (img.originalFile instanceof Blob ? img.originalFile.size : 0);
                }, 0) / 1024 / 1024
              ).toFixed(1)} MB</strong> total
            </p>
          </div>
        </div>
      )}

      {images.length === 0 && !isLoading && (
        <div className="text-center py-12">
          <p className="text-muted-foreground">No images imported yet</p>
        </div>
      )}
    </div>
  );
};
