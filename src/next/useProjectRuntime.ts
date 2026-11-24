import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExplorerContextMenuState } from '../components/workspace/WorkspaceTabMenus';
import { useExplorerMutations } from '../hooks/useExplorerMutations';
import { useExplorerTree } from '../hooks/useExplorerTree';
import { useLocalTaggerFilePicker } from '../hooks/useLocalTaggerFilePicker';
import { useProjectLifecycle } from '../hooks/useProjectLifecycle';
import { useProjectSave } from '../hooks/useProjectSave';
import { useWorkspaceAppearance } from '../hooks/useWorkspaceAppearance';
import { useWorkspaceFileAssets } from '../hooks/useWorkspaceFileAssets';
import { useWorkspaceTabsState } from '../hooks/useWorkspaceTabs';
import { selectBuildDatasetItems } from '../lib/buildStageSummary';
import { toWorkspaceImages, toWorkspaceReviewAssets } from '../lib/workspaceImages';
import { flushProjectSave } from '../hooks/useProjectSave';
import { rememberRecentProject } from '../services/project/recentProjectsService';
import { restoreSavedLocalTagger } from '../services/tagging/localTaggerConnectionService';
import { useProjectStore } from '../stores/useProjectStore';
import { useUIStore } from '../stores/useUIStore';

const NO_STORED_LAYOUT = {};
const showNothing = () => {};

/**
 * Project runtime for the next UI: save, appearance, Explorer mutations and project lifecycle,
 * without dock, tabs UI or Inspector. The headless tabs state only satisfies Explorer mutations.
 */
export function useProjectRuntime() {
  useEffect(() => { void restoreSavedLocalTagger(); }, []);
  const projectSave = useProjectSave();
  const appearance = useWorkspaceAppearance();
  const localTaggerPicker = useLocalTaggerFilePicker();
  const workspaceFileAssets = useWorkspaceFileAssets();

  const projectId = useProjectStore(state => state.id);
  const projectName = useProjectStore(state => state.name);
  const sourceImagesById = useProjectStore(state => state.sourceImages);
  const datasetItemsById = useProjectStore(state => state.datasetItems);
  const projectDirectoryHandle = useUIStore(state => state.projectDirectoryHandle);
  const projectDirectoryName = useUIStore(state => state.projectDirectoryName);
  const sourceImages = useMemo(() => Object.values(sourceImagesById), [sourceImagesById]);
  const datasetItems = useMemo(() => Object.values(datasetItemsById).filter(item => !item.deleted), [datasetItemsById]);
  const workspaceImages = useMemo(() => toWorkspaceImages(sourceImages, datasetItems), [datasetItems, sourceImages]);
  const workspaceReviewItems = useMemo(
    () => toWorkspaceReviewAssets(sourceImages, workspaceFileAssets, {}, datasetItems),
    [datasetItems, sourceImages, workspaceFileAssets]
  );

  const projectType = useProjectStore(state => state.projectType);
  const targetModel = useProjectStore(state => state.targetModel);
  const setProjectDirectory = useUIStore(state => state.setProjectDirectory);
  const datasetCount = useMemo(() => selectBuildDatasetItems(workspaceImages).length, [workspaceImages]);

  // The open project is remembered for the Projects screen; its edit time moves when a save completes.
  const recentSummary = useRef({ name: projectName, projectType, targetModel, datasetCount });
  recentSummary.current = { name: projectName, projectType, targetModel, datasetCount };
  const remember = useCallback((edited: boolean) => {
    if (!projectDirectoryHandle) return;
    void rememberRecentProject(projectDirectoryHandle, { ...recentSummary.current, ...(edited ? { lastEditedAt: new Date().toISOString() } : {}) })
      .catch(() => {});
  }, [projectDirectoryHandle]);
  useEffect(() => { remember(false); }, [projectId, remember]);
  const previousSaveStatus = useRef(projectSave.status);
  useEffect(() => {
    const previous = previousSaveStatus.current;
    previousSaveStatus.current = projectSave.status;
    if (projectSave.status === 'saved' && (previous === 'pending' || previous === 'saving')) remember(true);
  }, [projectSave.status, remember]);
  const closeProject = useCallback(async () => {
    if (projectOperationBusyRef.current) return;
    await flushProjectSave();
    remember(false);
    setProjectDirectory(undefined);
  }, [remember, setProjectDirectory]);

  const tabsState = useWorkspaceTabsState(NO_STORED_LAYOUT);
  const [, setExplorerContextMenu] = useState<ExplorerContextMenuState | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isProjectDirectoryBusy, setIsProjectDirectoryBusy] = useState(false);
  const [navigationRecovery, setNavigationRecovery] = useState(false);
  const persistWorkspaceRef = useRef<(() => void) | null>(null);
  const projectSessionRef = useRef(0);
  const projectOperationBusyRef = useRef(false);
  const projectOperationOriginRef = useRef<HTMLElement | null>(null);

  const explorer = useExplorerTree({
    setOpenTabs: tabsState.setOpenTabs,
    setExplorerContextMenu,
    openFile: async () => {},
  });
  const explorerMutations = useExplorerMutations({
    explorer,
    tabs: tabsState,
    activeTab: null,
    confirmClosingTabs: async () => true,
    projectOperationBusyRef,
  });
  const lifecycle = useProjectLifecycle({
    workspace: {
      openTabs: tabsState.openTabs, workspaceImages, dock: { show: showNothing }, setOpenMenu: showNothing,
      setActiveActivityView: showNothing, setClosedTabs: tabsState.setClosedTabs, setNavigationRecovery,
      applyWorkspaceTabsForProject: showNothing, confirmClosingTabs: async () => true, focusView: showNothing,
      setIsProjectDirectoryBusy,
    },
    sessionRefs: { projectSessionRef, projectOperationBusyRef, persistWorkspaceRef, projectOperationOriginRef },
    explorer,
    runExplorerMutation: explorerMutations.runExplorerMutation,
  });

  return {
    projectId, projectName, projectDirectoryHandle, projectDirectoryName,
    projectSave, appearance, localTaggerPicker, workspaceFileAssets, workspaceImages, workspaceReviewItems,
    settingsOpen, setSettingsOpen, explorer, explorerMutations, lifecycle, closeProject, datasetCount, isProjectDirectoryBusy, navigationRecovery,
  };
}
