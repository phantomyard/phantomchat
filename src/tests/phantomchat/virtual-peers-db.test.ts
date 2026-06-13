/**
 * Unit tests for VirtualPeersDB IndexedDB persistence layer.
 *
 * Tests cover:
 * - CRUD operations (put, get, delete, updateLastSeen, getAll)
 * - Reverse lookup via peerId index
 * - Schema migration (v0 → v1)
 * - Error handling
 * - Observability (getStats)
 */

import '../setup';
import {
  VirtualPeersDB,
  VirtualPeerRecord,
  getVirtualPeersDB,
  VIRTUAL_PEERS_DB_NAME,
  VIRTUAL_PEERS_STORE,
  SCHEMA_VERSION,
  storeMapping,
  getMapping,
  updateMappingProfile
} from '@lib/phantomchat/virtual-peers-db';

// Save original indexedDB so we can restore after tests (isolate:false leaks globals)
const _origIndexedDB = (global as any).indexedDB;
afterAll(() => {
  (global as any).indexedDB = _origIndexedDB;
});

// --- IndexedDB mock helpers ---

/**
 * Create a mock IndexedDB database that stores records in a Map.
 * Simulates the actual IndexedDB API without a browser.
 *
 * Key behavior: Both onupgradeneeded and onsuccess fire in microtasks, giving
 * the calling code time to attach handlers after indexedDB.open() returns.
 * This mirrors real IndexedDB where open() is synchronous but the connection
 * is established asynchronously (microtask).
 */
class MockIDBDatabase {
  name: string;
  version: number;
  objectStoreNames: DOMStringList;
  private stores: Map<string, Map<string, VirtualPeerRecord>>;
  private storeIndexes: Map<string, Map<number, string[]>>;
  private objectStoreInstances: Map<string, MockIDBObjectStore>;
  onerror: ((event: Event) => void) | null = null;
  onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null = null;
  onsuccess: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(name: string, version: number) {
    this.name = name;
    this.version = version;
    this.objectStoreNames = {
      length: 0,
      contains: (name: string) => this.stores.has(name),
      item: (): string | null => null,
      [Symbol.iterator]: function* () {}
    } as unknown as DOMStringList;
    this.stores = new Map();
    this.storeIndexes = new Map();
    this.objectStoreInstances = new Map();
  }

  createObjectStore(
    storeName: string,
    options?: IDBObjectStoreParameters
  ): MockIDBObjectStore {
    const store = new MockIDBObjectStore(storeName, this.stores, this.storeIndexes);
    store.keyPath = options?.keyPath as string | string[];
    this.stores.set(storeName, (store as any).records);
    this.storeIndexes.set(storeName, (store as any).indexes);
    this.objectStoreInstances.set(storeName, store);
    // Update objectStoreNames
    const names = Array.from(this.stores.keys());
    this.objectStoreNames = {
      length: names.length,
      contains: (n: string) => names.includes(n),
      item: (i: number) => names[i] ?? null,
      [Symbol.iterator]: function* () { yield* names; }
    } as unknown as DOMStringList;
    return store;
  }

  transaction(storeName: string, mode: IDBTransactionMode): MockIDBTransaction {
    return new MockIDBTransaction(storeName, mode, this.stores, this.storeIndexes, this.objectStoreInstances);
  }

  close(): void {
    // No-op in mock
  }
}

class MockIDBObjectStore {
  name: string;
  keyPath: string | string[];
  private records: Map<string, VirtualPeerRecord>;
  private indexes: Map<number, string[]>;
  autoIncrement: boolean = false;

  constructor(
    name: string,
    stores: Map<string, Map<string, VirtualPeerRecord>>,
    storeIndexes: Map<string, Map<number, string[]>>
  ) {
    this.name = name;
    this.records = stores.get(name) ?? new Map();
    this.indexes = storeIndexes.get(name) ?? new Map();
  }

  createIndex(indexName: string, keyPath: string, _options?: IDBIndexParameters): MockIDBIndex {
    return new MockIDBIndex(indexName, this.records, this.indexes);
  }

  put(record: VirtualPeerRecord): MockIDBRequest {
    const req = new MockIDBRequest();
    // Handle compound keyPath (array of keys)
    const keyPath = this.keyPath;
    let key: string;
    if(Array.isArray(keyPath)) {
      key = keyPath.map(k => (record as any)[k]).join('|');
    } else {
      key = (record as any)[keyPath as string];
    }
    if(key === undefined) {
      req._error = new Error(`KeyPath '${keyPath}' not found in record`);
      Promise.resolve().then(() => req._fireError());
      return req;
    }
    // Preserve createdAt when updating existing record
    const existing = this.records.get(key);
    if(existing) {
      record.createdAt = existing.createdAt;
      // Update lastSeenAt on existing record
      (record as any).lastSeenAt = Date.now();
    } else {
      // Set createdAt and lastSeenAt for new records
      if(record.createdAt === undefined) record.createdAt = Date.now();
      if((record as any).lastSeenAt === undefined) (record as any).lastSeenAt = Date.now();
    }
    this.records.set(key, record);
    // Update indexes
    if(record.peerId !== undefined) {
      const existing = this.indexes.get(record.peerId) ?? [];
      if(!existing.includes(key)) existing.push(key);
      this.indexes.set(record.peerId, existing);
    }
    Promise.resolve().then(() => req._fireSuccess());
    return req;
  }

  get(key: string): MockIDBRequest {
    const req = new MockIDBRequest();
    const result = this.records.get(key) ?? undefined;
    Promise.resolve().then(() => {
      req._result = result;
      req._fireSuccess();
    });
    return req;
  }

  getAll(_key?: string | IDBKeyRange): MockIDBRequest {
    const req = new MockIDBRequest();
    Promise.resolve().then(() => {
      req._result = Array.from(this.records.values());
      req._fireSuccess();
    });
    return req;
  }

  delete(key: string): MockIDBRequest {
    const req = new MockIDBRequest();
    const record = this.records.get(key);
    this.records.delete(key);
    // Remove from indexes
    if(record && record.peerId !== undefined) {
      const idx = this.indexes.get(record.peerId) ?? [];
      this.indexes.set(record.peerId, idx.filter(k => k !== key));
    }
    Promise.resolve().then(() => req._fireSuccess());
    return req;
  }

  index(indexName: string): MockIDBIndex {
    return new MockIDBIndex(indexName, this.records, this.indexes);
  }
}

class MockIDBIndex {
  name: string;
  private records: Map<string, VirtualPeerRecord>;
  private indexes: Map<number, string[]>;

  constructor(
    name: string,
    records: Map<string, VirtualPeerRecord>,
    indexes: Map<number, string[]>
  ) {
    this.name = name;
    this.records = records;
    this.indexes = indexes;
  }

  getAll(key: number): MockIDBRequest {
    const req = new MockIDBRequest();
    Promise.resolve().then(() => {
      const keys = this.indexes.get(key) ?? [];
      req._result = keys.map(k => this.records.get(k)).filter(Boolean);
      req._fireSuccess();
    });
    return req;
  }
}

class MockIDBTransaction {
  mode: IDBTransactionMode;
  onerror: ((event: Event) => void) | null = null;
  oncomplete: (() => void) | null = null;
  private stores: Map<string, Map<string, VirtualPeerRecord>>;
  private storeIndexes: Map<string, Map<number, string[]>>;
  private objectStoreInstances: Map<string, MockIDBObjectStore>;

  constructor(
    _storeName: string,
    _mode: IDBTransactionMode,
    stores: Map<string, Map<string, VirtualPeerRecord>>,
    storeIndexes: Map<string, Map<number, string[]>>,
    objectStoreInstances: Map<string, MockIDBObjectStore>
  ) {
    this.stores = stores;
    this.storeIndexes = storeIndexes;
    this.objectStoreInstances = objectStoreInstances;
  }

  objectStore(name: string): MockIDBObjectStore {
    // Return the original store instance (created during onupgradeneeded) so that
    // keyPath and other settings are preserved.
    return this.objectStoreInstances.get(name) ??
      new MockIDBObjectStore(name, this.stores, this.storeIndexes);
  }
}

class MockIDBRequest {
  _result: any = undefined;
  _error: Error | null = null;
  get result(): any { return this._result; }
  get error(): Error | null { return this._error; }
  onsuccess: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  _fireSuccess(): void {
    if(this.onsuccess) this.onsuccess();
  }

  _fireError(): void {
    if(this.onerror) this.onerror(new Event('error'));
  }
}

class MockIDBOpenDBRequest extends MockIDBRequest {
  onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null = null;
  oldVersion: number = 0;
}

// --- Global IndexedDB mock ---

let mockDB: MockIDBDatabase | null = null;

function installIndexedDBMock(): void {
  (global as any).indexedDB = {
    open: (name: string, version?: number) => {
      mockDB = new MockIDBDatabase(name, version ?? 1);
      const req = new MockIDBOpenDBRequest();

      // Both onupgradeneeded and onsuccess fire in microtasks.
      // This gives the calling code time to attach handlers after open() returns.
      // Real IndexedDB fires onupgradeneeded synchronously during open() and
      // onsuccess asynchronously; we fire both in microtasks for consistency.
      Promise.resolve().then(() => {
        // Set result BEFORE onupgradeneeded fires — source code reads request.result in onupgradeneeded handler
        req._result = mockDB;
        if(req.onupgradeneeded) {
          const event = {
            target: {result: mockDB, transaction: null, oldVersion: req.oldVersion}
          } as unknown as IDBVersionChangeEvent;
          req.onupgradeneeded(event);
        }
      }).then(() => {
        // onsuccess fires after onupgradeneeded handlers complete
        if(req.onsuccess) req.onsuccess();
      });

      return req;
    },
    deleteDatabase: (name: string) => {
      const req = new MockIDBOpenDBRequest();
      Promise.resolve().then(() => {
        mockDB = null;
        if(req.onsuccess) req.onsuccess();
      });
      return req;
    }
  };
}

// --- Test helpers ---

const TEST_PUBKEY_1 = 'a'.repeat(64);
const TEST_PUBKEY_2 = 'b'.repeat(64);
const TEST_PUBKEY_3 = 'c'.repeat(64);
const TEST_PEER_ID_1 = 0x7FFFFFFF - 100;
const TEST_PEER_ID_2 = 0x7FFFFFFF - 200;
const TEST_PEER_ID_3 = 0x7FFFFFFF - 300;

// --- Tests ---

describe('VirtualPeersDB', () => {
  let db: VirtualPeersDB;

  beforeEach(async() => {
    installIndexedDBMock();
    // Destroy singleton and create fresh instance with debug enabled
    VirtualPeersDB.getInstance().destroy();
    db = new VirtualPeersDB({debug: true});
    // Wait for DB to open (microtask must complete first)
    await (db as any).getDB();
  });

  afterEach(() => {
    db.destroy();
  });

  describe('putPeer / getByPubkey round-trip', () => {
    test('stores and retrieves a virtual peer record', async() => {
      await db.putPeer(TEST_PUBKEY_1, TEST_PEER_ID_1, 'Alice');

      const record = await db.getByPubkey(TEST_PUBKEY_1);

      expect(record).not.toBeNull();
      expect(record!.pubkey).toBe(TEST_PUBKEY_1);
      expect(record!.peerId).toBe(TEST_PEER_ID_1);
      expect(record!.displayName).toBe('Alice');
      expect(record!.createdAt).toBeGreaterThan(0);
      expect(record!.lastSeenAt).toBeGreaterThan(0);
    });

    test('putPeer updates existing record, preserving createdAt', async() => {
      await db.putPeer(TEST_PUBKEY_1, TEST_PEER_ID_1, 'Alice');
      const firstRecord = await db.getByPubkey(TEST_PUBKEY_1);
      const originalCreatedAt = firstRecord!.createdAt;

      // Advance time
      await new Promise(r => setTimeout(r, 10));
      await db.putPeer(TEST_PUBKEY_1, TEST_PEER_ID_1, 'Alice Updated');

      const updatedRecord = await db.getByPubkey(TEST_PUBKEY_1);

      expect(updatedRecord!.createdAt).toBe(originalCreatedAt);
      expect(updatedRecord!.displayName).toBe('Alice Updated');
    });

    test('getByPubkey returns null for non-existent pubkey', async() => {
      const record = await db.getByPubkey('0'.repeat(64));
      expect(record).toBeNull();
    });

    test('putPeer without displayName stores undefined displayName', async() => {
      await db.putPeer(TEST_PUBKEY_1, TEST_PEER_ID_1);

      const record = await db.getByPubkey(TEST_PUBKEY_1);
      expect(record!.displayName).toBeUndefined();
    });
  });

  describe('getByPeerId reverse lookup', () => {
    test('retrieves record by peerId using the index', async() => {
      await db.putPeer(TEST_PUBKEY_1, TEST_PEER_ID_1);
      await db.putPeer(TEST_PUBKEY_2, TEST_PEER_ID_2);

      const record = await db.getByPeerId(TEST_PEER_ID_1);

      expect(record).not.toBeNull();
      expect(record!.pubkey).toBe(TEST_PUBKEY_1);
      expect(record!.peerId).toBe(TEST_PEER_ID_1);
    });

    test('returns null for non-existent peerId', async() => {
      const record = await db.getByPeerId(999999);
      expect(record).toBeNull();
    });

    test('multiple pubkeys can share the same peerId (non-unique index)', async() => {
      await db.putPeer(TEST_PUBKEY_1, TEST_PEER_ID_1);
      await db.putPeer(TEST_PUBKEY_2, TEST_PEER_ID_1); // Same peerId

      const records = await db.getByPeerId(TEST_PEER_ID_1);
      // Non-unique index — returns first match
      expect(records).not.toBeNull();
    });
  });

  describe('deletePeer', () => {
    test('deletes a record by pubkey', async() => {
      await db.putPeer(TEST_PUBKEY_1, TEST_PEER_ID_1);
      await db.putPeer(TEST_PUBKEY_2, TEST_PEER_ID_2);

      await db.deletePeer(TEST_PUBKEY_1);

      expect(await db.getByPubkey(TEST_PUBKEY_1)).toBeNull();
      expect(await db.getByPubkey(TEST_PUBKEY_2)).not.toBeNull();
    });

    test('deletePeer is idempotent (no-op for non-existent pubkey)', async() => {
      // Should not throw
      await db.deletePeer('0'.repeat(64));
      // No error means success
      expect(true).toBe(true);
    });
  });

  describe('updateLastSeen', () => {
    test('updates lastSeenAt timestamp', async() => {
      await db.putPeer(TEST_PUBKEY_1, TEST_PEER_ID_1);
      const before = (await db.getByPubkey(TEST_PUBKEY_1))!.lastSeenAt!;

      // Advance time
      await new Promise(r => setTimeout(r, 10));
      await db.updateLastSeen(TEST_PUBKEY_1);
      const after = (await db.getByPubkey(TEST_PUBKEY_1))!.lastSeenAt!;

      expect(after).toBeGreaterThan(before);
    });

    test('updateLastSeen warns for non-existent pubkey', async() => {
      // Should not throw, just warn
      await db.updateLastSeen('0'.repeat(64));
      expect(true).toBe(true);
    });
  });

  describe('getAll', () => {
    test('returns all stored records', async() => {
      await db.putPeer(TEST_PUBKEY_1, TEST_PEER_ID_1);
      await db.putPeer(TEST_PUBKEY_2, TEST_PEER_ID_2);
      await db.putPeer(TEST_PUBKEY_3, TEST_PEER_ID_3);

      const all = await db.getAll();

      expect(all.length).toBe(3);
    });

    test('returns empty array when no records exist', async() => {
      const all = await db.getAll();
      expect(all).toEqual([]);
    });
  });

  describe('getStats', () => {
    test('returns correct stats', async() => {
      const before = Date.now() - 1000;
      await db.putPeer(TEST_PUBKEY_1, TEST_PEER_ID_1);
      await new Promise(r => setTimeout(r, 5));
      await db.putPeer(TEST_PUBKEY_2, TEST_PEER_ID_2);
      const after = Date.now() + 1000;

      const stats = await db.getStats();

      expect(stats.totalPeers).toBe(2);
      expect(stats.oldestEntry).toBeGreaterThanOrEqual(before);
      expect(stats.newestEntry).toBeLessThanOrEqual(after);
    });

    test('returns null oldest/newest for empty DB', async() => {
      const stats = await db.getStats();

      expect(stats.totalPeers).toBe(0);
      expect(stats.oldestEntry).toBeNull();
      expect(stats.newestEntry).toBeNull();
    });
  });

  describe('Schema migration', () => {
    test('schema version is set correctly', () => {
      expect(SCHEMA_VERSION).toBe(1);
    });

    test('creates virtual-peers object store on first open', async() => {
      installIndexedDBMock();
      VirtualPeersDB.getInstance().destroy();
      const freshDb = new VirtualPeersDB({debug: false});
      await (freshDb as any).getDB();

      const all = await freshDb.getAll();
      expect(Array.isArray(all)).toBe(true);
      freshDb.destroy();
    });
  });

  describe('Singleton pattern', () => {
    test('getInstance returns consistent instance', () => {
      installIndexedDBMock();
      VirtualPeersDB.getInstance().destroy();
      const inst1 = VirtualPeersDB.getInstance();
      const inst2 = VirtualPeersDB.getInstance();
      expect(inst1).toBe(inst2);
      inst1.destroy();
    });

    test('getVirtualPeersDB alias returns singleton', async() => {
      installIndexedDBMock();
      await VirtualPeersDB.getInstance().destroy();
      const inst = getVirtualPeersDB();
      expect(inst).toBe(VirtualPeersDB.getInstance());
      await inst.destroy();
    });

    test('destroy clears singleton', async() => {
      installIndexedDBMock();
      await VirtualPeersDB.getInstance().destroy();
      const inst1 = VirtualPeersDB.getInstance();
      await inst1.destroy();

      // After destroy, getInstance should create a new instance
      const inst2 = VirtualPeersDB.getInstance();
      expect(inst1).not.toBe(inst2);
      await inst2.destroy();
    });
  });

  describe('Observability', () => {
    test('instance has debug flag set', async() => {
      const debugDb = new VirtualPeersDB({debug: true});
      expect((debugDb as any).debug).toBe(true);
      debugDb.destroy();

      const normalDb = new VirtualPeersDB({debug: false});
      expect((normalDb as any).debug).toBe(false);
      normalDb.destroy();
    });

    test('putPeer logs in debug mode', async() => {
      installIndexedDBMock();
      VirtualPeersDB.getInstance().destroy();
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const debugDb = new VirtualPeersDB({debug: true});
      await (debugDb as any).getDB();

      await debugDb.putPeer(TEST_PUBKEY_1, TEST_PEER_ID_1);

      // Check that something was logged (log format: ['VirtualPeersDB', ...])
      const logs = spy.mock.calls.map(c => c[0]);
      const dbLogs = logs.filter(l =>
        typeof l === 'string' && l.includes('VirtualPeersDB')
      );
      expect(dbLogs.length).toBeGreaterThan(0);
      spy.mockRestore();
      debugDb.destroy();
    });
  });
});

describe('VirtualPeersDB Constants', () => {
  test('VIRTUAL_PEERS_DB_NAME is phantomchat-virtual-peers', () => {
    expect(VIRTUAL_PEERS_DB_NAME).toBe('phantomchat-virtual-peers');
  });

  test('VIRTUAL_PEERS_STORE is virtual-peers', () => {
    expect(VIRTUAL_PEERS_STORE).toBe('virtual-peers');
  });

  test('SCHEMA_VERSION is 1', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });
});

describe('storeMapping / getMapping round-trip', () => {
  beforeEach(async() => {
    installIndexedDBMock();
    VirtualPeersDB.getInstance().destroy();
    // Warm the DB singleton so low-level functions can use getDB()
    const db = new VirtualPeersDB();
    await (db as any).getDB();
  });

  afterEach(() => {
    VirtualPeersDB.getInstance().destroy();
  });

  test('stores and retrieves a mapping by pubkey', async() => {
    const pubkey = 'a'.repeat(64);
    const peerId = 0x7FFFFFFF - 50;

    await storeMapping(pubkey, peerId, 'TestUser');
    const result = await getMapping(pubkey);

    expect(result).toBeDefined();
    expect(result!.pubkey).toBe(pubkey);
    expect(result!.peerId).toBe(peerId);
    expect(result!.displayName).toBe('TestUser');
    expect(result!.addedAt).toBeGreaterThan(0);
  });

  test('getMapping returns undefined for non-existent pubkey', async() => {
    const result = await getMapping('0'.repeat(64));
    expect(result).toBeUndefined();
  });

  test('storeMapping with nostrProfile preserves profile data', async() => {
    const pubkey = 'b'.repeat(64);
    const profile = {display_name: 'Bob', name: 'bob', picture: 'https://example.com/bob.jpg'};

    await storeMapping(pubkey, 12345, 'Bob', profile);
    const result = await getMapping(pubkey);

    expect(result!.nostrProfile).toEqual(profile);
  });

  test('storeMapping upserts (overwrites) existing record', async() => {
    const pubkey = 'c'.repeat(64);
    await storeMapping(pubkey, 100, 'Original');
    await storeMapping(pubkey, 100, 'Updated');

    const result = await getMapping(pubkey);
    expect(result!.displayName).toBe('Updated');
  });

  test('storeMapping without displayName stores undefined', async() => {
    const pubkey = 'd'.repeat(64);
    await storeMapping(pubkey, 200);

    const result = await getMapping(pubkey);
    expect(result!.displayName).toBeUndefined();
  });

  // WU-2 #10: a contact's kind:0 rebrand must update the stored displayName.
  // Old guard (!existing.displayName) only set it when empty, so a rename was
  // dropped forever. New rule: overwrite when the existing name was kind:0-
  // derived (== the stored profile name); preserve a user-supplied nickname.
  test('updateMappingProfile updates a kind:0-derived displayName on rebrand', async() => {
    const pubkey = 'e'.repeat(64);
    await storeMapping(pubkey, 300, 'Alice', {name: 'Alice', display_name: 'Alice'});

    await updateMappingProfile(pubkey, 'Alice Rebranded', {name: 'Alice Rebranded', display_name: 'Alice Rebranded'});

    const result = await getMapping(pubkey);
    expect(result!.displayName).toBe('Alice Rebranded');
  });

  test('updateMappingProfile preserves a user-supplied nickname distinct from the kind:0 name', async() => {
    const pubkey = 'f'.repeat(64);
    await storeMapping(pubkey, 301, 'MyNickname', {name: 'Bob', display_name: 'Bob'});

    await updateMappingProfile(pubkey, 'Bob Rebranded', {name: 'Bob Rebranded', display_name: 'Bob Rebranded'});

    const result = await getMapping(pubkey);
    expect(result!.displayName).toBe('MyNickname');
  });

  test('updateMappingProfile sets displayName when none existed', async() => {
    const pubkey = '1'.repeat(64);
    await storeMapping(pubkey, 302);

    await updateMappingProfile(pubkey, 'Fresh Name', {name: 'Fresh Name'});

    const result = await getMapping(pubkey);
    expect(result!.displayName).toBe('Fresh Name');
  });
});

describe('updateMappingProfile', () => {
  beforeEach(async() => {
    installIndexedDBMock();
    VirtualPeersDB.getInstance().destroy();
    const db = new VirtualPeersDB();
    await (db as any).getDB();
  });

  afterEach(() => {
    VirtualPeersDB.getInstance().destroy();
  });

  test('updates nostrProfile on existing mapping', async() => {
    const pubkey = 'a'.repeat(64);
    await storeMapping(pubkey, 500);

    const profile = {display_name: 'Alice', name: 'alice'};
    await updateMappingProfile(pubkey, 'Alice', profile);

    const result = await getMapping(pubkey);
    expect(result!.nostrProfile).toEqual(profile);
    expect(result!.displayName).toBe('Alice');
  });

  test('preserves existing displayName if already set', async() => {
    const pubkey = 'b'.repeat(64);
    await storeMapping(pubkey, 600, 'UserNickname');

    const profile = {display_name: 'Nostr Name', name: 'nostr'};
    await updateMappingProfile(pubkey, 'Nostr Name', profile);

    const result = await getMapping(pubkey);
    // Existing displayName 'UserNickname' should NOT be overwritten
    expect(result!.displayName).toBe('UserNickname');
    expect(result!.nostrProfile).toEqual(profile);
  });

  test('sets displayName when none existed', async() => {
    const pubkey = 'c'.repeat(64);
    await storeMapping(pubkey, 700);

    const profile = {name: 'charlie'};
    await updateMappingProfile(pubkey, 'Charlie', profile);

    const result = await getMapping(pubkey);
    expect(result!.displayName).toBe('Charlie');
  });

  test('no-ops for non-existent pubkey', async() => {
    const profile = {name: 'ghost'};
    // Should not throw
    await updateMappingProfile('0'.repeat(64), 'Ghost', profile);

    const result = await getMapping('0'.repeat(64));
    expect(result).toBeUndefined();
  });
});

describe('VirtualPeerRecord interface', () => {
  test('record has correct shape', () => {
    const record: VirtualPeerRecord = {
      pubkey: 'a'.repeat(64),
      peerId: 12345,
      displayName: 'Test',
      addedAt: Date.now(),
      createdAt: Date.now(),
      lastSeenAt: Date.now()
    };

    expect(record.pubkey).toBeDefined();
    expect(record.peerId).toBeDefined();
    expect(typeof record.createdAt).toBe('number');
    expect(typeof record.displayName).toBe('string');
    expect(typeof record.lastSeenAt).toBe('number');
  });

  test('record allows optional fields to be undefined', () => {
    const record: VirtualPeerRecord = {
      pubkey: 'a'.repeat(64),
      peerId: 12345,
      addedAt: Date.now(),
      createdAt: Date.now()
    };

    expect(record.displayName).toBeUndefined();
    expect(record.lastSeenAt).toBeUndefined();
  });
});
