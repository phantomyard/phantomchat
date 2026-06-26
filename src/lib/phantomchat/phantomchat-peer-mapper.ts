/**
 * PhantomChatPeerMapper
 *
 * Factory for creating properly-shaped tweb-native objects (User, Chat, Message, Dialog)
 * from Nostr data. Centralises the synthetic object construction that was previously
 * scattered across phantomchat-display-bridge and phantomchat-bridge.
 */

import type {User, Chat, Dialog, Message, MessageEntity, Peer, PeerNotifySettings} from '@layer';
import {PhantomChatBridge} from './phantomchat-bridge';
import wrapMessageEntities from '@lib/richTextProcessor/wrapMessageEntities';
import parseMarkdown from '@lib/richTextProcessor/parseMarkdown';
import {renderMarkdownTables} from '@lib/phantomchat/markdown-tables';

export interface CreateUserOpts {
  peerId: number;
  firstName?: string;
  lastName?: string;
  pubkey: string;
  /**
   * Mark the user as a bot (sets `pFlags.bot`, so `appUsersManager.isBot`
   * returns true). Resolved from the peer's kind-0 `bot` flag by the caller
   * (virtual-mtproto-server). Drives the bot badge and unlocks the "/" command
   * menu in the chat input.
   */
  bot?: boolean;
}

export interface CreateChatOpts {
  chatId: number;
  title: string;
  membersCount: number;
  date: number;
}

export interface CreateMessageOpts {
  mid: number;
  peerId: number;
  fromPeerId?: number;
  date: number;
  text: string;
  isOutgoing: boolean;
  media?: any;
  /**
   * tweb mid of the message this one is a reply to. When set, surfaces as
   * `messageReplyHeader.reply_to_msg_id` so the bubble renderer adds the
   * `.reply` quote header. Resolved from the rumor's NIP-10 `['e', id, '',
   * 'reply']` tag by chat-api-receive (incoming) or from the original row's
   * mid by chat-api.sendMessage (outgoing).
   */
  replyToMid?: number;
  /**
   * Persisted delivery state of an OUTGOING message. Drives the bubble tick at
   * render time: 'delivered'/'read' → `pFlags.unread = false` → double check
   * (is-read); anything else → single check (is-sent). Threading it through the
   * MODEL is what makes the ✓✓ survive re-renders — a DOM-only patch
   * (applyBubbleState) is wiped the next time tweb re-renders the bubble from
   * `message.pFlags.unread` (bubbles.ts:8629). Ignored for incoming.
   */
  deliveryState?: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
}

export interface CreateDialogOpts {
  peerId: number;
  topMessage: number;
  topMessageDate: number;
  unreadCount?: number;
  isGroup?: boolean;
  readInboxMaxId?: number;
  readOutboxMaxId?: number;
}

export class PhantomChatPeerMapper {
  /**
   * Creates a User.user object from Nostr data.
   * Falls back to first 12 chars of pubkey if no firstName provided.
   */
  createTwebUser(opts: CreateUserOpts): User.user {
    let displayName = opts.firstName;
    if(!displayName) {
      // Use first 12 chars of pubkey as display name fallback.
      // (npubEncode is async-loaded; callers that need npub should pass firstName.)
      displayName = opts.pubkey.slice(0, 12);
    }

    const user: User.user = {
      _: 'user',
      id: opts.peerId,
      first_name: displayName,
      last_name: opts.lastName,
      // `bot` flips the bot badge + unlocks the "/" command menu (see isBot).
      pFlags: opts.bot ? {bot: true} : {},
      access_hash: '0',
      // No presence in PhantomChat (Telegram-style: we don't show online /
      // last-seen). userStatusEmpty renders no subtitle — see
      // getUserStatusString — instead of a misleading "last seen recently".
      status: {_: 'userStatusEmpty'}
    } as User.user;

    // Store pubkey for avatar derivation and relay lookups
    (user as any).p2pPubkey = opts.pubkey;

    return user;
  }

  /**
   * Creates a Chat.chat object for a group peer.
   */
  createTwebChat(opts: CreateChatOpts): Chat.chat {
    // P2P groups have no server-side moderation today — everyone can send.
    // `default_banned_rights` with empty pFlags makes `hasRights` return true
    // for all send_* actions in src/lib/appManagers/utils/chats/hasRights.ts.
    // When per-role permissions land (Telegram-style admin/banned rights),
    // populate `admin_rights` / `banned_rights` per member from group-store.
    const chat: Chat.chat = {
      _: 'chat',
      id: opts.chatId,
      title: opts.title,
      participants_count: opts.membersCount,
      date: opts.date,
      pFlags: {},
      default_banned_rights: {
        _: 'chatBannedRights',
        pFlags: {},
        until_date: 0
      }
    } as Chat.chat;

    return chat;
  }

  /**
   * Creates a Message.message object from P2P data.
   * For negative peerId → peerChat; positive → peerUser.
   */
  createTwebMessage(opts: CreateMessageOpts): Message.message {
    const pFlags: Message.message['pFlags'] = {};
    if(opts.isOutgoing) {
      pFlags.out = true;
      // tweb renders the outgoing tick as `pFlags.unread ? 'sent' : 'read'`
      // (bubbles.ts:8629). `unread` is an MTProto flag — present(=true) or
      // ABSENT (never literally false). Once the peer has the message
      // (delivered/read) we OMIT it → double check (is-read), kept across
      // re-renders; otherwise set it → single check (is-sent).
      if(!(opts.deliveryState === 'delivered' || opts.deliveryState === 'read')) {
        pFlags.unread = true;
      }
    } else {
      pFlags.unread = true;
    }

    const isGroup = opts.peerId < 0;
    const chatId = Math.abs(opts.peerId);

    const peer_id: Peer = isGroup ?
      {_: 'peerChat', chat_id: chatId} as Peer.peerChat :
      {_: 'peerUser', user_id: opts.peerId} as Peer.peerUser;

    // `from_id` is set whenever a sender peerId is provided. For outgoing
    // group messages this resolves the sender to the user's own User in the
    // dialog preview ("<my name>: text"); without it, the preview falls
    // back to the chat peer and shows the group title as the sender.
    // For 1-on-1 outgoing, callers omit `fromPeerId` and `pFlags.out` alone
    // remains the ownership signal — preserving the prior behavior.
    let from_id: Peer | undefined;
    if(opts.fromPeerId) {
      from_id = {_: 'peerUser', user_id: opts.fromPeerId} as Peer.peerUser;
    }

    // Compute entities + totalEntities so single-emoji bubbles trigger the
    // big-emoji path on first render. Without this, `bubbles.ts:6537/6542`
    // reads `message.totalEntities` as undefined and the big-emoji
    // detector at `bubbles.ts:6564` is skipped — the bubble shows the
    // native OS glyph until tweb's `saveMessages` later runs
    // `wrapMessageEntities` and populates totalEntities. We replicate
    // that work up-front so first render matches post-reload appearance.
    // Render Markdown: convert the raw text's Markdown (bold/italic/inline-code/
    // fenced code blocks/strikethrough/spoiler/links) into MessageEntities so the
    // bubble renders them richly — Lena (an LLM) emits Markdown, and aligned/0xchat
    // peers may too. parseMarkdown strips the delimiters and returns the clean
    // display text + entities; wrapMessageEntities then layers emoji entities on
    // top. NOTE: tables/lists/headings have no Telegram entity, so they remain raw
    // (a full Markdown→HTML renderer would be a separate, larger change).
    let displayText = opts.text;
    let entities: MessageEntity[] | undefined;
    let totalEntities: MessageEntity[] | undefined;
    if(opts.text) {
      // Reflow GFM tables into aligned monospace blocks first (no table entity
      // exists), then parse the rest of the Markdown into entities.
      const [mdText, mdEntities] = parseMarkdown(renderMarkdownTables(opts.text));
      displayText = mdText;
      const wrapped = wrapMessageEntities(mdText, mdEntities.slice());
      entities = wrapped.totalEntities;
      totalEntities = wrapped.totalEntities;
    }

    const reply_to = opts.replyToMid !== undefined ? {
      _: 'messageReplyHeader',
      pFlags: {},
      reply_to_msg_id: opts.replyToMid
    } : undefined;

    const message: Message.message = {
      _: 'message',
      id: opts.mid,
      peer_id,
      ...(from_id ? {from_id} : {}),
      date: opts.date,
      message: displayText,
      pFlags,
      ...(entities && entities.length ? {entities} : {}),
      ...(opts.media ? {media: opts.media} : {}),
      ...(reply_to ? {reply_to: reply_to as any} : {}),
      // bubbles.ts reads `message.reply_to_mid` (not reply_to.reply_to_msg_id)
      // to resolve the parent and render the .reply preview header. tweb's
      // saveMessages computes this via `generateMessageId(replyTo.reply_to_msg
      // _id, channelId)`, but our synthetic P2P messages bypass that path —
      // we already have the parent's local mid, so stamp it directly. Without
      // this the bubble has no .reply element even though message.reply_to
      // is populated (FIND-191385d3 secondary).
      ...(opts.replyToMid !== undefined ? {reply_to_mid: opts.replyToMid} : {})
    } as Message.message;
    if(totalEntities && totalEntities.length) {
      (message as any).totalEntities = totalEntities;
    }

    // Set mid and peerId explicitly — required for P2P synthetic messages
    // that bypass saveMessages()
    (message as any).mid = opts.mid;
    (message as any).peerId = isGroup ?
      opts.peerId.toPeerId(true) :
      opts.peerId.toPeerId(false);

    // tweb's saveMessages would normally compute `message.fromId` from
    // `from_id` (line 5149 in appMessagesManager), but our P2P render path
    // bypasses that. bubbles.ts reads `message.fromId` directly for the
    // colored-name peerIdForColor and for the createTitle(peerId,...) call —
    // without it the bubble renders `data-peer-id="0"` / "Deleted Account"
    // even though `from_id` is populated (FIND-3ce67f93 sender-side
    // attribution bug on group bubbles).
    if(opts.fromPeerId) {
      (message as any).fromId = opts.fromPeerId;
    } else if(opts.isOutgoing) {
      // Outgoing 1-on-1 fall-back: tweb's saveMessages would set fromId to
      // myId here. We don't have myId in the mapper context, but for 1-on-1
      // P2P chats the bubble doesn't show a name anyway (.hide-name fires
      // when peerId === fromId). Leave undefined.
    }

    return message;
  }

  /**
   * Creates a Dialog.dialog object for a P2P peer.
   * No pFlags.pinned — the pinned flag was a legacy bug.
   */
  createTwebDialog(opts: CreateDialogOpts): Dialog.dialog {
    const now = Math.floor(Date.now() / 1000);
    const sortIndex = (opts.topMessageDate || now) * 0x10000;

    const isGroup = opts.isGroup ?? opts.peerId < 0;
    const chatId = Math.abs(opts.peerId);

    const peer: Peer = isGroup ?
      {_: 'peerChat', chat_id: chatId} as Peer.peerChat :
      {_: 'peerUser', user_id: opts.peerId} as Peer.peerUser;

    const peerId: PeerId = isGroup ?
      opts.peerId.toPeerId(true) :
      opts.peerId.toPeerId(false);

    const dialog = {
      _: 'dialog',
      pFlags: {},
      peer,
      peerId,
      top_message: opts.topMessage,
      read_inbox_max_id: opts.readInboxMaxId ?? 0,
      read_outbox_max_id: opts.readOutboxMaxId ?? 0,
      unread_count: opts.unreadCount ?? 0,
      unread_mentions_count: 0,
      unread_reactions_count: 0,
      folder_id: 0,
      notify_settings: {
        _: 'peerNotifySettings',
        pFlags: {},
        sound: 1,
        show_previews: true,
        silent: false,
        mute_until: 0
      } as PeerNotifySettings,
      pts: undefined
    } as Dialog.dialog;

    (dialog as any)['index_0'] = sortIndex;

    return dialog;
  }

  /**
   * Maps a Nostr pubkey to a tweb virtual peer ID.
   */
  async mapPubkey(pubkey: string): Promise<number> {
    return PhantomChatBridge.getInstance().mapPubkeyToPeerId(pubkey);
  }

  /**
   * Maps a Nostr event ID to a tweb virtual message ID.
   * Timestamp is encoded in the high bits for chronological ordering.
   */
  async mapEventId(eventId: string, timestamp: number): Promise<number> {
    return PhantomChatBridge.getInstance().mapEventIdToMid(eventId, timestamp);
  }
}
