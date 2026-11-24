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
import { useDocumentStateStore } from '../src/stores/useDocumentStateStore';
import JSZip from 'jszip';
import { BufferTarget, CanvasSource, Output, WebMOutputFormat } from 'mediabunny';
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

// A tiny WebM (4 frames of 160x90) for the Video Frames overlay; the encoder is the browser's own VP8.
const makeWebm = async () => {
  const canvas = new OffscreenCanvas(160, 90); const context = canvas.getContext('2d')!;
  const target = new BufferTarget();
  const output = new Output({ format: new WebMOutputFormat(), target });
  const source = new CanvasSource(canvas, { codec: 'vp8', bitrate: 500_000 });
  output.addVideoTrack(source);
  await output.start();
  for (let index = 0; index < 4; index += 1) {
    context.fillStyle = ['#d32f2f', '#1565c0', '#16a34a', '#c026d3'][index]; context.fillRect(0, 0, 160, 90);
    context.fillStyle = '#ffffff'; context.fillRect(10 + index * 30, 20, 40, 50);
    await source.add(index * 0.1, 0.1);
  }
  await output.finalize(); source.close();
  return new Blob([target.buffer!], { type: 'video/webm' });
};

type Kind = 'sources' | 'grid' | 'big' | 'assemble' | 'caption' | 'advice' | 'export' | 'video';
// Project-relative file paths per fixture kind. `emptyFolders` are created on disk without images; `captions` are TXT files written next to them.
const LAYOUTS: Record<Kind, { files: string[]; emptyFolders: string[]; captions?: Record<string, string>; size?: [number, number]; trigger?: string }> = {
  // Caption mode: c1-c3 tagged, c4 an empty caption file, c5 no caption file, inbox/i1 is not in the dataset.
  caption: {
    files: ['dataset/c1.png', 'dataset/c2.png', 'dataset/c3.png', 'dataset/c4.png', 'dataset/c5.png', 'inbox/i1.png'], emptyFolders: [], trigger: 'hero',
    captions: { 'dataset/c1.txt': 'hero, red hair, smile', 'dataset/c2.txt': 'hero, Red Hair, hat', 'dataset/c3.txt': 'hero, red hair', 'dataset/c4.txt': '', 'inbox/i1.txt': 'hero, red hair' },
  },
  // The common-tags advice of a character project: "red hair" is in every caption.
  advice: {
    files: ['dataset/m1.png', 'dataset/m2.png', 'dataset/m3.png'], emptyFolders: [], trigger: 'hero',
    captions: { 'dataset/m1.txt': 'hero, red hair, smile', 'dataset/m2.txt': 'hero, red hair, hat', 'dataset/m3.txt': 'hero, red hair' },
  },
  // Export: 64x40 frames (resize has something to shrink); e3 has no caption file.
  export: {
    files: ['dataset/e1.png', 'dataset/e2.png', 'dataset/e3.png', 'inbox/x1.png'], emptyFolders: [], size: [64, 40], trigger: 'hero',
    captions: { 'dataset/e1.txt': 'hero, one', 'dataset/e2.txt': 'hero, two' },
  },
  video: { files: ['inbox/shot.png'], emptyFolders: [] },
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
let projectRoot: FileSystemDirectoryHandle | undefined;
let exportTarget: FileSystemDirectoryHandle | undefined;
const bitmapControl: { gate: Promise<void> | null; release: (() => void) | null } = { gate: null, release: null };
const projectWrites: number[] = [];
let dropFake: (() => void) | undefined;

const listFiles = async (directory: FileSystemDirectoryHandle, prefix = ''): Promise<string[]> => {
  const found: string[] = [];
  for await (const [name, handle] of (directory as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    if (name === '.datasetcreator') continue;
    if (handle.kind === 'directory') found.push(...await listFiles(handle as FileSystemDirectoryHandle, `${prefix}${name}/`)); else found.push(`${prefix}${name}`);
  }
  return found.sort();
};
const fileAt = async (directory: FileSystemDirectoryHandle, path: string) => {
  const parts = path.split('/'); const name = parts.pop()!;
  let current = directory;
  for (const part of parts) current = await current.getDirectoryHandle(part);
  return (await current.getFileHandle(name)).getFile();
};
const writeAt = async (directory: FileSystemDirectoryHandle, path: string, data: Blob | string) => {
  const parts = path.split('/'); const name = parts.pop()!;
  let current = directory;
  for (const part of parts) current = await current.getDirectoryHandle(part, { create: true });
  const writable = await (await current.getFileHandle(name, { create: true })).createWritable();
  await writable.write(data); await writable.close();
};
const sizeOf = async (blob: Blob) => { const bitmap = await createImageBitmap(blob); const size = { width: bitmap.width, height: bitmap.height }; bitmap.close(); return size; };

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
    if (layout.trigger) project.dataset = { ...project.dataset, triggerWord: layout.trigger };
    // Export is offered after an Assemble: the Export fixture is a project that was assembled before.
    if (kind === 'export') project.buildSession = { ...createBuildSession(), auto: { assembledAt: new Date().toISOString() } };
    if (kind === 'assemble') project.buildSession = { ...createBuildSession(), profile: { ...createBuildSession().profile, sizeMode: 'auto' } };
    const sources = await Promise.all(layout.files.map(async (path, index) => {
      // tiny.png is portrait (200x300) and below the minimum; every other Assemble frame is a 512x512 square.
      const [width, height] = kind !== 'assemble' ? layout.size ?? [8, 8] : nameOf(path) === 'tiny.png' ? [200, 300] : [512, 512];
      const source = createSourceImage(kind === 'assemble' || layout.size ? await textured(width, height, index) : await png(index), nameOf(path), width, height);
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
    for (const [path, text] of Object.entries(layout.captions ?? {})) await writeAt(directory, path, text);
    if (kind === 'video') await writeAt(directory, 'inbox/clip.webm', await makeWebm());
    projectRoot = directory;
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
      lastExport: state.buildSession.lastExport,
      records: Object.fromEntries(Object.values(state.buildSession.records).map(record => [nameOf(record.locator), { override: record.override, origin: record.origin, locator: record.locator }])),
    };
  },
  /** Every file of the project folder on disk (relative paths, without .datasetcreator). */
  files: () => listFiles(projectRoot!),
  /** The text of a project file, or null while it does not exist. */
  readText: async (path: string) => { try { return await (await fileAt(projectRoot!, path)).text(); } catch (error) { if ((error as DOMException).name === 'NotFoundError') return null; throw error; } },
  imageSize: async (path: string) => sizeOf(await fileAt(projectRoot!, path)),
  /** Entries of a ZIP in the project folder: name, text of a .txt, size of an image. */
  zipEntries: async (path: string) => {
    const zip = await JSZip.loadAsync(await (await fileAt(projectRoot!, path)).arrayBuffer());
    const result: { name: string; text?: string; width?: number; height?: number }[] = [];
    for (const name of Object.keys(zip.files).sort()) {
      if (zip.files[name].dir) continue;
      result.push(name.endsWith('.txt') ? { name, text: await zip.files[name].async('string') } : { name, ...await sizeOf(new Blob([await zip.files[name].async('arraybuffer')])) });
    }
    return result;
  },
  /** The next folder picker returns a fresh empty OPFS folder (Export to a folder). */
  useExportFolder: async () => {
    exportTarget = await uniqueDirectory('next-export');
    pickerWindow.showDirectoryPicker = async () => exportTarget as unknown as ProjectDirectoryHandle;
  },
  exportFolderFiles: async () => {
    const result: { name: string; text?: string; width?: number; height?: number }[] = [];
    for (const name of await listFiles(exportTarget!)) {
      const file = await fileAt(exportTarget!, name);
      result.push(name.endsWith('.txt') ? { name, text: await file.text() } : { name, ...await sizeOf(file) });
    }
    return result;
  },
  /** Model suggestions by file name; the revision is copied from the record, so they are not stale. */
  seedProposals: async (spec: Record<string, string[]>) => {
    const recordOf = (name: string) => Object.values(useProjectStore.getState().buildSession.records).find(record => nameOf(record.locator) === name);
    const deadline = Date.now() + 15_000;
    while (!Object.keys(spec).every(name => recordOf(name)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    useProjectStore.getState().updateBuildSession(session => {
      const records = { ...session.records };
      for (const [name, tags] of Object.entries(spec)) {
        const record = recordOf(name);
        if (!record) throw new Error(`No record for ${name}`);
        records[record.assetId] = { ...record, proposal: { tags, revision: record.revision ?? '' } };
      }
      return { ...session, records };
    });
  },
  /** Holds image decoding of the export resize until `releaseBitmaps` (the export then stays in progress). */
  holdBitmaps: () => {
    if (bitmapControl.gate) return;
    const original = window.createImageBitmap.bind(window) as (...args: unknown[]) => Promise<ImageBitmap>;
    bitmapControl.gate = new Promise<void>(resolve => { bitmapControl.release = resolve; });
    (window as unknown as { createImageBitmap: unknown }).createImageBitmap = async (...args: unknown[]) => { await bitmapControl.gate; return original(...args); };
  },
  releaseBitmaps: () => { bitmapControl.release?.(); },
  /** Counts the writes of project.json from now on (a manifest save). */
  spyProjectWrites: () => {
    if (projectWrites.length) return;
    projectWrites.push(0);
    const original = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = function (this: FileSystemFileHandle, ...args) { if (this.name === 'project.json') projectWrites[0] += 1; return original.apply(this, args); };
  },
  projectWrites: () => projectWrites[0] ?? 0,
  /** A project change that the autosave would write after its delay. */
  touch: () => useProjectStore.getState().updateBuildSession(session => ({ ...session, cursor: session.cursor + 1 })),
  documentViews: () => Object.keys(useDocumentStateStore.getState().documents),
  /** Pretends the editor of a view holds a document (the Photopea overlay does that once Photopea has loaded). */
  fakeDocument: (viewId: string) => { dropFake?.(); dropFake = useDocumentStateStore.getState().register(viewId, { dirty: false, check: async () => false }); },
  dropFakeDocument: () => { dropFake?.(); dropFake = undefined; },
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
