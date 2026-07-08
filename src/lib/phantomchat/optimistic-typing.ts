/**
 * Optimistic typing indicator — local-only UX feedback.
 *
 * When the user sends a message, we immediately show a "typing…" indicator
 * for the peer (as if they are already composing a reply) and keep it alive
 * for up to 10 seconds. The indicator is cleared the moment a reply actually
 * arrives from that peer, whichever comes first.
 *
 * This is purely LOCAL — we dispatch native `updateUserTyping` updates into
 * tweb's apiUpdatesManager, exactly like the relay-side typing receiver does
 * (phantomchat-typing-receive.ts). Nothing is published to relays; the peer
 * is not notified. It is a perceived-latency reduction: instead of staring at
 * a blank state after sending, the user sees "typing…" immediately.
 *
 * Lifecycle:
 *   start(peerPubkey)
 *     ├─ t=0s    → dispatch updateUserTyping (typing)   [6s native auto-expiry]
 *     ├─ t=5s    → re-dispatch (refresh the 6s timer)
 *     └─ t=10s   → hard-stop: dispatch cancel, clear timers
 *   stop(peerPubkey)
 *     └─ clear timers + dispatch cancel (clears dots immediately)
 *
 * The re-fire at 5s keeps the 6s native auto-expiry alive without a visible
 * gap. The hard stop at 10s guarantees the indicator never lingers past the
 * budget even if no reply arrives.
 */

import rootScope from '@lib/rootScope';

const LOG_PREFIX = '[OptimisticTyping]';

/** Total lifetime of the optimistic indicator (ms). */
const TYPING_DURATION_MS = 10_000;

/** Interval at which we re-fire the typing update to beat the 6s auto-expiry (ms). */
const TYPING_REFRESH_MS = 5_000;

/** Resolve a pubkey to the virtual tweb peerId. */
type PeerResolver = (pubkey: string) => Promise<number>;

/** Dispatch a local typing update into tweb. */
type TypingDispatcher = (peerId: number, isStop: boolean) => void;

/** Default resolver using PhantomChatBridge. Lazily imported to avoid circular deps. */
const defaultResolver: PeerResolver = async(pubkey) => {
  const {PhantomChatBridge} = await import('./phantomchat-bridge');
  return PhantomChatBridge.getInstance().mapPubkeyToPeerId(pubkey);
};

/** Default dispatcher using the native apiUpdatesManager. */
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
  peerId: number;
}

class OptimisticTypingManager {
  private active = new Map<string, ActiveTimer>();
  private generation = new Map<string, number>();
  private resolver: PeerResolver = defaultResolver;
  private dispatcher: TypingDispatcher = defaultDispatcher;

  /** Test seam: override the pubkey → peerId resolver. */
  setPeerResolver(r: PeerResolver) { this.resolver = r; }

  /** Test seam: override the typing dispatcher. */
  setTypingDispatcher(d: TypingDispatcher) { this.dispatcher = d; }

  /**
   * Start the optimistic typing indicator for a peer.
   * If already active for this peer, the timers are reset (restart the 10s
   * window) — this handles rapid-fire consecutive sends without stacking
   * timers.
   */
  async start(peerPubkey: string): Promise<void> {
    // Claim a new generation token for this peer. If a newer start() arrives
    // while we're awaiting the resolver, our generation will be stale and we
    // abort — preventing orphaned timers.
    const gen = (this.generation.get(peerPubkey) ?? 0) + 1;
    this.generation.set(peerPubkey, gen);

    // Clear any existing timers for this peer first.
    this.stop(peerPubkey, true);

    let peerId: number;
    try {
      peerId = await this.resolver(peerPubkey);
    } catch(err) {
      console.debug(LOG_PREFIX, 'peer resolve failed:', (err as Error)?.message);
      return;
    }

    // Abort if a newer start() superseded us while awaiting.
    if(this.generation.get(peerPubkey) !== gen) return;

    // Fire immediately.
    this.dispatcher(peerId, false);

    // Recursive refresh: re-fire every 5s to beat the 6s native auto-expiry.
    // Uses setTimeout (not setInterval) so the hard-stop timeout below can
    // clearTimeout the pending refresh and avoid a dispatch-then-immediately-
    // cancel double-fire at exactly 10s.
    let refreshTimer: ReturnType<typeof setTimeout>;
    const scheduleRefresh = () => {
      refreshTimer = setTimeout(() => {
        this.dispatcher(peerId, false);
        scheduleRefresh();
      }, TYPING_REFRESH_MS);
    };
    scheduleRefresh();

    // Hard stop after 10s total.
    const hardStopTimer = setTimeout(() => {
      this.active.delete(peerPubkey);
      clearTimeout(refreshTimer);
      this.dispatcher(peerId, true);
    }, TYPING_DURATION_MS);

    this.active.set(peerPubkey, {refreshTimer, hardStopTimer, peerId});
  }

  /**
   * Stop the optimistic typing indicator for a peer and clear it immediately.
   * Safe to call when no indicator is active (no-op).
   *
   * @param silent If true, skip the cancel dispatch (used internally by start()
   *               to clear stale timers without flickering the dots).
   */
  stop(peerPubkey: string, silent?: boolean): void {
    const entry = this.active.get(peerPubkey);
    if(entry) {
      clearTimeout(entry.refreshTimer);
      clearTimeout(entry.hardStopTimer);
      this.active.delete(peerPubkey);
    }

    if(!silent && entry) {
      this.dispatcher(entry.peerId, true);
    }
  }

  /** Check whether an optimistic indicator is currently active for a peer. */
  isActive(peerPubkey: string): boolean {
    return this.active.has(peerPubkey);
  }
}

export const optimisticTyping = new OptimisticTypingManager();

if(typeof window !== 'undefined') {
  (window as any).__optimisticTyping = optimisticTyping;
}
