import { usePhotopeaDocumentState } from '../../hooks/usePhotopeaDocumentState';
import { DocumentActions } from '../workspace/DocumentActions';
import { useOperation } from '../../hooks/useOperation';
import { useCommands, useCommandRunner } from '../workspace/Commands';
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

type PsdSavePhase = 'idle' | 'saving-png' | 'saving-psd' | 'writing';

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
  // Saving refreshes the parent's file snapshot. Keep the live document (including
  // edits made during that write) until this viewer is actually unmounted.
  const [initialDocument] = useState(() => ({ file, fileName }));
  const rootRef = useRef<HTMLDivElement>(null);
  const writeOperation = useOperation('Save document', rootRef, `photopea:${fileName}`);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const openedRef = useRef(false);
  const savingRef = useRef<PsdToolCommand | null>(null);
  const savePhaseRef = useRef<PsdSavePhase>('idle');
  const pendingPreviewRef = useRef<ArrayBuffer | null>(null);
  const pendingPsdRef = useRef<ArrayBuffer | null>(null);
  const readyRef = useRef(false);
  const documentState = usePhotopeaDocumentState(rootRef, iframeRef, () => readyRef.current && (savePhaseRef.current === 'idle' || savePhaseRef.current === 'writing'));
  const [status, setStatus] = useState('Loading Photopea...');
  const onSavePsdRef = useRef(onSavePsd);
  onSavePsdRef.current = onSavePsd;
  const runCommand = useCommandRunner();
  const runCommandRef = useRef(runCommand); runCommandRef.current = runCommand;

  useEffect(() => {
    documentState.reset();
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

      if (event.data === 'Open') {
        runCommandRef.current('focus.explorer');
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
            writeOperation.finish('failed', 'Photopea did not return a preview.');
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
          savePhaseRef.current = 'writing';
          pendingPreviewRef.current = null;
          pendingPsdRef.current = null;

          if (!psd) {
            savePhaseRef.current = 'idle';
            writeOperation.finish('failed', 'Photopea did not return a PSD.');
            setStatus('Photopea did not return a PSD.');
            return;
          }

          setStatus(command === 'saveCopy' ? 'Saving PSD copy...' : 'Saving PSD...');
          const save = onSavePsdRef.current;
          void Promise.resolve().then(() => {
            if (!save) throw new Error('Saving is unavailable for this document.');
            return save({ psd, preview }, command === 'saveCopy');
          }).then(() => {
            writeOperation.progress(1, 1); writeOperation.finish('completed', `Saved ${fileName}`);
            savePhaseRef.current = 'idle'; documentState.saved(command === 'saveCopy'); setStatus(command === 'saveCopy' ? 'Saved PSD copy.' : 'Saved PSD.');
          }).catch(error => {
            writeOperation.finish('failed', error instanceof Error ? error.message : 'Unable to save PSD');
            savePhaseRef.current = 'idle'; setStatus(command === 'saveCopy' ? 'Unable to save PSD copy.' : 'Unable to save PSD.');
          });
          return;
        }

        if (savePhaseRef.current === 'writing') return;
        if (openedRef.current) {
          readyRef.current = true;
          setStatus('Ready in Photopea.');
          return;
        }

        openedRef.current = true;
        initialDocument.file
          .arrayBuffer()
          .then((buffer) => {
            setStatus(`Opening ${initialDocument.fileName}...`);
            iframeRef.current?.contentWindow?.postMessage(buffer, PHOTOPEA_ORIGIN, [buffer]);
          })
          .catch(() => setStatus('Unable to open PSD in Photopea.'));
      }

      if (event.data === 'Save' && onSavePsdRef.current && readyRef.current && savePhaseRef.current === 'idle') {
        const photopeaWindow = iframeRef.current?.contentWindow;
        if (!photopeaWindow) {
          setStatus('Photopea is not available.');
          return;
        }
        writeOperation.start(undefined, 1);
        const inspect = documentState.saving();
        savingRef.current = 'save';
        savePhaseRef.current = 'saving-png';
        pendingPreviewRef.current = null;
        pendingPsdRef.current = null;
        setStatus('Requesting preview...');
        void inspect.then(() => photopeaWindow.postMessage('app.activeDocument.saveToOE("png");', PHOTOPEA_ORIGIN)).catch(error => {
          savingRef.current = null; savePhaseRef.current = 'idle'; writeOperation.finish('failed', error.message); setStatus(error.message);
        });
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [initialDocument, writeOperation, documentState]);

  const requestSave = (command: PsdToolCommand) => {
    if (!onSavePsdRef.current || !readyRef.current || savePhaseRef.current !== 'idle') return;
    const photopeaWindow = iframeRef.current?.contentWindow;
    if (!photopeaWindow) { setStatus('Photopea is not available.'); return; }
    writeOperation.start(undefined, 1);
    const inspect = documentState.saving();
    savingRef.current = command;
    savePhaseRef.current = 'saving-png';
    pendingPreviewRef.current = null;
    pendingPsdRef.current = null;
    setStatus(command === 'saveCopy' ? 'Requesting PSD copy preview...' : 'Requesting preview...');
    void inspect.then(() => photopeaWindow.postMessage('app.activeDocument.saveToOE("png");', PHOTOPEA_ORIGIN)).catch(error => {
      savingRef.current = null; savePhaseRef.current = 'idle'; writeOperation.finish('failed', error.message); setStatus(error.message);
    });
  };
  const saveDisabled = !onSavePsd || !readyRef.current || savePhaseRef.current !== 'idle';
  useCommands([
    { id: 'document.save', label: `Save ${fileName}`, shortcut: 'Mod+S', allowInInput: true, active, disabled: saveDisabled,
      reason: !readyRef.current ? 'Photopea is loading' : savePhaseRef.current !== 'idle' ? 'Saving document…' : !onSavePsd ? 'This document is read-only' : undefined,
      run: () => requestSave('save') },
    { id: 'document.saveCopy', label: 'Save document copy', active, disabled: saveDisabled, run: () => requestSave('saveCopy') },
  ]);

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border p-2">
        <DocumentActions active={active} open />
        <p role="status" className="text-xs text-muted-foreground">{status}</p>
      </div>
      <PhotopeaFrame ref={iframeRef} title={`Photopea editor for ${fileName}`} className="min-h-0 flex-1" />
    </div>
  );
};
