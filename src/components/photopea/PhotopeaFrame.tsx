import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';

export const PHOTOPEA_ORIGIN = 'https://www.photopea.com';
export const PSD_TOOL_COMMAND_EVENT = 'dataset-creator-psd-command';

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
      tabIndex={0}
    />
  );
});

PhotopeaFrame.displayName = 'PhotopeaFrame';

type PsdToolCommand = 'save' | 'saveCopy';

export const PhotopeaBlobViewer = ({
  file,
  fileName,
  active = true,
  onSavePsd,
}: {
  file: Blob;
  fileName: string;
  active?: boolean;
  onSavePsd?: (buffer: ArrayBuffer, saveCopy: boolean) => void | Promise<void>;
}) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const openedRef = useRef(false);
  const savingRef = useRef<PsdToolCommand | null>(null);
  const readyRef = useRef(false);
  const [status, setStatus] = useState('Loading Photopea...');

  useEffect(() => {
    openedRef.current = false;
    readyRef.current = false;
    savingRef.current = null;
    setStatus('Loading Photopea...');

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || event.origin !== PHOTOPEA_ORIGIN) {
        return;
      }

      if (event.data === 'done') {
        if (openedRef.current) {
          readyRef.current = true;
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

      if (event.data instanceof ArrayBuffer && savingRef.current) {
        const command = savingRef.current;
        savingRef.current = null;
        setStatus(command === 'saveCopy' ? 'Saving PSD copy...' : 'Saving PSD...');
        void Promise.resolve(onSavePsd?.(event.data, command === 'saveCopy'))
          .then(() => setStatus(command === 'saveCopy' ? 'Saved PSD copy.' : 'Saved PSD.'))
          .catch(() => setStatus(command === 'saveCopy' ? 'Unable to save PSD copy.' : 'Unable to save PSD.'));
      }

      if (event.data === 'Save' && onSavePsd && readyRef.current) {
        const photopeaWindow = iframeRef.current?.contentWindow;
        if (!photopeaWindow) {
          setStatus('Photopea is not available.');
          return;
        }
        savingRef.current = 'save';
        setStatus('Requesting PSD...');
        photopeaWindow.postMessage('app.activeDocument.saveToOE("psd");', PHOTOPEA_ORIGIN);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [file, fileName, onSavePsd]);

  useEffect(() => {
    if (!active || !onSavePsd) {
      return;
    }

    const handleCommand = (event: Event) => {
      const command = (event as CustomEvent<PsdToolCommand>).detail;
      if (command !== 'save' && command !== 'saveCopy') {
        return;
      }
      if (!readyRef.current) {
        setStatus('Photopea is still loading...');
        return;
      }
      const photopeaWindow = iframeRef.current?.contentWindow;
      if (!photopeaWindow) {
        setStatus('Photopea is not available.');
        return;
      }
      savingRef.current = command;
      setStatus(command === 'saveCopy' ? 'Requesting PSD copy...' : 'Requesting PSD...');
      photopeaWindow.postMessage('app.activeDocument.saveToOE("psd");', PHOTOPEA_ORIGIN);
    };

    window.addEventListener(PSD_TOOL_COMMAND_EVENT, handleCommand);
    return () => window.removeEventListener(PSD_TOOL_COMMAND_EVENT, handleCommand);
  }, [active, onSavePsd]);

  return (
    <div className="relative h-full min-h-0 bg-black">
      <p className="pointer-events-none absolute left-3 top-3 z-10 rounded bg-black/70 px-2 py-1 text-xs text-white">
        {status}
      </p>
      <PhotopeaFrame ref={iframeRef} title={`Photopea editor for ${fileName}`} />
    </div>
  );
};
