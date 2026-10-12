import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AssetGallery } from '../src/components/ui/AssetGallery';
import { WorkspacePreviewCard } from '../src/components/ui/WorkspacePreviewCard';
import { BrickMasonry } from '../src/components/ui/BrickMasonry';
import { CommandProvider } from '../src/components/workspace/Commands';
import type { WorkspaceImage } from '../src/lib/workspaceImages';
import '../src/index.css';

const blob = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#476c94"/></svg>'], { type: 'image/svg+xml' });
const preview = URL.createObjectURL(blob);
const fixture = (count: number): WorkspaceImage[] => Array.from({ length: count }, (_, index) => ({ id: `source:${index}`, sourceImageId: String(index), fileName: `image-${index}.png`, originalFileName: `Photo ${index}.png`, kind: 'image', label: 'Image', displayIdentity: String(index), imageData: blob, width: 320, height: 240, aspectRatio: '3:2', tags: index % 2 ? ['portrait'] : [] }));
const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
type Result = { mode: string; count: number; render: number; select?: number; cards: number; overflow: boolean; heap?: number };
function Checks() {
  const [items, setItems] = useState<WorkspaceImage[]>([]);
  const [mode, setMode] = useState('gallery');
  const [width, setWidth] = useState(920);
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const renderItem = (item: WorkspaceImage) => <WorkspacePreviewCard item={item} previewUrl={preview} />;
  const run = async () => {
    setBusy(true); setResults([]);
    const output: Result[] = [];
    for (const variant of ['masonry', 'gallery']) for (const count of [100, 1000, 5000]) {
      setItems([]); await frames();
      const data = fixture(count); const start = performance.now();
      setMode(variant); setItems(data); await frames();
      const render = performance.now() - start;
      const checkbox = root.current?.querySelector<HTMLInputElement>('input[type=checkbox]');
      const selectionStart = performance.now(); checkbox?.click(); await frames();
      const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
      output.push({ mode: variant, count, render: Math.round(render), select: checkbox ? Math.round(performance.now() - selectionStart) : undefined, cards: root.current?.querySelectorAll('img').length ?? 0, overflow: (root.current?.scrollWidth ?? 0) > (root.current?.clientWidth ?? 0), heap: memory ? Math.round(memory.usedJSHeapSize / 1024 / 1024) : undefined });
      setResults([...output]);
    }
    setBusy(false);
  };
  return <main className="min-h-screen space-y-4 bg-background p-4 text-foreground">
    <h1 className="text-xl font-semibold">UI workflow checks</h1>
    <p className="text-sm">Synthetic assets, shared preview. Measurements include two animation frames. Heap is browser-reported and includes earlier trials.</p>
    <div className="flex flex-wrap gap-3"><button className="rounded border p-2" disabled={busy} onClick={() => void run()}>Run gallery benchmark</button><button className="rounded border p-2" onClick={() => { setMode('gallery'); setItems(fixture(101)); }}>Load 101 assets</button><label>Panel width <select aria-label="Test panel width" value={width} onChange={event => setWidth(Number(event.target.value))}><option value={920}>920 px</option><option value={320}>320 px</option></select></label><button className="rounded border p-2" onClick={() => document.documentElement.classList.toggle('dark')}>Toggle theme</button></div>
    <table className="text-left text-sm"><thead><tr>{['Mode', 'Assets', 'Render ms', 'Select ms', 'Mounted images', 'Overflow', 'Heap MB'].map(label => <th className="pr-4" key={label}>{label}</th>)}</tr></thead><tbody>{results.map(row => <tr key={`${row.mode}${row.count}`}><td>{row.mode}</td><td>{row.count}</td><td>{row.render}</td><td>{row.select ?? 'N/A'}</td><td>{row.cards}</td><td>{String(row.overflow)}</td><td>{row.heap ?? 'N/A'}</td></tr>)}</tbody></table>
    <div ref={root} data-dock-view="test:gallery" tabIndex={-1} style={{ width, maxWidth: '100%', height: 600, overflow: 'auto' }}>
      {mode === 'gallery' ? <AssetGallery items={items} renderItem={renderItem} onAdd={() => {}} /> : <BrickMasonry items={items} getKey={item => item.id} getEstimate={() => 0.75} renderItem={renderItem} />}
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<CommandProvider><Checks /></CommandProvider>);
