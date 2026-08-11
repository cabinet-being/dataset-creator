import { useState, useCallback, useRef } from 'react';
import { useProjectStore } from '../../stores/useProjectStore';
import { useUIStore } from '../../stores/useUIStore';
import { createStandardImageFileName } from '../../types';
import {
  getWorkspaceKindBadgeClass,
  getWorkspaceKindFrameClass,
  getWorkspaceKindFrameOverlayClass,
  getWorkspaceKindFrameOverlayStyle,
  getWorkspaceKindFrameStyle,
} from '../../lib/workspaceImages';
import { BrickMasonry } from '../ui/BrickMasonry';
import { MasonryImageFrame } from '../ui/MasonryImageFrame';
import { createOperationLogger } from '../../services/logging/applicationLog';
import {
  getImportFilesFromDataTransfer,
  importImageFiles,
  SUPPORTED_IMPORT_FILE_FORMATS,
  type ImportInputFile,
} from '../../services/import/importService';

import { Upload, Trash2 } from 'lucide-react';

export const ImportStage = () => {
  const {
    addSourceImage,
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
  const importLogger = useRef(createOperationLogger('Import'));

  const logDev = useCallback((scope: string, message: string, value: number) => {
    if (import.meta.env.DEV) {
      console.log(`[${scope}] ${message}: ${value}`);
    }
  }, []);

  const importImages = useCallback(
    async (files: ImportInputFile[]): Promise<number> => {
      if (files.length === 0) {
        return 0;
      }

      setIsLoading(true);
      logDev('import', 'received files', files.length);

      try {
        const result = await importImageFiles(files, {
          logger: importLogger.current,
          onImageImported: (image) => {
            addSourceImage(image);
            logDev(
              'import',
              'store image count',
              Object.keys(useProjectStore.getState().sourceImages).length
            );
          },
          onError: (fileName) => addNotification('error', `Failed to process ${fileName}`),
        });
        const newImages = result.importedImages;

        if (newImages.length > 0) {
          logDev('import', 'processed images', newImages.length);
          addNotification(
            'success',
            `Imported ${newImages.length} image${newImages.length !== 1 ? 's' : ''}`
          );
        }

        return newImages.length;
      } catch (error) {
        importLogger.current.error(error instanceof Error ? error.message : 'image import failed');
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [addNotification, addSourceImage, logDev]
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

    const files = await getImportFilesFromDataTransfer(event.dataTransfer);
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
            Select individual files or an entire folder to begin
          </p>
          
          <div className="flex gap-4 justify-center mb-4">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isLoading}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {isLoading ? 'Processing...' : 'Select File'}
            </button>
            
            <button
              onClick={() => folderInputRef.current?.click()}
              disabled={isLoading}
              className="px-4 py-2 bg-secondary text-foreground rounded-md hover:bg-muted disabled:opacity-50 transition-colors"
            >
              {isLoading ? 'Processing...' : 'Select Folder'}
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
            accept={SUPPORTED_IMPORT_FILE_FORMATS.join(',')}
            onChange={handleFileSelect}
            className="hidden"
          />
          
          <input
            ref={folderInputRef}
            type="file"
            multiple
            accept={SUPPORTED_IMPORT_FILE_FORMATS.join(',')}
            {...{ webkitdirectory: 'true', mozdirectory: 'true' } as any}
            onChange={handleFolderSelect}
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

          <BrickMasonry
            items={images}
            getKey={(image) => image.id}
            getEstimate={(image) => image.height / Math.max(1, image.width)}
            renderItem={(image) => (
              <div
                className={`gallery-masonry-item rounded-lg overflow-hidden ${getWorkspaceKindFrameClass('source')} ${
                  image.hidden ? 'opacity-60' : ''
                }`}
                style={getWorkspaceKindFrameStyle('source')}
              >
                <div className="group relative bg-secondary transition-colors">
                  <MasonryImageFrame
                    src={typeof image.previewUrl === 'string' ? image.previewUrl : undefined}
                    alt={createStandardImageFileName(image.id, image.fileName, image.mimeType)}
                    width={image.width}
                    height={image.height}
                    placeholder="Preview unavailable"
                  >
                  <div
                    className={getWorkspaceKindFrameOverlayClass()}
                    style={getWorkspaceKindFrameOverlayStyle('source')}
                  />

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
                  </MasonryImageFrame>
                </div>
              </div>
            )}
          />

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
