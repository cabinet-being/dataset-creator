import { useEffect, useState } from 'react';
import { collectWorkspaceFileAssets, generateMissingWorkspacePsdPreviews } from '../lib/workspaceFileAssets';
import type { WorkspaceFileAsset } from '../lib/workspaceImages';
import { useUIStore } from '../stores/useUIStore';

/** Owns the workspaceFileAssets list: reloads it for the open project and fills missing PSD previews. */
export function useWorkspaceFileAssets() {
  const addNotification = useUIStore(state => state.addNotification);
  const projectDirectoryHandle = useUIStore(state => state.projectDirectoryHandle);
  const assetPreviewRefreshKey = useUIStore((state) => state.assetPreviewRefreshKey);
  const [workspaceFileAssets, setWorkspaceFileAssets] = useState<WorkspaceFileAsset[]>([]);

  useEffect(() => {
    let canceled = false;

    if (!projectDirectoryHandle) {
      setWorkspaceFileAssets([]);
      return;
    }

    const loadDatasetWorkspaceFileAssets = async () => {
      try {
        const assets = await collectWorkspaceFileAssets(projectDirectoryHandle);
        const pendingAssets = assets.map((asset) =>
          asset.kind === 'psd' && !asset.previewUrl ? { ...asset, previewStatus: 'queued' as const } : asset
        );

        if (canceled) {
          return;
        }

        setWorkspaceFileAssets(pendingAssets);
        void generateMissingWorkspacePsdPreviews(
          projectDirectoryHandle,
          pendingAssets,
          (path, update) => {
            setWorkspaceFileAssets((currentAssets) =>
              currentAssets.map((asset) => (asset.path === path ? { ...asset, ...update } : asset))
            );
          },
          () => canceled
        );
      } catch (error) {
        if (!canceled) {
          setWorkspaceFileAssets([]);
          addNotification('warning', error instanceof Error ? error.message : 'Unable to read Dataset file assets');
        }
      }
    };

    void loadDatasetWorkspaceFileAssets();

    return () => {
      canceled = true;
    };
  }, [addNotification, assetPreviewRefreshKey, projectDirectoryHandle]);

  return workspaceFileAssets;
}
