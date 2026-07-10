/**
 * CrdtSync — the transport + reconcile engine shared by contacts-sync and
 * groups-sync.
 *
 * Shape mirrors FoldersSync (kind 30078, self-addressed encrypted replaceable
 * event, d-tag per domain) but the merge is union-with-tombstones rather than
 * whole-blob last-write-wins. See sync-crdt.ts for why.
 *
 * The engine knows nothing about contacts or groups. A domain plugs in a
 * `LocalAdapter` that can (a) read the local world as a SyncMap and (b) apply
 * a merged SyncMap back onto the local world.
 */
import {
  mergeMaps,
  gcTombstones,
  sanitizeMap,
  differs,
  type SyncMap
} from './sync-crdt';

export type CrdtSyncEvent = {
  kind: number;
  created_at: number;
  tags: any[];
  content: string;
};

export type CrdtSyncDeps<T> = {
  /** Nostr d-tag identifying this domain, e.g. 'phantomchat.chat/contacts'. */
  dTag: string;
  /** Snapshot schema version. A mismatched remote is ignored, never applied. */
  version: number;
  kind?: number;

  chatAPI: {
    publishEvent: (event: CrdtSyncEvent) => Promise<void>;
    queryLatestEvent: (
      filter: {kinds: number[], '#d': string[], limit: number}
    ) => Promise<{kind: number, created_at: number, content: string} | null>;
  };

  adapter: LocalAdapter<T>;

  encrypt: (plaintext: string) => string;
  decrypt: (ciphertext: string) => string;
  nowSeconds: () => number;
  logPrefix?: string;
};

export type LocalAdapter<T> = {
  /** Read the local world (live items + tombstones) as a SyncMap. */
  read: () => Promise<SyncMap<T>>;
  /**
   * Apply the merged map to the local world. Receives the merged map and the
   * pre-merge local map so it can compute the minimal delta — only items that
   * actually changed get materialized, which matters because materializing a
   * contact is expensive (Worker IPC + relay connect).
   */
  apply: (merged: SyncMap<T>, before: SyncMap<T>) => Promise<void>;
};

export const CRDT_SYNC_KIND = 30078;

type Snapshot<T> = {
  version: number;
  items: SyncMap<T>;
};

export type ReconcileOutcome =
  | 'no-remote-published-local'
  | 'no-remote-nothing-local'
  | 'merged-applied-and-published'
  | 'merged-applied'
  | 'in-sync'
  | 'failed';

export class CrdtSync<T> {
  private applying = false;
  private publishing = false;

  constructor(private deps: CrdtSyncDeps<T>) {}

  private get tag() {
    return this.deps.logPrefix || `[CrdtSync:${this.deps.dTag}]`;
  }

  private get kind() {
    return this.deps.kind ?? CRDT_SYNC_KIND;
  }

  /**
   * Boot-time reconcile: fetch remote, union-merge with local, apply the
   * result locally, and republish if the merged view is richer than what the
   * relay had.
   *
   * Note this is symmetric — unlike FoldersSync there is no "remote wins" or
   * "local wins" branch, because with tombstones there is nothing to lose.
   * Both sides always converge on the same union.
   */
  async reconcile(): Promise<ReconcileOutcome> {
    let local: SyncMap<T>;
    try {
      local = await this.deps.adapter.read();
    } catch(err) {
      console.warn(this.tag, 'local read failed', err);
      return 'failed';
    }

    const remote = await this.fetchRemote();

    if(!remote) {
      // Nothing on the relay (or it was unreadable). Seed it from local if we
      // have anything worth publishing.
      if(Object.keys(local).length === 0) return 'no-remote-nothing-local';
      await this.publishMap(local);
      return 'no-remote-published-local';
    }

    const merged = gcTombstones(
      mergeMaps(local, remote),
      this.deps.nowSeconds()
    );

    const localChanged = differs(merged, local);
    const remoteChanged = differs(merged, remote);

    if(!localChanged && !remoteChanged) return 'in-sync';

    if(localChanged) {
      this.applying = true;
      try {
        await this.deps.adapter.apply(merged, local);
      } catch(err) {
        console.warn(this.tag, 'apply failed', err);
        return 'failed';
      } finally {
        this.applying = false;
      }
    }

    if(remoteChanged) {
      await this.publishMap(merged);
      return 'merged-applied-and-published';
    }

    return 'merged-applied';
  }

  /**
   * Publish the current local view, union-merged with whatever the relay holds.
   *
   * Re-fetching before publishing is what stops a device from clobbering an
   * add it never saw: without it, a debounced publish triggered by a local
   * edit would overwrite the replaceable event with a map missing the other
   * device's concurrent change.
   */
  async publish(): Promise<void> {
    if(this.applying || this.publishing) return;
    this.publishing = true;
    try {
      const local = await this.deps.adapter.read();
      const remote = await this.fetchRemote();
      const merged = remote ?
        gcTombstones(mergeMaps(local, remote), this.deps.nowSeconds()) :
        local;

      if(remote && !differs(merged, remote)) return; // relay already current
      await this.publishMap(merged);
    } finally {
      this.publishing = false;
    }
  }

  private async publishMap(items: SyncMap<T>): Promise<void> {
    const snapshot: Snapshot<T> = {version: this.deps.version, items};
    const ciphertext = this.deps.encrypt(JSON.stringify(snapshot));

    await this.deps.chatAPI.publishEvent({
      kind: this.kind,
      created_at: this.deps.nowSeconds(),
      tags: [['d', this.deps.dTag]],
      content: ciphertext
    });
  }

  /**
   * Fetch + decrypt + validate the remote map. Any failure (relay down, bad
   * ciphertext, wrong version, garbage JSON) returns null, which the caller
   * treats as "no remote" — never as "remote is empty, delete everything".
   * That distinction is the whole ballgame: an empty map would tombstone
   * nothing, but a *missing* map must not be mistaken for an authoritative
   * empty one.
   */
  private async fetchRemote(): Promise<SyncMap<T> | null> {
    let ev;
    try {
      ev = await this.deps.chatAPI.queryLatestEvent({
        'kinds': [this.kind],
        '#d': [this.deps.dTag],
        'limit': 1
      });
    } catch(err) {
      console.warn(this.tag, 'relay query failed', err);
      return null;
    }
    if(!ev) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(this.deps.decrypt(ev.content));
    } catch(err) {
      console.warn(this.tag, 'decrypt/parse failed', err);
      return null;
    }

    if(!parsed || typeof parsed !== 'object') return null;
    const snap = parsed as Snapshot<T>;
    if(snap.version !== this.deps.version) {
      console.warn(this.tag, 'unknown snapshot version', snap.version);
      return null;
    }

    return sanitizeMap<T>(snap.items);
  }
}
