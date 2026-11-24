import type { ProjectType } from '../types';
import { PROFILE_RULES, type CoverageAxisId, type TagPolicy } from './projectProfilePresets';

export * from './projectProfilePresets';

export interface ProjectTypeProfile {
  label: string;
  description: string;
  defaults: { datasetName: string; triggerWord: string };
  labels: { workspace: string; emptyDatasets: string };
  flags: Readonly<Record<string, boolean>>;
  coverageAxes: readonly CoverageAxisId[];
  tagPolicy: TagPolicy;
}
type ProfileBase = Omit<ProjectTypeProfile, 'coverageAxes' | 'tagPolicy'>;
const withRules = (type: ProjectType, base: ProfileBase): ProjectTypeProfile => ({ ...base, ...PROFILE_RULES[type] });
const PROFILE_BASES: Record<ProjectType, ProfileBase> = {
  general: {
    label: 'General', description: 'No specific subject: a general-purpose dataset.',
    defaults: { datasetName: 'New Dataset', triggerWord: '' },
    labels: { workspace: 'Dataset Workspace', emptyDatasets: 'Create a dataset.' }, flags: {},
  },
  character: {
    label: 'Character', description: 'Build datasets around a consistent character or identity.',
    defaults: { datasetName: 'New Dataset', triggerWord: '' },
    labels: { workspace: 'Character Workspace', emptyDatasets: 'Create a dataset for your character.' }, flags: {},
  },
  style: {
    label: 'Style', description: 'Capture a visual style, aesthetic, or artistic treatment.',
    defaults: { datasetName: 'Style Dataset', triggerWord: 'mystyle' },
    labels: { workspace: 'Style Workspace', emptyDatasets: 'Create a dataset for your visual style.' }, flags: {},
  },
  concept: {
    label: 'Concept', description: 'Explore an object, theme, or visual concept.',
    defaults: { datasetName: 'Concept Dataset', triggerWord: 'myconcept' },
    labels: { workspace: 'Concept Workspace', emptyDatasets: 'Create a dataset for your concept.' }, flags: {},
  },
};
export const PROJECT_TYPE_PROFILES: Record<ProjectType, ProjectTypeProfile> = Object.fromEntries(
  (Object.keys(PROFILE_BASES) as ProjectType[]).map((type) => [type, withRules(type, PROFILE_BASES[type])]),
) as Record<ProjectType, ProjectTypeProfile>;
export const isProjectType = (value: unknown): value is ProjectType =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROJECT_TYPE_PROFILES, value);
/** Manifests written before project types existed open as `general` without a prompt. */
export const normalizeProjectType = (value: unknown): ProjectType => {
  if (value === undefined) return 'general';
  if (isProjectType(value)) return value;
  throw new Error('Unsupported project type in manifest.');
};
export type ProjectTypeResolver = (name: string) => Promise<ProjectType>;
export const resolveProjectType = async (value: unknown, name: string, select?: ProjectTypeResolver): Promise<ProjectType> => {
  if (isProjectType(value)) return value;
  if (value !== undefined) throw new Error('Unsupported project type in manifest.');
  if (!select) throw new Error('This project needs a project type selection before opening.');
  const selected = await select(name);
  if (!isProjectType(selected)) throw new Error('Select a valid project type.');
  return selected;
};
