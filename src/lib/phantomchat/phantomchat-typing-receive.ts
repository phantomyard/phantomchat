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
import {groupIdToPeerId} from './group-types';
import {ensureSenderUserInjected} from './ensure-sender-user-injected';

const LOG_PREFIX = '[PhantomChatTypingReceive]';

/** Drop typing events whose created_at is older than this (seconds). */
const STALE_SECONDS = 30;

/**
 * Content marker on a kind-20001 event. Empty = "typing now" (start/refresh);
 * `'stop'` = "stopped" (cancel immediately). Mirrors phantombot's transport so
 * a reply-published STOP clears the dots at once instead of waiting out the 6s
 * auto-expiry — the "typing lingers after the answer" fix.
 */
const TYPING_STOP = 'stop';

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

/** Maps a group id to its deterministic (negative) group peerId. */
type GroupResolver = (groupId: string) => Promise<number>;

/**
 * Injects a 1:1 typing update into tweb. `isStop` true cancels the indicator.
 * Default → apiUpdatesManager `updateUserTyping`.
 */
type TypingDispatcher = (peerId: number, isStop?: boolean) => void;

/**
 * Injects a GROUP typing update into tweb. `chatId` is the positive chat id,
 * `fromUserPeerId` the member who's typing. `isStop` cancels. Default →
 * apiUpdatesManager `updateChatUserTyping` (which natively renders the member's
 * name and aggregates "Lena and Kai are typing…").
 */
type GroupTypingDispatcher = (chatId: number, fromUserPeerId: number, isStop?: boolean) => void;

/** Ensures a User exists for a pubkey so the group typing name renders. */
type UserEnsurer = (pubkey: string, peerId: number) => Promise<void>;

/** Verifies a Nostr event's Schnorr signature. Default → nostr-tools. */
type SignatureVerifier = (event: NostrEventLite) => boolean;

class PhantomChatTypingReceive {
  private ownPubkey = '';
  private mapper = new PhantomChatPeerMapper();
  private resolver: PeerResolver = (pubkey) => this.mapper.mapPubkey(pubkey);
  private groupResolver: GroupResolver = (groupId) => groupIdToPeerId(groupId);
  private verify: SignatureVerifier = (event) => {
    try {
      return verifyEvent(event as any);
    } catch{
      return false;
    }
  };
  private ensureUser: UserEnsurer = async(pubkey, peerId) => {
    await ensureSenderUserInjected({senderPubkey: pubkey, peerId, logPrefix: LOG_PREFIX});
  };
  private dispatcher: TypingDispatcher = (peerId, isStop) => {
    // Native path: a local `updateUserTyping` populates appProfileManager's
    // typingsInPeer store (which the topbar reads back via getPeerTypings) AND
    // dispatches `peer_typings`, AND arms the 6s auto-expiry. We never await —
    // a typing tick is fire-and-forget and must not block the relay callback.
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
  private groupDispatcher: GroupTypingDispatcher = (chatId, fromUserPeerId, isStop) => {
    // `updateChatUserTyping` routes the dots into the group chat. tweb resolves
    // the typing member from `from_id` and renders their name, aggregating
    // multiple typers natively — so a group reply-in-progress shows "Lena is
    // typing…" in the group, not as a 1:1 DM indicator.
    Promise.resolve(
      rootScope.managers.apiUpdatesManager.processLocalUpdate({
        _: 'updateChatUserTyping',
        chat_id: chatId,
        from_id: {_: 'peerUser', user_id: fromUserPeerId},
        action: {_: isStop ? 'sendMessageCancelAction' : 'sendMessageTypingAction'}
      } as any)
    ).catch((err) => {
      console.debug(LOG_PREFIX, 'group processLocalUpdate failed:', err?.message);
    });
  };

  setOwnPubkey(pk: string) { this.ownPubkey = pk; }

  /** Test seam: override how a pubkey resolves to a peerId. */
  setPeerResolver(r: PeerResolver) { this.resolver = r; }
  /** Test seam: override how a group id resolves to its (negative) peerId. */
  setGroupResolver(r: GroupResolver) { this.groupResolver = r; }
  /** Test seam: override how the 1:1 typing update is injected. */
  setTypingDispatcher(d: TypingDispatcher) { this.dispatcher = d; }
  /** Test seam: override how the group typing update is injected. */
  setGroupTypingDispatcher(d: GroupTypingDispatcher) { this.groupDispatcher = d; }
  /** Test seam: override the user-ensure step. */
  setUserEnsurer(e: UserEnsurer) { this.ensureUser = e; }
  /** Test seam: override signature verification. */
  setSignatureVerifier(v: SignatureVerifier) { this.verify = v; }

  async onTyping(event: NostrEventLite): Promise<void> {
    if(event.kind !== 20001) return;

    // Never show a typing indicator for ourselves.
    if(this.ownPubkey && event.pubkey === this.ownPubkey) return;

    // Defensive #p check — subscription already filters, but a permissive
    // relay could deliver an unaddressed event. For a GROUP tick the p-tags are
    // the members (which include us), so this still passes legitimately.
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

    // 'stop' marker → cancel the indicator immediately instead of letting it
    // ride the 6s auto-expiry.
    const isStop = event.content === TYPING_STOP;

    let senderPeerId: number;
    try {
      senderPeerId = await this.resolver(event.pubkey);
    } catch(err) {
      console.debug(LOG_PREFIX, 'peer resolve failed:', (err as Error)?.message);
      return;
    }

    // GROUP tick: a ['group', id] tag means the dots belong in the group chat,
    // not the sender's DM. Resolve the group's chat peerId and dispatch a
    // chat-typing update keyed to the member who's typing.
    const groupTag = event.tags.find((t) => t[0] === 'group' && typeof t[1] === 'string' && t[1].length > 0);
    if(groupTag) {
      let groupPeerId: number;
      try {
        groupPeerId = await this.groupResolver(groupTag[1]);
      } catch(err) {
        console.debug(LOG_PREFIX, 'group resolve failed:', (err as Error)?.message);
        return;
      }
      // Ensure the typing member has a User so the name renders (idempotent).
      // Skip on stop — there's nothing to label when clearing.
      if(!isStop) {
        try {
          await this.ensureUser(event.pubkey, senderPeerId);
        } catch(err) {
          console.debug(LOG_PREFIX, 'ensureUser non-critical:', (err as Error)?.message);
        }
      }
      // groupPeerId is negative (peerChat); chat_id is the positive chat id.
      this.groupDispatcher(-groupPeerId, senderPeerId, isStop);
      return;
    }

    this.dispatcher(senderPeerId, isStop);
  }
}

export const phantomchatTypingReceive = new PhantomChatTypingReceive();

if(typeof window !== 'undefined') {
  (window as any).__phantomchatTypingReceive = phantomchatTypingReceive;
}
