/**
 * MessageRequestStore - Unknown sender message request management
 *
 * Manages incoming messages from unknown pubkeys. Messages from senders
 * not in the virtual-peers-db (not yet a contact) go to a "Richieste"
 * (Requests) section rather than the main chat list.
 *
 * Users can accept (move to main chat) or reject (block future messages)
 * message requests from unknown senders.
 *
 * DB: nostra-message-requests, version 1
 * Store: requests (keyPath: pubkey)
 */

import {getDB as getVirtualPeersDB} from './virtual-peers-db';

// ─── Types ────────────────────────────────────────────────────────

export interface MessageRequest {
  /** Nostr hex public key of the sender */
  pubkey: string;
  /** First message content from this sender */
  firstMessage: string;
  /** Timestamp when first message was received */
  timestamp: number;
  /** Request status */
  status: 'pending' | 'accepted' | 'rejected';
}

// ─── Constants ────────────────────────────────────────────────────

const DB_NAME = 'nostra-message-requests';
const DB_VERSION = 1;
const STORE_NAME = 'requests';

// ─── Singleton ────────────────────────────────────────────────────

let _instance: MessageRequestStore | null = null;

/**
 * Get the singleton MessageRequestStore instance.
 */
export function getMessageRequestStore(): MessageRequestStore {
  if(!_instance) {
    _instance = new MessageRequestStore();
  }
  return _instance;
}

// ─── MessageRequestStore ──────────────────────────────────────────

export class MessageRequestStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  /**
   * Get or open the IndexedDB database.
   */
  private getDB(): Promise<IDBDatabase> {
    if(!this.dbPromise) {
      this.dbPromise = this.openDB();
    }
    return this.dbPromise;
  }

  /**
   * Open the IndexedDB database.
   */
  private openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if(!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, {keyPath: 'pubkey'});
        }
      };
    });
  }

  /**
   * Add a message request from an unknown sender.
   * If pubkey already exists and was rejected (blocked), silently ignore.
   * If pubkey already exists as pending/accepted, no-op.
   */
  async addRequest(pubkey: string, message: string, timestamp: number): Promise<void> {
    const db = await this.getDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      const getReq = store.get(pubkey);
      getReq.onsuccess = () => {
        const existing = getReq.result as MessageRequest | undefined;

        // If already rejected (blocked) or already exists, do nothing
        if(existing) {
          resolve();
          return;
        }

        const request: MessageRequest = {
          pubkey,
          firstMessage: message,
          timestamp,
          status: 'pending'
        };

        const putReq = store.put(request);
        putReq.onerror = () => reject(putReq.error);
        putReq.onsuccess = () => resolve();
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  /**
   * Get all pending message requests.
   */
  async getRequests(): Promise<MessageRequest[]> {
    const db = await this.getDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const all = request.result as MessageRequest[];
        resolve(all.filter((r) => r.status === 'pending'));
      };
    });
  }

  /**
   * Get count of pending message requests (for badge display).
   */
  async getPendingCount(): Promise<number> {
    const requests = await this.getRequests();
    return requests.length;
  }

  /**
   * Accept a message request. Changes status to 'accepted'.
   * The caller moves the conversation to the main chat list.
   */
  async acceptRequest(pubkey: string): Promise<void> {
    const db = await this.getDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      const getReq = store.get(pubkey);
      getReq.onsuccess = () => {
        const existing = getReq.result as MessageRequest | undefined;
        if(!existing) {
          resolve();
          return;
        }

        existing.status = 'accepted';
        const putReq = store.put(existing);
        putReq.onerror = () => reject(putReq.error);
        putReq.onsuccess = () => resolve();
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  /**
   * Reject a message request. Changes status to 'rejected'.
   * Blocks future messages from this pubkey.
   */
  async rejectRequest(pubkey: string): Promise<void> {
    const db = await this.getDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      const getReq = store.get(pubkey);
      getReq.onsuccess = () => {
        const existing = getReq.result as MessageRequest | undefined;
        if(!existing) {
          // Create a rejected entry to block future messages
          const request: MessageRequest = {
            pubkey,
            firstMessage: '',
            timestamp: Math.floor(Date.now() / 1000),
            status: 'rejected'
          };
          const putReq = store.put(request);
          putReq.onerror = () => reject(putReq.error);
          putReq.onsuccess = () => resolve();
          return;
        }

        existing.status = 'rejected';
        const putReq = store.put(existing);
        putReq.onerror = () => reject(putReq.error);
        putReq.onsuccess = () => resolve();
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  /**
   * Check if a pubkey is a known contact.
   * Returns true if pubkey exists in virtual-peers-db (mapped to a peerId)
   * OR has an accepted message request.
   */
  async isKnownContact(pubkey: string): Promise<boolean> {
    // Check virtual-peers-db first
    try {
      const vpDb = await getVirtualPeersDB();
      const tx = vpDb.transaction('mappings', 'readonly');
      const store = tx.objectStore('mappings');

      const exists = await new Promise<boolean>((resolve) => {
        // keyPath is 'pubkey', so use store.get() directly
        const request = store.get(pubkey);
        request.onsuccess = () => resolve(!!request.result);
        request.onerror = () => resolve(false);
      });

      if(exists) return true;
    } catch{
      // virtual-peers-db not available, fall through to request check
    }

    // Check message requests for accepted status
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(pubkey);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const result = request.result as MessageRequest | undefined;
        resolve(result?.status === 'accepted');
      };
    });
  }

  /**
   * Check if a pubkey is blocked (rejected request).
   */
  async isBlocked(pubkey: string): Promise<boolean> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(pubkey);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const result = request.result as MessageRequest | undefined;
        resolve(result?.status === 'rejected');
      };
    });
  }

  async destroy(): Promise<void> {
    if(this.dbPromise) {
      const db = await this.dbPromise;
      db.close();
    }
    this.dbPromise = null;
    _instance = null;
  }
}
