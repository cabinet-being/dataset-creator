import { WORKFLOW_TOOLS } from './constants';
import type { ProjectType, ToolName } from '../types';

export interface ProjectTypeProfile {
  label: string;
  description: string;
  enabledTools: readonly ToolName[];
  defaults: { datasetName: string; triggerWord: string; datasetKeyword: string };
  labels: { workspace: string; emptyDatasets: string };
  flags: Readonly<Record<string, boolean>>;
}
const tools = WORKFLOW_TOOLS;
export const PROJECT_TYPE_PROFILES: Record<ProjectType, ProjectTypeProfile> = {
  character: {
    label: 'Character', description: 'Build datasets around a consistent character or identity.', enabledTools: tools,
    defaults: { datasetName: 'New Dataset', triggerWord: '', datasetKeyword: 'dataset' },
    labels: { workspace: 'Character Workspace', emptyDatasets: 'Create a dataset for your character.' }, flags: {},
  },
  style: {
    label: 'Style', description: 'Capture a visual style, aesthetic, or artistic treatment.', enabledTools: tools,
    defaults: { datasetName: 'Style Dataset', triggerWord: 'mystyle', datasetKeyword: 'mystyle' },
    labels: { workspace: 'Style Workspace', emptyDatasets: 'Create a dataset for your visual style.' }, flags: {},
  },
  concept: {
    label: 'Concept', description: 'Explore an object, theme, or visual concept.', enabledTools: tools,
    defaults: { datasetName: 'Concept Dataset', triggerWord: 'myconcept', datasetKeyword: 'myconcept' },
    labels: { workspace: 'Concept Workspace', emptyDatasets: 'Create a dataset for your concept.' }, flags: {},
  },
};
export const isProjectType = (value: unknown): value is ProjectType =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROJECT_TYPE_PROFILES, value);
export type ProjectTypeResolver = (name: string) => Promise<ProjectType>;
export const resolveProjectType = async (value: unknown, name: string, select?: ProjectTypeResolver): Promise<ProjectType> => {
  if (isProjectType(value)) return value;
  if (value !== undefined) throw new Error('Unsupported project type in manifest.');
  if (!select) throw new Error('This project needs a project type selection before opening.');
  const selected = await select(name);
  if (!isProjectType(selected)) throw new Error('Select a valid project type.');
  return selected;
};
