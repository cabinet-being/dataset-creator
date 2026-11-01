import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AnalysisTool } from '../src/components/tools/AnalysisTool';
import { CommandProvider } from '../src/components/workspace/Commands';
import { InspectorSelectionDetails } from '../src/components/workspace/InspectorSelectionDetails';
import { AssetGallery } from '../src/components/ui/AssetGallery';
import { WorkspacePreviewCard } from '../src/components/ui/WorkspacePreviewCard';
import { createProject, createSourceImage } from '../src/types';
import { toWorkspaceImages } from '../src/lib/workspaceImages';
import { useWorkspacePreviewUrls } from '../src/lib/previewUrlCache';
import { useInspectorSelectionStore } from '../src/stores/useInspectorSelectionStore';
import { useProjectStore } from '../src/stores/useProjectStore';
import { useUIStore } from '../src/stores/useUIStore';
import '../src/index.css';

function InspectorFixture() {
  const [ready, setReady] = useState(false);
  const [screen, setScreen] = useState<'analysis' | 'gallery'>('analysis');
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const sources = useProjectStore((state) => state.sourceImages);
  const edits = useProjectStore((state) => state.datasetItems);
  const items = useMemo(() => toWorkspaceImages(Object.values(sources), Object.values(edits)), [edits, sources]);
  const previewUrls = useWorkspacePreviewUrls(items);
  const ownerId = useInspectorSelectionStore((state) => state.activeOwnerId);
  const selection = useInspectorSelectionStore((state) => state.activeOwnerId ? state.selections[state.activeOwnerId] : null);

  const prepare = async () => {
    const makeImage = async (color: string) => {
      const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 64;
      const context = canvas.getContext('2d')!; context.fillStyle = color; context.fillRect(0, 0, 96, 64);
      return await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/png'));
    };
    const first = createSourceImage(await makeImage('#6750a4'), 'first.png', 96, 64);
    first.originalFilePath = 'src/shared/first.png'; first.tags = ['portrait', 'fixture'];
    const second = createSourceImage(await makeImage('#229977'), 'second.png', 96, 64);
    second.originalFilePath = 'src/shared/second.png'; second.tags = ['landscape'];
    const project = createProject('Inspector fixture', 'character');
    project.sourceImages = { [first.id]: first, [second.id]: second };
    useProjectStore.getState().loadProject(project);
    useUIStore.setState({ projectDirectoryHandle: undefined });
    useInspectorSelectionStore.getState().resetForProject(project.id);
    setReady(true);
  };

  if (!ready) return <main className="p-6"><button className="rounded border px-3 py-2" onClick={() => void prepare()}>Prepare Inspector fixture</button></main>;

  const selectedAsset = items[0];
  return <CommandProvider><main className="flex h-screen flex-col bg-background text-foreground">
    <header className="flex flex-wrap items-center gap-2 border-b border-border p-3">
      <strong className="mr-2 text-sm">Inspector regression fixture</strong>
      <button className="rounded border px-3 py-1.5 text-xs" onClick={() => setScreen('analysis')}>Analysis screen</button>
      <button className="rounded border px-3 py-1.5 text-xs" onClick={() => setScreen('gallery')}>Asset gallery</button>
      <button className="ml-auto rounded border px-3 py-1.5 text-xs" onClick={() => setInspectorOpen((open) => !open)}>
        {inspectorOpen ? 'Close Inspector' : 'Open Inspector'}
      </button>
    </header>
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-auto p-4">
        {screen === 'analysis' ? <AnalysisTool
          active
          viewId="fixture:analysis"
          fileTarget={selectedAsset ? {
            path: selectedAsset.assetPath ?? 'Project/src/shared/first.png',
            name: selectedAsset.fileName,
            fileKind: 'image',
            file: selectedAsset.imageData,
            workspaceImageId: selectedAsset.id,
          } : undefined}
        /> : <AssetGallery
          active
          inspectorOwnerId="fixture:gallery"
          items={items}
          directInteraction
          hideToolbar
          thumbnailSize={180}
          renderItem={(item) => <WorkspacePreviewCard item={item} previewUrl={previewUrls[item.id]} showMenuButton={false} />}
        />}
      </div>
      {inspectorOpen && <aside className="w-72 shrink-0 overflow-auto border-l border-border p-3" aria-label="Inspector">
        <p className="mb-2 text-xs text-muted-foreground">Owner: {ownerId ?? 'none'}</p>
        {selection ? <InspectorSelectionDetails selection={selection} open={detailsOpen} onOpenChange={setDetailsOpen} /> : <p className="text-xs text-muted-foreground">No active selection</p>}
      </aside>}
    </div>
  </main></CommandProvider>;
}

const root = createRoot(document.getElementById('root')!);
root.render(<InspectorFixture />);
import.meta.hot?.dispose(() => root.unmount());
