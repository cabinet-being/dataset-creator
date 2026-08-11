export const ASSET_MANIFEST_SUFFIX = '.manifest.json';
export const PROJECT_MANIFEST_NAME = 'manifest.json';

export const getAssetManifestName = (assetName: string): string =>
  `${assetName}${ASSET_MANIFEST_SUFFIX}`;

export const getAssetManifestPath = (assetPath: string): string =>
  `${assetPath}${ASSET_MANIFEST_SUFFIX}`;

export const isAssetManifestName = (name: string): boolean =>
  name.endsWith(ASSET_MANIFEST_SUFFIX);

export const isProjectManifestName = (name: string): boolean =>
  name === PROJECT_MANIFEST_NAME;

export const isHiddenExplorerManifestName = (name: string): boolean =>
  isProjectManifestName(name) || isAssetManifestName(name);
