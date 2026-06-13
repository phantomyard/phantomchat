/**
 * NIP-25 receiver — handles kind-7 (new reaction) and kind-5 (delete reaction).
 *
 * Out-of-order tolerance: kind-7 can arrive on the wire before the kind-1059
 * gift-wrap of the target message, so when the target eventId isn't resolvable
 * via the message store, the event is buffered for BUFFER_MS; a caller
 * (NostraSync on new-message ingest) may invoke flushPending(eventId).
 *
 * Author integrity:
 *   - kind-7: trust `event.pubkey` as the reactor. Filter at subscription
 *     level ensures `#p: [ownPubkey]`; we re-check defensively.
 *   - kind-5 delete: only accepted when `delete.pubkey === reaction.pubkey`.
 */
import rootScope from '@lib/rootScope';
import {nostraReactionsStore, type ReactionRow} from './nostra-reactions-store';

const BUFFER_MS = 5000;

interface NostrEventLite {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: any[][];
  content: string;
}

type MessageResolver = (eventId: string) => Promise<{mid: number; peerId: number} | undefined>;

interface PendingEntry {
  event: NostrEventLite;
  expiresAt: number;
}

class NostraReactionsReceive {
  private ownPubkey = '';
  private resolver: MessageResolver | null = null;
  private pending = new Map<string, PendingEntry[]>(); // keyed by targetEventId

  setOwnPubkey(pk: string) { this.ownPubkey = pk; }
  setMessageResolver(r: MessageResolver) { this.resolver = r; }

  clearBuffer() { this.pending.clear(); }

  async onKind7(event: NostrEventLite): Promise<void> {
    const eTag = event.tags.find((t) => t[0] === 'e');
    const pTags = event.tags.filter((t) => t[0] === 'p');
    if(!eTag || pTags.length === 0) return; // malformed
    // Accept when ANY `p` tag matches ownPubkey. The publish path adds both
    // the target author AND the conversation peer (when distinct) so that
    // reactions on own messages reach the peer's `#p: [peerPk]` subscription.
    // Checking only the first p-tag would drop those events since the first
    // p-tag is the target author (= reactor's own pubkey, not the peer's).
    if(this.ownPubkey && !pTags.some((t) => t[1] === this.ownPubkey)) return; // not for me
    const targetEventId = eTag[1];
    const target = this.resolver ? await this.resolver(targetEventId) : undefined;
    if(!target) {
      this.bufferEvent(targetEventId, event);
      return;
    }
    await this.persist(event, targetEventId, target.mid, target.peerId);
  }

  async flushPending(targetEventId: string): Promise<void> {
    const queue = this.pending.get(targetEventId);
    if(!queue || !queue.length) return;
    const target = this.resolver ? await this.resolver(targetEventId) : undefined;
    if(!target) return;
    for(const entry of queue) {
      if(Date.now() > entry.expiresAt) continue;
      await this.persist(entry.event, targetEventId, target.mid, target.peerId);
    }
    this.pending.delete(targetEventId);
  }

  async onKind5(event: NostrEventLite): Promise<void> {
    const eTags = event.tags.filter((t) => t[0] === 'e').map((t) => t[1] as string);
    if(!eTags.length) return;
    const rows = await nostraReactionsStore.getAll();
    for(const reactionEventId of eTags) {
      const row = rows.find((r) => r.reactionEventId === reactionEventId);
      if(!row) continue;
      if(row.fromPubkey !== event.pubkey) continue; // author mismatch — reject
      await nostraReactionsStore.removeByReactionEventId(reactionEventId);
      rootScope.dispatchEventSingle('nostra_reactions_changed', {
        peerId: row.targetPeerId,
        mid: row.targetMid
      });
    }
  }

  private bufferEvent(targetEventId: string, event: NostrEventLite): void {
    const list = this.pending.get(targetEventId) || [];
    list.push({event, expiresAt: Date.now() + BUFFER_MS});
    this.pending.set(targetEventId, list);
    setTimeout(() => {
      const cur = this.pending.get(targetEventId);
      if(!cur) return;
      const live = cur.filter((e) => e.expiresAt > Date.now());
      if(live.length === 0) this.pending.delete(targetEventId);
      else this.pending.set(targetEventId, live);
    }, BUFFER_MS + 100);
  }

  private async persist(event: NostrEventLite, targetEventId: string, targetMid: number, targetPeerId: number): Promise<void> {
    const row: ReactionRow = {
      targetEventId,
      targetMid,
      targetPeerId,
      fromPubkey: event.pubkey,
      emoji: event.content,
      reactionEventId: event.id,
      createdAt: event.created_at
    };
    await nostraReactionsStore.add(row);
    rootScope.dispatchEventSingle('nostra_reactions_changed', {
      peerId: targetPeerId,
      mid: targetMid
    });
  }
}

export const nostraReactionsReceive = new NostraReactionsReceive();

if(typeof window !== 'undefined') {
  (window as any).__nostraReactionsReceive = nostraReactionsReceive;
}
