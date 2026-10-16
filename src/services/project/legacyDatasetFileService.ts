/** Legacy Dataset documents are recognized only so migration can hide, validate, and remove them. */
export const LEGACY_DATASET_FILE_SUFFIX = '.dataset.json';

export const isLegacyDatasetFileName = (name: string): boolean =>
  name.toLowerCase().endsWith(LEGACY_DATASET_FILE_SUFFIX);
