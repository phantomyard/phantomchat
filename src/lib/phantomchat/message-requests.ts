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
 * DB: phantomchat-message-requests, version 1
 * Store: requests (keyPath: pubkey)
 */

import {getDB as getVirtualPeersDB} from './virtual-peers-db';
import {PhantomChatBridge} from './phantomchat-bridge';

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

const DB_NAME = 'phantomchat-message-requests';
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

  // ─── In-memory status cache (perf) ──────────────────────────────────
  // isBlocked + isKnownContact run on EVERY incoming message and the request
  // status changes only via this store's own mutations. Cache the per-pubkey
  // status in memory so a reply burst from one peer pays the IDB read once, not
  // per message. A BroadcastChannel propagates mutations across tabs so block
  // enforcement never goes stale (each tab owns its own instance + cache).
  // 'none' is cached for "no request row" so a negative result is also O(1).
  private statusCache = new Map<string, MessageRequest['status'] | 'none'>();
  private channel: BroadcastChannel | null = null;
  private channelInit = false;

  private getChannel(): BroadcastChannel | null {
    if(!this.channelInit) {
      this.channelInit = true;
      if(typeof BroadcastChannel !== 'undefined') {
        try {
          this.channel = new BroadcastChannel('phantomchat-message-requests');
          this.channel.onmessage = (e) => {
            const data = e.data as {pubkey?: string; status?: MessageRequest['status'] | 'none'};
            if(typeof data?.pubkey === 'string' && data.status) {
              this.statusCache.set(data.pubkey, data.status);
            }
          };
        } catch{
          this.channel = null;
        }
      }
    }
    return this.channel;
  }

  /**
   * Resolve a pubkey's request status, served from the in-memory cache when
   * present (these run per incoming message). A cold miss reads IDB once and
   * memoizes — including 'none' for "no row", so negatives are O(1) too.
   */
  private async getStatus(pubkey: string): Promise<MessageRequest['status'] | 'none'> {
    const cached = this.statusCache.get(pubkey);
    if(cached !== undefined) return cached;
    const db = await this.getDB();
    const status = await new Promise<MessageRequest['status'] | 'none'>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(pubkey);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve((req.result as MessageRequest | undefined)?.status ?? 'none');
    });
    this.statusCache.set(pubkey, status);
    return status;
  }

  /** Update the cache after a local mutation and tell other tabs. */
  private setStatus(pubkey: string, status: MessageRequest['status']): void {
    this.statusCache.set(pubkey, status);
    this.getChannel()?.postMessage({pubkey, status});
  }

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
        putReq.onsuccess = () => { this.setStatus(pubkey, 'pending'); resolve(); };
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
        putReq.onsuccess = () => { this.setStatus(pubkey, 'accepted'); resolve(); };
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
          putReq.onsuccess = () => { this.setStatus(pubkey, 'rejected'); resolve(); };
          return;
        }

        existing.status = 'rejected';
        const putReq = store.put(existing);
        putReq.onerror = () => reject(putReq.error);
        putReq.onsuccess = () => { this.setStatus(pubkey, 'rejected'); resolve(); };
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
    // Fast path: a peer already mapped in the bridge's in-memory pubkeyCache is
    // a known contact — skip IndexedDB entirely on every message from a known
    // sender (the reply-burst case). A miss falls through to the authoritative
    // virtual-peers-db read below, so correctness is unchanged.
    try {
      if(PhantomChatBridge.getInstance().hasPeerMapping(pubkey)) return true;
    } catch{
      // bridge not ready — fall through to the DB checks
    }

    // Authoritative: check virtual-peers-db for a mapping.
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

    // Finally, an accepted message request also counts as known (cached).
    return (await this.getStatus(pubkey)) === 'accepted';
  }

  /**
   * Check if a pubkey is blocked (rejected request).
   */
  async isBlocked(pubkey: string): Promise<boolean> {
    return (await this.getStatus(pubkey)) === 'rejected';
  }

  async destroy(): Promise<void> {
    if(this.dbPromise) {
      const db = await this.dbPromise;
      db.close();
    }
    this.dbPromise = null;
    this.statusCache.clear();
    try { this.channel?.close(); } catch{ /* ignore */ }
    this.channel = null;
    this.channelInit = false;
    _instance = null;
  }
}
