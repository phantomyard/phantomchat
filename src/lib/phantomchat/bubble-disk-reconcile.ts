/**
 * Belt-and-braces repair: the open chat's bubbles are compared against the
 * local message store (IndexedDB) and any stored message with no bubble is
 * painted.
 *
 * Why it exists: a user's own message has repeatedly vanished from a chat
 * after "send, switch to another chat, come back", on both the desktop app and
 * the PWA, while a reload (Ctrl+R) always brought it back. The row is
 * persisted before publish, so the store is always right and only the
 * in-memory history the renderer reuses on switch-back is wrong. #467 repairs
 * a page that lists a mid it cannot resolve; this covers the case it cannot
 * see, where the mid is missing from the in-memory list altogether.
 *
 * Rules:
 * - Add-only. It never removes or moves a bubble, so it cannot make a chat
 *   worse than it was.
 * - Only inside the window the chat already shows: the newest page, and only
 *   when the chat is scrolled to its live bottom. A row older than the oldest
 *   rendered bubble is left to normal scroll-back paging.
 * - Never while a temp (still-sending) bubble is on screen, so an in-flight
 *   send cannot be painted twice.
 * - One read in flight per chat; a mid that was tried and did not paint is not
 *   retried until the chat is opened again, so a row the renderer skips on
 *   purpose (e.g. an own chat-creation service row) cannot loop.
 * - Every repair logs one `console.error` line: a heal means the in-memory
 *   history diverged from the store, and the desktop log keeps only errors.
 */
import {isGroupPeer} from './group-types';

const P2P_PEER_MIN = 1e15;

/** Newest rows compared per check: the same page size a chat opens with. */
export const RECONCILE_PAGE_SIZE = 50;

export const RECONCILE_LOG_PREFIX = '[PhantomChat] bubble-reconcile:';

export function isReconcilablePeer(peerId: number): boolean {
  return peerId >= P2P_PEER_MIN || isGroupPeer(peerId);
}

export type ReconcileView = {
  /** Mids that currently have a bubble in the open chat. */
  renderedMids: readonly number[],
  /** True when the open chat is scrolled to its newest message. */
  atLiveBottom: boolean,
  /** True when the oldest stored message is already rendered. */
  loadedAllTop: boolean
};

/**
 * The stored mids that should have a bubble but do not. Pure, so the window
 * rules are testable without a DOM.
 */
export function collectMissingStoredMids(
  storedMids: readonly number[],
  view: ReconcileView,
  exclude: ReadonlySet<number> = new Set()
): number[] {
  if(!view.atLiveBottom) return [];

  const rendered = new Set<number>();
  let oldestRendered = Infinity;
  for(const mid of view.renderedMids) {
    // A non-integer mid is a temp bubble for a send still in flight: its real
    // row may already be stored under the final mid, so painting now would
    // draw the same message twice. Try again on the next trigger.
    if(!Number.isInteger(mid)) return [];
    rendered.add(mid);
    if(mid < oldestRendered) oldestRendered = mid;
  }

  const missing = new Set<number>();
  for(const mid of storedMids) {
    if(!Number.isSafeInteger(mid) || mid <= 0) continue;
    if(rendered.has(mid) || exclude.has(mid)) continue;
    // Outside the rendered window: paging owns it, not this repair. An empty
    // chat has no window, so every stored row in the newest page counts.
    if(rendered.size && !view.loadedAllTop && mid < oldestRendered) continue;
    missing.add(mid);
  }

  return [...missing].sort((a, b) => a - b);
}

export type BubbleDiskReconcileOptions<MessageType> = {
  /** Mids of the newest stored rows for the peer, read from IndexedDB. */
  readStoredMids: (peerId: number, limit: number) => PromiseLike<readonly number[]>,
  /** Resolves message objects for mids (Worker storage, else the store). */
  loadMessages: (peerId: number, mids: number[]) => PromiseLike<readonly (MessageType | undefined)[]>,
  /** Paints one recovered message; resolves once it is in the DOM. */
  renderMessage: (message: MessageType) => PromiseLike<unknown> | unknown,
  /** Snapshot of what the open chat shows right now. */
  getView: () => ReconcileView,
  /** True when the mid has a bubble now (checked after painting). */
  hasBubble: (mid: number) => boolean,
  /** False once the chat has switched, so a late result is dropped. */
  isActualPeer: (peerId: number) => boolean,
  log?: (...args: unknown[]) => void
};

export function createBubbleDiskReconcile<MessageType>(options: BubbleDiskReconcileOptions<MessageType>) {
  const log = options.log ?? ((...args: unknown[]) => console.error(...args));
  let inFlight: {peerId: number, generation: number, promise: Promise<number[]>} | undefined;
  // Bumped on every teardown, so a read that started for the previous open of
  // the same chat can never paint into the next one.
  let generation = 0;
  let attemptedPeerId: number | undefined;
  const attempted = new Set<number>();

  const run = async(peerId: number, reason: string): Promise<number[]> => {
    const startedAt = generation;
    const isActual = () => generation === startedAt && options.isActualPeer(peerId);
    const storedMids = await options.readStoredMids(peerId, RECONCILE_PAGE_SIZE);
    if(!isActual()) return [];

    const missing = collectMissingStoredMids(storedMids, options.getView(), attempted);
    if(!missing.length) return [];
    for(const mid of missing) attempted.add(mid);

    const messages = await options.loadMessages(peerId, missing);
    if(!isActual()) return [];

    const healed: number[] = [];
    for(let i = 0; i < missing.length; ++i) {
      const message = messages?.[i];
      // Re-check per message: a live update may have painted it meanwhile.
      if(!message || options.hasBubble(missing[i])) continue;
      await options.renderMessage(message);
      if(!isActual()) return healed;
      if(options.hasBubble(missing[i])) healed.push(missing[i]);
    }

    if(healed.length) {
      // One flat string: the desktop log stores the console text, so an object
      // argument would land there as "Object" / "Array(1)".
      log(`${RECONCILE_LOG_PREFIX} healed ${healed.length} bubble(s) peer=${peerId} reason=${reason} mids=${healed.join(',')}`);
    }

    return healed;
  };

  return {
    /** The chat was torn down for the next open: forget per-open state. */
    reset() {
      ++generation;
      inFlight = undefined;
      attemptedPeerId = undefined;
      attempted.clear();
    },

    /**
     * Compare the open chat with the store and paint what is missing.
     * Fire-and-forget safe: failures resolve to an empty list.
     * @returns the mids that were painted.
     */
    check(peerId: number, reason: string): Promise<number[]> {
      if(!isReconcilablePeer(peerId)) return Promise.resolve([]);
      if(inFlight?.peerId === peerId && inFlight.generation === generation) return inFlight.promise;
      if(attemptedPeerId !== peerId) {
        attemptedPeerId = peerId;
        attempted.clear();
      }

      const promise = run(peerId, reason).catch((): number[] => []).finally(() => {
        if(inFlight?.promise === promise) inFlight = undefined;
      });
      inFlight = {peerId, generation, promise};
      return promise;
    }
  };
}
