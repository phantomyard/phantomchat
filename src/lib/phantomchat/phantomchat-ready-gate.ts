/**
 * phantomchat-ready-gate — the cold-start paint gate (#217).
 *
 * The bug: on load the chat list painted immediately from stale device-local
 * state — empty summaries first, then a populate → sync → reconnect →
 * backfill dance that left every chat wearing a stale unread badge the user
 * had to click away.
 *
 * The contract: on cold start the boot splash (with its progress bar) stays
 * up until BOTH readiness signals have landed —
 *
 *   'previews'    — every cached chat-list preview has been refreshed from
 *                   the local store (the populate dance is DONE, the list can
 *                   paint with real summaries), and
 *   'read-state'  — the cross-device read-state sync has had its first
 *                   settle (read cursors are account-true before badges
 *                   paint), or the relay wait has timed out.
 *
 * then the splash lifts and the interface paints ready-loaded and synced.
 *
 * HARD CAP — a dead relay must never wedge the UI: `whenChatListReady`
 * resolves on the signals OR after `READY_TIMEOUT_MS`, whichever comes
 * first. Late signals are simply ignored (first resolution wins), and
 * background sync keeps converging afterwards — any badge it corrects later
 * refreshes in place via the read-state apply path.
 */

export type ReadySignal = 'previews' | 'read-state';

/** Upper bound on the splash hold. Read-state's first settle normally lands
 * in well under this; this is the "relay is dead / wiring is broken" escape
 * hatch so the app always becomes usable. */
export const READY_TIMEOUT_MS = 10_000;

const ALL_SIGNALS: ReadySignal[] = ['previews', 'read-state'];

const landed = new Set<ReadySignal>();
const waiters: Array<() => void> = [];

/** Record that a readiness signal has landed. Idempotent; extra calls (e.g.
 * periodic reconciles) are no-ops. */
export function markChatListReady(signal: ReadySignal): void {
  if(landed.has(signal)) return;
  landed.add(signal);
  if(ALL_SIGNALS.every((s) => landed.has(s))) {
    const pending = waiters.splice(0, waiters.length);
    for(const resolve of pending) resolve();
  }
}

/** Resolve when every signal has landed, or after `timeoutMs` (default
 * READY_TIMEOUT_MS) — whichever comes first. Never rejects. */
export function whenChatListReady(timeoutMs: number = READY_TIMEOUT_MS): Promise<void> {
  if(ALL_SIGNALS.every((s) => landed.has(s))) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if(done) return;
      done = true;
      resolve();
    };
    waiters.push(finish);
    if(typeof setTimeout !== 'undefined') {
      setTimeout(finish, timeoutMs);
    }
  });
}

/** Test hook — drops all signal state so a suite (or a re-login) re-gates its
 * own boot from scratch. Pending waiters resolve rather than hang. */
export function resetChatListReady(): void {
  landed.clear();
  waiters.splice(0, waiters.length).forEach((resolve) => resolve());
}
