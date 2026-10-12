import { addSavedFramesToDataset } from '../../services/video/frameDataset';
import { useOperation } from '../../hooks/useOperation';
import { useCommands } from '../workspace/Commands';
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Pin, Video, X } from 'lucide-react';
import type { ProjectDirectoryHandle } from '../../services/project/projectDirectoryService';
import { createOperationLogger } from '../../services/logging/applicationLog';
import { useUIStore } from '../../stores/useUIStore';
import { useProjectStore } from '../../stores/useProjectStore';
import { collectWorkspaceFileAssets } from '../../lib/workspaceFileAssets';
import { isProjectPathIncluded } from '../../lib/projectCategories';
import { VideoClient, setVideoTabBusy, hasBusyVideoTasks } from '../../services/video/videoClient';
import { inspectVideo, readVideoFrame, findFrameIndex } from '../../services/video/videoReader';
import { clearVideoCache, hasVideoModel, getVideoThumbnail } from '../../services/video/videoCache';
import { listFrameDirectories, saveVideoFrame } from '../../services/video/frameExport';
import { DEFAULT_FRAME_SELECTION, frameTimecode, type FrameReference, type FrameSelectionOptions, type VideoInfo, type VideoProgress } from '../../services/video/types';

type Props = {
  active?: boolean;
  tabId: string;
  file?: Blob;
  fileName?: string;
  projectDirectoryHandle?: ProjectDirectoryHandle | null;
  onSaved?: () => void | Promise<void>;
};
const buttonClass = 'inline-flex items-center justify-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-secondary disabled:opacity-40';
const inputClass = 'rounded border border-border bg-background px-2 py-1 text-xs';
const logger = createOperationLogger('Video Frames');

const FrameThumbnail = ({ run, frame }: { run: string; frame: FrameReference }) => {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let current: string | undefined;
    let disposed = false;
    void getVideoThumbnail(run, frame.timestamp).then((blob) => {
      if (disposed || !blob) return;
      current = URL.createObjectURL(blob); setUrl(current);
    }).catch(() => {});
    return () => { disposed = true; if (current) URL.revokeObjectURL(current); };
  }, [run, frame.timestamp]);
  return url ? <img src={url} alt={`Frame at ${frameTimecode(frame.timestamp)}`} className="h-28 w-full object-contain" /> : <div className="h-28 bg-secondary" />;
};

export const VideoFramesTool = ({ active = true, tabId, file: initialFile, fileName, projectDirectoryHandle, onSaved }: Props) => {
  const workspaceSettings = useProjectStore((state) => state.workspaceSettings);
  const assetPreviewRefreshKey = useUIStore((state) => state.assetPreviewRefreshKey);
  const [file, setFile] = useState<Blob | undefined>(initialFile);
  const [name, setName] = useState(fileName ?? 'video');
  const [info, setInfo] = useState<VideoInfo>();
  const [url, setUrl] = useState<string>();
  const [position, setPosition] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [loop, setLoop] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const [mode, setMode] = useState<'manual' | 'automatic'>('manual');
  const [analysisMode, setAnalysisMode] = useState<'fast' | 'full'>('fast');
  const [sampleRate, setSampleRate] = useState(2);
  const [selection, setSelection] = useState<FrameSelectionOptions>({ ...DEFAULT_FRAME_SELECTION });
  const [frames, setFrames] = useState<FrameReference[]>([]);
  const [run, setRun] = useState<string>();
  const [modelReady, setModelReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<VideoProgress>();
  const [error, setError] = useState<string>();
  const [savedPaths, setSavedPaths] = useState<string[]>([]);
  const [directories, setDirectories] = useState<string[]>([]);
  const [projectVideos, setProjectVideos] = useState<Array<{ path:string; name:string; file:Blob }>>([]);
  const [destination, setDestination] = useState('Project/src/shared');
  const [replacement, setReplacement] = useState<number>();
  const commandRoot = useRef<HTMLDivElement>(null);
  const task = useOperation('Video Frames', commandRoot, tabId);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const decoded = useRef<Awaited<ReturnType<typeof readVideoFrame>>>();
  const latestPresented = useRef<number>();
  const ignorePause = useRef(false);
  const client = useRef(new VideoClient());
  const frameAbort = useRef<AbortController>();
  const operationAbort = useRef<AbortController>();
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const lastLoggedProgress = useRef('');
  const savedCallback = useRef(onSaved);
  savedCallback.current = onSaved;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      client.current.cancel(); frameAbort.current?.abort(); operationAbort.current?.abort(); setVideoTabBusy(tabId, false);
    };
  }, [tabId]);
  useEffect(() => { if (initialFile) { setFile(initialFile); setName(fileName ?? 'video'); } }, [initialFile, fileName]);
  useEffect(() => { void hasVideoModel().then(setModelReady).catch(() => {}); }, []);
  useEffect(() => {
    let disposed = false;
    setDirectories([]);
    if (projectDirectoryHandle) void listFrameDirectories(projectDirectoryHandle).then((paths) => {
      if (!disposed) { setDirectories(paths); setDestination((current) => paths.includes(current) ? current : paths[0] ?? 'Project'); }
    }).catch((reason) => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; };
  }, [projectDirectoryHandle]);
  useEffect(() => {
    let disposed = false;
    if (!projectDirectoryHandle || initialFile) { setProjectVideos([]); return; }
    void collectWorkspaceFileAssets(projectDirectoryHandle).then((assets) => {
      if (disposed) return;
      setProjectVideos(assets.filter((asset) => asset.kind === 'video' && isProjectPathIncluded(asset.path,
        workspaceSettings.excludedProjectCategories ?? [], workspaceSettings.includedProjectCategories ?? []))
        .map((asset) => ({path:asset.path,name:asset.fileName,file:asset.file})));
    }).catch((reason) => { if (!disposed) reportError(reason); });
    return () => { disposed = true; };
  }, [assetPreviewRefreshKey, initialFile, projectDirectoryHandle, workspaceSettings.excludedProjectCategories, workspaceSettings.includedProjectCategories]);

  const reportError = (reason: unknown) => {
    if (!mounted.current) return;
    const message = reason instanceof Error ? reason.message : String(reason);
    setError(message); logger.error(message);
  };
  const reportProgress = (next: VideoProgress) => {
    if (!mounted.current) return;
    setProgress(next);
    task.progress(next.completed, next.total, next.phase);
    const percent = next.total > 0 ? Math.min(100, Math.floor(next.completed / next.total * 10) * 10) : 0;
    const marker = `${next.phase}:${percent}`;
    if (marker !== lastLoggedProgress.current) {
      lastLoggedProgress.current = marker;
      logger.progress({ current: next.completed, total: next.total, label: next.phase });
    }
  };
  const showFrame = async (timestamp: number, source = file) => {
    if (!source) return;
    frameAbort.current?.abort();
    const controller = new AbortController();
    frameAbort.current = controller;
    setDecoding(true);
    try {
      const frame = await readVideoFrame(source, timestamp, controller.signal);
      if (controller.signal.aborted || !mounted.current) return;
      decoded.current = frame;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = frame.canvas.width; canvas.height = frame.canvas.height;
        canvas.getContext('2d')!.drawImage(frame.canvas, 0, 0);
      }
      setPosition(frame.timestamp);
      latestPresented.current = frame.timestamp;
    } catch (reason) { if (!controller.signal.aborted) reportError(reason); }
    finally { if (!controller.signal.aborted && mounted.current) setDecoding(false); }
  };
  useEffect(() => {
    setInfo(undefined); setRun(undefined); setFrames([]); setError(undefined); decoded.current = undefined;
    setPlaying(false); latestPresented.current = undefined;
    setSelection({ ...DEFAULT_FRAME_SELECTION }); setReplacement(undefined);
    if (!file) return;
    const controller = new AbortController();
    const objectUrl = URL.createObjectURL(file); setUrl(objectUrl);
    void inspectVideo(file, controller.signal).then((metadata) => {
      if (controller.signal.aborted) return;
      setInfo(metadata); setStart(metadata.start); setEnd(metadata.end); setPosition(metadata.timestamps[0]);
      void showFrame(metadata.timestamps[0], file);
    }).catch((reason) => { if (!controller.signal.aborted) reportError(reason); });
    return () => { controller.abort(); frameAbort.current?.abort(); URL.revokeObjectURL(objectUrl); };
  }, [file]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = speed;
    let callback: number | undefined;
    const presented: VideoFrameRequestCallback = (_time, metadata) => {
      latestPresented.current = metadata.mediaTime;
      callback = video.requestVideoFrameCallback(presented);
    };
    if (video.requestVideoFrameCallback) callback = video.requestVideoFrameCallback(presented);
    return () => { if (callback !== undefined) video.cancelVideoFrameCallback(callback); };
  }, [url, speed]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (busyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);

  const perform = async (operation: (signal: AbortSignal) => Promise<void>) => {
    if (busyRef.current) return;
    if (hasBusyVideoTasks()) { setError('Another Video Frames tab is busy. Wait for it to finish or cancel it first.'); return; }
    busyRef.current = true; setBusy(true); setVideoTabBusy(tabId, true); setError(undefined);
    const controller = new AbortController(); operationAbort.current = controller;
    task.start(() => { controller.abort(); client.current.cancel(); });
    logger.info('Started video operation');
    try { await operation(controller.signal); task.finish(controller.signal.aborted ? 'cancelled' : 'completed'); }
    catch (reason) { task.finish(controller.signal.aborted ? 'cancelled' : 'failed', reason instanceof Error ? reason.message : 'Video operation failed'); if (!controller.signal.aborted) reportError(reason); }
    finally {
      busyRef.current = false; setVideoTabBusy(tabId, false);
      if (mounted.current) { setBusy(false); setProgress(undefined); }
    }
  };
  const cancel = () => { operationAbort.current?.abort(); client.current.cancel(); logger.info('Video operation cancelled'); };
  const seek = (timestamp: number) => {
    ignorePause.current = Boolean(videoRef.current && !videoRef.current.paused);
    videoRef.current?.pause(); setPlaying(false);
    if (videoRef.current) videoRef.current.currentTime = timestamp;
    void showFrame(timestamp);
  };
  const step = (direction: number) => {
    if (!info) return;
    const index = findFrameIndex(info.timestamps, playing ? latestPresented.current ?? position : decoded.current?.timestamp ?? position);
    seek(info.timestamps[Math.max(0, Math.min(info.timestamps.length - 1, index + direction))]);
  };
  const receiveFrames = (result: { run?: string; frames?: FrameReference[]; count?: number }) => {
    if (!mounted.current) return;
    setRun(result.run); setFrames(result.frames ?? []);
    logger.success(`Selected ${result.frames?.length ?? 0} frames${result.count !== undefined ? ` from ${result.count} analyzed frames` : ''}`);
  };
  const invalidateAnalysis = () => {
    setRun(undefined); setFrames([]); setReplacement(undefined);
    setSelection((current) => ({ ...current, pinned: [], excluded: [] }));
  };
  const reselect = (next = selection) => {
    if (!run) return;
    void perform(async () => { receiveFrames(await client.current.request({ type: 'select', run, selection: next }, reportProgress)); });
  };
  const save = (references?: FrameReference[]) => {
    if (!projectDirectoryHandle || !file || !decoded.current || busy) return;
    if (references && !window.confirm(`Save ${references.length} PNG frames to ${destination}? They will not be added to Dataset automatically.`)) return;
    const current = decoded.current;
    void perform(async (signal) => {
      let saved = 0;
      const timestamps = references?.map((frame) => frame.timestamp) ?? [current.timestamp];
      try {
        for (const timestamp of timestamps) {
          signal.throwIfAborted();
          const frame = references ? await readVideoFrame(file, timestamp, signal) : current;
          const blob = await frame.canvas.convertToBlob({ type: 'image/png' });
          signal.throwIfAborted();
          const path = await saveVideoFrame(projectDirectoryHandle, destination, name, frame.timestamp, blob);
          setSavedPaths(paths => [...paths, path]);
          saved++;
          reportProgress({ phase: 'Saving PNG frames', completed: saved, total: timestamps.length });
        }
      } finally {
        if (saved) {
          await savedCallback.current?.();
          logger.success(`Saved ${saved} PNG frames to ${destination}`);
          useUIStore.getState().addNotification('success', `Saved ${saved} frame${saved === 1 ? '' : 's'}`);
        }
      }
    });
  };

  const togglePlayback = () => {
    const video = videoRef.current; if (!video) return;
    if (playing) video.pause(); else { video.currentTime = position >= end || position < start ? start : position; video.playbackRate = speed; void video.play().catch(reportError); }
  };
  useCommands([
    { id: 'video.play', label: playing ? 'Pause video' : 'Play video', shortcut: 'Space', active, disabled: !info || decoding, run: togglePlayback },
    { id: 'video.previous', label: 'Previous frame', shortcut: 'ArrowLeft', active, disabled: !info || decoding, run: () => step(-1) },
    { id: 'video.next', label: 'Next frame', shortcut: 'ArrowRight', active, disabled: !info || decoding, run: () => step(1) },
    { id: 'video.in', label: 'Set range In', shortcut: 'I', active, disabled: !info || busy, run: () => { setStart(position); invalidateAnalysis(); } },
    { id: 'video.out', label: 'Set range Out', shortcut: 'O', active, disabled: !info || busy || playing || decoding, run: () => { setEnd(Math.min(info!.end, position + Math.max(decoded.current?.duration ?? 0, 0.000001))); invalidateAnalysis(); } },
    { id: 'video.loop', label: 'Loop range', shortcut: 'L', active, disabled: !info, run: () => setLoop(value => !value) },
    { id: 'video.save', label: 'Save displayed frame', active, disabled: !info || !projectDirectoryHandle || busy || playing || decoding || !decoded.current, run: () => save() },
    { id: 'video.cancel', label: 'Cancel video operation', active, disabled: !busy, run: cancel },
  ], () => commandRoot.current?.closest<HTMLElement>('[data-dock-view]') ?? commandRoot.current);

  return <div ref={commandRoot} className="flex h-full min-h-0 flex-col overflow-auto p-3 text-sm" data-video-frames-tool>
    <div className="flex flex-wrap items-center gap-2 border-b border-border pb-2">
      <Video className="h-4 w-4" /><strong>Video Frames</strong><span className="min-w-0 truncate text-xs text-muted-foreground">{file ? name : ''}</span>
      {!initialFile && projectVideos.length > 0 ? <select aria-label="Project video" value={projectVideos.find((video) => video.file === file)?.path ?? ''} disabled={busy} className={inputClass}
        onChange={(event) => { const video = projectVideos.find((candidate) => candidate.path === event.target.value); if (video) { setFile(video.file); setName(video.name); } }}>
        <option value="">Choose project video…</option>{projectVideos.map((video) => <option key={video.path} value={video.path}>{video.path}</option>)}
      </select> : null}
      {!initialFile && <label className={buttonClass} tabIndex={0} role="button" onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.currentTarget.querySelector('input')?.click(); } }}>Open video<input aria-label="Open video" type="file" accept="video/mp4,video/webm,.mp4,.webm" className="hidden" disabled={busy} onChange={(event) => {
        const chosen = event.target.files?.[0]; if (chosen) { setFile(chosen); setName(chosen.name); }
        event.target.value = '';
      }} /></label>}
      <button type="button" className={buttonClass} aria-pressed={mode === 'manual'} onClick={() => setMode('manual')}>Manual</button>
      <button type="button" className={buttonClass} aria-pressed={mode === 'automatic'} onClick={() => setMode('automatic')}>Automatic</button>
    </div>
    {savedPaths.length > 0 && <div className="flex items-center gap-3 py-2 text-xs"><span>{savedPaths.length} saved frames</span><button className={buttonClass} disabled={busy} onClick={() => void perform(async signal => { await addSavedFramesToDataset(projectDirectoryHandle!, savedPaths, signal, (completed, total) => reportProgress({ phase: 'Adding to Dataset', completed, total })); setSavedPaths([]); })}>Add saved frames to Dataset</button></div>}
    {error && <p role="alert" className="my-2 rounded border border-red-500/40 p-2 text-xs text-red-400">{error}</p>}
    {file && !info && !error && <p className="p-3">Reading video frame timestamps…</p>}
    <div className="my-2 overflow-auto rounded border border-border bg-black" style={{ minHeight: 180, maxHeight: '55vh' }}>
      <video ref={videoRef} src={url} controls className="mx-auto max-h-[50vh] max-w-full" style={{ display: playing ? 'block' : 'none' }}
        onPlay={() => { setPlaying(true); }} onPause={() => {
          setPlaying(false);
          if (ignorePause.current) { ignorePause.current = false; return; }
          void showFrame(latestPresented.current ?? videoRef.current?.currentTime ?? position);
        }}
        onTimeUpdate={(event) => {
          const video = event.currentTarget;
          if (video.currentTime >= end && end > start) {
            if (loop) video.currentTime = start;
            else seek(info?.timestamps[findFrameIndex(info.timestamps, Math.max(start, end - 0.000001))] ?? start);
          }
          if (!video.paused) setPosition(video.currentTime);
        }} />
      <canvas ref={canvasRef} className="mx-auto" style={{ display: playing ? 'none' : 'block', width: info ? info.width * zoom : 320, maxWidth: zoom === 1 ? '100%' : undefined, height: 'auto' }} />
    </div>
    {info && <>
      <input aria-label="Video timeline" type="range" min={0} max={info.timestamps.length - 1} step={1} value={findFrameIndex(info.timestamps, position)} onChange={(event) => seek(info.timestamps[Number(event.target.value)])} />
      <div className="my-2 flex flex-wrap items-center gap-2">
        <button className={buttonClass} disabled={decoding} onClick={() => step(-1)} aria-label="Previous frame"><ChevronLeft className="h-4 w-4" /></button>
        <button className={buttonClass} disabled={decoding} onClick={() => step(1)} aria-label="Next frame"><ChevronRight className="h-4 w-4" /></button>
        <button className={buttonClass} onClick={() => {
          const video = videoRef.current; if (!video) return;
          if (playing) video.pause(); else {
            video.currentTime = position >= end || position < start ? start : position;
            video.playbackRate = speed; void video.play().catch(reportError);
          }
        }}>{playing ? 'Pause' : 'Play'}</button>
        <span className="font-mono text-xs">{frameTimecode(position)} / {frameTimecode(info.end)}</span>
        <label className="text-xs">Speed <select aria-label="Playback speed" className={inputClass} value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>{[0.1, 0.25, 0.5, 1, 2].map((value) => <option key={value} value={value}>{value}×</option>)}</select></label>
        <label className="text-xs">Zoom <select aria-label="Frame zoom" className={inputClass} value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>{[0.25, 0.5, 1, 2].map((value) => <option key={value} value={value}>{value}×</option>)}</select></label>
        <span className="text-xs text-muted-foreground">{info.width} × {info.height}{decoding ? ' · Decoding…' : ''}</span>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <label>In (s) <input className={`${inputClass} w-24`} aria-label="Range start" type="number" min={info.start} max={end} step="0.001" value={start} disabled={busy} onChange={(event) => { setStart(Number(event.target.value)); invalidateAnalysis(); }} /></label>
        <button className={buttonClass} disabled={busy} onClick={() => { setStart(position); invalidateAnalysis(); }}>Set In</button>
        <label>Out (s) <input className={`${inputClass} w-24`} aria-label="Range end" type="number" min={start} max={info.end} step="0.001" value={end} disabled={busy} onChange={(event) => { setEnd(Number(event.target.value)); invalidateAnalysis(); }} /></label>
        <button className={buttonClass} disabled={busy || playing || decoding} onClick={() => { setEnd(Math.min(info.end, position + Math.max(decoded.current?.duration ?? 0, 0.000001))); invalidateAnalysis(); }}>Set Out</button>
        <label><input type="checkbox" checked={loop} onChange={(event) => setLoop(event.target.checked)} /> Loop range</label>
      </div>
    </>}
    <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
      <label>Save to <select aria-label="Frame destination" className={inputClass} value={destination} disabled={!projectDirectoryHandle || busy} onChange={(event) => setDestination(event.target.value)}>{directories.map((path) => <option key={path}>{path}</option>)}</select></label>
      <button className={buttonClass} disabled={!projectDirectoryHandle || busy} onClick={() => {
        if (projectDirectoryHandle) void listFrameDirectories(projectDirectoryHandle).then(setDirectories).catch(reportError);
      }}>Refresh folders</button>
      <button className={buttonClass} disabled={!info || !projectDirectoryHandle || busy || playing || decoding || !decoded.current} onClick={() => save()}><Download className="h-3 w-3" />Save frame</button>
      {!projectDirectoryHandle && <span className="text-muted-foreground">Open or save a project directory to write frames.</span>}
    </div>
    {mode === 'automatic' && <div className="space-y-3 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <button className={buttonClass} disabled={busy} onClick={() => void perform(async () => {
          const result = await client.current.request({ type: 'model' }, reportProgress); setModelReady(true); logger.success(`DINOv2 ready (${result.runtime})`);
        })}>{modelReady ? 'Check DINOv2 model' : 'Download DINOv2 · 88.5 MB'}</button>
        <button className={buttonClass} disabled={busy} onClick={() => {
          if (window.confirm('Clear downloaded DINOv2 weights and all cached video analyses? Other video tabs must be idle.')) void perform(async () => {
            await clearVideoCache(); setModelReady(false); invalidateAnalysis();
          });
        }}>Clear video cache</button>
      </div>
      <details className="text-xs text-muted-foreground"><summary>About local analysis</summary><p className="mt-2">DINOv2 downloads from Hugging Face. Videos stay on this device. Distance measures visual difference, not training quality.</p></details>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label>Analysis <select className={inputClass} aria-label="Analysis mode" disabled={busy} value={analysisMode} onChange={(event) => { setAnalysisMode(event.target.value as 'fast' | 'full'); invalidateAnalysis(); }}><option value="fast">Fast</option><option value="full">Full — every frame</option></select></label>
        {analysisMode === 'fast' && <label>Frames/s <input className={`${inputClass} w-20`} aria-label="Sampling rate" type="number" min="0.1" max="60" step="0.1" value={sampleRate} disabled={busy} onChange={(event) => { setSampleRate(Number(event.target.value)); invalidateAnalysis(); }} /></label>}
        <label>Maximum frames <input className={`${inputClass} w-20`} aria-label="Maximum frames" type="number" min="1" max="1000" value={selection.limit} disabled={busy} onChange={(event) => setSelection({ ...selection, limit: Number(event.target.value) })} /></label>
      </div>
      <details className="text-xs"><summary>Advanced selection</summary><div className="mt-2 flex flex-wrap items-center gap-3">
        <label>Minimum distance <input className={`${inputClass} w-20`} aria-label="Minimum distance" type="number" min="0" max="2" step="0.01" value={selection.distance} disabled={busy} onChange={(event) => setSelection({ ...selection, distance: Number(event.target.value) })} /></label>
        {(['excludeDark', 'excludeBlurry', 'excludeTransitions'] as const).map((key) => <label key={key}><input type="checkbox" checked={selection[key]} disabled={busy} onChange={(event) => setSelection({ ...selection, [key]: event.target.checked })} /> {key === 'excludeDark' ? 'Exclude dark' : key === 'excludeBlurry' ? 'Exclude blurry' : 'Exclude transitions'}</label>)}
      </div></details>
      {analysisMode === 'full' && <p className="text-xs text-muted-foreground">Full analysis can take longer than playback.</p>}
      <div className="flex flex-wrap gap-2">
        <button className={buttonClass} disabled={!info || !modelReady || busy} onClick={() => void perform(async () => {
          const next = { ...selection, pinned: [], excluded: [] }; setSelection(next); setReplacement(undefined);
          receiveFrames(await client.current.request({ type: 'analyze', file: file!, options: { mode: analysisMode, start, end, sampleRate }, selection: next }, reportProgress));
        })}>Analyze video</button>
        <button className={buttonClass} disabled={!run || busy} onClick={() => reselect()}>Recalculate selection</button>
        <button className={buttonClass} disabled={!frames.length || !projectDirectoryHandle || busy || decoding} onClick={() => save(frames)}>Save selected ({frames.length})</button>
        {!!selection.excluded.length && <button className={buttonClass} disabled={busy} onClick={() => { const next = { ...selection, excluded: [] }; setSelection(next); reselect(next); }}>Reset exclusions ({selection.excluded.length})</button>}
      </div>
      {replacement !== undefined && <div className="flex flex-wrap items-center gap-2 rounded border border-border p-2 text-xs">
        Replacing {frameTimecode(replacement)}. Step through nearby frames, then confirm.
        <button className={buttonClass} disabled={busy || decoding || playing || !decoded.current} onClick={() => void perform(async () => {
          const result = await client.current.request({ type: 'include', file: file!, run: run!, timestamp: decoded.current!.timestamp }, reportProgress);
          const timestamp = result.frames![0].timestamp;
          const next = { ...selection, pinned: [...new Set([...selection.pinned.filter((value) => value !== replacement), timestamp])],
            excluded: [...new Set([...selection.excluded.filter((value) => value !== timestamp), ...(timestamp !== replacement ? [replacement] : [])])] };
          setSelection(next); setReplacement(undefined);
          receiveFrames(await client.current.request({ type: 'select', run: run!, selection: next }, reportProgress));
        })}>Use displayed frame</button>
        <button className={buttonClass} onClick={() => setReplacement(undefined)}>Cancel replacement</button>
      </div>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
        {run && frames.map((frame) => <article key={frame.timestamp} className="rounded border border-border p-2">
          <button className="w-full" onClick={() => seek(frame.timestamp)}><FrameThumbnail run={run} frame={frame} /><span className="font-mono text-xs">{frameTimecode(frame.timestamp)}</span></button>
          <p className="min-h-4 text-xs text-yellow-500">{[frame.quality.dark && 'Dark', frame.quality.blurry && 'Possibly blurry', frame.quality.transition && 'Scene transition'].filter(Boolean).join(' · ')}</p>
          <div className="mt-1 flex gap-1">
            <button className={buttonClass} disabled={busy} aria-label={`Pin ${frameTimecode(frame.timestamp)}`} aria-pressed={selection.pinned.includes(frame.timestamp)} onClick={() => setSelection({ ...selection, pinned: selection.pinned.includes(frame.timestamp) ? selection.pinned.filter((value) => value !== frame.timestamp) : [...selection.pinned, frame.timestamp] })}><Pin className="h-3 w-3" /></button>
            <button className={buttonClass} disabled={busy} onClick={() => { setReplacement(frame.timestamp); seek(frame.timestamp); }}>Replace</button>
            <button className={buttonClass} disabled={busy} aria-label={`Exclude ${frameTimecode(frame.timestamp)}`} onClick={() => {
              const next = { ...selection, pinned: selection.pinned.filter((value) => value !== frame.timestamp), excluded: [...selection.excluded, frame.timestamp] };
              setSelection(next); setFrames((current) => current.filter((item) => item.timestamp !== frame.timestamp));
            }}><X className="h-3 w-3" /></button>
          </div>
        </article>)}
      </div>
      {run && !frames.length && <p className="text-xs">No frames match these filters. Lower the distance or relax the quality filters and recalculate.</p>}
    </div>}
    {busy && <div role="status" className="sticky bottom-0 mt-3 flex items-center gap-2 rounded border border-border bg-card p-2 text-xs">
      <span>{progress?.phase ?? 'Working…'}{progress?.analyzed !== undefined ? ` · ${progress.analyzed} analyzed` : ''}{progress?.secondsRemaining ? ` · ~${Math.ceil(progress.secondsRemaining / 60)} min remaining` : ''}</span>
      <progress className="min-w-0 flex-1" value={progress?.completed ?? 0} max={progress?.total || 1} />
      <button className={buttonClass} onClick={cancel}>Cancel</button>
    </div>}
  </div>;
};
