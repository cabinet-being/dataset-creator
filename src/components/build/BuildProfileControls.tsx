import { PROJECT_TYPE_PROFILES, TARGET_MODEL_PRESETS } from '../../lib/projectProfiles';
import { useProjectStore } from '../../stores/useProjectStore';
import type { ProjectType, TargetModelId } from '../../types';

/** Project type and target model; the model is the single source of the minimum short side. */
export function BuildProfileControls({ onModelChange }: { onModelChange?: (model: TargetModelId) => void }) {
  const projectType = useProjectStore((state) => state.projectType);
  const targetModel = useProjectStore((state) => state.targetModel);
  const setProjectProfile = useProjectStore((state) => state.setProjectProfile);
  const selectClass = 'ml-1 rounded border border-border bg-background px-2 py-1';
  return <>
    <label>Type <select aria-label="Project type" value={projectType} onChange={(event) => setProjectProfile({ projectType: event.target.value as ProjectType })} className={selectClass}>
      {(Object.keys(PROJECT_TYPE_PROFILES) as ProjectType[]).map((id) => <option key={id} value={id}>{PROJECT_TYPE_PROFILES[id].label}</option>)}
    </select></label>
    <label>Model <select aria-label="Model" value={targetModel} onChange={(event) => {
      const model = event.target.value as TargetModelId;
      setProjectProfile({ targetModel: model });
      onModelChange?.(model);
    }} className={selectClass}>
      {(Object.keys(TARGET_MODEL_PRESETS) as TargetModelId[]).map((id) => <option key={id} value={id}>{TARGET_MODEL_PRESETS[id].label} (min {TARGET_MODEL_PRESETS[id].minShortSide}px)</option>)}
    </select></label>
  </>;
}
