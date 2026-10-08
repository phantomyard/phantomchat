/**
 * Tests for the wake-latency resume breadcrumbs in NostrRelayPool (#206).
 *
 * Pins the delivery breadcrumb ordering: "first message delivered" must be
 * logged only AFTER the onMessage callback completes successfully — the
 * callback contains the IDB/UI work the timing is meant to measure, so
 * logging at entry would produce a falsely-fast number, and logging on a
 * throw would report "delivered" for a failed delivery.
 *
 * Also pins the staleness cap: a breadcrumb armed by a wake that never
 * resolves must not log a multi-hour elapsed value attributed to that
 * long-gone resume.
 *
 * And pins the resume-epoch guard: the armed timestamp is snapshotted before
 * the await, so a wake that arms a NEW breadcrumb while an earlier delivery
 * is still pending is not cleared and logged by that older delivery.
 */

import 'fake-indexeddb/auto';
import '../setup';

const {mockRelayInstances, MockNostrRelayClass} = vi.hoisted(() => {
  if(!(globalThis as any).__nostrRelayPoolTestInstances) {
    (globalThis as any).__nostrRelayPoolTestInstances = [];
  }
  const instances: any[] = (globalThis as any).__nostrRelayPoolTestInstances;

  class MockNostrRelay {
    url: string;
    connected = false;
    disconnected = false;
    initialized = false;
    subscribed = false;
    messageHandler: ((msg: any) => void) | null = null;
    connectionState = 'disconnected';
    onStateChangeCb: (() => void) | null = null;
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
    async getMessages(_since?: number): Promise<any[]> {
      return [];
    }
    async getMessagesPaged(_since?: number, _until?: number): Promise<{
      messages: any[];
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
    onMessage(handler: (msg: any) => void): void {
      this.messageHandler = handler;
    }
    setEventDedup(_fn: (id: string) => boolean): void {}
    setEventRelease(_fn: (id: string, error?: Error) => void): void {}
    setEventCommit(_fn: (id: string) => void): void {}
    getPublicKey(): string {
      return 'abcd1234pubkey';
    }
    getState(): string {
      return this.connectionState;
    }
    simulateMessage(msg: any): void {
      if(this.messageHandler) this.messageHandler(msg);
    }
    set onStateChange(fn: () => void) {
      this.onStateChangeCb = fn;
    }
  }

  return {mockRelayInstances: instances, MockNostrRelayClass: MockNostrRelay};
});

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
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn()
  }
}));

vi.mock('@lib/phantomchat/nip65', () => ({
  buildNip65Event: vi.fn().mockReturnValue({kind: 10002, tags: [], content: '', id: 'mock-id', sig: 'mock-sig'})
}));

// Mock key-storage: the real implementation hangs on IndexedDB calls here.
vi.mock('@lib/phantomchat/key-storage', () => ({
  loadEncryptedIdentity: vi.fn().mockResolvedValue(null),
  loadBrowserKey: vi.fn().mockResolvedValue(null),
  decryptKeys: vi.fn().mockResolvedValue({seed: ''}),
  saveEncryptedIdentity: vi.fn().mockResolvedValue(undefined),
  saveBrowserKey: vi.fn().mockResolvedValue(undefined)
}));

const logLines: string[] = [];

vi.mock('@lib/logger', () => ({
  logger: () => {
    const log = (...args: unknown[]) => {
      logLines.push(args.join(' '));
    };
    log.warn = (...args: unknown[]) => {
      logLines.push(args.join(' '));
    };
    log.error = (...args: unknown[]) => {
      logLines.push(args.join(' '));
    };
    log.debug = (...args: unknown[]) => {
      logLines.push(args.join(' '));
    };
    return log;
  },
  Logger: class {},
  LogTypes: {None: 0, Error: 1, Warn: 2, Log: 4, Debug: 8}
}));

import {NostrRelayPool} from '@lib/phantomchat/nostr-relay-pool';

type Msg = {
  id: string;
  from: string;
  content: string;
  timestamp: number;
};

function makeMessage(id: string): Msg {
  return {
    id,
    from: 'sender-pubkey-hex',
    content: 'hello world',
    timestamp: Math.floor(Date.now() / 1000)
  };
}

async function flushMicrotasks(): Promise<void> {
  for(let i = 0; i < 8; i++) await Promise.resolve();
}

describe('resume breadcrumbs (wake-latency timing)', () => {
  beforeEach(() => {
    mockRelayInstances.length = 0;
    logLines.length = 0;
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function makePool(onMessage: (msg: Msg) => void | Promise<void>): Promise<NostrRelayPool> {
    const pool = new NostrRelayPool({
      relays: [{url: 'wss://r.test', read: true, write: true}],
      onMessage
    });
    await pool.initialize();
    pool.subscribeMessages();
    return pool;
  }

  async function drainDelivery(pool: NostrRelayPool): Promise<void> {
    await (pool as any).liveDeliveryDone;
  }

  it('logs "first message delivered" only after the onMessage callback completes', async() => {
    let releaseCallback: (() => void) | null = null;
    const callbackDone = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    let callbackFinished = false;
    const pool = await makePool(async() => {
      await callbackDone;
      callbackFinished = true;
    });

    // Simulate a wake: arm the breadcrumb exactly as hardResetSockets does.
    (pool as any).resumeDeliverAt = Date.now();
    (pool as any).resumeConnectAt = 0;

    mockRelayInstances[0].simulateMessage(makeMessage('msg-1'));
    // Flush microtasks WITHOUT awaiting the pump — the pump is blocked in the
    // callback, which is exactly the state under test.
    await flushMicrotasks();

    // The callback is still awaiting — delivery has NOT completed, so the
    // breadcrumb must not have fired yet, even though the message arrived.
    expect(callbackFinished).toBe(false);
    expect(logLines.some((l) => l.includes('first message delivered'))).toBe(false);

    // Let the callback finish — NOW the breadcrumb fires.
    releaseCallback!();
    await drainDelivery(pool);
    expect(callbackFinished).toBe(true);
    expect(logLines.some((l) => l.includes('first message delivered'))).toBe(true);
  });

  it('does not log "delivered" when the onMessage callback throws; next success logs the true total', async() => {
    const pool = await makePool((msg: Msg) => {
      if(msg.id === 'bad') throw new Error('delivery failed');
    });

    (pool as any).resumeDeliverAt = Date.now();
    (pool as any).resumeConnectAt = 0;

    // First delivery fails inside the callback.
    mockRelayInstances[0].simulateMessage(makeMessage('bad'));
    await drainDelivery(pool);
    expect(logLines.some((l) => l.includes('first message delivered'))).toBe(false);

    // 1.5s later a delivery succeeds — breadcrumb logs the true total
    // (armed timestamp unchanged), then the one-shot clears.
    (pool as any).resumeDeliverAt = Date.now() - 1500;
    mockRelayInstances[0].simulateMessage(makeMessage('good'));
    await drainDelivery(pool);
    const deliveredLine = logLines.find((l) => l.includes('first message delivered'));
    expect(deliveredLine).toBeTruthy();
    expect(deliveredLine).toContain('1500 ms');
    // One-shot: a third delivery logs nothing more.
    mockRelayInstances[0].simulateMessage(makeMessage('more'));
    await drainDelivery(pool);
    expect(logLines.filter((l) => l.includes('first message delivered'))).toHaveLength(1);
  });

  it('does not let a pre-resume delivery clear/log a breadcrumb armed during its await', async() => {
    // Kai's resume-epoch race: message A starts delivery (snapshot taken),
    // a visibility resume arms a NEW breadcrumb while A's callback is still
    // pending, then A completes. A must not consume the newer epoch.
    let releaseA: (() => void) | null = null;
    const aDone = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const pool = await makePool(async(msg: Msg) => {
      if(msg.id === 'A') await aDone;
    });

    const firstEpoch = Date.now() - 1000;
    (pool as any).resumeDeliverAt = firstEpoch;
    (pool as any).resumeConnectAt = 0;

    mockRelayInstances[0].simulateMessage(makeMessage('A'));
    await flushMicrotasks();

    // A wake lands while A's callback is still pending: re-arm the breadcrumb.
    const resumeEpoch = Date.now();
    (pool as any).resumeDeliverAt = resumeEpoch;

    releaseA!();
    await drainDelivery(pool);

    // The stale pre-resume value must be gone (not logged as a bogus fast
    // time) and the NEW epoch must still be armed for its own delivery.
    expect(logLines.some((l) => l.includes('first message delivered'))).toBe(false);
    expect((pool as any).resumeDeliverAt).toBe(resumeEpoch);

    // The wake's own first delivery consumes it, elapsed from resumeEpoch.
    mockRelayInstances[0].simulateMessage(makeMessage('B'));
    await drainDelivery(pool);
    const deliveredLine = logLines.find((l) => l.includes('first message delivered'));
    expect(deliveredLine).toBeTruthy();
    expect((pool as any).resumeDeliverAt).toBe(0);
  });

  it('drops a stale connect breadcrumb instead of attributing hours-old times to this resume', async() => {
    const onMessage = vi.fn();
    const pool = await makePool(onMessage);

    // Arm, then go stale well past the cap — no timer advancement needed.
    (pool as any).resumeConnectAt = Date.now() - (60 * 60 * 1000); // 1h ago

    // A connect state-change now must NOT log the stale value.
    (mockRelayInstances[0] as any).connectionState = 'connected';
    if((mockRelayInstances[0] as any).onStateChangeCb) (mockRelayInstances[0] as any).onStateChangeCb();
    await flushMicrotasks();
    expect(logLines.some((l) => l.includes('first relay connected'))).toBe(false);
  });

  it('logs the connect breadcrumb for a prompt connect within the cap', async() => {
    const onMessage = vi.fn();
    const pool = await makePool(onMessage);

    (pool as any).resumeConnectAt = Date.now() - 3000;

    (mockRelayInstances[0] as any).connectionState = 'connected';
    if((mockRelayInstances[0] as any).onStateChangeCb) (mockRelayInstances[0] as any).onStateChangeCb();
    await flushMicrotasks();
    const connectLine = logLines.find((l) => l.includes('first relay connected'));
    expect(connectLine).toBeTruthy();
    expect(connectLine).toContain('3000 ms');
  });
});
