import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'rolldown';

const temp = await mkdtemp(join(tmpdir(), 'state-recovery-'));
after(() => rm(temp, { recursive: true, force: true }));
await build({
  input: ['src/services/project/saveQueue.ts', 'src/services/project/saveSession.ts', 'src/stores/useOperationStore.ts', 'src/stores/useHistoryStore.ts', 'src/stores/useProjectStore.ts'],
  platform: 'node', output: { dir: temp, format: 'esm', entryFileNames: '[name].mjs' },
});
const load = name => import(pathToFileURL(join(temp, `${name}.mjs`)));
const { createSaveQueue } = await load('saveQueue');
const { createSaveSession } = await load('saveSession');
const { useOperationStore } = await load('useOperationStore');
const { useHistoryStore } = await load('useHistoryStore');
const { useProjectStore } = await load('useProjectStore');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const observable = initial => {
  let value = initial; const listeners = new Set();
  return { get: () => value, set: next => { value = next; for (const listener of listeners) listener(next); },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, listeners };
};

test('failed pre-save prevents file mutation and the exclusive lane recovers on retry', async () => {
  let fail = true; const events = [];
  const queue = createSaveQueue(0, async (value, previous) => {
    events.push(['save', value, previous]); if (fail) throw new Error('Disk full');
  }, () => {});
  queue.enqueue(1);
  await assert.rejects(queue.runExclusive(async () => events.push(['mutation'])), /Disk full/);
  assert.deepEqual(events, [['save', 1, 0]]);
  assert.equal(queue.isDirty(), true);
  fail = false;
  assert.equal(await queue.runExclusive(async () => { events.push(['mutation']); queue.enqueue(2); return 'done'; }), 'done');
  assert.deepEqual(events, [['save', 1, 0], ['save', 1, 0], ['mutation'], ['save', 2, 1]]);
  assert.equal(queue.isDirty(), false);
});

test('stopping during a save prevents queued file operations and suppresses stale status', async () => {
  const gate = deferred(); const states = []; const writes = [];
  const queue = createSaveQueue(0, async value => { writes.push(value); await gate.promise; }, state => states.push(state.status));
  queue.enqueue(1); const saving = queue.flush();
  const mutation = queue.runExclusive(async () => assert.fail('Stopped project must not mutate files'));
  const rejected = assert.rejects(mutation, /project changed/);
  queue.enqueue(2); queue.stop(); const count = states.length;
  gate.resolve(); await saving; await rejected;
  assert.deepEqual(writes, [1]); assert.equal(states.length, count);
});

test('save session flush cancels debounce and disposal removes both subscriptions', async () => {
  const project = observable({ id: 'a', version: 0 }); const directory = observable({ name: 'folder' });
  const writes = [];
  const session = createSaveSession({ getProject: project.get, subscribeProject: project.subscribe,
    getDirectory: directory.get, subscribeDirectory: directory.subscribe,
    write: async (next, previous, target) => writes.push([next.version, previous.version, target.name]), changed() {}, delay: 60_000 });
  try {
    project.set({ id: 'a', version: 1 }); project.set({ id: 'a', version: 2 });
    directory.set(directory.get());
    assert.equal(project.listeners.size, 1);
    assert.equal(session.isDirty(), true); await session.flush();
    assert.deepEqual(writes, [[2, 0, 'folder']]); assert.equal(session.isDirty(), false);
    project.set({ id: 'a', version: 3 });
  } finally { session.dispose(); }
  assert.equal(project.listeners.size, 0); assert.equal(directory.listeners.size, 0);
  await session.flush(); assert.equal(writes.length, 1);
});

test('operation retention preserves active work and only the nine latest finished entries', () => {
  useOperationStore.setState({ entries: [] });
  const store = useOperationStore.getState();
  store.start({ id: 'active', viewId: 'import', label: 'Active' });
  for (let i = 0; i < 15; i++) {
    store.start({ id: String(i), viewId: 'export', label: String(i) }); store.finish(String(i), 'completed');
  }
  store.start({ id: 'new', viewId: 'import', label: 'New' });
  assert.deepEqual(useOperationStore.getState().entries.map(entry => entry.id), ['active', '6', '7', '8', '9', '10', '11', '12', '13', '14', 'new']);
  store.start({ id: 'new', viewId: 'import', label: 'Restarted' });
  assert.equal(useOperationStore.getState().entries.filter(entry => entry.id === 'new').length, 1);
  store.dismiss('active'); assert.ok(useOperationStore.getState().entries.some(entry => entry.id === 'active'));
  store.finish('new', 'failed', 'Permission denied'); store.update('new', { message: 'stale progress' });
  assert.equal(useOperationStore.getState().entries.at(-1).message, 'Permission denied');
  useOperationStore.setState({ entries: [] });
});

function resetHistory() {
  useProjectStore.setState({ id: 'history-recovery' });
  useHistoryStore.setState({ past: [], future: [], busy: false });
}

test('failed undo and redo retain the entry, release busy and allow retry', async () => {
  resetHistory(); let failUndo = true; let failRedo = true; let value = 1;
  useHistoryStore.getState().push({ label: 'Edit', undo: () => { if (failUndo) throw new Error('Undo failed'); value = 0; },
    redo: () => { if (failRedo) throw new Error('Redo failed'); value = 1; } });
  await assert.rejects(useHistoryStore.getState().undo(), /Undo failed/);
  assert.equal(useHistoryStore.getState().past.length, 1); assert.equal(useHistoryStore.getState().busy, false);
  failUndo = false; await useHistoryStore.getState().undo(); assert.equal(value, 0);
  await assert.rejects(useHistoryStore.getState().redo(), /Redo failed/);
  assert.equal(useHistoryStore.getState().future.length, 1); assert.equal(useHistoryStore.getState().busy, false);
  failRedo = false; await useHistoryStore.getState().redo(); assert.equal(value, 1);
  assert.equal(useHistoryStore.getState().future.length, 0);
});

test('concurrent undo runs once and project switching discards the old history', async () => {
  resetHistory(); const gate = deferred(); let calls = 0;
  useHistoryStore.getState().push({ label: 'Slow edit', undo: async () => { calls++; await gate.promise; }, redo() {} });
  const pending = useHistoryStore.getState().undo();
  await useHistoryStore.getState().undo(); assert.equal(calls, 1);
  useProjectStore.setState({ id: 'different-project' });
  gate.resolve(); await pending;
  assert.equal(useHistoryStore.getState().past.length, 0);
  assert.equal(useHistoryStore.getState().future.length, 0);
  assert.equal(useHistoryStore.getState().busy, false);
});

test('history caps retained edits and a new edit invalidates redo', async () => {
  resetHistory();
  for (let i = 0; i < 25; i++) useHistoryStore.getState().push({ label: String(i), undo() {}, redo() {} });
  assert.equal(useHistoryStore.getState().past.length, 20);
  assert.equal(useHistoryStore.getState().past[0].label, '5');
  await useHistoryStore.getState().undo(); assert.equal(useHistoryStore.getState().future.length, 1);
  useHistoryStore.getState().push({ label: 'Branch', undo() {}, redo() { assert.fail('Discarded redo'); } });
  assert.equal(useHistoryStore.getState().future.length, 0);
  await useHistoryStore.getState().redo();
  assert.equal(useHistoryStore.getState().past.at(-1).label, 'Branch');
});
