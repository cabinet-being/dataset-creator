import { OBJECT_STORES } from '../../lib/constants';
import { dbDelete, dbGet, dbPut } from '../persistence/indexedDBService';

export type LocalTaggerFileKey = 'model' | 'tags';

type StoredLocalTaggerFileHandle = {
  id: LocalTaggerFileKey;
  handle: FileSystemFileHandle;
};

type FileSystemPermissionMode = 'read' | 'readwrite';

type PermissionCapableFileHandle = FileSystemFileHandle & {
  queryPermission?: (descriptor?: { mode?: FileSystemPermissionMode }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: { mode?: FileSystemPermissionMode }) => Promise<PermissionState>;
};

export const saveLocalTaggerFileHandle = async (
  id: LocalTaggerFileKey,
  handle: FileSystemFileHandle
): Promise<void> => {
  await dbPut<StoredLocalTaggerFileHandle>(OBJECT_STORES.TAGGER_FILE_HANDLES, { id, handle });
};

export const getLocalTaggerFileHandle = async (
  id: LocalTaggerFileKey
): Promise<FileSystemFileHandle | undefined> => {
  const storedHandle = await dbGet<StoredLocalTaggerFileHandle>(OBJECT_STORES.TAGGER_FILE_HANDLES, id);
  return storedHandle?.handle;
};

export const deleteLocalTaggerFileHandle = async (id: LocalTaggerFileKey): Promise<void> => {
  await dbDelete(OBJECT_STORES.TAGGER_FILE_HANDLES, id);
};

export const ensureLocalTaggerFileReadPermission = async (
  handle: FileSystemFileHandle
): Promise<boolean> => {
  const permissionHandle = handle as PermissionCapableFileHandle;

  if (!permissionHandle.queryPermission || !permissionHandle.requestPermission) {
    return true;
  }

  if ((await permissionHandle.queryPermission({ mode: 'read' })) === 'granted') {
    return true;
  }

  return (await permissionHandle.requestPermission({ mode: 'read' })) === 'granted';
};
