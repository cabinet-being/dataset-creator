import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { getImageDimensions } from '../../services/image/imageProcessor';
import { BrickMasonry } from '../ui/BrickMasonry';
import { MasonryImageFrame } from '../ui/MasonryImageFrame';
import { useProjectStore } from '../../stores/useProjectStore';
import { useUIStore } from '../../stores/useUIStore';
import { createSyntheticImage } from '../../types';
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
  | 'preparing-synthetic-psd'
  | 'saving-png'
  | 'saving-psd';

const EDIT_TOOL_COMMAND_EVENT = 'dataset-creator-edit-command';

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

type CleanupStageProps = {
  selectedImageId?: string;
  singleFileMode?: boolean;
  active?: boolean;
  projectDirectoryHandle?: ProjectDirectoryHandle | null;
};

export const CleanupStage = ({
  selectedImageId,
  singleFileMode = false,
  active = true,
  projectDirectoryHandle = null,
}: CleanupStageProps = {}) => {
  const sourceImagesById = useProjectStore((state) => state.sourceImages);
  const syntheticImagesById = useProjectStore((state) => state.datasetItems);
  const addDatasetItem = useProjectStore((state) => state.addDatasetItem);
  const updateDatasetItem = useProjectStore((state) => state.updateDatasetItem);
  const updateSourceImage = useProjectStore((state) => state.updateSourceImage);
  const addNotification = useUIStore((state) => state.addNotification);
  const setEditToolbar = useUIStore((state) => state.setEditToolbar);
  const initialSelectedImageId = useProjectStore(
    (state) => (state.stageState.clean as { selectedImageId?: string } | undefined)?.selectedImageId
  );

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const phaseRef = useRef<PhotopeaPhase>('waiting-ready');
  const saveModeRef = useRef<boolean | null>(null);
  const saveBuffersRef = useRef<PhotopeaSaveBuffers>({});
  const loadedImageKeyRef = useRef<string | null>(null);
  const loadingImageKeyRef = useRef<string | null>(null);
  const pendingImageRef = useRef<WorkspaceImage | null>(null);
  const pendingSyntheticPsdBufferRef = useRef<ArrayBuffer | null>(null);
  const pendingSyntheticPsdUpgradeRef = useRef(false);

  const [selectedImageKey, setSelectedImageKey] = useState<string | null>(null);
  const [photopeaReady, setPhotopeaReady] = useState(false);
  const [documentReady, setDocumentReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [editorStatus, setEditorStatus] = useState('Loading Photopea...');
  const [hasPhotopeaMounted, setHasPhotopeaMounted] = useState(false);

  const sourceImages = useMemo(() => Object.values(sourceImagesById), [sourceImagesById]);
  const syntheticImages = useMemo(
    () => Object.values(syntheticImagesById).filter((item) => !item.deleted),
    [syntheticImagesById]
  );

  const workspaceImages = useMemo(
    () => toWorkspaceImages(sourceImages, syntheticImages),
    [sourceImages, syntheticImages]
  );
  const previewUrls = useWorkspacePreviewUrls(workspaceImages);

  const selectedImage = useMemo(
    () => workspaceImages.find((image) => image.id === selectedImageKey) ?? null,
    [selectedImageKey, workspaceImages]
  );

  const readEditableImageBuffer = useCallback(
    async (image: WorkspaceImage): Promise<ArrayBuffer> => {
      const editableBlob = image.kind === 'synthetic' && image.psdData ? image.psdData : image.imageData;
      try {
        return await readEditableBlobBuffer(editableBlob);
      } catch (error) {
        const fallbackPath =
          image.kind === 'image'
            ? sourceImagesById[image.sourceImageId]?.originalFilePath
            : image.psdData
              ? syntheticImagesById[image.syntheticImageId ?? '']?.psdDataPath
              : syntheticImagesById[image.syntheticImageId ?? '']?.imageDataPath;

        if (!projectDirectoryHandle || !fallbackPath) {
          throw error;
        }

        const fallbackFile = await readExplorerFile(projectDirectoryHandle, fallbackPath);
        return readEditableBlobBuffer(fallbackFile);
      }
    },
    [projectDirectoryHandle, sourceImagesById, syntheticImagesById]
  );

  useEffect(() => {
    const nextSelectedImageId = selectedImageId ?? initialSelectedImageId;
    if (nextSelectedImageId && nextSelectedImageId !== selectedImageKey) {
      setSelectedImageKey(nextSelectedImageId);
      setHasPhotopeaMounted(true);
    }
  }, [initialSelectedImageId, selectedImageId, selectedImageKey]);

  const resetEditorState = useCallback((status = 'Loading Photopea...', resetPhotopea = true) => {
    phaseRef.current = 'waiting-ready';
    saveModeRef.current = null;
    saveBuffersRef.current = {};
    loadedImageKeyRef.current = null;
    loadingImageKeyRef.current = null;
    pendingImageRef.current = null;
    pendingSyntheticPsdBufferRef.current = null;
    pendingSyntheticPsdUpgradeRef.current = false;
    if (resetPhotopea) {
      setPhotopeaReady(false);
    }
    setDocumentReady(false);
    setIsProcessing(false);
    setEditorStatus(status);
  }, []);

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
    if (!active) {
      return;
    }
    setEditToolbar({
      visible: Boolean(selectedImage),
      canSave: Boolean(selectedImage && documentReady),
      isProcessing,
      status: selectedImage ? editorStatus : undefined,
    });
  }, [active, documentReady, editorStatus, isProcessing, selectedImageKey, setEditToolbar]);

  useEffect(() => {
    return () => {
      setEditToolbar({
        visible: false,
        canSave: false,
        isProcessing: false,
        status: undefined,
      });
    };
  }, [setEditToolbar]);

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
      pendingSyntheticPsdUpgradeRef.current =
        image.kind === 'synthetic' && Boolean(image.syntheticImageId) && !image.psdData;
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
        if (!saveCopy && image.kind === 'synthetic' && image.syntheticImageId) {
          updateDatasetItem(image.syntheticImageId, {
            imageData: editedBlob,
            psdData: psdBlob,
            width: imageInfo.width,
            height: imageInfo.height,
            aspectRatio: image.aspectRatio,
          });
        } else {
          const syntheticImage = createSyntheticImage(
            image.sourceImageId,
            editedBlob,
            imageInfo.width,
            imageInfo.height,
            'cleaned',
            image.aspectRatio
          );
          syntheticImage.psdData = psdBlob;

          addDatasetItem(syntheticImage);

          if (!saveCopy && image.kind === 'image') {
            updateSourceImage(image.sourceImageId, { hidden: true });
          }
        }

        addNotification('success', saveCopy ? 'Saved edited copy' : 'Saved edited image');
        closeEditor();
      } catch (error) {
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
    [addDatasetItem, addNotification, closeEditor, updateDatasetItem, updateSourceImage]
  );

  const requestPhotopeaSave = useCallback((saveCopy: boolean) => {
    if (!selectedImage || !documentReady || isProcessing) {
      return;
    }

    const photopeaWindow = iframeRef.current?.contentWindow;
    if (!photopeaWindow) {
      addNotification('error', 'Photopea is not available');
      return;
    }

    setIsProcessing(true);
    setEditorStatus('Requesting PNG preview from Photopea...');
    saveModeRef.current = saveCopy;
    saveBuffersRef.current = {};
    phaseRef.current = 'saving-png';
    photopeaWindow.postMessage('app.activeDocument.saveToOE("png");', PHOTOPEA_ORIGIN);
  }, [addNotification, documentReady, isProcessing, selectedImage]);

  useEffect(() => {
    const handlePhotopeaMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || event.origin !== PHOTOPEA_ORIGIN) {
        return;
      }

      const data = event.data;

      if (data instanceof ArrayBuffer) {
        if (phaseRef.current === 'preparing-synthetic-psd') {
          pendingSyntheticPsdBufferRef.current = data;
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
        if (pendingSyntheticPsdUpgradeRef.current) {
          phaseRef.current = 'preparing-synthetic-psd';
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

      if (phaseRef.current === 'preparing-synthetic-psd') {
        const pendingImage = pendingImageRef.current;
        const psdBuffer = pendingSyntheticPsdBufferRef.current;
        if (!pendingImage?.syntheticImageId || !psdBuffer) {
          phaseRef.current = 'idle';
          loadingImageKeyRef.current = null;
          pendingImageRef.current = null;
          pendingSyntheticPsdBufferRef.current = null;
          pendingSyntheticPsdUpgradeRef.current = false;
          setEditorStatus('Failed to prepare generated PSD.');
          addNotification('error', 'Failed to prepare generated PSD');
          return;
        }

        const psdData = new Blob([psdBuffer], { type: 'image/vnd.adobe.photoshop' });
        updateDatasetItem(pendingImage.syntheticImageId, { psdData });
        pendingImageRef.current = { ...pendingImage, psdData };
        pendingSyntheticPsdBufferRef.current = null;
        pendingSyntheticPsdUpgradeRef.current = false;
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

  useEffect(() => {
    const handleEditCommand = (event: Event) => {
      const command = (event as CustomEvent<'back' | 'save' | 'saveCopy' | 'cancel'>).detail;
      switch (command) {
        case 'back':
        case 'cancel':
          if (!isProcessing) {
            closeEditor();
          }
          break;
        case 'save':
          requestPhotopeaSave(false);
          break;
        case 'saveCopy':
          requestPhotopeaSave(true);
          break;
      }
    };

    window.addEventListener(EDIT_TOOL_COMMAND_EVENT, handleEditCommand);
    return () => window.removeEventListener(EDIT_TOOL_COMMAND_EVENT, handleEditCommand);
  }, [closeEditor, isProcessing, requestPhotopeaSave]);

  if (workspaceImages.length === 0 || (singleFileMode && !selectedImage)) {
    return (
      <div className="text-center py-12">
        <AlertCircle className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
        <p className="text-muted-foreground">
          {singleFileMode ? 'Selected image is no longer available.' : 'No images to edit. Import images first.'}
        </p>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0">
      <div className={selectedImage || singleFileMode ? 'hidden' : 'h-full min-h-0 overflow-y-auto'}>
        <BrickMasonry
          items={workspaceImages}
          getKey={(image) => image.id}
          getEstimate={(image) => image.height / Math.max(1, image.width)}
          renderItem={(image) => (
            <button
              onClick={() => selectImageForEditing(image.id)}
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
          className={`h-full min-h-0 w-full border-0 bg-black ${selectedImage ? '' : 'hidden'}`}
        />
      )}
    </div>
  );
};
