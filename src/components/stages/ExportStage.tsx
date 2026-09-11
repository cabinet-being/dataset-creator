import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useProjectStore } from '../../stores/useProjectStore';
import { useUIStore } from '../../stores/useUIStore';
import { useLocalTaggerStore } from '../../stores/useLocalTaggerStore';
import { useInspectorPortalRoot } from '../../hooks/useInspectorPortalRoot';
import {
  exportAsZip,
  downloadZipFile,
  createExportFilePlan,
  saveDirectoryViaFilesystemAPI,
} from '../../services/export/exportService';
import { createOperationLogger } from '../../services/logging/applicationLog';
import { toWorkspaceImages, getWorkspaceKindBadgeClass } from '../../lib/workspaceImages';
import { AlertCircle, CheckCircle2, Download, FolderOpen } from 'lucide-react';

type ExportStageProps = {
  active?: boolean;
};

export const ExportStage = ({ active = true }: ExportStageProps = {}) => {
  const { taggingConfig } = useProjectStore();
  const sourceImagesById = useProjectStore((state) => state.sourceImages);
  const syntheticImagesById = useProjectStore((state) => state.datasetItems);
  const datasetsById = useProjectStore((state) => state.datasets);
  const datasetTriggerWord = useMemo(
    () => Object.values(datasetsById).find((dataset) => dataset.triggerWord.trim())?.triggerWord.trim() ?? '',
    [datasetsById]
  );
  const cleanupStageState = useProjectStore(
    (state) =>
      (state.stageState.clean as
        | { workingEdits?: Record<string, { blob: Blob; previewUrl: string; width: number; height: number }> }
        | undefined) ?? {}
  );
  const { addNotification } = useUIStore();
  const localTaggerStatus = useLocalTaggerStore((state) => state.status);

  const [isExporting, setIsExporting] = useState(false);
  const [exportMethod, setExportMethod] = useState<'zip' | 'directory'>('zip');
  const exportInspectorRoot = useInspectorPortalRoot('export-inspector-root', active);

  const sourceImages = useMemo(() => Object.values(sourceImagesById), [sourceImagesById]);
  const syntheticImages = useMemo(
    () => Object.values(syntheticImagesById).filter((item) => !item.deleted),
    [syntheticImagesById]
  );
  const items = useMemo(
    () => toWorkspaceImages(sourceImages, syntheticImages, cleanupStageState.workingEdits),
    [cleanupStageState.workingEdits, sourceImages, syntheticImages]
  );
  const exportItems = useMemo(
    () => items.filter((item) => !item.excludedFromDataset),
    [items]
  );
  const totalSize = useMemo(
    () => exportItems.reduce((sum, item) => sum + item.imageData.size, 0),
    [exportItems]
  );
  const taggedCount = useMemo(
    () => exportItems.filter((item) => item.tags && item.tags.length > 0).length,
    [exportItems]
  );
  const inactiveCount = items.length - exportItems.length;
  const exportFilePlan = useMemo(
    () => createExportFilePlan({ datasetKeyword: datasetTriggerWord, items: exportItems }),
    [datasetTriggerWord, exportItems]
  );

  useEffect(() => {
    if (import.meta.env.DEV) {
      console.log(`[tagging:model] model connected state on entering Export tool: ${localTaggerStatus}`);
      console.log('[export] export keyword is added only during export rendering/output');
    }
  }, [localTaggerStatus]);

  const handleExport = async () => {
    if (exportItems.length === 0) {
      createOperationLogger('Export').warning('no images to export');
      addNotification('warning', 'No images to export');
      return;
    }

    setIsExporting(true);
    const logger = createOperationLogger('Export');
    logger.info(`preparing ${exportItems.length} image${exportItems.length !== 1 ? 's' : ''}`);

    try {
      // Try directory API if selected
      if (exportMethod === 'directory') {
        logger.info('starting directory export');
        const success = await saveDirectoryViaFilesystemAPI(
          {
            datasetKeyword: datasetTriggerWord,
            items: exportItems,
          },
          taggingConfig.blacklist,
          logger
        );

        if (success) {
          logger.success(`completed directory export: ${exportItems.length} images`);
          addNotification('success', `Exported ${exportItems.length} images and tag files`);
          setIsExporting(false);
          return;
        }

        logger.warning('using ZIP fallback');
        addNotification('info', 'Directory API not available, using ZIP fallback');
      }

      // Fallback to ZIP
      logger.info('starting ZIP export');
      const zipBlob = await exportAsZip(
        {
          datasetKeyword: datasetTriggerWord,
          items: exportItems,
        },
        taggingConfig.blacklist,
        logger
      );

      downloadZipFile(zipBlob, `dataset-${new Date().toISOString().split('T')[0]}.zip`);
      logger.success(`completed ZIP export: ${exportItems.length} images`);
      addNotification('success', `Exported ${exportItems.length} images as ZIP`);
    } catch (error) {
      console.error('Export failed:', error);
      logger.error(error instanceof Error ? error.message : 'failed to export images');
      addNotification('error', 'Failed to export images');
    } finally {
      setIsExporting(false);
    }
  };

  const exportControls = (
    <div className="space-y-3 text-xs">
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded border border-border bg-background p-2">
          <p className="text-muted-foreground">Assets</p>
          <p className="mt-1 text-lg font-semibold">{exportItems.length}</p>
        </div>
        <div className="rounded border border-border bg-background p-2">
          <p className="text-muted-foreground">Size</p>
          <p className="mt-1 text-lg font-semibold">{(totalSize / 1024 / 1024).toFixed(1)} MB</p>
        </div>
        <div className="rounded border border-border bg-background p-2">
          <p className="text-muted-foreground">Tagged</p>
          <p className="mt-1 text-lg font-semibold">{taggedCount}/{exportItems.length}</p>
        </div>
        <div className="rounded border border-border bg-background p-2">
          <p className="text-muted-foreground">Inactive</p>
          <p className="mt-1 text-lg font-semibold">{inactiveCount}</p>
        </div>
      </div>

      <div>
        <p className="mb-2 text-muted-foreground">Method</p>
        <div className="grid gap-2">
          <button
            type="button"
            onClick={() => setExportMethod('directory')}
            className={`flex items-center justify-between rounded border px-2 py-2 text-left font-medium ${
              exportMethod === 'directory'
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border bg-background hover:bg-secondary'
            }`}
          >
            <span className="inline-flex items-center gap-2">
              <FolderOpen className="h-3.5 w-3.5" />
              Directory
            </span>
            {exportMethod === 'directory' ? <CheckCircle2 className="h-3.5 w-3.5" /> : null}
          </button>
          <button
            type="button"
            onClick={() => setExportMethod('zip')}
            className={`flex items-center justify-between rounded border px-2 py-2 text-left font-medium ${
              exportMethod === 'zip'
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border bg-background hover:bg-secondary'
            }`}
          >
            <span className="inline-flex items-center gap-2">
              <Download className="h-3.5 w-3.5" />
              ZIP
            </span>
            {exportMethod === 'zip' ? <CheckCircle2 className="h-3.5 w-3.5" /> : null}
          </button>
        </div>
      </div>

      <div className="rounded border border-border bg-background p-2">
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Trigger Word</span>
          <span className="min-w-0 truncate text-right font-mono font-medium">{datasetTriggerWord || 'None'}</span>
        </div>
        <div className="mt-2 flex justify-between gap-3">
          <span className="text-muted-foreground">TXT format</span>
          <span className="font-medium">Comma tags</span>
        </div>
      </div>

      <button
        type="button"
        onClick={handleExport}
        disabled={isExporting || exportItems.length === 0}
        className="flex w-full items-center justify-center gap-2 rounded bg-primary px-3 py-2 font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Download className="h-3.5 w-3.5" />
        {isExporting ? 'Exporting...' : `Export ${exportItems.length}`}
      </button>
    </div>
  );
  const exportInspectorPortal = exportInspectorRoot ? createPortal(exportControls, exportInspectorRoot) : null;
  const inlineExportControls = exportInspectorPortal ? null : (
    <aside className="rounded-md border border-border bg-card p-3">
      {exportControls}
    </aside>
  );

  if (items.length === 0) {
    return (
      <div className="space-y-4">
        {exportInspectorPortal}
        {inlineExportControls}
        <div className="text-center py-12">
          <AlertCircle className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
          <p className="text-muted-foreground">No images to export.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {exportInspectorPortal}
      {inlineExportControls}

      <div className="rounded-md border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h3 className="text-base font-semibold">Project Export</h3>
            <p className="mt-1 text-xs text-muted-foreground">PNG/TXT output plan</p>
          </div>
          <span className="rounded bg-secondary px-2 py-1 text-xs text-muted-foreground">
            {exportFilePlan.workspaceItems.length} asset rows
          </span>
        </div>
        <div className="max-h-[34rem] overflow-auto">
          {exportFilePlan.workspaceItems.map((filePlan) => {
            const item = filePlan.item;
            return (
              <div key={item.id} className="grid gap-2 border-b border-border px-4 py-2 text-xs last:border-b-0 md:grid-cols-[minmax(0,1fr)_7rem_minmax(0,1.25fr)] md:items-center">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono font-medium">{filePlan.imageFileName}</span>
                    <span className={getWorkspaceKindBadgeClass(item.kind)}>{item.label}</span>
                  </div>
                  <p className="mt-0.5 truncate font-mono text-muted-foreground">{filePlan.textFileName}</p>
                </div>
                <span className="font-mono text-muted-foreground">
                  {(item.imageData.size / 1024 / 1024).toFixed(1)} MB
                </span>
                <div className="min-w-0 truncate text-muted-foreground">
                  {datasetTriggerWord ? `${datasetTriggerWord}, ` : ''}
                  {item.tags && item.tags.length > 0 ? item.tags.join(', ') : '(no tags)'}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
