import { WorkspaceSettingsDialog } from '../../components/workspace/WorkspaceSettingsDialog';
import { useCommandPalette } from '../../components/workspace/Commands';
import type { SimilarityStrictnessId } from '../../services/similarity/similarityLevels';
import { restoreSavedLocalTagger } from '../../services/tagging/localTaggerConnectionService';
import { useProjectStore } from '../../stores/useProjectStore';
import type { useProjectRuntime } from '../useProjectRuntime';

/** Settings of the next UI: the shared dialog without tool shortcuts; `strictness` is given only while a project is open. */
export function NextSettingsDialog({ runtime, strictness }: { runtime: ReturnType<typeof useProjectRuntime>; strictness?: { value: SimilarityStrictnessId; onChange: (value: SimilarityStrictnessId) => void } }) {
  const openCommands = useCommandPalette();
  const settings = useProjectStore(state => state.workspaceSettings);
  const updateSettings = useProjectStore(state => state.updateWorkspaceSettings);
  const { appearance, settingsOpen, setSettingsOpen, localTaggerPicker } = runtime;
  return <WorkspaceSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen}
    theme={appearance.theme} onThemeChange={appearance.setTheme} density={appearance.density} onDensityChange={appearance.setDensity}
    settings={settings} onSettingsChange={updateSettings}
    onPickTaggerFile={kind => void localTaggerPicker.pickLocalTaggerFile(kind)}
    onRestoreTaggerAccess={() => void restoreSavedLocalTagger(true)}
    onShortcuts={() => openCommands(true)} strictness={strictness} />;
}
