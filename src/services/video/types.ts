export type FrameQuality = { sharpness: number; dark: boolean; blurry: boolean; transition: boolean };
export type FrameReference = { source: string; id: string; timestamp: number; duration: number; quality: FrameQuality };
export type FrameRecord = FrameReference & { run: string; embedding: Float32Array };
export type VideoAnalysisOptions = { mode: 'fast' | 'full'; start: number; end: number; sampleRate: number };
export type FrameSelectionOptions = {
  limit: number;
  distance: number;
  pinned: number[];
  excluded: number[];
  excludeDark: boolean;
  excludeBlurry: boolean;
  excludeTransitions: boolean;
};
export type VideoProgress = { phase: string; completed: number; total: number; analyzed?: number; secondsRemaining?: number };
export type VideoInfo = { width: number; height: number; start: number; end: number; timestamps: number[] };
export type VideoWorkerRequest =
  | { id: number; type: 'model' }
  | { id: number; type: 'analyze'; file: Blob; options: VideoAnalysisOptions; selection: FrameSelectionOptions }
  | { id: number; type: 'select'; run: string; selection: FrameSelectionOptions }
  | { id: number; type: 'include'; file: Blob; run: string; timestamp: number }
  | { id: number; type: 'cancel' };
export type VideoWorkerResponse =
  | { id: number; type: 'progress'; progress: VideoProgress }
  | { id: number; type: 'result'; run?: string; frames?: FrameReference[]; runtime?: string; count?: number }
  | { id: number; type: 'error'; message: string };
export const DEFAULT_FRAME_SELECTION: FrameSelectionOptions = {
  limit: 50, distance: 0.15, pinned: [], excluded: [], excludeDark: true, excludeBlurry: false, excludeTransitions: false,
};
export const frameTimestamp = (timestamp: number) => Math.round(timestamp * 1e6) / 1e6;
export const checkVideoAbort = (signal?: AbortSignal) => signal?.throwIfAborted();
export const frameTimecode = (timestamp: number) => {
  const milliseconds = Math.max(0, Math.round(timestamp * 1000));
  return `${String(Math.floor(milliseconds / 3600000)).padStart(2, '0')}:${String(Math.floor(milliseconds / 60000) % 60).padStart(2, '0')}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
};
