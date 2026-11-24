export type AutoSelectStepId = 'sources' | 'find' | 'describe' | 'pick';
export type AutoSelectStepState = 'done' | 'ready' | 'locked' | 'running';
export type AutoSelectTask = 'find' | 'describe' | 'pick' | 'apply';

export type AutoSelectInput = {
  /** Images in the selected folders that the user has not rejected and that are outside the Dataset. */
  folderImages: number;
  /** Of those, how many already have a quality verdict. */
  analyzed: number;
  /** Images waiting for the automatic quality analysis. */
  pendingAnalysis: number;
  analysisPaused: boolean;
  /** Pool for "Find candidates": not rejected by the user or by quality triage. */
  poolSize: number;
  datasetCount: number;
  target: number;
  /** Auto mode: no target size; one image per group of similar ones. */
  auto?: boolean;
  /** A candidate list exists in the session, even if all its images were since decided by hand. */
  hasCandidates: boolean;
  /** Candidates still waiting for a decision. */
  candidates: number;
  /** Candidates that have caption tags or a suggestion. */
  described: number;
  /** Candidates the tagger can still describe. */
  taggable: number;
  /** Candidates picked as the most varied (still valid). */
  picks: number;
  duplicatesSkipped: number;
  unreadable: number;
  /** A background job is running; `task` says which one when it belongs to this panel. */
  taskRunning: boolean;
  task: AutoSelectTask | null;
};

export type AutoSelectStep = {
  id: AutoSelectStepId;
  state: AutoSelectStepState;
  /** Why the step is locked, or what is missing for a ready one. */
  reason?: string;
  counts: Record<string, number>;
};

export type AutoSelectSteps = {
  needed: number;
  /** How many images "Pick" will choose. */
  pickCount: number;
  undescribed: number;
  steps: AutoSelectStep[];
};

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Pure derivation of the guided Auto-select panel; nothing here touches the session. */
export function getAutoSelectSteps(input: AutoSelectInput): AutoSelectSteps {
  const auto = !!input.auto;
  const needed = auto ? 0 : Math.max(0, input.target - input.datasetCount);
  const undescribed = Math.max(0, input.candidates - input.described);
  const otherTask = input.taskRunning;
  const busyReason = 'Another task is running';
  const exhausted = input.hasCandidates && input.candidates === 0;

  const sourcesDone = input.folderImages > 0;
  const sources: AutoSelectStep = {
    id: 'sources', state: sourcesDone ? 'done' : 'ready',
    reason: sourcesDone ? undefined : 'No images in the selected folders',
    counts: { images: input.folderImages, analyzed: input.analyzed },
  };

  const findCounts = { found: input.candidates, duplicates: input.duplicatesSkipped, unreadable: input.unreadable, pool: input.poolSize, needed };
  let find: AutoSelectStep;
  if (input.task === 'find') find = { id: 'find', state: 'running', counts: findCounts };
  else if (input.hasCandidates) find = { id: 'find', state: 'done', counts: findCounts };
  else {
    const reason = !sourcesDone ? 'No images in the selected folders'
      : !auto && needed === 0 ? `The Dataset already has ${input.datasetCount} of ${input.target} images`
      : input.pendingAnalysis > 0 ? `Waiting for quality analysis (${input.pendingAnalysis} left)`
      : otherTask ? busyReason
      : input.poolSize === 0 ? 'No usable images in the selected folders'
      : undefined;
    find = { id: 'find', state: reason ? 'locked' : 'ready', reason, counts: findCounts };
  }

  const describeCounts = { candidates: input.candidates, described: input.described, undescribed, taggable: input.taggable };
  let describe: AutoSelectStep;
  if (input.task === 'describe') describe = { id: 'describe', state: 'running', counts: describeCounts };
  else if (!input.hasCandidates) describe = { id: 'describe', state: 'locked', reason: 'Find candidates first', counts: describeCounts };
  else if (exhausted || undescribed === 0 || input.taggable === 0) describe = { id: 'describe', state: 'done', counts: describeCounts };
  else if (otherTask) describe = { id: 'describe', state: 'locked', reason: busyReason, counts: describeCounts };
  else describe = { id: 'describe', state: 'ready', counts: describeCounts };

  const pickCount = auto ? input.candidates : Math.min(needed, input.candidates);
  const pickCounts = { picks: input.picks, pickCount, undescribed, needed };
  let pick: AutoSelectStep;
  if (input.task === 'pick' || input.task === 'apply') pick = { id: 'pick', state: 'running', counts: pickCounts };
  else if (exhausted) pick = { id: 'pick', state: 'done', counts: pickCounts };
  else if (!input.hasCandidates) pick = { id: 'pick', state: 'locked', reason: 'Find candidates first', counts: pickCounts };
  else if (!auto && needed === 0) pick = { id: 'pick', state: 'locked', reason: 'Target reached', counts: pickCounts };
  else if (input.picks > 0) pick = { id: 'pick', state: 'done', counts: pickCounts };
  else if (!auto && input.described === 0) pick = { id: 'pick', state: 'locked', reason: 'Describe candidates first', counts: pickCounts };
  else if (otherTask) pick = { id: 'pick', state: 'locked', reason: busyReason, counts: pickCounts };
  else pick = {
    id: 'pick', state: 'ready', counts: pickCounts,
    reason: undescribed > 0 ? `${plural(undescribed, 'candidate has', 'candidates have')} no tags; they are compared by appearance only` : undefined,
  };

  return { needed, pickCount, undescribed, steps: [sources, find, describe, pick] };
}
