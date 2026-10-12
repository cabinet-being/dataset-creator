import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { useDocumentStateStore } from '../stores/useDocumentStateStore';

const ORIGIN = 'https://www.photopea.com';

/** Track each iframe independently; serialization is not a successful filesystem save. */
export function usePhotopeaDocumentState(root: RefObject<HTMLElement>, frame: RefObject<HTMLIFrameElement>, canInspect: () => boolean) {
  const canInspectRef = useRef(canInspect); canInspectRef.current = canInspect;
  const api = useMemo(() => {
    let viewId = '';
    let dirty = false;
    let unsavedWrite = false;
    let dirtyBeforeSave = false;
    let request = 0;
    let pending: { id: string; resolve: (dirty: boolean) => void; reject: (error: Error) => void; timer: number } | undefined;
    let pendingPromise: Promise<boolean> | undefined;
    const prefix = `document-state:${crypto.randomUUID()}:`;
    let suppressDone = false;
    const report = (value: boolean) => {
      dirty = value;
      if (viewId) useDocumentStateStore.getState().changed(viewId, verify, dirty);
    };
    const check = (inspectable = canInspectRef.current()): Promise<boolean> => {
      if (pendingPromise) return pendingPromise;
      if (!inspectable || !frame.current?.contentWindow) return Promise.resolve(dirty);
      const id = `${prefix}${++request}:`;
      pendingPromise = new Promise<boolean>((resolve, reject) => {
        const timer = window.setTimeout(() => { pending = undefined; pendingPromise = undefined; reject(new Error('Could not verify Photopea changes. Return to the editor and try again.')); }, 3000);
        pending = { id, resolve, reject, timer };
        frame.current!.contentWindow!.postMessage(`app.echoToOE(${JSON.stringify(id)} + (app.documents.length ? String(app.activeDocument.saved) : "true"));`, ORIGIN);
      });
      return pendingPromise;
    };
    const receive = (event: MessageEvent) => {
      if (event.origin !== ORIGIN || event.source !== frame.current?.contentWindow) return;
      if (event.data === 'done' && suppressDone) { suppressDone = false; event.stopImmediatePropagation(); return; }
      if (typeof event.data !== 'string' || !event.data.startsWith(prefix)) return;
      suppressDone = true; event.stopImmediatePropagation();
      if (!pending || !event.data.startsWith(pending.id)) return;
      const result = event.data.slice(pending.id.length);
      const current = pending;
      window.clearTimeout(current.timer); pending = undefined; pendingPromise = undefined;
      if (result !== 'true' && result !== 'false') { current.reject(new Error('Photopea did not report its document state.')); return; }
      report(unsavedWrite || result === 'false'); current.resolve(dirty);
    };
    // A close/save gesture needs a fresh response, not an earlier background poll.
    const verify = async () => {
      const inspectable = canInspectRef.current();
      if (pendingPromise) await pendingPromise;
      return check(inspectable);
    };
    return {
      check: verify,
      reset() {
        if (pending) { window.clearTimeout(pending.timer); pending.resolve(false); pending = undefined; pendingPromise = undefined; }
        unsavedWrite = false; report(false);
      },
      async saving() { dirtyBeforeSave = await verify(); unsavedWrite = true; report(true); },
      saved(copy = false) {
        unsavedWrite = copy && dirtyBeforeSave;
        return verify().catch(() => { report(true); return true; });
      },
      attach() {
        viewId = root.current?.closest<HTMLElement>('[data-dock-view]')?.dataset.dockView ?? '';
        const unregister = viewId ? useDocumentStateStore.getState().register(viewId, { dirty, check: verify }) : () => {};
        window.addEventListener('message', receive);
        const poll = () => { void check().catch(() => {}); };
        const timer = window.setInterval(poll, 1000);
        window.addEventListener('focus', poll);
        const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
        window.addEventListener('beforeunload', beforeUnload);
        return () => {
          unregister(); window.clearInterval(timer);
          window.removeEventListener('message', receive); window.removeEventListener('focus', poll); window.removeEventListener('beforeunload', beforeUnload);
          if (pending) { window.clearTimeout(pending.timer); pending.reject(new Error('Editor closed')); pending = undefined; pendingPromise = undefined; }
        };
      },
    };
  }, [root, frame]);
  useEffect(() => api.attach(), [api]);
  return api;
}
