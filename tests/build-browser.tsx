import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BuildWorkspace } from '../src/components/build/BuildWorkspace';
import { CommandProvider } from '../src/components/workspace/Commands';
import { createProject, createSourceImage } from '../src/types';
import { createBuildSession } from '../src/services/build/buildSessionService';
import type { SemanticFeature } from '../src/services/analysis/semanticFeatureService';
import type { WorkspaceImage } from '../src/lib/workspaceImages';
import { toWorkspaceImages } from '../src/lib/workspaceImages';
import { useProjectStore } from '../src/stores/useProjectStore';
import { useUIStore } from '../src/stores/useUIStore';
import { useProjectSave } from '../src/hooks/useProjectSave';
import { createProjectDirectory, type ProjectDirectoryHandle } from '../src/services/project/projectDirectoryService';
import '../src/index.css';

const pngOf = async (width: number, height: number, paint: (context: CanvasRenderingContext2D) => void) => {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  paint(canvas.getContext('2d')!);
  return new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/png'));
};
// Deterministic blocky noise: sharp (high Laplacian energy), mid exposure, distinct per seed.
const detailed = (width: number, height: number, seed: number) => pngOf(width, height, (context) => {
  let state = seed * 2654435761 >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  for (let y = 0; y < height; y += 4) for (let x = 0; x < width; x += 4) {
    context.fillStyle = `rgb(${80 + next() * 120 | 0},${80 + next() * 120 | 0},${80 + next() * 120 | 0})`;
    context.fillRect(x, y, 4, 4);
  }
});
const flat = (width: number, height: number) => pngOf(width, height, (context) => { context.fillStyle = '#808080'; context.fillRect(0, 0, width, height); });

// Fake semantic encoder (no model, no network): one-hot-like vectors per file; near.png ~ d.png (cosine > 0.999).
const DIMENSIONS = 8;
const unit = (values: number[]) => { const length = Math.hypot(...values); return Float32Array.from(values, (value) => value / length); };
const basis = (index: number, extra?: [number, number]) => {
  const values = new Array<number>(DIMENSIONS).fill(0); values[index] = 1;
  if (extra) values[extra[0]] = extra[1];
  return unit(values);
};
const FAKE_VECTORS: Record<string, Float32Array> = {
  'a.png': basis(0), 'a-copy.png': basis(0), 'b.png': basis(1), 'c.png': basis(2), 'd.png': basis(3), 'near.png': basis(3, [4, 0.03]),
};
const fakeEncoderFactory = async () => ({
  encode: async (item: WorkspaceImage, caption: string): Promise<SemanticFeature> => {
    const name = (item.assetPath ?? item.fileName ?? '').split('/').pop() ?? '';
    const image = FAKE_VECTORS[name] ?? basis(5);
    return { imageHash: `fake:${name}`, image, text: basis(6), contexts: [], caption };
  },
  dispose: async () => undefined,
});

function Harness() {
  useProjectSave();
  const [ready, setReady] = useState(false);
  const [auto, setAuto] = useState(false);
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
  const prepareAuto = async () => {
    const files: Array<[string, Blob]> = [];
    const a = await detailed(1100, 1100, 1);
    files.push(['a.png', a], ['a-copy.png', a], ['b.png', await detailed(1100, 1100, 2)], ['c.png', await detailed(1100, 1100, 3)],
      ['d.png', await detailed(1100, 1100, 4)], ['near.png', await detailed(1100, 1100, 5)],
      ['tiny.png', await detailed(200, 200, 6)], ['flat.png', await flat(1100, 1100)], ['below.png', await detailed(900, 1000, 7)]);
    const sourceImages = Object.fromEntries(files.map(([name, blob]) => {
      const source = createSourceImage(blob, name, name === 'tiny.png' ? 200 : name === 'below.png' ? 900 : 1100, name === 'tiny.png' ? 200 : name === 'below.png' ? 1000 : 1100);
      source.originalFilePath = `src/shared/${name}`;
      return [source.id, source];
    }));
    const project = createProject('Build auto fixture', 'character'); project.sourceImages = sourceImages;
    project.buildSession = { ...createBuildSession(), profile: { ...createBuildSession().profile, target: 3 } };
    const storage = await navigator.storage.getDirectory();
    const directory = await storage.getDirectoryHandle(`build-auto-fixture-${crypto.randomUUID()}`, { create:true }) as unknown as ProjectDirectoryHandle;
    await createProjectDirectory(directory, project);
    useProjectStore.getState().loadProject(project);
    useUIStore.setState({ projectDirectoryHandle:directory });
    (window as unknown as Record<string, unknown>).__buildFixture = {
      session: () => useProjectStore.getState().buildSession,
      paths: () => {
        const state = useProjectStore.getState();
        return Object.fromEntries(toWorkspaceImages(Object.values(state.sourceImages), Object.values(state.datasetItems)).map((item) => [(item.assetPath ?? item.fileName).split('/').pop()!, item.assetPath]));
      },
    };
    setAuto(true); setReady(true);
  };
  const prepareCoverage = async () => {
    // Character project with 10 tagged files already in dataset/: 'solo' is in every file, framing tags are mixed.
    const framing = ['full body', 'full body', 'full body', 'full body', 'full body', 'close-up', 'close-up', 'close-up', 'upper body', 'upper body'];
    const blob = await detailed(64, 96, 1);
    const sourceImages = Object.fromEntries(framing.map((shot, index) => {
      const name = `cov-${index}.png`;
      const source = createSourceImage(blob, name, 64, 96);
      source.tags = ['solo', shot, `extra${index}`]; source.originalFilePath = `dataset/${name}`; source.manifestPath = `dataset/${name}.manifest.json`;
      return [source.id, source];
    }));
    const project = createProject('Build coverage fixture', 'character'); project.sourceImages = sourceImages;
    const storage = await navigator.storage.getDirectory();
    const directory = await storage.getDirectoryHandle(`build-coverage-fixture-${crypto.randomUUID()}`, { create:true }) as unknown as ProjectDirectoryHandle;
    await createProjectDirectory(directory, project);
    useProjectStore.getState().loadProject(project);
    useUIStore.setState({ projectDirectoryHandle:directory });
    (window as unknown as Record<string, unknown>).__buildFixture = {
      paths: () => {
        const state = useProjectStore.getState();
        return Object.fromEntries(toWorkspaceImages(Object.values(state.sourceImages), Object.values(state.datasetItems)).map((item) => [(item.assetPath ?? item.fileName).split('/').pop()!, item.assetPath]));
      },
      tags: () => Object.fromEntries(Object.values(useProjectStore.getState().sourceImages).map((source) => [(source.originalFilePath ?? source.fileName).split('/').pop()!, source.tags])),
      projectType: () => useProjectStore.getState().projectType,
    };
    setReady(true);
  };
  return <CommandProvider><main className="h-screen">{ready
    ? <BuildWorkspace active viewId="fixture:build" items={items} directory={useUIStore.getState().projectDirectoryHandle} semanticEncoderFactory={auto ? fakeEncoderFactory : undefined} />
    : <><button onClick={() => void prepare()}>Prepare Build fixture</button><button onClick={() => void prepareAuto()}>Prepare auto pipeline fixture</button><button onClick={() => void prepareCoverage()}>Prepare coverage fixture</button></>}</main></CommandProvider>;
}

const root = createRoot(document.getElementById('root')!); root.render(<Harness />);
import.meta.hot?.dispose(() => root.unmount());
