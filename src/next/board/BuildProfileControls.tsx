import { PROJECT_TYPE_PROFILES, TARGET_MODEL_PRESETS } from '../../lib/projectProfiles';
import { useProjectStore } from '../../stores/useProjectStore';
import { CharacterTraitsEditor } from './CharacterTraitsEditor';
import type { ProjectType, TargetModelId } from '../../types';

/** Project type and target model; the model is the single source of the minimum short side. */
export function BuildProfileControls({ onModelChange, suggestions }: { onModelChange?: (model: TargetModelId) => void; suggestions?: readonly string[] }) {
  const projectType = useProjectStore((state) => state.projectType);
  const targetModel = useProjectStore((state) => state.targetModel);
  const setProjectProfile = useProjectStore((state) => state.setProjectProfile);
  const selectClass = 'min-h-[44px] rounded-md border border-border bg-background px-3 text-sm';
  return <div className="grid gap-3">
    <label className="grid gap-2 text-sm">Type <select aria-label="Project type" value={projectType} onChange={(event) => setProjectProfile({ projectType: event.target.value as ProjectType })} className={selectClass}>
      {(Object.keys(PROJECT_TYPE_PROFILES) as ProjectType[]).map((id) => <option key={id} value={id}>{PROJECT_TYPE_PROFILES[id].label}</option>)}
    </select></label>
    <label className="grid gap-2 text-sm">Model <select aria-label="Model" value={targetModel} onChange={(event) => {
      const model = event.target.value as TargetModelId;
      setProjectProfile({ targetModel: model });
      onModelChange?.(model);
    }} className={selectClass}>
      {(Object.keys(TARGET_MODEL_PRESETS) as TargetModelId[]).map((id) => <option key={id} value={id}>{TARGET_MODEL_PRESETS[id].label} (min {TARGET_MODEL_PRESETS[id].minShortSide}px)</option>)}
    </select></label>
    <CharacterTraitsEditor suggestions={suggestions} />
  </div>;
}
