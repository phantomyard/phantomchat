/**
 * Message-loss recovery — reproduction of the two holes that let a gift-wrap
 * that IS on the relay never reach the UI until a full page reload.
 *
 * Hole 1 — dedup claim-before-commit. `claimWrapId()` marks an outer event id
 * as seen BEFORE the wrap is unwrapped/dispatched, and never rolls the claim
 * back. If the unwrap or the dispatch fails (frozen worker on a backgrounded
 * PWA, transient crypto error), the wrap is permanently poisoned: every later
 * replay — reconnect re-arm, catch-up poll, manual backfill — is deduped away.
 * Only a reload (fresh pool, fresh set) recovers it.
 *
 * Hole 2 — wall-clock catch-up window. `backfillRecent()` polls
 * `now - 90s`, NOT the watermark. A tab that is frozen/offline for longer than
 * 90s slides the window clean past anything it missed, so the poll — the
 * "delivery backbone" — cannot recover it either.
 *
 * Together they are the "Kai went quiet" bug: the wrap was published, was
 * retrievable from the relay, and still never rendered.
 */

import 'fake-indexeddb/auto';
import '../setup';

import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';

interface MockMsg {
  id: string;
  from: string;
  content: string;
  timestamp: number;
}

const {mockRelayInstances, MockNostrRelayClass} = vi.hoisted(() => {
  const instances: any[] = [];

  class MockRelay {
    url: string;
    connected = false;
    subscribed = false;
    connectionState: string = 'disconnected';
    messageHandler: ((msg: MockMsg) => void) | null = null;
    claimEvent: ((id: string) => boolean) | null = null;
    releaseEvent: ((id: string) => void) | null = null;
    liveSubscribeSince: (() => number | undefined) | null = null;
    // Every `since` the pool has asked this relay to query with.
    sinceCalls: (number | undefined)[] = [];
    // Wraps the relay is holding and will serve on a getMessages() query.
    stored: MockMsg[] = [];

    constructor(url: string) {
      this.url = url;
      instances.push(this);
    }

    async initialize(): Promise<void> {}

    connect(): void {
      this.connected = true;
      this.connectionState = 'connected';
    }

    disconnect(): void {
      this.connected = false;
      this.connectionState = 'disconnected';
    }

    resetReconnectBackoff(): void {}

    // Every (since, until) pair the pool has asked this relay to walk.
    pagedCalls: {since?: number; until?: number}[] = [];
    // When set, the next getMessagesPaged() reports a truncated walk (page cap
    // hit with the range unexhausted) and hands back this resume cursor.
    truncateAt: number | null = null;

    async getMessages(since?: number): Promise<MockMsg[]> {
      this.sinceCalls.push(since);
      return this.stored.filter((m) => since === undefined || m.timestamp >= since);
    }

    // When set, the next getMessagesPaged() reports an UNKNOWN outcome — the walk
    // failed to learn anything (page timed out / not connected). Distinct from a
    // short page, and the pool must not read it as a closed range.
    unknownNext = false;

    async getMessagesPaged(since?: number, until?: number): Promise<{
      messages: MockMsg[];
      outcome: 'exhausted' | 'truncated' | 'unknown';
      oldestReached?: number;
    }> {
      this.sinceCalls.push(since);
      this.pagedCalls.push({since, until});

      // A relay we're not connected to cannot answer — ignorance, not absence.
      if(this.connectionState !== 'connected') {
        return {messages: [], outcome: 'unknown'};
      }

      if(this.unknownNext) {
        this.unknownNext = false;
        return {messages: [], outcome: 'unknown', oldestReached: until};
      }

      const messages = this.stored.filter((m) =>
        (since === undefined || m.timestamp >= since) &&
        (until === undefined || m.timestamp <= until)
      );
      if(this.truncateAt !== null) {
        const oldestReached = this.truncateAt;
        this.truncateAt = null; // one truncated tick, then the walk completes
        return {messages, outcome: 'truncated', oldestReached};
      }
      return {messages, outcome: 'exhausted'};
    }

    subscribeMessages(): void {
      this.subscribed = true;
    }
    unsubscribeMessages(): void {
      this.subscribed = false;
    }

    onMessage(handler: (msg: MockMsg) => void): void {
      this.messageHandler = handler;
    }

    setEventDedup(fn: (id: string) => boolean): void {
      this.claimEvent = fn;
    }

    setEventRelease(fn: (id: string) => void): void {
      this.releaseEvent = fn;
    }

    setEventCommit(fn: (id: string) => void): void {
      this.commitEvent = fn;
    }

    commitEvent: ((id: string) => void) | null = null;

    getPublicKey(): string {
      return 'abcd1234pubkey';
    }
    getState(): string {
      return this.connectionState;
    }
    getLatency(): number {
      return -1;
    }
    sendRawEvent(_event: any): void {}

    // Raw wraps this relay is holding, keyed by wrap id, each carrying the
    // message it unwraps to. Models what the relay ACTUALLY stores (gift wraps),
    // as opposed to `stored`, which is the already-decrypted view the paged
    // walk hands back.
    storedWraps: Map<string, {id: string; created_at: number; msg: MockMsg}> = new Map();
    // Every filter the pool has asked this relay to raw-query with.
    rawQueries: Record<string, unknown>[] = [];

    async queryRawEvents(filter: Record<string, unknown>): Promise<any[]> {
      this.rawQueries.push(filter);
      if(this.connectionState !== 'connected') return [];
      const ids = (filter.ids as string[]) ?? [];
      return ids
      .map((id) => this.storedWraps.get(id))
      .filter(Boolean)
      .map((w) => ({id: w!.id, created_at: w!.created_at, kind: 1059}));
    }

    // The real relay runs an out-of-band event through the identical path a
    // socket-delivered one takes: the shared pre-decrypt claim gate, then unwrap,
    // then dispatch. Model exactly that — including the gate, which is what makes
    // a still-claimed wrap silently vanish.
    async ingestExternalEvent(event: any): Promise<void> {
      if(event.id && this.claimEvent && !this.claimEvent(event.id)) return;
      const wrap = this.storedWraps.get(event.id);
      if(!wrap) return;
      this.messageHandler?.(wrap.msg);
      this.commitEvent?.(event.id);
    }

    simulateMessage(msg: MockMsg): void {
      this.messageHandler?.(msg);
    }
  }

  return {mockRelayInstances: instances, MockNostrRelayClass: MockRelay};
});

vi.mock('@lib/phantomchat/nostr-relay', () => ({
  NostrRelay: MockNostrRelayClass
}));

vi.mock('@lib/rootScope', () => ({
  default: {dispatchEvent: vi.fn()}
}));

vi.mock('@lib/phantomchat/nip65', () => ({
  buildNip65Event: vi.fn().mockReturnValue({kind: 10002, tags: [], content: '', id: 'm', sig: 's'})
}));

vi.mock('@lib/phantomchat/key-storage', () => ({
  loadEncryptedIdentity: vi.fn().mockResolvedValue(null),
  loadBrowserKey: vi.fn().mockResolvedValue(null),
  decryptKeys: vi.fn().mockResolvedValue({seed: ''}),
  saveEncryptedIdentity: vi.fn().mockResolvedValue(undefined),
  saveBrowserKey: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('@lib/logger', () => ({
  logger: () => {
    const log = (..._a: unknown[]) => {};
    log.warn = (..._a: unknown[]) => {};
    log.error = (..._a: unknown[]) => {};
    log.debug = (..._a: unknown[]) => {};
    return log;
  },
  Logger: class {},
  LogTypes: {None: 0, Error: 1, Warn: 2, Log: 4, Debug: 8}
}));

import {NostrRelayPool} from '@lib/phantomchat/nostr-relay-pool';

const RELAYS = [{url: 'wss://r1.test', read: true, write: true}];

function makeMsg(id: string, timestamp: number): MockMsg {
  return {id, from: 'kai-pubkey-hex', content: 'answer from Kai', timestamp};
}

describe('message-loss recovery', () => {
  beforeEach(() => {
    mockRelayInstances.length = 0;
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('hole 1 — dedup must not poison a wrap that never got delivered', () => {
    it('re-admits a wrap id whose processing failed, so a replay can retry it', async() => {
      const onMessage = vi.fn();
      const pool = new NostrRelayPool({relays: [...RELAYS], onMessage});
      await pool.initialize();

      const relay = mockRelayInstances[0];
      const claim = relay.claimEvent!;
      expect(claim).toBeTypeOf('function');

      const release = relay.releaseEvent!;
      expect(release).toBeTypeOf('function');

      // The wrap lands live. The pool claims its id BEFORE unwrapping.
      expect(claim('wrap-kai-1')).toBe(true);

      // ...and then the unwrap dies (frozen worker on a backgrounded PWA).
      // Nothing is ever dispatched — onMessage never fires. The relay hands the
      // claim back rather than leaving it poisoned.
      expect(onMessage).not.toHaveBeenCalled();
      release('wrap-kai-1');

      // The relay replays the very same wrap on the next reconnect/backfill.
      // It MUST be admitted this time — otherwise it is lost until a reload.
      expect(claim('wrap-kai-1')).toBe(true);
    });

    it('still dedups a wrap that WAS delivered (no double bubble)', async() => {
      const onMessage = vi.fn();
      const pool = new NostrRelayPool({relays: [...RELAYS], onMessage});
      await pool.initialize();

      const relay = mockRelayInstances[0];
      const claim = relay.claimEvent!;

      expect(claim('wrap-kai-2')).toBe(true);
      // Processing succeeded — the message reached the pool.
      relay.simulateMessage(makeMsg('rumor-kai-2', Math.floor(Date.now() / 1000)));
      expect(onMessage).toHaveBeenCalledTimes(1);

      // Replay of the same wrap must NOT be re-admitted.
      expect(claim('wrap-kai-2')).toBe(false);
      expect(onMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('hole 2 — catch-up poll must not slide past a long sleep', () => {
    it('recovers a wrap that arrived while the tab was frozen for 10 minutes', async() => {
      const t0 = 1_800_000_000; // fixed epoch seconds
      vi.useFakeTimers();
      vi.setSystemTime(t0 * 1000);

      const onMessage = vi.fn();
      const pool = new NostrRelayPool({relays: [...RELAYS], onMessage});
      await pool.initialize();
      pool.subscribeMessages();

      const relay = mockRelayInstances[0];

      // A message lands live at t0 — this sets the watermark.
      relay.simulateMessage(makeMsg('rumor-seen', t0));
      expect(onMessage).toHaveBeenCalledTimes(1);
      onMessage.mockClear();

      // Kai answers 60s later. The tab is frozen: the socket is deaf, nothing
      // is pushed, nothing is claimed. The wrap only exists ON THE RELAY.
      const missed = makeMsg('rumor-kai-missed', t0 + 60);
      relay.stored.push(missed);

      // The tab sleeps for 10 minutes, then resumes. The next catch-up poll
      // tick fires.
      vi.setSystemTime((t0 + 600) * 1000);
      relay.sinceCalls.length = 0;
      await (pool as any).backfillRecent();

      const since = relay.sinceCalls[0];
      expect(since).toBeDefined();

      // The poll must reach back to the WATERMARK, not to now-90s. A now-90s
      // window starts at t0+510 — 450s after the missed message — so it can
      // never see it.
      expect(since!).toBeLessThanOrEqual(missed.timestamp);
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage.mock.calls[0][0].id).toBe('rumor-kai-missed');
    });
  });

  // Review finding (Robert): reaching the poll back to the watermark makes the
  // GAP bigger, and a limit-capped REQ answers a big gap with only its NEWEST
  // page. If the pool then advances the watermark to the newest message it
  // decrypted, everything older is stranded below the floor forever. The relay
  // paginates (getMessagesPaged); the pool must not "catch up" past a walk that
  // ran out of pages.
  describe('truncated backfill must not strand the messages it did not reach', () => {
    it('holds the watermark while a backfill gap is still open', async() => {
      const t0 = 1_800_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(t0 * 1000);

      const onMessage = vi.fn();
      const pool = new NostrRelayPool({relays: [...RELAYS], onMessage});
      await pool.initialize();
      pool.subscribeMessages();

      const relay = mockRelayInstances[0];

      // A deep backlog: the walk hits the page cap and only reaches back to
      // t0+500, leaving everything below it unfetched.
      relay.stored.push(makeMsg('rumor-newest', t0 + 900));
      relay.truncateAt = t0 + 500;

      await (pool as any).backfillRecent();

      expect(onMessage).toHaveBeenCalledTimes(1); // the newest DID arrive...
      // ...but the watermark must NOT jump to it. Doing so would put the floor
      // above the unfetched older wraps and make them permanently unreachable —
      // every replay path (live REQ, poll, reconnect backfill) keys off it.
      expect((pool as any).lastSeenTimestamp).toBe(0);
      expect((pool as any).backfillGapOpen).toBe(true);
    });

    it('resumes the walk from the saved cursor, then advances once the gap closes', async() => {
      const t0 = 1_800_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(t0 * 1000);

      const onMessage = vi.fn();
      const pool = new NostrRelayPool({relays: [...RELAYS], onMessage});
      await pool.initialize();
      pool.subscribeMessages();

      const relay = mockRelayInstances[0];
      relay.stored.push(makeMsg('rumor-newest', t0 + 900));
      relay.truncateAt = t0 + 500;

      await (pool as any).backfillRecent();
      expect((pool as any).backfillCursor).toBe(t0 + 500);

      // Next tick must CONTINUE from the cursor. Restarting from the top would
      // re-fetch the same newest page forever and never reach the older wraps.
      relay.stored.push(makeMsg('rumor-older', t0 + 300));
      relay.pagedCalls.length = 0;
      onMessage.mockClear();

      await (pool as any).backfillRecent();

      expect(relay.pagedCalls[0].until).toBe(t0 + 500);
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage.mock.calls[0][0].id).toBe('rumor-older');

      // Range exhausted this time — the gap is closed, so the watermark is free
      // to move again.
      expect((pool as any).backfillGapOpen).toBe(false);
      expect((pool as any).lastSeenTimestamp).toBe(t0 + 300);
    });
  });

  // Review finding (Robert, re-review of 70920c9): the gap machinery recomputed
  // its state from scratch each tick, so "no relay reported truncation" was read
  // as "the range is exhausted". It is equally what a tick that LEARNED NOTHING
  // looks like — relay threw, page timed out, no read relay connected. Clearing
  // the gap on that throws the cursor away and unfreezes the watermark over wraps
  // never fetched: reload-only recovery, the bug this PR exists to kill, reached
  // through the resume path. And these conditions CORRELATE with the target
  // scenario — a just-woken device has unreconnected relays and a deep backlog.
  //
  // Invariant: gap state may only be CLEARED by a walk that reached the bottom of
  // the range. Absence of a signal is not the signal.
  describe('an unproductive tick must never be mistaken for a closed gap', () => {
    async function poolWithOpenGap(t0: number, onMessage = vi.fn()) {
      vi.useFakeTimers();
      vi.setSystemTime(t0 * 1000);

      const pool = new NostrRelayPool({relays: [...RELAYS], onMessage});
      await pool.initialize();
      pool.subscribeMessages();

      const relay = mockRelayInstances[0];
      relay.stored.push(makeMsg('rumor-newest', t0 + 900));
      relay.truncateAt = t0 + 500;

      await (pool as any).backfillRecent();
      expect((pool as any).backfillGapOpen).toBe(true);
      expect((pool as any).backfillCursor).toBe(t0 + 500);

      return {pool, relay};
    }

    it('a relay that THROWS mid-gap leaves the gap open and the cursor intact', async() => {
      const t0 = 1_800_000_000;
      const {pool, relay} = await poolWithOpenGap(t0);

      // The socket dies — which is the state a just-woken device is in, and
      // exactly when a gap is open.
      relay.getMessagesPaged = async() => {
        throw new Error('socket closed');
      };
      await (pool as any).backfillRecent();

      // Nothing fetched the wraps below t0+500. We learned NOTHING about the
      // range, so the gap must still be open and the resume cursor preserved.
      expect((pool as any).backfillGapOpen).toBe(true);
      expect((pool as any).backfillCursor).toBe(t0 + 500);
      expect((pool as any).lastSeenTimestamp).toBe(0);
    });

    it('a tick with NO CONNECTED READ RELAY leaves the gap open', async() => {
      const t0 = 1_800_000_000;
      const {pool, relay} = await poolWithOpenGap(t0);

      // Relays not yet reconnected after the freeze: the poll has nobody to ask.
      relay.disconnect();
      await (pool as any).backfillRecent();

      expect((pool as any).backfillGapOpen).toBe(true);
      expect((pool as any).backfillCursor).toBe(t0 + 500);
      expect((pool as any).lastSeenTimestamp).toBe(0);
    });

    it('a page TIMEOUT is not a short page — the gap survives it', async() => {
      const t0 = 1_800_000_000;
      const {pool, relay} = await poolWithOpenGap(t0);

      // A slow first query after resume hits the 10s page timeout. The walk
      // reports 'unknown', NOT an exhausted range.
      relay.unknownNext = true;
      await (pool as any).backfillRecent();

      expect((pool as any).backfillGapOpen).toBe(true);
      expect((pool as any).backfillCursor).toBe(t0 + 500);
      expect((pool as any).lastSeenTimestamp).toBe(0);
    });

    it('still closes the gap on POSITIVE evidence — an exhausted walk', async() => {
      const t0 = 1_800_000_000;
      const {pool, relay} = await poolWithOpenGap(t0);

      // The relay answers and reaches the bottom of the range. THAT is evidence,
      // and only that may clear the gap.
      await (pool as any).backfillRecent();

      expect((pool as any).backfillGapOpen).toBe(false);
      expect((pool as any).backfillCursor).toBeUndefined();

      // And the watermark is free to move again — preserving gap state on
      // ignorance must not curdle into a watermark that is frozen forever.
      relay.simulateMessage(makeMsg('rumor-after-gap', t0 + 950));
      expect((pool as any).lastSeenTimestamp).toBe(t0 + 950);
    });
  });

  // Review nit (Robert): wrapFailures only shrank on resume, so a wrap that
  // failed twice then succeeded kept its strikes and parked a failure early.
  describe('failure counters clear on a successful unwrap', () => {
    it('forgets strikes once the wrap unwraps cleanly', async() => {
      const pool = new NostrRelayPool({relays: [...RELAYS], onMessage: vi.fn()});
      await pool.initialize();

      const relay = mockRelayInstances[0];
      const claim = relay.claimEvent!;
      const release = relay.releaseEvent!;
      const commit = relay.commitEvent!;

      // Two failures under a briefly-frozen worker...
      claim('wrap-flaky'); release('wrap-flaky');
      claim('wrap-flaky'); release('wrap-flaky');

      // ...then it unwraps fine. The failures were environmental, so the strikes
      // must go.
      claim('wrap-flaky');
      commit('wrap-flaky');
      expect((pool as any).wrapFailures.has('wrap-flaky')).toBe(false);

      // Proof the budget is genuinely full again: the next failure is strike ONE,
      // so the wrap is released and retryable. Carrying the two stale strikes
      // would make this failure the third — parking a wrap whose only crime was
      // stumbling while the worker was frozen.
      release('wrap-flaky');
      expect(claim('wrap-flaky')).toBe(true);
    });
  });

  // Review finding (Robert, revised): an UNCONDITIONAL release re-opens the
  // FIND-poll-reunwrap freeze — a deterministically-bad wrap near the watermark
  // is re-fetched and re-unwrapped every 15s forever. Cap it. But the cap must
  // reset on resume, or a frozen worker (which fails wraps in BURSTS) burns the
  // budget in ~45s and drops a good message permanently — the original bug.
  describe('retry budget — bounded, but never permanent', () => {
    it('parks a wrap that keeps failing, killing the 15s re-unwrap loop', async() => {
      const pool = new NostrRelayPool({relays: [...RELAYS], onMessage: vi.fn()});
      await pool.initialize();

      const relay = mockRelayInstances[0];
      const claim = relay.claimEvent!;
      const release = relay.releaseEvent!;

      // Three consecutive failed unwraps of the same wrap.
      for(let i = 0; i < 3; i++) {
        expect(claim('wrap-corrupt')).toBe(true); // re-admitted each time
        release('wrap-corrupt');
      }

      // Budget spent: the wrap is now PARKED — the claim is kept, so the poll
      // stops re-fetching and re-decrypting it on every tick.
      expect(claim('wrap-corrupt')).toBe(false);
    });

    it('un-parks on resume, so a frozen-worker burst never loses a good wrap', async() => {
      const pool = new NostrRelayPool({relays: [...RELAYS], onMessage: vi.fn()});
      await pool.initialize();

      const relay = mockRelayInstances[0];
      const claim = relay.claimEvent!;
      const release = relay.releaseEvent!;

      // The tab is backgrounded and the unwrap worker is frozen: this PERFECTLY
      // GOOD wrap fails on every attempt, in a burst, and gets parked.
      for(let i = 0; i < 3; i++) {
        claim('wrap-kai-good');
        release('wrap-kai-good');
      }
      expect(claim('wrap-kai-good')).toBe(false); // parked

      // The user comes back to the tab. The worker thaws. The wrap MUST become
      // retryable — otherwise the cap is just the poisoning we set out to remove.
      document.dispatchEvent(new Event('visibilitychange'));

      expect(claim('wrap-kai-good')).toBe(true);
    });
  });

  // Releasing a claim makes a wrap CLAIMABLE. It does not make it REACHABLE.
  //
  // Every replay path is keyed off the watermark (`since = min(now-90s,
  // lastSeen-fuzz)`), and the watermark advances on any delivered message. So a
  // wrap that fails to unwrap and is then overtaken by a later, successful
  // message falls BELOW the floor — and no since-query will ever ask for it
  // again. The release is a promise the poll cannot keep: seenWrapIds says
  // "retry me", the watermark says "never look there again", and the watermark
  // wins. Invisible until reload — the exact bug this suite exists to kill,
  // surviving in the failed-unwrap path.
  //
  // The fix is targeted re-fetch BY ID (the wrap id is known — we just released
  // it), not widening the since-window: the window is the thing that is wrong,
  // and dragging it back down would replay unbounded history on every tick.
  describe('a released wrap must stay reachable after the watermark overtakes it', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('re-fetches a failed wrap by id once the watermark has moved past it', async() => {
      const t0 = 1_800_000_000;
      vi.setSystemTime(t0 * 1000);

      const onMessage = vi.fn();
      const pool = new NostrRelayPool({relays: [...RELAYS], onMessage});
      await pool.initialize();
      pool.subscribeMessages();

      const relay = mockRelayInstances[0];
      const claim = relay.claimEvent!;
      const release = relay.releaseEvent!;

      // Kai's message lands at t0. The relay genuinely HOLDS it — both as a raw
      // wrap and in the paged view. Nothing about this message is lost.
      const missed = makeMsg('rumor-kai-missed', t0);
      relay.stored.push(missed);
      relay.storedWraps.set('wrap-kai-missed', {
        id: 'wrap-kai-missed', created_at: t0, msg: missed
      });

      // But the unwrap dies (frozen worker). Claimed, failed, released.
      expect(claim('wrap-kai-missed')).toBe(true);
      release('wrap-kai-missed');
      expect(onMessage).not.toHaveBeenCalled();

      // The conversation carries on. Ten minutes later a message unwraps fine,
      // and the watermark jumps to t0+600 — sailing past the wrap we dropped.
      vi.setSystemTime((t0 + 600) * 1000);
      relay.simulateMessage(makeMsg('rumor-later', t0 + 600));
      expect(onMessage).toHaveBeenCalledTimes(1);
      onMessage.mockClear();

      // Now the catch-up poll runs. Its since-window starts at
      // min(now-90, watermark-fuzz) = t0+300 — 300s ABOVE the missed wrap. The
      // paged walk cannot see it, and never will again.
      await (pool as any).backfillRecent();

      const since = relay.sinceCalls[relay.sinceCalls.length - 1];
      expect(since!).toBeGreaterThan(missed.timestamp); // the floor really is above it

      // ...so the ONLY way back is a targeted re-fetch of the id we released.
      // Without one, Kai's message is on the relay, retrievable, and invisible.
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage.mock.calls[0][0].id).toBe('rumor-kai-missed');
    });

    it('un-parking on resume actually re-delivers, not merely re-admits', async() => {
      const t0 = 1_800_000_000;
      vi.setSystemTime(t0 * 1000);

      const onMessage = vi.fn();
      const pool = new NostrRelayPool({relays: [...RELAYS], onMessage});
      await pool.initialize();
      pool.subscribeMessages();

      const relay = mockRelayInstances[0];
      const claim = relay.claimEvent!;
      const release = relay.releaseEvent!;

      const missed = makeMsg('rumor-parked', t0);
      relay.stored.push(missed);
      relay.storedWraps.set('wrap-parked', {id: 'wrap-parked', created_at: t0, msg: missed});

      // A frozen worker burns the whole retry budget in a burst — the wrap parks.
      for(let i = 0; i < 3; i++) {
        claim('wrap-parked');
        release('wrap-parked');
      }
      expect(claim('wrap-parked')).toBe(false); // parked

      // The watermark then sails past it.
      vi.setSystemTime((t0 + 600) * 1000);
      relay.simulateMessage(makeMsg('rumor-later', t0 + 600));
      onMessage.mockClear();

      // User foregrounds. The existing code un-parks the wrap — but un-parking
      // only clears a flag. Nothing re-requests the wrap, and the watermark is
      // now above it, so it stays gone. Resume must actually GO AND GET IT.
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);

      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage.mock.calls[0][0].id).toBe('rumor-parked');
    });

    it('does not keep re-fetching a wrap that unwrapped cleanly', async() => {
      const t0 = 1_800_000_000;
      vi.setSystemTime(t0 * 1000);

      const pool = new NostrRelayPool({relays: [...RELAYS], onMessage: vi.fn()});
      await pool.initialize();
      pool.subscribeMessages();

      const relay = mockRelayInstances[0];
      const claim = relay.claimEvent!;
      const release = relay.releaseEvent!;
      const commit = relay.commitEvent!;

      // Failed once (so it is pending re-fetch), then succeeded on retry.
      claim('wrap-flaky');
      release('wrap-flaky');
      claim('wrap-flaky');
      commit('wrap-flaky');

      // A committed wrap is done. It must not sit in the pending set generating
      // an ids-query on every 15s tick forever.
      relay.rawQueries.length = 0;
      await (pool as any).backfillRecent();
      expect(relay.rawQueries).toHaveLength(0);
    });

    it('keeps the pending id when no relay is connected to answer', async() => {
      const t0 = 1_800_000_000;
      vi.setSystemTime(t0 * 1000);

      const pool = new NostrRelayPool({relays: [...RELAYS], onMessage: vi.fn()});
      await pool.initialize();
      pool.subscribeMessages();

      const relay = mockRelayInstances[0];
      // Claim then fail, as production does — a release with no prior claim is a
      // no-op by design (nothing to hand back).
      relay.claimEvent!('wrap-offline');
      relay.releaseEvent!('wrap-offline');

      // Nothing can answer a re-fetch right now. Ignorance is not absence: the
      // id must survive to be retried, not be quietly dropped on the floor.
      mockRelayInstances.forEach((r: any) => r.disconnect());
      await (pool as any).refetchPendingWraps();
      expect((pool as any).pendingWrapRefetch.has('wrap-offline')).toBe(true);

      // Reconnect, and the re-fetch finally goes out.
      relay.connect();
      relay.rawQueries.length = 0;
      await (pool as any).refetchPendingWraps();
      expect(relay.rawQueries[0]?.ids).toContain('wrap-offline');
    });
  });
});
