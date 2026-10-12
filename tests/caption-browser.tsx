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
    const first=createSourceImage(blob,'first.png',32,24); first.tags=['original-first'];
    const second=createSourceImage(blob,'second.png',32,24); second.tags=['original-second'];
    useProjectStore.getState().loadProject({...createProject('Caption fixture','character'),sourceImages:{[first.id]:first,[second.id]:second}});
    setReady(true);
  };
  return ready ? <CommandProvider><InspectorProvider><App /></InspectorProvider></CommandProvider> : <button onClick={()=>void start()}>Load two captioned images</button>;
}
const root=createRoot(document.getElementById('root')!);root.render(<Harness/>);
import.meta.hot?.dispose(()=>root.unmount());
