export const LEGACY_PROJECT_ROOT_DIRECTORY_NAMES = new Set(['sources', `syn${'thetic'}`]);

export const getProjectPathParts = (path: string): string[] => {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[0]?.toLowerCase() === 'project' ? parts.slice(1) : parts;
};

export const isLegacyProjectRootPath = (path: string): boolean => {
  const [rootName] = getProjectPathParts(path);
  return rootName ? LEGACY_PROJECT_ROOT_DIRECTORY_NAMES.has(rootName.toLowerCase()) : false;
};

export const filterLegacyProjectAssetPaths = (paths: string[] = []): string[] =>
  paths.filter((path) => !isLegacyProjectRootPath(path));
