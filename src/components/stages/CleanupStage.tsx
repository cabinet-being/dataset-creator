import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { getImageDimensions } from '../../services/image/imageProcessor';
import { useProjectStore } from '../../stores/useProjectStore';
import { useUIStore } from '../../stores/useUIStore';
import { createSyntheticImage } from '../../types';
import {
  WORKSPACE_KIND_STYLES,
  getWorkspaceKindBadgeClass,
  getWorkspaceKindFrameClass,
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
  | 'saving';

const PHOTOPEA_ORIGIN = 'https://www.photopea.com';
const EDIT_TOOL_COMMAND_EVENT = 'dataset-creator-edit-command';
const CLOSE_ALL_DOCUMENTS_SCRIPT = [
  'while (app.documents.length > 0) {',
  '  app.activeDocument.close(SaveOptions.DONOTSAVECHANGES);',
  '}',
].join('\n');

const createPhotopeaUrl = () => {
  const config = {
    environment: {
      intro: false,
      localsave: false,
      customIO: {
        open: 'app.echoToOE("Open");',
        save: 'app.activeDocument.saveToOE("png");',
        exportAs: true,
      },
      panels: [0, 2],
    },
  };

  return `${PHOTOPEA_ORIGIN}#${encodeURIComponent(JSON.stringify(config))}`;
};

export const CleanupStage = () => {
  const sourceImages = useProjectStore((state) => Object.values(state.sourceImages));
  const syntheticImages = useProjectStore((state) => state.getDatasetItems(false));
  const addDatasetItem = useProjectStore((state) => state.addDatasetItem);
  const updateSourceImage = useProjectStore((state) => state.updateSourceImage);
  const softDeleteDatasetItem = useProjectStore((state) => state.softDeleteDatasetItem);
  const { addNotification, setEditToolbar } = useUIStore();

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const phaseRef = useRef<PhotopeaPhase>('waiting-ready');
  const saveModeRef = useRef<boolean | null>(null);
  const saveBufferRef = useRef<ArrayBuffer | null>(null);
  const loadedImageKeyRef = useRef<string | null>(null);
  const loadingImageKeyRef = useRef<string | null>(null);
  const pendingImageRef = useRef<WorkspaceImage | null>(null);
  const syntheticPreviewCacheRef = useRef<Record<string, PreviewCacheEntry>>({});

  const [selectedImageKey, setSelectedImageKey] = useState<string | null>(null);
  const [photopeaReady, setPhotopeaReady] = useState(false);
  const [documentReady, setDocumentReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [editorStatus, setEditorStatus] = useState('Loading Photopea...');
  const [syntheticPreviewUrls, setSyntheticPreviewUrls] = useState<Record<string, string>>({});

  const photopeaUrl = useMemo(createPhotopeaUrl, []);

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
    saveBufferRef.current = null;
    loadedImageKeyRef.current = null;
    loadingImageKeyRef.current = null;
    pendingImageRef.current = null;
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

    return () => {
      setEditToolbar({
        visible: false,
        canSave: false,
        isProcessing: false,
        status: undefined,
      });
    };
  }, [documentReady, editorStatus, isProcessing, selectedImage, setEditToolbar]);

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
      const buffer = await image.imageData.arrayBuffer();
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
    async (buffer: ArrayBuffer, saveCopy: boolean, image: WorkspaceImage) => {
      setIsProcessing(true);
      setEditorStatus('Saving edited image...');

      try {
        const editedBlob = new Blob([buffer], { type: 'image/png' });
        const imageInfo = await getImageDimensions(editedBlob).catch(() => ({
          width: image.width,
          height: image.height,
          mimeType: editedBlob.type,
        }));
        const syntheticImage = createSyntheticImage(
          image.sourceImageId,
          editedBlob,
          imageInfo.width,
          imageInfo.height,
          'cleaned',
          image.aspectRatio
        );

        addDatasetItem(syntheticImage);

        if (!saveCopy) {
          if (image.kind === 'source') {
            updateSourceImage(image.sourceImageId, { hidden: true });
          } else if (image.syntheticImageId) {
            softDeleteDatasetItem(image.syntheticImageId);
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
        saveBufferRef.current = null;
        phaseRef.current = 'idle';
      }
    },
    [addDatasetItem, addNotification, closeEditor, softDeleteDatasetItem, updateSourceImage]
  );

  useEffect(() => {
    const handlePhotopeaMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }

      const data = event.data;

      if (data instanceof ArrayBuffer) {
        if (saveModeRef.current !== null) {
          saveBufferRef.current = data;
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
        phaseRef.current = 'idle';
        loadedImageKeyRef.current = pendingImageRef.current?.id ?? loadingImageKeyRef.current;
        loadingImageKeyRef.current = null;
        pendingImageRef.current = null;
        setDocumentReady(true);
        setEditorStatus('Ready to edit in Photopea.');
        window.setTimeout(() => iframeRef.current?.focus(), 0);
        return;
      }

      if (phaseRef.current === 'saving') {
        const saveCopy = saveModeRef.current;
        const saveBuffer = saveBufferRef.current;
        if (saveCopy !== null && saveBuffer && selectedImage) {
          void saveEditedImage(saveBuffer, saveCopy, selectedImage);
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
  }, [addNotification, saveEditedImage, selectedImage, sendImageBufferToPhotopea]);

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
    setEditorStatus('Requesting edited image from Photopea...');
    saveModeRef.current = saveCopy;
    saveBufferRef.current = null;
    phaseRef.current = 'saving';
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

  return (
    <div className="h-full min-h-0 rounded-lg border border-border bg-card overflow-hidden flex flex-col">
      {!selectedImage ? (
        <>
          <div className="border-b border-border p-4 flex items-center justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold">Edit Gallery</h3>
              <p className="text-sm text-muted-foreground">
                Choose an image to edit in Photopea.
              </p>
            </div>
            <div className="text-sm text-muted-foreground">
              {workspaceImages.length} image{workspaceImages.length !== 1 ? 's' : ''}
            </div>
          </div>

          <div className="p-6 gallery-masonry overflow-y-auto">
            {workspaceImages.map((image, index) => (
              <button
                key={image.id}
                onClick={() => {
                  resetEditorState();
                  setSelectedImageKey(image.id);
                }}
                className={`gallery-masonry-item group relative rounded-lg overflow-hidden bg-secondary ${getWorkspaceKindFrameClass(image.kind)} hover:border-primary transition-colors text-left`}
                style={getWorkspaceKindFrameStyle(image.kind)}
              >
                <div className="relative min-h-[12rem] bg-black flex items-center justify-center overflow-hidden">
                  {image.previewUrl ? (
                    <img src={image.previewUrl} alt={image.label} className="w-full h-auto object-contain" />
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {image.width} x {image.height}
                    </span>
                  )}
                  <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity" />
                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/45 to-transparent p-3">
                    <div className="flex items-end justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-white">Image #{index + 1}</p>
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
            ))}
          </div>
        </>
      ) : (
        <iframe
          key={selectedImage.id}
          ref={iframeRef}
          title="Photopea image editor"
          src={photopeaUrl}
          className="h-full min-h-0 w-full flex-1 border-0 bg-black"
          allow="clipboard-read; clipboard-write; fullscreen"
        />
      )}
    </div>
  );
};
