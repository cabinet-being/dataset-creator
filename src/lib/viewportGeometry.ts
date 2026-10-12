export type ViewportRect = { left: number; top: number; width: number; height: number };
export type SurfaceRect = { left: number; top: number; width: number; height: number };

export const clampSurfaceToViewport = (
  surface: SurfaceRect,
  viewport: ViewportRect,
  margin = 8
): { x: number; y: number; maxHeight: number } => {
  const left = viewport.left + margin;
  const top = viewport.top + margin;
  const right = viewport.left + viewport.width - margin;
  const bottom = viewport.top + viewport.height - margin;
  const maxHeight = Math.max(0, bottom - top);
  const width = Math.min(surface.width, Math.max(0, right - left));
  const height = Math.min(surface.height, maxHeight);
  return {
    x: Math.min(Math.max(surface.left, left), Math.max(left, right - width)),
    y: Math.min(Math.max(surface.top, top), Math.max(top, bottom - height)),
    maxHeight,
  };
};

export const getEdgeScrollVelocity = (
  pointer: number,
  start: number,
  end: number,
  edge = 48,
  maximum = 28
): number => {
  if (end <= start || edge <= 0 || maximum <= 0) return 0;
  if (pointer < start + edge) {
    return -Math.min(maximum, maximum * (start + edge - pointer) / edge);
  }
  if (pointer > end - edge) {
    return Math.min(maximum, maximum * (pointer - (end - edge)) / edge);
  }
  return 0;
};
