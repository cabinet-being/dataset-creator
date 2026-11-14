// Pure profile data (leaf module: type-only imports, no constants/UI). Public owner is projectProfiles.ts.
import type { ProjectType, TargetModelId } from '../types/entities';

export interface AspectBucket { id: string; width: number; height: number }
export interface TargetModelPreset { label: string; minShortSide: number; buckets: readonly AspectBucket[] }

export const DEFAULT_TARGET_MODEL: TargetModelId = 'sdxl';

const SDXL_BUCKETS: readonly AspectBucket[] = [
  { id: '1024x1024', width: 1024, height: 1024 },
  { id: '1152x896', width: 1152, height: 896 },
  { id: '896x1152', width: 896, height: 1152 },
  { id: '1216x832', width: 1216, height: 832 },
  { id: '832x1216', width: 832, height: 1216 },
  { id: '1344x768', width: 1344, height: 768 },
  { id: '768x1344', width: 768, height: 1344 },
];

export const TARGET_MODEL_PRESETS: Record<TargetModelId, TargetModelPreset> = {
  sd15: {
    label: 'SD 1.5', minShortSide: 512,
    buckets: [
      { id: '512x512', width: 512, height: 512 },
      { id: '576x448', width: 576, height: 448 },
      { id: '448x576', width: 448, height: 576 },
      { id: '640x384', width: 640, height: 384 },
      { id: '384x640', width: 384, height: 640 },
    ],
  },
  sdxl: { label: 'SDXL', minShortSide: 1024, buckets: SDXL_BUCKETS },
  flux: { label: 'Flux', minShortSide: 1024, buckets: SDXL_BUCKETS },
};

export const isTargetModelId = (value: unknown): value is TargetModelId =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(TARGET_MODEL_PRESETS, value);

/** Stored value wins; otherwise a legacy Build min short side of 512 means SD 1.5, anything else the default. */
export const resolveTargetModel = (value: unknown, legacyMinShortSide?: unknown): TargetModelId => {
  if (isTargetModelId(value)) return value;
  return Math.floor(Number(legacyMinShortSide)) === 512 ? 'sd15' : DEFAULT_TARGET_MODEL;
};

export type CoverageAxisId = 'framing' | 'orientation' | 'setting' | 'lighting' | 'subject' | 'aspect';
export interface CoverageAxisBucket { id: string; label: string; tags?: readonly string[]; pattern?: RegExp }
export interface CoverageAxisSpec {
  id: CoverageAxisId; label: string; source: 'tags' | 'dimensions'; buckets: readonly CoverageAxisBucket[];
}
export interface TagPolicy { requireTrigger: boolean; constantTags: 'prune' | 'keep' | 'review' }

const COLOR_BACKGROUND = /^(white|grey|gray|black|transparent|gradient|red|orange|yellow|green|blue|aqua|purple|pink|brown) background$/;

export const COVERAGE_AXES: Record<CoverageAxisId, CoverageAxisSpec> = {
  framing: {
    id: 'framing', label: 'Кадрування', source: 'tags',
    buckets: [
      { id: 'close', label: 'Крупний план', tags: ['close-up', 'portrait', 'face focus'] },
      { id: 'mid', label: 'Середній план', tags: ['upper body', 'cowboy shot'] },
      { id: 'full', label: 'На весь зріст', tags: ['full body', 'wide shot', 'very wide shot'] },
    ],
  },
  orientation: {
    id: 'orientation', label: 'Орієнтація', source: 'dimensions',
    buckets: [
      { id: 'portrait', label: 'Вертикальні' },
      { id: 'square', label: 'Квадратні' },
      { id: 'landscape', label: 'Горизонтальні' },
    ],
  },
  setting: {
    id: 'setting', label: 'Фон і місце', source: 'tags',
    buckets: [
      { id: 'simple', label: 'Простий фон', tags: ['simple background'], pattern: COLOR_BACKGROUND },
      { id: 'indoors', label: 'У приміщенні', tags: ['indoors'] },
      { id: 'outdoors', label: 'На вулиці', tags: ['outdoors', 'scenery'] },
    ],
  },
  lighting: {
    id: 'lighting', label: 'Освітлення', source: 'tags',
    buckets: [
      { id: 'day', label: 'День', tags: ['day', 'sunlight', 'dappled sunlight'] },
      { id: 'evening', label: 'Вечір', tags: ['sunset', 'twilight', 'evening'] },
      { id: 'night', label: 'Ніч', tags: ['night', 'night sky', 'moonlight'] },
    ],
  },
  subject: {
    id: 'subject', label: 'Суб’єкт', source: 'tags',
    buckets: [
      { id: 'people', label: 'Люди', tags: ['multiple girls', 'multiple boys'], pattern: /^\d\+?(girl|boy)s?$/ },
      { id: 'no-humans', label: 'Без людей', tags: ['no humans'] },
    ],
  },
  aspect: {
    id: 'aspect', label: 'Пропорції', source: 'dimensions',
    buckets: [],
  },
};

export interface ProfileRules { coverageAxes: readonly CoverageAxisId[]; tagPolicy: TagPolicy }

export const PROFILE_RULES: Record<ProjectType, ProfileRules> = {
  general: { coverageAxes: ['orientation', 'setting'], tagPolicy: { requireTrigger: false, constantTags: 'review' } },
  character: { coverageAxes: ['framing', 'orientation', 'setting', 'lighting'], tagPolicy: { requireTrigger: true, constantTags: 'prune' } },
  style: { coverageAxes: ['subject', 'aspect', 'setting'], tagPolicy: { requireTrigger: false, constantTags: 'keep' } },
  concept: { coverageAxes: ['setting', 'framing', 'orientation'], tagPolicy: { requireTrigger: true, constantTags: 'prune' } },
};
