import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';

export const PHOTOPEA_ORIGIN = 'https://www.photopea.com';

export const CLOSE_ALL_DOCUMENTS_SCRIPT = [
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
        save: 'app.echoToOE("Save");',
        exportAs: true,
      },
      panels: [0, 2],
    },
  };

  return `${PHOTOPEA_ORIGIN}#${encodeURIComponent(JSON.stringify(config))}`;
};

export const PhotopeaFrame = forwardRef<
  HTMLIFrameElement,
  {
    title: string;
    className?: string;
  }
>(({ title, className = 'h-full min-h-0 w-full border-0 bg-black' }, ref) => {
  const photopeaUrl = useMemo(createPhotopeaUrl, []);

  return (
    <iframe
      ref={ref}
      title={title}
      src={photopeaUrl}
      className={className}
      allow="clipboard-read; clipboard-write; fullscreen"
    />
  );
});

PhotopeaFrame.displayName = 'PhotopeaFrame';

export const PhotopeaBlobViewer = ({ file, fileName }: { file: Blob; fileName: string }) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const openedRef = useRef(false);
  const [status, setStatus] = useState('Loading Photopea...');

  useEffect(() => {
    openedRef.current = false;
    setStatus('Loading Photopea...');

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || event.origin !== PHOTOPEA_ORIGIN) {
        return;
      }

      if (event.data === 'done') {
        if (openedRef.current) {
          setStatus('Ready in Photopea.');
          return;
        }

        openedRef.current = true;
        file
          .arrayBuffer()
          .then((buffer) => {
            setStatus(`Opening ${fileName}...`);
            iframeRef.current?.contentWindow?.postMessage(buffer, PHOTOPEA_ORIGIN, [buffer]);
          })
          .catch(() => setStatus('Unable to open PSD in Photopea.'));
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [file, fileName]);

  return (
    <div className="relative h-full min-h-0 bg-black">
      <p className="pointer-events-none absolute left-3 top-3 z-10 rounded bg-black/70 px-2 py-1 text-xs text-white">
        {status}
      </p>
      <PhotopeaFrame ref={iframeRef} title={`Photopea editor for ${fileName}`} />
    </div>
  );
};
