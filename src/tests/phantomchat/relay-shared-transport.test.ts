/**
 * Shared relay transport (#257).
 *
 * Field symptom (Atlas diag log, 2026-10-22): ~4-5 separate NostrRelay
 * instances dialled the SAME failing relay URL in one window, each with its
 * own reconnect counter and cooldown ladder (`attempt: 7 cooldown: true`
 * interleaved with `attempt: 4` / `attempt: 5` within 20s). Cause: the bridge
 * and ChatAPI each constructed a NostrRelayPool over the full relay list (and
 * re-creation multiplied them), so benching a relay in one pool did not bench
 * it in the others and the backoff never held.
 *
 * Acceptance (#257): "two consumers asking for the same URL in one context
 * share one socket and one counter."
 */
import 'fake-indexeddb/auto';
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import '../setup';
import {
  acquireSharedRelayPool,
  getSharedRelayPool,
  resetSharedRelayPool
} from '@lib/phantomchat/nostr-relay-pool';
import type {DecryptedMessage} from '@lib/phantomchat/nostr-relay';

// App-event bus: the pool's debounced state notify dispatches through
// rootScope, whose MTProto port does not exist in tests.
vi.mock('@lib/rootScope', () => ({
  default: {
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn()
  }
}));

// Identity store: NostrRelay.initialize() decrypts the stored identity per
// relay — mocked so real relay instances can complete startup in tests.
vi.mock('@lib/phantomchat/key-storage', () => ({
  loadEncryptedIdentity: vi.fn(async() => ({iv: 'iv', encryptedKeys: 'ek'})),
  loadBrowserKey: vi.fn(async() => 'browser-key'),
  decryptKeys: vi.fn(async() => ({seed: 'seed', nsec: 'nsec'}))
}));
vi.mock('@lib/phantomchat/nostr-identity', () => ({
  importFromStored: vi.fn(() => ({
    npub: 'npub-test',
    publicKey: 'test-public-key',
    privateKey: 'a'.repeat(64)
  }))
}));

// Minimal WebSocket mock: counts every dial, opens itself like the real thing.
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static created: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  sent: string[] = [];

  constructor(public url: string) {
    MockWebSocket.created.push(this);
    setTimeout(() => {
      if(this.readyState === MockWebSocket.CONNECTING) {
        this.readyState = MockWebSocket.OPEN;
        this.onopen?.(new Event('open'));
      }
    }, 5);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }

  simulateError(): void {
    this.onerror?.(new Event('error'));
  }
}

const RELAYS = [
  {url: 'wss://shared-a.test', read: true, write: true},
  {url: 'wss://shared-b.test', read: true, write: true}
];

describe('shared relay transport (#257)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.created = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    resetSharedRelayPool();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('two consumers share one pool — ONE socket per relay URL, not one per consumer', async() => {
    // Consumer 1 (e.g. the bridge) creates the transport…
    const c1 = acquireSharedRelayPool({
      relays: RELAYS,
      preloadedIdentity: {publicKey: 'test-public-key', privateKeyHex: 'short'}
    });
    // …consumer 2 (e.g. ChatAPI) asks for the same URLs later.
    const c2 = acquireSharedRelayPool({relays: RELAYS});

    expect(c2.pool).toBe(c1.pool);
    expect(getSharedRelayPool()).toBe(c1.pool);

    await c1.pool.initialize();
    await c2.pool.initialize(); // "ensure up" from the second consumer
    await vi.advanceTimersByTimeAsync(1_000); // cover the dial stagger (350ms/relay)

    // ONE socket per URL across both consumers (2 relays => 2 dials, not 4).
    expect(MockWebSocket.created.length).toBe(2);
    const urls = MockWebSocket.created.map((ws) => ws.url).sort();
    expect(urls).toEqual(['wss://shared-a.test', 'wss://shared-b.test']);

    // …and ONE relay entry (one NostrRelay = one backoff counter) per URL.
    const entries = (c1.pool as any).relayEntries;
    expect(entries.length).toBe(2);
    expect((c2.pool as any).relayEntries).toBe(entries);
  });

  it('initialize() is single-flight — a second consumer never re-runs startup', async() => {
    const c1 = acquireSharedRelayPool({
      relays: RELAYS,
      preloadedIdentity: {publicKey: 'test-public-key', privateKeyHex: 'short'}
    });
    const c2 = acquireSharedRelayPool({relays: RELAYS});

    const spy = vi.spyOn(c1.pool as any, 'runInitialize');
    await c1.pool.initialize();
    await c2.pool.initialize();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.created.length).toBe(2); // no re-dial wave
  });

  it('shares ONE reconnect counter per URL — consumers cannot hold separate ladders', async() => {
    const c1 = acquireSharedRelayPool({
      relays: [RELAYS[0]],
      preloadedIdentity: {publicKey: 'test-public-key', privateKeyHex: 'short'}
    });
    const c2 = acquireSharedRelayPool({relays: [RELAYS[0]]});
    await c1.pool.initialize();
    await vi.advanceTimersByTimeAsync(500);

    const instance = (c1.pool as any).relayEntries[0].instance;
    // Both consumers observe the SAME counter object.
    expect((c2.pool as any).relayEntries[0].instance).toBe(instance);
    expect(instance.reconnectAttempts).toBe(0);

    // One failed dial advances the ladder exactly ONCE, visible to both.
    MockWebSocket.created[0].simulateError();
    MockWebSocket.created[0].close();
    await vi.advanceTimersByTimeAsync(10);

    expect(instance.reconnectAttempts).toBe(1);
    expect((c2.pool as any).relayEntries[0].instance.reconnectAttempts).toBe(1);
  });

  it('fans each message out to every consumer over the shared socket', async() => {
    const primary = vi.fn();
    const c1 = acquireSharedRelayPool({relays: []});
    c1.pool.setOnMessage(primary);
    const seen1: DecryptedMessage[] = [];
    const seen2: DecryptedMessage[] = [];
    const listener1 = (m: DecryptedMessage) => { seen1.push(m); };
    const listener2 = (m: DecryptedMessage) => { seen2.push(m); };
    c1.pool.addOnMessageListener(listener1);
    c1.pool.addOnMessageListener(listener2);

    const textMsg: DecryptedMessage = {
      id: 'text-1',
      from: 'peer-pubkey-hex',
      content: JSON.stringify({id: 'm1', type: 'text', content: 'hi', timestamp: Date.now()}),
      timestamp: Math.floor(Date.now() / 1000)
    };
    await (c1.pool as any).handleIncomingMessage(textMsg);

    expect(primary).toHaveBeenCalledTimes(1);
    expect(seen1).toEqual([textMsg]);
    expect(seen2).toEqual([textMsg]);

    // A detached consumer stops receiving (the pool outlives its consumers).
    c1.pool.removeOnMessageListener(listener2);
    await (c1.pool as any).handleIncomingMessage({...textMsg, id: 'text-2'});
    expect(seen1).toHaveLength(2);
    expect(seen2).toHaveLength(1);
  });

  it('defers startup history until a consumer attaches — boot-order regression (#261 review P1)', async() => {
    // REAL boot order: the bridge acquires + initializes the pool (backfill
    // starts, NO consumer yet); ChatAPI is constructed only after further
    // onboarding/UI awaits. Early relay history must survive that window.
    const bridge = acquireSharedRelayPool({
      relays: [],
      preloadedIdentity: {publicKey: 'test-public-key', privateKeyHex: 'short'}
    });
    const mk = (id: string): DecryptedMessage => ({
      id,
      from: 'peer-pubkey-hex',
      content: JSON.stringify({id, type: 'text', content: 'early ' + id, timestamp: Date.now()}),
      timestamp: Math.floor(Date.now() / 1000)
    });
    const early1 = mk('early-1');
    const early2 = mk('early-2');
    await (bridge.pool as any).handleIncomingMessage(early1);
    await (bridge.pool as any).handleIncomingMessage(early2);

    // Held, not consumed: nothing durable may claim an undelivered message —
    // the watermark is the "everything at or below is delivered" claim.
    expect((bridge.pool as any).lastSeenTimestamp).toBe(0);

    // ChatAPI attaches its listener (its constructor wires the shared pool).
    const seen: DecryptedMessage[] = [];
    bridge.pool.addOnMessageListener((m: DecryptedMessage) => { seen.push(m); });
    await vi.advanceTimersByTimeAsync(10);

    // The held history drained to the consumer, in order, exactly once each.
    expect(seen.map((m) => m.id)).toEqual(['early-1', 'early-2']);
    expect((bridge.pool as any).lastSeenTimestamp).toBeGreaterThan(0);

    // A relay replay of the same wraps is deduped — not double-delivered, and
    // not lost: the original regression delivered ZERO here (burned at boot).
    await (bridge.pool as any).handleIncomingMessage(early1);
    expect(seen).toHaveLength(2);
    expect(seen.filter((m) => m.id === 'early-1')).toHaveLength(1);
  });

  it('wake-on-send: a send on an IDLE shared pool wakes it to ACTIVE (publishRawEvent + publishNip65)', async() => {
    const c = acquireSharedRelayPool({
      relays: [RELAYS[0]],
      preloadedIdentity: {publicKey: 'test-public-key', privateKeyHex: 'short'}
    });
    await c.pool.initialize();
    await vi.advanceTimersByTimeAsync(1_000); // cover the dial stagger

    // Page Lifecycle freeze path: hard-suspend to tick mode (zero sockets).
    const idleCtl = () => (c.pool as any).idleController;
    idleCtl().onFreeze();
    await vi.advanceTimersByTimeAsync(10);
    expect(c.pool.getTransportMode()).toBe('idle');

    // A send is activity: the publish must wake the transport to ACTIVE even
    // though no socket was up when it fired (the relay-level pendingPublishes
    // buffer holds the event and flushes on open). The publish RESULT is
    // irrelevant to this contract — wake-on-send is.
    await (c.pool as any).publishRawEvent({id: 'ev1', kind: 7, content: '+', tags: [], created_at: 1, pubkey: 'peer', sig: 'sig'});
    await vi.advanceTimersByTimeAsync(10);
    expect(c.pool.getTransportMode()).toBe('active');

    // Same contract on the NIP-65 advert path (_publishNip65Now).
    idleCtl().onFreeze();
    await vi.advanceTimersByTimeAsync(10);
    expect(c.pool.getTransportMode()).toBe('idle');
    (c.pool as any).publishNip65(new Uint8Array(32).fill(2));
    await vi.advanceTimersByTimeAsync(10);
    expect(c.pool.getTransportMode()).toBe('active');
  });

  it('fan-out is consumer-isolated: one throwing handler cannot starve the rest (#257 review nit)', async() => {
    const c = acquireSharedRelayPool({relays: []});
    c.pool.setOnMessage(() => { throw new Error('boom'); });
    const seen: DecryptedMessage[] = [];
    c.pool.addOnMessageListener(() => { throw new Error('boom'); });
    c.pool.addOnMessageListener((m: DecryptedMessage) => { seen.push(m); });

    const msg: DecryptedMessage = {
      id: 'iso-1',
      from: 'peer-pubkey-hex',
      content: JSON.stringify({id: 'm-iso', type: 'text', content: 'hi', timestamp: Date.now()}),
      timestamp: Math.floor(Date.now() / 1000)
    };
    await (c.pool as any).handleIncomingMessage(msg);

    // The throwing primary and throwing first listener are logged, not obeyed:
    // the healthy consumer still receives exactly one copy (previously the
    // first throw skipped every consumer after it).
    expect(seen).toEqual([msg]);
  });

  it('disconnects only when the LAST consumer releases', async() => {
    const a = acquireSharedRelayPool({
      relays: RELAYS,
      preloadedIdentity: {publicKey: 'test-public-key', privateKeyHex: 'short'}
    });
    const b = acquireSharedRelayPool({relays: RELAYS});
    await a.pool.initialize();
    const disconnectSpy = vi.spyOn(a.pool, 'disconnect');

    // Double release is idempotent — cannot drop the refcount twice.
    a.release();
    a.release();
    expect(getSharedRelayPool()).toBe(a.pool);
    expect(disconnectSpy).not.toHaveBeenCalled();

    b.release();
    expect(getSharedRelayPool()).toBeNull();
    expect(disconnectSpy).toHaveBeenCalledTimes(1);

    // A fresh JS-context equivalent: the next acquire gets a NEW transport.
    const c = acquireSharedRelayPool({relays: RELAYS});
    expect(c.pool).not.toBe(a.pool);
    c.release();
    expect(getSharedRelayPool()).toBeNull();
  });

  // ─── Identity lifecycle (#262) ───────────────────────────────────────────

  it('a preloaded identity at acquire wins over the encrypted store', async() => {
    // REAL timers: startup with a loaded key reaches the message store via
    // warmV2KeyCache, whose async settles fake timers freeze.
    vi.useRealTimers();
    // The store mock resolves to publicKey 'test-public-key'; the preloaded
    // key must win — the shared pool takes its identity from the FIRST
    // acquirer (the bridge, in the real boot order).
    const c = acquireSharedRelayPool({
      relays: RELAYS,
      preloadedIdentity: {publicKey: '11'.repeat(32), privateKeyHex: 'a'.repeat(64)}
    });
    await c.pool.initialize();

    expect((c.pool as any).publicKey).toBe('11'.repeat(32));
    expect(c.pool.getPrivateKey()).not.toBeNull();
  });

  it('reloadIdentity replaces the keys AND pushes them into every relay instance', async() => {
    vi.useRealTimers();
    const c = acquireSharedRelayPool({
      relays: RELAYS,
      preloadedIdentity: {publicKey: 'test-public-key', privateKeyHex: 'a'.repeat(64)}
    });
    await c.pool.initialize();

    await c.pool.reloadIdentity({publicKey: 'cd'.repeat(32), privateKeyHex: 'b'.repeat(64)});

    expect((c.pool as any).publicKey).toBe('cd'.repeat(32));
    // Every live relay instance got the new account's keys — signing, AUTH,
    // unwrap and the '#p' filters all read the instance's own copy.
    const entries = (c.pool as any).relayEntries as any[];
    expect(entries.length).toBe(2);
    for(const entry of entries) {
      expect(entry.instance.getPublicKey()).toBe('cd'.repeat(32));
    }
  });
});
