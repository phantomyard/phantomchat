/**
 * Tests for NostrRelayPool — multi-relay publish, subscribe, and dedup
 *
 * Uses vi.resetModules() + vi.doMock() + dynamic import in beforeEach
 * to get fresh module instances per test, avoiding mock contamination
 * from relay-failover.test.ts (isolate:false).
 */

import 'fake-indexeddb/auto';
import '../setup';

// ─── Hoisted mock state ────────────────────────────────────────────

interface MockMsg {
  id: string;
  from: string;
  content: string;
  timestamp: number;
}

const {mockRelayInstances, MockNostrRelayClass} = vi.hoisted(() => {
  // Use a global instances array so that both this file's MockRelay
  // and relay-failover.test.ts's MockRelay push to the same array.
  // Under isolate:false, whichever MockRelay class wins the vi.mock
  // registration race, instances will be tracked correctly.
  if(!(globalThis as any).__nostrRelayPoolTestInstances) {
    (globalThis as any).__nostrRelayPoolTestInstances = [];
  }
  const instances: any[] = (globalThis as any).__nostrRelayPoolTestInstances;

  class MockRelay {
    url: string;
    initialized = false;
    connected = false;
    subscribed = false;
    disconnected = false;
    messageHandler: ((msg: MockMsg) => void) | null = null;
    connectionState: string = 'disconnected';

    constructor(url: string) {
      this.url = url;
      instances.push(this);
    }

    async initialize(): Promise<void> {
      this.initialized = true;
    }

    connect(): void {
      this.connected = true;
      this.connectionState = 'connected';
    }

    disconnect(): void {
      this.disconnected = true;
      this.connected = false;
      this.connectionState = 'disconnected';
    }

    resetReconnectBackoff(): void {}

    async storeMessage(_recipientPubkey: string, _plaintext: string): Promise<string> {
      if(!this.connected) throw new Error('Not connected to relay');
      return 'event-id-' + Math.random().toString(36).slice(2, 8);
    }

    async getMessages(_since?: number): Promise<MockMsg[]> {
      return [];
    }

    // The catch-up poll walks the range in pages (see NostrRelay.getMessagesPaged)
    // so it can reach wraps older than one limit-capped REQ returns.
    async getMessagesPaged(_since?: number, _until?: number): Promise<{
      messages: MockMsg[];
      outcome: 'exhausted' | 'truncated' | 'unknown';
      oldestReached?: number;
    }> {
      return {messages: [], outcome: 'exhausted'};
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

    // Dedup/release/commit hooks the pool wires up per relay — captured so
    // tests can drive the wrap retry-budget lifecycle directly.
    claimEvent: ((id: string) => boolean) | null = null;
    releaseEvent: ((id: string, error?: Error) => void) | null = null;
    commitEvent: ((id: string) => void) | null = null;

    setEventDedup(fn: (id: string) => boolean): void {
      this.claimEvent = fn;
    }

    setEventRelease(fn: (id: string, error?: Error) => void): void {
      this.releaseEvent = fn;
    }

    setEventCommit(fn: (id: string) => void): void {
      this.commitEvent = fn;
    }

    getPublicKey(): string {
      return 'abcd1234pubkey';
    }

    getState(): string {
      return this.connectionState;
    }

    simulateMessage(msg: MockMsg): void {
      if(this.messageHandler) {
        this.messageHandler(msg);
      }
    }

    simulateDisconnect(): void {
      this.connected = false;
      this.connectionState = 'disconnected';
    }

    // Phase 3 methods
    getLatency(): number {
      return -1;
    }

    sendRawEvent(_event: any): void {}
  }

  return {mockRelayInstances: instances, MockNostrRelayClass: MockRelay};
});

// Module-level vi.mock (hoisted) — baseline registration.
vi.mock('@lib/phantomchat/nostr-relay', () => ({
  NostrRelay: MockNostrRelayClass
}));

vi.mock('@lib/phantomchat/identity', () => ({
  loadIdentity: vi.fn().mockResolvedValue({
    id: 'current',
    seed: 'test seed phrase',
    ownId: 'AAAAA.BBBBB.CCCCC',
    publicKey: 'dGVzdC1wdWJsaWMta2V5',
    privateKey: 'dGVzdC1wcml2YXRlLWtleQ==',
    encryptionKey: 'dGVzdC1lbmNyeXB0aW9uLWtleQ==',
    createdAt: Date.now()
  })
}));

vi.mock('@lib/rootScope', () => ({
  default: {
    dispatchEvent: vi.fn()
  }
}));

vi.mock('@lib/phantomchat/nip65', () => ({
  buildNip65Event: vi.fn().mockReturnValue({kind: 10002, tags: [], content: '', id: 'mock-id', sig: 'mock-sig'})
}));

// Mock key-storage to avoid IndexedDB calls that hang after
// relay-failover.test.ts resets the module cache.
vi.mock('@lib/phantomchat/key-storage', () => ({
  loadEncryptedIdentity: vi.fn().mockResolvedValue(null),
  loadBrowserKey: vi.fn().mockResolvedValue(null),
  decryptKeys: vi.fn().mockResolvedValue({seed: ''}),
  saveEncryptedIdentity: vi.fn().mockResolvedValue(undefined),
  saveBrowserKey: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('@lib/logger', () => ({
  logger: () => {
    const log = (..._args: unknown[]) => {};
    log.warn = (..._args: unknown[]) => {};
    log.error = (..._args: unknown[]) => {};
    log.debug = (..._args: unknown[]) => {};
    return log;
  },
  Logger: class {},
  LogTypes: {None: 0, Error: 1, Warn: 2, Log: 4, Debug: 8}
}));

// ─── Per-test fresh module import ─────────────────────────────────

type DecryptedMessage = MockMsg;

function makeMessage(id: string, timestamp?: number): DecryptedMessage {
  return {
    id,
    from: 'sender-pubkey-hex',
    content: 'hello world',
    timestamp: timestamp ?? Math.floor(Date.now() / 1000)
  };
}

// Static import — both this file and relay-failover.test.ts mock
// @lib/phantomchat/nostr-relay with structurally compatible MockRelay classes
// (both have simulateMessage, simulateDisconnect, etc.), so it doesn't
// matter which mock wins. No vi.resetModules() needed.
import {NostrRelayPool, DEFAULT_RELAYS} from '@lib/phantomchat/nostr-relay-pool';
import rootScope from '@lib/rootScope';

describe('NostrRelayPool', () => {
  beforeEach(() => {
    mockRelayInstances.length = 0;
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('initialization', () => {
    it('loads default relays when no config in IndexedDB', async() => {
      const onMessage = vi.fn();
      // Pass explicit relays to skip IndexedDB path (which is
      // unreliable under isolate:false due to fake-indexeddb state
      // leaking across files).
      const pool = new NostrRelayPool({relays: [...DEFAULT_RELAYS], onMessage});

      await pool.initialize();

      const relays = pool.getRelays();
      expect(relays).toHaveLength(DEFAULT_RELAYS.length);
      expect(relays.map((r: any) => r.url)).toEqual(DEFAULT_RELAYS.map((r: any) => r.url));
    });

    it('opens a socket to every configured relay by default', async() => {
      const onMessage = vi.fn();
      const pool = new NostrRelayPool({relays: [...DEFAULT_RELAYS], onMessage});

      await pool.initialize();

      // Default is connect-all: an entry AND a live socket for every relay.
      expect(mockRelayInstances.length).toBe(DEFAULT_RELAYS.length);
      const connected = mockRelayInstances.filter((r: any) => r.connected);
      expect(connected.length).toBe(DEFAULT_RELAYS.length);
      expect(pool.getConnectedCount()).toBe(DEFAULT_RELAYS.length);
    });

    it('opens sockets to every relay when maxActiveRelays covers them all', async() => {
      const onMessage = vi.fn();
      const pool = new NostrRelayPool({
        relays: [...DEFAULT_RELAYS],
        maxActiveRelays: DEFAULT_RELAYS.length,
        onMessage
      });

      await pool.initialize();

      expect(mockRelayInstances.length).toBe(DEFAULT_RELAYS.length);
      for(const relay of mockRelayInstances) {
        expect(relay.initialized).toBe(true);
        expect(relay.connected).toBe(true);
      }
    });

    it('benches a flapping relay and keeps the rest connected', async() => {
      const onMessage = vi.fn();
      const pool = new NostrRelayPool({relays: [...DEFAULT_RELAYS], onMessage});
      await pool.initialize();

      // All connected (connect-all).
      expect(mockRelayInstances.filter((r: any) => r.connected).length).toBe(DEFAULT_RELAYS.length);
      const firstActive = mockRelayInstances.filter((r: any) => r.connected)[0];

      // Flap the first relay past threshold: connect→drop, 3× quick.
      for(let i = 0; i < 3; i++) {
        firstActive.connectionState = 'connected';
        firstActive.onStateChange?.();
        firstActive.connectionState = 'reconnecting';
        firstActive.onStateChange?.();
      }
      await vi.advanceTimersByTimeAsync(0);

      // The flapping relay is benched (disconnected); the rest carry on. The
      // liveness floor does NOT fire — the remaining relays are still active.
      expect(pool.getConnectedCount()).toBe(DEFAULT_RELAYS.length - 1);
    });

    it('throttles per-relay reconnect backfills during a flap storm', async() => {
      const pool = new NostrRelayPool({
        relays: [...DEFAULT_RELAYS],
        maxActiveRelays: DEFAULT_RELAYS.length,
        onMessage: vi.fn()
      });
      await pool.initialize();
      pool.subscribeMessages();

      const relay = mockRelayInstances.filter((r: any) => r.connected)[0];
      // The reconnect backfill is PAGED now (same walk discipline as the poll),
      // so count walks, not single-shot queries. The 15s catch-up poll walks
      // this relay too — compare against a baseline rather than an absolute.
      const walkSpy = vi.spyOn(relay, 'getMessagesPaged');
      const walks = () => walkSpy.mock.calls.length;

      // Register the first connect (no backfill on first connect by design)
      relay.connectionState = 'connected';
      relay.onStateChange?.();
      expect(walks()).toBe(0);

      // First reconnect: the idle-gap backfill runs
      relay.connectionState = 'reconnecting';
      relay.onStateChange?.();
      relay.connectionState = 'connected';
      relay.onStateChange?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(walks()).toBe(1);

      // Immediate re-flap inside the throttle window: no second backfill —
      // each one re-runs every returned wrap through main-thread unwrap crypto,
      // and the watermark poll covers the gap.
      relay.connectionState = 'reconnecting';
      relay.onStateChange?.();
      relay.connectionState = 'connected';
      relay.onStateChange?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(walks()).toBe(1);

      // Past the window (and connected long enough to clear the flap counter),
      // a reconnect backfills again.
      await vi.advanceTimersByTimeAsync(35_000);
      const afterPolls = walks();
      relay.connectionState = 'reconnecting';
      relay.onStateChange?.();
      relay.connectionState = 'connected';
      relay.onStateChange?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(walks()).toBe(afterPolls + 1);
    });
  });

  describe('publish', () => {
    it('publishes to all write-enabled relays', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true},
        {url: 'wss://relay2.test', read: true, write: true},
        {url: 'wss://relay3.test', read: true, write: false}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      const storeSpy1 = vi.spyOn(mockRelayInstances[0], 'storeMessage');
      const storeSpy2 = vi.spyOn(mockRelayInstances[1], 'storeMessage');
      const storeSpy3 = vi.spyOn(mockRelayInstances[2], 'storeMessage');

      const result = await pool.publish('recipient-pubkey', 'hello');

      expect(storeSpy1).toHaveBeenCalledWith('recipient-pubkey', 'hello');
      expect(storeSpy2).toHaveBeenCalledWith('recipient-pubkey', 'hello');
      expect(storeSpy3).not.toHaveBeenCalled();
      expect(result.successes.length).toBe(2);
    });

    it('returns successes and failures in PublishResult', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true},
        {url: 'wss://relay2.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      vi.spyOn(mockRelayInstances[1], 'storeMessage').mockRejectedValue(new Error('connection lost'));

      const result = await pool.publish('recipient-pubkey', 'hello');

      expect(result.successes.length).toBe(1);
      expect(result.failures.length).toBe(1);
      expect(result.failures[0].url).toBe('wss://relay2.test');
      expect(result.failures[0].error).toBe('connection lost');
    });

    it('succeeds if at least one relay accepts', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true},
        {url: 'wss://relay2.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      vi.spyOn(mockRelayInstances[0], 'storeMessage').mockRejectedValue(new Error('fail'));

      const result = await pool.publish('recipient-pubkey', 'hello');

      expect(result.successes.length).toBe(1);
      expect(result.failures.length).toBe(1);
    });

    // phantomchat#143: publish() = wrapForSend + publishWraps, split so the
    // P2P-first path can ship the wrap directly before any relay fan-out.
    it('publishWraps hands every wrap to each write relay and reports per-relay failures', async() => {
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true},
        {url: 'wss://relay2.test', read: true, write: true},
        {url: 'wss://relay3.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage: vi.fn()});
      await pool.initialize();
      const sent: Record<string, string[]> = {};
      for(const inst of mockRelayInstances) {
        inst.publishRawEvent = vi.fn((w: any) => {
          if(inst.url === 'wss://relay2.test') throw new Error('socket gone');
          (sent[inst.url] ??= []).push(w.id);
        });
      }

      const wraps = [{id: 'w-peer'}, {id: 'w-self'}] as any;
      const result = pool.publishWraps(wraps);

      expect(sent['wss://relay1.test']).toEqual(['w-peer', 'w-self']);
      expect(sent['wss://relay3.test']).toEqual(['w-peer', 'w-self']);
      expect(result.successes).toEqual(['w-peer', 'w-peer']);
      expect(result.failures).toEqual([{url: 'wss://relay2.test', error: 'socket gone'}]);
    });

    // Review on #144: the first relay publish of a rumor that only went over P2P
    // must reach our own other devices too — includeSelf adds the self copy.
    it('rewrapAndPublish(includeSelf) hands each relay the recipient AND the self-addressed copy of the same rumor', async() => {
      const {generateSecretKey, getPublicKey} = await import('nostr-tools/pure');
      const {wrapV2, unwrapV2, getSymmetricKey} = await import('@lib/phantomchat/nostr-crypto');
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true},
        {url: 'wss://relay2.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage: vi.fn()});
      await pool.initialize();
      const skA = generateSecretKey();
      const pkA = getPublicKey(skA);
      const skB = generateSecretKey();
      const pkB = getPublicKey(skB);
      (pool as any).privateKeyBytes = skA;
      await getSymmetricKey(skA, pkB);
      const {rumor, rumorId} = await wrapV2(skA, pkB, 'direct first');
      const sent: Record<string, any[]> = {};
      for(const inst of mockRelayInstances) {
        inst.publishRawEvent = vi.fn((w: any) => { (sent[inst.url] ??= []).push(w); });
      }

      const withSelf = await pool.rewrapAndPublish(pkB, rumor, {includeSelf: true});
      const pTo = (w: any) => w.tags.find((t: string[]) => t[0] === 'p')[1];
      for(const url of ['wss://relay1.test', 'wss://relay2.test']) {
        expect(sent[url].map(pTo)).toEqual([pkB, pkA]);
      }
      expect(withSelf.successes).toEqual([withSelf.wraps![0].id, withSelf.wraps![0].id]);
      expect((await unwrapV2(sent['wss://relay1.test'][1], skA)).id).toBe(rumorId);
      expect((await unwrapV2(sent['wss://relay1.test'][0], skB)).id).toBe(rumorId);

      for(const k of Object.keys(sent)) delete sent[k];
      await pool.rewrapAndPublish(pkB, rumor);
      expect(sent['wss://relay1.test'].map(pTo)).toEqual([pkB]);
    });

    it('wrapForSend throws without an identity key instead of returning a bogus wrap', async() => {
      const pool = new NostrRelayPool({relays: [{url: 'wss://relay1.test', read: true, write: true}], onMessage: vi.fn()});
      await expect(pool.wrapForSend('recipient', 'hi')).rejects.toThrow(/private key/);
    });
  });

  describe('deduplication', () => {
    it('delivers each event ID only once', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true},
        {url: 'wss://relay2.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();
      pool.subscribeMessages();

      const msg = makeMessage('dup-event-1');

      // Both relays deliver the same message
      mockRelayInstances[0].simulateMessage(msg);
      mockRelayInstances[1].simulateMessage(msg);

      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledWith(msg);
    });

    it('evicts old entries from LRU cache', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();
      pool.subscribeMessages();

      // Fill cache with 10,001 unique messages to evict msg-0
      for(let i = 0; i < 10001; i++) {
        mockRelayInstances[0].simulateMessage(makeMessage(`msg-${i}`));
      }

      // Live deliveries are serialized behind the first one — drain the
      // pump so all 10,001 have been processed (and evicted msg-0).
      await (pool as any).liveDeliveryDone;

      expect(onMessage).toHaveBeenCalledTimes(10001);

      // Now deliver the very first message again — it should have been evicted
      onMessage.mockClear();
      mockRelayInstances[0].simulateMessage(makeMessage('msg-0'));
      await (pool as any).liveDeliveryDone;
      expect(onMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('presence envelope drop (presence removed)', () => {
    function presenceMsg(id: string, type: 'presence-ping' | 'presence-pong', nonce: string): DecryptedMessage {
      return {
        id,
        from: 'peer-pubkey-hex',
        content: JSON.stringify({id: 'env-' + id, from: 'peer-pubkey-hex', to: 'me', type, nonce, content: '', timestamp: Date.now()}),
        timestamp: Math.floor(Date.now() / 1000)
      };
    }

    it('drops a presence ping — never surfaced to onMessage', async() => {
      const onMessage = vi.fn();
      const pool = new NostrRelayPool({relays: [{url: 'wss://r.test', read: true, write: true}], onMessage});
      await pool.initialize();
      pool.subscribeMessages();

      mockRelayInstances[0].simulateMessage(presenceMsg('ping-1', 'presence-ping', 'n-abc'));

      expect(onMessage).not.toHaveBeenCalled();
    });

    it('drops a presence pong — never surfaced to onMessage', async() => {
      const onMessage = vi.fn();
      const pool = new NostrRelayPool({relays: [{url: 'wss://r.test', read: true, write: true}], onMessage});
      await pool.initialize();
      pool.subscribeMessages();

      mockRelayInstances[0].simulateMessage(presenceMsg('pong-1', 'presence-pong', 'n-xyz'));

      expect(onMessage).not.toHaveBeenCalled();
    });

    it('still delivers a normal text envelope to onMessage', async() => {
      const onMessage = vi.fn();
      const pool = new NostrRelayPool({relays: [{url: 'wss://r.test', read: true, write: true}], onMessage});
      await pool.initialize();
      pool.subscribeMessages();

      const textMsg: DecryptedMessage = {
        id: 'text-1',
        from: 'peer-pubkey-hex',
        content: JSON.stringify({id: 'm1', type: 'text', content: 'hi', timestamp: Date.now()}),
        timestamp: Math.floor(Date.now() / 1000)
      };
      mockRelayInstances[0].simulateMessage(textMsg);

      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledWith(textMsg);
    });
  });

  describe('device-sync digest envelope routing', () => {
    // Matches the mocked identity publicKey — a digest is always self-authored.
    const SELF_PUBKEY = 'dGVzdC1wdWJsaWMta2V5';

    function digestMsg(id: string, from: string, deviceId: string, count: number): DecryptedMessage {
      return {
        id,
        from,
        content: JSON.stringify({type: 'device-digest', deviceId, conv: 'a:b', count, latestId: 'z', timestamp: Date.now()}),
        timestamp: Math.floor(Date.now() / 1000)
      };
    }

    it('routes a self-authored digest to onDigest and never to onMessage', async() => {
      const onMessage = vi.fn();
      const pool = new NostrRelayPool({
        relays: [{url: 'wss://r.test', read: true, write: true}],
        onMessage,
        preloadedIdentity: {publicKey: SELF_PUBKEY, privateKeyHex: 'short'}
      });
      await pool.initialize();
      pool.subscribeMessages();

      const seen: any[] = [];
      pool.setOnDigest((d) => seen.push(d));

      mockRelayInstances[0].simulateMessage(digestMsg('dg-1', SELF_PUBKEY, 'device-x', 7));

      expect(onMessage).not.toHaveBeenCalled();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({deviceId: 'device-x', conv: 'a:b', count: 7, latestId: 'z'});
    });

    it('drops a digest forged by a non-self author (never onDigest, never onMessage)', async() => {
      const onMessage = vi.fn();
      const pool = new NostrRelayPool({
        relays: [{url: 'wss://r.test', read: true, write: true}],
        onMessage,
        preloadedIdentity: {publicKey: SELF_PUBKEY, privateKeyHex: 'short'}
      });
      await pool.initialize();
      pool.subscribeMessages();

      const seen: any[] = [];
      pool.setOnDigest((d) => seen.push(d));

      mockRelayInstances[0].simulateMessage(digestMsg('dg-2', 'someone-else', 'device-y', 9));

      expect(onMessage).not.toHaveBeenCalled();
      expect(seen).toHaveLength(0);
    });

    function syncReqMsg(id: string, from: string): DecryptedMessage {
      return {
        id, from,
        content: JSON.stringify({type: 'device-sync-req', deviceId: 'req-dev', targetId: 'holder-dev', conv: 'a:b', haveIds: ['m1'], timestamp: Date.now()}),
        timestamp: Math.floor(Date.now() / 1000)
      };
    }
    function syncResMsg(id: string, from: string): DecryptedMessage {
      return {
        id, from,
        content: JSON.stringify({type: 'device-sync-res', deviceId: 'holder-dev', targetId: 'req-dev', conv: 'a:b', rows: [{eventId: 'm2'}], seq: 0, last: true, timestamp: Date.now()}),
        timestamp: Math.floor(Date.now() / 1000)
      };
    }

    it('routes a self-authored sync-request to onSyncRequest, never to onMessage', async() => {
      const onMessage = vi.fn();
      const pool = new NostrRelayPool({
        relays: [{url: 'wss://r.test', read: true, write: true}],
        onMessage,
        preloadedIdentity: {publicKey: SELF_PUBKEY, privateKeyHex: 'short'}
      });
      await pool.initialize();
      pool.subscribeMessages();

      const seen: any[] = [];
      pool.setOnSyncRequest((r) => seen.push(r));
      mockRelayInstances[0].simulateMessage(syncReqMsg('sr-1', SELF_PUBKEY));

      expect(onMessage).not.toHaveBeenCalled();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({deviceId: 'req-dev', targetId: 'holder-dev', conv: 'a:b', haveIds: ['m1']});
    });

    it('routes a self-authored sync-response to onSyncResponse, never to onMessage', async() => {
      const onMessage = vi.fn();
      const pool = new NostrRelayPool({
        relays: [{url: 'wss://r.test', read: true, write: true}],
        onMessage,
        preloadedIdentity: {publicKey: SELF_PUBKEY, privateKeyHex: 'short'}
      });
      await pool.initialize();
      pool.subscribeMessages();

      const seen: any[] = [];
      pool.setOnSyncResponse((r) => seen.push(r));
      mockRelayInstances[0].simulateMessage(syncResMsg('ss-1', SELF_PUBKEY));

      expect(onMessage).not.toHaveBeenCalled();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({deviceId: 'holder-dev', targetId: 'req-dev', conv: 'a:b', seq: 0, last: true});
      expect(seen[0].rows).toHaveLength(1);
    });

    it('drops a sync-request forged by a non-self author', async() => {
      const onMessage = vi.fn();
      const pool = new NostrRelayPool({
        relays: [{url: 'wss://r.test', read: true, write: true}],
        onMessage,
        preloadedIdentity: {publicKey: SELF_PUBKEY, privateKeyHex: 'short'}
      });
      await pool.initialize();
      pool.subscribeMessages();

      const seen: any[] = [];
      pool.setOnSyncRequest((r) => seen.push(r));
      mockRelayInstances[0].simulateMessage(syncReqMsg('sr-2', 'someone-else'));

      expect(onMessage).not.toHaveBeenCalled();
      expect(seen).toHaveLength(0);
    });
  });

  describe('reconnection', () => {
    it('pool-level recovery retries all failed relays every 60s', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true},
        {url: 'wss://relay2.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      // Simulate relay2 going down (exhausted per-relay backoff)
      const failedRelay = mockRelayInstances[1];
      failedRelay.simulateDisconnect();

      // Reset initialized flag to verify recovery re-initializes
      failedRelay.initialized = false;

      // Advance 60s for pool recovery
      vi.advanceTimersByTime(60_000);

      // Pool recovery is async (initialize returns a promise) —
      // flush the microtask queue
      await vi.advanceTimersByTimeAsync(0);

      expect(failedRelay.initialized).toBe(true);
      expect(failedRelay.connected).toBe(true);
    });
  });

  describe('relay management', () => {
    it('addRelay connects and persists to config', async() => {
      const onMessage = vi.fn();
      const pool = new NostrRelayPool({
        relays: [{url: 'wss://relay1.test', read: true, write: true}],
        onMessage
      });
      await pool.initialize();

      const initialCount = mockRelayInstances.length;
      pool.addRelay({url: 'wss://new-relay.test', read: true, write: true});

      // A new relay instance is created immediately
      expect(mockRelayInstances.length).toBe(initialCount + 1);
      const newRelay = mockRelayInstances[mockRelayInstances.length - 1];
      expect(newRelay.url).toBe('wss://new-relay.test');

      // Initialize + connect is async, flush microtasks
      await vi.advanceTimersByTimeAsync(0);

      expect(newRelay.initialized).toBe(true);
      expect(newRelay.connected).toBe(true);

      const poolRelays = pool.getRelays();
      expect(poolRelays.find((r: any) => r.url === 'wss://new-relay.test')).toBeTruthy();
    });

    it('removeRelay disconnects and persists to config', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true},
        {url: 'wss://relay2.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      const relay2 = mockRelayInstances[1];
      pool.removeRelay('wss://relay2.test');

      expect(relay2.disconnected).toBe(true);
      expect(pool.getRelays().find((r: any) => r.url === 'wss://relay2.test')).toBeUndefined();
    });

    it('isConnected returns true when at least 1 relay is up', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true},
        {url: 'wss://relay2.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      mockRelayInstances[0].simulateDisconnect();

      expect(pool.isConnected()).toBe(true);
    });

    it('isConnected returns false when all relays are down', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true},
        {url: 'wss://relay2.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      mockRelayInstances[0].simulateDisconnect();
      mockRelayInstances[1].simulateDisconnect();

      expect(pool.isConnected()).toBe(false);
    });
  });

  describe('history backfill', () => {
    it('walks paged history on initialize when lastSeenTimestamp > 0', async() => {
      localStorage.setItem('phantomchat-last-seen-timestamp', '1700000000');

      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});

      // We need to spy before initialize creates the relay. Since
      // MockNostrRelay instances are tracked, we can spy after construction by
      // intercepting the prototype. The startup walk is PAGED now (truncation
      // has to be visible, or the watermark jumps over what it didn't fetch).
      const pagedSpy = vi.spyOn(MockNostrRelayClass.prototype, 'getMessagesPaged');

      await pool.initialize();

      // Backfill subtracts a small fuzz window (clock skew / out-of-order slack)
      // from lastSeen. Backdating was removed, so this is minutes, not 48h:
      // 5*60 = 300s → 1700000000 - 300 = 1699999700.
      expect(pagedSpy).toHaveBeenCalledWith(1700000000 - 5 * 60, undefined);
      pagedSpy.mockRestore();
    });

    it('walks ALL history on a cold profile with no watermark (#154)', async() => {
      // The fresh-device bug: the deep walk was gated on `lastSeenTimestamp > 0`,
      // so a brand-new profile on a months-old account never walked history at
      // all. The live REQ then set the watermark to TODAY and every replay path
      // floors at the watermark — the account's whole past became unreachable
      // while the client reported "caught up".
      expect(localStorage.getItem('phantomchat-last-seen-timestamp')).toBeNull();

      const pool = new NostrRelayPool({
        relays: [{url: 'wss://relay1.test', read: true, write: true}],
        onMessage: vi.fn()
      });
      const pagedSpy = vi.spyOn(MockNostrRelayClass.prototype, 'getMessagesPaged');

      await pool.initialize();

      // `since: undefined` = no lower bound = all history.
      expect(pagedSpy).toHaveBeenCalledWith(undefined, undefined);
      pagedSpy.mockRestore();
      pool.disconnect();
    });

    it('a truncated startup walk holds the watermark and persists the resume cursor', async() => {
      // Evidence before dispatch: the walk hit the page cap, so the newest
      // message it DID fetch must not advance the watermark over the tail it
      // didn't — and the cursor has to outlive the tab.
      const pagedSpy = vi.spyOn(MockNostrRelayClass.prototype, 'getMessagesPaged')
      .mockResolvedValue({
        messages: [makeMessage('cold-newest', 1700009000)],
        outcome: 'truncated',
        oldestReached: 1700005000
      });

      const pool = new NostrRelayPool({
        relays: [{url: 'wss://relay1.test', read: true, write: true}],
        onMessage: vi.fn()
      });
      await pool.initialize();
      await vi.advanceTimersByTimeAsync(0);

      expect(JSON.parse(localStorage.getItem('phantomchat-backfill-gap')!)).toEqual({
        cursor: 1700005000,
        open: true
      });
      // Watermark frozen: "caught up" is not true while wraps below the cursor
      // remain unfetched.
      expect(localStorage.getItem('phantomchat-last-seen-timestamp')).toBeNull();

      pagedSpy.mockRestore();
      pool.disconnect();
    });

    it('an exhausted walk clears the persisted gap', async() => {
      localStorage.setItem('phantomchat-backfill-gap', JSON.stringify({cursor: 1700005000, open: true}));

      const pagedSpy = vi.spyOn(MockNostrRelayClass.prototype, 'getMessagesPaged')
      .mockResolvedValue({messages: [], outcome: 'exhausted'});

      const pool = new NostrRelayPool({
        relays: [{url: 'wss://relay1.test', read: true, write: true}],
        onMessage: vi.fn()
      });
      await pool.initialize();
      await vi.advanceTimersByTimeAsync(0);

      expect(localStorage.getItem('phantomchat-backfill-gap')).toBeNull();
      pagedSpy.mockRestore();
      pool.disconnect();
    });

    it('a cold profile keeps walking ALL history until one walk reaches the bottom', async() => {
      // The startup walk can learn nothing — on a real cold boot it may run
      // before any socket finished connecting, and an unknown outcome is not
      // evidence of anything. The poll must not then fall back to its 90s
      // window: with no watermark, 90s of a months-old account IS the bug.
      const pagedSpy = vi.spyOn(MockNostrRelayClass.prototype, 'getMessagesPaged')
      .mockResolvedValue({messages: [], outcome: 'unknown'});

      const pool = new NostrRelayPool({
        relays: [{url: 'wss://relay1.test', read: true, write: true}],
        onMessage: vi.fn()
      });
      await pool.initialize();
      pool.subscribeMessages();

      pagedSpy.mockClear();
      await vi.advanceTimersByTimeAsync(15_000);

      expect(pagedSpy).toHaveBeenCalled();
      expect(pagedSpy.mock.calls[0]![0]).toBeUndefined();

      // One walk reaching the bottom retires it: the poll goes back to its
      // cheap rolling window.
      pagedSpy.mockResolvedValue({messages: [], outcome: 'exhausted'});
      await vi.advanceTimersByTimeAsync(15_000);
      pagedSpy.mockClear();
      await vi.advanceTimersByTimeAsync(15_000);
      const nowAtFire = Math.floor(Date.now() / 1000);
      expect(pagedSpy.mock.calls[0]![0] as number).toBeGreaterThanOrEqual(nowAtFire - 90 - 3);

      pagedSpy.mockRestore();
      pool.disconnect();
    });

    it('resumes an unfinished drain after a reload instead of coming back up "caught up"', async() => {
      // Close the tab mid-drain: the watermark persisted, the freeze and the
      // cursor did not, so the next boot looked caught up and the next live
      // message dragged the watermark past the undrained tail. Both halves of
      // the state must survive together.
      localStorage.setItem('phantomchat-last-seen-timestamp', '1700009000');
      localStorage.setItem('phantomchat-backfill-gap', JSON.stringify({cursor: 1700005000, open: true}));

      const pagedSpy = vi.spyOn(MockNostrRelayClass.prototype, 'getMessagesPaged')
      .mockResolvedValue({messages: [], outcome: 'truncated', oldestReached: 1700004000});

      const pool = new NostrRelayPool({
        relays: [{url: 'wss://relay1.test', read: true, write: true}],
        onMessage: vi.fn()
      });
      await pool.initialize();
      await vi.advanceTimersByTimeAsync(0);

      // Resumed from the persisted cursor (`until`), and the lower bound was
      // DROPPED: the watermark (1700009000) sits ABOVE the cursor, so asking
      // {since: watermark, until: cursor} would be an inverted range — the relay
      // answers short, the walk reads as 'exhausted', and the gap clears over
      // the very wraps it was protecting.
      expect(pagedSpy).toHaveBeenCalledWith(undefined, 1700005000);

      // Still frozen, cursor advanced downward: the tail drains across ticks.
      expect(JSON.parse(localStorage.getItem('phantomchat-backfill-gap')!)).toEqual({
        cursor: 1700004000,
        open: true
      });

      pagedSpy.mockRestore();
      pool.disconnect();
    });

    it('catch-up poll re-queries connected read relays with a tight since', async() => {
      vi.useFakeTimers();
      try {
        const onMessage = vi.fn();
        const relays = [
          {url: 'wss://relay1.test', read: true, write: true}
        ];
        const pool = new NostrRelayPool({relays, onMessage});
        await pool.initialize();

        // The poll only runs once subscribed and only against CONNECTED read
        // relays — mirror that state.
        pool.subscribeMessages();
        const inst = mockRelayInstances[mockRelayInstances.length - 1];
        inst.connectionState = 'connected';
        // The poll goes through the PAGED walk now, not the single-shot query.
        const spy = vi.spyOn(inst, 'getMessagesPaged').mockResolvedValue({messages: [], outcome: 'exhausted'});

        // Advance past one poll interval (BACKFILL_POLL_INTERVAL_MS = 15s).
        // Fake timers move Date.now() forward too, so measure "now" at the
        // moment the poll fires, not before.
        await vi.advanceTimersByTimeAsync(15_000);
        const nowAtFire = Math.floor(Date.now() / 1000);

        expect(spy).toHaveBeenCalled();
        const calledSince = spy.mock.calls[0]![0] as number;
        // RECENT_BACKFILL_WINDOW_SEC = 90; allow a couple seconds of slack.
        expect(calledSince).toBeGreaterThanOrEqual(nowAtFire - 90 - 3);
        expect(calledSince).toBeLessThanOrEqual(nowAtFire - 90 + 3);
        spy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });

    it('updates lastSeenTimestamp as messages arrive', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();
      pool.subscribeMessages();

      const timestamp = 1700001000;
      mockRelayInstances[0].simulateMessage(makeMessage('msg-ts-1', timestamp));

      // The watermark now advances only after the (awaited) handler completes
      // — flush microtasks so the delivery continuation runs.
      for(let i = 0; i < 5; i++) await Promise.resolve();
      const stored = localStorage.getItem('phantomchat-last-seen-timestamp');
      expect(stored).toBe(String(timestamp));
    });

    it('advances lastSeenTimestamp only after the onMessage handler completes', async() => {
      // Durability contract: the watermark is the claim "everything at or
      // below this has been delivered". It may only be persisted once the
      // handler (which awaits the IndexedDB put) has finished — otherwise a
      // PWA close in the delivery window loses the row while every replay
      // path has already moved past it (the vanishing-reply bug).
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => { openGate = resolve; });
      const onMessage = vi.fn(() => gate);
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();
      pool.subscribeMessages();

      const timestamp = 1700002000;
      mockRelayInstances[0].simulateMessage(makeMessage('msg-ts-gated', timestamp));

      // Delivered to the handler (synchronously), but the handler is still
      // in flight — the watermark must NOT be claimed yet.
      expect(onMessage).toHaveBeenCalledTimes(1);
      for(let i = 0; i < 5; i++) await Promise.resolve();
      expect(localStorage.getItem('phantomchat-last-seen-timestamp')).toBeNull();

      // Handler completes → the watermark may now advance.
      openGate();
      for(let i = 0; i < 5; i++) await Promise.resolve();
      expect(localStorage.getItem('phantomchat-last-seen-timestamp')).toBe(String(timestamp));
    });

    it('serializes live deliveries so out-of-order completion cannot advance the watermark past an in-flight save', async() => {
      // Regression (Kai, PR #112): the live socket callback used to launch
      // handleIncomingMessage fire-and-forget. An older message (t=100)
      // awaiting its IndexedDB save could be overtaken by a newer one
      // (t=101) completing first, persisting lastSeen=101; a tab close
      // before t=100 finished then replayed with since=101 and skipped the
      // older message forever — the same loss window this PR closed for
      // backfill. Live deliveries must be serialized: t=101's handler may
      // not even START until t=100's has fully completed.
      let openOldGate!: () => void;
      const oldGate = new Promise<void>((resolve) => { openOldGate = resolve; });
      const order: string[] = [];
      const onMessage = vi.fn((msg: any) => {
        order.push(`start-${msg.id}`);
        if(msg.id === 'msg-old') {
          return oldGate.then(() => { order.push('end-msg-old'); });
        }
        order.push(`end-${msg.id}`);
        return Promise.resolve();
      });
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();
      pool.subscribeMessages();

      const tOld = 1700003000;
      const tNew = 1700003001;
      mockRelayInstances[0].simulateMessage(makeMessage('msg-old', tOld));
      mockRelayInstances[0].simulateMessage(makeMessage('msg-new', tNew));

      // The old message is in flight; the newer one must be QUEUED BEHIND
      // it — not delivered, and certainly not completing.
      for(let i = 0; i < 10; i++) await Promise.resolve();
      expect(order).toEqual(['start-msg-old']);
      expect(localStorage.getItem('phantomchat-last-seen-timestamp')).toBeNull();

      // Old message's save finishes → only now may the newer one deliver,
      // and the watermark lands on the newest timestamp with BOTH rows
      // already durable.
      openOldGate();
      for(let i = 0; i < 10; i++) await Promise.resolve();
      expect(order).toEqual(['start-msg-old', 'end-msg-old', 'start-msg-new', 'end-msg-new']);
      expect(localStorage.getItem('phantomchat-last-seen-timestamp')).toBe(String(tNew));
    });
  });

  describe('default relays (Phase 3)', () => {
    it('DEFAULT_RELAYS has 7 entries', () => {
      expect(DEFAULT_RELAYS).toHaveLength(7);
    });

    // Pinning one relay by name made this test a tripwire on every list change
    // without asserting anything that matters. What matters is that the entries
    // are distinct hosts: nostr.mom and nos.lol resolved to the SAME machine and
    // the same operator pubkey, so carrying both bought zero redundancy while
    // looking like two relays.
    it('DEFAULT_RELAYS entries are unique wss:// hosts', () => {
      const urls = DEFAULT_RELAYS.map((r: any) => r.url);
      for(const url of urls) expect(url.startsWith('wss://')).toBe(true);
      expect(new Set(urls).size).toBe(urls.length);
    });
  });

  describe('enable/disable (Phase 3)', () => {
    it('disableRelay causes publish to skip that relay', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true},
        {url: 'wss://relay2.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      pool.disableRelay('wss://relay2.test');

      const spy1 = vi.spyOn(mockRelayInstances[0], 'storeMessage');
      const spy2 = vi.spyOn(mockRelayInstances[1], 'storeMessage');

      await pool.publish('recipient', 'hello');

      expect(spy1).toHaveBeenCalled();
      expect(spy2).not.toHaveBeenCalled();
    });

    it('enableRelay re-enables publishing after disable', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true},
        {url: 'wss://relay2.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      pool.disableRelay('wss://relay2.test');
      pool.enableRelay('wss://relay2.test');

      const spy2 = vi.spyOn(mockRelayInstances[1], 'storeMessage');

      await pool.publish('recipient', 'hello');

      expect(spy2).toHaveBeenCalled();
    });
  });

  describe('getRelayStates (Phase 3)', () => {
    it('returns all relays with connected, latencyMs, read, write, enabled', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true},
        {url: 'wss://relay2.test', read: true, write: false}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      pool.disableRelay('wss://relay2.test');

      const states = pool.getRelayStates();

      expect(states).toHaveLength(2);
      expect(states[0]).toEqual(expect.objectContaining({
        url: 'wss://relay1.test',
        connected: true,
        read: true,
        write: true,
        enabled: true
      }));
      expect(states[1]).toEqual(expect.objectContaining({
        url: 'wss://relay2.test',
        connected: true,
        read: true,
        write: false,
        enabled: false
      }));
      // latencyMs should be a number
      expect(typeof states[0].latencyMs).toBe('number');
    });
  });

  describe('publishNip65 (Phase 3)', () => {
    it('publishes NIP-65 event to write-enabled relays only', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true},
        {url: 'wss://relay2.test', read: true, write: false}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      const spy1 = vi.spyOn(mockRelayInstances[0], 'sendRawEvent');
      const spy2 = vi.spyOn(mockRelayInstances[1], 'sendRawEvent');

      const privateKey = new Uint8Array(32);
      pool.publishNip65(privateKey);

      // sendRawEvent should be called on write relay, not on read-only relay
      expect(spy1).toHaveBeenCalledTimes(1);
      expect(spy2).not.toHaveBeenCalled();
    });
  });

  describe('resume-trigger listener cleanup (#81)', () => {
    it('disconnect removes visibilitychange listener', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      const spy = vi.spyOn(pool, 'resetWrapRetryBudget');

      pool.disconnect();

      document.dispatchEvent(new Event('visibilitychange'));
      expect(spy).not.toHaveBeenCalled();
    });

    it('disconnect removes online listener', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      const spy = vi.spyOn(pool, 'resetWrapRetryBudget');

      pool.disconnect();

      window.dispatchEvent(new Event('online'));
      expect(spy).not.toHaveBeenCalled();
    });

    it('listeners fire before disconnect', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      const spy = vi.spyOn(pool, 'resetWrapRetryBudget');

      window.dispatchEvent(new Event('online'));
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('re-initialize after disconnect re-registers listeners', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();
      pool.disconnect();

      await pool.initialize();

      const spy = vi.spyOn(pool, 'resetWrapRetryBudget');
      window.dispatchEvent(new Event('online'));
      expect(spy).toHaveBeenCalledTimes(1);

      spy.mockClear();
      pool.disconnect();
      window.dispatchEvent(new Event('online'));
      expect(spy).not.toHaveBeenCalled();
    });

    it('double disconnect is a no-op (no throw)', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      pool.disconnect();
      expect(() => pool.disconnect()).not.toThrow();
    });

    it('disconnect before initialize is safe', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});

      expect(() => pool.disconnect()).not.toThrow();
    });
  });

  describe('visible transition must not burst a backfill (wake black-screen regression)', () => {
    it('never fires a paged backfill on visible, however stale the last catch-up', async() => {
      const onMessage = vi.fn();
      const pool = new NostrRelayPool({
        relays: [{url: 'wss://relay1.test', read: true, write: true}],
        onMessage
      });
      await pool.initialize();
      pool.subscribeMessages();
      await vi.advanceTimersByTimeAsync(0);

      const relay = mockRelayInstances.filter((r: any) => r.connected)[0];
      const pagedSpy = vi.spyOn(relay, 'getMessagesPaged');

      // Fresh poll: no backfill on visible.
      (pool as any).lastCatchUpAt = Date.now();
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      expect(pagedSpy).not.toHaveBeenCalled();

      // An hour of dormancy: STILL no backfill on visible. The gap is covered
      // incrementally — reconnecting relays re-arm the live REQ with a `since`
      // watermark and fire the throttled per-relay reconnect backfill, and the
      // 15s poll resumes on its own. A global paged burst on the visible
      // transition is what saturated the main thread and black-screened the
      // PWA on wake; it must not come back.
      (pool as any).lastCatchUpAt = Date.now() - 3_600_000;
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      expect(pagedSpy).not.toHaveBeenCalled();

      pool.disconnect();
    });

    it('still runs the cheap resume work on visible: un-park wraps, clear cooldowns', async() => {
      const onMessage = vi.fn();
      const pool = new NostrRelayPool({
        relays: [{url: 'wss://relay1.test', read: true, write: true}],
        onMessage
      });
      await pool.initialize();
      pool.subscribeMessages();
      await vi.advanceTimersByTimeAsync(0);

      const relay = mockRelayInstances.filter((r: any) => r.connected)[0];
      const claim = relay.claimEvent!;
      const release = relay.releaseEvent!;

      // Park a wrap by burning its retry budget (frozen-worker burst).
      for(let i = 0; i < 3; i++) {
        claim('wrap-parked-on-wake');
        release('wrap-parked-on-wake');
      }
      expect(claim('wrap-parked-on-wake')).toBe(false); // parked

      // Visible must still un-park it — only the backfill burst was removed.
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      expect(claim('wrap-parked-on-wake')).toBe(true);

      pool.disconnect();
    });
  });

  describe('Palm-Pilot hard reset on resume (zombie self-heal)', () => {
    const ADV = 0;

    it('tears down every socket and dials fresh on visible — zombie sockets cannot survive', async() => {
      const relays = [
        {url: 'wss://r1.test', read: true, write: true},
        {url: 'wss://r2.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage: vi.fn()});
      await pool.initialize();
      expect(pool.getConnectedCount()).toBe(2);

      // The phone-lock wedge: the OS killed the sockets while the page was
      // hidden, no close event was ever delivered, so both instances still
      // claim 'connected'. superviseConnections trusts that state — only a
      // teardown+redial can heal it.
      const disconnectSpies = mockRelayInstances.map((r: any) => vi.spyOn(r, 'disconnect'));
      const connectSpies = mockRelayInstances.map((r: any) => vi.spyOn(r, 'connect'));

      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(ADV);

      for(const spy of disconnectSpies) expect(spy).toHaveBeenCalledTimes(1);
      for(const spy of connectSpies) expect(spy).toHaveBeenCalled();
      expect(pool.getConnectedCount()).toBe(2);

      pool.disconnect();
    });

    it('a benched (cooling-down) relay rejoins through the reset', async() => {
      // Enough relays to stay above the MIN_WRITE_RELAYS liveness floor when
      // one is benched (the floor force-revives below 3, which would mask the
      // bench — same reason the original flap test used the full 7).
      const relays = [1, 2, 3, 4, 5].map((i) => ({url: `wss://r${i}.test`, read: true, write: true}));
      const pool = new NostrRelayPool({relays, onMessage: vi.fn()});
      await pool.initialize();

      // Bench r1 with quick connect→drop flaps, like the existing flap test.
      const first = mockRelayInstances[0];
      for(let i = 0; i < 3; i++) {
        first.connectionState = 'connected';
        first.onStateChange?.();
        first.connectionState = 'reconnecting';
        first.onStateChange?.();
      }
      await vi.advanceTimersByTimeAsync(ADV);
      expect(pool.getConnectedCount()).toBe(4); // r1 benched

      // Resume: the reset clears benches/cooldowns and redials the full set.
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(ADV);
      expect(pool.getConnectedCount()).toBe(5);

      pool.disconnect();
    });

    it('reset redials do not burst per-relay backfills (wake black-screen guard)', async() => {
      const relays = [
        {url: 'wss://r1.test', read: true, write: true},
        {url: 'wss://r2.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage: vi.fn()});
      await pool.initialize();
      pool.subscribeMessages();
      await vi.advanceTimersByTimeAsync(ADV);

      // Populate relayHasConnected so every 'connected' fired AFTER the reset
      // counts as a reconnect (first connects never backfill — the reset redial
      // must not sneak through that door either).
      for(const relay of mockRelayInstances) {
        relay.connectionState = 'connected';
        relay.onStateChange?.();
      }
      await vi.advanceTimersByTimeAsync(ADV);

      const pagedSpies = mockRelayInstances.map((r: any) => vi.spyOn(r, 'getMessagesPaged'));

      // Stale catch-up: an hour of dormancy — exactly when a burst would hurt.
      (pool as any).lastCatchUpAt = Date.now() - 3_600_000;

      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(ADV);

      // The reset redials complete; the real instances would fire their
      // onStateChange('connected') here — drive it manually (the mock's
      // connect() does not).
      for(const relay of mockRelayInstances) {
        relay.connectionState = 'connected';
        relay.onStateChange?.();
      }
      await vi.advanceTimersByTimeAsync(ADV);

      // Suppression window: no per-relay reconnect backfill from reset redials.
      for(const spy of pagedSpies) expect(spy).not.toHaveBeenCalled();

      // After the window, a genuine reconnect blip backfills again — the
      // suppression must not become a permanent hole.
      await vi.advanceTimersByTimeAsync(11_000);
      const relay = mockRelayInstances[0];
      relay.connectionState = 'reconnecting';
      relay.onStateChange?.();
      relay.connectionState = 'connected';
      relay.onStateChange?.();
      await vi.advanceTimersByTimeAsync(ADV);
      expect(pagedSpies[0]).toHaveBeenCalled();

      pool.disconnect();
    });

    it('is a no-op while idle-gated — resumeFromIdle owns that transition', async() => {
      const relays = [
        {url: 'wss://r1.test', read: true, write: true},
        {url: 'wss://r2.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage: vi.fn(), idleTransport: true});
      await pool.initialize();
      expect(pool.getTransportMode()).toBe('active');

      // Hidden past the grace: idle mode, every socket closed.
      (pool as any).idleController.onBackground();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(pool.getTransportMode()).toBe('idle');
      expect(pool.getConnectedCount()).toBe(0);

      const connectSpies = mockRelayInstances.map((r: any) => vi.spyOn(r, 'connect'));

      // A hard reset while gated must not open anything NOR announce a resume
      // (the idle resume owns that transition — a "Syncing" banner while the
      // page is still backgrounded would be a lie).
      (pool as any).hardResetSockets('test');
      await vi.advanceTimersByTimeAsync(ADV);
      for(const spy of connectSpies) expect(spy).not.toHaveBeenCalled();
      expect(rootScope.dispatchEvent).not.toHaveBeenCalledWith('phantomchat_resume_sync', {active: true});

      // Foreground: the idle controller resumes and dials fresh.
      (pool as any).idleController.onForeground();
      await vi.advanceTimersByTimeAsync(ADV);
      expect(pool.getTransportMode()).toBe('active');
      expect(pool.getConnectedCount()).toBe(2);

      // Race guard: a hard reset for the SAME transition (both listeners fire
      // on one visibilitychange) must not kill the sockets resumeFromIdle just
      // opened.
      const disconnectSpies = mockRelayInstances.map((r: any) => vi.spyOn(r, 'disconnect'));
      (pool as any).hardResetSockets('test');
      await vi.advanceTimersByTimeAsync(ADV);
      for(const spy of disconnectSpies) expect(spy).not.toHaveBeenCalled();
      expect(pool.getConnectedCount()).toBe(2);

      pool.disconnect();
    });

    it('announces the resume so the banner can say Syncing...', async() => {
      const pool = new NostrRelayPool({
        relays: [{url: 'wss://r1.test', read: true, write: true}],
        onMessage: vi.fn()
      });
      await pool.initialize();

      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(ADV);

      expect(rootScope.dispatchEvent).toHaveBeenCalledWith('phantomchat_resume_sync', {active: true});

      pool.disconnect();
    });
  });

});
