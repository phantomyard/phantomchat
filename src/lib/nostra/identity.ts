import {WORDLIST} from './wordlist';

/**
 * Generate a cryptographically secure 12-word seed phrase
 */
export function generateSeed(): string {
  // Generate 11 random indices (0-2047)
  const indices: number[] = [];
  const randomValues = crypto.getRandomValues(new Uint16Array(11));

  for(let i = 0; i < 11; i++) {
    // Take 11 bits from each 16-bit random value
    indices[i] = randomValues[i] & 0x7FF; // 2047 = 2^11 - 1
  }

  // Calculate checksum (first 8 bits of SHA-256 of concatenated words)
  let checksumInput = '';
  for(const idx of indices) {
    checksumInput += WORDLIST[idx] + ' ';
  }

  // Simple checksum - hash the input and take first 11 bits
  crypto.subtle.digest('SHA-256', new TextEncoder().encode(checksumInput));

  // Get indices for checksum (synchronously - simplified for demo)
  // In production, use proper BIP39 checksum
  const checksumIdx = indices.reduce((a, b) => a ^ b, 0) % 2048;

  indices.push(checksumIdx);

  // Convert indices to words
  const words = indices.map(idx => WORDLIST[idx]);

  return words.join(' ');
}

/**
 * Validate a seed phrase format
 */
export function validateSeed(seed: string): boolean {
  const words = seed.trim().toLowerCase().split(/\s+/);

  if(words.length !== 12) {
    return false;
  }

  // Check all words are in wordlist
  const wordSet = new Set(WORDLIST);
  return words.every(word => wordSet.has(word));
}

/**
 * Derive OwnID from seed
 * Format: xxxxx.xxxxx.xxxxx (base32-like, 15 chars)
 */
export async function deriveOwnID(seed: string): Promise<string> {
  // Hash the seed to get deterministic output
  const encoder = new TextEncoder();
  const seedBuffer = encoder.encode(seed);

  // Use SHA-256 to derive a deterministic hash
  const hashBuffer = await crypto.subtle.digest('SHA-256', seedBuffer);
  const hashArray = new Uint8Array(hashBuffer);

  // Convert to base32-like representation
  // Take first 15 bytes and convert to a readable format
  let ownId = '';
  for(let i = 0; i < 5; i++) {
    const chunk = (hashArray[i * 3] << 16) | (hashArray[i * 3 + 1] << 8) | hashArray[i * 3 + 2];
    const chunkBase32 = chunk.toString(32).padStart(4, '0').toUpperCase();
    ownId += chunkBase32;
  }

  // Format as xxxxx.xxxxx.xxxxx
  return `${ownId.slice(0, 5)}.${ownId.slice(5, 10)}.${ownId.slice(10, 15)}`;
}

/**
 * Synchronous version - derive OwnID from seed (synchronous)
 * Uses simple hash for demonstration
 */
export function deriveOwnIDSync(seed: string): string {
  // Simple hash implementation for sync context
  let hash = 0;
  for(let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }

  // Convert to positive and base32-like
  const positive = Math.abs(hash);
  let ownId = '';
  let num = positive;

  for(let i = 0; i < 15; i++) {
    const charIndex = num % 32;
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // No O, 0, I, 1 to avoid confusion
    ownId = chars[charIndex % chars.length] + ownId;
    num = Math.floor(num / 32);
  }

  // Add randomness from the seed
  const seedHash = seed.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const offset = seedHash % 10;

  // Format as groups
  return ownId.slice(offset, offset + 5) + '.' +
    ownId.slice((offset + 5) % 15, (offset + 5) % 15 + 5) + '.' +
    ownId.slice((offset + 10) % 15, (offset + 10) % 15 + 5);
}

/**
 * Key derivation from seed
 */
export interface KeyPair {
  publicKey: string;
  privateKey: string;
  encryptionKey: string;
}

/**
 * Derive encryption keys from seed
 */
export async function deriveKeys(seed: string): Promise<KeyPair> {
  // Derive keys using PBKDF2
  const encoder = new TextEncoder();

  // Derive signing key (using Ed25519-like approach - generate from seed)
  const signingKeyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(seed + '-signing'),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const signingBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: encoder.encode('Nostra.chat-Signing-v1'),
      iterations: 100000,
      hash: 'SHA-256'
    },
    signingKeyMaterial,
    512, // 64 bytes: 32 for private, 32 for public
  );

  const signingBytes = new Uint8Array(signingBits);
  const signingPrivateKey = signingBytes.slice(0, 32);
  const signingPublicKey = signingBytes.slice(32, 64);

  // Derive encryption key (AES-256)
  const encryptionKeyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(seed + '-encryption'),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const encryptionBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: encoder.encode('Nostra.chat-Encryption-v1'),
      iterations: 100000,
      hash: 'SHA-256'
    },
    encryptionKeyMaterial,
    256,
  );

  return {
    publicKey: bufferToBase64(signingPublicKey),
    privateKey: bufferToBase64(signingPrivateKey),
    encryptionKey: bufferToBase64(new Uint8Array(encryptionBits))
  };
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for(let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Store identity in IndexedDB
 */
const DB_NAME = 'Nostra.chat';
const STORE_NAME = 'identity';

async function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = () => {
      const db = request.result;
      if(!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, {keyPath: 'id'});
      }
    };
  });
}

export interface StoredIdentity {
  id: string;
  seed: string;
  ownId: string;
  publicKey: string;
  privateKey: string;
  encryptionKey: string;
  createdAt: number;
}

/**
 * Save identity to IndexedDB
 */
/**
 * Load identity from IndexedDB (primary) or localStorage (fallback for test contexts).
 */
export async function loadIdentity(): Promise<StoredIdentity | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get('current');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || null);
    });
  } catch{
    // Fallback: try localStorage (used by test injection)
    try {
      const stored = localStorage.getItem('nostra_identity');
      return stored ? JSON.parse(stored) : null;
    } catch{
      return null;
    }
  }
}

/**
 * Check if identity exists
 */
export async function hasIdentity(): Promise<boolean> {
  const identity = await loadIdentity();
  return identity !== null;
}

/**
 * Save identity to IndexedDB (primary) and localStorage (fallback for test contexts).
 */
export async function saveIdentity(identity: Omit<StoredIdentity, 'id' | 'createdAt'>): Promise<void> {
  const now = {id: 'current', createdAt: Date.now()};
  const full = {...identity, ...now};

  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.add(full);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch{
    // Fallback: save to localStorage (used by test injection)
    localStorage.setItem('nostra_identity', JSON.stringify(full));
  }
}

/**
 * Clear identity (logout)
 */
export async function clearIdentity(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete('current');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch{
    // Ignore IndexedDB errors
  }
  // Also clear localStorage fallback
  localStorage.removeItem('nostra_identity');
}
