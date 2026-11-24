import React from 'react';
import { createRoot } from 'react-dom/client';
import NextApp from '../src/next/NextApp';
import { CommandProvider } from '../src/components/workspace/Commands';
import { InspectorProvider } from '../src/components/workspace/InspectorHost';
import { createProject, createSourceImage } from '../src/types';
import { createProjectDirectory, type ProjectDirectoryHandle } from '../src/services/project/projectDirectoryService';
import { forgetRecentProject, listRecentProjects, rememberRecentProject } from '../src/services/project/recentProjectsService';
import { toWorkspaceImages } from '../src/lib/workspaceImages';
import { useProjectStore } from '../src/stores/useProjectStore';
import { flushProjectSave } from '../src/hooks/useProjectSave';
import { useHistoryStore } from '../src/stores/useHistoryStore';
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

type Kind = 'sources' | 'grid' | 'big';
// Project-relative file paths per fixture kind. `emptyFolders` are created on disk without images.
const LAYOUTS: Record<Kind, { files: string[]; emptyFolders: string[] }> = {
  sources: { files: ['inbox/day1/a.png', 'inbox/day1/b.png', 'inbox/c.png', 'dataset/d.png'], emptyFolders: ['inbox/empty', 'inbox/other'] },
  grid: {
    files: ['dataset/in1.png', 'dataset/pin1.png', 'inbox/q1.png', 'inbox/dup1.png', 'inbox/ns1.png', 'inbox/ban1.png', 'inbox/new1.png'],
    emptyFolders: [],
  },
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
    const project = createProject(projectName, 'character');
    const sources = await Promise.all(layout.files.map(async (path, index) => {
      const source = createSourceImage(await png(index), nameOf(path), 8, 8);
      source.originalFilePath = path;
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
      records: Object.fromEntries(Object.values(state.buildSession.records).map(record => [nameOf(record.locator), { override: record.override, origin: record.origin, locator: record.locator }])),
    };
  },
  paths: () => {
    const state = useProjectStore.getState();
    return toWorkspaceImages(Object.values(state.sourceImages), Object.values(state.datasetItems)).map(item => item.assetPath);
  },
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
root.render(<React.StrictMode><CommandProvider><InspectorProvider><NextApp /></InspectorProvider></CommandProvider></React.StrictMode>);
import.meta.hot?.dispose(() => { root.unmount(); pickerWindow.showDirectoryPicker = originalPicker; });
