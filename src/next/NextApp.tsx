import { FolderOpen, FolderPlus } from 'lucide-react';
import { ProjectSetupDialog } from '../components/ProjectSetupDialog';
import { ProjectUpgradeDialog } from '../components/ProjectUpgradeDialog';
import { PhotopeaPsdPreviewWorker } from '../components/photopea/PhotopeaFrame';
import { Button } from '../components/ui/button';
import { useCommandPalette } from '../components/workspace/Commands';
import { AppShell } from '../components/workspace/AppShell';
import { WorkspaceNotifications } from '../components/workspace/WorkspaceNotifications';
import { WorkspaceStatusBar } from '../components/workspace/WorkspaceStatusBar';
import { useNextCommands } from './useNextCommands';
import { useProjectRuntime } from './useProjectRuntime';

/** Root of the rewritten UI. It is mounted instead of the classic App, never next to it. */
export default function NextApp() {
  const runtime = useProjectRuntime();
  const openCommands = useCommandPalette();
  useNextCommands(runtime, () => openCommands(true));
  const { lifecycle, projectDirectoryHandle, projectDirectoryName, projectName, projectSave, workspaceImages, isProjectDirectoryBusy } = runtime;
  const { projectSetup, layoutUpgrade } = lifecycle;

  return <AppShell
    busy={isProjectDirectoryBusy}
    setupDialog={projectSetup
      ? <ProjectSetupDialog name={projectSetup.name} migration={projectSetup.migration} onComplete={projectSetup.complete} />
      : layoutUpgrade
        ? <ProjectUpgradeDialog name={layoutUpgrade.name} plan={layoutUpgrade.plan} rawPlan={layoutUpgrade.rawPlan} blockedReason={layoutUpgrade.blockedReason} onComplete={layoutUpgrade.complete} />
        : null}
    backgroundTasks={<PhotopeaPsdPreviewWorker active={Boolean(projectDirectoryHandle)} />}
    header={<header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card px-4">
      <h1 className="mr-auto text-base font-semibold tracking-tight">Dataset Creator</h1>
      <Button variant="outline" size="sm" onClick={() => void lifecycle.handleOpenProject()}><FolderOpen className="h-4 w-4" />Open project</Button>
      <Button size="sm" onClick={() => void lifecycle.handleNewProject()}><FolderPlus className="h-4 w-4" />New project</Button>
    </header>}
    footer={<WorkspaceStatusBar projectName={projectName} save={projectSave}
      onFocusOperation={() => {}} onOutput={() => {}} onHelp={() => openCommands(true)} />}
    overlays={<>
      {runtime.localTaggerPicker.inputs}
      <WorkspaceNotifications />
    </>}
  >
    <div data-next-app className="flex flex-1 items-center justify-center p-6">
      {projectDirectoryHandle
        ? <div className="space-y-1 text-center">
          <h2 data-next-project-name className="text-xl font-semibold">{projectDirectoryName ?? projectName}</h2>
          <p data-next-image-count className="text-sm text-muted-foreground">{workspaceImages.length} {workspaceImages.length === 1 ? 'image' : 'images'}</p>
        </div>
        : <p className="text-sm text-muted-foreground">Open or create a project to begin.</p>}
    </div>
  </AppShell>;
}
