import type {MyDialogFilter} from '@lib/storages/filters';
import {
  FOLDERS_SYNC_KIND,
  FOLDERS_SYNC_D_TAG,
  FOLDERS_SYNC_VERSION,
  isValidSnapshot,
  type FolderSnapshot
} from '@lib/nostra/folders-sync-types';
import {buildSnapshotFromFilters, applySnapshotToFilters} from '@lib/nostra/folders-sync-snapshot';
import {decideMerge, type MergeDecision} from '@lib/nostra/folders-sync-merge';
import {
  getLastPublishedAt, setLastPublishedAt,
  getLastModifiedAt
} from '@lib/nostra/folders-sync-state';
import {START_LOCAL_ID} from '@appManagers/constants';

export type FoldersSyncDeps = {
  chatAPI: {
    publishEvent: (event: {kind: number, created_at: number, tags: any[], content: string}) => Promise<void>;
    queryLatestEvent: (filter: {kinds: number[], '#d': string[], limit: number}) => Promise<{kind: number, created_at: number, content: string} | null>;
  };
  filtersStore: {
    getFilters: () => MyDialogFilter[] | Promise<MyDialogFilter[]>;
    setFilters: (next: MyDialogFilter[]) => void | Promise<void>;
    reseedSystemFolders: () => void | Promise<void>;
  };
  encrypt: (plaintext: string) => string;
  decrypt: (ciphertext: string) => string;
  nowSeconds: () => number;
  toast: (message: string) => void;
  i18n?: (key: string) => string;
};

export type ReconcileResult = MergeDecision;

export class FoldersSync {
  private applyingRemote = false;

  constructor(private deps: FoldersSyncDeps) {}

  async reconcile(): Promise<ReconcileResult> {
    const remote = await this.fetchRemote();
    const filters = await this.deps.filtersStore.getFilters();
    const hasCustom = filters.some((f) => f.id >= START_LOCAL_ID);

    const decision = decideMerge({
      remoteCreatedAt: remote?.createdAt ?? null,
      localPublishedAt: getLastPublishedAt(),
      localModifiedAt: getLastModifiedAt(),
      hasLocalCustomFolders: hasCustom
    });

    switch(decision.action) {
      case 'publish-local':
      case 'local-wins':
        await this.publish();
        return decision;

      case 'remote-wins': {
        this.applyingRemote = true;
        try {
          const next = applySnapshotToFilters(filters, remote!.snapshot);
          await this.deps.filtersStore.setFilters(next);
          await this.deps.filtersStore.reseedSystemFolders();
          if(decision.showToast) {
            const msg = this.deps.i18n ?
              this.deps.i18n('FoldersSyncOverwritten') :
              'Folders updated from another device. Your local changes were overwritten.';
            this.deps.toast(msg);
          }
        } finally {
          this.applyingRemote = false;
        }
        return decision;
      }

      case 'in-sync':
      case 'no-op':
        return decision;
    }
  }

  async publish(): Promise<void> {
    if(this.applyingRemote) return;
    const filters = await this.deps.filtersStore.getFilters();
    const snapshot = buildSnapshotFromFilters(filters);
    const plaintext = JSON.stringify(snapshot);
    const ciphertext = this.deps.encrypt(plaintext);
    const createdAt = this.deps.nowSeconds();

    await this.deps.chatAPI.publishEvent({
      kind: FOLDERS_SYNC_KIND,
      created_at: createdAt,
      tags: [['d', FOLDERS_SYNC_D_TAG]],
      content: ciphertext
    });

    setLastPublishedAt(createdAt);
  }

  private async fetchRemote(): Promise<{createdAt: number, snapshot: FolderSnapshot} | null> {
    let ev;
    try {
      ev = await this.deps.chatAPI.queryLatestEvent({
        'kinds': [FOLDERS_SYNC_KIND],
        '#d': [FOLDERS_SYNC_D_TAG],
        'limit': 1
      });
    } catch{
      return null;
    }
    if(!ev) return null;

    let snapshot: unknown;
    try {
      snapshot = JSON.parse(this.deps.decrypt(ev.content));
    } catch{
      return null;
    }
    if(!isValidSnapshot(snapshot)) return null;
    if(snapshot.version !== FOLDERS_SYNC_VERSION) {
      console.warn('[FoldersSync] unknown snapshot version', snapshot.version);
      return null;
    }
    return {createdAt: ev.created_at, snapshot};
  }
}
