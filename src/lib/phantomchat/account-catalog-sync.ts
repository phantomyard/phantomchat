import {mergeAccountCatalog as mergeCatalog} from './account-catalog-merge';
import type {GroupsLocalAdapter} from './groups-sync-adapter';
import type {SyncMap} from './sync-crdt';
import {CATALOG_TAG, parseCatalog, observeCatalog, writeCatalogValue, compareRevision,
  type CatalogMap, type CatalogState} from './account-catalog';
import {updateCatalogState} from './account-catalog-store';
import {filtersToCatalog, catalogToFilters, groupsToCatalog, validateCatalogProjection} from './account-catalog-projection';
import {registerCatalogArchiveWriter} from './account-catalog-mutations';
import {stableStringify} from './sync-crdt';
import {syncStep} from './session-sync-recovery';
import type {MyDialogFilter} from '@lib/storages/filters';
import type {GroupRecord} from './group-types';
import type {FolderSnapshot} from './folders-sync-types';
import {applySnapshotToFilters} from './folders-sync-snapshot';

type Deps = {
  account: string;
  roster: GroupsLocalAdapter;
  getFilters: () => Promise<MyDialogFilter[]>;
  setFilters: (expected: MyDialogFilter[], filters: MyDialogFilter[]) => Promise<boolean>;
  legacyFolders: () => Promise<{snapshot: FolderSnapshot; createdAt: number} | null>;
  getGroups: () => Promise<GroupRecord[]>;
  applyArchive: (group: GroupRecord) => Promise<void>;
  query: () => Promise<Array<{content: string; tags: string[][]}>>;
  publish: (event: {kind: number; created_at: number; tags: string[][]; content: string}) => Promise<void>;
  encrypt: (plaintext: string) => string;
  decrypt: (ciphertext: string) => string;
};

/** Encrypted account catalog, cached in an additive account-scoped DB. */
export class AccountCatalogSync {
  private applying = false;
  private flight: Promise<void> | undefined;
  private dirty = false;
  private stopped = false;
  private controller: AbortController | undefined;
  private capture = Promise.resolve();
  private timer: ReturnType<typeof setTimeout>;
  private retryMs = 2000;

  constructor(private deps: Deps) {}

  private update<T>(fn: (state: CatalogState) => T): Promise<T> {
    return updateCatalogState(this.deps.account, fn);
  }

  async start(): Promise<void> {
    const [filters, groups] = await Promise.all([this.deps.getFilters(), this.deps.getGroups()]);
    await this.update((state) => {
      // Once initialized, archive mutations are recorded at the gesture site.
      // Never promote a stale group replay into a new catalog edit at boot.
      if(!state.initialized) observeCatalog(state, {...filtersToCatalog(filters), ...groupsToCatalog(groups)});
      else {
        // A cached projection (including an older frontend's rewrite) is not
        // evidence of a new user gesture. Never let boot resurrect tombstones.
        const view = filtersToCatalog(filters);
        for(const [key, value] of Object.entries(view)) {
          if(!state.items[key]) state.items[key] = {revision: {counter: 0, device: 'legacy'}, value};
          state.observed[key] = value;
        }
      }
      // A group restored from the groups channel may already know a catalog
      // revision. Carry it intact rather than stamping it as a new gesture.
      for(const group of groups) {
        if(!group.catalogArchiveRevision) continue;
        const key = `archive:${group.groupId}`;
        const entry = {revision: group.catalogArchiveRevision, value: groupsToCatalog([group])[key]};
        if(!state.items[key] || compareRevision(entry.revision, state.items[key].revision) > 0) state.items[key] = entry;
      }
    });
    registerCatalogArchiveWriter(async(groupId, archivedAt, archiveUpdatedAt, previous) => {
      const entry = await this.update((state) => {
        state.counter = Math.max(state.counter, previous?.counter || 0);
        return writeCatalogValue(state, `archive:${groupId}`, {groupId, archivedAt, archiveUpdatedAt});
      });
      this.schedule();
      return entry.revision;
    });
    this.schedule(0);
  }

  /** Filter events capture changes immediately, independently of relay availability. */
  filtersChanged(): Promise<void> {
    if(this.applying || this.stopped) return Promise.resolve();
    this.capture = this.capture.catch(() => {}).then(async() => {
      const view = filtersToCatalog(await this.deps.getFilters());
      await this.update((state) => {
        for(const prefix of ['folder:', 'member:', 'order:']) observeCatalog(state, view, prefix);
      });
      this.schedule();
    });
    return this.capture;
  }

  schedule(delay = 2000): void {
    if(this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.reconcile().catch((e) => console.warn('[account-catalog] reconcile failed', e)); }, delay);
  }

  stop(): void {
    this.stopped = true;
    this.controller?.abort();
    clearTimeout(this.timer);
    registerCatalogArchiveWriter(undefined);
  }

  reconcile(): Promise<void> {
    if(this.stopped) return Promise.resolve();
    if(this.flight) { this.dirty = true; return this.flight; }
    const controller = this.controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Account catalog timed out')), 20000);
    this.flight = (async() => {
      try {
        // A single writer per browser profile, including multiple PWA tabs.
        await navigator.locks.request(`phantomchat-catalog:${this.deps.account}`, {signal: controller.signal}, () => this.pass(controller.signal));
        this.retryMs = 2000;
      } catch(error) {
        this.retryMs = Math.min(this.retryMs * 2, 60000);
        throw error;
      } finally {
        clearTimeout(timer);
        this.flight = undefined;
        const delay = this.dirty ? 2000 : this.retryMs === 2000 ? 15000 : this.retryMs;
        this.dirty = false;
        this.schedule(delay);
      }
    })();
    return this.flight;
  }

  private async pass(signal: AbortSignal): Promise<void> {
    const step = <T>(work: Promise<T>) => syncStep(work, signal);
    await step(this.capture);
    const roster = await step(this.deps.roster.read());
    // Persist local roster facts before touching the network. Missing records
    // never delete: only the existing durable deletion log produces tombstones.
    await step(this.update((current) => {
      for(const [id, value] of Object.entries(roster)) {
        const key = `roster:${id}`;
        const candidate = {[key]: {revision: current.items[key]?.revision || {counter: 0, device: current.device}, value}};
        const merged = mergeCatalog(current.items, candidate);
        if(stableStringify(merged[key]?.value) !== stableStringify(current.items[key]?.value)) writeCatalogValue(current, key, merged[key].value);
      }
    }));
    const events = await step(this.deps.query());
    let remote: CatalogMap = {};
    for(const event of events) {
      const map = parseCatalog(this.deps.decrypt(event.content));
      validateCatalogProjection(map);
      remote = mergeCatalog(remote, map);
    }
    const initial = await step(this.update((current) => current));
    if(!initial.legacyImported) {
      const legacy = await step(this.deps.legacyFolders());
      if(legacy) {
        const filters = await step(this.deps.getFilters());
        const view = filtersToCatalog(applySnapshotToFilters(filters, legacy.snapshot));
        const migration: CatalogMap = {};
        for(const [key, value] of Object.entries(view)) migration[key] = {
          revision: {counter: 0, device: 'legacy-' + String(legacy.createdAt).padStart(16, '0')}, value
        };
        remote = mergeCatalog(remote, migration);
      }
    }
    await step(this.capture);
    signal.throwIfAborted();
    let state = await step(this.update((current) => {
      current.items = mergeCatalog(current.items, remote);
      current.legacyImported = true;
      current.counter = Math.max(current.counter, ...Object.values(current.items).map((e) => e.revision.counter));
      return current;
    }));
    const mergedRoster: SyncMap<GroupRecord> = {};
    for(const [key, entry] of Object.entries(state.items)) {
      if(key.startsWith('roster:') && entry.value) mergedRoster[key.slice(7)] = entry.value as SyncMap<GroupRecord>[string];
    }
    const beforeRoster = await step(this.deps.roster.read());
    signal.throwIfAborted();
    await step(this.deps.roster.apply(mergedRoster, beforeRoster, signal));
    const knownGroups = await step(this.deps.getGroups());
    state = await step(this.update((current) => {
      for(const group of knownGroups) {
        if(!group.catalogArchiveRevision) continue;
        const key = `archive:${group.groupId}`;
        if(!current.items[key] || compareRevision(group.catalogArchiveRevision, current.items[key].revision) > 0) {
          current.items[key] = {revision: group.catalogArchiveRevision, value: groupsToCatalog([group])[key]};
        }
      }
      return current;
    }));
    await step(this.capture);
    state = await step(this.update((current) => current));
    const filters = await step(this.deps.getFilters());
    const next = catalogToFilters(filters, state.items);
    if(stableStringify(filtersToCatalog(next)) !== stableStringify(filtersToCatalog(filters))) {
      signal.throwIfAborted();
      this.applying = true;
      try {
        const replaced = await step(this.deps.setFilters(filters, next));
        if(!replaced) throw new Error('Folders changed during catalog reconciliation');
        await step(this.update((current) => {
          const view = filtersToCatalog(next);
          // Don't acknowledge a different local edit that arrived during IPC.
          for(const prefix of ['folder:', 'member:', 'order:']) {
            for(const key of Object.keys(current.observed)) if(key.startsWith(prefix)) delete current.observed[key];
            for(const [key, value] of Object.entries(view)) if(key.startsWith(prefix)) current.observed[key] = value;
          }
        }));
      } finally { this.applying = false; }
      // Events from the remote projection were suppressed; capture any user
      // edit that landed immediately after the atomic worker replacement.
      await step(this.filtersChanged());
    }
    const groups = await step(this.deps.getGroups());
    await step(Promise.all(groups.map(async(group) => {
      const entry = state.items[`archive:${group.groupId}`];
      if(!entry || entry.deleted) return;
      const value = entry.value as {archivedAt: number; archiveUpdatedAt: number};
      if(group.catalogArchiveRevision && compareRevision(group.catalogArchiveRevision, entry.revision) > 0) return;
      if(group.archivedAt === value.archivedAt && stableStringify(group.catalogArchiveRevision) === stableStringify(entry.revision)) return;
      signal.throwIfAborted();
      await this.deps.applyArchive({...group, ...value, catalogArchiveRevision: entry.revision});
    })));
    signal.throwIfAborted();
    state = await step(this.update((current) => current));
    // Each device has its own replaceable addresses. Union every device's
    // shards; absence is never permission to overwrite another device.
    let own: CatalogMap = {};
    for(const event of events) {
      const address = event.tags.find((tag) => tag[0] === 'd')?.[1] || '';
      if(address.startsWith(`${CATALOG_TAG}/${state.device}/`)) own = mergeCatalog(own, parseCatalog(this.deps.decrypt(event.content)));
    }
    if(stableStringify(own) === stableStringify(state.items)) return;
    const chunks: CatalogMap[] = [];
    let chunk: CatalogMap = {};
    for(const [key, entry] of Object.entries(state.items).sort(([a], [b]) => a < b ? -1 : 1)) {
      if(new TextEncoder().encode(JSON.stringify({...chunk, [key]: entry})).length > 24000 && Object.keys(chunk).length) {
        chunks.push(chunk); chunk = {};
      }
      chunk[key] = entry;
    }
    if(Object.keys(chunk).length) chunks.push(chunk);
    const createdAt = await step(this.update((current) => {
      // Nostr replaces within one second by event-id, not arrival order.
      // Reserve a monotonic envelope timestamp; data conflicts use revisions.
      current.publishedAt = Math.max(Math.floor(Date.now() / 1000), current.publishedAt + 1);
      return current.publishedAt;
    }));
    await step(Promise.all(chunks.map((items, index) => {
      signal.throwIfAborted();
      return this.deps.publish({kind: 30078, created_at: createdAt,
        tags: [['d', `${CATALOG_TAG}/${state.device}/${index}`], ['t', CATALOG_TAG]],
        content: this.deps.encrypt(JSON.stringify({version: 1, items}))});
    })));
    // A send is not an acknowledgement: retry until the relay serves our data.
    const verified = await step(this.deps.query());
    let confirmed: CatalogMap = {};
    for(const event of verified) {
      const address = event.tags.find((tag) => tag[0] === 'd')?.[1] || '';
      if(address.startsWith(`${CATALOG_TAG}/${state.device}/`)) confirmed = mergeCatalog(confirmed, parseCatalog(this.deps.decrypt(event.content)));
    }
    if(stableStringify(mergeCatalog(confirmed, state.items)) !== stableStringify(confirmed)) throw new Error('Catalog publish unconfirmed');
  }
}
