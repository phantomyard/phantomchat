/**
 * MessageStore - IndexedDB message cache per conversation
 *
 * Provides persistent storage for decrypted messages, enabling instant
 * chat load without relay queries. Messages are stored per conversation
 * with indexes for efficient retrieval and pagination.
 *
 * DB: phantomchat-messages, version 1
 * Store: messages (auto-increment key, indexes: conversationId, timestamp, eventId)
 */

/**
 * Stored message interface for IndexedDB.
 *
 * IDENTITY-TRIPLE CONTRACT (Phase 2b.1 — see docs/fuzz-reports/FIND-e49755c1/):
 *   - `eventId`, `mid`, `twebPeerId`, `timestamp` are the authoritative identity
 *     of a message row. They MUST be computed ONCE at message creation and are
 *     IMMUTABLE afterwards.
 *   - All write paths supply the full triple. The store never fills identity
 *     fields from fallbacks.
 *   - Read paths consume `row.mid` / `row.timestamp` directly and NEVER recompute
 *     identity from `(eventId, timestamp)` — if a read observes a row without a
 *     mid, that is a bug in the write path and should throw.
 *
 * `PartialStoredMessage` exists ONLY as a narrow escape hatch for the rare
 * in-place update case where a caller spreads an existing row through
 * `saveMessage`. The message-store merges missing fields from the prior row on
 * upsert (see `saveMessage` body). No new write path may introduce rows without
 * `mid` / `twebPeerId`.
 */
export interface StoredMessage {
  /** Nostr event ID (unique) */
  eventId: string;
  /** Deterministic conversation ID (sorted pubkeys joined with ':') */
  conversationId: string;
  /** Sender's hex public key */
  senderPubkey: string;
  /** Message content (plaintext) */
  content: string;
  /** Message type */
  type: 'text' | 'file';
  /** Unix timestamp in seconds — authoritative creation time (immutable) */
  timestamp: number;
  /** Delivery state */
  deliveryState: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  /** File metadata (for type='file', used by Plan 02) */
  fileMetadata?: {
    url: string;
    sha256: string;
    mimeType: string;
    size: number;
    width?: number;
    height?: number;
    keyHex: string;
    ivHex: string;
    duration?: number;
    waveform?: string;
    /** Authoritative sender-tagged media class (image/video/voice/file). */
    mediaType?: 'image' | 'video' | 'voice' | 'file';
  };
  /** tweb message ID (mid) — computed ONCE at creation via mapEventId(eventId, timestamp) */
  mid: number;
  /** tweb numeric peerId used in storageKey (e.g. the sender peerId) */
  twebPeerId: number;
  /** Whether this message was outgoing */
  isOutgoing?: boolean;
  /** Parsed application message ID (chat-XXX-N) — used so read receipts can key off the same ID that delivery receipts use */
  appMessageId?: string;
  /** Unix timestamp (seconds) of the most recent edit. Absent on never-edited messages. */
  editedAt?: number;
  /**
   * tweb mid of the message this row is a reply to, when the rumor carried a
   * NIP-10 `['e', <id>, '', 'reply']` tag. Sender stamps locally before save;
   * receiver resolves the original rumor's stored row to its mid on incoming.
   * Absent on non-reply messages. Surfaces as `messageReplyHeader.reply_to_msg_id`
   * when the row is converted to a tweb Message via phantomchat-peer-mapper.
   */
  replyToMid?: number;
  /**
   * Service message type (e.g. group creation). When set, VMT renders this row
   * as a tweb `messageService` with the corresponding action instead of a
   * regular text bubble. Synthesized locally — never transmitted over the wire.
   */
  serviceType?: 'chatCreate';
  /** Opaque payload for service messages (e.g. title/memberPeerIds for chatCreate). */
  servicePayload?: {
    title?: string;
    memberPeerIds?: number[];
  };
}

/**
 * Narrow escape hatch for writes that update an existing row without
 * supplying the full identity triple. `saveMessage` merges missing
 * `mid` / `twebPeerId` from the prior row. Callers using this type
 * MUST guarantee an existing row is present (i.e. they are patching
 * a row they previously wrote with the full triple).
 */
export type PartialStoredMessage = Omit<StoredMessage, 'mid' | 'twebPeerId'> & {
  mid?: number;
  twebPeerId?: number;
};

// ─── Constants ─────────────────────────────────────────────────────

const DB_NAME = 'phantomchat-messages';
const DB_VERSION = 3;
const STORE_NAME = 'messages';
const CURSOR_STORE = 'read-cursors';
const TOMBSTONE_STORE = 'conversation-tombstones';
const DEFAULT_LIMIT = 50;

// ─── Singleton ─────────────────────────────────────────────────────

let _instance: MessageStore | null = null;

/**
 * Get the singleton MessageStore instance.
 * Lazily opens the IndexedDB on first call.
 */
export function getMessageStore(): MessageStore {
  if(!_instance) {
    _instance = new MessageStore();
  }
  return _instance;
}

// ─── MessageStore ──────────────────────────────────────────────────

/**
 * IndexedDB message cache per conversation.
 */
export class MessageStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  // ─── Per-message read caches (perf, Phase 2) ────────────────────────
  // getTombstone + the getByEventId dedup run on EVERY incoming message. Both
  // are served from memory so a reply burst from one peer doesn't re-hit IDB
  // per message (the main-thread backlog the user's own send queues behind).

  // conversationId → deletion watermark. Written only by set/clearTombstone, so
  // it is owner-contained; a BroadcastChannel propagates deletes across tabs so
  // the "delete boomerang" suppression never goes stale (mirrors the
  // message-requests block cache; listener activated on the READ path).
  private tombstoneCache = new Map<string, number>();
  private tsChannel: BroadcastChannel | null = null;
  private tsChannelInit = false;

  private getTsChannel(): BroadcastChannel | null {
    if(!this.tsChannelInit) {
      this.tsChannelInit = true;
      if(typeof BroadcastChannel !== 'undefined') {
        try {
          // Lives for the page lifetime; closed in destroy() (logout/cleanup).
          this.tsChannel = new BroadcastChannel('phantomchat-tombstones');
          this.tsChannel.onmessage = (e) => {
            const d = e.data as {conversationId?: string; deletedAt?: number};
            if(typeof d?.conversationId !== 'string' || typeof d.deletedAt !== 'number') return;
            if(d.deletedAt === 0) this.tombstoneCache.delete(d.conversationId); // cross-tab clear
            else this.tombstoneCache.set(d.conversationId, Math.max(this.tombstoneCache.get(d.conversationId) ?? 0, d.deletedAt));
          };
        } catch{
          this.tsChannel = null;
        }
      }
    }
    return this.tsChannel;
  }

  // Bounded set of eventIds known to be in IDB — a fast path for the receive
  // dedup so same-session relay replays skip the IDB read. Populated ONLY after
  // a confirmed write / read hit (never speculatively), so a hit always means
  // "definitely persisted" — no false-positive that could drop a real message.
  // Eviction is safe: an evicted id just falls back to the IDB dedup on replay.
  private static readonly SEEN_CAP = 10000;
  private seenEventIds = new Set<string>();

  private markSeen(eventId: string): void {
    if(!eventId || this.seenEventIds.has(eventId)) return;
    this.seenEventIds.add(eventId);
    if(this.seenEventIds.size > MessageStore.SEEN_CAP) {
      // Drop the oldest ~10% (Set preserves insertion order). Deleting during
      // for…of is safe — Set iterators skip entries removed after they're
      // visited (ECMAScript Set iteration spec).
      const drop = Math.floor(MessageStore.SEEN_CAP * 0.1);
      let i = 0;
      for(const k of this.seenEventIds) { this.seenEventIds.delete(k); if(++i >= drop) break; }
    }
  }

  /** Sync dedup fast path: true ⇒ this eventId is definitely already persisted. */
  hasSeenEventId(eventId: string): boolean {
    return this.seenEventIds.has(eventId);
  }

  /** Update the tombstone cache after a local write and tell other tabs.
   *  Monotonic: the watermark only ever moves forward. */
  private setTombstoneCache(conversationId: string, deletedAt: number): void {
    const next = Math.max(this.tombstoneCache.get(conversationId) ?? 0, deletedAt);
    this.tombstoneCache.set(conversationId, next);
    this.getTsChannel()?.postMessage({conversationId, deletedAt: next});
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
          const store = db.createObjectStore(STORE_NAME, {autoIncrement: true});
          store.createIndex('conversationId', 'conversationId', {unique: false});
          store.createIndex('timestamp', 'timestamp', {unique: false});
          store.createIndex('eventId', 'eventId', {unique: true});
        }
        if(!db.objectStoreNames.contains(CURSOR_STORE)) {
          db.createObjectStore(CURSOR_STORE, {keyPath: 'conversationId'});
        }
        // v3: per-conversation deletion watermark ("tombstone"). Keyed by
        // conversationId; value carries `deletedAt` (unix seconds). Used to
        // suppress relay-replayed messages at-or-before the deletion so a
        // deleted chat/contact does not boomerang back on reconnect.
        if(!db.objectStoreNames.contains(TOMBSTONE_STORE)) {
          db.createObjectStore(TOMBSTONE_STORE, {keyPath: 'conversationId'});
        }
      };
    });
  }

  /**
   * Save a message (upsert by eventId).
   * If a message with the same eventId exists, fields from the new write are
   * merged over the existing row with missing `mid`/`twebPeerId`/`isOutgoing`/
   * `editedAt` preserved from the prior row.
   *
   * Accepts `PartialStoredMessage` (mid/twebPeerId optional) so legitimate
   * in-place updates (edit, delivery-state mutations) can spread an existing
   * row and mutate only the fields they care about. For FIRST-time writes the
   * caller MUST supply the full identity triple (mid + twebPeerId + timestamp);
   * otherwise downstream readers will either observe a partial row or fall
   * through to the throw path in VMT.
   */
  async saveMessage(msg: PartialStoredMessage): Promise<void> {
    // Tombstone gate (defense-in-depth). A conversation the user deleted
    // carries a deletion watermark; any message at-or-before that watermark is
    // a relay replay of already-deleted history and must not be re-persisted.
    // Strictly-newer messages (timestamp > watermark) pass through and revive
    // the conversation — timestamp-gated "delete", Signal-style. The receive
    // path (chat-api-receive) applies the same gate earlier to also suppress
    // the UI dispatch; this store-level gate guarantees no write path (backfill,
    // sync, group) can silently re-hydrate a tombstoned conversation.
    if(msg.conversationId && typeof msg.timestamp === 'number') {
      const deletedAt = await this.getTombstone(msg.conversationId);
      if(deletedAt > 0 && msg.timestamp <= deletedAt) {
        return;
      }
    }

    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('eventId');

      // Check if exists
      const getReq = index.getKey(msg.eventId);
      getReq.onsuccess = () => {
        if(getReq.result !== undefined) {
          // Update existing — MERGE fields to preserve mid/twebPeerId/isOutgoing
          // that may have been set by a parallel save (send bridge vs ChatAPI race)
          const readReq = store.get(getReq.result);
          readReq.onsuccess = () => {
            const existing = readReq.result as StoredMessage | undefined;
            const merged = {...(existing || {}), ...msg};
            // Preserve non-null fields from existing record
            if(existing?.mid && !msg.mid) merged.mid = existing.mid;
            if(existing?.twebPeerId && !msg.twebPeerId) merged.twebPeerId = existing.twebPeerId;
            if(existing?.isOutgoing !== undefined && msg.isOutgoing === undefined) merged.isOutgoing = existing.isOutgoing;
            if(existing?.editedAt && !msg.editedAt) merged.editedAt = existing.editedAt;
            const putReq = store.put(merged, getReq.result);
            putReq.onerror = () => reject(putReq.error);
            putReq.onsuccess = () => { this.markSeen(msg.eventId); resolve(); };
          };
          readReq.onerror = () => reject(readReq.error);
        } else {
          // Insert new
          const addReq = store.add(msg);
          addReq.onerror = () => reject(addReq.error);
          addReq.onsuccess = () => { this.markSeen(msg.eventId); resolve(); };
        }
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  /**
   * Fetch all messages for a conversation, sorted newest-first.
   * No limit; used by offset-based pagination where the anchor may be
   * arbitrarily deep in history.
   */
  private async getAllMessagesSorted(conversationId: string): Promise<StoredMessage[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('conversationId');
      const request = index.openCursor(IDBKeyRange.only(conversationId));

      const results: StoredMessage[] = [];

      request.onerror = () => reject(request.error);
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if(cursor) {
          results.push(cursor.value as StoredMessage);
          cursor.continue();
        } else {
          results.sort((a, b) => b.timestamp - a.timestamp);
          resolve(results);
        }
      };
    });
  }

  /**
   * Get messages for a conversation, sorted by timestamp desc.
   *
   * @param conversationId - Deterministic conversation ID
   * @param limit - Max messages to return (default 50)
   * @param before - Optional timestamp for pagination (return messages before this time)
   */
  async getMessages(conversationId: string, limit: number = DEFAULT_LIMIT, before?: number): Promise<StoredMessage[]> {
    const all = await this.getAllMessagesSorted(conversationId);
    const filtered = before ? all.filter(m => m.timestamp < before) : all;
    return filtered.slice(0, limit);
  }

  /**
   * Get messages for a conversation using offset_id/add_offset pagination.
   * Mirrors Telegram's getHistory semantics: `results` are sorted newest-first,
   * `offsetId` is the anchor message, `addOffset` shifts the window away from
   * that anchor, and `limit` caps the returned slice.
   *
   * @param conversationId - Deterministic conversation ID
   * @param limit - Max messages to return
   * @param offsetId - Anchor message id (0 = start from newest)
   * @param addOffset - Positional shift relative to anchor (negative = newer)
   */
  async getMessagesByOffsetId(
    conversationId: string,
    limit: number = DEFAULT_LIMIT,
    offsetId: number = 0,
    addOffset: number = 0
  ): Promise<StoredMessage[]> {
    // Full sorted fetch is required because the IndexedDB schema indexes
    // on timestamp, not mid. A cursor scan is the only way to locate the
    // anchor message by mid before computing the window slice.
    const allMsgs = await this.getAllMessagesSorted(conversationId);
    if(allMsgs.length === 0) return [];

    if(offsetId <= 0) {
      const start = Math.max(0, addOffset);
      return allMsgs.slice(start, start + limit);
    }

    const offsetIndex = allMsgs.findIndex((m) => m.mid === offsetId);
    if(offsetIndex === -1) {
      // Anchor not found — fall back to newest page rather than empty.
      return allMsgs.slice(0, limit);
    }

    const start = Math.max(0, offsetIndex + addOffset);
    return allMsgs.slice(start, start + limit);
  }

  /**
   * Get the latest message timestamp for a conversation.
   * Used as `since` filter for relay backfill.
   *
   * @param conversationId - Deterministic conversation ID
   * @returns Latest timestamp, or 0 if no messages
   */
  async getLatestTimestamp(conversationId: string): Promise<number> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('conversationId');
      const request = index.openCursor(IDBKeyRange.only(conversationId));

      let maxTimestamp = 0;

      request.onerror = () => reject(request.error);
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if(cursor) {
          const msg = cursor.value as StoredMessage;
          if(msg.timestamp > maxTimestamp) {
            maxTimestamp = msg.timestamp;
          }
          cursor.continue();
        } else {
          resolve(maxTimestamp);
        }
      };
    });
  }

  /**
   * Delete messages from a conversation.
   *
   * @param conversationId - Conversation to delete from
   * @param eventIds - Optional specific event IDs to delete. If omitted, deletes all.
   */
  async deleteMessages(conversationId: string, eventIds?: string[]): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('conversationId');
      const request = index.openCursor(IDBKeyRange.only(conversationId));

      const eventIdSet = eventIds ? new Set(eventIds) : null;

      request.onerror = () => reject(request.error);
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if(cursor) {
          const msg = cursor.value as StoredMessage;
          if(!eventIdSet || eventIdSet.has(msg.eventId)) {
            cursor.delete();
          }
          cursor.continue();
        } else {
          resolve();
        }
      };
    });
  }

  /**
   * Delete a single message by its tweb mid (numeric ID).
   */
  async deleteByMid(mid: number): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.openCursor();
      request.onerror = () => reject(request.error);
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if(cursor) {
          const msg = cursor.value as StoredMessage;
          if(msg.mid === mid) {
            cursor.delete();
            resolve();
            return;
          }
          cursor.continue();
        } else {
          resolve(); // Not found — OK
        }
      };
    });
  }

  /**
   * Look up a single message by its tweb numeric mid.
   * Returns null if no row carries this mid.
   *
   * Performs a full scan; intended for low-frequency lookups (edit, delete).
   */
  async getByMid(mid: number): Promise<StoredMessage | null> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.openCursor();
      request.onerror = () => reject(request.error);
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if(cursor) {
          const msg = cursor.value as StoredMessage;
          if(msg.mid === mid) {
            resolve(msg);
            return;
          }
          cursor.continue();
        } else {
          resolve(null);
        }
      };
    });
  }

  /**
   * Look up a single message by its app-level message ID (chat-XXX-N).
   *
   * The app id may live either in the `eventId` column (sender-side rows are
   * keyed by app id) or in the `appMessageId` column (receiver-side rows carry
   * it as a parsed field). This method tries both, eventId first.
   *
   * Used by the edit pipeline so a single lookup works on both sides.
   */
  async getByAppMessageId(appMessageId: string): Promise<StoredMessage | null> {
    const direct = await this.getByEventId(appMessageId);
    if(direct) return direct;

    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.openCursor();
      request.onerror = () => reject(request.error);
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if(cursor) {
          const msg = cursor.value as StoredMessage;
          if(msg.appMessageId === appMessageId) {
            resolve(msg);
            return;
          }
          cursor.continue();
        } else {
          resolve(null);
        }
      };
    });
  }

  /**
   * Look up a single message by its eventId.
   * Returns the stored message or null if not found.
   */
  async getByEventId(eventId: string): Promise<StoredMessage | null> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('eventId');
      const request = index.get(eventId);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const row = (request.result as StoredMessage | undefined) ?? null;
        if(row) this.markSeen(eventId); // confirmed in IDB → fast-path future dedups
        resolve(row);
      };
    });
  }

  /**
   * Re-key a stored row's `eventId` IN PLACE (same primary key), preserving the
   * identity triple (mid/twebPeerId/timestamp) and all other fields. Used after
   * an OFFLINE text send flushes: the row was written under the app message id
   * (`chat-…`) because no rumor id was known yet; once the queue publishes and
   * learns the canonical 64-hex rumor id, we migrate the key so the receiver's
   * delivery receipt (which references the rumor id) resolves to this row and
   * the self-wrap echo dedups against it. `appMessageId` is set to the OLD key
   * so app-level lookups still work. No-op (returns false) if the old row is
   * gone or the new key already exists.
   */
  async reKeyEventId(oldEventId: string, newEventId: string): Promise<boolean> {
    if(!oldEventId || !newEventId || oldEventId === newEventId) return false;
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('eventId');
      const keyReq = index.getKey(oldEventId);
      keyReq.onerror = () => reject(keyReq.error);
      keyReq.onsuccess = () => {
        const primaryKey = keyReq.result;
        if(primaryKey === undefined) {resolve(false); return;}
        // Bail if a row already exists under the new key (avoid a duplicate).
        const existsReq = index.getKey(newEventId);
        existsReq.onerror = () => reject(existsReq.error);
        existsReq.onsuccess = () => {
          if(existsReq.result !== undefined) {resolve(false); return;}
          const readReq = store.get(primaryKey);
          readReq.onerror = () => reject(readReq.error);
          readReq.onsuccess = () => {
            const row = readReq.result as StoredMessage | undefined;
            if(!row) {resolve(false); return;}
            const next: StoredMessage = {...row, eventId: newEventId, appMessageId: row.appMessageId ?? oldEventId};
            const putReq = store.put(next, primaryKey);
            putReq.onerror = () => reject(putReq.error);
            putReq.onsuccess = () => resolve(true);
          };
        };
      };
    });
  }

  /**
   * Get a deterministic conversation ID from two public keys.
   * Sorts both hex pubkeys alphabetically and joins with ':'.
   */
  getConversationId(pubkeyA: string, pubkeyB: string): string {
    return [pubkeyA, pubkeyB].sort().join(':');
  }

  /**
   * Get all distinct conversation IDs from the store.
   * Needed by backfill to know which conversations to query.
   */
  async getAllConversationIds(): Promise<string[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('conversationId');
      const request = index.openKeyCursor(null, 'nextunique');

      const ids: string[] = [];

      request.onerror = () => reject(request.error);
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursor>).result;
        if(cursor) {
          ids.push(cursor.key as string);
          cursor.continue();
        } else {
          resolve(ids);
        }
      };
    });
  }

  /**
   * Read the stored read-cursor for a conversation.
   * Returns 0 when no cursor has ever been written.
   */
  async getReadCursor(conversationId: string): Promise<number> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CURSOR_STORE, 'readonly');
      const store = tx.objectStore(CURSOR_STORE);
      const req = store.get(conversationId);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const row = req.result as {conversationId: string; lastReadMid: number} | undefined;
        resolve(row?.lastReadMid ?? 0);
      };
    });
  }

  /**
   * Upsert the read-cursor for a conversation.
   * Monotonic: a write with `mid` below the stored value is a silent no-op so
   * late-arriving `readHistory` calls from out-of-order bubble scrollers can't
   * walk the cursor backwards.
   */
  async setReadCursor(conversationId: string, mid: number): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CURSOR_STORE, 'readwrite');
      const store = tx.objectStore(CURSOR_STORE);
      const getReq = store.get(conversationId);
      getReq.onerror = () => reject(getReq.error);
      getReq.onsuccess = () => {
        const existing = getReq.result as {conversationId: string; lastReadMid: number} | undefined;
        if(existing && existing.lastReadMid >= mid) {
          resolve();
          return;
        }
        const putReq = store.put({conversationId, lastReadMid: mid});
        putReq.onerror = () => reject(putReq.error);
        putReq.onsuccess = () => resolve();
      };
    });
  }

  /**
   * Read the deletion watermark for a conversation.
   * Returns the unix-seconds timestamp of the most recent deletion, or 0 if the
   * conversation has never been deleted.
   */
  async getTombstone(conversationId: string): Promise<number> {
    // Activate the cross-tab listener before the first cache read so a delete in
    // another tab is never missed (the #29 read-path lesson). Then serve from
    // memory — this runs on every incoming message (and every saveMessage).
    this.getTsChannel();
    const cached = this.tombstoneCache.get(conversationId);
    if(cached !== undefined) return cached;
    const db = await this.getDB();
    const deletedAt = await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(TOMBSTONE_STORE, 'readonly');
      const req = tx.objectStore(TOMBSTONE_STORE).get(conversationId);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve((req.result as {deletedAt: number} | undefined)?.deletedAt ?? 0);
    });
    this.tombstoneCache.set(conversationId, deletedAt);
    return deletedAt;
  }

  /**
   * Set (or extend) the deletion watermark for a conversation.
   * Monotonic: a write with a `deletedAt` below the stored value is a no-op so a
   * re-delete only ever moves the watermark forward. The watermark is a
   * permanent low-water mark — it is intentionally NOT cleared when a newer
   * message revives the conversation, so old replayed history stays suppressed
   * forever while genuinely new messages still get through.
   */
  async setTombstone(conversationId: string, deletedAt: number): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(TOMBSTONE_STORE, 'readwrite');
      const store = tx.objectStore(TOMBSTONE_STORE);
      const getReq = store.get(conversationId);
      getReq.onerror = () => reject(getReq.error);
      getReq.onsuccess = () => {
        const existing = getReq.result as {conversationId: string; deletedAt: number} | undefined;
        if(existing && existing.deletedAt >= deletedAt) {
          this.setTombstoneCache(conversationId, existing.deletedAt); // keep cache fresh
          resolve();
          return;
        }
        const putReq = store.put({conversationId, deletedAt});
        putReq.onerror = () => reject(putReq.error);
        putReq.onsuccess = () => { this.setTombstoneCache(conversationId, deletedAt); resolve(); };
      };
    });
  }

  /**
   * Enumerate every deletion watermark. Used by contacts-sync / groups-sync to
   * DERIVE their CRDT tombstones from reality rather than maintaining a
   * parallel delete log: a DM conversation tombstone whose peer no longer has a
   * live mapping is a deleted contact; a `group:<id>` tombstone whose group is
   * gone is a deleted group. Returns unix-SECONDS deletedAt (the watermark
   * unit), not millis.
   */
  async getAllTombstones(): Promise<Array<{conversationId: string; deletedAt: number}>> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(TOMBSTONE_STORE, 'readonly');
      const req = tx.objectStore(TOMBSTONE_STORE).getAll();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve((req.result as Array<{conversationId: string; deletedAt: number}>) ?? []);
    });
  }

  /**
   * Remove the deletion watermark for a conversation. Rarely needed — provided
   * for an explicit "re-add and resync full history" flow where the caller
   * deliberately wants old messages to flow back in.
   */
  async clearTombstone(conversationId: string): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(TOMBSTONE_STORE, 'readwrite');
      const store = tx.objectStore(TOMBSTONE_STORE);
      const req = store.delete(conversationId);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        this.tombstoneCache.delete(conversationId);
        this.getTsChannel()?.postMessage({conversationId, deletedAt: 0}); // cross-tab clear
        resolve();
      };
    });
  }

  /**
   * Count unread incoming messages in a conversation.
   *
   * Unread = `mid > cursor` AND message is incoming (not authored by `ownPubkey`)
   * AND not a synthetic `contact-init-` seed row. Uses the existing
   * `conversationId` index via `getMessages` for simplicity; caller must not
   * pass conversations with more messages than the soft limit below.
   */
  async countUnread(conversationId: string, ownPubkey: string): Promise<number> {
    const cursor = await this.getReadCursor(conversationId);
    const msgs = await this.getMessages(conversationId, 10000);
    let n = 0;
    for(const m of msgs) {
      if(m.eventId.startsWith('contact-init-')) continue;
      if(m.mid == null || m.mid <= cursor) continue;
      const isOutgoing = m.isOutgoing ?? (m.senderPubkey === ownPubkey);
      if(isOutgoing) continue;
      n++;
    }
    return n;
  }

  async destroy(): Promise<void> {
    if(this.dbPromise) {
      const db = await this.dbPromise;
      db.close();
    }
    this.dbPromise = null;
    // Mirror the IDB close: drop the cross-tab channel + in-memory caches so a
    // post-logout singleton starts clean (review #30).
    try { this.tsChannel?.close(); } catch{ /* ignore */ }
    this.tsChannel = null;
    this.tsChannelInit = false;
    this.tombstoneCache.clear();
    this.seenEventIds.clear();
    _instance = null;
  }
}
