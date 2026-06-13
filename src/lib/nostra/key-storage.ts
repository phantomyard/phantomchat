const DB_NAME = 'Nostra.chat';
const DB_VERSION = 2;
const IDENTITY_STORE = 'nostr-identity';
const KEYS_STORE = 'nostr-keys';

export interface EncryptedIdentityRecord {
  id: 'current';
  npub: string;
  displayName?: string;
  nip05?: string;
  protectionType: 'none' | 'pin' | 'passphrase';
  salt?: Uint8Array;
  iv: Uint8Array;
  encryptedKeys: ArrayBuffer;
  wrappingKeyId?: string;
  createdAt: number;
  migratedFrom?: 'ownid';
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if(!db.objectStoreNames.contains('identity')) {
        db.createObjectStore('identity', {keyPath: 'id'});
      }
      if(!db.objectStoreNames.contains(IDENTITY_STORE)) {
        db.createObjectStore(IDENTITY_STORE, {keyPath: 'id'});
      }
      if(!db.objectStoreNames.contains(KEYS_STORE)) {
        db.createObjectStore(KEYS_STORE, {keyPath: 'id'});
      }
    };
  });
}

/**
 * Generate a non-exportable browser-scoped AES-GCM key.
 * The key cannot be extracted and is tied to this browser profile.
 */
export async function generateBrowserScopedKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    {name: 'AES-GCM', length: 256},
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Derive an AES-GCM key from a numeric PIN using PBKDF2 (600,000 iterations).
 */
export async function deriveKeyFromPin(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  return deriveKeyFromSecret(pin, salt);
}

/**
 * Derive an AES-GCM key from a passphrase using PBKDF2 (600,000 iterations).
 */
export async function deriveKeyFromPassphrase(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  return deriveKeyFromSecret(passphrase, salt);
}

async function deriveKeyFromSecret(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 600000,
      hash: 'SHA-256'
    },
    keyMaterial,
    {name: 'AES-GCM', length: 256},
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt seed and nsec with AES-GCM.
 */
export async function encryptKeys(
  data: {seed: string; nsec: string},
  key: CryptoKey
): Promise<{iv: Uint8Array; ciphertext: ArrayBuffer}> {
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv},
    key,
    encoder.encode(JSON.stringify(data))
  );
  return {iv, ciphertext};
}

/**
 * Decrypt AES-GCM encrypted keys.
 * Throws if the key is wrong (AES-GCM authentication failure).
 */
export async function decryptKeys(
  iv: Uint8Array,
  ciphertext: ArrayBuffer,
  key: CryptoKey
): Promise<{seed: string; nsec: string}> {
  const decoder = new TextDecoder();
  const plaintext = await crypto.subtle.decrypt(
    {name: 'AES-GCM', iv},
    key,
    ciphertext
  );
  return JSON.parse(decoder.decode(plaintext));
}

/**
 * Save an encrypted identity record to IndexedDB.
 */
export async function saveEncryptedIdentity(record: EncryptedIdentityRecord): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDENTITY_STORE, 'readwrite');
      const store = tx.objectStore(IDENTITY_STORE);
      const req = store.put(record);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();
    });
  } catch(e) {
    throw new Error('Failed to save encrypted identity: ' + (e as Error).message);
  }
}

/**
 * Load the encrypted identity record from IndexedDB.
 */
export async function loadEncryptedIdentity(): Promise<EncryptedIdentityRecord | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDENTITY_STORE, 'readonly');
      const store = tx.objectStore(IDENTITY_STORE);
      const req = store.get('current');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result || null);
    });
  } catch{
    return null;
  }
}

/**
 * Delete the encrypted identity from IndexedDB.
 */
export async function deleteEncryptedIdentity(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDENTITY_STORE, 'readwrite');
      const store = tx.objectStore(IDENTITY_STORE);
      const req = store.delete('current');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();
    });
  } catch{
    // Ignore IndexedDB errors on delete
  }
}

/**
 * Save a CryptoKey to IndexedDB (structured clone preserves non-exportable keys).
 */
export async function saveBrowserKey(key: CryptoKey): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(KEYS_STORE, 'readwrite');
      const store = tx.objectStore(KEYS_STORE);
      const req = store.put({id: 'browser-key', key});
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();
    });
  } catch(e) {
    throw new Error('Failed to save browser key: ' + (e as Error).message);
  }
}

/**
 * Load a CryptoKey from IndexedDB.
 */
export async function loadBrowserKey(): Promise<CryptoKey | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(KEYS_STORE, 'readonly');
      const store = tx.objectStore(KEYS_STORE);
      const req = store.get('browser-key');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result ? req.result.key : null);
    });
  } catch{
    return null;
  }
}
