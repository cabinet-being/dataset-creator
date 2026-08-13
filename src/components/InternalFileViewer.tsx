import { useEffect, useState } from 'react';
import type { MouseEvent } from 'react';
import { AlertCircle, Minus, Plus } from 'lucide-react';
import type { ExplorerFileKind } from '../services/project/explorerFileService';
import { PhotopeaBlobViewer } from './photopea/PhotopeaFrame';

type InternalFileViewerProps = {
  file: File | Blob;
  fileName: string;
  fileKind: ExplorerFileKind;
  active?: boolean;
  onContextMenu?: (event: MouseEvent) => void;
  onSavePsd?: (buffer: ArrayBuffer, saveCopy: boolean) => void | Promise<void>;
};

const useObjectUrl = (file: Blob | null) => {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }

    const nextUrl = URL.createObjectURL(file);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file]);

  return url;
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

  useEffect(() => {
    let canceled = false;
    setError(null);
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
        }
      })
      .catch((readError) => {
        if (!canceled) {
          setError(readError instanceof Error ? readError.message : 'Unable to read file.');
        }
      });

    return () => {
      canceled = true;
    };
  }, [file, json]);

  if (error) {
    return <ViewerError message={error} />;
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

  if (!url) {
    return null;
  }

  return (
    <div className="relative flex h-full min-h-0 items-center justify-center overflow-auto bg-background">
      <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-md border border-border bg-card/95 p-1 shadow">
        <button
          type="button"
          onClick={() => setZoom((value) => Math.max(0.1, value - 0.25))}
          className="rounded p-1.5 hover:bg-secondary"
          title="Zoom out"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setZoom(1)}
          className="min-w-14 rounded px-2 py-1 text-xs hover:bg-secondary"
          title="Reset zoom"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          onClick={() => setZoom((value) => Math.min(6, value + 0.25))}
          className="rounded p-1.5 hover:bg-secondary"
          title="Zoom in"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <img
        src={url}
        alt={fileName}
        onContextMenu={onContextMenu}
        className="block max-h-full max-w-full object-contain"
        style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
      />
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

  if (!url) {
    return null;
  }

  return (
    <div onContextMenu={onContextMenu} className="flex h-full min-h-0 items-center justify-center bg-background">
      <video src={url} controls className="max-h-full max-w-full" />
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

export const InternalFileViewer = ({
  file,
  fileName,
  fileKind,
  active,
  onContextMenu,
  onSavePsd,
}: InternalFileViewerProps) => {
  switch (fileKind) {
    case 'image':
      return <ImageFileViewer file={file} fileName={fileName} onContextMenu={onContextMenu} />;
    case 'text':
      return <TextFileViewer file={file} onContextMenu={onContextMenu} />;
    case 'json':
      return <TextFileViewer file={file} json onContextMenu={onContextMenu} />;
    case 'video':
      return <VideoFileViewer file={file} onContextMenu={onContextMenu} />;
    case 'psd':
      return <PhotopeaBlobViewer file={file} fileName={fileName} active={active} onSavePsd={onSavePsd} />;
    default:
      return <ViewerError message="This file type does not have a viewer." />;
  }
};
