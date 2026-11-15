import { useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { WorkspaceMenu } from '../components/workspace/WorkspaceMenus';
import type { WorkspaceImage } from '../lib/workspaceImages';
import type { WorkspaceTab } from '../lib/workspaceTabs';
import { EXPLORER_VIEW } from '../lib/workspaceLayout';
import { isAbortError } from '../lib/utils';
import { rewriteWorkspaceTabPaths } from '../lib/workspacePersistence';
import { PROJECT_LAYOUT } from '../services/project/projectLayoutService';
import {
  createProjectDirectory,
  clearProjectDirectory,
  countProjectDirectoryFiles,
  listProjectDirectoryClearTargets,
  pickProjectDirectory,
  projectDirectoryHasManifest,
  readProjectDirectory,
  type ProjectDirectoryHandle,
} from '../services/project/projectDirectoryService';
import { createProjectVersion, getProjectVersionLayout, listProjectVersions, restoreProjectVersion, ProjectVersionRestoreError, type ProjectVersion } from '../services/project/projectVersionService';
import { LayoutMigrationError, detectLegacyRawLayout, detectProjectLayout, planLayoutMigration, planRawMaterialsMove, resumePendingJournals, runCaptionTxtMigration, runLayoutMigration, runRawMaterialsMove, type CaptionTxtReport, type LayoutMigrationPlan, type RawMaterialsPlan, type RawMaterialsReport } from '../services/project/layoutMigrationService';
import { indexProjectAssets } from '../services/project/assetIndexService';
import { createOperationLogger } from '../services/logging/applicationLog';
import { createProject, type ProjectState, type ProjectType, type TargetModelId } from '../types';
import { isOperationRunning, useOperationStore } from '../stores/useOperationStore';
import { useHistoryStore } from '../stores/useHistoryStore';
import { useProjectStore } from '../stores/useProjectStore';
import { useUIStore } from '../stores/useUIStore';
import { flushProjectSave, runProjectFileOperation } from './useProjectSave';
import type { useExplorerTree } from './useExplorerTree';
import type { useExplorerMutations } from './useExplorerMutations';
import type { useDockWorkspace } from './useDockWorkspace';

interface UseProjectLifecycleParams {
  workspace: {
    openTabs: WorkspaceTab[];
    workspaceImages: WorkspaceImage[];
    dock: ReturnType<typeof useDockWorkspace>;
    setOpenMenu: Dispatch<SetStateAction<WorkspaceMenu | null>>;
    setActiveActivityView: Dispatch<SetStateAction<'explorer' | 'versions'>>;
    setClosedTabs: Dispatch<SetStateAction<WorkspaceTab[]>>;
    setNavigationRecovery: Dispatch<SetStateAction<boolean>>;
    applyWorkspaceTabsForProject: (project: ProjectState) => void;
    confirmClosingTabs: (tabs: WorkspaceTab[]) => Promise<boolean>;
    focusView: (id: string) => void;
    setIsProjectDirectoryBusy: Dispatch<SetStateAction<boolean>>;
  };
  sessionRefs: {
    projectSessionRef: MutableRefObject<number>;
    projectOperationBusyRef: MutableRefObject<boolean>;
    persistWorkspaceRef: MutableRefObject<(() => void) | null>;
    projectOperationOriginRef: MutableRefObject<HTMLElement | null>;
  };
  explorer: ReturnType<typeof useExplorerTree>;
  runExplorerMutation: ReturnType<typeof useExplorerMutations>['runExplorerMutation'];
}

export function useProjectLifecycle({ workspace, sessionRefs, explorer, runExplorerMutation }: UseProjectLifecycleParams) {
  const {
    openTabs, workspaceImages, dock, setOpenMenu, setActiveActivityView, setClosedTabs, setNavigationRecovery,
    applyWorkspaceTabsForProject, confirmClosingTabs, focusView, setIsProjectDirectoryBusy,
  } = workspace;
  const { projectSessionRef, projectOperationBusyRef, persistWorkspaceRef, projectOperationOriginRef } = sessionRefs;
  const { refreshExplorer } = explorer;
  const projectName = useProjectStore((state) => state.name);
  const loadProject = useProjectStore((state) => state.loadProject);
  const renameProject = useProjectStore((state) => state.renameProject);
  const addSourceImage = useProjectStore((state) => state.addSourceImage);
  const addNotification = useUIStore(state => state.addNotification);
  const projectDirectoryHandle = useUIStore(state => state.projectDirectoryHandle);
  const setProjectDirectory = useUIStore(state => state.setProjectDirectory);
  const [projectSetup, setProjectSetup] = useState<{ name: string; migration: boolean; complete: (value: { name: string; projectType: ProjectType; targetModel: TargetModelId } | null) => void } | null>(null);
  const requestProjectSetup = (name: string, migration: boolean) => new Promise<{ name: string; projectType: ProjectType; targetModel: TargetModelId } | null>((resolve) => {
    setProjectSetup({ name, migration, complete: (value) => { setProjectSetup(null); resolve(value); } });
  });
  const [layoutUpgrade, setLayoutUpgrade] = useState<{ name: string; plan?: LayoutMigrationPlan; rawPlan?: RawMaterialsPlan; blockedReason?: string; complete: (proceed: boolean) => void } | null>(null);
  const requestLayoutUpgrade = (name: string, plan: LayoutMigrationPlan, blockedReason?: string) => new Promise<boolean>((resolve) => {
    setLayoutUpgrade({ name, plan, blockedReason, complete: (upgrade) => { setLayoutUpgrade(null); resolve(upgrade); } });
  });
  const requestRawMaterialsMove = (name: string, rawPlan: RawMaterialsPlan) => new Promise<boolean>((resolve) => {
    setLayoutUpgrade({ name, rawPlan, complete: (proceed) => { setLayoutUpgrade(null); resolve(proceed); } });
  });
  const [projectVersions, setProjectVersions] = useState<ProjectVersion[]>([]);
  const [currentProjectVersionId, setCurrentProjectVersionId] = useState<string | undefined>();
  const [newVersionName, setNewVersionName] = useState('');

  const handleProjectFileError = (error: unknown, message: string) => {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return;
    }
    addNotification('error', error instanceof Error ? error.message : message);
  };

  const activateProjectDirectory = (directory: ProjectDirectoryHandle, project: ProjectState) => {
    persistWorkspaceRef.current?.();
    setNavigationRecovery(false);
    projectSessionRef.current += 1;
    setProjectDirectory(undefined);
    loadProject(project);
    setClosedTabs([]);
    useHistoryStore.setState({past:[],future:[]});
    applyWorkspaceTabsForProject(project);
    setProjectDirectory({handle:directory,name:directory.name});
  };

  const indexActiveProject = async (directory: ProjectDirectoryHandle, expectedProjectId: string) => {
    const operations = useOperationStore.getState();
    const operationId = `project-index:${crypto.randomUUID()}`;
    operations.start({id:operationId,viewId:EXPLORER_VIEW,label:'Index project files'});
    try {
      await runProjectFileOperation(async () => {
        await indexProjectAssets(directory, {
          logger: createOperationLogger('Index'),
          existingSourceImages: useProjectStore.getState().sourceImages,
          triggerWord: useProjectStore.getState().dataset.triggerWord,
          onAssetIndexed: ({sourceImage}) => {
            const current = useProjectStore.getState();
            if (current.id !== expectedProjectId || useUIStore.getState().projectDirectoryHandle !== directory) {
              throw new DOMException('Project changed during indexing', 'AbortError');
            }
            if (sourceImage && !current.sourceImages[sourceImage.id]) addSourceImage(sourceImage);
            refreshExplorer();
          },
          onProgress: (completed,total) => operations.update(operationId,{completed,total}),
        });
      });
      operations.finish(operationId,'completed');
      refreshExplorer();
    } catch (error) {
      operations.finish(operationId,'failed',error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  const canSwitchProject = async () => {
    if (useHistoryStore.getState().busy) { addNotification('warning', 'Wait for Undo or Redo to finish saving.'); return false; }
    const running = useOperationStore.getState().entries.find(isOperationRunning);
    if (!running) return confirmClosingTabs(openTabs);
    addNotification('warning', `Finish or cancel ${running.label} before switching projects.`); focusView(running.viewId); return false;
  };

  const handleNewProject = async () => {
    if (!await canSwitchProject()) return;
    if (projectOperationBusyRef.current) {
      return;
    }
    const logger = createOperationLogger('Project');
    setOpenMenu(null);
    if (workspaceImages.length > 0 && !window.confirm('Create a new project and clear the current workspace?')) {
      return;
    }

    projectOperationBusyRef.current = true;
    projectOperationOriginRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setIsProjectDirectoryBusy(true);
    try {
      const setup = await requestProjectSetup('Untitled Project', false);
      if (!setup) {
        logger.warning('new project canceled');
        return;
      }

      const { name: nextName, projectType, targetModel } = setup;
      const parentDirectory = await pickProjectDirectory();
      logger.info(`creating project directory ${nextName}`);
      const directory = await parentDirectory.getDirectoryHandle(nextName, { create: true });
      const hasManifest = await projectDirectoryHasManifest(directory);
      if (hasManifest && !window.confirm(`Overwrite the Dataset Creator project in "${nextName}"?`)) {
        logger.warning(`new project canceled before overwriting ${nextName}`);
        return;
      }
      else if (!hasManifest) {
        const targets = await listProjectDirectoryClearTargets(directory);
        if (targets.length > 0 && !window.confirm(`The folder "${nextName}" is not a DatasetCreator project but contains entries that will be permanently deleted: ${targets.join(', ')}. Continue?`)) {
          logger.warning(`new project canceled before clearing ${nextName}`);
          return;
        }
      }
      await flushProjectSave();
      const project = createProject(nextName, projectType, targetModel);
      logger.info('writing project manifest and folders');
      const create = async () => {
        await clearProjectDirectory(directory);
        await createProjectDirectory(directory, project);
        activateProjectDirectory(directory, project);
      };
      if (projectDirectoryHandle) await runProjectFileOperation(create);
      else await create();
      logger.success(`created project directory ${directory.name}`);
      addNotification('success', 'New project directory created');
    } catch (error) {
      if (!isAbortError(error)) {
        logger.error(error instanceof Error ? error.message : 'failed to create project directory');
      }
      handleProjectFileError(error, 'Failed to create project directory');
    } finally {
      projectOperationBusyRef.current = false;
      setIsProjectDirectoryBusy(false);
    }
  };

  const openProjectDirectory = async (directory: ProjectDirectoryHandle) => {
    const logger = createOperationLogger('Project');
    logger.info(`opening project directory ${directory.name}`);
    await flushProjectSave();
    const previousProject = useProjectStore.getState();
    // The upgrade is confirmed before anything is read or written, and it runs outside runProjectFileOperation
    // (the caller already holds projectOperationBusyRef; no project is active for this directory yet).
    const layout = await detectProjectLayout(directory);
    let rawMaterials: RawMaterialsReport | undefined;
    let captions: CaptionTxtReport | undefined;
    if (layout === 'v3') {
      await resumePendingJournals(directory);
      if (await detectLegacyRawLayout(directory)) {
        // Raw materials moved from src/ to inbox/ in this layout version; files are listed in the dialog only when there are any.
        const rawPlan = await planRawMaterialsMove(directory);
        if (rawPlan.fileCount > 0 && !await requestRawMaterialsMove(directory.name, rawPlan)) {
          logger.warning(`raw materials move canceled for ${directory.name}`);
          throw new DOMException('Project opening canceled', 'AbortError');
        }
        rawMaterials = await runRawMaterialsMove(directory, { onProgress: ({ phase }) => logger.info(phase) });
      }
      // Sidecar tags become TXT captions (once per project); files that are replaced are kept in the service folder's backup.
      captions = await runCaptionTxtMigration(directory, { onProgress: ({ phase }) => logger.info(phase) });
    } else if (layout === 'v2') {
      const plan = await planLayoutMigration(directory);
      if (!await requestLayoutUpgrade(directory.name, plan)) {
        logger.warning(`project upgrade canceled for ${directory.name}`);
        throw new DOMException('Project opening canceled', 'AbortError');
      }
      try {
        const report = await runLayoutMigration(directory, { onProgress: ({ phase }) => logger.info(phase) });
        rawMaterials = report.rawMaterials;
        captions = report.captions;
        logger.success(`upgraded project layout of ${directory.name}`);
      } catch (error) {
        if (!(error instanceof LayoutMigrationError) || error.kind !== 'blocked') throw error;
        // No v3 step ran: opening continues through the legacy (manifest.json v2) reader so the conflicts can be resolved.
        if (!await requestLayoutUpgrade(directory.name, plan, error.message)) {
          logger.warning(`project opening canceled for ${directory.name}`);
          throw new DOMException('Project opening canceled', 'AbortError');
        }
        logger.warning(`opening ${directory.name} without upgrading`);
      }
    }
    const project = await readProjectDirectory(directory, async (name) => {
      const fileCount = await countProjectDirectoryFiles(directory);
      if (!window.confirm(`This folder is not a DatasetCreator project. Create a project here? ${fileCount} file${fileCount === 1 ? '' : 's'} will be indexed and may get caption sidecar files.`)) {
        throw new DOMException('Project opening canceled', 'AbortError');
      }
      const setup = await requestProjectSetup(name, true);
      if (!setup) throw new DOMException('Project opening canceled', 'AbortError');
      return setup.projectType;
    });
    if (useProjectStore.getState() !== previousProject) {
      throw new Error('The current project changed while opening the folder. Open it again after your changes are saved.');
    }
    if (rawMaterials) {
      rewriteWorkspaceTabPaths(project.id, rawMaterials.pathMoves);
      if (rawMaterials.collisions.length) {
        addNotification('warning', `${rawMaterials.collisions.length} file${rawMaterials.collisions.length === 1 ? ' was' : 's were'} renamed while moving raw materials to ${PROJECT_LAYOUT.rawDir}/ because the name was taken.`);
        for (const { from, to } of rawMaterials.collisions) logger.warning(`renamed ${from} to ${to}`);
      }
    }
    if (captions) {
      if (captions.pathMoves.length) rewriteWorkspaceTabPaths(project.id, captions.pathMoves);
      if (captions.converted || captions.triggersAdded) logger.info(`captions: ${captions.converted} converted to text files, trigger word added to ${captions.triggersAdded}; replaced files are in ${PROJECT_LAYOUT.backupDir}/${captions.journalId}/captions`);
      if (captions.collisions.length) {
        addNotification('warning', `${captions.collisions.length} image${captions.collisions.length === 1 ? ' was' : 's were'} renamed because another image in the folder had the same name before the extension (captions are stored as <name>.txt).`);
        for (const { from, to } of captions.collisions) logger.warning(`renamed ${from} to ${to}`);
      }
    }
    activateProjectDirectory(directory, project);
    await indexActiveProject(directory, project.id);
    logger.success(`opened project directory ${directory.name}`);
    addNotification('success', 'Project directory opened');
  };

  const handleOpenProject = async () => {
    if (!await canSwitchProject()) return;
    if (projectOperationBusyRef.current) {
      return;
    }
    projectOperationBusyRef.current = true;
    projectOperationOriginRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpenMenu(null);
    setIsProjectDirectoryBusy(true);
    try {
      const directory = await pickProjectDirectory();
      await openProjectDirectory(directory);
    } catch (error) {
      if (!isAbortError(error)) {
        createOperationLogger('Project').error(
          error instanceof Error ? error.message : 'failed to open project directory'
        );
      }
      handleProjectFileError(error, 'Failed to open project directory');
    } finally {
      projectOperationBusyRef.current = false;
      setIsProjectDirectoryBusy(false);
    }
  };

  const handleRenameProject = () => {
    setOpenMenu(null);
    const nextName = window.prompt('Project name', projectName)?.trim();
    if (!nextName || nextName === projectName) {
      return;
    }

    renameProject(nextName);
    addNotification('success', 'Project renamed');
  };

  const openProjectVersions = async () => {
    setActiveActivityView('versions');
    dock.show(EXPLORER_VIEW);
    if (!projectDirectoryHandle) {
      addNotification('warning', 'Open a project directory before managing versions');
      return;
    }
    try {
      const { currentId, versions } = await listProjectVersions(projectDirectoryHandle);
      setCurrentProjectVersionId(currentId);
      setProjectVersions(versions);
      setOpenMenu(null);
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : 'Failed to read project versions');
    }
  };

  const handleCreateProjectVersion = async () => {
    if (!projectDirectoryHandle || !newVersionName.trim()) {
      return;
    }
    try {
      const version = await runExplorerMutation('Create project version', () => createProjectVersion(projectDirectoryHandle, newVersionName));
      setProjectVersions((versions) => [...versions, version]);
      setCurrentProjectVersionId(version.id);
      setNewVersionName('');
      addNotification('success', `Created version ${version.name}`);
    } catch (error) {
      addNotification('error', error instanceof Error ? error.message : 'Failed to create project version');
    }
  };

  const handleRestoreProjectVersion = async (version: ProjectVersion) => {
    if (!projectDirectoryHandle || projectOperationBusyRef.current || !await canSwitchProject()) return;
    let needsUpgrade = false;
    try { needsUpgrade = await getProjectVersionLayout(projectDirectoryHandle, version.id) === 'legacy'; }
    catch (error) { addNotification('error', error instanceof Error ? error.message : 'Failed to read the project version'); return; }
    if (!window.confirm(`Restore project version "${version.name}"? Current changes will be replaced.${needsUpgrade ? ' This version uses the previous project layout, so the project will be upgraded to the current layout right after restoring (a new safety snapshot is saved first).' : ''}`)) return;
    const directory = projectDirectoryHandle;
    const operations = useOperationStore.getState();
    const operationId = `project-restore:${crypto.randomUUID()}`;
    projectOperationBusyRef.current = true;
    projectOperationOriginRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setIsProjectDirectoryBusy(true);
    operations.start({id:operationId,viewId:EXPLORER_VIEW,label:'Restore project version'});
    try {
      await runProjectFileOperation(async () => {
        let restoredOnDisk = false;
        try {
          let project!: ProjectState;
          await restoreProjectVersion(directory, version.id, async () => { project = await readProjectDirectory(directory); });
          restoredOnDisk = true;
          if (await detectProjectLayout(directory) === 'v2') {
            const report = await runLayoutMigration(directory);
            project = await readProjectDirectory(directory);
            if (report.rawMaterials) rewriteWorkspaceTabPaths(project.id, report.rawMaterials.pathMoves);
            if (report.captions?.pathMoves.length) rewriteWorkspaceTabPaths(project.id, report.captions.pathMoves);
            const refreshed = await listProjectVersions(directory);
            setProjectVersions(refreshed.versions);
          } else if (await detectLegacyRawLayout(directory)) {
            const rawMaterials = await runRawMaterialsMove(directory);
            project = await readProjectDirectory(directory);
            if (rawMaterials) rewriteWorkspaceTabPaths(project.id, rawMaterials.pathMoves);
          }
          if (await detectProjectLayout(directory) === 'v3') {
            const captions = await runCaptionTxtMigration(directory);
            if (captions) {
              project = await readProjectDirectory(directory);
              if (captions.pathMoves.length) rewriteWorkspaceTabPaths(project.id, captions.pathMoves);
            }
          }
          activateProjectDirectory(directory, project);
        } catch (error) {
          // Stop the old queue before its finally block can write over a partial restore.
          if (restoredOnDisk || (error instanceof ProjectVersionRestoreError && !error.previousRestored)) {
            setProjectDirectory(undefined);
          }
          throw error;
        }
      });
      await indexActiveProject(directory, useProjectStore.getState().id);
      setCurrentProjectVersionId(version.id);
      operations.finish(operationId,'completed');
      addNotification('success', `Restored version ${version.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to restore project version';
      operations.finish(operationId,'failed',message);
      addNotification('error', message);
    } finally {
      projectOperationBusyRef.current = false;
      setIsProjectDirectoryBusy(false);
    }
  };

  return {
    projectSetup, layoutUpgrade, projectVersions, currentProjectVersionId, newVersionName, setNewVersionName,
    handleNewProject, handleOpenProject, handleRenameProject, openProjectVersions,
    handleCreateProjectVersion, handleRestoreProjectVersion,
  };
}
