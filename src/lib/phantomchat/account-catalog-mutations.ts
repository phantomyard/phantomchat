import type {CatalogRevision} from './account-catalog';

let archiveWriter: ((groupId: string, archivedAt: number, updatedAt: number, previous?: CatalogRevision) => Promise<CatalogRevision>) | undefined;
export function registerCatalogArchiveWriter(writer: typeof archiveWriter): void {
  archiveWriter = writer;
}
export function recordCatalogArchive(groupId: string, archivedAt: number, updatedAt: number, previous?: CatalogRevision): Promise<CatalogRevision | undefined> {
  return archiveWriter ? archiveWriter(groupId, archivedAt, updatedAt, previous) : Promise.resolve(undefined);
}
