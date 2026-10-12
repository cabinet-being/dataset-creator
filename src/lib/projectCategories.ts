export const normalizeProjectPath = (path: string): string =>
  path.startsWith('Project/') || path === 'Project' ? path : `Project/${path}`;

export const isProjectPathIncluded = (
  path: string | undefined,
  excludedCategories: readonly string[],
  includedCategories: readonly string[] = []
): boolean => {
  const normalized = path ? normalizeProjectPath(path) : 'Project/Without folder';
  const matches = (directory: string) => normalized === directory || normalized.startsWith(`${directory}/`);
  const excluded = excludedCategories.filter(matches).sort((left, right) => right.length - left.length)[0];
  const included = includedCategories.filter(matches).sort((left, right) => right.length - left.length)[0];
  if (!excluded) return true;
  return Boolean(included && included.length >= excluded.length);
};
