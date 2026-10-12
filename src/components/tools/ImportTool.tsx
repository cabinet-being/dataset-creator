import { useOperation } from '../../hooks/useOperation';
import { useCommands } from '../workspace/Commands';
import { useState, useCallback, useMemo, useRef } from 'react';
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
import { useWorkspacePreviewUrls } from '../../lib/previewUrlCache';
import { BrickMasonry } from '../ui/BrickMasonry';
import { MasonryImageFrame } from '../ui/MasonryImageFrame';
import { createOperationLogger } from '../../services/logging/applicationLog';
import {
  getImportFilesFromDataTransfer,
  importImageFiles,
  SUPPORTED_IMPORT_FILE_FORMATS,
  type ImportInputFile,
  type ImportImagesOptions,
  type ImportImagesResult,
  type ImportPairSummary,
} from '../../services/import/importService';

import { FolderOpen, ImageIcon, RotateCcw, Trash2, Upload } from 'lucide-react';

type ImportToolProps = {
  active?: boolean;
  onImportFiles?: (files: ImportInputFile[], execution?: Pick<ImportImagesOptions, 'signal' | 'onProgress'>) => Promise<ImportImagesResult>;
};

export const ImportTool = ({ onImportFiles, active = true }: ImportToolProps) => {
  const {
    addSourceImage,
    removeSourceImage,
    updateSourceImage,
  } = useProjectStore();

  const sourceImages = useProjectStore((state) => state.sourceImages);
  const images = useMemo(() => Object.values(sourceImages), [sourceImages]);
  const previewItems = useMemo(
    () =>
      images.map((image) => ({
        id: image.id,
        imageData: image.originalFile,
        previewUrl: image.previewUrl,
      })),
    [images]
  );
  const previewUrls = useWorkspacePreviewUrls(previewItems);
  const visibleImages = useMemo(() => images.filter((image) => !image.hidden), [images]);
  const hiddenImages = images.length - visibleImages.length;
  const totalSourceSizeMb = useMemo(
    () =>
      images.reduce((sum, img) => {
        return sum + (img.originalFile instanceof Blob ? img.originalFile.size : 0);
      }, 0) /
      1024 /
      1024,
    [images]
  );

  const { addNotification } = useUIStore();
  
  const [isLoading, setIsLoading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const commandRoot = useRef<HTMLDivElement>(null);
  const operation = useOperation('Import', commandRoot, 'tool:import');
  const controller = useRef<AbortController>();
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [lastSummary, setLastSummary] = useState<ImportPairSummary | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  useCommands([
    { id: 'import.files', label: 'Import files', active, disabled: isLoading, run: () => fileInputRef.current?.click() },
    { id: 'import.cancel', label: 'Cancel import', active, disabled: !isLoading, run: () => controller.current?.abort() },
    { id: 'import.folder', label: 'Import folder', active, disabled: isLoading, run: () => folderInputRef.current?.click() },
  ], () => commandRoot.current?.closest<HTMLElement>('[data-dock-view]') ?? commandRoot.current);
  const importLogger = useRef(createOperationLogger('Import'));

  const logDev = useCallback((area: string, message: string, value: number) => {
    if (import.meta.env.DEV) {
      console.log(`[${area}] ${message}: ${value}`);
    }
  }, []);

  const importImages = useCallback(
    async (files: ImportInputFile[]): Promise<number> => {
      if (files.length === 0) {
        return 0;
      }

      if (controller.current && !controller.current.signal.aborted && isLoading) return 0;
      const next = new AbortController(); controller.current = next;
      const onProgress = (completed: number, total: number) => { setProgress({ completed, total }); operation.progress(completed, total); };
      operation.start(() => next.abort(), files.length); onProgress(0, files.length);
      setIsLoading(true);
      logDev('import', 'received files', files.length);

      try {
        if (onImportFiles) {
          const result = await onImportFiles(files, { signal: next.signal, onProgress });
          next.signal.throwIfAborted();
          const count = result.importedAssets.length || result.importedImages.length;
          setLastSummary(result.summary);
          operation.finish('completed', `${count} assets imported`);
          return count;
        }
        const result = await importImageFiles(files, {
          logger: importLogger.current,
          signal: next.signal, onProgress,
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
        setLastSummary(result.summary);

        if (newImages.length > 0) {
          logDev('import', 'processed images', newImages.length);
          addNotification(
            'success',
            `Imported ${newImages.length} image${newImages.length !== 1 ? 's' : ''}`
          );
        }

        operation.finish('completed', `${newImages.length} images imported`);
        return newImages.length;
      } catch (error) {
        const cancelled = next.signal.aborted;
        operation.finish(cancelled ? 'cancelled' : 'failed', cancelled ? 'Import stopped. Files already imported remain available.' : error instanceof Error ? error.message : 'Import failed');
        if (cancelled) { addNotification('info', 'Import stopped. Files already imported remain available.'); return 0; }
        importLogger.current.error(error instanceof Error ? error.message : 'image import failed');
        addNotification('error', error instanceof Error ? error.message : 'Import failed');
        return 0;
      } finally {
        setIsLoading(false);
      }
    },
    [addNotification, addSourceImage, logDev, onImportFiles, isLoading, operation]
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
    addNotification('info', 'Image and related generated assets removed');
  };

  const handleRestoreImage = (id: string) => {
    updateSourceImage(id, { hidden: false });
    addNotification('success', 'Source restored to tools');
  };

  return (
    <div ref={commandRoot} className="flex h-full min-h-0 flex-col gap-4">
      {isLoading && <div role="status" className="flex items-center gap-3 text-sm"><progress aria-label="Import progress" value={progress.completed} max={progress.total || 1} className="flex-1" /><span>{progress.completed}/{progress.total}</span><button onClick={() => controller.current?.abort()}>Cancel</button></div>}
      {lastSummary && <div role="status" className="flex flex-wrap gap-x-4 gap-y-1 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
        <span>{lastSummary.pairedImages} paired images</span><span>{lastSummary.imagesWithoutCaption} without caption</span>
        <span>{lastSummary.standaloneTextFiles} standalone TXT</span><span>{lastSummary.captionConflicts} conflicts</span>
        {lastSummary.errors > 0 ? <span className="text-destructive">{lastSummary.errors} errors</span> : null}
      </div>}
      <div 
        className={`rounded-md border border-dashed transition-colors ${
          isDragOver 
            ? 'border-primary bg-primary/5'
            : 'border-border bg-card/80 hover:border-primary/50'
        } p-4`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-background">
              <Upload className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">Import sources</h3>

              {isDragOver && (
                <p className="mt-1 text-xs font-medium text-primary">
                  Release to import selected files.
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isLoading}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <ImageIcon size={15} />
              {isLoading ? 'Processing...' : 'Files'}
            </button>
            
            <button
              onClick={() => folderInputRef.current?.click()}
              disabled={isLoading}
              className="inline-flex items-center gap-2 rounded-md border border-border bg-secondary px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              <FolderOpen size={15} />
              {isLoading ? 'Processing...' : 'Folder'}
            </button>
          </div>

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

      <div className="flex min-h-0 flex-1 flex-col rounded-md border border-border bg-card/70">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">Source files</h3>
            <p className="text-xs text-muted-foreground">
              {images.length > 0
                ? `${visibleImages.length} active / ${images.length} total`
                : 'No imported sources yet'}
            </p>
          </div>
          {images.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="rounded-md border border-border bg-background px-2 py-1">
                {totalSourceSizeMb.toFixed(1)} MB
              </span>
              {hiddenImages > 0 && (
                <span className="rounded-md border border-border bg-background px-2 py-1">
                  {hiddenImages} hidden
                </span>
              )}
            </div>
          )}
        </div>

        {images.length > 0 ? (
          <div className="min-h-0 flex-1 overflow-auto p-4">
          <BrickMasonry
            items={images}
            getKey={(image) => image.id}
            getEstimate={(image) => image.height / Math.max(1, image.width)}
            renderItem={(image) => (
              <div
                className={`gallery-masonry-item rounded-lg overflow-hidden ${getWorkspaceKindFrameClass('image')} ${
                  image.hidden ? 'opacity-60' : ''
                }`}
                style={getWorkspaceKindFrameStyle('image')}
              >
                <div className="group relative bg-secondary transition-colors">
                  <MasonryImageFrame
                    src={previewUrls[image.id]}
                    alt={createStandardImageFileName(image.id, image.fileName, image.mimeType)}
                    width={image.width}
                    height={image.height}
                    placeholder="Preview unavailable"
                  >
                  <div
                    className={getWorkspaceKindFrameOverlayClass()}
                    style={getWorkspaceKindFrameOverlayStyle('image')}
                  />

                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                  {image.hidden && (
                    <button
                      onClick={() => handleRestoreImage(image.id)}
                      className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
                    >
                      <RotateCcw size={14} />
                      Restore
                    </button>
                  )}
                  <button
                    onClick={() => handleRemoveImage(image.id)}
                    className="rounded-md bg-destructive p-2 text-destructive-foreground transition-opacity hover:opacity-90"
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
                    <span className={getWorkspaceKindBadgeClass('image')}>Image</span>
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
          </div>
        ) : (
          <div className="flex min-h-[260px] flex-1 items-center justify-center px-4 text-center">
            <div className="max-w-sm">
              <ImageIcon className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
              <p className="text-sm font-medium">No source files</p>

            </div>
          </div>
        )}
      </div>
    </div>
  );
};
