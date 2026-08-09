/**
 * Tests for the NostrRelayPool side of Phase 1 idle transport (#125):
 * the supervisor gate + the suspend / resume / one-shot-tick hooks the
 * IdleTransportController drives.
 *
 * The controller's own state machine is covered in
 * transport-idle-controller.test.ts; here we verify the pool mechanics with a
 * mock relay: going idle closes every socket and the gated supervisor does NOT
 * redial, resume reopens them, and an idle tick briefly connects → queries →
 * closes, reporting whether it delivered anything.
 */

import 'fake-indexeddb/auto';
import '../setup';

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
    connectionState = 'disconnected';
    pendingSubscribe = false;
    subscribed = false;
    onStateChange: (() => void) | null = null;
    onLatencyUpdate: (() => void) | null = null;
    liveSubscribeSince: (() => number | undefined) | null = null;
    private messageHandler: ((msg: MockMsg) => void) | null = null;
    /** Pages the next getMessagesPaged() call will hand back, FIFO. */
    pagedQueue: Array<{messages: MockMsg[]; outcome: string; oldestReached?: number}> = [];
    connectCount = 0;
    disconnectCount = 0;

    constructor(url: string) {
      this.url = url;
      instances.push(this);
    }

    async initialize(): Promise<void> {}

    connect(): void {
      if(this.connectionState === 'connected') return;
      this.connectCount++;
      this.connectionState = 'connected';
      this.onStateChange?.();
    }

    disconnect(): void {
      if(this.connectionState === 'disconnected') return;
      this.disconnectCount++;
      this.connectionState = 'disconnected';
      this.onStateChange?.();
    }

    resetReconnectBackoff(): void {}
    subscribeMessages(): void { this.subscribed = true; }
    unsubscribeMessages(): void { this.subscribed = false; }
    onMessage(handler: (msg: MockMsg) => void): void { this.messageHandler = handler; }
    onReceipt(): void {}
    onRawEvent(): void {}
    getState(): string { return this.connectionState; }
    getPublicKey(): string { return 'mock-pubkey'; }
    publishRawEvent(): void {}
    async queryRawEvents(): Promise<any[]> { return []; }
    async ingestExternalEvent(): Promise<void> {}
    async measureLatency(): Promise<number> { return -1; }
    getLatency(): number { return -1; }

    async getMessages(): Promise<MockMsg[]> { return []; }

    async getMessagesPaged(): Promise<{messages: MockMsg[]; outcome: string; oldestReached?: number}> {
      if(this.connectionState !== 'connected') return {messages: [], outcome: 'unknown'};
      return this.pagedQueue.shift() ?? {messages: [], outcome: 'exhausted'};
    }

    /** Deliver a live message straight through the pool's handler (unused here but kept for parity). */
    simulateMessage(msg: MockMsg): void { this.messageHandler?.(msg); }
  }

  return {mockRelayInstances: instances, MockNostrRelayClass: MockRelay};
});

vi.mock('@lib/phantomchat/nostr-relay', () => ({NostrRelay: MockNostrRelayClass}));
vi.mock('@lib/rootScope', () => ({default: {dispatchEvent: vi.fn(), addEventListener: vi.fn()}}));
vi.mock('@lib/phantomchat/nip65', () => ({
  buildNip65Event: vi.fn().mockReturnValue({kind: 10002, tags: [], content: '', id: 'x', sig: 'y'})
}));

const RELAYS = [
  {url: 'wss://relay-a.test', read: true, write: true},
  {url: 'wss://relay-b.test', read: true, write: true}
];

async function makePool(onMessage: (m: MockMsg) => void) {
  const mod = await import('@lib/phantomchat/nostr-relay-pool');
  const pool: any = new mod.NostrRelayPool({
    relays: [...RELAYS],
    maxActiveRelays: RELAYS.length,
    onMessage: (m: any) => onMessage(m as MockMsg)
  });
  await pool.initialize();
  pool.subscribeMessages(); // sets isSubscribedFlag so backfillRecent runs
  return pool;
}

function connectedCount(): number {
  return mockRelayInstances.filter((r) => r.getState() === 'connected').length;
}

/** Drain microtasks so async re-dials (superviseConnections → initialize().then(connect)) settle. */
async function flush(): Promise<void> {
  for(let i = 0; i < 8; i++) await Promise.resolve();
}

describe('NostrRelayPool idle transport (#125)', () => {
  beforeEach(() => {
    mockRelayInstances.length = 0;
    localStorage.clear();
  });

  it('after initialize the pool holds sockets open (ACTIVE baseline)', async() => {
    await makePool(() => {});
    expect(connectedCount()).toBe(RELAYS.length);
  });

  it('suspendForIdle closes every socket, and the gated supervisor does NOT redial', async() => {
    const pool = await makePool(() => {});
    expect(connectedCount()).toBe(RELAYS.length);

    pool.suspendForIdle();
    expect(connectedCount()).toBe(0);            // zero open sockets while idle (acceptance)
    expect(pool.idleGated).toBe(true);

    // The supervisor is what used to fight to reopen dropped sockets. Gated, it
    // must be a no-op — the whole point of idle mode.
    await pool.superviseConnections();
    expect(connectedCount()).toBe(0);
  });

  it('resumeFromIdle un-gates and reopens sockets for live streaming', async() => {
    const pool = await makePool(() => {});
    pool.suspendForIdle();
    expect(connectedCount()).toBe(0);

    pool.resumeFromIdle();
    expect(pool.idleGated).toBe(false);
    await flush(); // re-dials are async (superviseConnections → initialize().then(connect))
    expect(connectedCount()).toBe(RELAYS.length);
  });

  it('an idle tick briefly connects → queries → closes, and reports a delivered message', async() => {
    const delivered: MockMsg[] = [];
    const pool = await makePool((m) => delivered.push(m));

    pool.suspendForIdle();
    expect(connectedCount()).toBe(0);

    // Arm ONE relay to return a fresh message on its next paged query.
    const msg: MockMsg = {id: 'evt-1', from: 'peer', content: 'hello from idle', timestamp: 1000};
    mockRelayInstances[0].pagedQueue.push({messages: [msg], outcome: 'exhausted'});

    const found = await pool.idlePollOnce();
    expect(found).toBe(true);                     // delivered a new message
    expect(delivered.map((m) => m.id)).toContain('evt-1');
    // open → REQ → EOSE → CLOSE: no socket left dangling after the tick.
    expect(connectedCount()).toBe(0);
  });

  it('an idle tick with nothing new returns false and still leaves zero sockets open', async() => {
    const pool = await makePool(() => {});
    pool.suspendForIdle();

    const found = await pool.idlePollOnce();
    expect(found).toBe(false);
    expect(connectedCount()).toBe(0);
  });

  it('a duplicate event on a tick is NOT counted as newly delivered', async() => {
    const delivered: MockMsg[] = [];
    const pool = await makePool((m) => delivered.push(m));
    pool.suspendForIdle();

    const msg: MockMsg = {id: 'dup-1', from: 'peer', content: 'once', timestamp: 2000};
    mockRelayInstances[0].pagedQueue.push({messages: [msg], outcome: 'exhausted'});
    expect(await pool.idlePollOnce()).toBe(true);

    // Same id again → dedup drops it → tick reports nothing new.
    mockRelayInstances[0].pagedQueue.push({messages: [msg], outcome: 'exhausted'});
    expect(await pool.idlePollOnce()).toBe(false);
    expect(delivered.length).toBe(1);
  });

  it('enabling idleTransport builds a controller and reports transport mode', async() => {
    const mod = await import('@lib/phantomchat/nostr-relay-pool');
    const pool: any = new mod.NostrRelayPool({
      relays: [...RELAYS],
      maxActiveRelays: RELAYS.length,
      idleTransport: true,
      onMessage: () => {}
    });
    await pool.initialize();
    expect(pool.idleController).not.toBeNull();
    expect(['active', 'idle']).toContain(pool.getTransportMode());
    pool.disconnect();
    expect(pool.idleController).toBeNull(); // torn down cleanly
  });

  it('without idleTransport there is no controller and mode defaults to active', async() => {
    const pool = await makePool(() => {});
    expect(pool.idleController).toBeNull();
    expect(pool.getTransportMode()).toBe('active');
  });
});
