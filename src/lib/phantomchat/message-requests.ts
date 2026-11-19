/**
 * MessageRequestStore - Unknown sender message request management
 *
 * Holds the per-pubkey block (rejected) / accepted status and answers
 * isKnownContact for the receive path. Since the sender gate
 * (sender-gate.ts) drops every non-contact before anything is stored, no new
 * request rows are created from inbound messages; existing accepted rows
 * still count as contacts and rejected rows still block.
 *
 * DB: phantomchat-message-requests, version 1
 * Store: requests (keyPath: pubkey)
 */

import {hasStoredMapping} from './virtual-peers-db';
import {closeOnVersionChange} from './idb-close-on-versionchange';

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
    // Ensure the cross-tab listener is live BEFORE the first cache read. The
    // listener was previously only wired in setStatus() (a local mutation), so a
    // read-only tab — the common case, since isBlocked runs on every incoming
    // message — never listened and could serve a stale 'none' after another tab
    // blocked the sender. Activating it here (before anything is ever cached)
    // closes that hole: any value we cache is cached with the listener already
    // active, so a later cross-tab mutation always lands. (No-op once wired.)
    this.getChannel();
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
      request.onsuccess = () => resolve(closeOnVersionChange(request.result, () => { this.dbPromise = null; }));

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
   * Check if a pubkey is a known contact: it has a committed row in
   * virtual-peers-db (the contacts list) OR an accepted message request.
   *
   * Do NOT use the bridge's pubkeyCache here. mapPubkeyToPeerId caches every
   * pubkey it ever hashes, so a stranger whose message was merely looked at
   * counted as "known" — together with the receive path persisting a mapping
   * for every sender, that let every stranger into the chat list.
   */
  async isKnownContact(pubkey: string): Promise<boolean> {
    try {
      if(await hasStoredMapping(pubkey)) return true;
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
