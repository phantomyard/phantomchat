/**
 * NIP-25 publisher — kind-7 (reaction) + kind-5 (delete for remove).
 *
 * The module is a thin orchestrator: ChatAPI signs & fans out, store
 * persists. Consumers (appReactionsManager P2P shortcut, fuzz actions)
 * invoke publish()/unpublish() synchronously vs the UI update — the UI
 * reads the store, not the network.
 */
import rootScope from '@lib/rootScope';
import {nostraReactionsStore} from './nostra-reactions-store';
import {getPubkey as getPeerPubkeyByPeerId} from './virtual-peers-db';

export interface PublishArgs {
  targetEventId: string;
  targetMid: number;
  targetPeerId: number;
  targetAuthor: string;
  emoji: string;
}

interface ChatAPILike {
  publishEvent(unsigned: {kind: number; created_at: number; tags: string[][]; content: string}): Promise<{id: string; pubkey: string; sig: string; kind: number; created_at: number; tags: string[][]; content: string}>;
  ownId: string;
}

let chatAPI: ChatAPILike | null = null;

export function setChatAPI(c: ChatAPILike) {
  chatAPI = c;
}

class NostraReactionsPublish {
  async publish(args: PublishArgs): Promise<string> {
    if(!chatAPI) throw new Error('[nostra-reactions-publish] ChatAPI not wired — call setChatAPI first');
    // Build p-tags:
    //   1. targetAuthor — NIP-25 canonical (author of the reacted-to event).
    //   2. peerPubkey — the OTHER party of this 1-1 P2P conversation, added when
    //      distinct from targetAuthor so the peer's `#p: [peerPk]` relay
    //      subscription delivers this event. Without this tag, reactions on
    //      OWN messages (targetAuthor === ownId) would filter out at the peer's
    //      relay subscription and never propagate. NIP-25 permits additional
    //      `p` tags beyond the reacted-to author.
    const peerPubkey = await getPeerPubkeyByPeerId(args.targetPeerId).catch((): string | null => null);
    const tags: string[][] = [
      ['e', args.targetEventId],
      ['p', args.targetAuthor]
    ];
    if(peerPubkey && peerPubkey !== args.targetAuthor) {
      tags.push(['p', peerPubkey]);
    }
    const unsigned = {
      kind: 7,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: args.emoji
    };
    const signed = await chatAPI.publishEvent(unsigned);
    const reactionEventId = signed?.id;
    if(!reactionEventId) throw new Error('[nostra-reactions-publish] published event has no id');
    await nostraReactionsStore.add({
      targetEventId: args.targetEventId,
      targetMid: args.targetMid,
      targetPeerId: args.targetPeerId,
      fromPubkey: chatAPI.ownId,
      emoji: args.emoji,
      reactionEventId,
      createdAt: unsigned.created_at
    });
    rootScope.dispatchEventSingle('nostra_reactions_changed', {
      peerId: args.targetPeerId,
      mid: args.targetMid
    });
    return reactionEventId;
  }

  async unpublish(reactionEventId: string): Promise<void> {
    if(!chatAPI) throw new Error('[nostra-reactions-publish] ChatAPI not wired');
    const rows = await nostraReactionsStore.getAll();
    const row = rows.find((r) => r.reactionEventId === reactionEventId);
    if(!row) return;
    // `p` tag with own pubkey makes the kind-5 delete pass our own
    // `#p: [ownPubkey]` subscription filter (so we see self-echo).
    // Also p-tag the conversation peer (when distinct) so their
    // `#p: [peerPk]` subscription delivers the delete for symmetry with
    // the kind-7 publish path — otherwise a removeReaction on an own-
    // message reaction would be invisible to the peer. NIP-09 permits
    // additional tags beyond the target `e`.
    const peerPubkey = await getPeerPubkeyByPeerId(row.targetPeerId).catch((): string | null => null);
    const tags: string[][] = [['e', reactionEventId], ['p', chatAPI.ownId]];
    if(peerPubkey && peerPubkey !== chatAPI.ownId) {
      tags.push(['p', peerPubkey]);
    }
    const unsigned = {
      kind: 5,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: ''
    };
    await chatAPI.publishEvent(unsigned);
    await nostraReactionsStore.removeByReactionEventId(reactionEventId);
    rootScope.dispatchEventSingle('nostra_reactions_changed', {
      peerId: row.targetPeerId,
      mid: row.targetMid
    });
  }
}

export const nostraReactionsPublish = new NostraReactionsPublish();

if(typeof window !== 'undefined') {
  (window as any).__nostraReactionsPublish = nostraReactionsPublish;
}
