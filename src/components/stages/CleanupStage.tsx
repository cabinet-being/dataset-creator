import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { getImageDimensions } from '../../services/image/imageProcessor';
import { BrickMasonry } from '../ui/BrickMasonry';
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

type PreviewCacheEntry = { blob: Blob; url: string };
type PhotopeaPhase =
  | 'waiting-ready'
  | 'idle'
  | 'clearing-documents'
  | 'opening-buffer'
  | 'opening-source'
  | 'preparing-synthetic-psd'
  | 'saving-png'
  | 'saving-psd';

const PHOTOPEA_ORIGIN = 'https://www.photopea.com';
const EDIT_TOOL_COMMAND_EVENT = 'dataset-creator-edit-command';
const CLOSE_ALL_DOCUMENTS_SCRIPT = [
  'while (app.documents.length > 0) {',
  '  app.activeDocument.close(SaveOptions.DONOTSAVECHANGES);',
  '}',
].join('\n');

type PhotopeaSaveBuffers = {
  png?: ArrayBuffer;
  psd?: ArrayBuffer;
};

const createPhotopeaUrl = () => {
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

export const CleanupStage = () => {
  const sourceImagesById = useProjectStore((state) => state.sourceImages);
  const syntheticImagesById = useProjectStore((state) => state.datasetItems);
  const addDatasetItem = useProjectStore((state) => state.addDatasetItem);
  const updateDatasetItem = useProjectStore((state) => state.updateDatasetItem);
  const updateSourceImage = useProjectStore((state) => state.updateSourceImage);
  const addNotification = useUIStore((state) => state.addNotification);
  const setEditToolbar = useUIStore((state) => state.setEditToolbar);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const phaseRef = useRef<PhotopeaPhase>('waiting-ready');
  const saveModeRef = useRef<boolean | null>(null);
  const saveBuffersRef = useRef<PhotopeaSaveBuffers>({});
  const loadedImageKeyRef = useRef<string | null>(null);
  const loadingImageKeyRef = useRef<string | null>(null);
  const pendingImageRef = useRef<WorkspaceImage | null>(null);
  const pendingSyntheticPsdBufferRef = useRef<ArrayBuffer | null>(null);
  const pendingSyntheticPsdUpgradeRef = useRef(false);
  const syntheticPreviewCacheRef = useRef<Record<string, PreviewCacheEntry>>({});

  const [selectedImageKey, setSelectedImageKey] = useState<string | null>(null);
  const [photopeaReady, setPhotopeaReady] = useState(false);
  const [documentReady, setDocumentReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [editorStatus, setEditorStatus] = useState('Loading Photopea...');
  const [syntheticPreviewUrls, setSyntheticPreviewUrls] = useState<Record<string, string>>({});

  const photopeaUrl = useMemo(createPhotopeaUrl, []);
  const sourceImages = useMemo(() => Object.values(sourceImagesById), [sourceImagesById]);
  const syntheticImages = useMemo(
    () => Object.values(syntheticImagesById).filter((item) => !item.deleted),
    [syntheticImagesById]
  );

  useEffect(() => {
    setSyntheticPreviewUrls((previous) => {
      const next: Record<string, string> = {};
      const activeIds = new Set(syntheticImages.map((item) => item.id));

      for (const item of syntheticImages) {
        const cached = syntheticPreviewCacheRef.current[item.id];
        if (cached && cached.blob === item.imageData) {
          next[item.id] = cached.url;
          continue;
        }

        if (cached) {
          URL.revokeObjectURL(cached.url);
        }

        const url = URL.createObjectURL(item.imageData);
        syntheticPreviewCacheRef.current[item.id] = { blob: item.imageData, url };
        next[item.id] = url;
      }

      for (const [id, cached] of Object.entries(syntheticPreviewCacheRef.current)) {
        if (activeIds.has(id)) {
          continue;
        }
        URL.revokeObjectURL(cached.url);
        delete syntheticPreviewCacheRef.current[id];
      }

      const previousKeys = Object.keys(previous);
      const nextKeys = Object.keys(next);
      const changed =
        previousKeys.length !== nextKeys.length ||
        nextKeys.some((id) => previous[id] !== next[id]);

      return changed ? next : previous;
    });
  }, [syntheticImages]);

  useEffect(() => {
    return () => {
      Object.values(syntheticPreviewCacheRef.current).forEach((entry) => URL.revokeObjectURL(entry.url));
      syntheticPreviewCacheRef.current = {};
    };
  }, []);

  const workspaceImages = useMemo(() => {
    return toWorkspaceImages(sourceImages, syntheticImages).map((image) => ({
      ...image,
      previewUrl: image.previewUrl ?? (image.syntheticImageId ? syntheticPreviewUrls[image.syntheticImageId] : undefined),
    }));
  }, [sourceImages, syntheticImages, syntheticPreviewUrls]);

  const selectedImage = useMemo(
    () => workspaceImages.find((image) => image.id === selectedImageKey) ?? null,
    [selectedImageKey, workspaceImages]
  );

  const resetEditorState = useCallback((status = 'Loading Photopea...') => {
    phaseRef.current = 'waiting-ready';
    saveModeRef.current = null;
    saveBuffersRef.current = {};
    loadedImageKeyRef.current = null;
    loadingImageKeyRef.current = null;
    pendingImageRef.current = null;
    pendingSyntheticPsdBufferRef.current = null;
    pendingSyntheticPsdUpgradeRef.current = false;
    setPhotopeaReady(false);
    setDocumentReady(false);
    setIsProcessing(false);
    setEditorStatus(status);
  }, []);

  const closeEditor = useCallback(() => {
    setSelectedImageKey(null);
    resetEditorState();
  }, [resetEditorState]);

  useEffect(() => {
    setEditToolbar({
      visible: Boolean(selectedImage),
      canSave: Boolean(selectedImage && documentReady),
      isProcessing,
      status: selectedImage ? editorStatus : undefined,
    });
  }, [documentReady, editorStatus, isProcessing, selectedImageKey, setEditToolbar]);

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
      const editableBlob = image.kind === 'synthetic' && image.psdData ? image.psdData : image.imageData;
      const buffer = await editableBlob.arrayBuffer();
      phaseRef.current = 'opening-buffer';
      pendingImageRef.current = image;
      photopeaWindow.postMessage(buffer, '*', [buffer]);
    } catch (error) {
      console.error('Failed to send image to Photopea:', error);
      loadedImageKeyRef.current = null;
      loadingImageKeyRef.current = null;
      pendingImageRef.current = null;
      phaseRef.current = 'idle';
      setEditorStatus('Failed to open image in Photopea.');
      addNotification('error', 'Failed to open image in Photopea');
    }
  }, [addNotification]);

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
    photopeaWindow.postMessage(CLOSE_ALL_DOCUMENTS_SCRIPT, '*');
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

          if (!saveCopy && image.kind === 'source') {
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

  useEffect(() => {
    const handlePhotopeaMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }

      const data = event.data;

      if (data instanceof ArrayBuffer) {
        if (phaseRef.current === 'preparing-synthetic-psd') {
          pendingSyntheticPsdBufferRef.current = data;
          setEditorStatus('Receiving Synthetic PSD from Photopea...');
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
          '*'
        );
        return;
      }

      if (phaseRef.current === 'opening-source') {
        if (pendingSyntheticPsdUpgradeRef.current) {
          phaseRef.current = 'preparing-synthetic-psd';
          setEditorStatus('Preparing Synthetic PSD...');
          iframeRef.current?.contentWindow?.postMessage('app.activeDocument.saveToOE("psd");', '*');
          return;
        }

        phaseRef.current = 'idle';
        loadedImageKeyRef.current = pendingImageRef.current?.id ?? loadingImageKeyRef.current;
        loadingImageKeyRef.current = null;
        pendingImageRef.current = null;
        setDocumentReady(true);
        setEditorStatus('Ready to edit in Photopea.');
        window.setTimeout(() => iframeRef.current?.focus(), 0);
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
          setEditorStatus('Failed to prepare Synthetic PSD.');
          addNotification('error', 'Failed to prepare Synthetic PSD');
          return;
        }

        const psdData = new Blob([psdBuffer], { type: 'image/vnd.adobe.photoshop' });
        updateDatasetItem(pendingImage.syntheticImageId, { psdData });
        pendingImageRef.current = { ...pendingImage, psdData };
        pendingSyntheticPsdBufferRef.current = null;
        pendingSyntheticPsdUpgradeRef.current = false;
        loadedImageKeyRef.current = null;
        phaseRef.current = 'clearing-documents';
        setEditorStatus('Opening Synthetic PSD...');
        iframeRef.current?.contentWindow?.postMessage(CLOSE_ALL_DOCUMENTS_SCRIPT, '*');
        return;
      }

      if (phaseRef.current === 'saving-png') {
        phaseRef.current = 'saving-psd';
        setEditorStatus('Requesting PSD from Photopea...');
        iframeRef.current?.contentWindow?.postMessage('app.activeDocument.saveToOE("psd");', '*');
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
  }, [addNotification, saveEditedImage, selectedImage, sendImageBufferToPhotopea, updateDatasetItem]);

  const requestPhotopeaSave = (saveCopy: boolean) => {
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
    photopeaWindow.postMessage('app.activeDocument.saveToOE("png");', '*');
  };

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
  });

  if (workspaceImages.length === 0) {
    return (
      <div className="text-center py-12">
        <AlertCircle className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
        <p className="text-muted-foreground">No images to edit. Import images first.</p>
      </div>
    );
  }

  if (selectedImage) {
    return (
      <iframe
        key={selectedImage.id}
        ref={iframeRef}
        title="Photopea image editor"
        src={photopeaUrl}
        className="h-full min-h-0 w-full border-0 bg-black"
        allow="clipboard-read; clipboard-write; fullscreen"
      />
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <BrickMasonry
        items={workspaceImages}
        getKey={(image) => image.id}
        getEstimate={(image) => image.height / Math.max(1, image.width)}
        renderItem={(image) => (
          <button
            onClick={() => {
              resetEditorState();
              setSelectedImageKey(image.id);
            }}
            className={`gallery-masonry-item group relative rounded-lg overflow-hidden bg-secondary ${getWorkspaceKindFrameClass(image.kind)} hover:border-primary transition-colors text-left`}
            style={getWorkspaceKindFrameStyle(image.kind)}
          >
            <div className="relative min-h-[12rem] bg-black flex items-center justify-center overflow-hidden">
              {image.previewUrl ? (
                <img src={image.previewUrl} alt={image.fileName} className="w-full h-auto object-contain" />
              ) : (
                <span className="text-xs text-muted-foreground">
                  {image.width} x {image.height}
                </span>
              )}
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
            </div>
          </button>
        )}
      />
    </div>
  );
};
