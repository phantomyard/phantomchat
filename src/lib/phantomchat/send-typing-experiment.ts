/**
 * UX-isolation experiment: typing indicator fired on the SEND-BUTTON CLICK.
 *
 * Purpose
 * -------
 * The real peer-typing indicator (driven by relayed typing events via
 * `phantomchat-typing-receive.ts`) has been unreliable. Before chasing the
 * relay/transport path we want to answer a cheaper question first:
 *
 *   "If we dispatch a purely local typing update the instant the user clicks
 *    SEND, do the typing dots even render?"
 *
 * If the dots DO appear on click → the tweb rendering path is healthy and the
 * real bug lives upstream (relay receive / event plumbing). If the dots do NOT
 * appear even on a direct local dispatch → the bug is a PWA rendering/UX
 * problem and no amount of relay debugging will fix it.
 *
 * To keep the test pure this module is deliberately minimal and has NO
 * dependency on pubkey resolution, the bridge, or the ChatAPI data layer. It
 * operates directly on the numeric tweb peerId that the chat input already
 * holds, and dispatches the SAME native `updateUserTyping` local update that
 * the real typing receiver uses — nothing more, nothing less.
 *
 * NOTHING is published to relays. The peer is never notified. This is a
 * local-only, disposable experiment.
 *
 * Lifecycle
 * ---------
 *   start(peerId)
 *     ├─ t=0s   → dispatch typing            [6s native auto-expiry]
 *     ├─ t=5s   → re-dispatch (refresh the native 6s timer, no visible gap)
 *     └─ t=10s  → hard-stop: dispatch cancel, clear timers
 *   stop(peerId)
 *     └─ clear timers + dispatch cancel immediately (a reply arrived)
 */

import rootScope from '@lib/rootScope';

const LOG_PREFIX = '[SendTypingExperiment]';

/** Total lifetime of the experimental indicator (ms). */
const TYPING_DURATION_MS = 10_000;

/** Re-fire cadence to beat tweb's ~6s native auto-expiry (ms). */
const TYPING_REFRESH_MS = 5_000;

/** Dispatch a local typing update into tweb. Test seam. */
type TypingDispatcher = (peerId: number, isStop: boolean) => void;

const defaultDispatcher: TypingDispatcher = (peerId, isStop) => {
  Promise.resolve(
    rootScope.managers.apiUpdatesManager.processLocalUpdate({
      _: 'updateUserTyping',
      user_id: peerId,
      action: {_: isStop ? 'sendMessageCancelAction' : 'sendMessageTypingAction'}
    } as any)
  ).catch((err) => {
    console.debug(LOG_PREFIX, 'processLocalUpdate failed:', err?.message);
  });
};

interface ActiveTimer {
  refreshTimer: ReturnType<typeof setTimeout>;
  hardStopTimer: ReturnType<typeof setTimeout>;
}

class SendTypingExperiment {
  private active = new Map<number, ActiveTimer>();
  private dispatcher: TypingDispatcher = defaultDispatcher;

  /** Test seam: override the typing dispatcher. */
  setDispatcher(d: TypingDispatcher) { this.dispatcher = d; }

  /** Whether an experimental indicator is currently active for a peer. */
  isActive(peerId: number): boolean { return this.active.has(peerId); }

  /**
   * Fire the optimistic typing indicator for `peerId` and keep it alive for up
   * to 10s. Re-entrant: calling start() again on an active peer resets the
   * budget rather than stacking timers (rapid consecutive sends).
   */
  start(peerId: number): void {
    if(!Number.isFinite(peerId) || peerId <= 0) return;

    // Reset any in-flight timers for this peer (no stacking on rapid sends).
    this.clearTimers(peerId);

    // Loud success marker: proves the send-click trigger fired and dispatched a
    // local typing update. If you see this line but NO dots render, the bug is a
    // PWA rendering/UX problem — not a relay/transport problem.
    console.log(`${LOG_PREFIX} FIRED on send-click → dispatching local typing for peer ${peerId}`);

    this.dispatcher(peerId, false);

    // Recursive setTimeout (not setInterval) so the hard-stop can cancel a
    // pending refresh and avoid a double-fire at exactly t=10s.
    const scheduleRefresh = () => {
      const timer = this.active.get(peerId);
      if(!timer) return;
      timer.refreshTimer = setTimeout(() => {
        if(!this.active.has(peerId)) return;
        this.dispatcher(peerId, false);
        scheduleRefresh();
      }, TYPING_REFRESH_MS);
    };

    const hardStopTimer = setTimeout(() => this.stop(peerId), TYPING_DURATION_MS);

    this.active.set(peerId, {
      refreshTimer: undefined as unknown as ReturnType<typeof setTimeout>,
      hardStopTimer
    });
    scheduleRefresh();
  }

  /** Clear the indicator immediately (reply arrived, or hard-stop fired). */
  stop(peerId: number): void {
    if(!this.active.has(peerId)) return;
    this.clearTimers(peerId);
    this.dispatcher(peerId, true);
  }

  private clearTimers(peerId: number): void {
    const timer = this.active.get(peerId);
    if(!timer) return;
    if(timer.refreshTimer) clearTimeout(timer.refreshTimer);
    if(timer.hardStopTimer) clearTimeout(timer.hardStopTimer);
    this.active.delete(peerId);
  }
}

export const sendTypingExperiment = new SendTypingExperiment();
