/**
 * Bounded repair for history pages that render without all of their bubbles.
 *
 * A closed chat keeps only its newest message object in the main-thread mirror
 * (`injectIntoMirrors({hydrateHistory: false})` in phantomchat-message-handler):
 * the mirror is deliberately not allowed to inflate for every closed
 * conversation, since IndexedDB is the source of truth. A history page served
 * from the in-memory slice can therefore carry a mid whose object is gone, and
 * the renderer — which resolves each mid through that mirror — silently skips
 * it. The symptom is the user's own message disappearing after
 * "send → switch chat → come back", with the reply still visible, until a
 * second open happens to refetch the page (reported on both the PWA and the
 * desktop build, which share this code).
 *
 * The repair re-reads only the mids the page could not resolve, at most once
 * per chat open. The caller's loader answers from the Worker's message storage
 * or re-reads IndexedDB through the virtual MTProto server, so no relay traffic
 * is involved, and the once-per-open gate means a row that is genuinely gone
 * (deleted, or never stored) can never turn this into a reload loop.
 */

/** The mids of a rendered page whose message object could not be resolved. */
export function collectMissingHistoryMids(
  history: readonly (number | unknown)[],
  resolved: readonly unknown[]
): number[] {
  const resolvedMids = new Set<number>();
  for(let i = 0; i < history.length; ++i) {
    const mid = history[i];
    if(typeof(mid) === 'number' && resolved[i]) resolvedMids.add(mid);
  }

  const missing = new Set<number>();
  for(let i = 0; i < history.length; ++i) {
    const mid = history[i];
    if(typeof(mid) === 'number' && !resolvedMids.has(mid)) missing.add(mid);
  }

  return [...missing];
}

export type HistorySelfHealOptions<MessageType> = {
  /** Resolves the stored message objects, `undefined` for a mid that no longer exists. */
  loadMessages: (peerId: number, mids: number[]) => PromiseLike<readonly (MessageType | undefined)[]>,
  /** Paints one recovered message into the open chat. */
  renderMessage: (message: MessageType, reverse: boolean) => void,
  /** False once the chat has switched, so a late result is dropped. */
  isActualPeer?: (peerId: number) => boolean
};

export function createHistorySelfHeal<MessageType>({
  loadMessages,
  renderMessage,
  isActualPeer
}: HistorySelfHealOptions<MessageType>) {
  let healedPeerId: number | undefined;

  return {
    /** Called when the bubbles are torn down for the next chat open. */
    reset() {
      healedPeerId = undefined;
    },

    /**
     * Repairs one rendered page. Fire-and-forget: the page itself renders
     * immediately, recovered bubbles are painted when they arrive.
     * @returns the mids that were re-read (empty when nothing needed healing).
     */
    heal(
      peerId: number,
      history: readonly (number | unknown)[],
      resolved: readonly unknown[],
      reverse: boolean
    ): Promise<number[]> {
      const missing = collectMissingHistoryMids(history, resolved);
      if(!missing.length || healedPeerId === peerId) return Promise.resolve([] as number[]);

      healedPeerId = peerId;

      // Best-effort: a failed repair must never break the page that already
      // rendered, so the caller's loader is allowed to fail silently here.
      return Promise.resolve(loadMessages(peerId, missing)).then((messages): number[] => {
        if(isActualPeer && !isActualPeer(peerId)) return [];

        for(let i = 0; i < missing.length; ++i) {
          const message = messages?.[i];
          if(message) renderMessage(message, reverse);
        }

        return missing;
      }).catch((): number[] => []);
    }
  };
}
