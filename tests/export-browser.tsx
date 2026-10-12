import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { writePsd } from 'ag-psd';
import { ExportTool } from '../src/components/tools/ExportTool';
import { CommandProvider } from '../src/components/workspace/Commands';
import { createProject } from '../src/types';
import { useProjectStore } from '../src/stores/useProjectStore';
import { useUIStore } from '../src/stores/useUIStore';
import type { ProjectDirectoryHandle } from '../src/services/project/projectDirectoryService';
import '../src/index.css';

// Only the folder picker is substituted. ExportTool reads the actual PSD,
// calls the live Photopea converter, and writes into a fresh OPFS destination.
const picker = window as Window & { showDirectoryPicker?: () => Promise<ProjectDirectoryHandle> };
const originalPicker = picker.showDirectoryPicker;
let output: FileSystemDirectoryHandle;
function Harness() {
  const [ready, setReady] = useState(false);
  const [result, setResult] = useState('');
  const [saved, setSaved] = useState<string[]>([]);
  const findSaved = async () => {
    const storage = await navigator.storage.getDirectory();
    const names: string[] = [];
    for await (const [name, handle] of (storage as FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }).entries()) {
      if (handle.kind === 'directory' && name.startsWith('export-check-')) names.push(name);
    }
    setSaved(names);
  };
  const prepare = async () => {
    try {
      const parent = await (await navigator.storage.getDirectory()).getDirectoryHandle(`export-check-${crypto.randomUUID()}`, { create: true });
      const input = await parent.getDirectoryHandle('input', { create: true });
      output = await parent.getDirectoryHandle('output', { create: true });
      const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 24;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 16, 24);
      ctx.fillStyle = '#0000ff'; ctx.fillRect(16, 0, 16, 24);
      const psd = writePsd({ width: 32, height: 24, canvas, children: [{ name: 'Color sentinel', canvas }] });
      const writer = await (await input.getFileHandle('sentinel.psd', { create: true })).createWritable();
      await writer.write(psd); await writer.close();
      const project = createProject('PSD export fixture', 'character');
      project.dataset.assetPaths = ['sentinel.psd'];
      project.dataset.triggerWord = 'sentinel';
      useProjectStore.getState().loadProject(project);
      useUIStore.setState({ projectDirectoryHandle: input as unknown as ProjectDirectoryHandle });
      picker.showDirectoryPicker = async () => output as unknown as ProjectDirectoryHandle;
      setReady(true);
    } catch (error) { setResult(String(error)); }
  };
  const inspect = async () => {
    try {
      const file = await (await output.getFileHandle('sentinel.png')).getFile();
      const signature = [...new Uint8Array(await file.slice(0, 8).arrayBuffer())].join(',');
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0); bitmap.close();
      const left = [...ctx.getImageData(4, 12, 1, 1).data].join(',');
      const right = [...ctx.getImageData(24, 12, 1, 1).data].join(',');
      const caption = await (await (await output.getFileHandle('sentinel.txt')).getFile()).text();
      const pass = signature === '137,80,78,71,13,10,26,10' && canvas.width === 32 && canvas.height === 24 && left === '255,0,0,255' && right === '0,0,255,255' && caption === 'sentinel\n';
      setResult(`${pass ? 'PASS' : 'FAIL'}: PNG ${canvas.width}×${canvas.height}; left ${left}; right ${right}; caption ${JSON.stringify(caption)}`);
    } catch (error) { setResult(String(error)); }
  };
  return <CommandProvider><main>
    <header className="flex gap-4 p-4"><button onClick={() => void prepare()}>Prepare PSD fixture</button>{ready && <button onClick={() => void inspect()}>Inspect exported pixels and caption</button>}</header>
    <button onClick={() => void findSaved()}>Find saved fixture results</button>
    {saved.map(name => <button className="block" key={name} onClick={() => void (async () => {
      output = await (await (await navigator.storage.getDirectory()).getDirectoryHandle(name)).getDirectoryHandle('output');
      await inspect();
    })()}>Inspect {name}</button>)}
    <p role="status">{result}</p>
    {ready && <ExportTool />}
  </main></CommandProvider>;
}
const root = createRoot(document.getElementById('root')!); root.render(<Harness />);
import.meta.hot?.dispose(() => { root.unmount(); picker.showDirectoryPicker = originalPicker; });
