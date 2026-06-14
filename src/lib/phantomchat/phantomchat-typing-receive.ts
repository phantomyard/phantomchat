/**
 * Typing-indicator receiver — handles kind-20001 (NIP-16 ephemeral) events.
 *
 * A peer (phantombot, or another PhantomChat client) publishes a kind-20001
 * event p-tagged to us roughly every couple of seconds while it is composing a
 * reply. We translate each one into a NATIVE tweb `updateUserTyping` local
 * update, which `appProfileManager.onUpdateUserTyping` turns into the inherited
 * three-dots indicator AND auto-expires after 6s. Because the sender re-emits
 * every ~2s, the 6s timer keeps resetting while it works and the dots vanish a
 * few seconds after it stops — identical to Signal / native Telegram.
 *
 * Why this is safe / cheap:
 *   - Ephemeral (kind 20000–29999): relays don't store it, so there is nothing
 *     to replay on reconnect — no stale "ghost typing".
 *   - We still drop events older than STALE_MS defensively, in case a relay
 *     redelivers one, and verify the Schnorr signature so a hostile relay can't
 *     forge a spurious indicator from someone else's pubkey.
 *   - `#p` is checked defensively even though the subscription filter already
 *     constrains it to our pubkey.
 *
 * Author integrity: `event.pubkey` is the cryptographic author (verified). We
 * never trust any field in `content` (it is empty by contract anyway).
 */
import rootScope from '@lib/rootScope';
import {verifyEvent} from 'nostr-tools/pure';
import {PhantomChatPeerMapper} from './phantomchat-peer-mapper';

const LOG_PREFIX = '[PhantomChatTypingReceive]';

/** Drop typing events whose created_at is older than this (seconds). */
const STALE_SECONDS = 30;

interface NostrEventLite {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: any[][];
  content: string;
  sig?: string;
}

/** Maps a 64-hex pubkey to the deterministic virtual peerId. */
type PeerResolver = (pubkey: string) => Promise<number>;

/** Injects the typing update into tweb. Default → apiUpdatesManager. */
type TypingDispatcher = (peerId: number) => void;

/** Verifies a Nostr event's Schnorr signature. Default → nostr-tools. */
type SignatureVerifier = (event: NostrEventLite) => boolean;

class PhantomChatTypingReceive {
  private ownPubkey = '';
  private mapper = new PhantomChatPeerMapper();
  private resolver: PeerResolver = (pubkey) => this.mapper.mapPubkey(pubkey);
  private verify: SignatureVerifier = (event) => {
    try {
      return verifyEvent(event as any);
    } catch{
      return false;
    }
  };
  private dispatcher: TypingDispatcher = (peerId) => {
    // Native path: a local `updateUserTyping` populates appProfileManager's
    // typingsInPeer store (which the topbar reads back via getPeerTypings) AND
    // dispatches `peer_typings`, AND arms the 6s auto-expiry. We never await —
    // a typing tick is fire-and-forget and must not block the relay callback.
    Promise.resolve(
      rootScope.managers.apiUpdatesManager.processLocalUpdate({
        _: 'updateUserTyping',
        user_id: peerId,
        action: {_: 'sendMessageTypingAction'}
      } as any)
    ).catch((err) => {
      console.debug(LOG_PREFIX, 'processLocalUpdate failed:', err?.message);
    });
  };

  setOwnPubkey(pk: string) { this.ownPubkey = pk; }

  /** Test seam: override how a pubkey resolves to a peerId. */
  setPeerResolver(r: PeerResolver) { this.resolver = r; }
  /** Test seam: override how the typing update is injected. */
  setTypingDispatcher(d: TypingDispatcher) { this.dispatcher = d; }
  /** Test seam: override signature verification. */
  setSignatureVerifier(v: SignatureVerifier) { this.verify = v; }

  async onTyping(event: NostrEventLite): Promise<void> {
    if(event.kind !== 20001) return;

    // Never show a typing indicator for ourselves.
    if(this.ownPubkey && event.pubkey === this.ownPubkey) return;

    // Defensive #p check — subscription already filters, but a permissive
    // relay could deliver an unaddressed event.
    if(this.ownPubkey) {
      const pTags = event.tags.filter((t) => t[0] === 'p');
      if(pTags.length > 0 && !pTags.some((t) => t[1] === this.ownPubkey)) return;
    }

    // Drop stale redeliveries (ephemeral events shouldn't be stored, but a
    // misbehaving relay might). A live typing tick is always near-now.
    const ageSeconds = Math.floor(Date.now() / 1000) - event.created_at;
    if(ageSeconds > STALE_SECONDS) return;

    // Verify the signature so a hostile relay can't forge an indicator.
    if(!this.verify(event)) {
      console.debug(LOG_PREFIX, 'dropping unverifiable typing event from', event.pubkey?.slice(0, 8));
      return;
    }

    let peerId: number;
    try {
      peerId = await this.resolver(event.pubkey);
    } catch(err) {
      console.debug(LOG_PREFIX, 'peer resolve failed:', (err as Error)?.message);
      return;
    }

    this.dispatcher(peerId);
  }
}

export const phantomchatTypingReceive = new PhantomChatTypingReceive();

if(typeof window !== 'undefined') {
  (window as any).__phantomchatTypingReceive = phantomchatTypingReceive;
}
