import { FileImage, Video } from 'lucide-react';
import type { ReactNode } from 'react';
import type { WorkspaceImage } from '../../lib/workspaceImages';
import { MasonryImageFrame } from './MasonryImageFrame';

type WorkspaceAssetFrameProps = {
  item: WorkspaceImage;
  previewUrl?: string;
  alt: string;
  className?: string;
  imageClassName?: string;
  placeholder?: ReactNode;
  children?: ReactNode;
};

export const WorkspaceAssetFrame = ({
  item,
  previewUrl,
  alt,
  className,
  imageClassName,
  placeholder = 'Preview unavailable',
  children,
}: WorkspaceAssetFrameProps) => {
  const previewPlaceholder =
    item.kind === 'psd' && item.previewStatus === 'queued'
      ? 'Queued preview...'
      : item.kind === 'psd' && item.previewStatus === 'generating'
        ? 'Generating preview...'
        : placeholder;

  if (item.kind === 'image' || item.kind === 'synthetic' || (item.kind === 'psd' && previewUrl)) {
    return (
      <MasonryImageFrame
        src={previewUrl}
        alt={alt}
        width={item.width}
        height={item.height}
        className={className}
        imageClassName={imageClassName}
        placeholder={previewPlaceholder}
      >
        {children}
      </MasonryImageFrame>
    );
  }

  return (
    <div
      className={`relative aspect-square overflow-hidden bg-secondary ${className ?? ''}`}
      aria-label={alt}
    >
      {item.kind === 'video' && previewUrl ? (
        <video
          src={previewUrl}
          className={`h-full w-full bg-black object-contain ${imageClassName ?? ''}`}
          muted
          playsInline
          preload="metadata"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-secondary text-muted-foreground">
          <div className="text-center">
            {item.kind === 'video' ? (
              <Video className="mx-auto mb-2 h-10 w-10" />
            ) : (
              <FileImage className="mx-auto mb-2 h-10 w-10" />
            )}
            <p className="text-xs">{previewPlaceholder}</p>
          </div>
        </div>
      )}
      {children}
    </div>
  );
};
