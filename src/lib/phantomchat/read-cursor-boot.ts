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
 * Failure behavior is explicit, and covers both ways the warm can fail:
 * a REJECTION is logged and we FAIL OPEN, and a NEVER-SETTLING warm (an
 * IndexedDB request that stays pending around a blocked/broken database
 * without rejecting) is bounded by a timeout and also fails open — an
 * unbounded await here would strand the rest of the mount, since everything
 * wired below this call sits behind it (the 10s ready gate only hides the
 * splash; it cannot resume this function). An IndexedDB failure that breaks
 * the warm also breaks message persistence everywhere else on this path;
 * turning it into a wedged, silent boot would be strictly worse than the
 * worst case here (the pre-#218 over-badge/over-notify on covered backfill).
 */
import {getMessageStore, type MessageStore} from './message-store';

/** Bound on the boot warm; matches the other boot caps (ready gate, whenSubscribed). */
export const CURSOR_WARM_TIMEOUT_MS = 10_000;

export async function startReceiveAfterCursorWarm(
  startReceive: () => void,
  store: Pick<MessageStore, 'warmReadCursorCache'> = getMessageStore(),
  warmTimeoutMs: number = CURSOR_WARM_TIMEOUT_MS
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      store.warmReadCursorCache(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`read-cursor warm still pending after ${warmTimeoutMs}ms`)),
          warmTimeoutMs
        );
      })
    ]);
  } catch(err) {
    console.warn('[ReadCursorBoot] read-cursor warm failed or timed out; starting receive with the cursor view as-is (fail open):', err);
  } finally {
    if(timer !== undefined) clearTimeout(timer);
  }
  startReceive();
}
