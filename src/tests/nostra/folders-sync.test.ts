import {describe, it, expect, vi, beforeEach} from 'vitest';
import {FoldersSync} from '@lib/nostra/folders-sync';
import {buildLocalFilter} from '@lib/storages/filtersLocal';
import {
  FOLDER_ID_ALL,
  FOLDER_ID_PERSONS,
  FOLDER_ID_GROUPS,
  FOLDER_ID_ARCHIVE
} from '@appManagers/constants';
import {FOLDERS_SYNC_KIND, FOLDERS_SYNC_D_TAG} from '@lib/nostra/folders-sync-types';
import type {MyDialogFilter} from '@lib/storages/filters';

function mkCustom(id: number, title: string): MyDialogFilter {
  const f = buildLocalFilter(FOLDER_ID_ALL);
  f.id = id;
  (f as any).title = {_: 'textWithEntities', text: title, entities: []};
  f.pFlags = {};
  return f;
}

function mkBaseFilters(): MyDialogFilter[] {
  return [
    buildLocalFilter(FOLDER_ID_ALL),
    buildLocalFilter(FOLDER_ID_PERSONS),
    buildLocalFilter(FOLDER_ID_GROUPS),
    buildLocalFilter(FOLDER_ID_ARCHIVE)
  ];
}

function mkMockDeps() {
  const publishedEvents: any[] = [];
  const fetchResults: any[] = [];
  const toastFires: string[] = [];
  const filtersState: {current: MyDialogFilter[]} = {current: mkBaseFilters()};
  const reseedCalls = {count: 0};

  return {
    chatAPI: {
      publishEvent: vi.fn(async(ev: any) => { publishedEvents.push(ev); }),
      queryLatestEvent: vi.fn(async() => fetchResults.shift() ?? null)
    },
    filtersStore: {
      getFilters: () => filtersState.current,
      setFilters: (next: MyDialogFilter[]) => { filtersState.current = next; },
      reseedSystemFolders: () => { reseedCalls.count++; }
    },
    encrypt: (plain: string) => `enc(${plain})`,
    decrypt: (cipher: string) => cipher.replace(/^enc\(|\)$/g, ''),
    nowSeconds: () => 1000,
    toast: (msg: string) => { toastFires.push(msg); },
    i18n: (_key: string) => 'Folders updated from another device. Your local changes were overwritten.',
    // expose state
    _state: {publishedEvents, fetchResults, toastFires, filtersState, reseedCalls}
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('FoldersSync.reconcile', () => {
  it('no-remote + no custom folders → no publish', async() => {
    const deps = mkMockDeps();
    const sync = new FoldersSync(deps);
    const res = await sync.reconcile();
    expect(res.action).toBe('no-op');
    expect(deps._state.publishedEvents).toHaveLength(0);
  });

  it('no-remote + custom folder → publishes local', async() => {
    const deps = mkMockDeps();
    deps._state.filtersState.current = [...mkBaseFilters(), mkCustom(4, 'Work')];
    const sync = new FoldersSync(deps);
    const res = await sync.reconcile();
    expect(res.action).toBe('publish-local');
    expect(deps._state.publishedEvents).toHaveLength(1);
    const ev = deps._state.publishedEvents[0];
    expect(ev.kind).toBe(FOLDERS_SYNC_KIND);
    expect(ev.tags).toContainEqual(['d', FOLDERS_SYNC_D_TAG]);
  });

  it('remote wins cleanly → applies snapshot + calls reseedSystemFolders, no toast', async() => {
    const deps = mkMockDeps();
    const payload = {
      version: 1,
      order: [0, 2, 3, 1, 5],
      customFolders: [mkCustom(5, 'RemoteCustom')],
      protectedTitles: {}
    };
    deps._state.fetchResults.push({
      kind: FOLDERS_SYNC_KIND,
      created_at: 500,
      content: `enc(${JSON.stringify(payload)})`
    });
    const sync = new FoldersSync(deps);
    const res = await sync.reconcile();
    expect(res.action).toBe('remote-wins');
    expect(deps._state.toastFires).toHaveLength(0);
    expect(deps._state.reseedCalls.count).toBe(1);
    const after = deps._state.filtersState.current;
    expect((after.find((f) => f.id === 5) as any)?.title.text).toBe('RemoteCustom');
  });

  it('remote wins with offline local changes → fires toast', async() => {
    const deps = mkMockDeps();
    localStorage.setItem('nostra-folders-last-published', '100');
    localStorage.setItem('nostra-folders-last-modified', '200');
    const payload = {
      version: 1,
      order: [0, 2, 3, 1],
      customFolders: [] as MyDialogFilter[],
      protectedTitles: {}
    };
    deps._state.fetchResults.push({
      kind: FOLDERS_SYNC_KIND,
      created_at: 300,
      content: `enc(${JSON.stringify(payload)})`
    });
    const sync = new FoldersSync(deps);
    const res = await sync.reconcile();
    expect(res.action).toBe('remote-wins');
    expect(deps._state.toastFires).toHaveLength(1);
    expect(deps._state.toastFires[0]).toMatch(/Folders updated|Cartelle aggiornate/);
  });

  it('local wins → publishes new event', async() => {
    const deps = mkMockDeps();
    deps._state.filtersState.current = [...mkBaseFilters(), mkCustom(4, 'LocalNew')];
    localStorage.setItem('nostra-folders-last-published', '100');
    localStorage.setItem('nostra-folders-last-modified', '500');
    deps._state.fetchResults.push({
      kind: FOLDERS_SYNC_KIND,
      created_at: 200,
      content: `enc(${JSON.stringify({version: 1, order: [0, 2, 3, 1], customFolders: [], protectedTitles: {}})})`
    });
    const sync = new FoldersSync(deps);
    const res = await sync.reconcile();
    expect(res.action).toBe('local-wins');
    expect(deps._state.publishedEvents).toHaveLength(1);
  });

  it('unknown version in remote → ignored, treated as no-remote', async() => {
    const deps = mkMockDeps();
    deps._state.fetchResults.push({
      kind: FOLDERS_SYNC_KIND,
      created_at: 500,
      content: `enc(${JSON.stringify({version: 99, order: [], customFolders: []})})`
    });
    const sync = new FoldersSync(deps);
    const res = await sync.reconcile();
    expect(res.action).toBe('no-op');
  });

  it('publish during applyingRemote is a no-op (loop guard)', async() => {
    const deps = mkMockDeps();
    const payload = {
      version: 1,
      order: [0, 2, 3, 1],
      customFolders: [] as MyDialogFilter[],
      protectedTitles: {}
    };
    deps._state.fetchResults.push({
      kind: FOLDERS_SYNC_KIND,
      created_at: 500,
      content: `enc(${JSON.stringify(payload)})`
    });
    const sync = new FoldersSync(deps);
    await sync.reconcile();
    // reconcile's remote-wins path should NOT have triggered a publish
    expect(deps._state.publishedEvents).toHaveLength(0);
  });
});
