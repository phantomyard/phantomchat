/**
 * Unit tests for Nostra.chat Bridge modules
 *
 * Tests core invariants: determinism, round-trip, avatar derivation,
 * feature flag behavior, and singleton pattern.
 */

import '../setup';
import {
  storeMapping,
  getPubkey,
  getAllMappings,
  initVirtualPeersDB,
} from '../../lib/nostra/virtual-peers-db';
import {
  NostraBridge,
  VIRTUAL_PEER_BASE,
  VIRTUAL_PEER_RANGE
} from '../../lib/nostra/nostra-bridge';
import {
  installApiManagerStub,
  uninstallApiManagerStub,
  isStubInstalled,
} from '../../lib/nostra/api-manager-stub';

// ==================== Helpers ====================

/** Extracts peerId from the deterministic formula to verify correctness */
async function computeExpectedPeerId(pubkey: string): Promise<number> {
  // Hash the FULL pubkey bytes (matches current implementation)
  const bytes = hexToBytes(pubkey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  const hashBytes = new Uint8Array(hashBuffer);
  let hashBigInt = BigInt(0);
  for(let i = 0; i < 8; i++) {
    hashBigInt = (hashBigInt << BigInt(8)) | BigInt(hashBytes[i]);
  }
  return Number(VIRTUAL_PEER_BASE + (hashBigInt % VIRTUAL_PEER_RANGE));
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for(let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// ==================== Bridge Determinism Tests ====================

describe('Nostra.chat Bridge Determinism', () => {
  let bridge: NostraBridge;

  beforeEach(async () => {
    bridge = NostraBridge.getInstance();
  });

  afterEach(() => {
    // Clear in-memory caches between tests
    bridge = NostraBridge.getInstance();
    // Reset singleton state by clearing caches
    (bridge as unknown as {pubkeyCache: Map<string, number>; midCache: Map<string, number>}).pubkeyCache.clear();
    (bridge as unknown as {midCache: Map<string, number>}).midCache.clear();
  });

  it('mapPubkeyToPeerId is deterministic — same pubkey yields same peerId', async () => {
    const pubkey = 'a'.repeat(64); // 64 hex chars = 32 bytes

    const [result1, result2] = await Promise.all([
      bridge.mapPubkeyToPeerId(pubkey),
      bridge.mapPubkeyToPeerId(pubkey),
    ]);

    expect(result1).toBe(result2);
    expect(typeof result1).toBe('number');
    expect(result1).toBeGreaterThan(0);
  });

  it('mapPubkeyToPeerId result matches expected deterministic formula', async () => {
    const pubkey = 'a'.repeat(64);
    const expected = await computeExpectedPeerId(pubkey);
    const actual = await bridge.mapPubkeyToPeerId(pubkey);
    expect(actual).toBe(expected);
  });

  it('mapPubkeyToPeerId returns different values for different pubkeys', async () => {
    const pubkey1 = 'a'.repeat(64);
    const pubkey2 = 'b'.repeat(64);

    const [id1, id2] = await Promise.all([
      bridge.mapPubkeyToPeerId(pubkey1),
      bridge.mapPubkeyToPeerId(pubkey2),
    ]);

    expect(id1).not.toBe(id2);
  });

  it('mapEventIdToMid is deterministic — same eventId+timestamp yields same mid', async () => {
    const eventId = 'e'.repeat(64);
    const timestamp = 1712345678;

    const [result1, result2] = await Promise.all([
      bridge.mapEventIdToMid(eventId, timestamp),
      bridge.mapEventIdToMid(eventId, timestamp),
    ]);

    expect(result1).toBe(result2);
  });

  it('mapEventIdToMid encodes timestamp in high bits for chronological ordering', async () => {
    const eventId = 'f'.repeat(64);
    const timestamp = 1712345678;
    const mid = await bridge.mapEventIdToMid(eventId, timestamp);

    // mid = timestamp * 1_000_000 + (hash % 1_000_000)
    // So Math.floor(mid / 1_000_000) should equal the timestamp
    expect(Math.floor(mid / 1_000_000)).toBe(timestamp);
    // And the low 6 digits should be the hash remainder
    expect(mid % 1_000_000).toBeGreaterThanOrEqual(0);
    expect(mid % 1_000_000).toBeLessThan(1_000_000);
  });

  it('mapEventIdToMid produces chronological order — later timestamp yields higher mid', async () => {
    const eventIdA = 'a'.repeat(64);
    const eventIdB = 'b'.repeat(64);

    const midEarlier = await bridge.mapEventIdToMid(eventIdA, 1700000000);
    const midLater = await bridge.mapEventIdToMid(eventIdB, 1700000001);

    expect(midLater).toBeGreaterThan(midEarlier);
  });

  it('mapPubkeyToPeerId uses VIRTUAL_PEER_BASE range', async () => {
    const pubkey = 'a'.repeat(64);
    const peerId = await bridge.mapPubkeyToPeerId(pubkey);

    expect(peerId).toBeGreaterThanOrEqual(Number(VIRTUAL_PEER_BASE));
    expect(peerId).toBeLessThan(Number(VIRTUAL_PEER_BASE + VIRTUAL_PEER_RANGE));
  });

  // Regression: prod v0.20.0 logged three
  //   `TypeError: Cannot read properties of undefined (reading 'length')`
  // in getContacts because a 32-hex groupId leaked into the 1:1 DM
  // iteration and produced `peerPubkey === undefined`. The guard in
  // mapPubkeyToPeerId now rejects non-64-hex input with a clear message.
  it('mapPubkeyToPeerId throws on a 32-hex group-conv id (regression v0.20.0)', async () => {
    const groupConvId = '71859748a99f4707b32fb28868f5e097'; // 32 hex, no colon
    await expect(bridge.mapPubkeyToPeerId(groupConvId)).rejects.toThrow(/invalid pubkey input/);
  });

  it('mapPubkeyToPeerId throws on undefined input', async () => {
    await expect(bridge.mapPubkeyToPeerId(undefined as unknown as string)).rejects.toThrow(/invalid pubkey input/);
  });

  it('mapPubkeyToPeerId throws on empty string', async () => {
    await expect(bridge.mapPubkeyToPeerId('')).rejects.toThrow(/invalid pubkey input/);
  });
});

// ==================== Bridge Round-Trip Tests ====================

describe('Nostra.chat Bridge Round-Trip (IndexedDB)', () => {
  let bridge: NostraBridge;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let storeMappingSpy: ReturnType<typeof vi.spyOn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let getPubkeySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    bridge = NostraBridge.getInstance();

    // Reset singleton's in-memory caches
    (bridge as unknown as {pubkeyCache: Map<string, number>}).pubkeyCache.clear();
    (bridge as unknown as {midCache: Map<string, number>}).midCache.clear();

    // Spy on the module-level functions to avoid real IndexedDB calls
    const vdb = await import('../../lib/nostra/virtual-peers-db');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storeMappingSpy = vi.spyOn(vdb, 'storeMapping').mockResolvedValue(undefined) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getPubkeySpy = vi.spyOn(vdb, 'getPubkey').mockResolvedValue(null) as any;
  });

  afterEach(() => {
    storeMappingSpy?.mockRestore();
    getPubkeySpy?.mockRestore();
    (NostraBridge as unknown as {_instance: NostraBridge | null})._instance = null;
  });

  it('storePeerMapping then reverseLookup returns original pubkey', async () => {
    const pubkey = 'c'.repeat(64);
    const peerId = await bridge.mapPubkeyToPeerId(pubkey);

    // Configure getPubkey to return the pubkey for this specific peerId
    getPubkeySpy.mockResolvedValue(pubkey);

    await bridge.storePeerMapping(pubkey, peerId, 'Test User');

    const recoveredPubkey = await bridge.reverseLookup(peerId);
    expect(recoveredPubkey).toBe(pubkey);
    expect(getPubkeySpy).toHaveBeenCalledWith(peerId);
    expect(storeMappingSpy).toHaveBeenCalledWith(pubkey, peerId, 'Test User');
  });

  it('reverseLookup returns null for unknown peerId', async () => {
    const unknownId = 999999999999999;
    const result = await bridge.reverseLookup(unknownId);
    expect(result).toBeNull();
    expect(getPubkeySpy).toHaveBeenCalledWith(unknownId);
  });
});

// ==================== Avatar Derivation Tests ====================

describe('Nostra.chat Bridge Avatar Derivation', () => {
  let bridge: NostraBridge;

  beforeEach(() => {
    bridge = NostraBridge.getInstance();
  });

  it('deriveAvatarFromPubkey returns a valid linear-gradient CSS string', async () => {
    const pubkey = 'd'.repeat(64);
    const avatar = await bridge.deriveAvatarFromPubkey(pubkey);

    expect(avatar).toMatch(/^linear-gradient/);
    expect(avatar).toMatch(/hsl/);
    expect(avatar).toContain('deg');
    expect(avatar).toContain(',');
  });

  it('deriveAvatarFromPubkey is deterministic', async () => {
    const pubkey = 'd'.repeat(64);

    const [avatar1, avatar2] = await Promise.all([
      bridge.deriveAvatarFromPubkey(pubkey),
      bridge.deriveAvatarFromPubkey(pubkey),
    ]);

    expect(avatar1).toBe(avatar2);
  });

  it('deriveAvatarFromPubkeySync returns a valid linear-gradient CSS string', () => {
    const pubkey = 'd'.repeat(64);
    const avatar = bridge.deriveAvatarFromPubkeySync(pubkey);

    expect(avatar).toMatch(/^linear-gradient/);
    expect(avatar).toMatch(/hsl/);
    expect(avatar).toContain('deg');
  });

  it('deriveAvatarFromPubkey and deriveAvatarFromPubkeySync produce similar output', () => {
    const pubkey = 'e'.repeat(64);
    const asyncAvatar = bridge.deriveAvatarFromPubkeySync(pubkey);
    expect(asyncAvatar).toMatch(/^linear-gradient/);
  });
});

// ==================== Singleton Tests ====================

describe('NostraBridge Singleton', () => {
  it('getInstance() returns the same object reference', () => {
    const instance1 = NostraBridge.getInstance();
    const instance2 = NostraBridge.getInstance();
    expect(instance1).toBe(instance2);
  });

  it('isInitialized() returns false before init()', () => {
    // Create fresh instance
    (NostraBridge as unknown as {_instance: NostraBridge | null})._instance = null;
    const bridge = NostraBridge.getInstance();
    expect(bridge.isInitialized()).toBe(false);
  });
});

// ==================== API Manager Stub Tests ====================

describe('api-manager-stub', () => {
  beforeEach(() => {
    // Ensure stub is not installed before each test
    uninstallApiManagerStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (global as any).apiManager;
  });

  afterEach(() => {
    uninstallApiManagerStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (global as any).apiManager;
  });

  it('stub reports not installed before explicit install', () => {
    uninstallApiManagerStub();
    expect(isStubInstalled()).toBe(false);
  });

  it('installApiManagerStub returns true on successful install', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).apiManager = {
      invokeApi: async () => 'mock-result',
    };
    const result = installApiManagerStub();
    expect(result).toBe(true);
    expect(isStubInstalled()).toBe(true);
  });

  it('installApiManagerStub returns false if already installed', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).apiManager = {
      invokeApi: async () => 'mock-result',
    };
    installApiManagerStub();
    const result = installApiManagerStub();
    expect(result).toBe(false);
  });

  it('stub rejects invokeApi for non-virtual peers with MTPROTO_DISABLED', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockInvokeApi = vi.fn(async () => 'mtproto-result');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).apiManager = {invokeApi: mockInvokeApi};

    installApiManagerStub();

    await expect(
      (global as any).apiManager.invokeApi('messages.getHistory', {})
    ).rejects.toMatchObject({type: 'MTPROTO_DISABLED', code: 503});
  });

  it('stub logs intercepted methods when flag is enabled', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Set up mock bridge BEFORE the stub is installed
    const mockBridge = {
      isInitialized: () => true,
      reverseLookup: vi.fn().mockResolvedValue('a'.repeat(64)),
      deriveAvatarFromPubkeySync: vi.fn().mockReturnValue('linear-gradient(135deg, hsl(180,70%,60%),hsl(220,70%,45%))'),
    };
    // Spy on the static getInstance so the stub's call picks up our mock
    vi.spyOn(NostraBridge, 'getInstance').mockReturnValue(mockBridge as unknown as NostraBridge);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockInvokeApi = vi.fn(async () => 'mock-result');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).apiManager = {invokeApi: mockInvokeApi};

    uninstallApiManagerStub();
    installApiManagerStub();
    consoleSpy.mockClear();

    // Call messages.getHistory with a virtual peer — stub should log [NostraStub]
    // With MTProto disabled, the call logs then rejects (ChatAPI unavailable in test env)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (global as any).apiManager.invokeApi('messages.getHistory', {peer: {_ : 'inputPeerUser', user_id: 123456789012345}}).catch(() => {});

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[NostraStub]'));

    vi.restoreAllMocks();
    consoleSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it('stub rejects non-matching methods with MTPROTO_DISABLED', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockInvokeApi = vi.fn(async () => 'mock-result');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).apiManager = {invokeApi: mockInvokeApi};

    installApiManagerStub();

    await expect(
      (global as any).apiManager.invokeApi('users.getUsers', {id: []})
    ).rejects.toMatchObject({type: 'MTPROTO_DISABLED', code: 503});

    consoleWarnSpy.mockRestore();
  });

  it('uninstallApiManagerStub restores original invokeApi', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const originalFn = async () => 'original-result';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).apiManager = {invokeApi: originalFn};

    installApiManagerStub();
    // Clear the module-level "[Nostra.chat] apiManager stub installed" log
    consoleSpy.mockClear();
    uninstallApiManagerStub();

    const result = await (global as any).apiManager.invokeApi('messages.getHistory', {});

    expect(consoleSpy).not.toHaveBeenCalled(); // No interception logging after uninstall
    expect(result).toBe('original-result');

    consoleSpy.mockRestore();
  });

  it('installApiManagerStub warns and returns false if apiManager not found', () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (global as any).apiManager;

    const result = installApiManagerStub();

    expect(result).toBe(false);
    expect(consoleWarnSpy).toHaveBeenCalledWith('[Nostra.chat] apiManager stub: apiManager not found on ctx — stub not installed');
    consoleWarnSpy.mockRestore();
  });
});
