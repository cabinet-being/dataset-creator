import { createSourceImage, type SourceImage } from '../../types';
import { addAssetsToDataset } from '../../lib/assetActions';
import { normalizeWorkspaceAssetPath, toWorkspaceImages } from '../../lib/workspaceImages';
import { useProjectStore } from '../../stores/useProjectStore';
import { flushProjectSave } from '../../hooks/useProjectSave';
import { getImageDimensions } from '../image/imageProcessor';
import { readExplorerFile } from '../project/explorerFileService';
import { getAssetManifestPath } from '../project/assetManifestService';
import type { ProjectDirectoryHandle } from '../project/projectDirectoryService';

/** Link existing saved PNGs; never copy them or automatically add other directory files. */
export async function addSavedFramesToDataset(directory: ProjectDirectoryHandle, paths: string[], signal?: AbortSignal, progress?: (done: number, total: number) => void) {
  const sources: SourceImage[] = [];
  const uniquePaths = [...new Set(paths.map(normalizeWorkspaceAssetPath))];
  try {
    for (const path of uniquePaths) {
      signal?.throwIfAborted();
      let source = Object.values(useProjectStore.getState().sourceImages).find(item => item.originalFilePath && normalizeWorkspaceAssetPath(item.originalFilePath) === path);
      if (!source) {
        const file = await readExplorerFile(directory, path);
        const size = await getImageDimensions(file);
        signal?.throwIfAborted();
        source = createSourceImage(file, file.name, size.width, size.height);
        source.originalFilePath = path.replace(/^Project\//, '');
        source.manifestPath = getAssetManifestPath(source.originalFilePath);
        useProjectStore.getState().addSourceImage(source);
      }
      sources.push(source);
      progress?.(sources.length, uniquePaths.length);
    }
  } finally {
    if (sources.length) {
      await addAssetsToDataset(toWorkspaceImages(sources, []));
      await flushProjectSave();
    }
  }
}
