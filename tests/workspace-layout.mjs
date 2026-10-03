import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'rolldown';

const temporary = await mkdtemp(join(tmpdir(), 'workspace-layout-'));
try {
  await build({ input: 'src/lib/workspaceLayout.ts', platform: 'node', output: { dir: temporary, format: 'esm' } });
  const layoutApi = await import(pathToFileURL(join(temporary, 'workspaceLayout.js')));
  const { dockGroups, dockHosts, dockViews, findDockGroup, migrateDockLayout, moveDockSource, openDockView, removeDockViews, measureDockLayout, floatDockSource, pinDockHost, resizeDockSplit, parseDockLayout, getDockPreview, getDockSide, EXPLORER_VIEW } = layoutApi;
  const viewIds = (layout) => dockHosts(layout).flatMap((host) => dockViews(host.root));
  const groupAt = (layout, view) => findDockGroup(layout, view).group;
  const regionAt = (layout, view) => measureDockLayout(layout, 1400, 1000).groups.find((entry) => entry.group.tabs.includes(view));
  const base = () => migrateDockLayout({}, ['tool:review', 'tool:analysis']);
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
  const rect = { x: 100, y: 100, width: 800, height: 600 };
  assert.equal(getDockSide(rect, 110, 400), 'left');
  assert.equal(getDockSide(rect, 880, 400), 'right');
  assert.equal(getDockSide(rect, 500, 110), 'top');
  assert.equal(getDockSide(rect, 500, 680), 'bottom');
  assert.equal(getDockSide(rect, 500, 400), 'center');
  console.log('PASS: accurate drop previews, empty editor targets, docking in all directions for editors and panels, nested geometry/resizing, tab and group moves, floating groups, pin restoration, Explorer constraints, persistence and legacy migration.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
