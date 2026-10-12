import { createSaveQueue, type SaveState } from './saveQueue';

export type SessionSaveState = SaveState | { status: 'local' };

type Options<Project extends { id: string }, Directory> = {
  getProject: () => Project;
  subscribeProject: (listener: (project: Project) => void) => () => void;
  getDirectory: () => Directory | undefined;
  subscribeDirectory: (listener: (directory: Directory | undefined) => void) => () => void;
  write: (project: Project, previous: Project, directory: Directory) => Promise<void>;
  changed: (state: SessionSaveState) => void;
  delay?: number;
};

/** Binds each queue to one project and directory synchronously, independently of rendering. */
export function createSaveSession<Project extends { id: string }, Directory>(options: Options<Project, Directory>) {
  let queue: ReturnType<typeof createSaveQueue<Project>> | undefined;
  let unsubscribeProject: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let currentDirectory: Directory | undefined;
  let disposed = false;
  const disconnect = () => {
    clearTimeout(timer);
    unsubscribeProject?.(); unsubscribeProject = undefined;
    queue?.stop(); queue = undefined;
    currentDirectory = undefined;
  };
  const connect = (directory: Directory | undefined) => {
    if (disposed || (directory === currentDirectory && queue)) return;
    disconnect();
    currentDirectory = directory;
    if (!directory) { options.changed({status:'local'}); return; }
    const initial = options.getProject();
    const owner = createSaveQueue(initial,
      (snapshot, baseline) => options.write(snapshot, baseline, directory),
      state => { if (queue === owner) options.changed(state); });
    queue = owner;
    options.changed({status:'saved'});
    unsubscribeProject = options.subscribeProject(next => {
      if (next.id !== initial.id) {
        disconnect(); options.changed({status:'local'}); return;
      }
      owner.enqueue(next);
      clearTimeout(timer);
      timer = setTimeout(() => { void owner.flush().catch(() => {}); }, options.delay ?? 250);
    });
  };
  const unsubscribeDirectory = options.subscribeDirectory(connect);
  connect(options.getDirectory());
  return {
    flush: () => { clearTimeout(timer); return queue?.flush() ?? Promise.resolve(); },
    runExclusive: <T>(action: () => Promise<T>): Promise<T> => {
      clearTimeout(timer);
      if (!queue) return Promise.reject(new Error('Open a project directory before changing files.'));
      return queue.runExclusive(action);
    },
    isDirty: () => queue?.isDirty() ?? false,
    dispose: () => { disposed = true; unsubscribeDirectory(); disconnect(); },
  };
}
