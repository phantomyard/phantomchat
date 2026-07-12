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

    // Every (since, until) pair the pool has asked this relay to walk.
    pagedCalls: {since?: number; until?: number}[] = [];
    // When set, the next getMessagesPaged() reports a truncated walk (page cap
    // hit with the range unexhausted) and hands back this resume cursor.
    truncateAt: number | null = null;

    async getMessages(since?: number): Promise<MockMsg[]> {
      this.sinceCalls.push(since);
      return this.stored.filter((m) => since === undefined || m.timestamp >= since);
    }

    async getMessagesPaged(since?: number, until?: number): Promise<{
      messages: MockMsg[];
      truncated: boolean;
      oldestReached?: number;
    }> {
      this.sinceCalls.push(since);
      this.pagedCalls.push({since, until});
      const messages = this.stored.filter((m) =>
        (since === undefined || m.timestamp >= since) &&
        (until === undefined || m.timestamp <= until)
      );
      if(this.truncateAt !== null) {
        const oldestReached = this.truncateAt;
        this.truncateAt = null; // one truncated tick, then the walk completes
        return {messages, truncated: true, oldestReached};
      }
      return {messages, truncated: false};
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
});
