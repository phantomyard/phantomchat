/**
 * Identity reload regressions (#262 follow-ups) — REAL NostrRelay instances.
 *
 * The #262 lifecycle tests in nostr-relay-pool.test.ts run against a mocked
 * relay class and missed both defects found in review:
 *
 *  1. setIdentity() left the armed live REQ filtering on the OLD '#p' — the
 *     transport kept streaming the previous account's wraps until a socket
 *     recycle (review P1).
 *  2. reloadIdentity() mutated pool state BEFORE loading the replacement, so
 *     a failed/empty load left the pool cleared while every relay instance
 *     kept the OLD keys — split state, old account still operable (review P2).
 *
 * These tests drive the real NostrRelay (fake WebSocket) through the real
 * NostrRelayPool fan-out, so both defects stay fixed.
 */

import '../setup';

// ─── Fake WebSocket (real relay instances need a socket to arm REQs on) ───

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sentMessages: string[] = [];
  url: string;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      if(this.readyState === MockWebSocket.CONNECTING) {
        this.readyState = MockWebSocket.OPEN;
        this.onopen?.(new Event('open'));
      }
    }, 5);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }
}

(globalThis as any).WebSocket = MockWebSocket;

// ─── Controllable key-storage (the reload source of truth) ───────────────

const {keyStore} = vi.hoisted(() => ({keyStore: {
  record: null as unknown,
  browserKey: null as unknown,
  decryptError: null as Error | null
}}));

vi.mock('@lib/phantomchat/key-storage', () => ({
  loadEncryptedIdentity: vi.fn(async(): Promise<unknown> => keyStore.record),
  loadBrowserKey: vi.fn(async(): Promise<unknown> => keyStore.browserKey),
  decryptKeys: vi.fn(async(): Promise<{seed: string, nsec: string}> => {
    if(keyStore.decryptError) throw keyStore.decryptError;
    return {seed: 'seed', nsec: 'nsec'};
  }),
  saveEncryptedIdentity: vi.fn(async(): Promise<void> => undefined),
  saveBrowserKey: vi.fn(async(): Promise<void> => undefined)
}));

vi.mock('@lib/rootScope', () => ({default: {dispatchEvent: vi.fn()}}));
vi.mock('@lib/phantomchat/nip65', () => ({
  buildNip65Event: vi.fn().mockReturnValue({kind: 10002, tags: [], content: '', id: 'mock-id', sig: 'mock-sig'})
}));

// ─── Helpers ─────────────────────────────────────────────────────────────

import {NostrRelay} from '@lib/phantomchat/nostr-relay';
import {NostrRelayPool} from '@lib/phantomchat/nostr-relay-pool';
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {bytesToHex} from 'nostr-tools/utils';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function keypair(): {pub: string, privHex: string} {
  const priv = generateSecretKey();
  return {pub: getPublicKey(priv), privHex: bytesToHex(priv)};
}

/** Frames a real relay instance sent, parsed. */
function frames(relay: NostrRelay): Array<{type: string, subId?: string, filter?: any}> {
  const ws = MockWebSocket.instances.find((w) => w.url === (relay as any).relayUrl)!;
  return ws.sentMessages.map((m) => {
    const arr = JSON.parse(m);
    return {type: arr[0], subId: arr[1], filter: arr[2]};
  });
}

function reqFilters(relay: NostrRelay): any[] {
  return frames(relay).filter((f) => f.type === 'REQ').map((f) => f.filter);
}

/** A real, connected relay with its live REQ armed on `pub`. */
async function armedRelay(url: string, pub: string, privHex: string): Promise<NostrRelay> {
  const relay = new NostrRelay(url);
  relay.setIdentity({publicKey: pub, privateKey: new Uint8Array(32).fill(7)});
  relay.connect();
  await sleep(15);
  relay.subscribeMessages();
  // sanity: the armed REQ filters on pub
  expect(reqFilters(relay).some((f) => f['#p']?.[0] === pub)).toBe(true);
  // give the instance the real key bytes under test
  (relay as any).privateKey = Uint8Array.from(Buffer.from(privHex, 'hex'));
  return relay;
}

function poolWithRelays(relays: NostrRelay[]): NostrRelayPool {
  const pool = new NostrRelayPool({relays: []} as any);
  (pool as any).relayEntries = relays.map((instance, i) => ({
    config: {url: (instance as any).relayUrl, read: true, write: true},
    instance
  }));
  return pool;
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('identity reload — real relay instances (#262 review fixes)', () => {
  beforeEach(() => {
    MockWebSocket.instances.length = 0;
    keyStore.record = null;
    keyStore.browserKey = null;
    keyStore.decryptError = null;
  });

  it('setIdentity re-arms the live REQ on the NEW #p (P1)', async() => {
    const oldK = keypair();
    const newK = keypair();
    const relay = await armedRelay('wss://p1.test', oldK.pub, oldK.privHex);
    const pool = poolWithRelays([relay]);

    await pool.reloadIdentity({publicKey: newK.pub, privateKeyHex: newK.privHex});

    const all = frames(relay);
    const closeIdx = all.map((f) => f.type).indexOf('CLOSE');
    const reqs = reqFilters(relay);
    // The stale old-#p REQ is dropped (CLOSE) and the newest armed REQ
    // filters on the NEW pubkey.
    expect(closeIdx).toBeGreaterThanOrEqual(0);
    expect(reqs[reqs.length - 1]['#p']?.[0]).toBe(newK.pub);
    expect((relay as any).getPublicKey()).toBe(newK.pub);
  });

  it('empty reload clears pool AND every relay instance, then throws (P2)', async() => {
    const oldK = keypair();
    const relayA = await armedRelay('wss://p2-a.test', oldK.pub, oldK.privHex);
    const relayB = await armedRelay('wss://p2-b.test', oldK.pub, oldK.privHex);
    const pool = poolWithRelays([relayA, relayB]);
    await pool.reloadIdentity({publicKey: oldK.pub, privateKeyHex: oldK.privHex});

    // The documented logout shape: stored identity is gone.
    keyStore.record = null;
    await expect(pool.reloadIdentity()).rejects.toThrow();

    expect(pool.getPrivateKey()).toBeNull();
    for(const relay of [relayA, relayB]) {
      const key = (relay as any).privateKey as Uint8Array;
      expect([...key].every((b) => b === 0)).toBe(true);
      expect((relay as any).getPublicKey()).toBe('');
      expect((relay as any).ownId).toBe('');
    }
  });

  it('failed decrypt reload clears pool AND relays, then throws (P2)', async() => {
    const oldK = keypair();
    const relay = await armedRelay('wss://p2f.test', oldK.pub, oldK.privHex);
    const pool = poolWithRelays([relay]);
    await pool.reloadIdentity({publicKey: oldK.pub, privateKeyHex: oldK.privHex});

    keyStore.record = {iv: 'iv', encryptedKeys: 'ek'};
    keyStore.browserKey = 'bk';
    keyStore.decryptError = new Error('bad key');
    await expect(pool.reloadIdentity()).rejects.toThrow();

    expect(pool.getPrivateKey()).toBeNull();
    const key = (relay as any).privateKey as Uint8Array;
    expect([...key].every((b) => b === 0)).toBe(true);
  });

  it('a failed reload keeps NOTHING of the old account: its REQ is gone', async() => {
    const oldK = keypair();
    const relay = await armedRelay('wss://p2d.test', oldK.pub, oldK.privHex);
    const pool = poolWithRelays([relay]);
    await pool.reloadIdentity({publicKey: oldK.pub, privateKeyHex: oldK.privHex});

    keyStore.record = null;
    await expect(pool.reloadIdentity()).rejects.toThrow();

    const all = frames(relay);
    const closeIdx = all.map((f) => f.type).lastIndexOf('CLOSE');
    const reqAfterClose = all.slice(closeIdx + 1).some((f) => f.type === 'REQ');
    expect(reqAfterClose).toBe(false);
  });

  it('clearIdentity() is the explicit logout path: zeroes relays and drops the REQ', async() => {
    const oldK = keypair();
    const relay = await armedRelay('wss://logout.test', oldK.pub, oldK.privHex);
    const pool = poolWithRelays([relay]);
    await pool.reloadIdentity({publicKey: oldK.pub, privateKeyHex: oldK.privHex});

    pool.clearIdentity();

    expect(pool.getPrivateKey()).toBeNull();
    const key = (relay as any).privateKey as Uint8Array;
    expect([...key].every((b) => b === 0)).toBe(true);
    const all = frames(relay);
    expect(all[all.length - 1].type).toBe('CLOSE');
  });
});
