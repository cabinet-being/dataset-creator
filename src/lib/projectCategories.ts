export const normalizeProjectPath = (path: string): string =>
  path.startsWith('Project/') || path === 'Project' ? path : `Project/${path}`;

export const isProjectPathIncluded = (
  path: string | undefined,
  excludedCategories: readonly string[]
): boolean => {
  const normalized = path ? normalizeProjectPath(path) : 'Project/Without folder';
  return !excludedCategories.some(
    (directory) => normalized === directory || normalized.startsWith(`${directory}/`)
  );
};
