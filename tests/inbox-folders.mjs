import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'rolldown';

const temp = await mkdtemp(join(tmpdir(), 'inbox-folders-'));
try {
  await build({
    input: ['src/lib/inboxFolders.ts'],
    platform: 'node',
    output: { dir: temp, format: 'esm', entryFileNames: '[name].mjs', chunkFileNames: '[name]-[hash].mjs' },
  });
  const folders = await import(pathToFileURL(join(temp, 'inboxFolders.mjs')));

  // inboxFolders helpers.
  const item = (assetPath) => ({ assetPath });
  assert.equal(folders.INBOX_PREFIX.startsWith('Project/'), true);
  assert.equal(folders.inboxFolderOf(item('Project/inbox/day1/a.png')), 'inbox/day1');
  assert.equal(folders.inboxFolderOf(item('Project/inbox/a.png')), 'inbox');
  assert.equal(folders.inboxFolderOf({}), '');
  assert.equal(folders.isInboxItem(item(`${folders.INBOX_PREFIX}a.png`)), true);
  assert.equal(folders.isInboxItem(item('Project/dataset/a.png')), false);
  assert.equal(folders.isInboxItem({}), false);
  assert.equal(folders.isInFolder('inbox', 'inbox'), true);
  assert.equal(folders.isInFolder('inbox', 'inbox/day1'), true);
  assert.equal(folders.isInFolder('inbox', 'inbox2'), false);

  const rows = folders.buildFolderRows(['inbox', 'inbox/b/c', 'inbox/b/c', 'inbox/a']);
  assert.deepEqual(rows.map((row) => [row.path, row.name, row.depth, row.count]), [
    ['inbox', 'inbox', 0, 4], ['inbox/a', 'a', 1, 1], ['inbox/b', 'b', 1, 2], ['inbox/b/c', 'c', 2, 2],
  ]);
  assert.deepEqual(folders.buildFolderRows([]), []);
  assert.deepEqual(folders.buildFolderRows(['inbox/d10', 'inbox/d2']).map((row) => row.name), ['inbox', 'd2', 'd10']);

  // Toggle: all checked -> unchecked family; any unchecked -> everything checked.
  let off = folders.toggleFolderSelection(rows, new Set(), 'inbox/b');
  assert.deepEqual([...off].sort(), ['inbox/b', 'inbox/b/c']);
  off = folders.toggleFolderSelection(rows, off, 'inbox/b');
  assert.equal(off.size, 0);
  off = folders.toggleFolderSelection(rows, new Set(['inbox/b/c']), 'inbox/b');
  assert.equal(off.size, 0);
  const original = new Set();
  folders.toggleFolderSelection(rows, original, 'inbox');
  assert.equal(original.size, 0, 'input set is not mutated');
  assert.equal(folders.toggleFolderSelection(rows, new Set(), 'inbox').size, 4);

  assert.equal(folders.isInboxItemSelected(item('Project/inbox/a/x.png'), new Set()), true);
  assert.equal(folders.isInboxItemSelected(item('Project/inbox/a/x.png'), new Set(['inbox/a'])), false);
  assert.equal(folders.isInboxItemSelected(item('Project/inbox/a/x.png'), new Set(['inbox'])), true);

  // Build Sources helpers.
  assert.equal(folders.inboxFolderOfPath('Project/inbox/day1/a.png'), 'Project/inbox/day1');
  assert.equal(folders.inboxFolderOfPath('Project/inbox/a.png'), 'Project/inbox');
  assert.equal(folders.inboxFolderOfPath('inbox/day1/deep/a.png'), 'Project/inbox/day1/deep', 'the Project/ prefix is optional');
  assert.equal(folders.inboxFolderOfPath('./inbox/a.png'), 'Project/inbox');
  assert.equal(folders.inboxFolderOfPath('Project\\inbox\\day1\\a.png'), 'Project/inbox/day1', 'backslashes are normalised');
  for (const outside of ['Project/dataset/a.png', 'Project/inbox2/a.png', 'Project/other/inbox/a.png', '', undefined]) assert.equal(folders.inboxFolderOfPath(outside), undefined, `${outside} is outside the inbox`);

  assert.equal(folders.isInboxFolderInSources('Project/inbox/a', undefined), true, 'no sources means the whole inbox');
  assert.equal(folders.isInboxFolderInSources('inbox/new', undefined), true);
  assert.equal(folders.isInboxFolderInSources('Project/inbox/a', []), false, 'an empty list selects nothing');
  assert.equal(folders.isInboxFolderInSources('Project/inbox/b/c', ['Project/inbox/b']), true, 'a listed ancestor selects subfolders');
  assert.equal(folders.isInboxFolderInSources('inbox/b/c', ['inbox/b']), true, 'explorer paths with or without Project/ are equal');
  assert.equal(folders.isInboxFolderInSources('Project/inbox/bb', ['Project/inbox/b']), false, 'a sibling with the same prefix is not selected');
  assert.equal(folders.isInboxFolderInSources('Project/inbox', ['Project/inbox/b']), false, 'a parent is not selected by its child');
  const inboxItem = (path) => ({ assetPath: path });
  assert.equal(folders.isInboxItemInSources(inboxItem('Project/inbox/a/x.png'), undefined), true);
  assert.equal(folders.isInboxItemInSources(inboxItem('Project/inbox/a/x.png'), ['Project/inbox/a']), true);
  assert.equal(folders.isInboxItemInSources(inboxItem('Project/inbox/b/x.png'), ['Project/inbox/a']), false);
  assert.equal(folders.isInboxItemInSources(inboxItem('Project/inbox/x.png'), ['Project/inbox/a']), false, 'an image in the inbox root is not in a subfolder');
  assert.equal(folders.isInboxItemInSources(inboxItem('Project/inbox/x.png'), ['Project/inbox']), true);
  assert.equal(folders.isInboxItemInSources(inboxItem('Project/dataset/x.png'), ['Project/inbox']), false, 'outside the inbox is never in sources');
  // A folder created after sources were chosen is not selected; without sources it is.
  assert.equal(folders.isInboxItemInSources(inboxItem('Project/inbox/new/x.png'), ['Project/inbox/a', 'Project/inbox/b']), false);
  assert.equal(folders.isInboxItemInSources(inboxItem('Project/inbox/new/x.png'), undefined), true);

  const srcRows = folders.buildFolderRows(['inbox', 'inbox/a', 'inbox/b/c']);
  const sourcesOnly = ['Project/inbox/a'];
  let toggled = folders.toggleSourceFolder(srcRows, undefined, 'inbox/a');
  assert.deepEqual(toggled, ['Project/inbox/b'], 'unchecking a folder from "all" lists the remaining topmost folders (root images drop out)');
  toggled = folders.toggleSourceFolder(srcRows, toggled, 'inbox/a');
  assert.deepEqual(toggled, ['Project/inbox/a', 'Project/inbox/b'], 'checking it again adds it');
  assert.deepEqual(folders.toggleSourceFolder(srcRows, undefined, 'inbox'), [], 'unchecking the root clears everything');
  assert.deepEqual(folders.toggleSourceFolder(srcRows, [], 'inbox'), ['Project/inbox'], 'checking the root selects everything as one folder');
  assert.deepEqual(folders.toggleSourceFolder(srcRows, sourcesOnly, 'Project/inbox/b'), ['Project/inbox/a', 'Project/inbox/b'], 'subfolders follow their parent');
  assert.deepEqual(folders.toggleSourceFolder(srcRows, ['Project/inbox/b'], 'inbox/b/c'), [], 'unchecking the only child of a selected parent unselects the parent too');
  assert.deepEqual(folders.toggleSourceFolder(srcRows, ['Project/inbox/a', 'Project/inbox/b'], 'Project/inbox/b'), ['Project/inbox/a'], 'unchecking a parent unchecks its subfolders');
  assert.deepEqual(sourcesOnly, ['Project/inbox/a'], 'input list is not mutated');
  // A folder missing from rows (created later) stays unselected when another folder is toggled.
  const withNew = folders.buildFolderRows(['inbox', 'inbox/a', 'inbox/b/c', 'inbox/new']);
  assert.deepEqual(folders.toggleSourceFolder(withNew, ['Project/inbox/a'], 'inbox/b'), ['Project/inbox/a', 'Project/inbox/b'], 'the new folder is not selected');
  // Next UI Sources panel: folders of the Explorer tree (including empty ones) and the per-folder counts.
  {
    const dir = (path, children = []) => ({ path, kind: 'folder', children });
    const file = (path) => ({ path, kind: 'file' });
    const tree = dir('Project', [
      dir('Project/inbox', [dir('Project/inbox/day1', [file('Project/inbox/day1/a.png')]), dir('Project/inbox/empty'), dir('Project/inbox/day1b'), file('Project/inbox/root.png')]),
      dir('Project/dataset', [dir('Project/dataset/sub')]),
      dir('Project/inbox-old'),
    ]);
    assert.deepEqual(folders.collectInboxFolders(tree), ['inbox', 'inbox/day1', 'inbox/empty', 'inbox/day1b'],
      'inbox, its subfolders and empty folders; dataset/ and inbox-old are not inbox folders; files are skipped');
    assert.deepEqual(folders.collectInboxFolders(null), []);
    assert.deepEqual(folders.collectInboxFolders(undefined), []);
    assert.deepEqual(folders.collectInboxFolders(dir('Project')), [], 'a project without inbox has no inbox folders');
    assert.deepEqual(folders.collectInboxFolders({ path: 'Project/inbox', kind: 'file' }), [], 'a file named inbox is not a folder');

    const img = (path, extra = {}) => ({ id: path, assetPath: path, fileName: path.split('/').pop(), kind: 'image', ...extra });
    const items = [
      img('Project/inbox/day1/a.png'), img('Project/inbox/day1/b.png'), img('Project/inbox/root.png'),
      img('Project/inbox/clip.mp4', { kind: 'video' }), img('Project/dataset/d.png'), img('Project/dataset/clip2.mp4', { kind: 'video' }),
    ];
    const counted = folders.countInboxFolders(items, ['inbox', 'inbox/day1', 'inbox/empty']);
    assert.deepEqual(counted.rows.map(({ path, count, depth }) => [path, count, depth]), [['inbox', 3, 0], ['inbox/day1', 2, 1], ['inbox/empty', 0, 1]],
      'empty folders get a row with count 0; the root count includes subfolders; videos are not counted');
    assert.equal(counted.inbox, 3); assert.equal(counted.dataset, 1, 'dataset counts images only');
    assert.equal(counted.ticked, 3, 'undefined sources tick the whole inbox');
    assert.equal(folders.countInboxFolders(items, [], []).ticked, 0, 'an empty sources list ticks nothing');
    assert.equal(folders.countInboxFolders(items, [], ['Project/inbox/day1']).ticked, 2, 'only images of ticked folders');
    assert.equal(folders.countInboxFolders(items, [], ['Project/inbox']).ticked, 3);
    const noEmpty = folders.countInboxFolders(items);
    assert.deepEqual(noEmpty.rows.map((row) => row.path), ['inbox', 'inbox/day1'], 'without the tree only folders with images appear');
    const onlyEmpty = folders.countInboxFolders([], ['inbox', 'inbox/new']);
    assert.deepEqual(onlyEmpty.rows.map(({ path, count }) => [path, count]), [['inbox', 0], ['inbox/new', 0]]);
    assert.deepEqual([onlyEmpty.inbox, onlyEmpty.dataset, onlyEmpty.ticked], [0, 0, 0]);
    const deep = folders.countInboxFolders([img('Project/inbox/a/b/c.png')], []);
    assert.deepEqual(deep.rows.map(({ path, count }) => [path, count]), [['inbox', 1], ['inbox/a', 1], ['inbox/a/b', 1]], 'ancestors of an image folder get rows');
  }
  console.log('Inbox folder checks passed.');
} finally {
  await rm(temp, { recursive: true, force: true });
}
