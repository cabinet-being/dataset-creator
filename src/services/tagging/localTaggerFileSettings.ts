import { OBJECT_STORES } from '../../lib/constants';
import { dbGet, getDB } from '../persistence/indexedDBService';

export type LocalTaggerFileKey = 'model' | 'tags';
export type LocalTaggerSavedFile = FileSystemFileHandle | File;

type StoredLocalTaggerFile = {
  id: LocalTaggerFileKey;
  handle?: FileSystemFileHandle;
  file?: File;
  name?: string;
  sha256?: string;
  source?: 'download';
};

type PermissionCapableFileHandle = FileSystemFileHandle & {
  queryPermission?: (descriptor?: { mode?: 'read' }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: { mode?: 'read' }) => Promise<PermissionState>;
};

export type LocalTaggerFileProvenance = { sha256: string; source: 'download' };

export const saveLocalTaggerFile = async (id: LocalTaggerFileKey, resource: LocalTaggerSavedFile, provenance?: LocalTaggerFileProvenance): Promise<void> => {
  const name = resource.name;
  const entry: StoredLocalTaggerFile = resource instanceof File
    ? { id, name, file: resource, ...provenance }
    : { id, name, handle: resource };
  const database = await getDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(OBJECT_STORES.TAGGER_FILE_HANDLES, 'readwrite');
    transaction.objectStore(OBJECT_STORES.TAGGER_FILE_HANDLES).put(entry);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Browser storage could not save the selected file.'));
  });
};

export const saveLocalTaggerFileHandle = (id: LocalTaggerFileKey, handle: FileSystemFileHandle): Promise<void> =>
  saveLocalTaggerFile(id, handle);

export const getLocalTaggerSavedFile = (id: LocalTaggerFileKey): Promise<StoredLocalTaggerFile | undefined> =>
  dbGet<StoredLocalTaggerFile>(OBJECT_STORES.TAGGER_FILE_HANDLES, id);

export const getLocalTaggerFileHandle = async (id: LocalTaggerFileKey): Promise<FileSystemFileHandle | undefined> =>
  (await getLocalTaggerSavedFile(id))?.handle;

export const getLocalTaggerSavedFileNames = async (): Promise<{ model?: string; tags?: string }> => {
  const [model, tags] = await Promise.all([getLocalTaggerSavedFile('model'), getLocalTaggerSavedFile('tags')]);
  return { model: model?.name ?? model?.handle?.name ?? model?.file?.name, tags: tags?.name ?? tags?.handle?.name ?? tags?.file?.name };
};

export const queryLocalTaggerFileReadPermission = async (handle: FileSystemFileHandle): Promise<boolean> => {
  const permissionHandle = handle as PermissionCapableFileHandle;
  return !permissionHandle.queryPermission || (await permissionHandle.queryPermission({ mode: 'read' })) === 'granted';
};

export const ensureLocalTaggerFileReadPermission = async (handle: FileSystemFileHandle): Promise<boolean> => {
  if (await queryLocalTaggerFileReadPermission(handle)) return true;
  const permissionHandle = handle as PermissionCapableFileHandle;
  return !!permissionHandle.requestPermission && (await permissionHandle.requestPermission({ mode: 'read' })) === 'granted';
};

export const readLocalTaggerSavedFile = async (id: LocalTaggerFileKey, requestPermission: boolean): Promise<File | undefined> => {
  const entry = await getLocalTaggerSavedFile(id);
  if (entry?.file) return entry.file;
  if (!entry?.handle) return undefined;
  const permitted = requestPermission
    ? await ensureLocalTaggerFileReadPermission(entry.handle)
    : await queryLocalTaggerFileReadPermission(entry.handle);
  if (!permitted) throw new Error('Browser permission is required to read saved local caption model files. Use Reconnect.');
  try {
    return await entry.handle.getFile();
  } catch (error) {
    if (error instanceof Error && error.name === 'NotFoundError') {
      throw new Error(`${entry.handle.name} is no longer available. Choose it again in Settings.`);
    }
    throw error;
  }
};
