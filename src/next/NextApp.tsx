import { ProjectSetupDialog } from '../components/ProjectSetupDialog';
import { ProjectUpgradeDialog } from '../components/ProjectUpgradeDialog';
import { PhotopeaPsdPreviewWorker } from '../components/photopea/PhotopeaFrame';
import { useCommandPalette } from '../components/workspace/Commands';
import { AppShell } from '../components/workspace/AppShell';
import { WorkspaceNotifications } from '../components/workspace/WorkspaceNotifications';
import { WorkspaceStatusBar } from '../components/workspace/WorkspaceStatusBar';
import { BoardScreen } from './screens/BoardScreen';
import { ProjectsScreen } from './screens/ProjectsScreen';
import { useNextCommands } from './useNextCommands';
import { useProjectRuntime } from './useProjectRuntime';

/** Root of the rewritten UI. It is mounted instead of the classic App, never next to it. */
export default function NextApp() {
  const runtime = useProjectRuntime();
  const openCommands = useCommandPalette();
  useNextCommands(runtime, () => openCommands(true));
  const { lifecycle, projectDirectoryHandle, projectId, projectName, projectSave, isProjectDirectoryBusy } = runtime;
  const { projectSetup, layoutUpgrade } = lifecycle;

  return <AppShell
    busy={isProjectDirectoryBusy}
    setupDialog={projectSetup
      ? <ProjectSetupDialog name={projectSetup.name} migration={projectSetup.migration} onComplete={projectSetup.complete} />
      : layoutUpgrade
        ? <ProjectUpgradeDialog name={layoutUpgrade.name} plan={layoutUpgrade.plan} rawPlan={layoutUpgrade.rawPlan} blockedReason={layoutUpgrade.blockedReason} onComplete={layoutUpgrade.complete} />
        : null}
    backgroundTasks={<PhotopeaPsdPreviewWorker active={Boolean(projectDirectoryHandle)} />}
    header={projectDirectoryHandle ? null : <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card px-4">
      <h1 className="mr-auto text-base font-semibold tracking-tight">Dataset Creator</h1>
    </header>}
    footer={<WorkspaceStatusBar projectName={projectName} save={projectSave}
      onFocusOperation={() => {}} onOutput={() => {}} onHelp={() => openCommands(true)} />}
    overlays={<>
      {runtime.localTaggerPicker.inputs}
      <WorkspaceNotifications />
    </>}
  >
    {projectDirectoryHandle
      ? <div data-next-app className="flex min-h-0 flex-1 flex-col"><BoardScreen key={projectId} runtime={runtime} /></div>
      : <div data-next-app className="flex min-h-0 flex-1 flex-col"><ProjectsScreen runtime={runtime} /></div>}
  </AppShell>;
}
