/**
 * Boot-ordering invariant for the PhantomChat receive path (#218).
 *
 * The receive hot path answers "already read on another device?" with a
 * SYNCHRONOUS in-memory read (MessageStore.peekReadCursor) — no IndexedDB per
 * message by design. That read is only correct once the in-memory cursor view
 * has been seeded from IndexedDB, so the warm must complete BEFORE any receive
 * source starts and before its projection path is installed. Otherwise a fast
 * relay backfill reaches handleIncomingMessage() with peekReadCursor() === 0
 * and re-badges + re-notifies messages the persisted cursor already covers
 * (PR #218 review round 3, kaieriksen).
 *
 * Failure behavior is explicit: a warm rejection is logged and we FAIL OPEN,
 * starting receive with whatever the cache holds. An IndexedDB failure that
 * breaks the warm also breaks message persistence everywhere else on this
 * path; turning it into a wedged, silent boot would be strictly worse than the
 * worst case here (the pre-#218 over-badge/over-notify on covered backfill).
 */
import {getMessageStore, type MessageStore} from './message-store';

export async function startReceiveAfterCursorWarm(
  startReceive: () => void,
  store: Pick<MessageStore, 'warmReadCursorCache'> = getMessageStore()
): Promise<void> {
  try {
    await store.warmReadCursorCache();
  } catch(err) {
    console.warn('[ReadCursorBoot] read-cursor warm failed; starting receive with the cursor view as-is (fail open):', err);
  }
  startReceive();
}
