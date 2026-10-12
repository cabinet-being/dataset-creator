import React, { Suspense, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceTool } from '../src/components/workspace/WorkspaceTool';
import { CommandProvider } from '../src/components/workspace/Commands';
import { InspectorProvider } from '../src/components/workspace/InspectorHost';
import { getToolViewContext } from '../src/lib/workspaceToolScope';
import { createProject, createSourceImage } from '../src/types';
import { useProjectStore } from '../src/stores/useProjectStore';
import '../src/index.css';

function Harness() {
  const [ready, setReady] = useState(false);
  const [tool, setTool] = useState<'analysis' | 'tagging'>('tagging');
  const [empty, setEmpty] = useState(false);
  const start = async () => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 24;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#3c78a8'; ctx.fillRect(0, 0, 32, 24);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
    const source = createSourceImage(blob, 'scope-sentinel.png', 32, 24);
    const project = createProject('Scope fixture', 'character');
    useProjectStore.getState().loadProject({...project, sourceImages:{[source.id]:source}});
    setReady(true);
  };
  return <CommandProvider><InspectorProvider>
    <main className="space-y-4 p-4">
      <h1>Tool scope checks</h1>
      {!ready ? <button onClick={() => void start()}>Load scope fixture</button> : <>
        <div className="flex gap-4">
          <button onClick={() => setTool('tagging')}>Test Caption</button>
          <button onClick={() => setTool('analysis')}>Test Analysis</button>
          <button onClick={() => setEmpty(false)}>Entire project</button>
          <button onClick={() => setEmpty(true)}>Empty selection</button>
        </div>
        <p role="status">{tool} / {empty ? 'explicit empty selection' : 'entire project'}</p>
        <section data-dock-view="scope-check" className="h-[700px] overflow-auto">
          <Suspense fallback={<p>Loading tool</p>}>
            <WorkspaceTool {...getToolViewContext(tool, empty ? tool === 'analysis' ? {analysisFiles:[]} : {taggingItemIds:[]} : undefined)} active />
          </Suspense>
        </section>
      </>}
    </main>
  </InspectorProvider></CommandProvider>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Harness /></React.StrictMode>);
