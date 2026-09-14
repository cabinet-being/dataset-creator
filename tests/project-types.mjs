import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'rolldown';
import JSZip from 'jszip';

const temp = await mkdtemp(join(tmpdir(), 'project-types-'));
try {
  await build({ input: ['src/types/index.ts', 'src/lib/projectProfiles.ts', 'src/services/project/projectDirectoryService.ts', 'src/services/project/projectFileService.ts', 'src/stores/useProjectStore.ts'], platform: 'node', output: { dir: temp, format: 'esm', entryFileNames: '[name].mjs', chunkFileNames: '[name]-[hash].mjs' } });
  const { createProject } = await import(pathToFileURL(join(temp, 'index.mjs')));
  const { resolveProjectType, PROJECT_TYPE_PROFILES } = await import(pathToFileURL(join(temp, 'projectProfiles.mjs')));
  const { createProjectDirectory, readProjectDirectory } = await import(pathToFileURL(join(temp, 'projectDirectoryService.mjs')));
  const { createProjectFileBlob, readProjectFile } = await import(pathToFileURL(join(temp, 'projectFileService.mjs')));
  const { useProjectStore } = await import(pathToFileURL(join(temp, 'useProjectStore.mjs')));
  // In-memory File System Access handles exercise the real directory serializer and reader.
  function directory(name = 'test') {
    const entries = new Map();
    return {
      name, entries: async function* () { yield* entries; },
      async getDirectoryHandle(name, options) {
        if (!entries.has(name) && options?.create) entries.set(name, directory(name));
        if (!entries.has(name)) throw new DOMException('Missing', 'NotFoundError');
        return entries.get(name);
      },
      async getFileHandle(name, options) {
        if (!entries.has(name) && options?.create) {
          let contents = '';
          entries.set(name, { name, getFile: async () => new File([contents], name), createWritable: async () => ({ write: async (data) => { contents = data; }, close: async () => {} }) });
        }
        if (!entries.has(name)) throw new DOMException('Missing', 'NotFoundError');
        return entries.get(name);
      },
      async removeEntry(name) { entries.delete(name); },
    };
  }
  const readManifest = async (dir) => JSON.parse(await (await (await dir.getFileHandle('manifest.json')).getFile()).text());
  const writeManifest = async (dir, manifest) => {
    const stream = await (await dir.getFileHandle('manifest.json')).createWritable();
    await stream.write(JSON.stringify(manifest)); await stream.close();
  };
  for (const type of ['character', 'style', 'concept']) {
    const project = createProject(`Test ${type}`, type);
    assert.equal(project.projectType, type);
    useProjectStore.getState().initializeProject('Store test', type);
    assert.equal(useProjectStore.getState().projectType, type);
    const dataset = useProjectStore.getState().createDataset();
    assert.equal(dataset.name, PROJECT_TYPE_PROFILES[type].defaults.datasetName);
    assert.equal(dataset.triggerWord, PROJECT_TYPE_PROFILES[type].defaults.triggerWord);
    useProjectStore.getState().loadProject(project);
    assert.equal(useProjectStore.getState().projectType, type);
    assert.equal(project.taggingConfig.datasetKeyword, PROJECT_TYPE_PROFILES[type].defaults.datasetKeyword);
    assert.equal(PROJECT_TYPE_PROFILES[type].enabledTools.length, 8);
    const dir = directory();
    await createProjectDirectory(dir, project);
    assert.equal((await readManifest(dir)).project.projectType, type);
    assert.equal((await readProjectDirectory(dir)).projectType, type);
    const blob = await createProjectFileBlob(project);
    const bytes = await blob.arrayBuffer(); // JSZip's Node adapter accepts buffers, browser adapter accepts Files.
    const zip = await JSZip.loadAsync(bytes);
    assert.equal(JSON.parse(await zip.file('manifest.json').async('string')).project.projectType, type);
    assert.equal((await readProjectFile(bytes)).projectType, type);
  }
  const dir = directory();
  await createProjectDirectory(dir, createProject('Legacy', 'character'));
  const legacy = await readManifest(dir);
  delete legacy.project.projectType;
  legacy.project.customMetadata = { preserved: true };
  await writeManifest(dir, legacy);
  await assert.rejects(readProjectDirectory(dir), /selection/);
  await assert.rejects(readProjectDirectory(dir, async () => { throw new DOMException('Canceled', 'AbortError'); }), /Canceled/);
  assert.equal((await readManifest(dir)).project.projectType, undefined);
  let selections = 0;
  assert.equal((await readProjectDirectory(dir, async () => { selections++; return 'style'; })).projectType, 'style');
  await readProjectDirectory(dir, async () => { selections++; return 'concept'; });
  assert.equal(selections, 1);
  assert.deepEqual((await readManifest(dir)).project.customMetadata, { preserved: true });
  const zip = await JSZip.loadAsync(await (await createProjectFileBlob(createProject('Legacy zip', 'character'))).arrayBuffer());
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  delete manifest.project.projectType;
  zip.file('manifest.json', JSON.stringify(manifest));
  zip.file('unrelated.txt', 'preserve me');
  let bytes = await zip.generateAsync({ type: 'uint8array' });
  let saved;
  const handle = { createWritable: async () => ({ write: async (blob) => { saved = await blob.arrayBuffer(); }, close: async () => {} }) };
  await assert.rejects(readProjectFile(bytes, { selectProjectType: async () => 'concept' }), /writable/);
  await assert.rejects(readProjectFile(bytes, { selectProjectType: async () => 'concept', handle: { createWritable: async () => { throw new Error('Write denied'); } } }), /Write denied/);
  assert.equal((await readProjectFile(bytes, { handle, selectProjectType: async () => 'concept' })).projectType, 'concept');
  assert.equal((await readProjectFile(saved)).projectType, 'concept');
  assert.equal(await (await JSZip.loadAsync(saved)).file('unrelated.txt').async('string'), 'preserve me');
  await assert.rejects(resolveProjectType('invalid', 'Invalid'), /Unsupported/);
  await assert.rejects(resolveProjectType(null, 'Invalid'), /Unsupported/);
  console.log('PASS: all three types round-trip through directory and ZIP manifests; legacy selection, cancellation, one-time persistence, metadata preservation, and invalid types.');
} finally { await rm(temp, { recursive: true, force: true }); }
