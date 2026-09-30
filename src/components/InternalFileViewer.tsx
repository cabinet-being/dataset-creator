import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { AlertCircle, FileImage, FileJson, FileText, Minus, MoreHorizontal, Plus, Video } from 'lucide-react';
import type { ExplorerFileKind } from '../services/project/explorerFileService';
import { PhotopeaBlobViewer } from './photopea/PhotopeaFrame';

type InternalFileViewerProps = {
  file: File | Blob;
  fileName: string;
  fileKind: ExplorerFileKind;
  active?: boolean;
  onContextMenu?: (event: MouseEvent) => void;
  onSavePsd?: (payload: { psd: ArrayBuffer; preview?: ArrayBuffer }, saveCopy: boolean) => void | Promise<void>;
};

type ObjectUrlCacheEntry = {
  url: string;
  consumers: number;
  revokeTimer?: number;
};

const objectUrlCache = new WeakMap<Blob, ObjectUrlCacheEntry>();

const getObjectUrlCacheEntry = (file: Blob): ObjectUrlCacheEntry => {
  const cached = objectUrlCache.get(file);
  if (cached) {
    if (cached.revokeTimer !== undefined) {
      window.clearTimeout(cached.revokeTimer);
      cached.revokeTimer = undefined;
    }
    return cached;
  }

  const entry: ObjectUrlCacheEntry = {
    url: URL.createObjectURL(file),
    consumers: 0,
  };
  objectUrlCache.set(file, entry);
  return entry;
};

const releaseObjectUrlCacheEntry = (file: Blob) => {
  const cached = objectUrlCache.get(file);
  if (!cached) {
    return;
  }

  cached.consumers = Math.max(0, cached.consumers - 1);
  if (cached.consumers > 0 || cached.revokeTimer !== undefined) {
    return;
  }

  cached.revokeTimer = window.setTimeout(() => {
    if (cached.consumers === 0) {
      URL.revokeObjectURL(cached.url);
      objectUrlCache.delete(file);
    }
  }, 0);
};

const useObjectUrl = (file: Blob | null) => {
  const cacheEntry = useMemo(() => (file ? getObjectUrlCacheEntry(file) : null), [file]);

  useEffect(() => {
    if (!file || !cacheEntry) {
      return;
    }

    cacheEntry.consumers += 1;
    return () => {
      releaseObjectUrlCacheEntry(file);
    };
  }, [cacheEntry, file]);

  return cacheEntry?.url ?? null;
};

const TextFileViewer = ({
  file,
  json,
  onContextMenu,
}: {
  file: Blob;
  json?: boolean;
  onContextMenu?: (event: MouseEvent) => void;
}) => {
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let canceled = false;
    setContent('');
    setError(null);
    setLoading(true);
    file
      .text()
      .then((text) => {
        if (!canceled) {
          if (json) {
            try {
              setContent(JSON.stringify(JSON.parse(text), null, 2));
            } catch {
              setContent(text);
            }
          } else {
            setContent(text);
          }
          setLoading(false);
        }
      })
      .catch((readError) => {
        if (!canceled) {
          setError(readError instanceof Error ? readError.message : 'Unable to read file.');
          setLoading(false);
        }
      });

    return () => {
      canceled = true;
    };
  }, [file, json]);

  if (error) {
    return <ViewerError message={error} />;
  }

  if (loading) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6 text-sm text-muted-foreground">
        Loading file...
      </div>
    );
  }

  return (
    <pre
      onContextMenu={onContextMenu}
      className="h-full min-h-0 overflow-auto whitespace-pre-wrap break-words bg-background p-4 font-mono text-xs leading-5 text-foreground"
    >
      {content}
    </pre>
  );
};

const ImageFileViewer = ({
  file,
  fileName,
  onContextMenu,
}: {
  file: Blob;
  fileName: string;
  onContextMenu?: (event: MouseEvent) => void;
}) => {
  const url = useObjectUrl(file);
  const [zoom, setZoom] = useState(1);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [erroredUrl, setErroredUrl] = useState<string | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const updateViewportSize = () => {
      setViewportSize({
        width: container.clientWidth,
        height: container.clientHeight,
      });
    };

    updateViewportSize();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateViewportSize);
      return () => window.removeEventListener('resize', updateViewportSize);
    }

    const observer = new ResizeObserver(updateViewportSize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setNaturalSize(null);
    setLoadedUrl(null);
    setErroredUrl(null);
    setZoom(1);
  }, [url]);

  const imageLayout = useMemo(() => {
    if (!naturalSize) {
      return null;
    }

    const horizontalPadding = 48;
    const verticalPadding = 48;
    const availableWidth = Math.max(1, viewportSize.width - horizontalPadding);
    const availableHeight = Math.max(1, viewportSize.height - verticalPadding);
    const fitScale = Math.min(1, availableWidth / naturalSize.width, availableHeight / naturalSize.height);
    const width = Math.max(1, Math.round(naturalSize.width * fitScale * zoom));
    const height = Math.max(1, Math.round(naturalSize.height * fitScale * zoom));

    return {
      width,
      height,
      wrapperWidth: Math.max(viewportSize.width, width + horizontalPadding),
      wrapperHeight: Math.max(viewportSize.height, height + verticalPadding),
    };
  }, [naturalSize, viewportSize.height, viewportSize.width, zoom]);

  const loaded = Boolean(url && loadedUrl === url);
  const errored = Boolean(url && erroredUrl === url);

  return (
    <div ref={containerRef} className="relative h-full min-h-0 overflow-auto bg-background">
      <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-md border border-border bg-card/95 p-1 shadow">
        <button
          type="button"
          onClick={() => setZoom((value) => Math.max(0.1, value - 0.25))}
          className="rounded p-1.5 hover:bg-secondary"
          title="Zoom out"
          aria-label="Zoom out"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setZoom(1)}
          className="min-w-14 rounded px-2 py-1 text-xs hover:bg-secondary"
          title="Reset zoom"
          aria-label="Reset zoom"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          onClick={() => setZoom((value) => Math.min(6, value + 0.25))}
          className="rounded p-1.5 hover:bg-secondary"
          title="Zoom in"
          aria-label="Zoom in"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <div
        className="flex items-center justify-center p-6"
        style={{
          minWidth: imageLayout ? `${imageLayout.wrapperWidth}px` : '100%',
          minHeight: imageLayout ? `${imageLayout.wrapperHeight}px` : '100%',
        }}
      >
        {!loaded || errored ? (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <div className="flex min-h-48 min-w-64 items-center justify-center rounded border border-border bg-secondary p-6 text-sm text-muted-foreground">
              {errored ? 'Unable to load image' : 'Loading image...'}
            </div>
          </div>
        ) : null}
        {url ? (
          <img
            key={url}
            src={url}
            alt={fileName}
            onLoad={(event) => {
              setLoadedUrl(url);
              setErroredUrl((current) => (current === url ? null : current));
              setNaturalSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              });
            }}
            onError={() => {
              setLoadedUrl((current) => (current === url ? null : current));
              setErroredUrl(url);
            }}
            onContextMenu={onContextMenu}
            className={`block max-w-none object-contain ${loaded && !errored ? 'opacity-100' : 'opacity-0'}`}
            style={imageLayout ? { width: `${imageLayout.width}px`, height: `${imageLayout.height}px` } : undefined}
          />
        ) : null}
      </div>
    </div>
  );
};

const VideoFileViewer = ({
  file,
  onContextMenu,
}: {
  file: Blob;
  onContextMenu?: (event: MouseEvent) => void;
}) => {
  const url = useObjectUrl(file);

  return (
    <div onContextMenu={onContextMenu} className="flex h-full min-h-0 items-center justify-center bg-background">
      {url ? (
        <video src={url} controls className="max-h-full max-w-full" />
      ) : (
        <div className="rounded border border-border bg-secondary px-4 py-3 text-sm text-muted-foreground">
          Loading video...
        </div>
      )}
    </div>
  );
};

const ViewerError = ({ message }: { message: string }) => (
  <div className="flex h-full min-h-0 items-center justify-center p-6 text-center text-muted-foreground">
    <div>
      <AlertCircle className="mx-auto mb-3 h-8 w-8" />
      <p className="text-sm text-foreground">Cannot open this file</p>
      <p className="mt-1 text-xs">{message}</p>
    </div>
  </div>
);

const getFileKindIcon = (fileKind: ExplorerFileKind) => {
  switch (fileKind) {
    case 'image':
      return FileImage;
    case 'psd':
      return FileImage;
    case 'video':
      return Video;
    case 'json':
      return FileJson;
    case 'text':
      return FileText;
    default:
      return FileText;
  }
};

export const InternalFileViewer = ({
  file,
  fileName,
  fileKind,
  active,
  onContextMenu,
  onSavePsd,
}: InternalFileViewerProps) => {
  if (fileKind === 'psd') {
    return <PhotopeaBlobViewer file={file} fileName={fileName} active={active} onSavePsd={onSavePsd} />;
  }

  const FileKindIcon = getFileKindIcon(fileKind);
  const content = (() => {
    switch (fileKind) {
      case 'image':
        return <ImageFileViewer file={file} fileName={fileName} onContextMenu={onContextMenu} />;
      case 'text':
        return <TextFileViewer file={file} onContextMenu={onContextMenu} />;
      case 'json':
        return <TextFileViewer file={file} json onContextMenu={onContextMenu} />;
      case 'video':
        return <VideoFileViewer file={file} onContextMenu={onContextMenu} />;
      default:
        return <ViewerError message="This file type does not have a viewer." />;
    }
  })();

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileKindIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{fileName}</span>
        </div>
        {onContextMenu ? (
          <button
            type="button"
            onClick={(event) => onContextMenu(event)}
            className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
            title="File actions"
            aria-label="File actions"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">{content}</div>
    </div>
  );
};
