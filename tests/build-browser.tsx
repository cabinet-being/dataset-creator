import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BuildWorkspace } from '../src/components/build/BuildWorkspace';
import { CommandProvider } from '../src/components/workspace/Commands';
import { createProject, createSourceImage } from '../src/types';
import { toWorkspaceImages } from '../src/lib/workspaceImages';
import { useProjectStore } from '../src/stores/useProjectStore';
import { useUIStore } from '../src/stores/useUIStore';
import { useProjectSave } from '../src/hooks/useProjectSave';
import { createProjectDirectory, type ProjectDirectoryHandle } from '../src/services/project/projectDirectoryService';
import '../src/index.css';

function Harness() {
  useProjectSave();
  const [ready, setReady] = useState(false);
  const sources = useProjectStore((state) => state.sourceImages);
  const edits = useProjectStore((state) => state.datasetItems);
  const items = useMemo(() => toWorkspaceImages(Object.values(sources), Object.values(edits)), [edits, sources]);
  const prepare = async () => {
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 64;
    const context = canvas.getContext('2d')!; context.fillStyle = '#6750a4'; context.fillRect(0, 0, 96, 64);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/png'));
    const first = createSourceImage(blob, 'first.png', 96, 64); first.tags = ['portrait']; first.originalFilePath = 'src/shared/first.png';
    const second = createSourceImage(blob, 'second.png', 96, 64); second.originalFilePath = 'src/shared/second.png';
    const project = createProject('Build fixture', 'character'); project.sourceImages = { [first.id]: first, [second.id]: second };
    const storage = await navigator.storage.getDirectory();
    const directory = await storage.getDirectoryHandle(`build-fixture-${crypto.randomUUID()}`, { create:true }) as unknown as ProjectDirectoryHandle;
    await createProjectDirectory(directory, project);
    useProjectStore.getState().loadProject(project);
    useUIStore.setState({ projectDirectoryHandle:directory });
    setReady(true);
  };
  return <CommandProvider><main className="h-screen">{ready
    ? <BuildWorkspace active viewId="fixture:build" items={items} directory={useUIStore.getState().projectDirectoryHandle} />
    : <button onClick={() => void prepare()}>Prepare Build fixture</button>}</main></CommandProvider>;
}

const root = createRoot(document.getElementById('root')!); root.render(<Harness />);
import.meta.hot?.dispose(() => root.unmount());
