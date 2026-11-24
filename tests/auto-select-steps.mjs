import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'rolldown';

const temp = await mkdtemp(join(tmpdir(), 'auto-select-steps-'));
try {
  await build({
    input: ['src/lib/autoSelectSteps.ts', 'src/lib/inboxFolders.ts'],
    platform: 'node',
    output: { dir: temp, format: 'esm', entryFileNames: '[name].mjs', chunkFileNames: '[name]-[hash].mjs' },
  });
  const { getAutoSelectSteps } = await import(pathToFileURL(join(temp, 'autoSelectSteps.mjs')));
  const folders = await import(pathToFileURL(join(temp, 'inboxFolders.mjs')));

  const base = {
    folderImages: 9, analyzed: 9, pendingAnalysis: 0, analysisPaused: false, poolSize: 6, datasetCount: 0, target: 3,
    hasCandidates: false, candidates: 0, described: 0, taggable: 0, picks: 0, duplicatesSkipped: 0, unreadable: 0,
    taskRunning: false, task: null,
  };
  const steps = (patch = {}) => {
    const result = getAutoSelectSteps({ ...base, ...patch });
    return { ...result, by: Object.fromEntries(result.steps.map((step) => [step.id, step])) };
  };
  const withCandidates = { hasCandidates: true, candidates: 4, taggable: 4 };

  // Fresh start: only Find is ready.
  let result = steps();
  assert.deepEqual(result.steps.map((step) => step.id), ['sources', 'find', 'describe', 'pick']);
  assert.equal(result.needed, 3);
  assert.equal(result.by.sources.state, 'done');
  assert.equal(result.by.find.state, 'ready');
  assert.equal(result.by.find.reason, undefined);
  assert.equal(result.by.describe.state, 'locked');
  assert.equal(result.by.describe.reason, 'Find candidates first');
  assert.equal(result.by.pick.state, 'locked');
  assert.equal(result.by.pick.reason, 'Find candidates first');

  // Find locked reasons.
  result = steps({ folderImages: 0, analyzed: 0, poolSize: 0 });
  assert.equal(result.by.sources.state, 'ready');
  assert.equal(result.by.sources.reason, 'No images in the selected folders');
  assert.equal(result.by.find.state, 'locked');
  assert.equal(result.by.find.reason, 'No images in the selected folders');
  result = steps({ pendingAnalysis: 4, analyzed: 5 });
  assert.equal(result.by.find.state, 'locked');
  assert.equal(result.by.find.reason, 'Waiting for quality analysis (4 left)');
  result = steps({ datasetCount: 3 });
  assert.equal(result.needed, 0);
  assert.equal(result.by.find.state, 'locked');
  assert.match(result.by.find.reason, /already has 3 of 3/);
  result = steps({ taskRunning: true });
  assert.equal(result.by.find.state, 'locked');
  assert.equal(result.by.find.reason, 'Another task is running');
  result = steps({ poolSize: 0 });
  assert.equal(result.by.find.state, 'locked');
  assert.equal(result.by.find.reason, 'No usable images in the selected folders');
  // Target reached is reported before the busy state; datasetCount above target never goes negative.
  result = steps({ datasetCount: 5, taskRunning: true });
  assert.equal(result.needed, 0);
  assert.match(result.by.find.reason, /already has 5 of 3/);

  // Running find.
  result = steps({ taskRunning: true, task: 'find' });
  assert.equal(result.by.find.state, 'running');

  // Candidates found: find done, describe ready, pick locked until described.
  result = steps({ ...withCandidates, duplicatesSkipped: 2, unreadable: 1 });
  assert.equal(result.by.find.state, 'done');
  assert.deepEqual(result.by.find.counts, { found: 4, duplicates: 2, unreadable: 1, pool: 6, needed: 3 });
  assert.equal(result.by.describe.state, 'ready');
  assert.equal(result.undescribed, 4);
  assert.equal(result.by.pick.state, 'locked');
  assert.equal(result.by.pick.reason, 'Describe candidates first');
  assert.equal(result.pickCount, 3);

  // Another task blocks describe and pick.
  result = steps({ ...withCandidates, described: 2, taskRunning: true, task: null });
  assert.equal(result.by.describe.state, 'locked');
  assert.equal(result.by.describe.reason, 'Another task is running');
  assert.equal(result.by.pick.state, 'locked');
  assert.equal(result.by.pick.reason, 'Another task is running');
  result = steps({ ...withCandidates, taskRunning: true, task: 'describe' });
  assert.equal(result.by.describe.state, 'running');

  // Partially described: pick ready with a warning reason.
  result = steps({ ...withCandidates, described: 3 });
  assert.equal(result.by.describe.state, 'ready');
  assert.equal(result.by.pick.state, 'ready');
  assert.match(result.by.pick.reason, /^1 candidate has no tags/);
  result = steps({ ...withCandidates, described: 2 });
  assert.match(result.by.pick.reason, /^2 candidates have no tags/);

  // Fully described: describe done, pick ready without a reason, pickCount capped by candidates.
  result = steps({ ...withCandidates, described: 4 });
  assert.equal(result.by.describe.state, 'done');
  assert.equal(result.by.pick.state, 'ready');
  assert.equal(result.by.pick.reason, undefined);
  assert.equal(steps({ ...withCandidates, candidates: 2, described: 2, target: 10 }).pickCount, 2);
  // Nothing taggable also counts as describe done.
  assert.equal(steps({ ...withCandidates, taggable: 0 }).by.describe.state, 'done');

  // Picks made and apply running.
  result = steps({ ...withCandidates, described: 4, picks: 3 });
  assert.equal(result.by.pick.state, 'done');
  assert.equal(steps({ ...withCandidates, described: 4, picks: 3, taskRunning: true, task: 'pick' }).by.pick.state, 'running');
  assert.equal(steps({ ...withCandidates, described: 4, picks: 3, taskRunning: true, task: 'apply' }).by.pick.state, 'running');

  // Target reached with candidates left.
  result = steps({ ...withCandidates, described: 4, datasetCount: 3 });
  assert.equal(result.by.pick.state, 'locked');
  assert.equal(result.by.pick.reason, 'Target reached');
  assert.equal(result.pickCount, 0);

  // All candidates decided by hand: the list is exhausted, so everything reads done, not "0 of N".
  result = steps({ hasCandidates: true, candidates: 0, described: 0, taggable: 0 });
  assert.equal(result.by.find.state, 'done');
  assert.equal(result.by.describe.state, 'done');
  assert.equal(result.by.pick.state, 'done');
  assert.equal(result.undescribed, 0);
  assert.equal(result.pickCount, 0);

  // Auto mode: no target, so nothing is blocked by it.
  {
    const auto = (patch = {}) => steps({ auto: true, ...patch });
    let r = auto();
    assert.equal(r.needed, 0);
    assert.equal(r.by.find.state, 'ready');
    assert.equal(r.by.find.reason, undefined);
    r = auto({ datasetCount: 500, target: 3 });
    assert.equal(r.by.find.state, 'ready', 'a Dataset above the target never blocks Find in Auto');
    // The other Find locks still apply.
    assert.equal(auto({ folderImages: 0, analyzed: 0, poolSize: 0 }).by.find.reason, 'No images in the selected folders');
    assert.equal(auto({ pendingAnalysis: 2 }).by.find.reason, 'Waiting for quality analysis (2 left)');
    assert.equal(auto({ taskRunning: true }).by.find.reason, 'Another task is running');
    assert.equal(auto({ poolSize: 0 }).by.find.reason, 'No usable images in the selected folders');
    // Pick takes every candidate and does not need Describe.
    r = auto({ ...withCandidates });
    assert.equal(r.pickCount, 4);
    assert.equal(r.by.describe.state, 'ready');
    assert.equal(r.by.pick.state, 'ready');
    assert.match(r.by.pick.reason, /compared by appearance only/, 'undescribed candidates only produce a hint');
    assert.equal(auto({ ...withCandidates, described: 4 }).by.pick.reason, undefined);
    assert.equal(r.undescribed, 4);
    r = auto({ ...withCandidates, datasetCount: 500, target: 3 });
    assert.equal(r.by.pick.state, 'ready', 'no "Target reached" lock in Auto');
    assert.equal(r.pickCount, 4);
    assert.equal(auto({ ...withCandidates, taskRunning: true, task: 'find' }).by.pick.reason, 'Another task is running');
    assert.equal(auto({ ...withCandidates, picks: 3 }).by.pick.state, 'done');
    assert.equal(auto({ ...withCandidates, picks: 3, taskRunning: true, task: 'apply' }).by.pick.state, 'running');
    assert.equal(auto({ hasCandidates: true, candidates: 0 }).by.pick.state, 'done');
    assert.equal(auto().by.pick.reason, 'Find candidates first');
    // Target mode is unchanged when `auto` is false or absent.
    assert.equal(steps({ auto: false, datasetCount: 3 }).by.find.state, 'locked');
    assert.equal(steps({ ...withCandidates, described: 0 }).by.pick.reason, 'Describe candidates first');
  }

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
  console.log('Auto-select steps and inbox folder checks passed.');
} finally {
  await rm(temp, { recursive: true, force: true });
}
