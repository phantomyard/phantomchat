/**
 * read-state-sync-adapter — plugs the per-conversation read cursors
 * (message-store `read-cursors`) into the generic CRDT engine
 * (crdt-sync.ts) so "read up to here" is a fact shared by every device on
 * the account (#217).
 *
 * THE PROBLEM IT SOLVES
 * Read state used to be device-local: reading a chat on the laptop left the
 * phone showing every message as unread. Worse, the phone's device-local
 * unread counters (phantomchat-unread-counts) kept asserting stale blue
 * badges until each chat was clicked open.
 *
 * WHY A CUSTOM MERGE (the load-bearing detail)
 * The cursor is a MONOTONIC counter (`mid`, chronological: timestamp*1e6+slot),
 * so the correct conflict resolution is MAX-WINS on the cursor value — not
 * the engine's default per-item last-write-wins. LWW is wrong here: a device
 * that read LESS FAR but MORE RECENTLY (it only had half the history synced)
 * would win the LWW compare and drag every sibling's cursor backwards,
 * un-reading messages everyone had already seen. With max-wins the merged
 * cursor is `max(local, remote)` in every fold order — commutative,
 * associative, idempotent — so devices converge and the cursor only ever
 * moves forward.
 *
 * READ STATE IS NEVER DELETED. There is no tombstone in this domain: a
 * cursor is a monotonic fact ("I have seen everything up to here"), not an
 * item that can be removed. If a tombstone-shaped entry ever shows up in a
 * snapshot (corrupt/hostile blob), it is dropped on read and loses to any
 * live entry in merge — absence of a cursor just means "never read here",
 * which is exactly what a fresh device must see.
 *
 * `updatedAt` is NOT load-bearing in this domain (max-wins is entirely on
 * `lastReadMid`), so read() exports 0 and the merge keeps the winner entry
 * WHOLESALE (stamps included) — that makes `differs` see genuine no-ops as
 * no-ops and stops republish churn.
 */
import type {LocalAdapter} from './crdt-sync';
import type {SyncMap, SyncEntry} from './sync-crdt';
import {stableStringify} from './sync-crdt';

/** The payload published per conversation. */
export type ReadStateData = {
  /** Highest `mid` read on any device (message-store read-cursor unit). */
  lastReadMid: number;
};

export const READ_STATE_SYNC_D_TAG = 'phantomchat.chat/read-state';
export const READ_STATE_SYNC_VERSION = 1;
export const READ_STATE_SYNC_ACCEPTED_VERSIONS = [READ_STATE_SYNC_VERSION];

export type ReadStateAdapterDeps = {
  /** Every local cursor (message-store.getAllReadCursors). */
  listReadCursors: () => Promise<Array<{conversationId: string; lastReadMid: number}>>;
  /**
   * Monotonic-max cursor write (message-store.setReadCursor). A write at or
   * below the stored value must be a silent no-op so re-applied merges never
   * walk the cursor backwards locally either.
   */
  setReadCursor: (conversationId: string, mid: number) => Promise<void>;
  /**
   * Fired ONLY when this device genuinely learned a higher cursor from sync
   * (remote read ahead of local) — used to refresh the stale unread badge
   * without a click. Never fired for no-op re-applies.
   */
  onCursorAdvanced?: (conversationId: string, lastReadMid: number) => void | Promise<void>;
  logPrefix?: string;
};

function isPositiveMid(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * Domain merge: max-wins on `lastReadMid` (see header). Pure, commutative,
 * associative, idempotent. The winning entry is returned unchanged.
 */
export function mergeReadStateMaps(
  local: SyncMap<ReadStateData>,
  remote: SyncMap<ReadStateData>
): SyncMap<ReadStateData> {
  const out: SyncMap<ReadStateData> = {};
  const ids = new Set([...Object.keys(local), ...Object.keys(remote)]);
  for(const id of ids) {
    const a = local[id];
    const b = remote[id];
    if(!a) { out[id] = b; continue; }
    if(!b) { out[id] = a; continue; }

    // No deletes in this domain: a tombstone-shaped entry loses to any live
    // entry and is dropped outright when it is the only one (see header).
    if(a.deleted && b.deleted) continue;
    if(a.deleted) { out[id] = b; continue; }
    if(b.deleted) { out[id] = a; continue; }

    const am = isPositiveMid((a.data as ReadStateData)?.lastReadMid) ? (a.data as ReadStateData).lastReadMid : 0;
    const bm = isPositiveMid((b.data as ReadStateData)?.lastReadMid) ? (b.data as ReadStateData).lastReadMid : 0;

    if(am !== bm) { out[id] = am > bm ? a : b; continue; }
    // Equal cursors: any deterministic tie-break will do — same id + same
    // lastReadMid means both entries assert the same fact. Mirror the
    // generic rules (higher updatedAt, then greater stable serialization)
    // so fold order can never matter.
    if(a.updatedAt !== b.updatedAt) { out[id] = a.updatedAt > b.updatedAt ? a : b; continue; }
    out[id] = stableStringify(a.data) >= stableStringify(b.data) ? a : b;
  }
  return out;
}

/**
 * Build the engine adapter over the message-store read cursors.
 * `read()` is side-effect free (unlike contacts/groups — no resurrection
 * self-heal exists here); `apply()` writes cursors monotonically and reports
 * genuinely-new ones.
 */
export function createReadStateAdapter(deps: ReadStateAdapterDeps): LocalAdapter<ReadStateData> {
  return {
    async read(): Promise<SyncMap<ReadStateData>> {
      const rows = await deps.listReadCursors();
      const map: SyncMap<ReadStateData> = {};
      for(const row of rows) {
        if(!row || typeof row.conversationId !== 'string' || !row.conversationId) continue;
        if(!isPositiveMid(row.lastReadMid)) continue;
        map[row.conversationId] = {
          id: row.conversationId,
          updatedAt: 0,
          data: {lastReadMid: row.lastReadMid}
        };
      }
      return map;
    },

    async apply(merged: SyncMap<ReadStateData>, before: SyncMap<ReadStateData>): Promise<void> {
      for(const [id, entry] of Object.entries(merged)) {
        if(entry.deleted) continue;
        const mid = (entry.data as ReadStateData)?.lastReadMid;
        if(!isPositiveMid(mid)) continue;
        const beforeMid = (before[id]?.data as ReadStateData | undefined)?.lastReadMid ?? 0;
        // setReadCursor is monotonic, so re-applying a merged map that is
        // behind the local cursor is a silent no-op — but only report an
        // advance when this device actually LEARNED something new.
        await deps.setReadCursor(id, mid);
        if(mid > beforeMid) {
          try {
            await deps.onCursorAdvanced?.(id, mid);
          } catch(err) {
            console.warn(deps.logPrefix ?? '[read-state-sync]', 'onCursorAdvanced failed', err);
          }
        }
      }
    }
  };
}
