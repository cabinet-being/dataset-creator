import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  completePhotopeaPsdPreviewJob,
  startPhotopeaPsdPreviewJobTimeout,
  subscribeToPhotopeaPsdPreviewQueue,
  takePhotopeaPsdPreviewJob,
  type PhotopeaPsdPreviewJob,
} from '../../services/psd/photopeaPreviewQueue';
import { appLog } from '../../services/logging/applicationLog';

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

type PsdPreviewWorkerPhase = 'waiting-ready' | 'idle' | 'opening' | 'saving-png' | 'clearing';

export const PhotopeaPsdPreviewWorker = ({ active = true }: { active?: boolean }) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const readyRef = useRef(false);
  const phaseRef = useRef<PsdPreviewWorkerPhase>('waiting-ready');
  const jobRef = useRef<PhotopeaPsdPreviewJob | null>(null);
  const previewRef = useRef<ArrayBuffer | null>(null);

  const startNextJob = useCallback(() => {
    if (!active || !readyRef.current || phaseRef.current !== 'idle' || jobRef.current) {
      return;
    }

    const job = takePhotopeaPsdPreviewJob();
    if (!job) {
      return;
    }

    const photopeaWindow = iframeRef.current?.contentWindow;
    if (!photopeaWindow) {
      completePhotopeaPsdPreviewJob(job, undefined);
      return;
    }

    jobRef.current = job;
    appLog.info(`PSD preview: Photopea processing ${job.path}`);
    startPhotopeaPsdPreviewJobTimeout(job);
    job.onTimeout = () => {
      if (jobRef.current !== job) {
        return;
      }
      jobRef.current = null;
      previewRef.current = null;
      phaseRef.current = 'idle';
      appLog.warning(`PSD preview: Photopea timed out for ${job.path}`);
      startNextJob();
    };
    previewRef.current = null;
    phaseRef.current = 'opening';
    void job.file
      .arrayBuffer()
      .then((buffer) => {
        photopeaWindow.postMessage(buffer, PHOTOPEA_ORIGIN, [buffer]);
      })
      .catch((error) => {
        if (import.meta.env.DEV) {
          console.warn(`[psd-preview] unable to send ${job.path} to Photopea`, error);
        }
        jobRef.current = null;
        phaseRef.current = 'idle';
        completePhotopeaPsdPreviewJob(job, undefined);
        startNextJob();
      });
  }, [active]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const unsubscribe = subscribeToPhotopeaPsdPreviewQueue(startNextJob);
    startNextJob();
    return unsubscribe;
  }, [active, startNextJob]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || event.origin !== PHOTOPEA_ORIGIN) {
        return;
      }

      if (event.data instanceof ArrayBuffer && phaseRef.current === 'saving-png') {
        previewRef.current = event.data;
        return;
      }

      if (event.data !== 'done') {
        return;
      }

      if (phaseRef.current === 'waiting-ready') {
        readyRef.current = true;
        phaseRef.current = 'idle';
        appLog.info('PSD preview: Photopea worker ready');
        startNextJob();
        return;
      }

      if (phaseRef.current === 'opening') {
        phaseRef.current = 'saving-png';
        iframeRef.current?.contentWindow?.postMessage('app.activeDocument.saveToOE("png");', PHOTOPEA_ORIGIN);
        return;
      }

      if (phaseRef.current === 'saving-png') {
        const job = jobRef.current;
        const preview = previewRef.current;
        if (!job) {
          phaseRef.current = 'idle';
          startNextJob();
          return;
        }

        completePhotopeaPsdPreviewJob(
          job,
          preview ? new Blob([preview], { type: 'image/png' }) : undefined
        );
        appLog.info(`PSD preview: Photopea returned ${preview ? 'PNG' : 'no preview'} for ${job.path}`);
        jobRef.current = null;
        previewRef.current = null;
        phaseRef.current = 'clearing';
        iframeRef.current?.contentWindow?.postMessage(CLOSE_ALL_DOCUMENTS_SCRIPT, PHOTOPEA_ORIGIN);
        return;
      }

      if (phaseRef.current === 'clearing') {
        phaseRef.current = 'idle';
        startNextJob();
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [active, startNextJob]);

  if (!active) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed -bottom-[10000px] -right-[10000px] h-[240px] w-[320px] overflow-hidden opacity-0" aria-hidden="true">
      <PhotopeaFrame ref={iframeRef} title="Photopea PSD preview worker" className="h-[240px] w-[320px] border-0" />
    </div>
  );
};

type PsdToolCommand = 'save' | 'saveCopy';
type PsdSavePayload = {
  psd: ArrayBuffer;
  preview?: ArrayBuffer;
};

type PsdSavePhase = 'idle' | 'saving-png' | 'saving-psd';

export const PhotopeaBlobViewer = ({
  file,
  fileName,
  active = true,
  onSavePsd,
}: {
  file: Blob;
  fileName: string;
  active?: boolean;
  onSavePsd?: (payload: PsdSavePayload, saveCopy: boolean) => void | Promise<void>;
}) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const openedRef = useRef(false);
  const savingRef = useRef<PsdToolCommand | null>(null);
  const savePhaseRef = useRef<PsdSavePhase>('idle');
  const pendingPreviewRef = useRef<ArrayBuffer | null>(null);
  const pendingPsdRef = useRef<ArrayBuffer | null>(null);
  const readyRef = useRef(false);
  const [status, setStatus] = useState('Loading Photopea...');
  const onSavePsdRef = useRef(onSavePsd);
  onSavePsdRef.current = onSavePsd;

  useEffect(() => {
    openedRef.current = false;
    readyRef.current = false;
    savingRef.current = null;
    savePhaseRef.current = 'idle';
    pendingPreviewRef.current = null;
    pendingPsdRef.current = null;
    setStatus('Loading Photopea...');

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || event.origin !== PHOTOPEA_ORIGIN) {
        return;
      }

      if (event.data instanceof ArrayBuffer && savingRef.current) {
        if (savePhaseRef.current === 'saving-png') {
          pendingPreviewRef.current = event.data;
          setStatus('Receiving preview...');
          return;
        }

        if (savePhaseRef.current === 'saving-psd') {
          pendingPsdRef.current = event.data;
          setStatus('Receiving PSD...');
          return;
        }
      }

      if (event.data === 'done') {
        if (savingRef.current && savePhaseRef.current === 'saving-png') {
          if (!pendingPreviewRef.current) {
            savingRef.current = null;
            savePhaseRef.current = 'idle';
            setStatus('Photopea did not return a preview.');
            return;
          }

          savePhaseRef.current = 'saving-psd';
          setStatus('Requesting PSD...');
          iframeRef.current?.contentWindow?.postMessage('app.activeDocument.saveToOE("psd");', PHOTOPEA_ORIGIN);
          return;
        }

        if (savingRef.current && savePhaseRef.current === 'saving-psd') {
          const command = savingRef.current;
          const psd = pendingPsdRef.current;
          const preview = pendingPreviewRef.current ?? undefined;
          savingRef.current = null;
          savePhaseRef.current = 'idle';
          pendingPreviewRef.current = null;
          pendingPsdRef.current = null;

          if (!psd) {
            setStatus('Photopea did not return a PSD.');
            return;
          }

          setStatus(command === 'saveCopy' ? 'Saving PSD copy...' : 'Saving PSD...');
          void Promise.resolve(onSavePsdRef.current?.({ psd, preview }, command === 'saveCopy'))
            .then(() => setStatus(command === 'saveCopy' ? 'Saved PSD copy.' : 'Saved PSD.'))
            .catch(() => setStatus(command === 'saveCopy' ? 'Unable to save PSD copy.' : 'Unable to save PSD.'));
          return;
        }

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

      if (event.data === 'Save' && onSavePsdRef.current && readyRef.current) {
        const photopeaWindow = iframeRef.current?.contentWindow;
        if (!photopeaWindow) {
          setStatus('Photopea is not available.');
          return;
        }
        savingRef.current = 'save';
        savePhaseRef.current = 'saving-png';
        pendingPreviewRef.current = null;
        pendingPsdRef.current = null;
        setStatus('Requesting preview...');
        photopeaWindow.postMessage('app.activeDocument.saveToOE("png");', PHOTOPEA_ORIGIN);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [file, fileName]);

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
      savePhaseRef.current = 'saving-png';
      pendingPreviewRef.current = null;
      pendingPsdRef.current = null;
      setStatus(command === 'saveCopy' ? 'Requesting PSD copy preview...' : 'Requesting preview...');
      photopeaWindow.postMessage('app.activeDocument.saveToOE("png");', PHOTOPEA_ORIGIN);
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
