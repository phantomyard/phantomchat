import 'fake-indexeddb/auto';
import {randomUUID} from 'node:crypto';
import {describe, it, expect, beforeAll, afterEach, vi} from 'vitest';
import {emptyCatalogState, mergeCatalog, observeCatalog, writeCatalogValue, parseCatalog, type CatalogMap} from '@lib/phantomchat/account-catalog';
import {catalogToFilters, filtersToCatalog, validateCatalogProjection} from '@lib/phantomchat/account-catalog-projection';
import {AccountCatalogSync} from '@lib/phantomchat/account-catalog-sync';
import {buildLocalFilter} from '@lib/storages/filtersLocal';
import {mergeGroupsMaps, needsGroupMaterialization} from '@lib/phantomchat/groups-sync-adapter';
import {mergeAccountCatalog} from '@lib/phantomchat/account-catalog-merge';
import * as catalogStore from '@lib/phantomchat/account-catalog-store';
import {updateCatalogState} from '@lib/phantomchat/account-catalog-store';
import {registerCatalogArchiveWriter, recordCatalogArchive} from '@lib/phantomchat/account-catalog-mutations';

beforeAll(() => {
  Object.defineProperty(crypto, 'randomUUID', {value: randomUUID, configurable: true});
  Object.defineProperty(navigator, 'locks', {value: {request: async(_key: string, _opts: unknown, fn: () => Promise<void>) => fn()}, configurable: true});
});
const engines: AccountCatalogSync[] = [];
afterEach(() => { engines.splice(0).forEach((engine) => engine.stop()); registerCatalogArchiveWriter(undefined); vi.useRealTimers(); vi.restoreAllMocks(); });
const entry = (counter: number, device: string, value: any): any => ({revision: {counter, device}, value});
function folder(id: number, catalogId: string, name = catalogId): any {
  return {...buildLocalFilter(0), id, catalogId, title: {_: 'textWithEntities', text: name, entities: []}, pFlags: {}};
}

it('merges unrelated changes and deterministically resolves concurrent edits', () => {
  const a = {'folder:a': entry(1, 'A', 'one')};
  const b = {'folder:a': entry(1, 'B', 'two'), 'folder:b': entry(1, 'B', 'other')};
  expect(mergeCatalog(a, b)).toEqual(mergeCatalog(b, a));
  expect(mergeCatalog(a, b)['folder:a'].value).toBe('two');
  expect(mergeCatalog(a, b)['folder:b'].value).toBe('other');
});
it('is associative and idempotent including tombstones and equal-revision corruption', () => {
  const maps: CatalogMap[] = [
    {'folder:a': entry(2, 'a', 'left')},
    {'folder:a': {revision: {counter: 3, device: 'a'}, deleted: true}},
    {'folder:a': entry(2, 'z', 'stale')},
    {'folder:a': entry(3, 'a', 'tie')}
  ];
  for(const a of maps) for(const b of maps) for(const c of maps) {
    expect(mergeCatalog(mergeCatalog(a, b), c)).toEqual(mergeCatalog(a, mergeCatalog(b, c)));
    expect(mergeCatalog(a, a)).toEqual(a);
  }
});
it('advances beyond observed logical counters regardless of device clock', () => {
  const state = emptyCatalogState();
  state.items['folder:remote'] = entry(10000, 'remote', 'remote');
  expect(writeCatalogValue(state, 'folder:a', 'edit').revision.counter).toBe(10001);
});
it('bootstraps at revision zero and records a durable deletion only after observing it locally', () => {
  const state = emptyCatalogState();
  observeCatalog(state, {'folder:a': 'cached'});
  expect(state.items['folder:a'].revision.counter).toBe(0);
  observeCatalog(state, {});
  expect(state.items['folder:a'].deleted).toBe(true);
  expect(mergeCatalog(state.items, {'folder:a': entry(0, 'old', 'cached')})['folder:a'].deleted).toBe(true);
});
it('preserves two offline folders with the same numeric UI id', () => {
  const view = filtersToCatalog([folder(5, 'a'), folder(5, 'b')]);
  const map = Object.fromEntries(Object.entries(view).map(([key, value]) => [key, entry(1, 'a', value)]));
  const result = catalogToFilters([buildLocalFilter(0)], map);
  expect(new Set(result.map((f) => f.id)).size).toBe(2);
  expect(result.map((f) => f.catalogId)).toEqual(['a', 'b']);
});
it('keeps independent membership adds and removals when another device renames the folder', () => {
  const f = folder(5, 'a');
  f.includePeerIds = [123]; f.include_peers = [{_: 'inputPeerUser', user_id: 123}];
  const initial = Object.fromEntries(Object.entries(filtersToCatalog([f])).map(([key, value]) => [key, entry(1, 'a', value)]));
  const renamed = {...initial, 'folder:a': entry(2, 'b', {...initial['folder:a'].value, title: {_: 'textWithEntities', text: 'Renamed', entities: []}})};
  const removal: CatalogMap = {'member:a:include:123': {revision: {counter: 2, device: 'a'}, deleted: true}};
  const merged = mergeCatalog(renamed, removal);
  expect(catalogToFilters([], merged)[0].includePeerIds).toEqual([]);
  expect(catalogToFilters([], merged)[0].title.text).toBe('Renamed');
});
it('rejects bad versions, unsafe revisions and invalid typed values before applying', () => {
  expect(() => parseCatalog('{"version":2,"items":{}}')).toThrow();
  expect(() => parseCatalog(JSON.stringify({version: 1, items: {'folder:a': entry(Infinity, 'a', {})}}))).toThrow();
  expect(() => validateCatalogProjection({'archive:g': entry(1, 'a', {groupId: 'g', archivedAt: -1})})).toThrow();
  expect(() => validateCatalogProjection({'folder:a': entry(1, 'a', {id: 0})})).toThrow();
});
it('serializes clocks across concurrent tabs and scopes persistent caches by account', async() => {
  const account = randomUUID();
  const versions = await Promise.all(Array.from({length: 8}, (_, i) => updateCatalogState(account, (s) => writeCatalogValue(s, `folder:${i}`, i).revision.counter)));
  expect([...versions].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(await updateCatalogState(randomUUID(), (s) => Object.keys(s.items))).toEqual([]);
});
it('a newer metadata record cannot revert a logical archive revision', () => {
  const record: any = {groupId: 'g', name: 'x', archivedAt: 0, archiveUpdatedAt: 99999, catalogArchiveRevision: {counter: 4, device: 'B'}};
  const archived = {...record, archivedAt: 10, archiveUpdatedAt: 10, catalogArchiveRevision: {counter: 5, device: 'A'}};
  const a: any = {g: {id: 'g', updatedAt: 10, data: archived}};
  const b: any = {g: {id: 'g', updatedAt: 99, data: record}};
  expect(mergeGroupsMaps(a, b).g.data.archivedAt).toBe(10);
  expect(mergeGroupsMaps(b, a).g.data.archivedAt).toBe(10);
});

function fixture(events: Map<string, any>, options: {query?: () => Promise<any[]>; setFilters?: any; legacy?: any; roster?: any} = {}) {
  let filters = [folder(5, randomUUID())];
  const account = randomUUID();
  let publishes = 0;
  const engine = new AccountCatalogSync({
    account, roster: options.roster || {read: async() => ({}), apply: async() => {}}, getFilters: async() => structuredClone(filters),
    setFilters: options.setFilters || (async(_expected: any, next: any) => { filters = structuredClone(next); return true; }),
    getGroups: async() => [], applyArchive: async() => {},
    legacyFolders: async() => options.legacy || null,
    query: options.query || (async() => [...events.values()]),
    publish: async(event) => { publishes++; events.set(event.tags[0][1], event); },
    encrypt: (plain) => plain, decrypt: (plain) => plain
  });
  engines.push(engine);
  return {engine, account, filters: () => filters, set: (next: any) => { filters = next; }, publishes: () => publishes};
}

describe('catalog transport', () => {
  it('converges two devices, keeps offline adds, propagates delete and refuses stale resurrection', async() => {
    const relay = new Map();
    const a = fixture(relay), b = fixture(relay);
    await a.engine.start(); await b.engine.start();
    const left = a.filters()[0].catalogId, right = b.filters()[0].catalogId;
    for(let pass = 0; pass < 3; pass++) { await a.engine.reconcile(); await b.engine.reconcile(); }
    expect(a.filters().map((f) => f.catalogId).sort()).toEqual([left, right].sort());
    expect(b.filters().map((f) => f.catalogId).sort()).toEqual([left, right].sort());
    const stale = [...relay.values()].map((e) => structuredClone(e));
    a.set(a.filters().filter((f) => f.catalogId !== left));
    await a.engine.filtersChanged(); await a.engine.reconcile(); await b.engine.reconcile();
    expect(b.filters().some((f) => f.catalogId === left)).toBe(false);
    for(const e of stale) relay.set('stale:' + e.tags[0][1], e);
    await b.engine.reconcile();
    expect(b.filters().some((f) => f.catalogId === left)).toBe(false);
  });
  it('keeps cached data and publishes nothing after an unreadable remote or query failure', async() => {
    const f = fixture(new Map(), {query: async() => { throw new Error('offline'); }});
    await f.engine.start();
    const before = structuredClone(f.filters());
    await expect(f.engine.reconcile()).rejects.toThrow('offline');
    expect(f.filters()).toEqual(before); expect(f.publishes()).toBe(0);
    const broken = fixture(new Map([['bad', {content: 'unreadable', tags: []}]]));
    await broken.engine.start(); await expect(broken.engine.reconcile()).rejects.toThrow();
    expect(broken.publishes()).toBe(0);
  });
  it('imports the legacy relay catalog without dropping a cached offline folder', async() => {
    const f = fixture(new Map(), {legacy: {createdAt: 500, snapshot: {version: 1, order: [6], customFolders: [folder(6, 'legacy-remote')]}}});
    await f.engine.start(); await f.engine.reconcile();
    expect(f.filters()).toHaveLength(2);
    expect(f.filters().some((f) => f.catalogId === 'legacy-remote')).toBe(true);
  });
  it('does not overwrite a folder edited while the remote read was pending', async() => {
    const f = fixture(new Map(), {setFilters: async() => false});
    await f.engine.start();
    // Force a remote addition; the worker compare-and-swap sees a newer local edit.
    const state = await updateCatalogState(f.account, (s) => s);
    state.items['folder:other'] = entry(10, 'remote', folder(6, 'other'));
    const remote = new Map([['r', {content: JSON.stringify({version: 1, items: state.items}), tags: [['d', 'remote']]}]]);
    const g = fixture(remote, {setFilters: async() => false});
    await g.engine.start(); const before = structuredClone(g.filters());
    await expect(g.engine.reconcile()).rejects.toThrow('Folders changed');
    expect(g.filters()).toEqual(before);
  });
  it('records an archive gesture durably beyond the latest group revision before relay publication', async() => {
    const f = fixture(new Map()); await f.engine.start();
    const revision = await recordCatalogArchive('group', 123, 456, {counter: 90, device: 'other'});
    expect(revision.counter).toBe(91);
    const entry = await updateCatalogState(f.account, (s) => s.items['archive:group']);
    expect(entry.value).toEqual({groupId: 'group', archivedAt: 123, archiveUpdatedAt: 456});
  });
});

it('roster tombstones survive an automatic stale restore with a newer catalog revision', () => {
  const id = '12'.repeat(16);
  const deleted: any = {[`roster:${id}`]: entry(3, 'a', {id, updatedAt: 100, deleted: true})};
  const stale: any = {[`roster:${id}`]: entry(900, 'b', {id, updatedAt: 1000, data: {groupId: id}})};
  expect((mergeAccountCatalog(deleted, stale)[`roster:${id}`].value as any).deleted).toBe(true);
  expect(mergeAccountCatalog(deleted, stale)).toEqual(mergeAccountCatalog(stale, deleted));
});
it('a freshly paired device restores records carried by the catalog even when legacy group sync lost them', async() => {
  const events = new Map();
  const id = '12'.repeat(16);
  const record = {groupId: id, name: 'Recovered session', kind: 'session', adminPubkey: '34'.repeat(32), members: ['34'.repeat(32)], createdAt: 1000, updatedAt: 1000, peerId: -12000000000000001};
  let left: any = {[id]: {id, updatedAt: 1, data: record}};
  let right: any = {};
  const a = fixture(events, {roster: {read: async() => left, apply: async(map: any) => { left = map; }}});
  const b = fixture(events, {roster: {read: async() => right, apply: async(map: any) => { right = map; }}});
  await a.engine.start(); await b.engine.start();
  for(let pass = 0; pass < 3; pass++) { await a.engine.reconcile(); await b.engine.reconcile(); }
  expect(right[id].data).toEqual(record);
});

it('a timed-out catalog query cannot apply late data and a fresh attempt succeeds', async() => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
  let release: (events: any[]) => void;
  let hanging = true;
  const relay = new Map();
  const f = fixture(relay, {query: async() => hanging ? new Promise<any[]>((resolve) => { release = resolve; }) : [...relay.values()]});
  await f.engine.start();
  const attempt = f.engine.reconcile();
  const rejected = expect(attempt).rejects.toThrow('abandoned');
  for(let i = 0; !release && i < 100; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  expect(release).toBeTypeOf('function');
  await vi.advanceTimersByTimeAsync(20000);
  await rejected;
  const before = structuredClone(f.filters());
  release([{content: JSON.stringify({version: 1, items: {'folder:late': entry(999, 'remote', folder(99, 'late'))}}), tags: [['d', 'late']]}]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.filters()).toEqual(before);
  expect(f.publishes()).toBe(0);
  hanging = false;
  await f.engine.reconcile();
  expect(f.publishes()).toBeGreaterThan(0);
});
it('reopening a stale cached folder projection cannot resurrect a known deletion', async() => {
  const relay = new Map();
  const f = fixture(relay);
  await f.engine.start(); await f.engine.reconcile();
  const stale = structuredClone(f.filters());
  f.set([]); await f.engine.filtersChanged(); await f.engine.reconcile();
  f.engine.stop(); f.set(stale);
  // Recreate the engine against the same persisted account and stale cached UI.
  const account = f.account;
  const reopen = new AccountCatalogSync({
    account, roster: {read: async() => ({}), apply: async() => {}},
    getFilters: async() => structuredClone(f.filters()), setFilters: async(_expected, next) => { f.set(next); return true; },
    getGroups: async() => [], applyArchive: async() => {}, legacyFolders: async() => null,
    query: async() => [...relay.values()], publish: async(event) => { relay.set(event.tags[0][1], event); }, encrypt: (p) => p, decrypt: (p) => p
  });
  engines.push(reopen); await reopen.start(); await reopen.reconcile();
  expect(f.filters()).toEqual([]);
});

it('equivalent materialized group records do not retrigger guards on every catalog poll', () => {
  const base: any = {groupId: '12'.repeat(16), name: 'Group', members: [], adminPubkey: '34'.repeat(32), createdAt: 1000};
  const local: any = {id: base.groupId, updatedAt: 10, data: {...base, updatedAt: 10000, peerId: -2000000000000001}};
  const remote: any = {...local, data: {...base, kind: 'group', updatedAt: 10999, peerId: -2000000000000002}};
  expect(needsGroupMaterialization(remote, local)).toBe(false);
  expect(needsGroupMaterialization({...remote, data: {...remote.data, members: ['56'.repeat(32)]}}, local)).toBe(true);
});

it('a failed local capture is retried automatically before merging remote data', async() => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
  const f = fixture(new Map()); await f.engine.start();
  f.set(f.filters().map((filter) => ({...filter, title: {...filter.title, text: 'Retried local edit'}})));
  vi.spyOn(catalogStore, 'updateCatalogState').mockRejectedValueOnce(new Error('Temporary IndexedDB failure'));
  await expect(f.engine.filtersChanged()).rejects.toThrow('IndexedDB');
  await f.engine.reconcile();
  const state = await updateCatalogState(f.account, (s) => s);
  const definition = Object.entries(state.items).find(([key]) => key.startsWith('folder:'))[1].value as any;
  expect(definition.title.text).toBe('Retried local edit');
  expect(f.publishes()).toBeGreaterThan(0);
});
it('logout stops a queued capture before it can recreate private catalog state', async() => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
  const f = fixture(new Map()); await f.engine.start();
  const capture = f.engine.filtersChanged(); f.engine.stop();
  await expect(capture).rejects.toThrow('stopped');
});
it('session peer-range evidence still materializes a class upgrade without an explicit kind', () => {
  const data: any = {groupId: '12'.repeat(16), name: 'Legacy session', members: [], adminPubkey: '34'.repeat(32), createdAt: 1000, updatedAt: 10000, peerId: -2000000000000001};
  const local: any = {id: data.groupId, updatedAt: 10, data};
  const remote: any = {...local, data: {...data, peerId: -12000000000000001}};
  expect(needsGroupMaterialization(remote, local)).toBe(true);
});
