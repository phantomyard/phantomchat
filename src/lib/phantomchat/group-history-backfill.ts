/**
 * Group history backfill — hand a newly added member a bounded slice of the
 * group's existing backscroll.
 *
 * Group messages are N+1 gift-wraps addressed per member (`wrapGroupMessage`),
 * so a member who is added today cannot decrypt anything sent before the add.
 * There is nothing to "fetch": the history has to be RE-WRAPPED and pushed by a
 * member that already holds it. The adder does that right after the
 * `group_add_member` control it already broadcasts, as one or more
 * `group_history_backfill` control payloads addressed to the newcomer alone.
 *
 * Each item carries the ORIGINAL rumor identity (`rumorId`, `senderPubkey`,
 * `createdAt`) plus the original rumor content, so authorship survives
 * re-wrapping and receivers dedupe on the original rumor id exactly like the
 * live receive path does.
 *
 * Budget (owner decision, 2026-11-01): 32 KiB of message CONTENT bytes. 128 KiB
 * was considered and rejected — that is ~1-2k messages, far more than anyone
 * reads on join, and every re-wrapped event costs ~5x its content on the wire
 * (ciphertext + signature per recipient).
 *
 * THE BUDGET IS SPENT NEWEST-FIRST. When a ceiling binds it must be the OLDEST
 * rows that are dropped: the point of the slice is the conversation right
 * before the join, so truncating the newest rows would reproduce exactly the
 * gap this feature exists to close.
 *
 * Everything here is pure/near-pure so it can be unit-tested without a relay:
 * the caller supplies the message-store reads, and the two pieces of module
 * state (the receiver's ingest budget and the pending stage) are bounded,
 * expiring and resettable.
 */

import type {GroupControlPayload, GroupHistoryItem} from './group-types';

/** Content bytes handed to a newcomer. */
export const HISTORY_BACKFILL_TARGET_BYTES = 32 * 1024;
/** Row cap — also stays inside the message-store's per-chat retention cap. */
export const HISTORY_BACKFILL_MAX_MESSAGES = 400;
/** Target size of ONE control rumor, so a single wrap stays relay-friendly. */
export const HISTORY_BACKFILL_CHUNK_BYTES = 4 * 1024;
/**
 * One oversized message (a long paste, a media caption) is carried alone up to
 * this. Measured on the ITEM PAYLOAD (the rumor content), not on the envelope:
 * the ~270 B of per-item identity is wire overhead, and charging it here used
 * to silently drop ~200 B of legitimate long messages.
 */
export const HISTORY_BACKFILL_MAX_ITEM_BYTES = 8 * 1024;
/**
 * There is deliberately no separate wire ceiling. The three real budgets —
 * 32 KiB of content, 400 rows, 8 KiB per item — bound the wire at roughly
 * 160 KiB worst case (content + JSON escaping + ~270 B of per-item identity),
 * and a second absolute ceiling only ever bound FIRST: it truncated a 900-row
 * history at ~200 rows having spent a seventh of the content budget, which is
 * the exact truncation bug this module is written to avoid. The receiver
 * enforces its own aggregate cap regardless (see below), which is the check
 * that actually protects a device.
 */
/** Items per control payload, independently of the byte budget. */
export const HISTORY_BACKFILL_MAX_ITEMS_PER_CONTROL = 64;
/** Contiguous store page size while walking back. */
export const HISTORY_BACKFILL_PAGE_SIZE = 64;
/**
 * A relayed item stamped further in the future than this is rejected: it would
 * sort at the end of the thread and win LWW comparisons against real rows.
 */
export const HISTORY_BACKFILL_MAX_CLOCK_SKEW_SEC = 300;

// ─── Receiver-side ingest budget ────────────────────────────────────
//
// The sender's caps are advisory — the receiver enforces its own, because the
// bytes arrive from another device. Per group and per window: a slice may cost
// at most 2x the sender's content budget and 2x its row cap (the slack absorbs
// chunk-boundary overlap and a legitimate second relay), and only a bounded
// number of groups may hold a window at once.

/** How long one group's ingest window lasts. */
export const HISTORY_BACKFILL_INGEST_WINDOW_MS = 10 * 60 * 1000;
/** Content bytes a single group may receive per window. */
export const HISTORY_BACKFILL_INGEST_MAX_CONTENT_BYTES = HISTORY_BACKFILL_TARGET_BYTES * 2;
/** Rows a single group may receive per window. */
export const HISTORY_BACKFILL_INGEST_MAX_ROWS = HISTORY_BACKFILL_MAX_MESSAGES * 2;
/** Bounded number of groups holding a window (oldest evicted first). */
export const HISTORY_BACKFILL_INGEST_MAX_GROUPS = 32;

// ─── Pending stage (order tolerance) ────────────────────────────────
//
// A newcomer's group RECORD arrives through the groups CRDT, which the adder
// publishes after the membership control — so the backfill can legitimately
// land first. Dropping it there would lose the slice forever (nothing
// redelivers a control wrap to a member who has no record to validate it
// against), so it is staged until the record materialises.

/** How long a staged slice waits for its group record. */
export const HISTORY_BACKFILL_PENDING_TTL_MS = 15 * 60 * 1000;
/** Bounded number of staged groups. */
export const HISTORY_BACKFILL_MAX_PENDING_GROUPS = 16;

const encoder = new TextEncoder();

const SECP_PUBKEY_HEX_RE = /^[0-9a-f]{64}$/;

/** UTF-8 byte length of a string, without allocating a second string. */
export function utf8ByteLength(value: string): number {
  if(typeof value !== 'string' || value.length === 0) return 0;
  // Fast path: pure ASCII costs one byte per code unit.
  return /^[\x00-\x7F]*$/.test(value) ? value.length : encoder.encode(value).length;
}

/**
 * The subset of a stored message row backfill needs. Declared structurally so
 * tests can feed plain objects instead of real IndexedDB rows.
 */
export interface BackfillSourceRow {
  eventId: string;
  conversationId?: string;
  senderPubkey: string;
  content: string;
  type: string;
  /** Unix seconds. */
  timestamp: number;
  appMessageId?: string;
  replyToMid?: number;
  fileMetadata?: any;
  serviceType?: string;
  deliveryState?: string;
}

export interface CollectHistoryOptions {
  conversationId: string;
  /** Paging read, newest-first, exclusive `before` timestamp (message-store contract). */
  getMessages: (conversationId: string, limit: number, before?: number) => Promise<BackfillSourceRow[]>;
  /** mid -> row, used only to re-derive `replyToRumorId` for replies. */
  getByMid?: (mid: number) => Promise<{eventId?: string} | null | undefined>;
  targetBytes?: number;
  maxMessages?: number;
  pageSize?: number;
}

/** A row we refuse to relay: synthesized locally, never received, or unusable. */
function isBackfillable(row: BackfillSourceRow): boolean {
  if(!row || typeof row !== 'object') return false;
  if(typeof row.eventId !== 'string' || row.eventId.length === 0) return false;
  if(typeof row.senderPubkey !== 'string' || !SECP_PUBKEY_HEX_RE.test(row.senderPubkey)) return false;
  if(typeof row.content !== 'string') return false;
  if(typeof row.timestamp !== 'number' || !Number.isFinite(row.timestamp) || row.timestamp <= 0) return false;
  // Service rows (group create, rebind notices) are synthesized locally on every
  // device — relaying one would mint a duplicate row on the receiver.
  if(row.serviceType) return false;
  // A row that never reached the relay is not history anyone can vouch for.
  if(row.deliveryState === 'failed' || row.deliveryState === 'sending') return false;
  return true;
}

/** Rebuild the original rumor content from the stored row. */
function buildItemPayload(row: BackfillSourceRow, replyToRumorId?: string): string {
  const payload: any = {
    content: row.content,
    type: row.type === 'text' ? 'text' : (row.type || 'text'),
    id: row.appMessageId || row.eventId,
    // The live payload carries app-milliseconds; keep the same shape.
    timestamp: row.timestamp * 1000
  };
  if(replyToRumorId) payload.replyToRumorId = replyToRumorId;
  if(row.fileMetadata) payload.fileMetadata = row.fileMetadata;
  return JSON.stringify(payload);
}

/**
 * Walk the conversation backwards, newest-first, until the content-byte budget
 * or the row cap is reached, then return the slice OLDEST-FIRST so receivers
 * can append it in reading order.
 */
export async function collectGroupHistoryItems(options: CollectHistoryOptions): Promise<GroupHistoryItem[]> {
  const {
    conversationId,
    getMessages,
    getByMid,
    targetBytes = HISTORY_BACKFILL_TARGET_BYTES,
    maxMessages = HISTORY_BACKFILL_MAX_MESSAGES,
    pageSize = HISTORY_BACKFILL_PAGE_SIZE
  } = options;

  if(!conversationId || typeof getMessages !== 'function') return [];
  if(maxMessages <= 0 || targetBytes <= 0) return [];

  const seen = new Set<string>();
  const newestFirst: BackfillSourceRow[] = [];
  let bytes = 0;
  let before: number | undefined;

  while(newestFirst.length < maxMessages && bytes < targetBytes) {
    let page: BackfillSourceRow[];
    try {
      page = (await getMessages(conversationId, pageSize, before)) || [];
    } catch{
      break;
    }
    if(page.length === 0) break;

    for(const row of page) {
      if(newestFirst.length >= maxMessages || bytes >= targetBytes) break;
      if(!isBackfillable(row) || seen.has(row.eventId)) continue;
      seen.add(row.eventId);
      newestFirst.push(row);
      bytes += utf8ByteLength(row.content);
    }

    // Next page starts strictly before this page's oldest timestamp. Same-second
    // rows can only be split by the page boundary, which is why the page size is
    // well above the realistic same-second burst; duplicates are filtered by id.
    const oldest = page[page.length - 1];
    if(!oldest || typeof oldest.timestamp !== 'number') break;
    if(before !== undefined && oldest.timestamp >= before) break; // no progress
    before = oldest.timestamp;
  }

  const ordered = newestFirst.reverse();
  const items: GroupHistoryItem[] = [];
  for(const row of ordered) {
    if(row.replyToMid && getByMid) {
      let parentEventId: string | undefined;
      try {
        parentEventId = (await getByMid(row.replyToMid))?.eventId;
      } catch{
        parentEventId = undefined;
      }
      if(parentEventId) {
        items.push(buildItem(row, parentEventId));
        continue;
      }
    }
    items.push(buildItem(row));
  }
  return items;
}

function buildItem(row: BackfillSourceRow, replyToRumorId?: string): GroupHistoryItem {
  return {
    rumorId: row.eventId,
    senderPubkey: row.senderPubkey,
    createdAt: row.timestamp,
    payload: buildItemPayload(row, replyToRumorId)
  };
}

/** Content bytes one item costs against the budget (the payload, not the envelope). */
export function historyItemBytes(item: GroupHistoryItem): number {
  return utf8ByteLength(item?.payload);
}

/**
 * Split items into `group_history_backfill` control payloads small enough to
 * survive as individual gift-wraps.
 *
 * Items arrive OLDEST-FIRST (reading order). The budget walk runs from the NEW
 * end backwards, so every ceiling drops the oldest rows and the slice always
 * ends at the newest message before the join; the kept window is then emitted
 * oldest-first again, in reading order, so the last payload carries the newest
 * rows and receivers can append as they arrive.
 */
export function buildBackfillControlPayloads(
  groupId: string,
  targetPubkey: string,
  items: GroupHistoryItem[]
): GroupControlPayload[] {
  if(!Array.isArray(items) || items.length === 0) return [];

  const eligible = items.filter((item) => item &&
    typeof item.payload === 'string' &&
    historyItemBytes(item) <= HISTORY_BACKFILL_MAX_ITEM_BYTES);

  // Spend newest-first. Every cap breaks rather than skips: the slice is a
  // CONTIGUOUS window ending at the newest row, not a sample of it.
  const kept: GroupHistoryItem[] = [];
  let contentBytes = 0;
  for(let i = eligible.length - 1; i >= 0; i--) {
    if(kept.length >= HISTORY_BACKFILL_MAX_MESSAGES) break;
    const item = eligible[i];
    const itemContent = historyItemBytes(item);
    if(contentBytes + itemContent > HISTORY_BACKFILL_TARGET_BYTES) break;
    kept.push(item);
    contentBytes += itemContent;
  }
  kept.reverse();

  const payloads: GroupControlPayload[] = [];
  let current: GroupHistoryItem[] = [];
  let currentBytes = 0;

  const flush = () => {
    if(current.length === 0) return;
    payloads.push({
      type: 'group_history_backfill',
      groupId,
      historyTargetPubkey: targetPubkey,
      historyItems: current
    });
    current = [];
    currentBytes = 0;
  };

  for(const item of kept) {
    // Cost is the item AS IT APPEARS IN THE ENVELOPE (payload strings are
    // JSON-escaped inside the control content), not the raw payload length.
    const itemBytes = utf8ByteLength(JSON.stringify(item));
    if(current.length > 0 &&
      (currentBytes + itemBytes > HISTORY_BACKFILL_CHUNK_BYTES || current.length >= HISTORY_BACKFILL_MAX_ITEMS_PER_CONTROL)) {
      flush();
    }
    current.push(item);
    currentBytes += itemBytes;
  }
  flush();
  return payloads;
}

/**
 * Structural gate for one relayed item, with no membership knowledge.
 *
 * The original author cannot be cryptographically re-verified (the relayer
 * holds the plaintext), so the trust model is the same as a member forwarding
 * content: the ITEM is only accepted when its author is a member of the group,
 * and the RELAYER is authenticated separately by the gift-wrap. This half is
 * the part that can be checked before a group record exists (see the pending
 * stage); {@link isWellFormedHistoryItem} adds the membership test.
 */
export function isWellFormedHistoryItemShape(
  item: any,
  options: {nowSec?: number} = {}
): item is GroupHistoryItem {
  if(!item || typeof item !== 'object') return false;
  if(typeof item.rumorId !== 'string' || !SECP_PUBKEY_HEX_RE.test(item.rumorId)) return false;
  if(typeof item.senderPubkey !== 'string' || !SECP_PUBKEY_HEX_RE.test(item.senderPubkey)) return false;
  if(typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt) || item.createdAt <= 0) return false;
  // Future-dated rows would sort past the live thread and win LWW comparisons
  // against real messages; only a small clock skew is tolerated.
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  if(item.createdAt > nowSec + HISTORY_BACKFILL_MAX_CLOCK_SKEW_SEC) return false;
  if(typeof item.payload !== 'string' || item.payload.length === 0) return false;
  if(historyItemBytes(item) > HISTORY_BACKFILL_MAX_ITEM_BYTES) return false;
  return true;
}

/**
 * Full receiver gate: shape plus "the author is a current member". An item
 * authored by a non-member is either a pre-join artifact of a membership race
 * or a forged attribution — neither belongs in the thread.
 */
export function isWellFormedHistoryItem(
  item: any,
  members: string[],
  options: {nowSec?: number} = {}
): item is GroupHistoryItem {
  if(!isWellFormedHistoryItemShape(item, options)) return false;
  return Array.isArray(members) && members.includes(item.senderPubkey);
}

// ─── Receiver-side aggregate budget ─────────────────────────────────

interface IngestBudgetEntry {
  windowStart: number;
  bytes: number;
  rows: number;
}

const ingestBudgets = new Map<string, IngestBudgetEntry>();

/**
 * Trim `items` to what this device still accepts for `groupId` in the current
 * window, and record the spend. Truncates at the cap (keeping the prefix, i.e.
 * the oldest of the offered window) rather than dropping the payload whole, so
 * a slightly-over slice still lands most of its rows.
 */
export function applyIngestBudget(
  groupId: string,
  items: GroupHistoryItem[],
  now: number = Date.now()
): GroupHistoryItem[] {
  if(typeof groupId !== 'string' || !groupId) return [];
  if(!Array.isArray(items) || items.length === 0) return [];

  const existing = ingestBudgets.get(groupId);
  const fresh = !existing || now - existing.windowStart >= HISTORY_BACKFILL_INGEST_WINDOW_MS;
  const entry: IngestBudgetEntry = fresh ?
    {windowStart: now, bytes: 0, rows: 0} :
    {...existing};

  const allowed: GroupHistoryItem[] = [];
  for(const item of items) {
    if(entry.rows >= HISTORY_BACKFILL_INGEST_MAX_ROWS) break;
    const bytes = historyItemBytes(item);
    if(entry.bytes + bytes > HISTORY_BACKFILL_INGEST_MAX_CONTENT_BYTES) break;
    allowed.push(item);
    entry.rows++;
    entry.bytes += bytes;
  }

  if(allowed.length > 0) {
    // Re-insert so the map's iteration order stays "least recently used first"
    // for the eviction below.
    ingestBudgets.delete(groupId);
    ingestBudgets.set(groupId, entry);
    while(ingestBudgets.size > HISTORY_BACKFILL_INGEST_MAX_GROUPS) {
      const oldest = ingestBudgets.keys().next().value;
      if(oldest === undefined) break;
      ingestBudgets.delete(oldest);
    }
  }
  return allowed;
}

/** Test seam: forget every ingest window. */
export function resetIngestBudgets(): void {
  ingestBudgets.clear();
}

// ─── Pending stage ──────────────────────────────────────────────────

export interface PendingBackfill {
  groupId: string;
  /** The authenticated relayer — re-checked against the admin once the record lands. */
  relayerPubkey: string;
  items: GroupHistoryItem[];
  stagedAt: number;
}

const pendingBackfills = new Map<string, PendingBackfill>();

function prunePendingBackfills(now: number): void {
  for(const [groupId, pending] of pendingBackfills) {
    if(now - pending.stagedAt > HISTORY_BACKFILL_PENDING_TTL_MS) pendingBackfills.delete(groupId);
  }
}

/**
 * Hold a slice whose group record has not landed yet. Bounded by
 * {@link HISTORY_BACKFILL_MAX_PENDING_GROUPS} (oldest evicted) and by the same
 * row/byte caps as a live slice, so a flood cannot pin memory.
 */
export function stagePendingBackfill(
  pending: {groupId: string; relayerPubkey: string; items: GroupHistoryItem[]},
  now: number = Date.now()
): void {
  const {groupId, relayerPubkey} = pending;
  if(typeof groupId !== 'string' || !groupId) return;
  if(typeof relayerPubkey !== 'string' || !SECP_PUBKEY_HEX_RE.test(relayerPubkey)) return;
  prunePendingBackfills(now);

  const capped: GroupHistoryItem[] = [];
  let bytes = 0;
  for(const item of Array.isArray(pending.items) ? pending.items : []) {
    if(capped.length >= HISTORY_BACKFILL_MAX_MESSAGES) break;
    const itemBytes = historyItemBytes(item);
    if(bytes + itemBytes > HISTORY_BACKFILL_TARGET_BYTES) break;
    capped.push(item);
    bytes += itemBytes;
  }
  if(capped.length === 0) return;

  if(!pendingBackfills.has(groupId)) {
    while(pendingBackfills.size >= HISTORY_BACKFILL_MAX_PENDING_GROUPS) {
      const oldest = pendingBackfills.keys().next().value;
      if(oldest === undefined) break;
      pendingBackfills.delete(oldest);
    }
  }
  pendingBackfills.set(groupId, {groupId, relayerPubkey, items: capped, stagedAt: now});
}

/** Take (and clear) the staged slice for one group, if any is still live. */
export function takePendingBackfill(groupId: string, now: number = Date.now()): PendingBackfill | null {
  if(typeof groupId !== 'string' || !groupId) return null;
  prunePendingBackfills(now);
  const pending = pendingBackfills.get(groupId);
  if(!pending) return null;
  pendingBackfills.delete(groupId);
  return pending;
}

/** Test seam: forget every staged slice. */
export function resetPendingBackfills(): void {
  pendingBackfills.clear();
}
