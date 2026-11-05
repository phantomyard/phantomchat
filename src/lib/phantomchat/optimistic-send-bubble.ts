/**
 * Guards for the optimistic own-message bubble on PhantomChat peers.
 *
 * For a 1:1 P2P or group text send, the Virtual MTProto Server (or GroupAPI)
 * paints the user's bubble straight away under the REAL mid, and the Worker
 * deliberately skips its own temp-mid `history_append` so the bubble is not
 * drawn twice. The Worker still unshifts the temp mid into the peer's history
 * slice, though, so any history load that runs while the send is in flight can
 * pull the temp message back out and draw it as a second bubble. On a brand-new
 * contact the empty chat keeps re-running that load until its first message
 * lands, so the very first send is the one that shows a duplicate. When the
 * send then settles, `message_sent` renamed that temp bubble onto the real mid,
 * which already had a bubble: two bubbles under one mid, only one of them
 * tracked (and so the only one that gets its read tick).
 */
import {isGroupPeer} from './group-types';

const P2P_PEER_MIN = 1e15;

type MessageLike = {
  _?: string;
  peerId?: number | string;
  media?: {_?: string};
  /** Set by tweb on a send that failed (see bubbles.ts `message.error`). */
  error?: unknown;
  pFlags?: {is_outgoing?: boolean | true};
};

function isPhantomChatPeer(peerId: number): boolean {
  return peerId >= P2P_PEER_MIN || isGroupPeer(peerId);
}

/**
 * True for the Worker's temp copy of an in-flight TEXT send to a PhantomChat
 * peer: the bubble for it is already painted under the real mid, so a history
 * render must skip it. Media sends are left alone (their upload bubble is keyed
 * by the temp mid on purpose), and so are FAILED sends: their temp copy is the
 * only bubble that carries the error state and the retry, so hiding it would
 * make a failed message vanish.
 */
export function isPaintedTempSend(message: MessageLike | undefined): boolean {
  if(!message || message._ !== 'message') return false;
  if(!message.pFlags?.is_outgoing) return false;
  if(message.error) return false;
  const media = message.media;
  if(media && media._ !== 'messageMediaEmpty') return false;
  return isPhantomChatPeer(Number(message.peerId));
}

/**
 * What `message_sent` should do with the temp bubble once the real mid is
 * known: rename it (the normal tweb path), drop it because the real mid already
 * has its own bubble, or nothing when no temp bubble was drawn.
 */
export function resolveSentTempBubble<T>(tempBubble: T | undefined, realBubble: T | undefined): 'rename' | 'drop-temp' | 'none' {
  if(!tempBubble) return 'none';
  if(realBubble && realBubble !== tempBubble) return 'drop-temp';
  return 'rename';
}
