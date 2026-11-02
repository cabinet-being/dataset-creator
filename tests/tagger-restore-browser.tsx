const fixtureDbName = 'DatasetCreatorTaggerRestoreFixture';
const originalIndexedDB = window.indexedDB;
Object.defineProperty(window, 'indexedDB', {
  configurable: true,
  value: { open: (name: string, version?: number) => originalIndexedDB.open(name === 'DatasetCreator' ? fixtureDbName : name, version) },
});

const result = document.querySelector<HTMLPreElement>('#result')!;
const show = (message: string) => { result.textContent = message; };
const run = (task: () => Promise<void>) => { void task().catch(error => show(`FAIL: ${error instanceof Error ? error.message : String(error)}`)); };
const settings = await import('../src/services/tagging/localTaggerFileSettings');
const expectedModel = new Uint8Array([0, 4, 10, 77, 255]);
const expectedCsv = 'name,category\nblue_hair,0\n';

document.querySelector<HTMLButtonElement>('#save')!.onclick = () => run(async () => {
  await settings.saveLocalTaggerFile('model', new File([expectedModel], 'model.onnx', { type: 'application/octet-stream' }));
  await settings.saveLocalTaggerFile('tags', new File([expectedCsv], 'selected_tags.csv', { type: 'text/csv' }));
  sessionStorage.setItem('tagger-restore-fixture-pending', '1');
  location.reload();
});

document.querySelector<HTMLButtonElement>('#verify')!.onclick = () => run(async () => {
  const names = await settings.getLocalTaggerSavedFileNames();
  if (names.model !== 'model.onnx' || names.tags !== 'selected_tags.csv') throw new Error(`Saved names changed: ${JSON.stringify(names)}`);
  const model = await settings.readLocalTaggerSavedFile('model', false);
  const tags = await settings.readLocalTaggerSavedFile('tags', false);
  if (!model || !tags) throw new Error('A saved file was unavailable after reload.');
  const bytes = new Uint8Array(await model.arrayBuffer());
  if (bytes.length !== expectedModel.length || bytes.some((byte, index) => byte !== expectedModel[index])) {
    throw new Error('Saved model bytes changed after reload.');
  }
  if (await tags.text() !== expectedCsv) throw new Error('Saved CSV bytes changed after reload.');
  show('PASS: saved model and CSV names and bytes survived a browser reload without a file picker or model download.');
  sessionStorage.removeItem('tagger-restore-fixture-pending');
});

document.querySelector<HTMLButtonElement>('#clear')!.onclick = () => run(async () => {
  await new Promise<void>((resolve, reject) => {
    const open = originalIndexedDB.open(fixtureDbName);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction('taggerFileHandles', 'readwrite');
      transaction.objectStore('taggerFileHandles').delete('model');
      transaction.objectStore('taggerFileHandles').delete('tags');
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
    };
  });
  sessionStorage.removeItem('tagger-restore-fixture-pending');
  show('Fixture files cleared.');
});

if (sessionStorage.getItem('tagger-restore-fixture-pending') === '1') {
  document.querySelector<HTMLButtonElement>('#verify')!.click();
} else {
  show('Choose “Save test files and reload” to check real IndexedDB File persistence.');
}
