import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useExplorerMutations } from '../hooks/useExplorerMutations';
import { useExplorerTree } from '../hooks/useExplorerTree';
import { useLocalTaggerFilePicker } from '../hooks/useLocalTaggerFilePicker';
import { useProjectLifecycle } from '../hooks/useProjectLifecycle';
import { useProjectSave } from '../hooks/useProjectSave';
import { useWorkspaceAppearance } from '../hooks/useWorkspaceAppearance';
import { useWorkspaceFileAssets } from '../hooks/useWorkspaceFileAssets';
import { selectBuildDatasetItems } from '../lib/buildStageSummary';
import { toWorkspaceImages, toWorkspaceReviewAssets } from '../lib/workspaceImages';
import { flushProjectSave } from '../hooks/useProjectSave';
import { rememberRecentProject } from '../services/project/recentProjectsService';
import { restoreSavedLocalTagger } from '../services/tagging/localTaggerConnectionService';
import { useProjectStore } from '../stores/useProjectStore';
import { useUIStore } from '../stores/useUIStore';

/**
 * Project runtime for the next UI: save, appearance, Explorer mutations and project lifecycle,
 * without dock, tabs UI or Inspector.
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

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [isProjectDirectoryBusy, setIsProjectDirectoryBusy] = useState(false);
  const [navigationRecovery, setNavigationRecovery] = useState(false);
  const projectSessionRef = useRef(0);
  const projectOperationBusyRef = useRef(false);
  const projectOperationOriginRef = useRef<HTMLElement | null>(null);

  const explorer = useExplorerTree({
    openFile: async () => {},
  });
  const explorerMutations = useExplorerMutations({
    explorer,
    projectOperationBusyRef,
  });
  const lifecycle = useProjectLifecycle({
    workspace: { workspaceImages, setNavigationRecovery, setIsProjectDirectoryBusy },
    sessionRefs: { projectSessionRef, projectOperationBusyRef, projectOperationOriginRef },
    explorer,
    runExplorerMutation: explorerMutations.runExplorerMutation,
  });

  return {
    projectId, projectName, projectDirectoryHandle, projectDirectoryName,
    projectSave, appearance, localTaggerPicker, workspaceFileAssets, workspaceImages, workspaceReviewItems,
    settingsOpen, setSettingsOpen, projectSettingsOpen, setProjectSettingsOpen, versionsOpen, setVersionsOpen, activityOpen, setActivityOpen, explorer, explorerMutations, lifecycle, closeProject, datasetCount, isProjectDirectoryBusy, navigationRecovery,
  };
}
