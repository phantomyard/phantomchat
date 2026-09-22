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
    /**
     * Resolve the latest matching event, or `null` for a CONFIRMED absence (a
     * relay answered, nothing there). MUST reject/throw on transport failure
     * (init failure or no live relay) — fetchRemote maps a throw to
     * `unavailable` and a `null` to `absent`, and only `absent` seeds from local.
     */
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

/** Options for {@link CrdtSync.publishWithRetry}. */
export type PublishRetryOptions = {
  maxAttempts?: number;
  backoffMs?: number;
  /** Injectable for tests — defaults to a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Result of reading the remote snapshot. The three states must stay distinct:
 * conflating them is how a transient relay hiccup silently overwrites a newer
 * remote snapshot with stale local data.
 *
 *  - `ok`          — a snapshot was fetched, decrypted and version-matched.
 *  - `absent`      — the relay answered and there is genuinely no snapshot.
 *                    Only this state permits seeding the relay from local.
 *  - `unavailable` — the relay query failed, OR a snapshot exists but is
 *                    unreadable (bad ciphertext / garbage JSON / unknown
 *                    version). We must NOT publish over it — it may well be
 *                    newer than what we hold. Abort and let the retry try again.
 */
type RemoteFetch<T> =
  | {status: 'ok', map: SyncMap<T>}
  | {status: 'absent'}
  | {status: 'unavailable'};

export class CrdtSync<T> {
  private applying = false;
  /** The in-flight publish pass, or null. Re-entrant publishes queue on it. */
  private publishing: Promise<boolean> | null = null;
  /** A publish arrived while a pass was in flight — run one more after. */
  private rerunPending = false;

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

    if(remote.status === 'unavailable') {
      // Relay unreachable, or a snapshot exists but we couldn't read it.
      // Publishing local now could clobber a newer remote we simply failed to
      // fetch — so bail without writing. The boot retry loop will try again.
      return 'failed';
    }

    if(remote.status === 'absent') {
      // Relay confirmed there is no snapshot. Safe to seed it from local if we
      // have anything worth publishing.
      if(Object.keys(local).length === 0) return 'no-remote-nothing-local';
      await this.publishMap(local);
      return 'no-remote-published-local';
    }

    const remoteMap = remote.map;
    const merged = gcTombstones(
      mergeMaps(local, remoteMap),
      this.deps.nowSeconds()
    );

    const localChanged = differs(merged, local);
    const remoteChanged = differs(merged, remoteMap);

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
   *
   * Returns whether the relay was brought up to date with this device's view
   * (`true` = published or confirmed already current, `false` = could not
   * confirm — relay unavailable or the write failed). Callers that must not
   * lose a write use {@link publishWithRetry}; a fire-once publish whose relay
   * query happened to hiccup is how a tombstone silently never reached the
   * relay and a deleted contact resurrected (#155).
   *
   * The merged view is also applied LOCALLY when it differs: a publishing
   * device must converge, not just write — otherwise it keeps a stale live
   * entry that outranks the tombstone it just published.
   *
   * Re-entrancy: a call landing while a pass is in flight cannot be dropped —
   * the in-flight pass read the local view BEFORE this call's mutation, so
   * dropping it silently loses the mutation (the in-flight race of #155).
   * Instead the call queues one more pass and awaits the outcome. A call
   * landing during reconcile's apply() stays a no-op: apply fires the very
   * events that trigger publishes, and reconcile republishes the merged view
   * itself.
   */
  async publish(): Promise<boolean> {
    if(this.applying) return false;

    if(this.publishing) {
      this.rerunPending = true;
      return this.publishing;
    }

    this.publishing = this.publishOnce();
    try {
      let ok = await this.publishing;
      while(this.rerunPending) {
        this.rerunPending = false;
        this.publishing = this.publishOnce();
        ok = await this.publishing;
      }
      return ok;
    } finally {
      this.publishing = null;
    }
  }

  /**
   * Publish until the relay confirms our view, backing off between attempts.
   * A single failed attempt is a transient relay hiccup; giving up there is
   * how deletes were lost (#155). Capped so a dead relay doesn't spin forever
   * — after the cap, the periodic reconcile (and the next mutation) retries.
   */
  async publishWithRetry(opts: PublishRetryOptions = {}): Promise<boolean> {
    const maxAttempts = opts.maxAttempts ?? 6;
    const backoffMs = opts.backoffMs ?? 4000;
    const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for(let attempt = 1; attempt <= maxAttempts; attempt++) {
      if(await this.publish()) return true;
      if(attempt === maxAttempts) break;
      await sleep(backoffMs * attempt);
    }
    console.warn(this.tag, 'publish unconfirmed after', maxAttempts, 'attempts — local changes are NOT on the relay; the periodic reconcile will retry');
    return false;
  }

  private async publishOnce(): Promise<boolean> {
    let local: SyncMap<T>;
    try {
      local = await this.deps.adapter.read();
    } catch(err) {
      console.warn(this.tag, 'publish aborted: local read failed', err);
      return false;
    }

    const remote = await this.fetchRemote();

    // Transient read failure (or an unreadable snapshot): do NOT publish. A
    // debounced local edit must not overwrite a remote we couldn't fetch —
    // that's exactly how a concurrent add on another device gets lost.
    if(remote.status === 'unavailable') {
      console.warn(this.tag, 'publish skipped: relay unavailable (unconfirmed)');
      return false;
    }

    const remoteMap = remote.status === 'ok' ? remote.map : null;
    const merged = remoteMap ?
      gcTombstones(mergeMaps(local, remoteMap), this.deps.nowSeconds()) :
      local;

    // Converge locally too: the remote may hold entries this device has not
    // seen (an add from another device, or a tombstone for a contact that
    // resurrected here). Without this, the device keeps its stale live entry
    // and its next publish re-merges the same remote delta forever (#155).
    if(remoteMap && differs(merged, local)) {
      this.applying = true;
      try {
        await this.deps.adapter.apply(merged, local);
      } catch(err) {
        // The relay write below still converges the merged view; a failed
        // local apply heals on the next reconcile rather than aborting the
        // publish (local and relay disagree is strictly better than neither
        // side learning the other's tombstone).
        console.warn(this.tag, 'apply during publish failed', err);
      } finally {
        this.applying = false;
      }
    }

    if(remoteMap && !differs(merged, remoteMap)) return true; // relay already current
    try {
      await this.publishMap(merged);
    } catch(err) {
      console.warn(this.tag, 'publish write failed (unconfirmed)', err);
      return false;
    }
    return true;
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
   * Fetch + decrypt + validate the remote map, returning a three-state result
   * (see RemoteFetch). The critical distinction: a relay that *answers with no
   * event* (`absent`) is authoritative and lets us seed from local, but a relay
   * that *fails to answer* — or answers with a snapshot we can't read (bad
   * ciphertext / garbage JSON / unknown version) — is `unavailable`, and the
   * caller must never publish over it. A present-but-unreadable snapshot is the
   * most dangerous case: it may be newer than ours, so treat it as unavailable
   * and leave it untouched rather than clobber it with stale local data.
   */
  private async fetchRemote(): Promise<RemoteFetch<T>> {
    let ev;
    try {
      ev = await this.deps.chatAPI.queryLatestEvent({
        'kinds': [this.kind],
        '#d': [this.deps.dTag],
        'limit': 1
      });
    } catch(err) {
      console.warn(this.tag, 'relay query failed', err);
      return {status: 'unavailable'};
    }
    if(!ev) return {status: 'absent'};

    let parsed: unknown;
    try {
      parsed = JSON.parse(this.deps.decrypt(ev.content));
    } catch(err) {
      console.warn(this.tag, 'decrypt/parse failed', err);
      return {status: 'unavailable'};
    }

    if(!parsed || typeof parsed !== 'object') return {status: 'unavailable'};
    const snap = parsed as Snapshot<T>;
    if(snap.version !== this.deps.version) {
      console.warn(this.tag, 'unknown snapshot version', snap.version);
      return {status: 'unavailable'};
    }

    return {status: 'ok', map: sanitizeMap<T>(snap.items)};
  }
}
