import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../src/App';
import { CommandProvider } from '../src/components/workspace/Commands';
import { InspectorProvider } from '../src/components/workspace/InspectorHost';
import { createProject } from '../src/types';
import { createProjectDirectory, type ProjectDirectoryHandle } from '../src/services/project/projectDirectoryService';
import { useProjectStore } from '../src/stores/useProjectStore';
import { useUIStore } from '../src/stores/useUIStore';
import '../src/index.css';
import { checkExplorerMarquee } from './explorer-marquee-checks';

// Mount the actual App against disposable OPFS files. No directory picker or
// user-selected folder is involved; normal App selection/rename/save code runs.
function Harness() {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [checks, setChecks] = useState('');
  const start = async () => {
    setBusy(true);
    try {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(`explorer-check-${crypto.randomUUID()}`, {create:true});
      const directory = root as unknown as ProjectDirectoryHandle;
      const project = createProject('Explorer fixture', 'character');
      await createProjectDirectory(directory, project);
      const folder = await root.getDirectoryHandle('Keyboard', {create:true});
      for (const name of ['alpha.txt', 'beta.txt', 'gamma.txt']) {
        const stream = await (await folder.getFileHandle(name, {create:true})).createWritable();
        await stream.write(`Fixture ${name}`); await stream.close();
      }
      useProjectStore.getState().loadProject(project);
      useUIStore.getState().setProjectDirectory({handle:directory, name:project.name});
      setReady(true);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  return ready ? <CommandProvider><InspectorProvider><App /></InspectorProvider></CommandProvider> :
    <main className="space-y-4 p-4"><h1>Explorer workflow checks</h1>
      <p>Start the actual workspace with three disposable text files in browser storage.</p>
      <button disabled={busy} onClick={() => void start()}>Start Explorer fixture</button>
      <button disabled={busy} onClick={async () => {
        setBusy(true);
        try { setChecks(await checkExplorerMarquee()); } catch (cause) { setError(String(cause)); }
        finally { setBusy(false); }
      }}>Run marquee regressions</button>
      {checks && <p role="status">{checks}</p>}
      {error && <p role="alert">{error}</p>}
    </main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Harness /></React.StrictMode>);
