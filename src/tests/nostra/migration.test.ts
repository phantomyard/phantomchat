import 'fake-indexeddb/auto';
import {describe, it, expect, beforeEach, beforeAll, afterAll, vi} from 'vitest';
import {hexToBytes} from 'nostr-tools/utils';

// Dynamic imports — loaded after rootScope mock is installed via vi.doMock
let needsMigration: any;
let migrateOwnIdToNpub: any;
let loadEncryptedIdentity: any;
let loadAllQueuedMessages: any;
let importFromMnemonic: any;
let getConversationKey: any;
let nip44Decrypt: any;

beforeAll(async() => {
  vi.resetModules();

  // Mock rootScope to prevent MTProtoMessagePort.getInstance().invokeVoid crash.
  vi.doMock('@lib/rootScope', () => ({
    default: {
      dispatchEvent: vi.fn(),
      dispatchEventSingle: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      myId: 0,
      managers: undefined
    }
  }));

  const migrationMod = await import('@lib/nostra/migration');
  needsMigration = migrationMod.needsMigration;
  migrateOwnIdToNpub = migrationMod.migrateOwnIdToNpub;

  const keyStorageMod = await import('@lib/nostra/key-storage');
  loadEncryptedIdentity = keyStorageMod.loadEncryptedIdentity;

  const queueMod = await import('@lib/nostra/offline-queue');
  loadAllQueuedMessages = queueMod.loadAllQueuedMessages;

  const identityMod = await import('@lib/nostra/nostr-identity');
  importFromMnemonic = identityMod.importFromMnemonic;

  const cryptoMod = await import('@lib/nostra/nostr-crypto');
  getConversationKey = cryptoMod.getConversationKey;
  nip44Decrypt = cryptoMod.nip44Decrypt;
});

afterAll(() => {
  vi.unmock('@lib/rootScope');
  vi.restoreAllMocks();
});

// ─── Test helpers ────────────────────────────────────────────────────────────

/**
 * Open Nostra.chat DB at version 2 (matches key-storage) with all stores.
 * This avoids version conflicts between test seeding and production code.
 */
function openNostraDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('Nostra.chat', 2);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if(!db.objectStoreNames.contains('identity')) {
        db.createObjectStore('identity', {keyPath: 'id'});
      }
      if(!db.objectStoreNames.contains('nostr-identity')) {
        db.createObjectStore('nostr-identity', {keyPath: 'id'});
      }
      if(!db.objectStoreNames.contains('nostr-keys')) {
        db.createObjectStore('nostr-keys', {keyPath: 'id'});
      }
    };
  });
}

async function seedOldIdentity(record: any): Promise<void> {
  const db = await openNostraDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('identity', 'readwrite');
    const store = tx.objectStore('identity');
    const req = store.put(record);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve();
  });
  db.close();
}

async function getOldIdentity(): Promise<any> {
  const db = await openNostraDB();
  const result = await new Promise<any>((resolve, reject) => {
    const tx = db.transaction('identity', 'readonly');
    const store = tx.objectStore('identity');
    const req = store.get('current');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result || null);
  });
  db.close();
  return result;
}

function openQueueDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('nostra-offline-queue', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if(!db.objectStoreNames.contains('offline-messages')) {
        const store = db.createObjectStore('offline-messages', {keyPath: 'id'});
        store.createIndex('to', 'to', {unique: false});
        store.createIndex('timestamp', 'timestamp', {unique: false});
      }
    };
  });
}

async function seedQueueMessages(messages: any[]): Promise<void> {
  const db = await openQueueDB();
  for(const msg of messages) {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('offline-messages', 'readwrite');
      const store = tx.objectStore('offline-messages');
      const req = store.put(msg);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();
    });
  }
  db.close();
}

async function clearAllStores(): Promise<void> {
  const db = await openNostraDB();
  for(const storeName of ['identity', 'nostr-identity', 'nostr-keys']) {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.clear();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();
    });
  }
  db.close();

  // Also clear offline queue DB
  try {
    const qdb = await openQueueDB();
    await new Promise<void>((resolve, reject) => {
      const tx = qdb.transaction('offline-messages', 'readwrite');
      const store = tx.objectStore('offline-messages');
      const req = store.clear();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();
    });
    qdb.close();
  } catch {
    // Queue DB may not exist yet
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────

const VALID_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function makeOldIdentity(overrides?: any) {
  return {
    id: 'current',
    seed: VALID_MNEMONIC,
    ownId: 'ABCDE.FGHIJ.KLMNO',
    publicKey: 'oldpub',
    privateKey: 'oldpriv',
    encryptionKey: 'oldenc',
    createdAt: Date.now(),
    ...overrides
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('migration', () => {
  beforeEach(async() => {
    await clearAllStores();
  });

  describe('needsMigration', () => {
    it('returns true when old identity store has a record with ownId field', async() => {
      await seedOldIdentity(makeOldIdentity());
      const result = await needsMigration();
      expect(result).toBe(true);
    });

    it('returns false when no old identity exists', async() => {
      const result = await needsMigration();
      expect(result).toBe(false);
    });

    it('returns false when identity already has npub (already migrated)', async() => {
      await seedOldIdentity(makeOldIdentity({npub: 'npub1alreadymigrated'}));
      const result = await needsMigration();
      expect(result).toBe(false);
    });
  });

  describe('migrateOwnIdToNpub', () => {
    it('derives NIP-06 keypair from old seed and saves encrypted identity', async() => {
      await seedOldIdentity(makeOldIdentity());

      const result = await migrateOwnIdToNpub();

      expect(result.migrated).toBe(true);
      expect(result.npub).toBeDefined();
      expect(result.npub!.startsWith('npub1')).toBe(true);

      const stored = await loadEncryptedIdentity();
      expect(stored).not.toBeNull();
      expect(stored!.npub).toBe(result.npub);
      expect(stored!.migratedFrom).toBe('ownid');
      expect(stored!.protectionType).toBe('none');
    });

    it('returns {migrated: false} if no old identity found', async() => {
      const result = await migrateOwnIdToNpub();
      expect(result.migrated).toBe(false);
    });

    it('deletes old identity record after successful migration', async() => {
      await seedOldIdentity(makeOldIdentity());

      await migrateOwnIdToNpub();

      const old = await getOldIdentity();
      expect(old).toBeNull();
    });

    it('preserves old identity on error (no data loss)', async() => {
      await seedOldIdentity(makeOldIdentity({
        seed: 'invalid not a real mnemonic at all nope sorry fail now please'
      }));

      const result = await migrateOwnIdToNpub();
      expect(result.migrated).toBe(false);

      const old = await getOldIdentity();
      expect(old).not.toBeNull();
      expect(old.ownId).toBe('ABCDE.FGHIJ.KLMNO');
    });

    it('re-encrypts pending offline queue messages with NIP-44 using new keypair', async() => {
      const recipientPubHex = '0000000000000000000000000000000000000000000000000000000000000002';

      await seedOldIdentity(makeOldIdentity());
      await seedQueueMessages([
        {
          id: 'oq-1',
          to: recipientPubHex,
          payload: 'Hello from old identity',
          timestamp: Date.now()
        },
        {
          id: 'oq-2',
          to: recipientPubHex,
          payload: 'Already delivered',
          timestamp: Date.now(),
          relayEventId: 'event123'
        }
      ]);

      const result = await migrateOwnIdToNpub();

      expect(result.migrated).toBe(true);
      expect(result.queueReEncrypted).toBe(1);

      // Verify pending message was re-encrypted
      const messages = await loadAllQueuedMessages();
      const reEncrypted = messages.find((m: any) => m.id === 'oq-1');
      expect(reEncrypted).toBeDefined();
      expect(reEncrypted!.payload).not.toBe('Hello from old identity');

      // Verify re-encrypted message is decodeable with new NIP-06 keys
      const newIdentity = importFromMnemonic(VALID_MNEMONIC);
      const convKey = getConversationKey(hexToBytes(newIdentity.privateKey), recipientPubHex);
      const decrypted = nip44Decrypt(reEncrypted!.payload, convKey);
      expect(decrypted).toBe('Hello from old identity');

      // Verify delivered message was NOT re-encrypted
      const delivered = messages.find((m: any) => m.id === 'oq-2');
      expect(delivered).toBeDefined();
      expect(delivered!.payload).toBe('Already delivered');
    });

    it('returns queueReEncrypted count of 0 when no pending messages exist', async() => {
      await seedOldIdentity(makeOldIdentity());

      const result = await migrateOwnIdToNpub();
      expect(result.migrated).toBe(true);
      expect(result.queueReEncrypted).toBe(0);
    });
  });
});
