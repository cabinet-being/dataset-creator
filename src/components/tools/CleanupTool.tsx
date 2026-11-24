import { usePhotopeaDocumentState } from '../../hooks/usePhotopeaDocumentState';
import { DocumentActions } from '../workspace/DocumentActions';
import { useOperation } from '../../hooks/useOperation';
import { useCommands, useCommandRunner } from '../workspace/Commands';
import { flushProjectSave } from '../../hooks/useProjectSave';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { getImageDimensions } from '../../services/image/imageProcessor';
import { BrickMasonry } from '../ui/BrickMasonry';
import { MasonryImageFrame } from '../ui/MasonryImageFrame';
import { useProjectStore } from '../../stores/useProjectStore';
import { isProjectPathIncluded } from '../../lib/projectCategories';
import { useUIStore } from '../../stores/useUIStore';
import { createEditedAsset } from '../../types';
import {
  WORKSPACE_KIND_STYLES,
  getWorkspaceKindBadgeClass,
  getWorkspaceKindFrameClass,
  getWorkspaceKindFrameOverlayClass,
  getWorkspaceKindFrameOverlayStyle,
  getWorkspaceKindFrameStyle,
  toWorkspaceImages,
  type WorkspaceImage,
} from '../../lib/workspaceImages';
import { useWorkspacePreviewUrls } from '../../lib/previewUrlCache';
import { readExplorerFile } from '../../services/project/explorerFileService';
import { collectWorkspaceFileAssets } from '../../lib/workspaceFileAssets';
import type { ProjectDirectoryHandle } from '../../services/project/projectDirectoryService';
import {
  CLOSE_ALL_DOCUMENTS_SCRIPT,
  PHOTOPEA_ORIGIN,
  PhotopeaFrame,
} from '../photopea/PhotopeaFrame';

type PhotopeaPhase =
  | 'waiting-ready'
  | 'idle'
  | 'clearing-documents'
  | 'opening-buffer'
  | 'opening-source'
  | 'preparing-edited-psd'
  | 'saving-png'
  | 'saving-psd'
  | 'writing';


type PhotopeaSaveBuffers = {
  png?: ArrayBuffer;
  psd?: ArrayBuffer;
};

const readEditableBlobBuffer = async (blob: Blob): Promise<ArrayBuffer> => {
  if (!(blob instanceof Blob)) {
    throw new Error('Selected workspace image data is not a readable file.');
  }

  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }

  return new Response(blob).arrayBuffer();
};

const postImageBufferToPhotopea = (photopeaWindow: Window, buffer: ArrayBuffer) => {
  try {
    const transferableBuffer = buffer.slice(0);
    photopeaWindow.postMessage(transferableBuffer, PHOTOPEA_ORIGIN, [transferableBuffer]);
  } catch (error) {
    console.warn('Transferable Photopea postMessage failed; retrying without transfer list.', error);
    photopeaWindow.postMessage(buffer, PHOTOPEA_ORIGIN);
  }
};

type CleanupToolProps = {
  selectedImageId?: string | null;
  singleFileMode?: boolean;
  active?: boolean;
  projectDirectoryHandle?: ProjectDirectoryHandle | null;
  onSelectImage?: (imageId: string) => void;
  onOpenProjectFile?: (path: string) => void;
  /** Called after the edited image was written and the document has no further unsaved changes. */
  onSaved?: () => void;
};

export const CleanupTool = ({
  selectedImageId,
  singleFileMode = false,
  active = true,
  projectDirectoryHandle = null,
  onSelectImage,
  onOpenProjectFile,
  onSaved,
}: CleanupToolProps = {}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const writeOperation = useOperation('Save edited image', rootRef, 'tool:clean');
  const sourceImagesById = useProjectStore((state) => state.sourceImages);
  const workspaceSettings = useProjectStore((state) => state.workspaceSettings);
  const excludedProjectCategories = useMemo(() => workspaceSettings.excludedProjectCategories ?? [], [workspaceSettings.excludedProjectCategories]);
  const includedProjectCategories = useMemo(() => workspaceSettings.includedProjectCategories ?? [], [workspaceSettings.includedProjectCategories]);
  const editedAssetsById = useProjectStore((state) => state.datasetItems);
  const addDatasetItem = useProjectStore((state) => state.addDatasetItem);
  const updateDatasetItem = useProjectStore((state) => state.updateDatasetItem);
  const updateSourceImage = useProjectStore((state) => state.updateSourceImage);
  const addNotification = useUIStore((state) => state.addNotification);
  const assetPreviewRefreshKey = useUIStore((state) => state.assetPreviewRefreshKey);
  const [projectPsdPaths, setProjectPsdPaths] = useState<string[]>([]);
  const runCommand = useCommandRunner();
  const runCommandRef = useRef(runCommand); runCommandRef.current = runCommand;
  const initialSelectedImageId = useProjectStore(
    (state) => (state.toolState.clean as { selectedImageId?: string } | undefined)?.selectedImageId
  );

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const phaseRef = useRef<PhotopeaPhase>('waiting-ready');
  const saveModeRef = useRef<boolean | null>(null);
  const saveBuffersRef = useRef<PhotopeaSaveBuffers>({});
  const loadedImageKeyRef = useRef<string | null>(null);
  const loadingImageKeyRef = useRef<string | null>(null);
  const pendingImageRef = useRef<WorkspaceImage | null>(null);
  const pendingEditedPsdBufferRef = useRef<ArrayBuffer | null>(null);
  const pendingEditedPsdUpgradeRef = useRef(false);

  const [selectedImageKey, setSelectedImageKey] = useState<string | null>(null);
  const [photopeaReady, setPhotopeaReady] = useState(false);
  const [documentReady, setDocumentReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [editorStatus, setEditorStatus] = useState('Loading Photopea...');
  const [hasPhotopeaMounted, setHasPhotopeaMounted] = useState(false);
  const documentState = usePhotopeaDocumentState(rootRef, iframeRef, () => documentReady && (phaseRef.current === 'idle' || phaseRef.current === 'writing'));

  const sourceImages = useMemo(() => Object.values(sourceImagesById).filter((image) =>
    isProjectPathIncluded(image.originalFilePath, excludedProjectCategories, includedProjectCategories)
  ), [excludedProjectCategories, includedProjectCategories, sourceImagesById]);
  const editedAssets = useMemo(
    () => Object.values(editedAssetsById).filter((item) =>
      !item.deleted && isProjectPathIncluded(item.imageDataPath ?? sourceImagesById[item.sourceImageId]?.originalFilePath, excludedProjectCategories, includedProjectCategories)
    ),
    [editedAssetsById, excludedProjectCategories, includedProjectCategories, sourceImagesById]
  );

  const workspaceImages = useMemo(
    () => toWorkspaceImages(sourceImages, editedAssets),
    [sourceImages, editedAssets]
  );
  useEffect(() => {
    let disposed = false;
    if (!projectDirectoryHandle || singleFileMode) { setProjectPsdPaths(paths => paths.length ? [] : paths); return; }
    void collectWorkspaceFileAssets(projectDirectoryHandle).then((assets) => {
      const registeredPsdPaths = new Set(Object.values(editedAssetsById).map((item) => item.psdDataPath).filter((path): path is string => Boolean(path)).map((path) => path.startsWith('Project/') ? path : `Project/${path}`));
      if (!disposed) setProjectPsdPaths(assets.filter((asset) => asset.kind === 'psd' && !registeredPsdPaths.has(asset.path) && isProjectPathIncluded(asset.path, excludedProjectCategories, includedProjectCategories)).map((asset) => asset.path));
    }).catch((error) => { if (!disposed) addNotification('warning', error instanceof Error ? error.message : 'Unable to list project PSD files'); });
    return () => { disposed = true; };
  }, [addNotification, assetPreviewRefreshKey, editedAssetsById, excludedProjectCategories, includedProjectCategories, projectDirectoryHandle, singleFileMode]);
  const previewUrls = useWorkspacePreviewUrls(workspaceImages);

  const selectedImage = useMemo(
    () => workspaceImages.find((image) => image.id === selectedImageKey) ?? null,
    [selectedImageKey, workspaceImages]
  );

  const readEditableImageBuffer = useCallback(
    async (image: WorkspaceImage): Promise<ArrayBuffer> => {
      const editableBlob = image.kind === 'edited' && image.psdData ? image.psdData : image.imageData;
      try {
        return await readEditableBlobBuffer(editableBlob);
      } catch (error) {
        const fallbackPath =
          image.kind === 'image'
            ? sourceImagesById[image.sourceImageId]?.originalFilePath
            : image.psdData
              ? editedAssetsById[image.editedAssetId ?? '']?.psdDataPath
              : editedAssetsById[image.editedAssetId ?? '']?.imageDataPath;

        if (!projectDirectoryHandle || !fallbackPath) {
          throw error;
        }

        const fallbackFile = await readExplorerFile(projectDirectoryHandle, fallbackPath);
        return readEditableBlobBuffer(fallbackFile);
      }
    },
    [projectDirectoryHandle, sourceImagesById, editedAssetsById]
  );

  useEffect(() => {
    if (selectedImageId !== undefined) {
      if (selectedImageId) {
        setSelectedImageKey(selectedImageId);
        setHasPhotopeaMounted(true);
      } else {
        setSelectedImageKey(null);
      }
      return;
    }

    const nextSelectedImageId = selectedImageId ?? initialSelectedImageId;
    if (nextSelectedImageId && nextSelectedImageId !== selectedImageKey) {
      setSelectedImageKey(nextSelectedImageId);
      setHasPhotopeaMounted(true);
    }
  }, [initialSelectedImageId, selectedImageId, selectedImageKey]);

  const resetEditorState = useCallback((status = 'Loading Photopea...', resetPhotopea = true) => {
    documentState.reset();
    phaseRef.current = 'waiting-ready';
    saveModeRef.current = null;
    saveBuffersRef.current = {};
    loadedImageKeyRef.current = null;
    loadingImageKeyRef.current = null;
    pendingImageRef.current = null;
    pendingEditedPsdBufferRef.current = null;
    pendingEditedPsdUpgradeRef.current = false;
    if (resetPhotopea) {
      setPhotopeaReady(false);
    }
    setDocumentReady(false);
    setIsProcessing(false);
    setEditorStatus(status);
  }, [documentState]);

  const focusPhotopea = useCallback(() => {
    window.requestAnimationFrame(() => {
      iframeRef.current?.focus();
      window.setTimeout(() => iframeRef.current?.focus(), 0);
    });
  }, []);

  const closeEditor = useCallback(() => {
    setSelectedImageKey(null);
    resetEditorState(photopeaReady ? 'Photopea is ready.' : 'Loading Photopea...', false);
    phaseRef.current = photopeaReady ? 'idle' : 'waiting-ready';
  }, [photopeaReady, resetEditorState]);

  const selectImageForEditing = useCallback(
    (imageId: string) => {
      const keepLoadedPhotopea = hasPhotopeaMounted;
      setHasPhotopeaMounted(true);
      resetEditorState(keepLoadedPhotopea ? 'Preparing Photopea...' : 'Loading Photopea...', !keepLoadedPhotopea);
      setSelectedImageKey(imageId);
      focusPhotopea();
    },
    [focusPhotopea, hasPhotopeaMounted, resetEditorState]
  );

  useEffect(() => {
    if (active && selectedImage && hasPhotopeaMounted) {
      focusPhotopea();
    }
  }, [active, focusPhotopea, hasPhotopeaMounted, selectedImage?.id]);

  useEffect(() => {
    if (selectedImageKey && !selectedImage) {
      closeEditor();
    }
  }, [closeEditor, selectedImage, selectedImageKey]);

  const sendImageBufferToPhotopea = useCallback(async (image: WorkspaceImage) => {
    const photopeaWindow = iframeRef.current?.contentWindow;
    if (!photopeaWindow) {
      return;
    }

    try {
      setEditorStatus('Opening image in Photopea...');
      setDocumentReady(false);
      pendingEditedPsdUpgradeRef.current =
        image.kind === 'edited' && Boolean(image.editedAssetId) && !image.psdData;
      const buffer = await readEditableImageBuffer(image);
      phaseRef.current = 'opening-buffer';
      pendingImageRef.current = image;
      postImageBufferToPhotopea(photopeaWindow, buffer);
    } catch (error) {
      console.error('Failed to send image to Photopea:', error);
      loadedImageKeyRef.current = null;
      loadingImageKeyRef.current = null;
      pendingImageRef.current = null;
      phaseRef.current = 'idle';
      const message = error instanceof Error ? error.message : 'Failed to open image in Photopea.';
      setEditorStatus(message);
      addNotification('error', message);
    }
  }, [addNotification, readEditableImageBuffer]);

  const openImageInPhotopea = useCallback((image: WorkspaceImage) => {
    const photopeaWindow = iframeRef.current?.contentWindow;
    if (
      !photopeaWindow ||
      loadedImageKeyRef.current === image.id ||
      loadingImageKeyRef.current === image.id
    ) {
      return;
    }

    loadingImageKeyRef.current = image.id;
    pendingImageRef.current = image;
    setDocumentReady(false);
    setEditorStatus('Preparing Photopea...');
    phaseRef.current = 'clearing-documents';
    photopeaWindow.postMessage(CLOSE_ALL_DOCUMENTS_SCRIPT, PHOTOPEA_ORIGIN);
  }, []);

  useEffect(() => {
    if (photopeaReady && selectedImage) {
      openImageInPhotopea(selectedImage);
    }
  }, [openImageInPhotopea, photopeaReady, selectedImage?.id]);

  const saveEditedImage = useCallback(
    async (buffers: PhotopeaSaveBuffers, saveCopy: boolean, image: WorkspaceImage) => {
      phaseRef.current = 'writing';
      setIsProcessing(true);
      setEditorStatus('Saving edited image...');

      try {
        if (!buffers.png) {
          throw new Error('Missing edited PNG preview');
        }

        const editedBlob = new Blob([buffers.png], { type: 'image/png' });
        const psdBlob = buffers.psd
          ? new Blob([buffers.psd], { type: 'image/vnd.adobe.photoshop' })
          : undefined;
        const imageInfo = await getImageDimensions(editedBlob).catch(() => ({
          width: image.width,
          height: image.height,
          mimeType: editedBlob.type,
        }));
        if (!saveCopy && image.kind === 'edited' && image.editedAssetId) {
          updateDatasetItem(image.editedAssetId, {
            imageData: editedBlob,
            psdData: psdBlob,
            width: imageInfo.width,
            height: imageInfo.height,
            aspectRatio: image.aspectRatio,
          });
        } else {
          const editedAsset = createEditedAsset(
            image.sourceImageId,
            editedBlob,
            imageInfo.width,
            imageInfo.height,
            'cleaned',
            image.aspectRatio
          );
          editedAsset.psdData = psdBlob;

          addDatasetItem(editedAsset);

          if (!saveCopy && image.kind === 'image') {
            updateSourceImage(image.sourceImageId, { hidden: true });
          }
        }

        await flushProjectSave();
        writeOperation.progress(1, 1); writeOperation.finish('completed', saveCopy ? 'Saved edited copy' : 'Saved edited image');
        addNotification('success', saveCopy ? 'Saved edited copy' : 'Saved edited image');
        const stillDirty = await documentState.saved(saveCopy);
        if (stillDirty) setEditorStatus(saveCopy ? 'Copy saved. Original has unsaved changes.' : 'Saved. New changes remain unsaved.');
        else { closeEditor(); onSaved?.(); }
      } catch (error) {
        writeOperation.finish('failed', error instanceof Error ? error.message : 'Failed to save edited image');
        console.error('Failed to save edited image:', error);
        addNotification('error', 'Failed to save edited image');
        setEditorStatus('Failed to save edited image.');
      } finally {
        setIsProcessing(false);
        saveModeRef.current = null;
        saveBuffersRef.current = {};
        phaseRef.current = 'idle';
      }
    },
    [addDatasetItem, addNotification, closeEditor, onSaved, updateDatasetItem, updateSourceImage, writeOperation, documentState]
  );

  const requestPhotopeaSave = useCallback((saveCopy: boolean) => {
    if (!selectedImage || !documentReady || isProcessing || saveModeRef.current !== null) {
      return;
    }

    const photopeaWindow = iframeRef.current?.contentWindow;
    if (!photopeaWindow) {
      addNotification('error', 'Photopea is not available');
      return;
    }

    writeOperation.start(undefined, 1);
    const inspect = documentState.saving();
    setIsProcessing(true);
    setEditorStatus('Requesting PNG preview from Photopea...');
    saveModeRef.current = saveCopy;
    saveBuffersRef.current = {};
    phaseRef.current = 'saving-png';
    void inspect.then(() => photopeaWindow.postMessage('app.activeDocument.saveToOE("png");', PHOTOPEA_ORIGIN)).catch(error => {
      saveModeRef.current = null; phaseRef.current = 'idle'; writeOperation.finish('failed', error.message); setIsProcessing(false); setEditorStatus(error.message);
    });
  }, [addNotification, documentReady, isProcessing, selectedImage, documentState, writeOperation]);

  useEffect(() => {
    const handlePhotopeaMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || event.origin !== PHOTOPEA_ORIGIN) {
        return;
      }

      const data = event.data;
      if (data === 'Open') { runCommandRef.current('focus.explorer'); return; }

      if (data instanceof ArrayBuffer) {
        if (phaseRef.current === 'preparing-edited-psd') {
          pendingEditedPsdBufferRef.current = data;
          setEditorStatus('Receiving generated PSD from Photopea...');
          return;
        }

        if (saveModeRef.current !== null) {
          if (phaseRef.current === 'saving-png') {
            saveBuffersRef.current = { ...saveBuffersRef.current, png: data };
          }
          if (phaseRef.current === 'saving-psd') {
            saveBuffersRef.current = { ...saveBuffersRef.current, psd: data };
          }
          setEditorStatus('Receiving edited image from Photopea...');
        }
        return;
      }

      if (typeof data !== 'string') {
        return;
      }

      if (data === 'Open') {
        setEditorStatus('Use the gallery to choose a workspace image.');
        return;
      }

      if (data === 'Save') {
        requestPhotopeaSave(false);
        return;
      }

      if (data !== 'done') {
        return;
      }

      if (phaseRef.current === 'waiting-ready') {
        phaseRef.current = 'idle';
        setPhotopeaReady(true);
        setEditorStatus('Photopea is ready.');
        return;
      }

      if (phaseRef.current === 'clearing-documents') {
        const pendingImage = pendingImageRef.current;
        if (pendingImage) {
          void sendImageBufferToPhotopea(pendingImage);
        } else {
          loadingImageKeyRef.current = null;
          phaseRef.current = 'idle';
          setEditorStatus('No image selected.');
        }
        return;
      }

      if (phaseRef.current === 'opening-buffer') {
        const pendingImage = pendingImageRef.current;
        phaseRef.current = 'opening-source';
        setEditorStatus('Preparing document...');
        iframeRef.current?.contentWindow?.postMessage(
          `app.activeDocument.source=${JSON.stringify(pendingImage?.id ?? 'dataset-image')};`,
          PHOTOPEA_ORIGIN
        );
        return;
      }

      if (phaseRef.current === 'opening-source') {
        if (pendingEditedPsdUpgradeRef.current) {
          phaseRef.current = 'preparing-edited-psd';
          setEditorStatus('Preparing generated PSD...');
          iframeRef.current?.contentWindow?.postMessage('app.activeDocument.saveToOE("psd");', PHOTOPEA_ORIGIN);
          return;
        }

        phaseRef.current = 'idle';
        loadedImageKeyRef.current = pendingImageRef.current?.id ?? loadingImageKeyRef.current;
        loadingImageKeyRef.current = null;
        pendingImageRef.current = null;
        setDocumentReady(true);
        setEditorStatus('Ready in Photopea.');
        focusPhotopea();
        return;
      }

      if (phaseRef.current === 'preparing-edited-psd') {
        const pendingImage = pendingImageRef.current;
        const psdBuffer = pendingEditedPsdBufferRef.current;
        if (!pendingImage?.editedAssetId || !psdBuffer) {
          phaseRef.current = 'idle';
          loadingImageKeyRef.current = null;
          pendingImageRef.current = null;
          pendingEditedPsdBufferRef.current = null;
          pendingEditedPsdUpgradeRef.current = false;
          setEditorStatus('Failed to prepare generated PSD.');
          addNotification('error', 'Failed to prepare generated PSD');
          return;
        }

        const psdData = new Blob([psdBuffer], { type: 'image/vnd.adobe.photoshop' });
        updateDatasetItem(pendingImage.editedAssetId, { psdData });
        pendingImageRef.current = { ...pendingImage, psdData };
        pendingEditedPsdBufferRef.current = null;
        pendingEditedPsdUpgradeRef.current = false;
        loadedImageKeyRef.current = null;
        phaseRef.current = 'clearing-documents';
        setEditorStatus('Opening generated PSD...');
        iframeRef.current?.contentWindow?.postMessage(CLOSE_ALL_DOCUMENTS_SCRIPT, PHOTOPEA_ORIGIN);
        return;
      }

      if (phaseRef.current === 'saving-png') {
        phaseRef.current = 'saving-psd';
        setEditorStatus('Requesting PSD from Photopea...');
        iframeRef.current?.contentWindow?.postMessage('app.activeDocument.saveToOE("psd");', PHOTOPEA_ORIGIN);
        return;
      }

      if (phaseRef.current === 'saving-psd') {
        const saveCopy = saveModeRef.current;
        const saveBuffers = saveBuffersRef.current;
        if (saveCopy !== null && saveBuffers.png && selectedImage) {
          void saveEditedImage(saveBuffers, saveCopy, selectedImage);
        } else {
          phaseRef.current = 'idle';
          setIsProcessing(false);
          writeOperation.finish('failed', 'Photopea did not return an edited image.');
          setEditorStatus('Photopea did not return an edited image.');
          addNotification('error', 'Photopea did not return an edited image');
        }
      }
    };

    window.addEventListener('message', handlePhotopeaMessage);
    return () => window.removeEventListener('message', handlePhotopeaMessage);
  }, [
    addNotification,
    requestPhotopeaSave,
    saveEditedImage,
    selectedImage,
    sendImageBufferToPhotopea,
    updateDatasetItem,
    focusPhotopea,
  ]);

  useCommands([
    { id: 'document.save', label: 'Save edited image', shortcut: 'Mod+S', allowInInput: true, active,
      disabled: !selectedImage || !documentReady || isProcessing,
      reason: isProcessing ? 'Saving image…' : !selectedImage ? 'Choose an image to edit' : !documentReady ? 'Photopea is loading' : undefined,
      run: () => requestPhotopeaSave(false) },
    { id: 'document.saveCopy', label: 'Save edited copy', active, disabled: !selectedImage || !documentReady || isProcessing,
      run: () => requestPhotopeaSave(true) },
    { id: 'document.cancel', label: 'Close image editor', active, disabled: !selectedImage || isProcessing, run: async () => { try { if (!await documentState.check() || window.confirm('Close this image with unsaved changes?')) closeEditor(); } catch (error) { addNotification('error', error instanceof Error ? error.message : 'Could not verify changes'); } } },
  ]);

  if ((workspaceImages.length === 0 && projectPsdPaths.length === 0) || (singleFileMode && !selectedImage)) {
    return (
      <div className="flex h-full min-h-[320px] items-center justify-center px-4 text-center">
        <div className="max-w-sm">
          <AlertCircle className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium">
            {singleFileMode ? 'Selected image is no longer available.' : 'No editable images'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {singleFileMode
              ? 'Open another image or PSD from Explorer.'
              : 'Add image assets from Explorer, or open Photopea from a specific file.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      {selectedImage && <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border p-2">
        <DocumentActions active={active} close open />
        <p role="status" className="text-xs text-muted-foreground">{editorStatus}</p>
      </div>}
      <div className={selectedImage || singleFileMode ? 'hidden' : 'h-full min-h-0 overflow-y-auto'}>
        {projectPsdPaths.length > 0 && onOpenProjectFile ? <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-3">
          <span className="text-sm font-medium">Project PSD</span>
          <select aria-label="Open project PSD in Photopea" defaultValue="" className="min-w-48 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm" onChange={(event) => {
            if (event.target.value) onOpenProjectFile(event.target.value); event.currentTarget.value = '';
          }}><option value="">Choose a PSD…</option>{projectPsdPaths.map((path) => <option key={path} value={path}>{path}</option>)}</select>
        </div> : null}
        <BrickMasonry
          items={workspaceImages}
          getKey={(image) => image.id}
          getEstimate={(image) => image.height / Math.max(1, image.width)}
          renderItem={(image) => (
            <button
              onClick={() => {
                if (onSelectImage) {
                  onSelectImage(image.id);
                  return;
                }
                selectImageForEditing(image.id);
              }}
              className={`gallery-masonry-item group relative rounded-lg overflow-hidden bg-secondary ${getWorkspaceKindFrameClass(image.kind)} hover:border-primary transition-colors text-left`}
              style={getWorkspaceKindFrameStyle(image.kind)}
            >
              <MasonryImageFrame
                src={previewUrls[image.id]}
                alt={image.fileName}
                width={image.width}
                height={image.height}
              >
                <div
                  className={getWorkspaceKindFrameOverlayClass()}
                  style={getWorkspaceKindFrameOverlayStyle(image.kind)}
                />
                <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity" />
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/45 to-transparent p-3">
                  <div className="flex items-end justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-white">{image.fileName}</p>
                      <p className="text-xs text-gray-300">
                        {image.width} x {image.height}
                      </p>
                    </div>
                    <span className={getWorkspaceKindBadgeClass(image.kind)}>
                      {WORKSPACE_KIND_STYLES[image.kind].label}
                    </span>
                  </div>
                </div>
              </MasonryImageFrame>
            </button>
          )}
        />
      </div>
      {hasPhotopeaMounted && (
        <PhotopeaFrame
          ref={iframeRef}
          title="Photopea image editor"
          className={`min-h-0 w-full flex-1 border-0 bg-black ${selectedImage ? '' : 'hidden'}`}
        />
      )}
    </div>
  );
};
