import { BarChart3, Copy, Edit3, File, FilePlus, Layers3, Pencil, Scissors, Tags, Trash2, Upload, Video } from 'lucide-react';
import type { MouseEvent } from 'react';
import type { ContextAction, ContextActionGroup } from '../components/ui/ContextActions';
import type { ExplorerTreeNode } from '../components/workspace/ExplorerTree';
import type { ExplorerClipboard, ExplorerItemEntry } from '../hooks/useWorkspaceCommands';
import { canOpenExplorerFile, getExplorerFileKind, isExplorerImageFileName } from '../services/project/explorerFileService';
import { PROJECT_SHARED_DIRECTORY } from '../services/project/projectLayoutService';

type FilesystemExplorerItemEntry = ExplorerItemEntry & { kind: 'folder' | 'file' };

export type CreateExplorerAction = (
  action: Omit<ContextAction, 'onSelect'> & { onSelect: (event: MouseEvent<HTMLButtonElement>) => unknown }
) => ContextAction;

type ExplorerContextActionBase = {
  createExplorerAction: CreateExplorerAction;
  findWorkspaceImageIdForPath: (path: string) => string | null | undefined;
  openExplorerFile: (node: ExplorerTreeNode) => unknown;
  openFileModeTab: (node: ExplorerTreeNode, mode: 'edit' | 'caption' | 'analysis' | 'video') => unknown;
};

export type FileContextActionDeps = ExplorerContextActionBase & {
  getContextEntries: (node: ExplorerTreeNode) => ExplorerItemEntry[];
  getExplorerToolScopeFileNodes: (node: ExplorerTreeNode) => ExplorerTreeNode[];
  createExplorerEntryForNode: (node: ExplorerTreeNode) => ExplorerItemEntry;
  addToDataset: (sharedImagePaths: string[]) => Promise<void>;
  openExplorerFilesInPhotopea: (nodes: ExplorerTreeNode[]) => unknown;
  openExplorerFilesInCaption: (nodes: ExplorerTreeNode[]) => unknown;
  openExplorerFilesInAnalysis: (nodes: ExplorerTreeNode[]) => unknown;
  openExplorerFilesInReview: (sourceNode: ExplorerTreeNode, nodes: ExplorerTreeNode[]) => unknown;
  setExplorerClipboard: (clipboard: ExplorerClipboard) => void;
  handleExplorerRename: (node: ExplorerTreeNode) => unknown;
  handleExplorerDelete: (node: ExplorerTreeNode) => unknown;
};

export type DirectoryContextActionDeps = FileContextActionDeps & {
  explorerClipboard: ExplorerClipboard | null;
  handleExplorerNewFolder: (node: ExplorerTreeNode) => unknown;
  handleExplorerImport: (path: string, importFolder: boolean) => unknown;
  handleExplorerPaste: (node: ExplorerTreeNode) => unknown;
  handleExplorerDuplicate: (node: ExplorerTreeNode) => unknown;
};

export type DatasetBoardContextActionDeps = ExplorerContextActionBase & {
  removeFromDataset: () => unknown;
};

export const buildFileContextActionGroups = (node: ExplorerTreeNode, deps: FileContextActionDeps): ContextActionGroup[] => {
  const {
    createExplorerAction, findWorkspaceImageIdForPath, openExplorerFile, openFileModeTab, getContextEntries, getExplorerToolScopeFileNodes,
    createExplorerEntryForNode, addToDataset, openExplorerFilesInPhotopea, openExplorerFilesInCaption, openExplorerFilesInAnalysis,
    openExplorerFilesInReview, setExplorerClipboard, handleExplorerRename, handleExplorerDelete,
  } = deps;
  const contextEntries = getContextEntries(node);
  const selectedFileNodes = getExplorerToolScopeFileNodes(node);
  const selectedFiles = selectedFileNodes.map(createExplorerEntryForNode) as FilesystemExplorerItemEntry[];
  const selectedFileNode = selectedFileNodes.length === 1 ? selectedFileNodes[0] : null;
  const selectedFileKind = selectedFileNode ? getExplorerFileKind(selectedFileNode.name) : null;
  const isSingleFileSelection = Boolean(selectedFileNode);
  const canOpenFileInTab = isSingleFileSelection && selectedFileKind !== null && canOpenExplorerFile(selectedFileKind);
  const hasCompleteFileSelection = selectedFileNodes.length > 0 && selectedFileNodes.length === selectedFiles.length;
  const canOpenInAnalysis = hasCompleteFileSelection && selectedFileNodes.every((entry) => {
    const kind = getExplorerFileKind(entry.name);
    return kind === 'image' || kind === 'psd' || kind === 'video';
  });
  const canOpenInPhotopea = hasCompleteFileSelection && selectedFileNodes.every((entry) => isExplorerImageFileName(entry.name));
  const canOpenInCaption = hasCompleteFileSelection && selectedFileNodes.every((entry) => {
    const kind = getExplorerFileKind(entry.name);
    return (kind === 'image' || kind === 'psd') && Boolean(findWorkspaceImageIdForPath(entry.path));
  });
  const sharedImages = selectedFiles.filter(
    (entry): entry is FilesystemExplorerItemEntry =>
      entry.path.startsWith(`Project/${PROJECT_SHARED_DIRECTORY}/`) &&
      isExplorerImageFileName(entry.name)
  );
  const canAddToDataset = sharedImages.length > 0 && sharedImages.length === selectedFiles.length;

  return [
    [
      canOpenFileInTab
        ? createExplorerAction({ id: 'open', label: 'Open', icon: File, onSelect: () => {
          if (selectedFileNode) return openExplorerFile(selectedFileNode);
        } })
        : null,
    ].filter((action): action is ContextAction => Boolean(action)),
    canAddToDataset
      ? [createExplorerAction({ id: 'add-to-dataset', label: 'Add to Dataset', icon: Layers3, onSelect: () => addToDataset(sharedImages.map(entry => entry.path)) })]
      : [],
    [
      canOpenInPhotopea
        ? createExplorerAction({ id: 'photopea', label: 'Photopea', icon: Edit3, onSelect: () => {
          return openExplorerFilesInPhotopea(selectedFileNodes);
        } })
        : null,
      canOpenInCaption
        ? createExplorerAction({ id: 'caption', label: 'Caption', icon: Tags, onSelect: () => {
          return openExplorerFilesInCaption(selectedFileNodes);
        } })
        : null,
      canOpenInAnalysis
        ? createExplorerAction({ id: 'analysis', label: 'Analysis', icon: BarChart3, onSelect: () => {
          return openExplorerFilesInAnalysis(selectedFileNodes);
        } })
        : null,
      selectedFileNodes.length > 0
        ? createExplorerAction({ id: 'review', label: 'Review', icon: Layers3, onSelect: () => openExplorerFilesInReview(node, selectedFileNodes) })
        : null,
      selectedFileNode && selectedFileKind === 'video'
        ? createExplorerAction({ id: 'video-frames', label: 'Video Frames', icon: Video, onSelect: () => openFileModeTab(selectedFileNode, 'video') })
        : null,
    ].filter((action): action is ContextAction => Boolean(action)),
    [
      createExplorerAction({ id: 'cut', label: 'Cut', icon: Scissors, onSelect: () => setExplorerClipboard({ mode: 'cut', entries: contextEntries }) }),
    ],
    [
      isSingleFileSelection
        ? createExplorerAction({ id: 'rename', label: 'Rename', icon: Pencil, onSelect: () => handleExplorerRename(node) })
        : null,
      createExplorerAction({ id: 'delete', label: 'Delete', icon: Trash2, variant: 'destructive', onSelect: () => handleExplorerDelete(node) }),
    ].filter((action): action is ContextAction => Boolean(action)),
  ].filter((group) => group.length > 0);
};

export const buildDirectoryContextActionGroups = (node: ExplorerTreeNode, deps: DirectoryContextActionDeps): ContextActionGroup[] => {
  const {
    createExplorerAction, getContextEntries, getExplorerToolScopeFileNodes, openExplorerFilesInReview, setExplorerClipboard, handleExplorerRename,
    handleExplorerDelete, explorerClipboard, handleExplorerNewFolder, handleExplorerImport, handleExplorerPaste, handleExplorerDuplicate,
  } = deps;
  const contextEntries = getContextEntries(node);
  const fileToolActionGroups = getExplorerToolScopeFileNodes(node).length > 0
    ? buildFileContextActionGroups(node, deps)
      .map((group) => group.filter((action) => !['review', 'cut', 'copy', 'duplicate', 'rename', 'delete'].includes(action.id)))
      .filter((group) => group.length > 0)
    : [];
  const creationActions: ContextActionGroup =
    node.kind === 'folder'
      ? [
          createExplorerAction({ id: 'new-folder', label: 'New Folder', icon: FilePlus, onSelect: () => handleExplorerNewFolder(node) }),
          createExplorerAction({
            id: 'import',
            label: 'Import',
            icon: Upload,
            title: 'Shift-click to import a folder',
            onSelect: (event) => handleExplorerImport(node.path, event.shiftKey),
          }),
        ]
      : [];
  const reviewAction: ContextActionGroup = [
    createExplorerAction({
      id: 'review-directory',
      label: 'Review',
      icon: Layers3,
      onSelect: () => openExplorerFilesInReview(node, getExplorerToolScopeFileNodes(node)),
    }),
  ];

  if (node.path === 'Project') {
    return [
      ...fileToolActionGroups,
      reviewAction,
      creationActions,
      explorerClipboard
        ? [createExplorerAction({ id: 'paste', label: 'Paste', icon: Copy, onSelect: () => handleExplorerPaste(node) })]
        : [],
    ].filter((group) => group.length > 0);
  }

  return [
    ...fileToolActionGroups,
    reviewAction,
    creationActions,
    [
      createExplorerAction({ id: 'cut', label: 'Cut', icon: Scissors, onSelect: () => setExplorerClipboard({ mode: 'cut', entries: contextEntries }) }),
      createExplorerAction({ id: 'copy', label: 'Copy', icon: Copy, onSelect: () => setExplorerClipboard({ mode: 'copy', entries: contextEntries }) }),
      explorerClipboard
        ? createExplorerAction({ id: 'paste', label: 'Paste', icon: Copy, onSelect: () => handleExplorerPaste(node) })
        : null,
      createExplorerAction({ id: 'duplicate', label: 'Duplicate', icon: Copy, onSelect: () => handleExplorerDuplicate(node) }),
    ].filter((action): action is ContextAction => Boolean(action)),
    [
      contextEntries.length === 1
        ? createExplorerAction({ id: 'rename', label: 'Rename', icon: Pencil, onSelect: () => handleExplorerRename(node) })
        : null,
      createExplorerAction({ id: 'delete', label: 'Delete', icon: Trash2, variant: 'destructive', onSelect: () => handleExplorerDelete(node) }),
    ].filter((action): action is ContextAction => Boolean(action)),
  ].filter((group) => group.length > 0);
};

export const buildDatasetBoardContextActionGroups = (node: ExplorerTreeNode, deps: DatasetBoardContextActionDeps): ContextActionGroup[] => {
  const { createExplorerAction, findWorkspaceImageIdForPath, openExplorerFile, openFileModeTab, removeFromDataset } = deps;
  const fileKind = getExplorerFileKind(node.name);
  const workspaceImageId = findWorkspaceImageIdForPath(node.path);
  const canOpenFileInTab = canOpenExplorerFile(fileKind);
  const canOpenInPhotopea = isExplorerImageFileName(node.name);
  const canOpenInCaption = (fileKind === 'image' || fileKind === 'psd') && Boolean(workspaceImageId);
  const canOpenInAnalysis = fileKind === 'image' || fileKind === 'psd' || fileKind === 'video';

  return [
    [
      canOpenFileInTab
        ? createExplorerAction({ id: 'open', label: 'Open', icon: File, onSelect: () => openExplorerFile(node) })
        : null,
    ].filter((action): action is ContextAction => Boolean(action)),
    [
      canOpenInPhotopea
        ? createExplorerAction({ id: 'photopea', label: 'Photopea', icon: Edit3, onSelect: () => openFileModeTab(node, 'edit') })
        : null,
      canOpenInCaption
        ? createExplorerAction({ id: 'caption', label: 'Caption', icon: Tags, onSelect: () => openFileModeTab(node, 'caption') })
        : null,
      canOpenInAnalysis
        ? createExplorerAction({ id: 'analysis', label: 'Analysis', icon: BarChart3, onSelect: () => openFileModeTab(node, 'analysis') })
        : null,
      fileKind === 'video'
        ? createExplorerAction({ id: 'video-frames', label: 'Video Frames', icon: Video, onSelect: () => openFileModeTab(node, 'video') })
        : null,
    ].filter((action): action is ContextAction => Boolean(action)),
    [
      createExplorerAction({
        id: 'remove-from-dataset',
        label: 'Remove from Dataset',
        icon: Trash2,
        variant: 'destructive',
        onSelect: () => removeFromDataset(),
      }),
    ],
  ].filter((group) => group.length > 0);
};
