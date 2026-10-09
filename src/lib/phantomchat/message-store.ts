/**
 * MessageStore - IndexedDB message cache per conversation
 *
 * Provides persistent storage for decrypted messages, enabling instant
 * chat load without relay queries. Messages are stored per conversation
 * with indexes for efficient retrieval and pagination.
 *
 * DB: phantomchat-messages, version 5
 * Store: messages (auto-increment key, indexes: conversationId, timestamp, eventId,
 *        conversationTimestamp [v4, composite — drives retention pruning],
 *        conversationMid [v5, composite — drives anchor paging])
 *
 * Retention: each conversation is capped at MESSAGE_CAP_PER_CHAT rows (default
 * 500). On every INSERT (not upsert-update) the store prunes the oldest rows
 * by timestamp beyond the cap, keeping read cost bounded (closes #107).
 * Insert + count + prune run in ONE readwrite transaction, so retention is
 * failure-atomic — a prune failure aborts the insert with it.
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
 *     identity from `(eventId, timestamp)`. Legacy rows without a mid are skipped
 *     by indexed history reads and reported loudly instead of taking down the
 *     whole conversation.
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
  /**
   * Millisecond-of-second (0-999) of creation, from the rumor's `ms` tag.
   * Feeds the sub-second half of `mid` so same-second messages sort
   * chronologically instead of by hash. Absent on legacy rows written before
   * the ms tag existed — those keep the legacy hash tiebreak, so any code that
   * RE-derives a mid from this row must pass this field through verbatim
   * (undefined included) or it will compute a different mid and fork the row.
   */
  msSlot?: number;
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
    /** Multi-mirror Blossom URLs (primary first). */
    servers?: string[];
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
const DB_VERSION = 6;
const STORE_NAME = 'messages';

/**
 * Per-conversation retention cap. Once a conversation exceeds this many rows,
 * the oldest (by timestamp) are pruned on the next insert. Keeps
 * `getAllMessagesSorted` (full-conversation scan) bounded at O(cap).
 */
export const MESSAGE_CAP_PER_CHAT = 500;
const CURSOR_STORE = 'read-cursors';
const TOMBSTONE_STORE = 'conversation-tombstones';
/** One-shot data migrations, keyed by name. See `migrateLegacyGroupConversationKeys`. */
const MIGRATION_STORE = 'migrations';
const DEFAULT_LIMIT = 50;

/**
 * Marker name for the #207 group conversation-key migration. Persisted once the
 * bare→canonical group-key sweep has completed, so the seed-it-to-top-mid step
 * runs exactly once per install and a group created AFTER the fix is never
 * force-read on a later boot.
 */
export const GROUP_KEY_MIGRATION = 'group-207-canonical-key-v1';

/**
 * Companion records for GROUP_KEY_MIGRATION, so a partially-failed sweep can
 * resume without re-sweeping groups it already finished (#209).
 *
 * - COHORT: the group-id set captured on the FIRST attempt. Ids that only show
 *   up on a later boot (a group created after the fix) are never swept, so a
 *   retry cannot force-read them.
 * - DONE: group ids already migrated (rekeyed + cursor-seeded). A group is
 *   never swept twice, so messages that arrive during a retry window are not
 *   force-read by a second unconditional seed.
 * - CEILING: immutable per-group seed ceiling (`{groupId: topMid}`, captured
 *   before the group is touched). Persisted BEFORE the rekey/seed so a crash or
 *   a failed DONE write between the two cannot make a retry recompute a higher
 *   top and advance the cursor past messages that arrived in the window
 *   (review #211).
 */
export const GROUP_KEY_MIGRATION_COHORT = `${GROUP_KEY_MIGRATION}:cohort`;
export const GROUP_KEY_MIGRATION_DONE = `${GROUP_KEY_MIGRATION}:done`;
export const GROUP_KEY_MIGRATION_CEILING = `${GROUP_KEY_MIGRATION}:ceiling`;

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
export interface MessageStoreOptions {
  /**
   * Retention cap per conversation (default MESSAGE_CAP_PER_CHAT = 500).
   * Pass `Infinity` (or <= 0) to disable pruning. Exposed mainly for tests
   * and future per-chat settings.
   */
  messageCap?: number;
}

export class MessageStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private readonly messageCap: number;

  constructor(options: MessageStoreOptions = {}) {
    this.messageCap = options.messageCap ?? MESSAGE_CAP_PER_CHAT;
  }

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
      // Guards against double-settling when `onblocked` fires and the request
      // later resolves anyway (the blocker eventually closes).
      let settled = false;

      request.onerror = () => {
        if(settled) return;
        settled = true;
        reject(request.error);
      };

      request.onsuccess = () => {
        const db = request.result;
        if(settled) { db.close(); return; } // blocked-then-resolved: discard the stale handle
        settled = true;
        // When another tab/context opens a HIGHER version (v5→v6 and future
        // bumps), close this connection so it does not block that upgrade —
        // otherwise the other context's getDB() waits on `onblocked` forever.
        db.onversionchange = () => {
          db.close();
          if(this.dbPromise) this.dbPromise = null; // reopen lazily at the new version
        };
        resolve(db);
      };

      // OUR upgrade is blocked by another open connection that has not closed
      // (typically a second tab running an older build with no
      // `onversionchange` handler). Surface it and reject rather than leave
      // getDB() pending forever; clearing the cached promise lets a later call
      // retry once the blocker releases (#209).
      request.onblocked = () => {
        if(settled) return;
        settled = true;
        console.warn('[message-store] IndexedDB upgrade blocked by another open connection; retrying after it closes');
        if(this.dbPromise) this.dbPromise = null;
        reject(new Error('IndexedDB upgrade blocked by another open connection'));
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if(!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, {autoIncrement: true});
          store.createIndex('conversationId', 'conversationId', {unique: false});
          store.createIndex('timestamp', 'timestamp', {unique: false});
          store.createIndex('eventId', 'eventId', {unique: true});
          store.createIndex('conversationTimestamp', ['conversationId', 'timestamp'], {unique: false});
          store.createIndex('conversationMid', ['conversationId', 'mid'], {unique: false});
        } else {
          // v4 upgrade path: add the composite index to existing databases.
          // Composite key sorts rows oldest-first per conversation, so the
          // retention prune can delete exactly the excess via one cursor walk.
          const store = (event.target as IDBOpenDBRequest).transaction!.objectStore(STORE_NAME);
          if(!store.indexNames.contains('conversationTimestamp')) {
            store.createIndex('conversationTimestamp', ['conversationId', 'timestamp'], {unique: false});
          }
          // v5: direct chronological paging. `mid` is immutable and encodes
          // timestamp + sub-second order, so this index can seek to an anchor
          // and stop at the requested limit instead of decoding + sorting up
          // to 500 rows on every chat open and scroll event.
          if(!store.indexNames.contains('conversationMid')) {
            store.createIndex('conversationMid', ['conversationId', 'mid'], {unique: false});
          }
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
        // v6: persisted one-shot migration markers (see GROUP_KEY_MIGRATION).
        if(!db.objectStoreNames.contains(MIGRATION_STORE)) {
          db.createObjectStore(MIGRATION_STORE, {keyPath: 'name'});
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
    // Upsert + retention prune run in ONE readwrite transaction (#107, PR #113
    // review): if the prune step fails, the transaction aborts and the insert
    // rolls back with it — the store can never persist a row that breaches the
    // cap invariant, and readers never observe an over-cap conversation.
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('eventId');

      // Mark event as seen ONLY on full commit — if the transaction aborts
      // (e.g. pruneConversationInTx fails), the insert rolls back and the
      // event must remain retryable. marking in onsuccess (pre-commit) creates
      // a silent drop on retry — see review #113 by Kai.
      tx.oncomplete = () => {
        this.markSeen(msg.eventId);
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);

      // Check if exists
      const getReq = index.getKey(msg.eventId);
      getReq.onsuccess = () => {
        if(getReq.result !== undefined) {
          // Update existing — MERGE fields to preserve mid/twebPeerId/isOutgoing
          // that may have been set by a parallel save (send bridge vs ChatAPI race)
          const readReq = store.get(getReq.result);
          readReq.onsuccess = () => {
            const existing = readReq.result as StoredMessage | undefined;
            // A spread copies EXPLICITLY-undefined keys over the existing value,
            // so a partial writer that carries `senderPubkey: undefined` (e.g. a
            // device-sync row pulled from another device, where the field is
            // typed required but is wire data and absent on legacy rows) blanks
            // the sender of a row we already had. That loss is invisible until
            // the next reload: getGroupHistory can then emit no `from_id`, and
            // tweb's saveMessages falls back to `fromId = peerId` — the CHAT —
            // so the bubble renders the group's own title and avatar as the
            // sender. Strip undefined keys so an OMITTED field always falls back
            // to the existing row and can never erase it.
            const incoming = Object.fromEntries(
              Object.entries(msg).filter(([, v]) => v !== undefined)
            ) as PartialStoredMessage;
            const merged = {...(existing || {}), ...incoming};
            // Preserve non-null fields from existing record
            if(existing?.mid && !msg.mid) merged.mid = existing.mid;
            if(existing?.twebPeerId && !msg.twebPeerId) merged.twebPeerId = existing.twebPeerId;
            if(existing?.isOutgoing !== undefined && msg.isOutgoing === undefined) merged.isOutgoing = existing.isOutgoing;
            if(existing?.editedAt && !msg.editedAt) merged.editedAt = existing.editedAt;
            store.put(merged, getReq.result);
          };
        } else {
          // Insert new. Only INSERTs grow the row count — upsert-updates can
          // never push a conversation over the cap, so pruning is scheduled
          // only on this path, keeping zero work on the update path.
          const addReq = store.add(msg);
          addReq.onsuccess = () => {
            if(msg.conversationId) {
              this.pruneConversationInTx(store, msg.conversationId);
            }
          };
        }
      };
    });
  }

  /**
   * Enforce the per-conversation retention cap by deleting the oldest rows
   * (by authoritative `timestamp`, NOT insertion order — backfill legitimately
   * inserts old messages late, and those must be the first to fall off).
   *
   * Must be called from WITHIN the saveMessage write transaction: the count
   * request queues after the insert, so it sees the new row, and any request
   * failure aborts the whole transaction — insert included — making retention
   * failure-atomic. The composite index cursor walks oldest-first, so cost is
   * O(excess) — at steady state one delete per insert.
   */
  private pruneConversationInTx(store: IDBObjectStore, conversationId: string): void {
    const cap = this.messageCap;
    if(!Number.isFinite(cap) || cap <= 0) return; // pruning disabled

    const index = store.index('conversationTimestamp');
    // Timestamps are unix seconds (>= 0); bound covers the whole conversation.
    const range = IDBKeyRange.bound([conversationId, 0], [conversationId, Number.MAX_SAFE_INTEGER]);

    const countReq = index.count(range);
    countReq.onsuccess = () => {
      let remaining = countReq.result - cap;
      if(remaining <= 0) return; // within cap — nothing to do
      const cursorReq = index.openCursor(range);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if(!cursor || remaining <= 0) return;
        cursor.delete();
        remaining--;
        cursor.continue();
      };
    };
  }

  /**
   * Get messages for a conversation, sorted by timestamp desc.
   *
   * @param conversationId - Deterministic conversation ID
   * @param limit - Max messages to return (default 50)
   * @param before - Optional timestamp for pagination (return messages before this time)
   */
  async getMessages(conversationId: string, limit: number = DEFAULT_LIMIT, before?: number): Promise<StoredMessage[]> {
    if(limit <= 0) return [];
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('conversationTimestamp');
      const upper = before === undefined ? Number.MAX_SAFE_INTEGER : before;
      const range = IDBKeyRange.bound(
        [conversationId, 0],
        [conversationId, upper],
        false,
        before !== undefined
      );
      const request = index.openCursor(range, 'prev');
      const candidates: Array<{message: StoredMessage; key: IDBValidKey}> = [];
      let boundaryTimestamp: number | undefined;

      const finish = () => {
        candidates.sort((a, b) => {
          if(a.message.timestamp !== b.message.timestamp) return b.message.timestamp - a.message.timestamp;
          if(a.message.mid !== undefined && b.message.mid !== undefined) return b.message.mid - a.message.mid;
          return Number(b.key) - Number(a.key);
        });
        resolve(candidates.slice(0, limit).map(({message}) => message));
      };

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if(!cursor) {
          finish();
          return;
        }
        const message = cursor.value as StoredMessage;
        if(boundaryTimestamp !== undefined && message.timestamp !== boundaryTimestamp) {
          finish();
          return;
        }
        candidates.push({message, key: cursor.primaryKey});
        if(candidates.length >= limit) boundaryTimestamp = message.timestamp;
        cursor.continue();
      };
    });
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
    const {messages} = await this.getMessagesPage(conversationId, limit, offsetId, addOffset);
    return messages;
  }

  /**
   * Paginated history read that ALSO reports the totals the client needs to
   * decide whether the top/bottom of history has been reached.
   *
   * Returns the same window `getMessagesByOffsetId` would, plus:
   *  - `total`          — total messages stored for the conversation.
   *  - `offsetIdOffset` — absolute position of `messages[0]` within the full
   *                       newest-first list (Telegram's `offset_id_offset`).
   *
   * The Virtual MTProto server maps these onto `messages.messagesSlice` so
   * tweb's `isHistoryResultEnd` knows the true total instead of assuming the
   * page length IS the total. Previously it reported `count = page length`,
   * so every first page looked like the whole history: the scroller marked
   * the top as reached and never paged older messages in — even though they
   * were sitting in IndexedDB. This is the scroll-back-is-dead fix.
   *
   * Ordering is mid-descending for BOTH the initial page and paginated pages,
   * so the two never disagree (mid = timestamp * 1e6 + slot, i.e. mid order is
   * chronological order, which is also the order tweb rebuilds the slice in).
   *
   * @param conversationId - Deterministic conversation ID
   * @param limit - Max messages to return
   * @param offsetId - Anchor message id (0 = start from newest)
   * @param addOffset - Positional shift relative to anchor (negative = newer)
   */
  async getMessagesPage(
    conversationId: string,
    limit: number = DEFAULT_LIMIT,
    offsetId: number = 0,
    addOffset: number = 0
  ): Promise<{messages: StoredMessage[]; total: number; offsetIdOffset: number}> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('conversationMid');
      const conversationRange = IDBKeyRange.bound(
        [conversationId, 0],
        [conversationId, Number.MAX_SAFE_INTEGER]
      );
      const totalReq = index.count(conversationRange);
      const storedTotalReq = store.index('conversationId').count(IDBKeyRange.only(conversationId));
      let indexedTotal: number | undefined;
      let storedTotal: number | undefined;

      const continueWhenCounted = () => {
        if(indexedTotal === undefined || storedTotal === undefined) return;
        if(indexedTotal !== storedTotal) console.warn(
          `[MessageStore] Skipping ${storedTotal - indexedTotal} row(s) without mid in ${conversationId}`
        );
        readPage(indexedTotal);
      };

      totalReq.onerror = () => reject(totalReq.error);
      totalReq.onsuccess = () => {
        indexedTotal = totalReq.result;
        continueWhenCounted();
      };
      storedTotalReq.onerror = () => reject(storedTotalReq.error);
      storedTotalReq.onsuccess = () => {
        storedTotal = storedTotalReq.result;
        continueWhenCounted();
      };

      const readPage = (total: number) => {
        if(total === 0) {
          resolve({messages: [], total: 0, offsetIdOffset: 0});
          return;
        }

        const resolvePage = (anchorPosition: number | null) => {
          // Unknown anchors deliberately fall back to the newest page. This is
          // tweb's existing recovery behavior for a stale/truncated mid.
          const start = Math.max(0, (anchorPosition ?? 0) + (anchorPosition === null ? 0 : addOffset));
          if(limit <= 0 || start >= total) {
            resolve({messages: [], total, offsetIdOffset: start});
            return;
          }

          const messages: StoredMessage[] = [];
          const cursorReq = index.openCursor(conversationRange, 'prev');
          let advanced = start === 0;
          cursorReq.onerror = () => reject(cursorReq.error);
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if(!cursor || messages.length >= limit) {
              resolve({messages, total, offsetIdOffset: start});
              return;
            }
            if(!advanced) {
              advanced = true;
              cursor.advance(start);
              return;
            }
            messages.push(cursor.value as StoredMessage);
            if(messages.length >= limit) resolve({messages, total, offsetIdOffset: start});
            else cursor.continue();
          };
        };

        if(offsetId <= 0) {
          resolvePage(0);
          return;
        }

        const anchorReq = index.getKey([conversationId, offsetId]);
        anchorReq.onerror = () => reject(anchorReq.error);
        anchorReq.onsuccess = () => {
          if(anchorReq.result === undefined) {
            resolvePage(null);
            return;
          }
          // Count rows strictly newer than the anchor. That count is the
          // anchor's absolute position in the newest-first list.
          const newerRange = IDBKeyRange.bound(
            [conversationId, offsetId],
            [conversationId, Number.MAX_SAFE_INTEGER],
            true,
            false
          );
          const newerReq = index.count(newerRange);
          newerReq.onerror = () => reject(newerReq.error);
          newerReq.onsuccess = () => resolvePage(newerReq.result);
        };
      };
    });
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
      const index = store.index('conversationTimestamp');
      const range = IDBKeyRange.bound(
        [conversationId, 0],
        [conversationId, Number.MAX_SAFE_INTEGER]
      );
      const request = index.openCursor(range, 'prev');

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve((request.result?.value as StoredMessage | undefined)?.timestamp ?? 0);
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
   * Re-key every stored row in `fromConversationId` onto `toConversationId`
   * (issue #207: legacy group rows were written under the bare groupId before
   * `group:<groupId>` was enforced as the canonical group conversation key).
   * Rows keep their primary key (eventId) and identity triple; only the
   * `conversationId` field changes, so edits, reactions and eventId dedup are
   * unaffected. Paginates the same way `GroupAPI.rekeyGroupMessages` does so a
   * long history is migrated in full, and moving rows out of the source key is
   * itself the pagination cursor. Returns the number of rows moved.
   */
  async rekeyConversation(fromConversationId: string, toConversationId: string, pageSize = 1000): Promise<number> {
    if(!fromConversationId || !toConversationId || fromConversationId === toConversationId) return 0;
    const seen = new Set<string>();
    let before: number | undefined;
    let moved = 0;
    for(;;) {
      const rows = await this.getMessages(fromConversationId, pageSize, before);
      if(rows.length === 0) break;
      let newRows = 0;
      for(const row of rows) {
        if(seen.has(row.eventId)) continue;
        seen.add(row.eventId);
        newRows++;
        await this.saveMessage({...row, conversationId: toConversationId});
        moved++;
      }
      if(rows.length < pageSize) break;
      // Timestamp ties can straddle a page boundary; if a full page yielded
      // nothing new, nudge the strict `<` cursor to keep making progress.
      before = rows[rows.length - 1].timestamp;
      if(newRows === 0) before--;
    }
    return moved;
  }

  /**
   * Read a persisted one-shot migration marker. Returns false when the marker
   * has never been written.
   */
  async getMigration(name: string): Promise<boolean> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MIGRATION_STORE, 'readonly');
      const req = tx.objectStore(MIGRATION_STORE).get(name);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(!!req.result);
    });
  }

  /** Record that a one-shot migration has completed. Idempotent. */
  async setMigration(name: string): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MIGRATION_STORE, 'readwrite');
      const req = tx.objectStore(MIGRATION_STORE).put({name, doneAt: Date.now()});
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();
    });
  }

  /**
   * Read a migration marker's stored payload, or null when unwritten. Used by
   * migrations that need to persist progress (a set of ids), not just a
   * done/not-done flag.
   */
  async getMigrationValue<T = unknown>(name: string): Promise<T | null> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MIGRATION_STORE, 'readonly');
      const req = tx.objectStore(MIGRATION_STORE).get(name);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const rec = req.result as {value?: T} | undefined;
        resolve(rec && 'value' in rec ? (rec.value as T) : null);
      };
    });
  }

  /** Persist a migration marker's payload (idempotent overwrite). */
  async setMigrationValue(name: string, value: unknown): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MIGRATION_STORE, 'readwrite');
      const req = tx.objectStore(MIGRATION_STORE).put({name, value, doneAt: Date.now()});
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();
    });
  }

  /** Clear a migration marker (tests / explicit re-run). */
  async clearMigration(name: string): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MIGRATION_STORE, 'readwrite');
      const req = tx.objectStore(MIGRATION_STORE).delete(name);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();
    });
  }

  /**
   * One-shot migration of legacy bare-keyed GROUP state onto the canonical
   * `group:<groupId>` key (#207, review #208).
   *
   * Pre-#207 builds wrote group rows and read cursors under BOTH the bare
   * `<groupId>` and `group:<groupId>`. `resetUnreadForPeer` resolved the bare
   * id, so a read group's cursor lived under the bare key while its inbound
   * rows already lived under the canonical key — the "normal" upgrade state.
   * The boot dialog therefore found canonical rows (non-empty), skipped any
   * legacy fallback, read a canonical cursor of 0 and reported the whole
   * retained history as unread.
   *
   * So the migration must NOT be gated on the canonical lookup being empty:
   * for every group we rekey any bare rows forward unconditionally and seed the
   * canonical read cursor to the current top mid — exactly what `main` asserted
   * at boot (it forced unread 0) — so history already read via the UI-only
   * localStorage path does not resurface.
   *
   * The seed is UNCONDITIONAL, not gated on "no cursor found": a released
   * build's only bare-cursor writer (`resetUnreadForPeer`) derived the value
   * from the bare `chatCreate` row — the OLDEST mid in the group — so a legacy
   * bare cursor is not a read position and must not be trusted (review #208
   * blocker). Every pre-#207 group therefore seeds to the current top and
   * reports unread 0, matching `main`.
   *
   * Guarded by a persisted marker (GROUP_KEY_MIGRATION): the seed step must run
   * once per install, otherwise a genuinely-unread group with no cursor yet
   * would be force-read on every boot. On any per-group failure the marker is
   * NOT written, so the sweep retries on the next boot rather than silently
   * skipping the failed group forever.
   *
   * A retry must not re-seed a group it already finished, nor sweep a group that
   * only appeared after the first attempt (#209) — either would force-read
   * messages that arrived in the retry window. The frozen COHORT and the
   * per-group DONE set make the sweep resumable without that exposure.
   *
   * The per-group seed ceiling is persisted BEFORE any group mutation (#211):
   * the seed and the DONE write are not atomic, so if the tab dies (or the DONE
   * write rejects) after the cursor advanced but before the group is marked
   * done, a retry must seed to the ORIGINAL ceiling — never recompute the
   * then-current top, which would force-read messages received in between.
   */
  async migrateLegacyGroupConversationKeys(groupIds: string[]): Promise<void> {
    if(await this.getMigration(GROUP_KEY_MIGRATION)) return;

    // Freeze the sweep cohort on the FIRST attempt (#209). Ids that appear on a
    // later boot — groups created after the fix — are never in the cohort, so a
    // retry cannot force-read them.
    let cohort = await this.getMigrationValue<string[]>(GROUP_KEY_MIGRATION_COHORT);
    if(!cohort) {
      cohort = [...new Set(groupIds.filter((id): id is string => !!id))];
      await this.setMigrationValue(GROUP_KEY_MIGRATION_COHORT, cohort);
    }

    const done = new Set(await this.getMigrationValue<string[]>(GROUP_KEY_MIGRATION_DONE) ?? []);
    // Immutable per-group seed ceilings, captured before the group is touched
    // and written down before the first mutation (#211).
    const ceilings = await this.getMigrationValue<Record<string, number>>(GROUP_KEY_MIGRATION_CEILING) ?? {};
    let failed = false;
    for(const groupId of cohort) {
      // Never re-sweep a group that already migrated: the seed is
      // unconditional, so re-running it after new messages arrived would
      // force-read them (review #208 semantics, hardened here).
      if(done.has(groupId)) continue;
      try {
        let ceiling = ceilings[groupId];
        if(typeof ceiling !== 'number') {
          ceiling = await this.getGroupSeedCeiling(groupId);
          // Persist the ceiling BEFORE mutating the group. If this write fails
          // we abort without having touched anything, so the group is simply
          // retried from the same ceiling.
          ceilings[groupId] = ceiling;
          await this.setMigrationValue(GROUP_KEY_MIGRATION_CEILING, ceilings);
        }
        await this.migrateLegacyGroupConversationKey(groupId, ceiling);
        // Persist each success immediately so a crash/retry between groups
        // cannot re-seed an already-migrated group. If this write fails the
        // group reruns, but the persisted ceiling keeps the seed idempotent.
        done.add(groupId);
        await this.setMigrationValue(GROUP_KEY_MIGRATION_DONE, [...done]);
      } catch(err) {
        failed = true;
        console.warn('[message-store] #207 group-key migration failed for', groupId, err);
      }
    }
    if(!failed) await this.setMigration(GROUP_KEY_MIGRATION);
  }

  /**
   * The immutable seed ceiling for one group: the highest mid across BOTH the
   * legacy bare-keyed rows and the canonical rows, captured before the group is
   * mutated. The bare top must be included — the rekey is what moves those rows
   * forward, so reading only the canonical key would under-report the ceiling
   * (review #211).
   */
  private async getGroupSeedCeiling(groupId: string): Promise<number> {
    if(!groupId) return 0;
    const canonical = `group:${groupId}`;
    const bareTop = (await this.getMessages(groupId, 1))[0]?.mid ?? 0;
    const canonicalTop = (await this.getMessages(canonical, 1))[0]?.mid ?? 0;
    return Math.max(bareTop, canonicalTop);
  }

  private async migrateLegacyGroupConversationKey(groupId: string, seedCeiling?: number): Promise<void> {
    if(!groupId) return;
    const canonical = `group:${groupId}`;
    // Rekey any legacy bare-keyed rows forward unconditionally: in the mixed
    // upgrade state canonical rows already exist, and the bare chatCreate /
    // service rows would otherwise be orphaned (rule 15). Must run BEFORE the
    // seed so the top mid below includes the rekeyed rows.
    await this.rekeyConversation(groupId, canonical);
    // Seed the canonical cursor to the FROZEN ceiling for EVERY existing group
    // in this one-shot sweep (review #208 blocker). Do not gate on "no cursor
    // found": a released build's only bare cursor pointed at the chatCreate row
    // (the oldest mid), so trusting it under-reports the top. `main` asserted
    // unread 0 at every boot; the persisted marker makes this one-shot, so a
    // group created after the fix is never force-read. The ceiling is passed in
    // so a retry never recomputes (and advances) it (#211).
    const ceiling = seedCeiling ?? await this.getGroupSeedCeiling(groupId);
    if(ceiling > 0) await this.setReadCursor(canonical, ceiling);
  }

  /**
   * Remove a stored read cursor so a conversation reads as never-opened.
   * `setReadCursor` is monotonic and cannot walk a cursor back to 0, so tests
   * and explicit resets need a real delete.
   */
  async deleteReadCursor(conversationId: string): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CURSOR_STORE, 'readwrite');
      const req = tx.objectStore(CURSOR_STORE).delete(conversationId);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();
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
   * Compute a lightweight sync digest for one conversation: how many messages we
   * hold and the eventId of the newest (by timestamp, eventId as tiebreak). Used
   * by device-sync to let two of the user's devices detect that one is behind the
   * other for the open chat. A single conversationId-index cursor scan — no full
   * row decode beyond what the cursor already yields.
   *
   * NOTE: count + latestId catches the common "you're behind by N" case but not a
   * divergence where both sides hold the same count with different middle messages.
   * True set-union reconciliation (id-set exchange) is a later increment; this
   * digest is the cheap presence-style advertisement that triggers it.
   */
  async getConversationDigest(conversationId: string): Promise<{count: number; latestId: string; latestTimestamp: number}> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const index = tx.objectStore(STORE_NAME).index('conversationId');
      const request = index.openCursor(IDBKeyRange.only(conversationId));

      let count = 0;
      let latestId = '';
      let latestTimestamp = -1;

      request.onerror = () => reject(request.error);
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if(cursor) {
          const row = cursor.value as StoredMessage;
          count++;
          const ts = typeof row.timestamp === 'number' ? row.timestamp : 0;
          if(ts > latestTimestamp || (ts === latestTimestamp && (row.eventId || '') > latestId)) {
            latestTimestamp = ts;
            latestId = row.eventId || '';
          }
          cursor.continue();
        } else {
          resolve({count, latestId, latestTimestamp: latestTimestamp < 0 ? 0 : latestTimestamp});
        }
      };
    });
  }

  /**
   * List every eventId we hold for a conversation. This is the "have-set" a
   * device sends in a device-sync request so the fuller device can compute the
   * exact rows it holds that we don't (strict set difference). A single
   * conversationId-index cursor scan; returns the raw eventId strings only.
   */
  async getConversationEventIds(conversationId: string): Promise<string[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const index = tx.objectStore(STORE_NAME).index('conversationId');
      const request = index.openCursor(IDBKeyRange.only(conversationId));

      const ids: string[] = [];

      request.onerror = () => reject(request.error);
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if(cursor) {
          const row = cursor.value as StoredMessage;
          if(row.eventId) ids.push(row.eventId);
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
