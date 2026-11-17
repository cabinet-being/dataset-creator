import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'rolldown';

// Character traits: grouping, applying to tag lists, normalization, project.json persistence and the quality report.
globalThis.Image = class {
  naturalWidth = 1;
  naturalHeight = 1;
  set src(_value) { queueMicrotask(() => this.onload?.()); }
};
globalThis.window ??= { setTimeout, clearTimeout, dispatchEvent: () => true, addEventListener() {}, removeEventListener() {} };

const temp = await mkdtemp(join(tmpdir(), 'character-traits-'));
try {
  await build({
    input: { traits: 'src/services/tagging/characterTraits.ts', metrics: 'src/services/quality/metrics/index.ts', directory: 'src/services/project/projectDirectoryService.ts', types: 'src/types/index.ts', store: 'src/stores/useProjectStore.ts', adapter: 'src/services/quality/datasetQualityInput.ts' },
    platform: 'node', logLevel: 'silent', output: { dir: temp, format: 'esm', entryFileNames: '[name].mjs', chunkFileNames: '[name]-[hash].mjs' },
  });
  const load = (name) => import(pathToFileURL(join(temp, `${name}.mjs`)));
  const { getTraitGroup, applyCharacterTraits, normalizeTraitTag, normalizeCharacterTraits } = await load('traits');
  const metrics = await load('metrics');
  const { createProjectDirectory, readProjectDirectory, writeProjectDirectoryChanges } = await load('directory');
  const { createProject } = await load('types');
  const { useProjectStore, selectActiveCharacterTraits } = await load('store');
  const { buildDatasetQualityInput } = await load('adapter');

  // 1. Groups.
  assert.equal(getTraitGroup('blue_eyes'), getTraitGroup('green_eyes'));
  assert.ok(getTraitGroup('blue_eyes'));
  assert.equal(getTraitGroup('closed_eyes'), undefined, 'closed_eyes is not a colour');
  assert.equal(getTraitGroup('red_hair'), getTraitGroup('blonde_hair'));
  assert.notEqual(getTraitGroup('red_hair'), getTraitGroup('blue_eyes'));
  assert.notEqual(getTraitGroup('long_hair'), getTraitGroup('red_hair'), 'length is not colour');
  assert.equal(getTraitGroup('long_hair'), getTraitGroup('short_hair'));
  assert.equal(getTraitGroup(' Blue Eyes '), getTraitGroup('blue_eyes'), 'input is normalized');
  assert.equal(getTraitGroup('smile'), undefined);

  // 2. Normalization.
  assert.equal(normalizeTraitTag('  Blue   Eyes '), 'blue_eyes');
  assert.deepEqual(normalizeCharacterTraits([{ tag: ' Blue Eyes ', mode: 'omit' }, { tag: 'blue_eyes', mode: 'include' }, { tag: '', mode: 'include' }, { tag: 5 }, null, { tag: 'Smile', mode: 'weird' }]),
    [{ tag: 'blue_eyes', mode: 'omit' }, { tag: 'smile', mode: 'include' }], 'case, spaces, duplicates, invalid entries, unknown mode');
  assert.deepEqual(normalizeCharacterTraits(undefined), []);
  assert.deepEqual(normalizeCharacterTraits('x'), []);

  // 3. applyCharacterTraits.
  assert.deepEqual(applyCharacterTraits(['a', 'b', 'a'], undefined), ['a', 'b'], 'no traits only dedupes');
  assert.deepEqual(applyCharacterTraits(['1girl', 'green_eyes', 'smile'], [{ tag: 'blue_eyes', mode: 'include' }]), ['1girl', 'smile', 'blue_eyes'], 'include replaces the conflicting group member and appends the trait');
  assert.deepEqual(applyCharacterTraits(['1girl', 'blue_eyes', 'smile'], [{ tag: 'blue_eyes', mode: 'include' }]), ['1girl', 'blue_eyes', 'smile'], 'present trait keeps its position, no duplicate');
  assert.deepEqual(applyCharacterTraits(['1girl', 'blue_eyes', 'green_eyes', 'smile'], [{ tag: 'blue_eyes', mode: 'omit' }]), ['1girl', 'smile'], 'omit removes the tag and the whole group');
  assert.deepEqual(applyCharacterTraits(['x', 'closed_eyes', 'smile'], [{ tag: 'blue_eyes', mode: 'include' }]), ['x', 'closed_eyes', 'smile', 'blue_eyes'], 'ungrouped tags are untouched');
  assert.deepEqual(applyCharacterTraits(['smile', 'x'], [{ tag: 'smile', mode: 'omit' }]), ['x'], 'ungrouped omit removes only the tag');
  assert.deepEqual(applyCharacterTraits(['a', 'smile', 'b'], [{ tag: 'smile', mode: 'include' }]), ['a', 'smile', 'b'], 'ungrouped include keeps order');
  assert.deepEqual(applyCharacterTraits(['long_hair', 'red_hair', 'brown_hair'], [{ tag: 'red_hair', mode: 'include' }]), ['long_hair', 'red_hair'], 'length group is independent of colour');
  assert.deepEqual(applyCharacterTraits(['Blue Eyes', 'a'], [{ tag: 'blue_eyes', mode: 'omit' }]), ['a'], 'matches case-insensitively');
  {
    const out = applyCharacterTraits(['a', 'green_eyes', 'b', 'a'], [{ tag: 'blue_eyes', mode: 'include' }, { tag: 'blue_eyes', mode: 'include' }]);
    assert.equal(new Set(out).size, out.length, 'no duplicates');
  }

  // 4. Persistence in project.json (in-memory File System Access handles).
  const directory = (name = 'root') => {
    const entries = new Map();
    return {
      name, entries: async function* () { yield* entries; },
      async getDirectoryHandle(child, options) {
        if (!entries.has(child) && options?.create) entries.set(child, directory(child));
        if (!entries.has(child)) throw new DOMException('Missing', 'NotFoundError');
        if (!('entries' in entries.get(child))) throw new DOMException('Not a directory', 'TypeMismatchError');
        return entries.get(child);
      },
      async getFileHandle(child, options) {
        if (!entries.has(child) && options?.create) {
          let contents = '';
          entries.set(child, { name: child, getFile: async () => new File([contents], child), createWritable: async () => ({ write: async (data) => { contents = data; }, close: async () => {} }) });
        }
        if (!entries.has(child)) throw new DOMException('Missing', 'NotFoundError');
        if ('entries' in entries.get(child)) throw new DOMException('Not a file', 'TypeMismatchError');
        return entries.get(child);
      },
      async removeEntry(child) { entries.delete(child); },
    };
  };
  const manifestOf = async (root) => JSON.parse(await (await (await root.getDirectoryHandle('.datasetcreator')).getFileHandle('project.json')).getFile().then((file) => file.text()));
  {
    const plain = directory('plain');
    await createProjectDirectory(plain, createProject('Plain', 'character'));
    assert.equal('characterTraits' in (await manifestOf(plain)).project, false, 'no traits, no field');
    assert.deepEqual((await readProjectDirectory(plain)).characterTraits, [], 'missing field reads as []');

    const traits = [{ tag: 'blue_eyes', mode: 'include' }, { tag: 'long_hair', mode: 'omit' }];
    const withTraits = directory('with');
    const project = { ...createProject('With', 'character'), characterTraits: traits };
    await createProjectDirectory(withTraits, project);
    assert.deepEqual((await manifestOf(withTraits)).project.characterTraits, traits);
    assert.deepEqual((await readProjectDirectory(withTraits)).characterTraits, traits, 'round trip');

    const cleared = { ...project, characterTraits: [] };
    await writeProjectDirectoryChanges(cleared, project, withTraits);
    assert.equal('characterTraits' in (await manifestOf(withTraits)).project, false, 'emptied traits drop the field');
    assert.deepEqual((await readProjectDirectory(withTraits)).characterTraits, []);
  }

  // 5. Store: traits apply only to character projects.
  {
    useProjectStore.getState().loadProject(createProject('Store', 'character'));
    useProjectStore.getState().setCharacterTraits([{ tag: ' Blue Eyes ', mode: 'include' }, { tag: 'blue_eyes', mode: 'omit' }]);
    assert.deepEqual(selectActiveCharacterTraits(useProjectStore.getState()), [{ tag: 'blue_eyes', mode: 'include' }]);
    useProjectStore.getState().loadProject({ ...createProject('Style', 'style'), characterTraits: [{ tag: 'blue_eyes', mode: 'include' }] });
    assert.deepEqual(selectActiveCharacterTraits(useProjectStore.getState()), [], 'non-character project ignores traits');
  }

  // 6. Quality: trait tags are not constant tags.
  {
    const items = Array.from({ length: 10 }, (_, index) => ({ id: `i${index}`, tags: ['hero', 'blue_eyes', 'solo', `u${index}`] }));
    const without = metrics.measureCommonTags(items, 'hero');
    assert.deepEqual([...without.action.tags].sort(), ['blue_eyes', 'solo']);
    const withTrait = metrics.measureCommonTags(items, 'hero', undefined, ['BLUE_EYES']);
    assert.deepEqual([...withTrait.action.tags], ['solo'], 'trait tag is excluded, case-insensitively');
    const spaced = Array.from({ length: 10 }, (_, index) => ({ id: `s${index}`, tags: ['hero', 'blue eyes', 'solo', `u${index}`] }));
    assert.deepEqual([...metrics.measureCommonTags(spaced, 'hero', undefined, ['blue_eyes']).action.tags], ['solo'], 'a trait matches captions that spell it with spaces');
    const report = metrics.buildQualityReport({ items, projectType: 'character', triggerWord: 'hero', characterTraitTags: ['blue_eyes', 'solo'] });
    assert.equal(report.insights.find((metric) => metric.id === 'common-tags').value, 0);
    assert.equal(report.hints.find((hint) => hint.id === 'common-tags-prune'), undefined);
    const input = buildDatasetQualityInput({ items: [], triggerWord: 'hero', projectType: 'character', characterTraits: [{ tag: 'blue_eyes', mode: 'omit' }] });
    assert.deepEqual(input.characterTraitTags, ['blue_eyes'], 'adapter passes trait tags');
    assert.equal('characterTraitTags' in buildDatasetQualityInput({ items: [], triggerWord: 'hero' }), false);
  }
  console.log('character traits checks passed');
} finally {
  await rm(temp, { recursive: true, force: true });
}
