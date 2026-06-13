/**
 * Offline Queue - Encrypted offline message queue with IndexedDB persistence
 *
 * Composes NostrRelayPool to provide offline-first messaging.
 * When the relay pool is disconnected, messages are queued locally
 * and persisted to IndexedDB. When connectivity returns, queued
 * messages are flushed via relayPool.publish().
 *
 * Queued messages are also persisted to IndexedDB so they survive browser
 * restarts (per D029).
 *
 * Usage pattern:
 * ```ts
 * const queue = new OfflineQueue(relayPool);
 * // On send:
 * if (!relayPool.isConnected()) {
 *   queue.queue(recipientPubkey, payload);
 * } else {
 *   relayPool.publish(recipientPubkey, payload);
 * }
 * ```
 */

import {Logger, logger} from '@lib/logger';
import {NostrRelayPool} from './nostr-relay-pool';

/**
 * Queued message structure
 */
export interface QueuedMessage {
  /** Unique message identifier */
  id: string;
  /** Recipient's public key */
  to: string;
  /** Plaintext message content */
  payload: string;
  /** Unix timestamp when queued */
  timestamp: number;
  /** Relay event ID -- set after successful relay publish */
  relayEventId?: string;
  /** Retry count for exponential backoff */
  retryCount?: number;
}

// ─── Exponential Backoff Constants ────────────────────────────────────────
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MULTIPLIER = 2;
const BACKOFF_MAX_MS = 300_000; // 5 minutes
const MAX_RETRY_ATTEMPTS = 20;

// ─── IndexedDB persistence (per D029) ───────────────────────────────────────

const DB_NAME = 'nostra-offline-queue';
const DB_VERSION = 1;
const STORE_NAME = 'offline-messages';

let _dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Get or create the offline-queue IndexedDB singleton.
 */
function getDB(): Promise<IDBDatabase> {
  if(!_dbPromise) {
    _dbPromise = initDB();
  }
  return _dbPromise;
}

/**
 * Initialize the offline-queue IndexedDB and object store.
 */
function initDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);

    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if(!db.objectStoreNames.contains(STORE_NAME)) {
        // Key path: id
        const store = db.createObjectStore(STORE_NAME, {keyPath: 'id'});
        // Index on recipient pubkey for efficient per-peer queries
        store.createIndex('to', 'to', {unique: false});
        // Index on timestamp for ordering
        store.createIndex('timestamp', 'timestamp', {unique: false});
      }
    };
  });
}

/**
 * Load all queued messages from IndexedDB.
 * Exported for migration module access.
 */
export async function loadAllQueuedMessages(): Promise<QueuedMessage[]> {
  return loadFromIndexedDB();
}

/**
 * Save (upsert) a queued message to IndexedDB.
 * Exported for migration module access.
 */
export async function saveQueuedMessage(message: QueuedMessage): Promise<void> {
  return saveToIndexedDB(message);
}

/**
 * Save (upsert) a queued message to IndexedDB.
 */
async function saveToIndexedDB(message: QueuedMessage): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(message);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

/**
 * Delete a queued message from IndexedDB by ID.
 */
async function deleteFromIndexedDB(messageId: string): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(messageId);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

/**
 * Delete all queued messages for a specific peer (or all messages if no peer given).
 * Returns the number of deleted entries.
 */
async function deleteFromIndexedDBByPeer(peerPubkey?: string): Promise<number> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    if(peerPubkey) {
      const index = store.index('to');
      const request = index.openCursor(IDBKeyRange.only(peerPubkey));
      let deleted = 0;
      request.onerror = () => reject(request.error);
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if(cursor) {
          cursor.delete();
          deleted++;
          cursor.continue();
        } else {
          resolve(deleted);
        }
      };
    } else {
      const request = store.clear();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(1);
    }
  });
}

/**
 * Load all queued messages from IndexedDB.
 * Called on OfflineQueue construction to restore persisted messages.
 */
async function loadFromIndexedDB(): Promise<QueuedMessage[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result ?? []);
  });
}

// ─── OfflineQueue ────────────────────────────────────────────────────────────

/**
 * OfflineQueue - Uses NostrRelayPool for offline-first messaging
 *
 * Publishes queued messages via relayPool.publish() when connectivity
 * is available. Messages are persisted to IndexedDB for browser restart
 * survival.
 */
export class OfflineQueue {
  private relayPool: NostrRelayPool;
  private log: Logger;

  /** Queue keyed by recipient pubkey */
  private _queue: Map<string, QueuedMessage[]> = new Map();

  /** Track which relay messages have been acknowledged (already delivered) */
  private _acknowledged: Set<string> = new Set();

  /** Counter for generating message IDs */
  private messageIdCounter = 0;

  /** True once IndexedDB restore has completed in constructor */
  private _initialized = false;

  /**
   * Create a new OfflineQueue
   * @param relayPool - NostrRelayPool instance to use for publishing
   */
  constructor(relayPool: NostrRelayPool) {
    this.relayPool = relayPool;
    this.log = logger('OfflineQueue');

    // Expose for debug inspection
    if(typeof window !== 'undefined') {
      (window as any).__nostraOfflineQueue = this;
    }

    // Restore queued messages from IndexedDB (per D029)
    loadFromIndexedDB()
    .then(messages => {
      for(const msg of messages) {
        const peerQueue = this._queue.get(msg.to) || [];
        peerQueue.push(msg);
        this._queue.set(msg.to, peerQueue);
      }
      this._initialized = true;
      if(messages.length > 0) {
        this.log('[OfflineQueue] restored', messages.length, 'queued message(s) from IndexedDB');
      } else {
        this.log('[OfflineQueue] initialized (no persisted messages)');
      }
    })
    .catch(err => {
      this._initialized = true;
      this.log.warn('[OfflineQueue] failed to restore from IndexedDB:', err, '- continuing with empty queue');
    });

    this.log('[OfflineQueue] initializing…');
  }

  /**
   * Queue a message for offline delivery
   *
   * Stores the message locally and persists to IndexedDB (per D029).
   * If the relay pool is connected, also publishes via relayPool.publish().
   *
   * @param recipientPubkey - Recipient's public key
   * @param payload - Plaintext message content
   * @returns Generated message ID
   */
  async queue(recipientPubkey: string, payload: string): Promise<string> {
    const messageId = this.generateMessageId();
    const timestamp = Date.now();

    this.log('[OfflineQueue] queuing message for:', recipientPubkey.slice(0, 8) + '…', 'id:', messageId);

    let relayEventId: string | undefined;

    // Attempt to publish via relay pool if connected
    try {
      if(this.relayPool.isConnected()) {
        const result = await this.relayPool.publish(recipientPubkey, payload);
        if(result.successes.length > 0) {
          relayEventId = result.successes[0];
          this.log('[OfflineQueue] published to relay pool, event ID:', relayEventId.slice(0, 8) + '…');
        } else {
          this.log('[OfflineQueue] relay pool publish had no successes, message stored locally');
        }
      } else {
        this.log('[OfflineQueue] relay pool not connected, message stored locally only');
      }
    } catch(err) {
      this.log.warn('[OfflineQueue] relay pool publish failed:', err, '- message stored locally only');
    }

    // Store in local queue
    const message: QueuedMessage = {
      id: messageId,
      to: recipientPubkey,
      payload,
      timestamp,
      relayEventId
    };

    const peerQueue = this._queue.get(recipientPubkey) || [];
    peerQueue.push(message);
    this._queue.set(recipientPubkey, peerQueue);

    // Persist to IndexedDB (per D029) — fire and forget; failures are non-fatal
    saveToIndexedDB(message).catch(err => {
      this.log.warn('[OfflineQueue] failed to persist to IndexedDB:', err);
    });

    return messageId;
  }

  /**
   * Flush queued messages for a peer via the relay pool
   *
   * Publishes all queued messages for the specified peer through
   * relayPool.publish() and marks them as acknowledged. Only publishes
   * if the relay pool is connected.
   *
   * @param recipientPubkey - Recipient's public key
   * @returns Number of messages flushed
   */
  async flush(recipientPubkey: string): Promise<number> {
    if(!this.relayPool.isConnected()) {
      this.log.debug('[OfflineQueue] flush skipped: relay pool not connected');
      return 0;
    }

    const peerQueue = this._queue.get(recipientPubkey);
    if(!peerQueue || peerQueue.length === 0) {
      this.log.debug('[OfflineQueue] flush: no messages queued for peer');
      return 0;
    }

    this.log('[OfflineQueue] flushing', peerQueue.length, 'messages for:', recipientPubkey.slice(0, 8) + '…');

    let flushed = 0;

    for(const msg of peerQueue) {
      // Check if message has exceeded max retries
      const retryCount = msg.retryCount || 0;
      if(retryCount >= MAX_RETRY_ATTEMPTS) {
        this.log.warn('[OfflineQueue] message exceeded max retries, marking as failed:', msg.id);
        // Keep in queue for manual retry via retryMessage()
        continue;
      }

      try {
        const result = await this.relayPool.publish(msg.to, msg.payload);
        if(result.successes.length > 0) {
          // Mark as acknowledged so we don't deliver it again
          this.acknowledge(msg.id);
          // Remove from IndexedDB (per D029)
          deleteFromIndexedDB(msg.id).catch(err => {
            this.log.warn('[OfflineQueue] failed to delete from IndexedDB:', err);
          });
          flushed++;
        } else {
          // All relays failed -- increment retry count with exponential backoff
          msg.retryCount = retryCount + 1;
          const delay = Math.min(BACKOFF_BASE_MS * Math.pow(BACKOFF_MULTIPLIER, msg.retryCount), BACKOFF_MAX_MS);
          this.log.debug('[OfflineQueue] publish failed, retry', msg.retryCount, 'next in', delay, 'ms');
          // Persist updated retry count
          saveToIndexedDB(msg).catch((e) => console.debug('[OfflineQueue] IndexedDB persist failed:', e?.message));
          break;
        }
      } catch(err) {
        // Increment retry count on error
        msg.retryCount = retryCount + 1;
        this.log.error('[OfflineQueue] failed to publish queued message:', err);
        // Persist updated retry count
        saveToIndexedDB(msg).catch((e) => console.debug('[OfflineQueue] IndexedDB persist failed:', e?.message));
        break;
      }
    }

    this.log('[OfflineQueue] flushed', flushed, 'messages');

    // Remove flushed messages from queue
    if(flushed > 0) {
      const remaining = peerQueue.filter(msg => !this._acknowledged.has(msg.id));
      if(remaining.length === 0) {
        this._queue.delete(recipientPubkey);
      } else {
        this._queue.set(recipientPubkey, remaining);
      }
    }

    return flushed;
  }

  /**
   * Get queued messages, optionally filtered by peer
   *
   * @param recipientPubkey - Optional recipient pubkey to filter by
   * @returns Array of queued messages
   */
  getQueued(recipientPubkey?: string): QueuedMessage[] {
    if(recipientPubkey) {
      const queue = this._queue.get(recipientPubkey);
      if(!queue) return [];
      // Only return unacknowledged messages
      return queue.filter(msg => !this._acknowledged.has(msg.id));
    }

    // Return all unacknowledged messages
    const all: QueuedMessage[] = [];
    for(const [, messages] of this._queue) {
      for(const msg of messages) {
        if(!this._acknowledged.has(msg.id)) {
          all.push(msg);
        }
      }
    }
    return all;
  }

  /**
   * Return the number of unacknowledged queued messages.
   *
   * @param recipientPubkey - Optional recipient pubkey to filter by
   * @returns Count of unacknowledged messages
   */
  getQueueSize(recipientPubkey?: string): number {
    return this.getQueued(recipientPubkey).length;
  }

  /**
   * Clear queued messages from memory and IndexedDB.
   *
   * @param recipientPubkey - Optional recipient pubkey to filter by. If omitted,
   *                          clears all queued messages.
   */
  async clearQueue(recipientPubkey?: string): Promise<void> {
    if(recipientPubkey) {
      const count = this.getQueueSize(recipientPubkey);
      this._queue.delete(recipientPubkey);
      await deleteFromIndexedDBByPeer(recipientPubkey);
      this.log('[OfflineQueue] cleared', count, 'message(s) for peer:', recipientPubkey.slice(0, 8) + '…');
    } else {
      const total = this.getQueueSize();
      this._queue.clear();
      await deleteFromIndexedDBByPeer();
      this.log('[OfflineQueue] cleared all', total, 'queued message(s)');
    }
  }

  /**
   * Retry a specific message that has exceeded max retries.
   * Resets the retry count and attempts to publish immediately.
   *
   * @param messageId - The message ID to retry
   * @returns true if the message was found and retried
   */
  async retryMessage(messageId: string): Promise<boolean> {
    for(const [, messages] of this._queue) {
      const msg = messages.find(m => m.id === messageId);
      if(msg) {
        msg.retryCount = 0;
        // Persist reset
        saveToIndexedDB(msg).catch((e) => console.debug('[OfflineQueue] IndexedDB persist failed:', e?.message));

        if(this.relayPool.isConnected()) {
          try {
            const result = await this.relayPool.publish(msg.to, msg.payload);
            if(result.successes.length > 0) {
              this.acknowledge(msg.id);
              deleteFromIndexedDB(msg.id).catch((e) => console.debug('[OfflineQueue] IndexedDB delete failed:', e?.message));
              return true;
            }
          } catch{
            // Will be retried on next flush
          }
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Mark a relay message as acknowledged (already delivered)
   *
   * @param messageId - The message ID to acknowledge
   */
  acknowledge(messageId: string): void {
    this._acknowledged.add(messageId);
    this.log.debug('[OfflineQueue] acknowledged message:', messageId);
  }

  /**
   * Generate a unique message ID
   */
  private generateMessageId(): string {
    return `oq-${Date.now()}-${this.messageIdCounter++}`;
  }

  /**
   * Clean up — clear internal state
   */
  destroy(): void {
    this._queue.clear();
    this._acknowledged.clear();
  }
}

/**
 * Create an OfflineQueue instance with a NostrRelayPool
 *
 * @param relayPool - NostrRelayPool instance
 */
export function createOfflineQueue(relayPool: NostrRelayPool): OfflineQueue {
  return new OfflineQueue(relayPool);
}
