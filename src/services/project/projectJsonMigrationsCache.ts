import type { ProjectDirectoryHandle } from './projectDirectoryService';

// Every save needs the migration markers of project.json, which only the migrations change. Parsing the whole
// manifest (megabytes in a large project) to read them on each save is avoided by remembering them per directory.
const cache = new WeakMap<object, unknown>();

export const getCachedProjectJsonMigrations = <T>(directory: ProjectDirectoryHandle): { value: T } | undefined =>
  cache.has(directory as object) ? { value: cache.get(directory as object) as T } : undefined;

export const setCachedProjectJsonMigrations = (directory: ProjectDirectoryHandle, migrations: unknown): void => {
  cache.set(directory as object, migrations);
};

/** Call after anything else rewrote project.json (a migration, a path move) so the next save re-reads the markers. */
export const invalidateProjectJsonMigrations = (directory: ProjectDirectoryHandle): void => {
  cache.delete(directory as object);
};
