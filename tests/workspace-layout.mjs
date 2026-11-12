import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'rolldown';

const temporary = await mkdtemp(join(tmpdir(), 'workspace-layout-'));
try {
  await build({ input: ['src/lib/workspaceLayout.ts', 'src/lib/workspacePersistence.ts', 'src/lib/workspaceTabs.ts', 'src/lib/constants.ts'], platform: 'node', output: { dir: temporary, format: 'esm' } });
  const layoutApi = await import(pathToFileURL(join(temporary, 'workspaceLayout.js')));
  const { dockGroups, dockHosts, dockViews, findDockGroup, migrateDockLayout, moveDockSource, openDockView, removeDockViews, measureDockLayout, floatDockSource, pinDockHost, resizeDockSplit, parseDockLayout, getDockPreview, getDockSide, EXPLORER_VIEW } = layoutApi;
  const viewIds = (layout) => dockHosts(layout).flatMap((host) => dockViews(host.root));
  const groupAt = (layout, view) => findDockGroup(layout, view).group;
  const regionAt = (layout, view) => measureDockLayout(layout, 1400, 1000).groups.find((entry) => entry.group.tabs.includes(view));
  const base = () => migrateDockLayout({}, ['tool:review', 'tool:analysis']);
  const { readWorkspacePersistence, writeWorkspacePersistence, WORKSPACE_STORAGE_KEY, LEGACY_WORKSPACE_STORAGE_KEY } = await import(pathToFileURL(join(temporary, 'workspacePersistence.js')));
  const values = new Map();
  const storage = {getItem:key => values.get(key) ?? null, setItem:(key,value) => values.set(key,value)};
  const legacyWorkspace = {openTabs:[{kind:'tool',tool:'review'}],activeTabId:'tool:review',projectId:'project-a'};
  values.set(LEGACY_WORKSPACE_STORAGE_KEY,JSON.stringify(legacyWorkspace));
  values.set(layoutApi.DOCK_STORAGE_KEY,JSON.stringify(base()));
  const migrated = readWorkspacePersistence(storage);
  assert.deepEqual(migrated.workspace,legacyWorkspace);
  assert.ok(findDockGroup(migrated.dock,'tool:analysis'));
  const nextWorkspace = {...legacyWorkspace,activeTabId:'tool:analysis'};
  writeWorkspacePersistence(storage,nextWorkspace,migrated.dock);
  const snapshot = JSON.parse(values.get(WORKSPACE_STORAGE_KEY));
  assert.equal(snapshot.version,2);
  assert.deepEqual(snapshot.workspace,nextWorkspace);
  assert.deepEqual(snapshot.dock,migrated.dock);
  assert.deepEqual(readWorkspacePersistence(storage,'project-a'),migrated,'The first migration preserves the last connected project before temporary changes');
  values.set(LEGACY_WORKSPACE_STORAGE_KEY,JSON.stringify({projectId:'stale-legacy'}));
  assert.deepEqual(readWorkspacePersistence(storage).workspace,nextWorkspace,'Canonical data takes precedence over stale migration inputs');
  const previous = values.get(WORKSPACE_STORAGE_KEY);
  assert.throws(() => writeWorkspacePersistence({...storage,setItem:() => {throw new Error('quota');}},legacyWorkspace,base()),/quota/);
  assert.equal(values.get(WORKSPACE_STORAGE_KEY),previous,'A failed atomic write keeps the prior view/dock snapshot');
  values.set(WORKSPACE_STORAGE_KEY,JSON.stringify({version:3,workspace:{projectId:'future'}}));
  assert.throws(() => writeWorkspacePersistence(storage,legacyWorkspace,base()),/newer version/);
  assert.equal(JSON.parse(values.get(WORKSPACE_STORAGE_KEY)).version,3);
  values.delete(WORKSPACE_STORAGE_KEY);
  writeWorkspacePersistence(storage,legacyWorkspace,base(),'project-a');
  const projectA = readWorkspacePersistence(storage,'project-a');
  const layoutB = removeDockViews(base(),['tool:analysis']);
  const workspaceB = {...legacyWorkspace,projectId:'project-b',activeTabId:'tool:review'};
  writeWorkspacePersistence(storage,workspaceB,layoutB,'project-b');
  writeWorkspacePersistence(storage,{...workspaceB,activeTabId:null},removeDockViews(layoutB,['tool:review']));
  assert.deepEqual(readWorkspacePersistence(storage,'project-a'),projectA,'Temporary workspace and another project cannot overwrite A geometry');
  assert.ok(findDockGroup(readWorkspacePersistence(storage,'project-b').dock,'tool:review'),'Temporary edits cannot overwrite B geometry');
  assert.equal(findDockGroup(readWorkspacePersistence(storage,'project-b').dock,'tool:analysis'),null);
  const datasetStorageValues = new Map();
  const datasetStorage = {getItem:key => datasetStorageValues.get(key) ?? null,setItem:(key,value) => datasetStorageValues.set(key,value)};
  let dualDatasetDock = migrateDockLayout({}, ['dataset:old', 'dataset:old:analysis', 'tool:review']);
  dualDatasetDock = floatDockSource(dualDatasetDock, {type:'tab',id:'dataset:old'}, {x:80,y:60,width:500,height:420});
  dualDatasetDock = openDockView(dualDatasetDock, layoutApi.DATASET_VIEW);
  dualDatasetDock = layoutApi.focusDockView(dualDatasetDock, 'dataset:old');
  datasetStorageValues.set(WORKSPACE_STORAGE_KEY, JSON.stringify({version:2, workspace:{projectId:'project-a',activeTabId:'dataset:old',openTabs:[
    {kind:'window',window:'dataset'}, {kind:'dataset',datasetId:'old',pinned:true}, {kind:'dataset-tool',datasetId:'old',tool:'analysis'},
  ]}, dock:dualDatasetDock, projects:{}}));
  const normalizedDataset = readWorkspacePersistence(datasetStorage);
  assert.equal(normalizedDataset.workspace.activeTabId, layoutApi.DATASET_VIEW);
  assert.deepEqual(normalizedDataset.workspace.openTabs, [
    {kind:'window',window:'dataset',pinned:true}, {kind:'dataset-tool',datasetId:'global',tool:'analysis'},
  ]);
  assert.equal(viewIds(normalizedDataset.dock).filter(id => id === layoutApi.DATASET_VIEW).length, 1);
  assert.equal(viewIds(normalizedDataset.dock).some(id => id === 'dataset:old'), false);
  assert.equal(viewIds(normalizedDataset.dock).some(id => id === 'dataset:old:analysis'), false);
  assert.equal(viewIds(normalizedDataset.dock).includes('dataset:global:analysis'), true);
  assert.equal(findDockGroup(normalizedDataset.dock, layoutApi.DATASET_VIEW).host.startsWith('float:'), true, 'The active legacy Dataset placement wins');
  assert.ok(normalizedDataset.dock.pinned.includes(layoutApi.DATASET_VIEW));
  values.set(WORKSPACE_STORAGE_KEY,'broken JSON');
  assert.deepEqual(readWorkspacePersistence(storage).workspace,{projectId:'stale-legacy'},'Malformed canonical data can recover from retained legacy keys');

  const assertPreviewMatchesDrop = (layout, source, target, width = 1400, height = 1000) => {
    const before = JSON.stringify(layout);
    const preview = getDockPreview(layout, source, target, width, height);
    assert.equal(JSON.stringify(layout), before, 'Preview must not mutate the saved layout');
    const next = moveDockSource(layout, source, target);
    const incoming = dockViews(layoutApi.dockSourceNode(layout, source));
    const rectangles = measureDockLayout(next, width, height).groups
      .filter((entry) => entry.group.tabs.some((view) => incoming.includes(view)))
      .map((entry) => entry.rect);
    assert.ok(rectangles.length, 'Dropped views must remain visible');
    const left = Math.min(...rectangles.map((rect) => rect.x));
    const top = Math.min(...rectangles.map((rect) => rect.y));
    assert.deepEqual(preview, { x: left, y: top,
      width: Math.max(...rectangles.map((rect) => rect.x + rect.width)) - left,
      height: Math.max(...rectangles.map((rect) => rect.y + rect.height)) - top });
    return next;
  };
  const assertUnique = (layout) => assert.equal(new Set(viewIds(layout)).size, viewIds(layout).length);
  const assertDockedWithoutOverlap = (layout, width = 1400, height = 1000) => {
    const measured = measureDockLayout(layout, width, height);
    const groups = measured.groups.filter((group) => group.host === 'left' || group.host === 'main');
    for (const group of groups) {
      const rect = group.rect;
      assert.ok(rect.width >= 0 && rect.height >= 0);
      assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width + 0.001 && rect.y + rect.height <= height + 0.001);
      for (const other of groups) {
        if (other === group) continue;
        const intersectionWidth = Math.min(rect.x + rect.width, other.rect.x + other.rect.width) - Math.max(rect.x, other.rect.x);
        const intersectionHeight = Math.min(rect.y + rect.height, other.rect.y + other.rect.height) - Math.max(rect.y, other.rect.y);
        assert.ok(intersectionWidth <= 0.001 || intersectionHeight <= 0.001, 'Docked panels must not overlap');
      }
    }
  };

  for (const targetView of ['window:inspector', 'window:output', EXPLORER_VIEW, 'tool:review']) {
    for (const side of ['left', 'right', 'top', 'bottom']) {
      let layout = openDockView(base(), 'window:project');
      const target = findDockGroup(layout, targetView);
      assertPreviewMatchesDrop(layout, { type: 'tab', id: 'window:project' }, { host: target.host, group: target.group.id, side });
      assertPreviewMatchesDrop(layout, { type: 'tab', id: 'window:project' }, { host: target.host, group: target.group.id, side }, 400, 300);
      layout = moveDockSource(layout, { type: 'tab', id: 'window:project' }, { host: target.host, group: target.group.id, side });
      const sourceRect = regionAt(layout, 'window:project').rect;
      const targetRect = regionAt(layout, targetView).rect;
      if (side === 'left') assert.ok(sourceRect.x + sourceRect.width < targetRect.x);
      if (side === 'right') assert.ok(targetRect.x + targetRect.width < sourceRect.x);
      if (side === 'top') assert.ok(sourceRect.y + sourceRect.height < targetRect.y);
      if (side === 'bottom') assert.ok(targetRect.y + targetRect.height < sourceRect.y);
      assertUnique(layout);
      assertDockedWithoutOverlap(layout);
      assert.equal(findDockGroup(layout, EXPLORER_VIEW).host, 'left');
      assert.deepEqual(parseDockLayout(JSON.parse(JSON.stringify(layout))), { ...layout, pinned: [] });
    }
  }

  for (const side of ['left', 'right', 'top', 'bottom', 'center']) {
    const empty = migrateDockLayout({}, []);
    const initialViews = viewIds(empty).sort();
    const target = dockGroups(empty.main).find((group) => group.tabs.length === 0);
    const moved = assertPreviewMatchesDrop(empty, { type: 'tab', id: 'window:inspector' }, { host: 'main', group: target.id, side });
    assert.deepEqual(viewIds(moved).sort(), initialViews, 'Docking into an empty editor area must not lose any window');
    assertUnique(moved);
    assertDockedWithoutOverlap(moved);
    assert.deepEqual(parseDockLayout(JSON.parse(JSON.stringify(moved))), { ...moved, pinned: [] });
  }
  const emptyLayout = migrateDockLayout({}, []);
  assert.deepEqual(dockGroups(removeDockViews(emptyLayout, ['missing']).main), dockGroups(emptyLayout.main));
  assert.equal(getDockPreview(emptyLayout, { type: 'tab', id: EXPLORER_VIEW }, { host: 'main', group: 'main-editors', side: 'center' }, 1400, 1000), null);
  const ownGroup = findDockGroup(emptyLayout, 'window:inspector');
  assert.equal(getDockPreview(emptyLayout, { type: 'tab', id: 'window:inspector' }, { host: ownGroup.host, group: ownGroup.group.id, side: 'center' }, 1400, 1000), null);

  let layout = base();
  const inspector = findDockGroup(layout, 'window:inspector');
  layout = moveDockSource(layout, { type: 'tab', id: 'tool:analysis' }, { host: inspector.host, group: inspector.group.id, side: 'center' });
  assert.deepEqual(groupAt(layout, 'tool:analysis').tabs, ['window:inspector', 'tool:analysis']);
  assert.equal(groupAt(layout, 'tool:analysis').active, 'tool:analysis');
  assert.deepEqual(groupAt(layout, 'tool:review').tabs, ['tool:review']);

  layout = moveDockSource(layout, { type: 'group', id: groupAt(layout, 'tool:analysis').id }, { host: 'main', group: groupAt(layout, 'tool:review').id, side: 'bottom' });
  assert.deepEqual(groupAt(layout, 'tool:analysis').tabs, ['window:inspector', 'tool:analysis']);
  assertDockedWithoutOverlap(layout);
  const before = viewIds(layout).sort();
  layout = floatDockSource(layout, { type: 'group', id: groupAt(layout, 'tool:analysis').id }, { x: 80, y: 90, width: 500, height: 450 });
  assert.equal(layout.floating.length, 1);
  assert.deepEqual(viewIds(layout).sort(), before);
  layout = pinDockHost(layout, layout.floating[0].id);
  assert.equal(layout.floating.length, 0);
  assert.ok(regionAt(layout, 'tool:analysis').rect.y > regionAt(layout, 'tool:review').rect.y);

  layout = openDockView(layout, 'window:dataset');
  layout = floatDockSource(layout, { type: 'tab', id: 'window:dataset' }, { x: 20, y: 30, width: 600, height: 450 });
  const floatingTarget = findDockGroup(layout, 'window:dataset');
  assertPreviewMatchesDrop(layout, { type: 'tab', id: 'tool:review' }, { host: floatingTarget.host, group: floatingTarget.group.id, side: 'center' });
  assertPreviewMatchesDrop(layout, { type: 'tab', id: 'tool:review' }, { host: floatingTarget.host, group: floatingTarget.group.id, side: 'right' });
  layout = moveDockSource(layout, { type: 'tab', id: 'tool:review' }, { host: floatingTarget.host, group: floatingTarget.group.id, side: 'right' });
  assert.equal(layout.floating[0].root.type, 'split');
  assertPreviewMatchesDrop(layout, { type: 'host', id: layout.floating[0].id }, { host: 'left', group: groupAt(layout, EXPLORER_VIEW).id, side: 'bottom' });
  assertUnique(layout);
  layout = pinDockHost(layout, layout.floating[0].id);
  assert.equal(layout.floating.length, 0);
  assertUnique(layout);
  assert.notEqual(groupAt(layout, 'window:dataset').id, groupAt(layout, 'tool:review').id);
  assert.ok(regionAt(layout, 'window:dataset').rect.x < regionAt(layout, 'tool:review').rect.x);

  const forbiddenMove = moveDockSource(layout, { type: 'tab', id: EXPLORER_VIEW }, { host: 'main', group: groupAt(layout, 'tool:review').id, side: 'right' });
  assert.equal(forbiddenMove, layout);
  assert.equal(floatDockSource(layout, { type: 'group', id: groupAt(layout, EXPLORER_VIEW).id }, { x: 0, y: 0, width: 300, height: 400 }), layout);
  let sidebarLayout = openDockView(base(), 'window:project');
  sidebarLayout = moveDockSource(sidebarLayout, { type: 'tab', id: 'window:project' }, { host: 'left', group: groupAt(sidebarLayout, EXPLORER_VIEW).id, side: 'bottom' });
  assert.equal(findDockGroup(sidebarLayout, 'window:project').host, 'left');
  sidebarLayout = removeDockViews(sidebarLayout, [EXPLORER_VIEW]);
  assert.equal(findDockGroup(sidebarLayout, 'window:project').host, 'left');
  sidebarLayout = openDockView(sidebarLayout, EXPLORER_VIEW);
  assert.equal(findDockGroup(sidebarLayout, EXPLORER_VIEW).host, 'left');
  assert.ok(regionAt(sidebarLayout, EXPLORER_VIEW).rect.y < regionAt(sidebarLayout, 'window:project').rect.y);
  sidebarLayout = moveDockSource(sidebarLayout, { type: 'tab', id: 'window:project' }, { host: 'left', group: groupAt(sidebarLayout, EXPLORER_VIEW).id, side: 'center' });
  assert.equal(floatDockSource(sidebarLayout, { type: 'group', id: groupAt(sidebarLayout, EXPLORER_VIEW).id }, { x: 0, y: 0, width: 300, height: 400 }), sidebarLayout);
  assert.equal(moveDockSource(sidebarLayout, { type: 'host', id: 'left' }, { host: 'main', group: groupAt(sidebarLayout, 'tool:review').id, side: 'right' }), sidebarLayout);
  const oldSidebarWidth = regionAt(layout, EXPLORER_VIEW).rect.width;
  layout = resizeDockSplit(layout, 'sidebar', 0.3);
  assert.ok(regionAt(layout, EXPLORER_VIEW).rect.width > oldSidebarWidth);
  const divider = measureDockLayout(layout, 1400, 1000).dividers.find((entry) => entry.id !== 'sidebar');
  const beforeResize = measureDockLayout(layout, 1400, 1000).groups.map((group) => group.rect);
  layout = resizeDockSplit(layout, divider.id, 0.4);
  assert.notDeepEqual(measureDockLayout(layout, 1400, 1000).groups.map((group) => group.rect), beforeResize);
  assertDockedWithoutOverlap(layout);
  assertDockedWithoutOverlap(layout, 400, 300);
  assert.deepEqual(parseDockLayout({ version: 99 }), null);

  const migration = migrateDockLayout({
    leftPanelWidth: 300, rightPanelWidth: 320, bottomPanelHeight: 240, bottomPanelOpen: true,
    projectWindowOpen: true, projectWindow: { x: 100, y: 150, width: 410, height: 330, minimized: true },
    openTabs: [{ kind: 'window', window: 'inspector' }],
  }, ['tool:review'], 1400, 1000);
  assert.equal(migration.sidebarRatio, 300 / 1400);
  assert.equal(migration.floating[0].minimized, true);
  assert.deepEqual(migration.floating[0].bounds, { x: 100, y: 150, width: 410, height: 330 });
  assert.equal(groupAt(migration, 'window:inspector').id, groupAt(migration, 'tool:review').id);
  assertUnique(migration);
  const migratedWindowOnly = migrateDockLayout({
    openTabs: [{ kind: 'window', window: 'project', pinned: true }],
  }, []);
  assert.ok(findDockGroup(migratedWindowOnly, 'window:project'));
  assert.deepEqual(migratedWindowOnly.pinned, ['window:project']);
  const invalidHosts = { ...base(), floating: [
    { id: 'float:duplicate', root: layoutApi.dockGroup(['window:project']), bounds: { x: 0, y: 0, width: 300, height: 300 } },
    { id: 'float:duplicate', root: layoutApi.dockGroup(['window:dataset']), bounds: { x: 0, y: 0, width: 300, height: 300 } },
  ] };
  assert.equal(parseDockLayout(invalidHosts).floating.length, 1);
  const closed = removeDockViews(base(), ['tool:review', 'tool:analysis', 'window:inspector', 'window:output']);
  assert.equal(dockGroups(closed.main).length, 1);
  assert.equal(dockViews(closed.main).length, 0);
  assert.equal(findDockGroup(openDockView(closed, 'window:output'), 'window:output').host, 'main');
  const utilitiesOnly = removeDockViews(base(), ['tool:review', 'tool:analysis']);
  const withWelcome = layoutApi.ensureDockEditorGroup(utilitiesOnly);
  assert.ok(dockGroups(withWelcome.main).some(group => group.tabs.length === 0));
  assert.equal(layoutApi.ensureDockEditorGroup(withWelcome), withWelcome, 'The Welcome destination is not duplicated');
  assert.ok(findDockGroup(withWelcome, 'window:inspector'), 'Closing editors preserves utility panels');
  const inspectorFocused = { ...withWelcome, focusedGroup: findDockGroup(withWelcome, 'window:inspector').group.id };
  const newEditor = openDockView(inspectorFocused, 'tool:import');
  assert.notEqual(findDockGroup(newEditor, 'tool:import').group.id, findDockGroup(newEditor, 'window:inspector').group.id, 'New editors use the editor area even when Inspector has focus');
  const restoredEditor = openDockView(withWelcome, 'tool:review');
  assert.equal(dockGroups(restoredEditor.main).length, dockGroups(withWelcome.main).length, 'Reopening a closed editor fills Welcome instead of splitting its old neighbor again');
  const rect = { x: 100, y: 100, width: 800, height: 600 };
  assert.equal(getDockSide(rect, 110, 400), 'left');
  assert.equal(getDockSide(rect, 880, 400), 'right');
  assert.equal(getDockSide(rect, 500, 110), 'top');
  assert.equal(getDockSide(rect, 500, 680), 'bottom');
  assert.equal(getDockSide(rect, 500, 400), 'center');

  // Pure helpers extracted from App: layout reading, tab persistence and URL slugs (current behavior).
  {
    const { readWorkspaceLayout, getRestorableWorkspaceTabs } = await import(pathToFileURL(join(temporary, 'workspacePersistence.js')));
    const tabsApi = await import(pathToFileURL(join(temporary, 'workspaceTabs.js')));
    const constants = await import(pathToFileURL(join(temporary, 'constants.js')));
    const store = new Map();
    const fakeStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
    const hadWindow = 'window' in globalThis;
    const savedWindow = globalThis.window;
    try {
      assert.deepEqual(readWorkspaceLayout('p'), {}, 'Without window the layout is empty');
      globalThis.window = { localStorage: fakeStorage };
      assert.deepEqual(readWorkspaceLayout('p'), {}, 'A missing key yields an empty layout');
      store.set(WORKSPACE_STORAGE_KEY, '{broken');
      assert.deepEqual(readWorkspaceLayout('p'), {}, 'Corrupted JSON yields an empty layout');
      store.delete(WORKSPACE_STORAGE_KEY);

      const reviewScope = { review: { kind: 'directory', path: 'dataset/a', label: 'A' } };
      store.set(WORKSPACE_STORAGE_KEY, JSON.stringify({ version: 2, workspace: {
        projectId: 'p', activeTabId: 'tool:review', leftPanelOpen: false, leftPanelWidth: 280, rightPanelWidth: 'x', activeActivityView: 'versions',
        projectWindow: { x: 1, y: 'bad', width: 10, height: Infinity, minimized: true },
        openTabs: [
          'import', 'nope',
          { kind: 'tool', tool: 'review', pinned: true, id: 'tool:review', scope: reviewScope },
          { kind: 'tool', tool: 'review', scope: { review: { kind: 'selection', paths: ['a', 1], label: 'S' } } },
          { kind: 'tool', stage: 'analysis' },
          { kind: 'tool', tool: 'bogus' },
          { kind: 'dataset', datasetId: 'old', pinned: true },
          { kind: 'dataset-tool', datasetId: 'g', tool: 'analysis' },
          { kind: 'dataset-tool', datasetId: 'g', tool: 'export' },
          { kind: 'window', window: 'output' },
          { kind: 'window', window: 'unknown' },
          null, 5,
        ],
      }, dock: null, projects: {} }));
      const layout = readWorkspaceLayout('p');
      assert.deepEqual(layout.openTabs, [
        { kind: 'tool', tool: 'import' },
        { kind: 'tool', tool: 'review', pinned: true, scope: reviewScope, id: 'tool:review' },
        { kind: 'tool', tool: 'analysis', pinned: undefined, scope: undefined, id: undefined },
        { kind: 'window', window: 'dataset', pinned: true },
        { kind: 'dataset-tool', datasetId: 'global', tool: 'analysis', pinned: undefined },
        { kind: 'window', window: 'output', pinned: undefined },
      ], 'Strings, legacy stage key and window/dataset tabs are normalized; invalid scope, tools, windows and junk are dropped; duplicates collapse by tool (the second review tab is dropped); dataset tabs map to the Dataset window and dataset-tool to global');
      assert.equal(layout.projectId, 'p');
      assert.equal(layout.activeTabId, 'tool:review');
      assert.equal(layout.leftPanelOpen, false);
      assert.equal(layout.leftPanelWidth, 280);
      assert.equal(layout.rightPanelWidth, undefined, 'Non-numeric sizes are dropped');
      assert.equal(layout.rightPanelOpen, undefined);
      assert.equal(layout.activeActivityView, 'versions');
      assert.deepEqual(layout.projectWindow, { x: 1, y: 112, width: 10, height: 360, minimized: true }, 'Invalid panel fields fall back to defaults individually');
      assert.deepEqual(layout.datasetWindow, { x: 150, y: 132, width: 320, height: 380, minimized: false });
      store.set(WORKSPACE_STORAGE_KEY, JSON.stringify({ version: 2, workspace: { projectId: 7, activeActivityView: 'other' }, dock: null }));
      const sparse = readWorkspaceLayout('p');
      assert.equal(sparse.openTabs, undefined);
      assert.equal(sparse.projectId, null);
      assert.equal(sparse.activeTabId, null);
      assert.equal(sparse.activeActivityView, 'explorer');
      store.delete(WORKSPACE_STORAGE_KEY);
      store.set(LEGACY_WORKSPACE_STORAGE_KEY, JSON.stringify({ projectId: 'legacy', openTabs: ['review'] }));
      assert.deepEqual(readWorkspaceLayout('legacy').openTabs, [{ kind: 'tool', tool: 'review' }], 'Legacy key is still read when no canonical snapshot exists');
    } finally {
      if (hadWindow) globalThis.window = savedWindow; else delete globalThis.window;
    }

    const persisted = [
      { kind: 'tool', tool: 'review' }, { kind: 'tool', tool: 'import' }, { kind: 'window', window: 'project' }, { kind: 'dataset-tool', datasetId: 'g', tool: 'tagging' },
    ];
    assert.deepEqual(getRestorableWorkspaceTabs({ projectId: 'a', openTabs: persisted }, 'a').map((tab) => tab.id), ['tool:review', 'tool:import', 'window:project', 'dataset:g:tagging']);
    assert.deepEqual(getRestorableWorkspaceTabs({ projectId: 'a', openTabs: persisted }, 'b').map((tab) => tab.id), ['tool:review', 'tool:import', 'window:project'], 'Dataset tabs of another project are not restored');
    assert.deepEqual(getRestorableWorkspaceTabs({ projectId: 'a', openTabs: persisted }).map((tab) => tab.id), ['tool:review', 'tool:import', 'window:project'], 'Without a project id only tool and window tabs are restored');
    assert.deepEqual(getRestorableWorkspaceTabs({}, 'a'), []);

    const { createWorkspaceTabFromPersisted, persistWorkspaceTab, dedupeWorkspaceTabs, orderWorkspaceTabs, getInspectorContext, createToolTab, isDatasetToolName } = tabsApi;
    const scope = { review: { kind: 'selection', paths: ['a b', 'c'], label: 'S' } };
    assert.equal(createToolTab('review', scope).id, `tool:review:${encodeURIComponent('a b|c')}`);
    assert.equal(createToolTab('review', { review: { kind: 'directory', path: 'x/y', label: 'X' } }).id, 'tool:review:x%2Fy');
    for (const entry of [
      { kind: 'tool', tool: 'review', id: 'tool:review:custom', scope: { review: scope.review }, pinned: true },
      { kind: 'tool', tool: 'analysis', id: 'tool:analysis', scope: undefined, pinned: undefined },
      { kind: 'window', window: 'inspector', pinned: true },
      { kind: 'dataset-tool', datasetId: 'g', tool: 'select', pinned: false },
    ]) assert.deepEqual(persistWorkspaceTab(createWorkspaceTabFromPersisted(entry)), entry, `Round-trip ${entry.kind}`);
    assert.deepEqual(createWorkspaceTabFromPersisted({ kind: 'tool', tool: 'review', scope: { review: scope.review } }).id, createToolTab('review', scope).id, 'Missing id is derived from scope');
    assert.deepEqual(createWorkspaceTabFromPersisted({ kind: 'dataset', datasetId: 'old', pinned: true }), { id: 'window:dataset', kind: 'window', window: 'dataset', pinned: true }, 'Legacy dataset tab becomes the Dataset window');
    assert.deepEqual(persistWorkspaceTab({ id: 'dataset:x', kind: 'dataset', datasetId: 'x' }), { kind: 'window', window: 'dataset', pinned: undefined });
    assert.equal(persistWorkspaceTab({ id: 'file:1', kind: 'file-view' }), null, 'File tabs are not persisted');
    assert.deepEqual(isDatasetToolName('tagging') && isDatasetToolName('select') && !isDatasetToolName('export') && !isDatasetToolName(undefined), true);

    const mk = (id, pinned) => ({ id, kind: 'window', window: 'output', pinned });
    assert.deepEqual(dedupeWorkspaceTabs([mk('a'), mk('b'), mk('a', true)]).map((tab) => [tab.id, tab.pinned]), [['a', undefined], ['b', undefined]], 'The first tab with an id wins');
    assert.deepEqual(orderWorkspaceTabs([mk('a'), mk('b', true), mk('c'), mk('d', true)]).map((tab) => tab.id), ['b', 'd', 'a', 'c'], 'Pinned tabs first, stable within groups');

    const inspect = (tab, tool = null) => getInspectorContext(tab, tool);
    assert.equal(inspect(null, 'review'), 'empty');
    assert.equal(inspect({ kind: 'window', window: 'dataset' }), 'dataset');
    assert.equal(inspect({ kind: 'dataset' }), 'dataset');
    assert.equal(inspect({ kind: 'window', window: 'output' }), 'empty');
    assert.equal(inspect({ kind: 'window', window: 'output' }, 'import'), 'tool');
    assert.equal(inspect({ kind: 'tool', tool: 'import' }, 'tagging'), 'caption');
    assert.equal(inspect({ kind: 'file-caption' }), 'caption');
    assert.equal(inspect({ kind: 'file-analysis' }), 'analysis');
    assert.equal(inspect({ kind: 'file-edit' }), 'photopea');
    assert.equal(inspect({ kind: 'file-view', fileKind: 'psd' }), 'photopea');
    assert.equal(inspect({ kind: 'file-view', fileKind: 'image' }), 'file');
    assert.equal(inspect({ kind: 'file-video' }), 'file');
    assert.equal(inspect({ kind: 'tool', tool: 'review' }), 'review');
    assert.equal(inspect({ kind: 'dataset-tool', tool: 'select' }), 'review');
    assert.equal(inspect({ kind: 'dataset-tool', tool: 'analysis' }), 'analysis');
    assert.equal(inspect({ kind: 'tool', tool: 'analysis' }), 'analysis');
    assert.equal(inspect({ kind: 'dataset-tool', tool: 'tagging' }), 'empty', 'dataset-tool tagging without activeTool falls through to empty');
    assert.equal(inspect({ kind: 'tool', tool: 'export' }, 'export'), 'tool');

    const { getToolFromUrlSlug, getUrlSlugForTool, TOOLS, isToolName, URL_TOOL_ALIASES } = constants;
    for (const tool of TOOLS) assert.equal(getToolFromUrlSlug(getUrlSlugForTool(tool)), tool, `Slug round-trip for ${tool}`);
    assert.equal(getUrlSlugForTool('build'), 'build-dataset');
    assert.equal(getUrlSlugForTool('clean'), 'photopea');
    assert.equal(getToolFromUrlSlug('video-frames'), 'video');
    assert.equal(getToolFromUrlSlug('remove-duplicates'), 'select');
    assert.equal(getToolFromUrlSlug('edit'), 'clean');
    assert.equal(getToolFromUrlSlug('clear'), 'clean');
    assert.equal(getToolFromUrlSlug('caption'), 'tagging');
    assert.equal(getToolFromUrlSlug('tagging'), 'tagging');
    assert.equal(getToolFromUrlSlug('unknown'), null);
    assert.equal(getToolFromUrlSlug(''), null);
    assert.equal(getToolFromUrlSlug(null), null);
    assert.ok(Object.values(URL_TOOL_ALIASES).every((tool) => isToolName(tool)), 'Every alias targets a real tool');
    assert.equal(isToolName('review'), true);
    assert.equal(isToolName('photopea'), false);
    assert.equal(isToolName(null), false);
  }
  console.log('PASS: accurate drop previews, empty editor targets, docking in all directions for editors and panels, nested geometry/resizing, tab and group moves, floating groups, pin restoration, Explorer constraints, persistence and legacy migration.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
