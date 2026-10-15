import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../src/App';
import { CommandProvider } from '../src/components/workspace/Commands';
import { InspectorProvider } from '../src/components/workspace/InspectorHost';
import { createProject, createSourceImage } from '../src/types';
import { useProjectStore } from '../src/stores/useProjectStore';
import '../src/index.css';
function Harness() {
  const [ready, setReady] = useState(false);
  const start = async () => {
    const canvas = document.createElement('canvas'); canvas.width=32; canvas.height=24;
    canvas.getContext('2d')!.fillRect(0,0,32,24);
    const blob = await new Promise<Blob>(resolve=>canvas.toBlob(value=>resolve(value!), 'image/png'));
    const first=createSourceImage(blob,'very-long-portrait-caption-fixture-name.png',24,64); first.tags=['original-first'];
    const second=createSourceImage(blob,'extra-wide-panorama-caption-fixture.png',120,20); second.tags=['original-second'];
    const project = createProject('Caption fixture','character');
    project.dataset.assetIds = [first.id, second.id];
    useProjectStore.getState().loadProject({...project,sourceImages:{[first.id]:first,[second.id]:second}});
    setReady(true);
  };
  return ready ? <CommandProvider><InspectorProvider><App /></InspectorProvider></CommandProvider> : <button onClick={()=>void start()}>Load two captioned images</button>;
}
const root=createRoot(document.getElementById('root')!);root.render(<Harness/>);
import.meta.hot?.dispose(()=>root.unmount());
