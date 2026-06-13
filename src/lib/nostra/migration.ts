/**
 * OwnID-to-npub silent migration module.
 *
 * Reads the old Nostra.chat/identity store, derives a NIP-06 keypair from
 * the stored seed, encrypts and saves to the new nostr-identity store,
 * re-encrypts pending offline queue messages with NIP-44, then deletes
 * the old identity record.
 *
 * On error, the old identity is preserved (no data loss).
 */

import {importFromMnemonic} from '@lib/nostra/nostr-identity';
import {
  generateBrowserScopedKey,
  encryptKeys,
  saveEncryptedIdentity,
  saveBrowserKey,
  EncryptedIdentityRecord
} from '@lib/nostra/key-storage';
import {loadAllQueuedMessages, saveQueuedMessage} from '@lib/nostra/offline-queue';
import {nip44Encrypt, getConversationKey} from '@lib/nostra/nostr-crypto';
import {hexToBytes} from 'nostr-tools/utils';
import rootScope from '@lib/rootScope';

export interface MigrationResult {
  npub?: string;
  migrated: boolean;
  queueReEncrypted?: number;
}

// ─── Direct old-store access ─────────────────────────────────────────────────
// We access the old Nostra.chat/identity store directly (not via identity.ts)
// to ensure we close the v1 connection before key-storage opens at v2.

const OLD_DB_NAME = 'Nostra.chat';
const OLD_STORE_NAME = 'identity';

interface OldIdentityRecord {
  id: string;
  seed: string;
  ownId: string;
  publicKey: string;
  privateKey: string;
  encryptionKey: string;
  npub?: string;
  createdAt: number;
}

/**
 * Read old identity from Nostra.chat/identity store and close the connection.
 * Opens without specifying a version to avoid conflicts with key-storage's v2.
 */
async function readOldIdentity(): Promise<OldIdentityRecord | null> {
  return new Promise((resolve, reject) => {
    // Open without version — uses current version (1 or 2)
    const request = indexedDB.open(OLD_DB_NAME);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if(!db.objectStoreNames.contains(OLD_STORE_NAME)) {
        db.close();
        resolve(null);
        return;
      }
      const tx = db.transaction(OLD_STORE_NAME, 'readonly');
      const store = tx.objectStore(OLD_STORE_NAME);
      const getReq = store.get('current');
      getReq.onerror = () => {
        db.close();
        reject(getReq.error);
      };
      getReq.onsuccess = () => {
        db.close();
        resolve(getReq.result || null);
      };
    };
  });
}

/**
 * Delete old identity record from Nostra.chat/identity store and close.
 */
async function deleteOldIdentity(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OLD_DB_NAME);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if(!db.objectStoreNames.contains(OLD_STORE_NAME)) {
        db.close();
        resolve();
        return;
      }
      const tx = db.transaction(OLD_STORE_NAME, 'readwrite');
      const store = tx.objectStore(OLD_STORE_NAME);
      const delReq = store.delete('current');
      delReq.onerror = () => {
        db.close();
        reject(delReq.error);
      };
      delReq.onsuccess = () => {
        db.close();
        resolve();
      };
    };
  });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Check if a migration from OwnID to npub is needed.
 * Returns true when the old identity store has a record with ownId
 * but no npub field.
 */
export async function needsMigration(): Promise<boolean> {
  try {
    const old = await readOldIdentity();
    if(!old) return false;
    return !!old.ownId && !old.npub;
  } catch{
    return false;
  }
}

/**
 * Silently migrate an existing OwnID identity to npub.
 *
 * Steps:
 * 1. Load old identity (seed + ownId) and close v1 connection
 * 2. Derive NIP-06 keypair from seed (different keys than PBKDF2-derived)
 * 3. Encrypt new keys with browser-scoped CryptoKey
 * 4. Save encrypted identity to new store with migratedFrom: 'ownid'
 * 5. Re-encrypt pending offline queue messages with NIP-44
 * 6. Delete old identity record
 *
 * On error, the old identity is NOT deleted (safety).
 */
export async function migrateOwnIdToNpub(): Promise<MigrationResult> {
  try {
    // (a) Load old identity (connection closed after read)
    const old = await readOldIdentity();
    if(!old || !old.ownId) {
      return {migrated: false};
    }
    if(old.npub) {
      return {migrated: false};
    }

    // (b) Extract seed
    const seed = old.seed;
    if(!seed) {
      return {migrated: false};
    }

    // (c) Derive NIP-06 keypair (different keys than old PBKDF2-derived keys)
    const newIdentity = importFromMnemonic(seed);

    // (d) Generate browser-scoped CryptoKey
    const browserKey = await generateBrowserScopedKey();

    // (e) Encrypt {seed, nsec}
    const {iv, ciphertext} = await encryptKeys(
      {seed: newIdentity.mnemonic, nsec: newIdentity.nsec},
      browserKey
    );

    // (f) Save CryptoKey
    await saveBrowserKey(browserKey);

    // (g) Build EncryptedIdentityRecord
    const record: EncryptedIdentityRecord = {
      id: 'current',
      npub: newIdentity.npub,
      protectionType: 'none',
      iv,
      encryptedKeys: ciphertext,
      migratedFrom: 'ownid',
      createdAt: Date.now()
    };

    // (h) Save encrypted identity
    await saveEncryptedIdentity(record);

    // (i) Re-encrypt offline queue messages
    let queueReEncrypted = 0;
    try {
      const messages = await loadAllQueuedMessages();
      const pending = messages.filter(m => !m.relayEventId);

      for(const msg of pending) {
        const privKeyBytes = hexToBytes(newIdentity.privateKey);
        const convKey = getConversationKey(privKeyBytes, msg.to);
        const encrypted = nip44Encrypt(msg.payload, convKey);
        msg.payload = encrypted;
        await saveQueuedMessage(msg);
        queueReEncrypted++;
      }
    } catch(err) {
      // Queue re-encryption failure is non-fatal
      console.warn('[migration] offline queue re-encryption failed:', err);
    }

    // (j) Delete old identity
    await deleteOldIdentity();

    // (k) Dispatch identity loaded event
    try {
      rootScope.dispatchEvent('nostra_identity_loaded', {
        npub: newIdentity.npub,
        displayName: undefined,
        nip05: undefined,
        protectionType: 'none'
      });
    } catch{
      // Non-fatal: event dispatch may fail in test/worker contexts
    }

    // (l) Return result
    return {npub: newIdentity.npub, migrated: true, queueReEncrypted};
  } catch(err) {
    // On error, do NOT delete old identity (safety)
    console.error('[migration] OwnID-to-npub migration failed:', err);
    return {migrated: false};
  }
}
