import { checkDirtyDocuments, useDocumentStateStore } from '../src/stores/useDocumentStateStore';
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CommandProvider, useCommandPalette, useCommands } from '../src/components/workspace/Commands';
import { DocumentActions } from '../src/components/workspace/DocumentActions';
import { PhotopeaBlobViewer } from '../src/components/photopea/PhotopeaFrame';
import { OperationStatus } from '../src/components/workspace/OperationStatus';
import { moveFileTab, type FileWorkspaceTab } from '../src/lib/workspaceFileTabs';
import '../src/index.css';

const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
const context = canvas.getContext('2d')!; context.fillStyle = '#edac40'; context.fillRect(0, 0, 32, 32);
const fixture = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'));

function Harness() {
  const [fileTab, setFileTab] = useState<FileWorkspaceTab>({id:'test:photopea',kind:'file-edit',path:'Project/synthetic-fixture.png',name:'synthetic-fixture.png',fileKind:'image',file:fixture});
  const documents = useDocumentStateStore(state => state.documents);
  const [closeCheck, setCloseCheck] = useState('Not checked');
  const [active, setActive] = useState<'photopea' | 'notes'>('photopea');
  const [notesSaved, setNotesSaved] = useState(0);
  const [fail, setFail] = useState(false);
  const [hold, setHold] = useState(false);
  const [writes, setWrites] = useState<string[]>([]);
  const [waiting, setWaiting] = useState(false);
  const release = useRef<() => void>();
  const notes = useRef<HTMLTextAreaElement>(null);
  const palette = useCommandPalette();
  useCommands([
    { id: 'document.save', label: 'Save notes', shortcut: 'Mod+S', allowInInput: true, active: active === 'notes', run: () => setNotesSaved(n => n + 1) },
    { id: 'focus.explorer', label: 'Focus test file chooser', run: () => { setActive('notes'); notes.current?.focus(); } },
  ]);
  return <main className="flex h-screen flex-col bg-background text-foreground">
    <header className="flex flex-wrap items-center gap-3 border-b p-3">
      <h1>Document save checks</h1>
      <button onClick={() => void checkDirtyDocuments(['test:photopea']).then(ids => setCloseCheck(ids.length ? 'Confirmation required' : 'Safe to close')).catch(error => setCloseCheck(error.message))}>Check close</button>
      <output>Photopea dirty: {documents['test:photopea']?.dirty ? 'yes' : 'no'} · {closeCheck}</output>
      <button onClick={() => setActive('photopea')}>Focus Photopea</button>
      <button onClick={() => setActive('notes')}>Focus notes</button>
      <button onClick={() => palette()}>Commands</button>
      <label><input type="checkbox" checked={fail} onChange={e => setFail(e.target.checked)} /> Fail writes</label>
      <label><input type="checkbox" checked={hold} onChange={e => setHold(e.target.checked)} /> Hold writes</label>
      <button disabled={!waiting} onClick={() => release.current?.()}>Finish write</button>
      <button disabled={waiting} onClick={() => setFileTab(tab => moveFileTab(tab,[{from:tab.path,to:`Project/renamed-fixture.${tab.name.split('.').pop()}`}]))}>Rename document</button>
      <output>{fileTab.path}</output>
    </header>
    <div className="flex min-h-0 flex-1">
      <section key={fileTab.id} data-dock-view={fileTab.id} aria-label="Photopea test editor" className="min-w-0 flex-1" onPointerDownCapture={() => setActive('photopea')}>
        <PhotopeaBlobViewer file={fileTab.file} fileName={fileTab.name} active={active === 'photopea'} onSavePsd={async (payload, copy) => {
          setWrites(entries => [...entries, `Request ${copy ? 'copy' : 'save'}: PSD ${String.fromCharCode(...new Uint8Array(payload.psd).slice(0, 4))}, ${payload.psd.byteLength} bytes; preview ${payload.preview?.byteLength ?? 0} bytes`]);
          if (hold) { setWaiting(true); await new Promise<void>(resolve => { release.current = resolve; }); setWaiting(false); }
          if (fail) { setWrites(entries => [...entries, 'Write failed']); throw new Error('Test write denied'); }
          if (!copy) setFileTab(tab => ({...tab,file:new Blob([payload.psd],{type:'image/vnd.adobe.photoshop'}),name:tab.name.replace(/\.[^.]+$/,'.psd'),path:tab.path.replace(/\.[^.]+$/,'.psd')}));
          setWrites(entries => [...entries, `Write completed: ${fileTab.path}`]);
        }} />
      </section>
      <section aria-label="Notes test editor" className="w-64 space-y-3 border-l p-3" onPointerDownCapture={() => setActive('notes')}>
        <h2>Notes</h2><textarea ref={notes} aria-label="Test notes" className="w-full border bg-background" onFocus={() => setActive('notes')} />
        <DocumentActions active={active === 'notes'} />
        <p>Notes saves: {notesSaved}</p><p>Active: {active}</p><p>Writing: {waiting ? 'yes' : 'no'}</p>
        <ol aria-label="Write results">{writes.map((entry, index) => <li key={index}>{entry}</li>)}</ol>
      </section>
    </div>
    <footer className="flex justify-end border-t p-2"><OperationStatus onFocusView={() => setActive('photopea')} /></footer>
  </main>;
}
const root = createRoot(document.getElementById('root')!);
root.render(<React.StrictMode><CommandProvider><Harness /></CommandProvider></React.StrictMode>);
import.meta.hot?.dispose(() => root.unmount());
