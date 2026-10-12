import type { MouseEvent, ReactNode } from 'react';
import { MoreVertical } from 'lucide-react';
import { ASPECT_RATIO_LABELS } from '../../lib/constants';
import {
  getWorkspaceDisplayName,
  getWorkspaceKindBadgeClass,
  getWorkspaceKindFrameClass,
  getWorkspaceKindFrameOverlayClass,
  getWorkspaceKindFrameOverlayStyle,
  getWorkspaceKindFrameStyle,
  type WorkspaceImage,
} from '../../lib/workspaceImages';
import { WorkspaceAssetFrame } from './WorkspaceAssetFrame';

type WorkspacePreviewCardProps = {
  item: WorkspaceImage;
  previewUrl?: string;
  alt?: string;
  className?: string;
  imageClassName?: string;
  children?: ReactNode;
  footer?: ReactNode;
  onClick?: () => void;
  onOpenContextMenu?: (item: WorkspaceImage, event: MouseEvent<HTMLElement>) => void;
  showMenuButton?: boolean;
};

export const WorkspacePreviewCard = ({
  item,
  previewUrl,
  alt,
  className = '',
  imageClassName,
  children,
  footer,
  onClick,
  onOpenContextMenu,
  showMenuButton = true,
}: WorkspacePreviewCardProps) => {
  const handleContextMenu = (event: MouseEvent<HTMLElement>) => {
    if (!onOpenContextMenu) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onOpenContextMenu(item, event);
  };

  const handleMenuClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (!onOpenContextMenu) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onOpenContextMenu(item, event);
  };

  const content = (
    <WorkspaceAssetFrame
      item={item}
      previewUrl={previewUrl}
      alt={alt ?? getWorkspaceDisplayName(item)}
      className="rounded-lg"
      imageClassName={imageClassName}
      placeholder="Preview unavailable"
    >
      <div
        className={getWorkspaceKindFrameOverlayClass()}
        style={getWorkspaceKindFrameOverlayStyle(item.kind)}
      />
      {onClick && <button type="button" onClick={onClick} aria-label={`Open ${getWorkspaceDisplayName(item)}`} className="absolute inset-0 z-10 rounded-lg" />}
      {children}
      {showMenuButton && onOpenContextMenu ? (
        <button
          type="button"
          onClick={handleMenuClick}
          className="absolute right-2 top-2 z-20 flex h-8 w-8 items-center justify-center rounded-md bg-black/65 text-white opacity-0 transition-opacity hover:bg-black/85 group-hover:opacity-100 focus:opacity-100"
          title="Asset actions"
          aria-label={`Open actions for ${getWorkspaceDisplayName(item)}`}
        >
          <MoreVertical size={16} />
        </button>
      ) : null}
      {footer ?? (
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/45 to-transparent p-3">
          <div className="flex items-end justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-white">{getWorkspaceDisplayName(item)}</p>
              <p className="text-xs text-gray-300">
                {item.dimensionsKnown === false ? 'Dimensions unknown' : `${ASPECT_RATIO_LABELS[item.aspectRatio]} · ${item.width} x ${item.height}`}
              </p>
            </div>
            <span
              className={getWorkspaceKindBadgeClass(item.kind)}
              style={getWorkspaceKindFrameStyle(item.kind)}
            >
              {item.label}
            </span>
          </div>
        </div>
      )}
    </WorkspaceAssetFrame>
  );

  return (
    <div
      className={`group relative overflow-visible rounded-lg ${
        item.excludedFromDataset ? 'border border-muted opacity-75' : getWorkspaceKindFrameClass(item.kind)
      } ${className}`}
      style={getWorkspaceKindFrameStyle(item.kind)}
      onContextMenu={handleContextMenu}
    >
      {content}
    </div>
  );
};
