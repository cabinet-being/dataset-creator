import type { ProjectDirectoryHandle } from './projectDirectoryService';
import { moveExplorerEntries } from './explorerFileService';
import { PROJECT_DATASET_DIRECTORY } from './projectLayoutService';

export const LEGACY_DATASET_MIGRATION_VERSION = 1;

export type LegacyDatasetMembership = {
  datasetFilePath?: string;
  assetIds?: string[];
  assetPaths?: string[];
  psdAssetPaths?: string[];
};

export type LegacyDatasetMigrationEntry = {
  from: string;
  to?: string;
  status: 'moved' | 'already-in-dataset' | 'failed';
  message?: string;
};

export type LegacyDatasetMigrationReport = {
  version: typeof LEGACY_DATASET_MIGRATION_VERSION;
  operationId: string;
  status: 'running' | 'complete' | 'partial';
  startedAt: string;
  completedAt?: string;
  recoverySnapshot: LegacyDatasetMembership;
  operations: LegacyDatasetMigrationEntry[];
  conflicts: Array<{ path: string; message: string }>;
};

const projectPath = (path: string): string => path.startsWith('Project/') ? path : `Project/${path.replace(/^\/?/, '')}`;
const isDatasetPath = (path: string): boolean => {
  const normalized = path.replace(/^Project\//, '');
  return normalized === PROJECT_DATASET_DIRECTORY || normalized.startsWith(`${PROJECT_DATASET_DIRECTORY}/`);
};

export const createLegacyDatasetMigration = (
  membership: LegacyDatasetMembership,
  resolvedAssetPaths: string[] = []
): LegacyDatasetMigrationReport => {
  const paths = [...new Set([
    ...resolvedAssetPaths,
    ...(membership.assetPaths ?? []),
    ...(membership.psdAssetPaths ?? []),
  ].filter(Boolean).map(projectPath))];
  return {
    version: LEGACY_DATASET_MIGRATION_VERSION,
    operationId: crypto.randomUUID(),
    status: 'running',
    startedAt: new Date().toISOString(),
    recoverySnapshot: {
      datasetFilePath: membership.datasetFilePath,
      assetIds: [...new Set(membership.assetIds ?? [])],
      assetPaths: [...new Set(membership.assetPaths ?? [])],
      psdAssetPaths: [...new Set(membership.psdAssetPaths ?? [])],
    },
    operations: paths.map((from) => ({
      from,
      to: isDatasetPath(from) ? from : undefined,
      status: isDatasetPath(from) ? 'already-in-dataset' : 'failed',
      message: isDatasetPath(from) ? undefined : 'Pending migration',
    })),
    conflicts: [],
  };
};

export const migrateLegacyDatasetMembership = async (
  root: ProjectDirectoryHandle,
  report: LegacyDatasetMigrationReport,
  checkpoint?: (report: LegacyDatasetMigrationReport) => void | Promise<void>
): Promise<LegacyDatasetMigrationReport> => {
  const next: LegacyDatasetMigrationReport = {
    ...report,
    status: 'running',
    operations: report.operations.map((entry) => ({ ...entry })),
    conflicts: [],
  };
  await checkpoint?.(next);
  for (let index = 0; index < next.operations.length; index += 1) {
    const entry = next.operations[index];
    if (entry.status === 'moved' || entry.status === 'already-in-dataset') continue;
    try {
      const [change] = await moveExplorerEntries(root, [{
        path: entry.from,
        name: entry.from.split('/').pop() ?? entry.from,
        kind: 'file',
      }], `Project/${PROJECT_DATASET_DIRECTORY}`);
      next.operations[index] = { from: entry.from, to: change.to, status: 'moved' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      next.operations[index] = { ...entry, status: 'failed', message };
      next.conflicts.push({ path: entry.from, message });
    }
    await checkpoint?.(next);
  }
  next.status = next.operations.some((entry) => entry.status === 'failed') ? 'partial' : 'complete';
  next.completedAt = new Date().toISOString();
  await checkpoint?.(next);
  return next;
};

export const getLegacyDatasetPathMoves = (report: LegacyDatasetMigrationReport) => report.operations
  .filter((entry): entry is LegacyDatasetMigrationEntry & { to: string } => entry.status === 'moved' && Boolean(entry.to))
  .map((entry) => ({ from: entry.from, to: entry.to }));

export const removeLegacyDatasetDocuments = async (directory: ProjectDirectoryHandle): Promise<void> => {
  const children: Array<[string, ProjectDirectoryHandle | { getFile: () => Promise<File> }]> = [];
  for await (const entry of directory.entries()) children.push(entry);
  for (const [name, entry] of children) {
    if ('entries' in entry) {
      await removeLegacyDatasetDocuments(entry);
    } else if (name.toLowerCase().endsWith('.dataset.json')) {
      await directory.removeEntry(name);
    }
  }
};
