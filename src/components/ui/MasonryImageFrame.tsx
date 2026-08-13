import { useEffect, useState, type ReactNode } from 'react';

type MasonryImageFrameProps = {
  src?: string;
  alt: string;
  width: number;
  height: number;
  className?: string;
  imageClassName?: string;
  placeholder?: ReactNode;
  children?: ReactNode;
};

export const MasonryImageFrame = ({
  src,
  alt,
  width,
  height,
  className = '',
  imageClassName = '',
  placeholder,
  children,
}: MasonryImageFrameProps) => {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const placeholderContent = !src || errored ? placeholder ?? `${safeWidth} x ${safeHeight}` : null;

  useEffect(() => {
    setLoaded(false);
    setErrored(false);
  }, [src]);

  return (
    <div
      className={`relative overflow-hidden bg-black ${className}`.trim()}
      style={{ aspectRatio: `${safeWidth} / ${safeHeight}` }}
    >
      <div
        className={`absolute inset-0 flex items-center justify-center bg-secondary text-xs text-muted-foreground transition-opacity ${
          loaded && src && !errored ? 'opacity-0' : 'opacity-100'
        }`}
      >
        {placeholderContent}
      </div>

      {src ? (
        <img
          src={src}
          alt={alt}
          className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-200 ${
            loaded ? 'opacity-100' : 'opacity-0'
          } ${imageClassName}`.trim()}
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => {
            setLoaded(true);
            setErrored(false);
          }}
          onError={() => {
            setLoaded(false);
            setErrored(true);
          }}
        />
      ) : null}

      {children}
    </div>
  );
};
