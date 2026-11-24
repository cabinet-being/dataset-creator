import { useCommands, type Command } from '../components/workspace/Commands';
import { useDocumentStateStore } from '../stores/useDocumentStateStore';
import { useHistoryStore } from '../stores/useHistoryStore';
import { PHOTOPEA_OVERLAY_VIEW } from './board/toolOverlays';
import type { useProjectRuntime } from './useProjectRuntime';

type Runtime = ReturnType<typeof useProjectRuntime>;

/** Global commands of the next UI; Undo, Redo and Save keep the shortcuts of the classic UI. */
export function useNextCommands(runtime: Runtime, openHelp: () => void) {
  const history = useHistoryStore();
  const { lifecycle, projectSave, appearance, projectDirectoryHandle, isProjectDirectoryBusy } = runtime;
  // While the Photopea overlay is open, Mod+S saves its document (the CleanupTool command), not the project.
  const photopeaOpen = useDocumentStateStore(state => Boolean(state.documents[PHOTOPEA_OVERLAY_VIEW]));
  const noProject = !projectDirectoryHandle;
  const commands: Command[] = [
    { id: 'history.undo', label: `Undo${history.past.length ? ' · ' + history.past[history.past.length - 1].label : ''}`, shortcut: 'Mod+Z', disabled: !history.past.length || history.busy, run: history.undo },
    { id: 'history.redo', label: 'Redo', shortcut: 'Mod+Shift+Z', disabled: !history.future.length || history.busy, run: history.redo },
    { id: 'project.save', label: 'Save project', shortcut: 'Mod+S', shortcutEnabled: !photopeaOpen, allowInInput: true, disabled: noProject, reason: noProject ? 'Open a project directory first' : undefined, run: projectSave.retry },
    { id: 'project.new', label: 'New project', disabled: isProjectDirectoryBusy, run: lifecycle.handleNewProject },
    { id: 'project.open', label: 'Open project', disabled: isProjectDirectoryBusy, run: lifecycle.handleOpenProject },
    { id: 'settings', label: 'Settings', run: () => runtime.setSettingsOpen(true) },
    { id: 'help', label: 'Keyboard shortcuts', run: openHelp },
    ...(['system', 'light', 'dark'] as const).map(mode => ({ id: `theme.${mode}`, label: `Theme: ${mode}`, run: () => appearance.setTheme(mode) })),
  ];
  useCommands(commands.map(command => isProjectDirectoryBusy ? { ...command, disabled: true, reason: 'Wait for the project operation to finish' } : command));
}
