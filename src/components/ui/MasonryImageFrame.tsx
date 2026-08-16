import { useEffect, useRef, useState, type ReactNode } from 'react';

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
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [erroredSrc, setErroredSrc] = useState<string | null>(null);
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const loaded = Boolean(src && loadedSrc === src);
  const errored = Boolean(src && erroredSrc === src);
  const placeholderContent = !src || !loaded || errored ? placeholder ?? `${safeWidth} x ${safeHeight}` : null;

  useEffect(() => {
    if (!src) {
      setLoadedSrc(null);
      setErroredSrc(null);
      return;
    }

    setErroredSrc((current) => (current === src ? null : current));
    const image = imageRef.current;
    if (image?.complete) {
      if (image.naturalWidth > 0) {
        setLoadedSrc(src);
      } else {
        setErroredSrc(src);
      }
    }
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
          ref={imageRef}
          className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-200 ${
            loaded ? 'opacity-100' : 'opacity-0'
          } ${imageClassName}`.trim()}
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => {
            setLoadedSrc(src);
            setErroredSrc((current) => (current === src ? null : current));
          }}
          onError={() => {
            setLoadedSrc((current) => (current === src ? null : current));
            setErroredSrc(src);
          }}
        />
      ) : null}

      {children}
    </div>
  );
};
