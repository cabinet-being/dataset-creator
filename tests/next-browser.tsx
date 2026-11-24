import React from 'react';
import { createRoot } from 'react-dom/client';
import NextApp from '../src/next/NextApp';
import { CommandProvider } from '../src/components/workspace/Commands';
import { InspectorProvider } from '../src/components/workspace/InspectorHost';
import { createProject, createSourceImage } from '../src/types';
import { createBuildSession } from '../src/services/build/buildSessionService';
import { createProjectDirectory, type ProjectDirectoryHandle } from '../src/services/project/projectDirectoryService';
import { forgetRecentProject, listRecentProjects, rememberRecentProject } from '../src/services/project/recentProjectsService';
import { toWorkspaceImages } from '../src/lib/workspaceImages';
import { useProjectStore } from '../src/stores/useProjectStore';
import { flushProjectSave } from '../src/hooks/useProjectSave';
import { useHistoryStore } from '../src/stores/useHistoryStore';
import { hexDigest, SEMANTIC_FEATURE_MODEL, type createSemanticFeatureEncoder } from '../src/services/analysis/semanticFeatureService';
import { writeImageFeature } from '../src/services/analysis/semanticFeatureCache';
import { setVideoMeta } from '../src/services/video/videoCache';
import '../src/index.css';

// Only the folder picker is substituted (an OPFS directory); Open, New, recent projects, Board, Sources, grid and
// lightbox are the real NextApp. Fixtures stay tiny: 8x8 PNGs, at most a few hundred.
const pickerWindow = window as Window & { showDirectoryPicker?: () => Promise<ProjectDirectoryHandle> };
const originalPicker = pickerWindow.showDirectoryPicker;

const png = (index: number) => {
  const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
  const context = canvas.getContext('2d')!; context.fillStyle = `hsl(${(index * 37) % 360} 60% 50%)`; context.fillRect(0, 0, 8, 8);
  return new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'));
};
const opfsRoot = () => navigator.storage.getDirectory();
const uniqueDirectory = async (prefix: string) => (await opfsRoot()).getDirectoryHandle(`${prefix}-${crypto.randomUUID()}`, { create: true });
const nameOf = (path: string | undefined) => (path ?? '').split('/').pop()!;

// Fake DINOv2: one unit vector per file name, so the groups of an Assemble are known in advance. a1-a3 and b1-b2 are near copies (cosine > 0.999).
const DIMENSIONS = 16;
const unit = (values: number[]) => { const length = Math.hypot(...values); return Float32Array.from(values, value => value / length); };
const axisVector = (index: number, extra?: [number, number]) => {
  const values = new Array<number>(DIMENSIONS).fill(0); values[index] = 1;
  if (extra) values[extra[0]] = extra[1];
  return unit(values);
};
const ASSEMBLE_VECTORS: Record<string, Float32Array> = {
  'a1.png': axisVector(0), 'a2.png': axisVector(0, [8, 0.03]), 'a3.png': axisVector(0, [9, 0.05]),
  'b1.png': axisVector(1), 'b2.png': axisVector(1, [10, 0.04]),
  'c1.png': axisVector(2), 'c2.png': axisVector(3), 'c3.png': axisVector(4), 'c4.png': axisVector(5), 'c5.png': axisVector(6), 'c6.png': axisVector(7),
  // cosine 0.908 to c1: one group at Loose (cutoff 0.85) but two at Balanced (0.93) and Strict (0.985).
  'd1.png': axisVector(2, [14, 0.46]),
  'tiny.png': axisVector(11),
};
const ASSEMBLE_NAMES = Object.keys(ASSEMBLE_VECTORS);
// Test control over the fake encoder: `gate` holds every encode until released (to look at progress and to Cancel); `encoded` counts calls.
const encoderControl: { gate: Promise<void> | null; release: (() => void) | null; encoded: string[] } = { gate: null, release: null, encoded: [] };
const fakeEncoderFactory: typeof createSemanticFeatureEncoder = async () => ({
  encode: async (item, caption) => {
    if (encoderControl.gate) await encoderControl.gate;
    const name = nameOf(item.assetPath ?? item.fileName);
    encoderControl.encoded.push(name);
    return { imageHash: `fake:${name}`, image: ASSEMBLE_VECTORS[name] ?? axisVector(12), text: axisVector(13), contexts: [], caption };
  },
  dispose: async () => undefined,
});
// Textured, sharp and cheap: 8 px blocks, distinct per seed (flat or blurry frames would be rejected by the quality check).
const textured = (width: number, height: number, seed: number) => {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d')!;
  let state = Math.imul(seed + 1, 2654435761) >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  for (let y = 0; y < height; y += 8) for (let x = 0; x < width; x += 8) {
    context.fillStyle = `rgb(${80 + random() * 120 | 0},${80 + random() * 120 | 0},${80 + random() * 120 | 0})`; context.fillRect(x, y, 8, 8);
  }
  return new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'));
};

type Kind = 'sources' | 'grid' | 'big' | 'assemble';
// Project-relative file paths per fixture kind. `emptyFolders` are created on disk without images.
const LAYOUTS: Record<Kind, { files: string[]; emptyFolders: string[] }> = {
  sources: { files: ['inbox/day1/a.png', 'inbox/day1/b.png', 'inbox/c.png', 'dataset/d.png'], emptyFolders: ['inbox/empty', 'inbox/other'] },
  grid: {
    files: ['dataset/in1.png', 'dataset/pin1.png', 'inbox/q1.png', 'inbox/dup1.png', 'inbox/ns1.png', 'inbox/ban1.png', 'inbox/new1.png'],
    emptyFolders: [],
  },
  // 13 frames for a full Assemble (see ASSEMBLE_VECTORS): group A (3 near copies), group B (2), six singles, d1 (like c1 at Loose) and one small portrait frame below the target model's minimum.
  assemble: { files: [...ASSEMBLE_NAMES.map(name => `inbox/shots/${name}`)], emptyFolders: [] },
  big: { files: Array.from({ length: 300 }, (_, index) => `inbox/big/f${String(index).padStart(3, '0')}.png`), emptyFolders: [] },
};

let parent: FileSystemDirectoryHandle | undefined;

const api = {
  /** The next folder picker returns a fresh empty OPFS parent (New project flow). */
  useEmptyParent: async () => {
    parent = await uniqueDirectory('next-parent');
    pickerWindow.showDirectoryPicker = async () => parent as unknown as ProjectDirectoryHandle;
  },
  manifest: async (name: string) => {
    const directory = await parent!.getDirectoryHandle(name);
    return JSON.parse(await (await (await (await directory.getDirectoryHandle('.datasetcreator')).getFileHandle('project.json')).getFile()).text());
  },
  /** Writes a ready project to OPFS and makes the next folder picker return it; the test then clicks "Open folder…". */
  prepare: async (kind: Kind, projectName: string) => {
    const layout = LAYOUTS[kind];
    const directory = await uniqueDirectory(`next-${kind}`);
    // The Assemble fixture targets SD 1.5 (minimum short side 512 px), so real frames stay small; its Size is Auto.
    const project = createProject(projectName, 'character', kind === 'assemble' ? 'sd15' : 'sdxl');
    if (kind === 'assemble') project.buildSession = { ...createBuildSession(), profile: { ...createBuildSession().profile, sizeMode: 'auto' } };
    const sources = await Promise.all(layout.files.map(async (path, index) => {
      // tiny.png is portrait (200x300) and below the minimum; every other Assemble frame is a 512x512 square.
      const [width, height] = kind !== 'assemble' ? [8, 8] : nameOf(path) === 'tiny.png' ? [200, 300] : [512, 512];
      const source = createSourceImage(kind === 'assemble' ? await textured(width, height, index) : await png(index), nameOf(path), width, height);
      source.originalFilePath = path;
      // Health reads image features from the cache: seed it, so the real model is never needed.
      if (kind === 'assemble') writeImageFeature(`${await hexDigest(source.originalFile)}:${SEMANTIC_FEATURE_MODEL.visual}`, ASSEMBLE_VECTORS[nameOf(path)]);
      return source;
    }));
    project.sourceImages = Object.fromEntries(sources.map(source => [source.id, source]));
    await createProjectDirectory(directory as unknown as ProjectDirectoryHandle, project);
    for (const folder of layout.emptyFolders) {
      let current = directory;
      for (const part of folder.split('/')) current = await current.getDirectoryHandle(part, { create: true });
    }
    pickerWindow.showDirectoryPicker = async () => directory as unknown as ProjectDirectoryHandle;
    return directory.name;
  },
  /** Statuses by file name. Revisions are copied from the reconciled record (the fixture images have no caption), so nothing is stale. */
  seedStatuses: async (spec: Record<string, 'pin' | 'ban' | 'quality' | 'not-selected' | { duplicateOf: string }>) => {
    const names = [...Object.keys(spec), ...Object.values(spec).flatMap(value => typeof value === 'object' ? [value.duplicateOf] : [])];
    const recordOf = (name: string) => Object.values(useProjectStore.getState().buildSession.records).find(record => nameOf(record.locator) === name);
    const deadline = Date.now() + 15_000;
    while (!names.every(name => recordOf(name)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    const now = new Date().toISOString();
    useProjectStore.getState().updateBuildSession(session => {
      const records = { ...session.records };
      for (const [name, status] of Object.entries(spec)) {
        const record = recordOf(name);
        if (!record) throw new Error(`No record for ${name}`);
        const revision = record.revision;
        const triage = (group: 'accepted' | 'rejected', stage: 'quality' | 'assembly', message: string) => ({ group, stage, revision, createdAt: now, reasons: [{ code: 'fixture', message }] });
        records[record.assetId] = status === 'pin' ? { ...record, override: 'pin' }
          : status === 'ban' ? { ...record, override: 'ban' }
          : status === 'quality' ? { ...record, triage: triage('rejected', 'quality', 'Too small') }
          : status === 'not-selected' ? { ...record, triage: triage('rejected', 'assembly', 'Not selected'), assembly: { outcome: 'not-selected', revision } }
          : { ...record, triage: triage('rejected', 'assembly', 'Duplicate'), assembly: { outcome: 'duplicate', of: recordOf(status.duplicateOf)!.assetId, similarity: 0.97, revision } };
      }
      return { ...session, records };
    });
  },
  session: () => {
    const state = useProjectStore.getState();
    return {
      sources: state.buildSession.profile.sources,
      strictness: state.buildSession.profile.similarityStrictness,
      assembledAt: state.buildSession.auto?.assembledAt,
      records: Object.fromEntries(Object.values(state.buildSession.records).map(record => [nameOf(record.locator), { override: record.override, origin: record.origin, locator: record.locator }])),
    };
  },
  paths: () => {
    const state = useProjectStore.getState();
    return toWorkspaceImages(Object.values(state.sourceImages), Object.values(state.datasetItems)).map(item => item.assetPath);
  },
  /** Pretends the DINOv2 model is cached, so Health reads the seeded features instead of asking to download it. Call before opening the project. */
  fakeModelPresent: () => setVideoMeta('model', 'fake'),
  /** Holds the fake encoder until `releaseEncoder` (Assemble then stays in "Understanding images"). */
  holdEncoder: () => { encoderControl.gate = new Promise<void>(resolve => { encoderControl.release = resolve; }); },
  releaseEncoder: () => { encoderControl.release?.(); encoderControl.gate = null; encoderControl.release = null; },
  encodedCount: () => encoderControl.encoded.length,
  resetEncoded: () => { encoderControl.encoded = []; },
  historyBusy: () => useHistoryStore.getState().busy,
  /** Writes pending autosave data to disk, as the Projects button does before closing. */
  flush: () => flushProjectSave(),
  undoDepth: () => useHistoryStore.getState().past.length,
  /** Recent projects store, driven with OPFS folders: names are made up, lastEditedAt is explicit. */
  rememberFolders: async (count: number) => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    for (let index = 0; index < count; index += 1) {
      const directory = await uniqueDirectory('next-recent');
      await rememberRecentProject(directory as unknown as ProjectDirectoryHandle, {
        name: `Recent ${index}`, projectType: 'general', targetModel: 'sdxl', datasetCount: index, lastEditedAt: new Date(base + index * 60_000).toISOString(),
      });
    }
  },
  listRecent: async () => (await listRecentProjects()).map(entry => ({ id: entry.id, name: entry.name, lastEditedAt: entry.lastEditedAt })),
  forgetRecent: (id: string) => forgetRecentProject(id),
};
(window as unknown as Record<string, unknown>).__next = api;

const root = createRoot(document.getElementById('root')!);
root.render(<React.StrictMode><CommandProvider><InspectorProvider><NextApp encoderFactory={fakeEncoderFactory} /></InspectorProvider></CommandProvider></React.StrictMode>);
import.meta.hot?.dispose(() => { root.unmount(); pickerWindow.showDirectoryPicker = originalPicker; });
