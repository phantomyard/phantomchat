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
 * Everything here is pure/near-pure so it can be unit-tested without a relay:
 * the caller supplies the message-store reads.
 */

import type {GroupControlPayload, GroupHistoryItem} from './group-types';

/** Content bytes handed to a newcomer. */
export const HISTORY_BACKFILL_TARGET_BYTES = 32 * 1024;
/** Row cap — also stays inside the message-store's per-chat retention cap. */
export const HISTORY_BACKFILL_MAX_MESSAGES = 400;
/** Hard ceiling on the wire payloads a single join may produce. */
export const HISTORY_BACKFILL_MAX_WIRE_BYTES = 64 * 1024;
/** Target size of ONE control rumor, so a single wrap stays relay-friendly. */
export const HISTORY_BACKFILL_CHUNK_BYTES = 4 * 1024;
/** One oversized message (a long paste, a media caption) is carried alone up to this. */
export const HISTORY_BACKFILL_MAX_ITEM_BYTES = 8 * 1024;
/** Items per control payload, independently of the byte budget. */
export const HISTORY_BACKFILL_MAX_ITEMS_PER_CONTROL = 64;
/** Contiguous store page size while walking back. */
export const HISTORY_BACKFILL_PAGE_SIZE = 64;

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

/**
 * Split items into `group_history_backfill` control payloads small enough to
 * survive as individual gift-wraps. Stops at the wire ceiling — a very media-
 * heavy slice is truncated rather than published as an unbounded burst.
 */
export function buildBackfillControlPayloads(
  groupId: string,
  targetPubkey: string,
  items: GroupHistoryItem[]
): GroupControlPayload[] {
  const payloads: GroupControlPayload[] = [];
  let current: GroupHistoryItem[] = [];
  let currentBytes = 0;
  let wireBytes = 0;

  const flush = () => {
    if(current.length === 0) return;
    const payload: GroupControlPayload = {
      type: 'group_history_backfill',
      groupId,
      historyTargetPubkey: targetPubkey,
      historyItems: current
    };
    current = [];
    currentBytes = 0;
    payloads.push(payload);
  };

  for(const item of items) {
    if(!item || typeof item.payload !== 'string') continue;
    // Cost is the item AS IT APPEARS IN THE ENVELOPE (payload strings are
    // JSON-escaped inside the control content), not the raw payload length.
    const itemBytes = utf8ByteLength(JSON.stringify(item));
    if(itemBytes > HISTORY_BACKFILL_MAX_ITEM_BYTES) continue; // one huge message is not worth a wrap
    if(wireBytes + itemBytes > HISTORY_BACKFILL_MAX_WIRE_BYTES) break;
    if(current.length > 0 &&
      (currentBytes + itemBytes > HISTORY_BACKFILL_CHUNK_BYTES || current.length >= HISTORY_BACKFILL_MAX_ITEMS_PER_CONTROL)) {
      flush();
    }
    current.push(item);
    currentBytes += itemBytes;
    wireBytes += itemBytes;
  }
  flush();
  return payloads;
}

/**
 * Receiver-side shape gate for one relayed item. The original author cannot be
 * cryptographically re-verified (the relayer holds the plaintext), so the trust
 * model is the same as a member forwarding content: the ITEM is only accepted
 * when its author is a member of the group, and the RELAYER is authenticated
 * separately by the gift-wrap.
 */
export function isWellFormedHistoryItem(item: any, members: string[]): item is GroupHistoryItem {
  if(!item || typeof item !== 'object') return false;
  if(typeof item.rumorId !== 'string' || !SECP_PUBKEY_HEX_RE.test(item.rumorId)) return false;
  if(typeof item.senderPubkey !== 'string' || !SECP_PUBKEY_HEX_RE.test(item.senderPubkey)) return false;
  if(typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt) || item.createdAt <= 0) return false;
  if(typeof item.payload !== 'string' || item.payload.length === 0) return false;
  if(utf8ByteLength(item.payload) > HISTORY_BACKFILL_MAX_ITEM_BYTES) return false;
  // An item authored by a non-member is either a pre-join artifact of a
  // membership race or a forged attribution — neither belongs in the thread.
  return members.includes(item.senderPubkey);
}
