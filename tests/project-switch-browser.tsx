import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../src/App';
import { CommandProvider } from '../src/components/workspace/Commands';
import { InspectorProvider } from '../src/components/workspace/InspectorHost';
import { createProject } from '../src/types';
import { createProjectDirectory, type ProjectDirectoryHandle } from '../src/services/project/projectDirectoryService';
import '../src/index.css';

// Substitute only the picker boundary. All reads, activation, save flushing,
// tab restoration and docking run through the real App Open project command.
const pickerWindow = window as Window & {showDirectoryPicker?: () => Promise<ProjectDirectoryHandle>};
const originalPicker = pickerWindow.showDirectoryPicker;
let selected: 'A' | 'B' = 'A';
function Harness() {
  const [ready, setReady] = useState(false);
  const [choice, setChoice] = useState(selected);
  const [error, setError] = useState('');
  const start = async () => {
    try {
      const parent = await (await navigator.storage.getDirectory()).getDirectoryHandle(`switch-check-${crypto.randomUUID()}`, {create:true});
      const handles = {} as Record<'A' | 'B', ProjectDirectoryHandle>;
      for (const name of ['A', 'B'] as const) {
        const directory = await parent.getDirectoryHandle(name, {create:true});
        const project = createProject(`Project ${name}`, 'character');
        project.dataset.name = `Dataset ${name}`;
        await createProjectDirectory(directory as unknown as ProjectDirectoryHandle, project);
        const writer = await (await directory.getFileHandle(`${name}.txt`, {create:true})).createWritable();
        await writer.write(`Only project ${name}`); await writer.close();
        handles[name] = directory as unknown as ProjectDirectoryHandle;
      }
      pickerWindow.showDirectoryPicker = async () => handles[selected];
      setReady(true);
    } catch (cause) { setError(String(cause)); }
  };
  // New-project flow: the picker returns an empty OPFS parent; the test reads back the manifest App wrote.
  const startNew = async () => {
    try {
      const parent = await (await navigator.storage.getDirectory()).getDirectoryHandle(`new-project-${crypto.randomUUID()}`, {create:true});
      pickerWindow.showDirectoryPicker = async () => parent as unknown as ProjectDirectoryHandle;
      (window as unknown as Record<string, unknown>).__newProject = {
        manifest: async (name: string) => {
          const directory = await parent.getDirectoryHandle(name);
          return JSON.parse(await (await (await directory.getFileHandle('manifest.json')).getFile()).text());
        },
      };
      setReady(true);
    } catch (cause) { setError(String(cause)); }
  };
  return <>
    <header className="flex gap-4 border-b p-2">
      {!ready ? <><button onClick={() => void start()}>Prepare two isolated projects</button><button onClick={() => void startNew()}>Prepare empty parent for new project</button></> : <>
        <button onClick={() => {selected='A';setChoice('A');}}>Choose A for next Open</button>
        <button onClick={() => {selected='B';setChoice('B');}}>Choose B for next Open</button>
        <span role="status">Next Open project: {choice}</span>
      </>}
      {error && <p role="alert">{error}</p>}
    </header>
    {ready && <CommandProvider><InspectorProvider><App /></InspectorProvider></CommandProvider>}
  </>;
}
const root = createRoot(document.getElementById('root')!);
root.render(<React.StrictMode><Harness /></React.StrictMode>);
import.meta.hot?.dispose(() => {root.unmount();pickerWindow.showDirectoryPicker=originalPicker;});
