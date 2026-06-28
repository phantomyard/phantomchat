/**
 * Regression: a custom folder created in the UI must survive a PWA restart.
 *
 * Root cause it guards: the FoldersSync publish wiring listened to
 * filter_update / filter_delete / filter_order but NOT filter_new. A freshly
 * created folder dispatches ONLY filter_new (filters.ts saveDialogFilter), so
 * it never bumped localModifiedAt nor scheduled a publish. On the next boot
 * reconcile() saw a stale remote snapshot as authoritative, took remote-wins,
 * and reseedSystemFolders() wiped the new folder off disk.
 *
 * The fix wires filter_new (via FOLDER_SYNC_TRIGGER_EVENTS) so creation bumps
 * localModifiedAt — which makes reconcile take local-wins on the next boot and
 * preserve + republish the folder instead of dropping it.
 */
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {FoldersSync} from '@lib/phantomchat/folders-sync';
import {buildLocalFilter} from '@lib/storages/filtersLocal';
import {buildSnapshotFromFilters} from '@lib/phantomchat/folders-sync-snapshot';
import {
  FOLDER_ID_ALL,
  FOLDER_ID_GROUPS,
  FOLDER_ID_ARCHIVE
} from '@appManagers/constants';
import {
  FOLDERS_SYNC_KIND,
  FOLDERS_SYNC_D_TAG,
  FOLDER_SYNC_TRIGGER_EVENTS
} from '@lib/phantomchat/folders-sync-types';
import {
  setLastPublishedAt,
  setLastModifiedAt,
  LS_KEY_LAST_PUBLISHED,
  LS_KEY_LAST_MODIFIED
} from '@lib/phantomchat/folders-sync-state';
import type {MyDialogFilter} from '@lib/storages/filters';

function mkBaseFilters(): MyDialogFilter[] {
  return [
    buildLocalFilter(FOLDER_ID_ALL),
    buildLocalFilter(FOLDER_ID_GROUPS),
    buildLocalFilter(FOLDER_ID_ARCHIVE)
  ];
}

function mkCustom(id: number, title: string): MyDialogFilter {
  const f = buildLocalFilter(FOLDER_ID_ALL);
  f.id = id;
  (f as any).title = {_: 'textWithEntities', text: title, entities: []};
  f.pFlags = {};
  return f;
}

function mkDeps(localFilters: MyDialogFilter[], remoteCreatedAt: number | null, remoteSnapshotFilters: MyDialogFilter[]) {
  const filtersState = {current: localFilters};
  const reseed = {count: 0};
  const publishedEvents: any[] = [];

  const remoteEvent = remoteCreatedAt === null ? null : {
    kind: FOLDERS_SYNC_KIND,
    created_at: remoteCreatedAt,
    content: `enc(${JSON.stringify(buildSnapshotFromFilters(remoteSnapshotFilters))})`
  };

  const deps = {
    chatAPI: {
      publishEvent: vi.fn(async(ev: any) => { publishedEvents.push(ev); }),
      queryLatestEvent: vi.fn(async() => remoteEvent)
    },
    filtersStore: {
      getFilters: () => filtersState.current,
      setFilters: (next: MyDialogFilter[]) => { filtersState.current = next; },
      reseedSystemFolders: () => { reseed.count++; }
    },
    encrypt: (plain: string) => `enc(${plain})`,
    decrypt: (cipher: string) => cipher.replace(/^enc\(|\)$/g, ''),
    nowSeconds: () => 5000,
    toast: vi.fn(),
    i18n: (_k: string) => 'overwritten'
  };

  return {deps, filtersState, reseed, publishedEvents};
}

describe('folders-sync: new folder survives restart', () => {
  beforeEach(() => {
    localStorage.removeItem(LS_KEY_LAST_PUBLISHED);
    localStorage.removeItem(LS_KEY_LAST_MODIFIED);
  });

  it('wires filter_new into the sync trigger events (the original miss)', () => {
    expect(FOLDER_SYNC_TRIGGER_EVENTS).toContain('filter_new');
    expect(FOLDER_SYNC_TRIGGER_EVENTS).toContain('filter_update');
    expect(FOLDER_SYNC_TRIGGER_EVENTS).toContain('filter_delete');
    expect(FOLDER_SYNC_TRIGGER_EVENTS).toContain('filter_order');
  });

  it('preserves a locally-created folder on reboot when creation bumped localModifiedAt (the fix)', async() => {
    const local = [...mkBaseFilters(), mkCustom(4, 'max-test')];
    // The fix: creating the folder fired filter_new -> schedulePublish ->
    // setLastModifiedAt(now). Stale remote predates the creation.
    const remoteCreatedAt = 1000;
    setLastPublishedAt(1000);
    setLastModifiedAt(2000); // creation time, newer than the stale remote
    const {deps, filtersState, reseed, publishedEvents} = mkDeps(local, remoteCreatedAt, mkBaseFilters());

    const decision = await new FoldersSync(deps as any).reconcile();

    expect(decision.action).toBe('local-wins');
    // Folder NOT wiped, system folders NOT reseeded over it
    expect(reseed.count).toBe(0);
    expect(filtersState.current.some((f) => f.id === 4)).toBe(true);
    // and it gets pushed up to the relay
    expect(publishedEvents.length).toBe(1);
  });

  it('DOCUMENTS the bug: without the modifiedAt bump a stale remote wipes the folder', async() => {
    const local = [...mkBaseFilters(), mkCustom(4, 'max-test')];
    // Old buggy behavior: filter_new never bumped localModifiedAt, so it stayed 0
    // while a stale remote snapshot (system-only) had a real timestamp.
    const remoteCreatedAt = 2000;
    setLastPublishedAt(0);
    setLastModifiedAt(0);
    const {deps, filtersState, reseed} = mkDeps(local, remoteCreatedAt, mkBaseFilters());

    const decision = await new FoldersSync(deps as any).reconcile();

    expect(decision.action).toBe('remote-wins');
    expect(reseed.count).toBe(1);
    expect(filtersState.current.some((f) => f.id === 4)).toBe(false);
  });
});
