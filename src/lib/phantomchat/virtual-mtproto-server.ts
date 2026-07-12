/**
 * PhantomChatMTProtoServer
 *
 * Pull-based server that intercepts MTProto method calls and returns
 * native tweb-shaped responses built from local Nostr data stores.
 *
 * Replaces push-based injection scattered across phantomchat-display-bridge
 * and phantomchat-bridge with a clean request/response pattern.
 */

import {PhantomChatPeerMapper} from './phantomchat-peer-mapper';
import {getMessageStore} from './message-store';
import {loadCachedPeerProfile, refreshPeerProfileFromRelays} from './peer-profile-cache';
import type {NostrBotCommand} from './nostr-profile';
import {buildPhantomChatMedia} from './phantomchat-media-shape';
import {getPubkey, getMapping, removeMapping} from './virtual-peers-db';
import {swallowHandler} from './log-swallow';
import {isGroupPeer} from './group-types';
import {getReadReceiptsEnabled} from './read-receipts-setting';
import {schedulePublish} from './phantomchat-sync-triggers';
// Lazy imports for group-store / group-api so test files that never hit the
// group branch don't drag phantomchat-groups-sync into their module graph. Each
// test file mocks `@config/debug`'s MOUNT_CLASS_TO with its own proxy; a
// top-level import here binds phantomchat-groups-sync's MOUNT_CLASS_TO to the
// FIRST loader's proxy, which then leaks across test files in the same
// vitest worker (manifested as group-cleanup-mirror asserts failing only
// when run together with vmt-outgoing-dialog).

const LOG_PREFIX = '[VirtualMTProto]';

// Matches 1:1 DM conversationIds: '<64-hex-pubkey>:<64-hex-pubkey>'. Group
// conversationIds are either '<32-hex-groupId>' (group-service-messages) or
// 'group:<32-hex-groupId>' (phantomchat-groups-sync) — neither parses as a
// pair of pubkeys and both must be filtered out of DM iteration sites
// before we feed halves into `mapper.mapPubkey()`.
const ONE_TO_ONE_CONV_ID_RE = /^[0-9a-f]{64}:[0-9a-f]{64}$/i;
function isOneToOneConvId(convId: string): boolean {
  return typeof convId === 'string' && ONE_TO_ONE_CONV_ID_RE.test(convId);
}

// 64-hex Nostr event id (rumor / kind-1059 wrap). NIP-01 fixed-size tags
// `e` / `p` require 32-byte hex. Used by `sendReaction` to drop publishes
// whose target row carries a legacy `chat-XXX-N` app id as `eventId` —
// strfry would reject the kind-7 with "unexpected size for fixed-size
// tag: e" and the user would see the reaction silently fail.
const RUMOR_ID_RE = /^[0-9a-f]{64}$/i;

// Kind-20001 typing indicator (NIP-16 ephemeral). Duplicated from
// nostr-relay.ts's NOSTR_KIND_TYPING as a plain literal so this module's graph
// stays decoupled from the relay transport (same approach as P2P_PEER_ID_MIN in
// bridge-invariants.ts). Keep the two in sync. Also mirrors phantombot.
const KIND_TYPING = 20001;

// Content markers on a kind-20001 event — MUST match the receiver
// (phantomchat-typing-receive.ts): '' = typing now (start/refresh),
// 'recording' = recording voice, 'stop' = stopped (clear immediately).
const TYPING_CONTENT_START = '';
const TYPING_CONTENT_RECORDING = 'recording';
const TYPING_CONTENT_STOP = 'stop';

/**
 * Maps a tweb `SendMessageAction._` to the kind-20001 content marker we relay,
 * or `null` for actions we deliberately don't broadcast (e.g. upload-progress
 * actions like sendMessageUploadDocumentAction — those are local UI only and
 * would just be noise on the wire).
 */
function typingContentForAction(actionType: string): string | null {
  switch(actionType) {
    case 'sendMessageTypingAction':
      return TYPING_CONTENT_START;
    case 'sendMessageRecordAudioAction':
    case 'sendMessageRecordRoundAction':
    case 'sendMessageRecordVideoAction':
      return TYPING_CONTENT_RECORDING;
    case 'sendMessageCancelAction':
      return TYPING_CONTENT_STOP;
    default:
      return null;
  }
}

// ─── Action method patterns ──────────────────────────────────────────

const ACTION_PATTERNS = [
  '.set', '.save', '.delete', '.read', '.mark',
  '.toggle', '.send', '.block', '.unblock', '.join', '.leave'
];

// WU-1 #5: dev/explorer-only diagnostics. Surfaces unhandled silent-noops
// so an unimplemented UI action doesn't disappear unnoticed; off in prod.
const IS_DEV_DIAGNOSTICS = (import.meta as any)?.env?.PROD !== true;

// ─── Known method fallback shapes ───────────────────────────────────

export const PHANTOMCHAT_STATIC: Record<string, any> = {
  'updates.getState': {
    _: 'updates.state',
    pts: 1,
    qts: 0,
    date: Math.floor(Date.now() / 1000),
    seq: 1,
    unread_count: 0
  },
  'updates.getDifference': {
    _: 'updates.differenceEmpty',
    date: Math.floor(Date.now() / 1000),
    seq: 1
  },
  'help.getConfig': {
    _: 'config',
    date: Math.floor(Date.now() / 1000),
    expires: Math.floor(Date.now() / 1000) + 3600,
    test_mode: false,
    this_dc: 1,
    dc_options: [],
    dc_txt_domain_name: '',
    chat_size_max: 200,
    megagroup_size_max: 200000,
    forwarded_count_max: 100,
    online_update_period_ms: 210000,
    offline_blur_timeout_ms: 5000,
    offline_idle_timeout_ms: 30000,
    online_cloud_timeout_ms: 300000,
    notify_cloud_delay_ms: 30000,
    notify_default_delay_ms: 1500,
    push_chat_period_ms: 60000,
    push_chat_limit: 2,
    saved_gifs_limit: 200,
    edit_time_limit: 172800,
    revoke_time_limit: 172800,
    revoke_pm_time_limit: 2147483647,
    rating_e_decay: 2419200,
    stickers_recent_limit: 15,
    stickers_faved_limit: 5,
    channels_read_media_period: 604800,
    pinned_dialogs_count_max: 5,
    pinned_infolder_count_max: 100,
    call_receive_timeout_ms: 20000,
    call_ring_timeout_ms: 90000,
    call_connect_timeout_ms: 30000,
    call_packet_timeout_ms: 10000,
    me_url_prefix: 'https://t.me/',
    autoupdate_url_prefix: '',
    gif_search_username: 'gif',
    venue_search_username: 'foursquare',
    img_search_username: 'bing',
    static_maps_provider: '',
    caption_length_max: 1024,
    message_length_max: 4096,
    webfile_dc_id: 1,
    suggested_lang_code: 'en',
    lang_pack_version: 0,
    base_lang_pack_version: 0,
    pFlags: {}
  },
  'help.getAppConfig': {
    _: 'help.appConfig',
    hash: 0,
    config: {_: 'jsonObject', value: []}
  },
  'account.getNotifySettings': {
    _: 'peerNotifySettings',
    pFlags: {},
    flags: 0
  },
  'langpack.getDifference': {
    _: 'langPackDifference',
    lang_code: 'en',
    from_version: 0,
    version: 1,
    strings: []
  },
  'stories.getAllStories': {
    _: 'stories.allStories',
    pFlags: {},
    count: 0,
    state: '',
    peer_stories: [],
    chats: [],
    users: [],
    stealth_mode: {_: 'storiesStealthMode', pFlags: {}}
  },
  'stories.getPeerStories': {
    _: 'stories.peerStories',
    stories: {_: 'peerStories', pFlags: {}, peer: {_: 'peerUser', user_id: 0}, stories: []},
    chats: [],
    users: []
  },
  'messages.getDialogFilters': [],
  'messages.getSuggestedDialogFilters': [],
  'messages.updateDialogFilter': true,
  'messages.updateDialogFiltersOrder': true,
  'messages.getPinnedDialogs': {
    _: 'messages.peerDialogs',
    dialogs: [],
    messages: [],
    chats: [],
    users: [],
    state: {_: 'updates.state', pts: 1, qts: 0, date: 0, seq: 1, unread_count: 0}
  },
  'messages.getPinnedSavedDialogs': {
    _: 'messages.savedDialogs',
    dialogs: [],
    messages: [],
    chats: [],
    users: []
  },
  'messages.getSavedDialogs': {
    _: 'messages.savedDialogs',
    dialogs: [],
    messages: [],
    chats: [],
    users: []
  },
  'messages.getEmojiKeywordsDifference': {
    _: 'emojiKeywordsDifference',
    lang_code: 'en',
    from_version: 0,
    version: 1,
    keywords: []
  },
  'account.getPassword': {
    _: 'account.password',
    pFlags: {has_password: false},
    new_algo: {_: 'passwordKdfAlgoUnknown'},
    new_secure_algo: {_: 'securePasswordKdfAlgoUnknown'},
    secure_random: new Uint8Array(0)
  },
  'account.getPrivacy': {
    _: 'account.privacyRules',
    rules: [{_: 'privacyValueAllowAll'}],
    chats: [],
    users: []
  },
  'contacts.getTopPeers': {
    _: 'contacts.topPeersDisabled'
  },
  'messages.getStickers': {
    _: 'messages.stickers',
    hash: 0,
    stickers: []
  },
  'messages.getAllStickers': {
    _: 'messages.allStickers',
    hash: 0,
    sets: []
  },
  'messages.getSearchCounters': [],
  'photos.getUserPhotos': {
    _: 'photos.photos',
    photos: [],
    users: []
  }
};

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Extract a numeric peerId from various MTProto peer input formats.
 */
function extractPeerId(peer: any): number | null {
  if(!peer) return null;
  // inputPeerUser / plain user_id
  if(peer.user_id !== undefined) return Number(peer.user_id);
  // inputPeerChat / plain chat_id
  if(peer.chat_id !== undefined) return -Math.abs(Number(peer.chat_id));
  // inputPeerChannel / channel_id
  if(peer.channel_id !== undefined) return -Math.abs(Number(peer.channel_id));
  return null;
}

// A well-formed Telegram-style command name: 1-32 chars, letters/digits/_.
// Anything else in a (relay-sourced, possibly hostile) kind-0 is dropped.
const VALID_BOT_COMMAND = /^[a-zA-Z0-9_]{1,32}$/;

/**
 * Build the single `userFull.bot_info` object from a peer's kind-0 profile.
 * Returns `undefined` for a non-bot (and isBot is false there, so the command
 * menu never runs). For a bot it always returns a botInfo — even with an empty
 * `commands` array — because the upstream processPeerFullForCommands does
 * `[].concat(full.bot_info)` and would crash on `undefined`. The botInfo /
 * botCommand shape mirrors Telegram's so that code consumes it unchanged.
 *
 * Commands come from another peer's kind-0 (relay-sourced, untrusted), so the
 * names are sanitized to the Telegram command grammar and descriptions are
 * length-capped — a malformed/abusive entry is skipped rather than rendered
 * into the user's input typeahead.
 */
function buildBotInfo(peerId: number, profile?: {bot?: boolean; commands?: NostrBotCommand[]}): any {
  if(!profile?.bot) return undefined;
  const commands = (profile.commands ?? [])
  .filter((c) => c && typeof c.command === 'string' && VALID_BOT_COMMAND.test(c.command))
  .map((c) => ({
    _: 'botCommand',
    command: c.command,
    description: typeof c.description === 'string' ? c.description.slice(0, 256) : ''
  }));
  return {_: 'botInfo', pFlags: {}, user_id: peerId, commands};
}

// ─── Server ──────────────────────────────────────────────────────────

export interface PhantomChatMTProtoServerDeps {
  /**
   * Resolve a target message's relay event id + sender pubkey from a
   * peerId + mid pair. Used by `messages.sendReaction` to build the
   * `e`/`p` tags on a kind-7 reaction. Optional DI seam for tests; the
   * default implementation reads from the message-store.
   */
  getMessageByPeerMid?: (peerId: number, mid: number) => Promise<{relayEventId: string; senderPubkey: string} | null> | {relayEventId: string; senderPubkey: string} | null;
}

export class PhantomChatMTProtoServer {
  private mapper: PhantomChatPeerMapper;
  private ownPubkey: string | null;
  private chatAPI: any | null;
  private deps: PhantomChatMTProtoServerDeps;

  // Layer 5: In-memory pubkey cache (peerId → pubkey). Eliminates a redundant
  // IndexedDB read on every getHistory call for known peers. Populated lazily
  // on first lookup, never invalidated (mappings are write-once).
  private pubkeyCache = new Map<number, string>();
  // FIND-0ed3a22c: monotonic pts counter for update-bearing responses with
  // pts_count > 0. apiUpdatesManager.processUpdateMessage gates updates with
  // `if(pts > curState.pts) accept; else if(pts_count) drop as duplicate`,
  // and `updates.getState` initialises curState.pts to 1. Before this counter
  // existed, every deleteMessages return shape was `{pts: 1, pts_count: N}` —
  // collided with curState.pts on the very first call, hit the duplicate
  // branch, and the bubble was never removed from the sender's UI. createChat
  // emitted its updateNewMessage through the same path with the same value
  // and got dropped after the first chat per session. Static returns with
  // pts_count: 0 (deleteHistory at :1734, readHistory at :1789) bypass the
  // dedup gate by design and need not consume from this counter.
  //
  // Persistence-safety: apiUpdatesManager.saveUpdatesState pushes curState.pts
  // to appStateManager state on every assignment (see apiUpdatesManager.ts:65-84
  // Proxy + :77 saveUpdatesState). On reload curState.pts is restored from
  // disk, but a freshly-constructed VMT starts at nextPts=1 — so the second
  // session would re-trigger the original FIND-0ed3a22c bug (nextPts allocates
  // values below the persisted high-water-mark, dedup drops them). The
  // boot-time wiring in pages/phantomchat-onboarding-integration.ts seeds nextPts
  // from the persisted value via seedPts() before the proxy is registered.
  private nextPts: number = 1;

  constructor(deps: PhantomChatMTProtoServerDeps = {}) {
    this.mapper = new PhantomChatPeerMapper();
    this.ownPubkey = null;
    this.chatAPI = null;
    this.deps = deps;
  }

  /**
   * Layer 5: Cached reverse lookup (peerId → pubkey).
   * Wraps the IndexedDB `getPubkey` with an in-memory Map so repeat history
   * fetches skip the IDB read entirely. Mappings are write-once (a peerId
   * never changes its pubkey), so the cache never needs invalidation.
   */
  private async cachedGetPubkey(peerId: number): Promise<string | null> {
    const absPeerId = Math.abs(peerId);
    if(this.pubkeyCache.has(absPeerId)) {
      return this.pubkeyCache.get(absPeerId)!;
    }
    const pubkey = await getPubkey(absPeerId);
    if(pubkey) {
      this.pubkeyCache.set(absPeerId, pubkey);
    }
    return pubkey;
  }

  // Seed the pts high-water-mark from persisted state so a returning user's
  // first allocate exceeds the apiUpdatesManager curState.pts loaded from
  // disk. Idempotent and monotonic-only: a smaller value than the current
  // counter is ignored. Safe to call before or after the first allocation.
  public seedPts(persistedPts: number): void {
    if(typeof persistedPts !== 'number' || !Number.isFinite(persistedPts)) return;
    if(persistedPts > this.nextPts) {
      this.nextPts = persistedPts;
    }
  }

  // Allocate a fresh pts for a response that delivers `count` events. Mirrors
  // upstream Telegram's monotonic pts: the server bumps the counter by `count`
  // and returns the new top-of-window value. apiUpdatesManager then accepts
  // the update through the `pts > curState.pts` branch instead of dropping it
  // as a duplicate.
  //
  // INVARIANT: callers MUST place `allocatePts(...)` as the last sync
  // statement before `return`. JavaScript's single-threaded `++` plus same-
  // tick microtask ordering then guarantees that the order in which two
  // concurrent handleMethod invocations resolve their promises matches the
  // order in which they allocated, so the consumer-side `.then` chain
  // delivers updates to apiUpdatesManager.processLocalUpdate in monotonic
  // pts order. Adding ANY async work after allocatePts (extra `await`,
  // microtask hop) can flip resolve-order vs. allocate-order and the late
  // arrival is dropped as `duplicate update`. If you genuinely need post-
  // allocate async work, allocate INSIDE that work after all awaits.
  private allocatePts(count: number): {pts: number; pts_count: number} {
    this.nextPts += count;
    return {pts: this.nextPts, pts_count: count};
  }

  private async getMessageByPeerMid(peerId: number, mid: number): Promise<{relayEventId: string; senderPubkey: string} | null> {
    if(this.deps.getMessageByPeerMid) {
      const r = await this.deps.getMessageByPeerMid(peerId, mid);
      return r || null;
    }
    try {
      const row = await getMessageStore().getByMid(mid);
      if(!row) return null;
      return {relayEventId: row.eventId, senderPubkey: row.senderPubkey};
    } catch(e) {
      console.warn(LOG_PREFIX, 'getMessageByPeerMid: store lookup failed', e);
      return null;
    }
  }

  setOwnPubkey(pubkey: string): void {
    this.ownPubkey = pubkey;
  }

  setChatAPI(chatAPI: any): void {
    this.chatAPI = chatAPI;
    this.wireRetryListener();
  }

  private retryListenerWired = false;
  private wireRetryListener(): void {
    if(this.retryListenerWired) return;
    this.retryListenerWired = true;
    // Lazy-import rootScope to avoid pulling it into non-browser test paths.
    import('@lib/rootScope').then(({default: rs}) => {
      if(typeof (rs as any).addEventListener !== 'function') return;
      (rs as any).addEventListener('phantomchat_retry_file_send', async(e: {peerId: number; mid: number}) => {
        const {getPendingFileSend} = await import('./phantomchat-send-file');
        const pending = getPendingFileSend(e.mid);
        if(!pending) {
          console.warn(LOG_PREFIX, 'retry: no pending entry for mid', e.mid);
          return;
        }
        await this.phantomchatSendFile({
          peerId: pending.peerId,
          blob: pending.blob,
          type: pending.type,
          caption: pending.caption,
          tempMid: pending.tempMid,
          width: pending.width,
          height: pending.height,
          duration: pending.duration,
          waveform: pending.waveform
        });
      });
    }).catch(swallowHandler('VirtualMTProto.pendingFlush'));
  }

  // WU-1 #5: methods already warned about (warn once per method, dev only).
  private warnedFallbacks = new Set<string>();

  async handleMethod(method: string, params: any): Promise<any> {
    switch(method) {
      case 'messages.getDialogs':
      case 'messages.getPinnedDialogs':
        return this.getDialogs(params);

      case 'messages.getHistory':
        return this.getHistory(params);

      case 'messages.search':
        return this.searchMessages(params);

      case 'contacts.getContacts':
        return this.getContacts();

      case 'contacts.deleteContacts':
        return this.deleteContacts(params);

      case 'users.getFullUser':
        return this.getFullUser(params);

      case 'users.getUsers':
        return this.getUsers(params);

      case 'messages.sendMessage':
        return this.sendMessage(params);

      case 'messages.editMessage':
        return this.editMessage(params);

      case 'messages.sendReaction':
        return this.sendReaction(params);

      case 'messages.sendMedia':
        return this.sendMedia(params);

      case 'phantomchatSendFile':
        return this.phantomchatSendFile(params);

      case 'messages.deleteMessages':
        return this.deleteMessages(params);

      case 'messages.deleteHistory':
        return this.deleteHistory(params, false);

      case 'channels.deleteHistory':
        return this.deleteHistory(params, true);

      case 'messages.readHistory':
        return this.readHistory(params);

      case 'messages.createChat':
        return this.createChat(params);

      case 'channels.createChannel':
        return this.createChannel(params);

      case 'channels.inviteToChannel':
        return this.inviteToChannel(params);

      case 'account.getPrivacy':
        return this.getPrivacy(params);

      case 'account.setPrivacy':
        return this.setPrivacy(params);

      case 'account.getNotifySettings':
        return this.getNotifySettings(params);

      case 'account.updateNotifySettings':
        return this.updateNotifySettings(params);

      case 'messages.editChatTitle':
        return this.editChatTitle(params);

      case 'messages.setTyping':
        return this.setTyping(params);

      default:
        return this.fallback(method, params);
    }
  }

  // ─── Privacy persistence ──────────────────────────────────────────
  //
  // Tweb's appPrivacyManager calls account.setPrivacy/getPrivacy whenever
  // the user toggles a switch in Settings → Privacy. With no explicit
  // handler the previous behaviour was: setPrivacy fell through to the
  // fallback() and returned `true` (silently dropping the user's choice),
  // and getPrivacy in WORKER context returned a hardcoded
  // `[{_:'privacyValueAllowAll'}]` static. The local `processLocalUpdate`
  // optimistic dispatch made the toggle look effective until the next
  // reload, when getPrivacy returned allowAll again and the change was
  // gone. Persist via localStorage so the round-trip is honest.
  //
  // Same shape as the bugs already fixed in WAVE 2.x (delete, reply, pin)
  // — UI shipped, RPC silently no-op'd, audit in WAVE 7 flagged this as
  // the #1 ranked silent-noop candidate. Implementing it preventively
  // before the explorer surfaces it as FIND-* HIGH.
  private privacyKey(inputKey: any): string {
    const k = inputKey?._ ?? '';
    return `phantomchat-privacy:${k}`;
  }

  private async getPrivacy(params: any): Promise<any> {
    const fallbackResponse = {
      _: 'account.privacyRules',
      rules: [{_: 'privacyValueAllowAll'}],
      chats: [] as any[],
      users: [] as any[]
    };
    try {
      if(typeof localStorage === 'undefined') return fallbackResponse;
      const raw = localStorage.getItem(this.privacyKey(params?.key));
      if(!raw) return fallbackResponse;
      const stored = JSON.parse(raw);
      if(!Array.isArray(stored?.rules)) return fallbackResponse;
      return {
        _: 'account.privacyRules',
        rules: stored.rules,
        chats: [] as any[],
        users: [] as any[]
      };
    } catch{
      return fallbackResponse;
    }
  }

  private async setPrivacy(params: any): Promise<any> {
    // Convert tweb's `inputPrivacyValue*` rules into the response-shape
    // `privacyValue*` so the round-trip via getPrivacy returns rules that
    // match what tweb stores in its in-memory privacy map.
    const rules = Array.isArray(params?.rules) ? params.rules.map((r: any) => ({
      ...r,
      _: typeof r?._ === 'string' ? r._.replace(/^inputPrivacy/, 'privacy') : r?._
    })) : [];
    try {
      if(typeof localStorage !== 'undefined') {
        localStorage.setItem(this.privacyKey(params?.key), JSON.stringify({rules}));
      }
    } catch(err) {
      console.warn(LOG_PREFIX, 'setPrivacy persist failed:', err);
    }
    // Tweb's caller does:
    //   .then((privacyRules) => { saveApiUsers(privacyRules.users); ... })
    // so we must return a properly-shaped account.privacyRules envelope.
    return {
      _: 'account.privacyRules',
      rules,
      chats: [] as any[],
      users: [] as any[]
    };
  }

  // ─── Notify settings persistence (WU-1 #4) ────────────────────────
  //
  // Tweb's appNotificationsManager calls account.updateNotifySettings when
  // the user mutes/unmutes a peer and account.getNotifySettings on open.
  // With no handler updateNotifySettings fell through fallback() and the
  // mute was dropped on reload (getNotifySettings returned a static). Same
  // silent-noop shape as setPrivacy — persist per-peer via localStorage.
  private notifyKey(notifyPeer: any): string {
    const t = notifyPeer?._ || 'default';
    if(t === 'inputNotifyPeer') {
      const ip = notifyPeer.peer || {};
      const id = ip.user_id ?? ip.chat_id ?? ip.channel_id ?? '?';
      return `phantomchat-notify:${ip._ || 'peer'}:${id}`;
    }
    return `phantomchat-notify:${t}`;
  }

  private async getNotifySettings(params: any): Promise<any> {
    const base = {_: 'peerNotifySettings', pFlags: {} as any, flags: 0};
    try {
      if(typeof localStorage === 'undefined') return base;
      const raw = localStorage.getItem(this.notifyKey(params?.peer));
      if(!raw) return base;
      const stored = JSON.parse(raw);
      return {
        _: 'peerNotifySettings',
        pFlags: stored?.silent ? {silent: true} : {},
        flags: 0,
        ...stored
      };
    } catch{
      return base;
    }
  }

  private async updateNotifySettings(params: any): Promise<any> {
    try {
      if(typeof localStorage !== 'undefined') {
        const s = params?.settings || {};
        const toStore: any = {};
        if(s.mute_until !== undefined) toStore.mute_until = s.mute_until;
        if(s.silent !== undefined) toStore.silent = s.silent;
        if(s.sound !== undefined) toStore.sound = s.sound;
        if(s.show_previews !== undefined) toStore.show_previews = s.show_previews;
        localStorage.setItem(this.notifyKey(params?.peer), JSON.stringify(toStore));
      }
    } catch(err) {
      console.warn(LOG_PREFIX, 'updateNotifySettings persist failed:', err);
    }
    return true;
  }

  // ─── Group rename wiring (WU-1 #3) ────────────────────────────────
  //
  // The Edit-Chat tab calls appChatsManager.editTitle → messages.editChatTitle
  // for a (basic-chat) phantomchat group. With no handler the rename fell through
  // fallback() and was silently discarded — never reaching other members.
  // GroupAPI.renameGroup already exists; route the live method to it.
  private async editChatTitle(params: any): Promise<any> {
    const emptyUpdates = {
      _: 'updates',
      updates: [] as any[],
      users: [] as any[],
      chats: [] as any[],
      date: Math.floor(Date.now() / 1000),
      seq: 0
    };
    const title = typeof params?.title === 'string' ? params.title.trim() : '';
    const chatId = params?.chat_id;
    if(!title || chatId == null) return emptyUpdates;

    const peerId = -Math.abs(Number(chatId));
    if(!isGroupPeer(peerId)) return emptyUpdates;

    try {
      const {getGroupStore} = await import('./group-store');
      const group = await getGroupStore().getByPeerId(peerId);
      if(!group?.groupId) return emptyUpdates;

      const {getGroupAPI} = await import('./group-api');
      await getGroupAPI().renameGroup(group.groupId, title);
    } catch(err) {
      console.warn(LOG_PREFIX, 'editChatTitle: group rename failed', err);
    }
    return emptyUpdates;
  }

  // ─── Private implementations ──────────────────────────────────────

  private async getDialogs(_params: any): Promise<any> {
    const store = getMessageStore();
    const dialogs: any[] = [];
    const messages: any[] = [];
    const users: any[] = [];
    const chats: any[] = [];

    try {
      const conversationIds = await store.getAllConversationIds();

      for(const convId of conversationIds) {
        try {
          // Skip group conversationIds ('<32-hex>' or 'group:<32-hex>') —
          // the group branch is served elsewhere (getGroupHistory, etc.).
          if(!isOneToOneConvId(convId)) continue;

          const [msgA, msgB] = convId.split(':');
          if(!msgA || !msgB) continue;

          // Determine which pubkey is the peer (not us)
          const peerPubkey = this.ownPubkey && msgA === this.ownPubkey ? msgB :
            this.ownPubkey && msgB === this.ownPubkey ? msgA :
            msgB;

          // Skip self:self conversations — the user is not their own chat.
          if(peerPubkey === this.ownPubkey) continue;

          const latestMsgs = await store.getMessages(convId, 1);
          if(latestMsgs.length === 0) continue;

          const latest = latestMsgs[0];
          const peerId = await this.mapper.mapPubkey(peerPubkey);

          // Identity-triple contract: `latest.mid` is set at creation and
          // never recomputed. If it's missing, an upstream write path is
          // broken — surface loudly rather than silently spawn a ghost mid.
          if(latest.mid == null) {
            console.error(LOG_PREFIX, 'getDialogs: stored message missing mid — upstream write path is broken', {eventId: latest.eventId, timestamp: latest.timestamp});
            throw new Error('StoredMessage.mid is required (getDialogs 1:1 branch)');
          }
          const mid = latest.mid;

          // Read display name from peer mapping (nickname saved at add-contact time)
          const mapping = await getMapping(peerPubkey);
          const user = this.mapper.createTwebUser({
            peerId,
            firstName: mapping?.displayName,
            pubkey: peerPubkey
          });

          const isOutgoing = latest.isOutgoing ?? (latest.senderPubkey === this.ownPubkey);

          const msg = this.mapper.createTwebMessage({
            mid,
            peerId,
            fromPeerId: isOutgoing ? undefined : peerId,
            date: latest.timestamp,
            text: latest.content,
            isOutgoing,
            ...(latest.replyToMid !== undefined ? {replyToMid: latest.replyToMid} : {})
          });

          const readCursor = await store.getReadCursor(convId);
          const unreadCount = this.ownPubkey ?
            await store.countUnread(convId, this.ownPubkey) :
            0;

          const dialog = this.mapper.createTwebDialog({
            peerId,
            topMessage: mid,
            topMessageDate: latest.timestamp,
            unreadCount,
            readInboxMaxId: readCursor,
            readOutboxMaxId: readCursor
          });

          dialogs.push(dialog);
          messages.push(msg);
          users.push(user);
        } catch(err) {
          console.warn(LOG_PREFIX, 'getDialogs: failed for conversation', convId, err);
        }
      }
    } catch(err) {
      console.warn(LOG_PREFIX, 'getDialogs: failed to get conversation IDs', err);
    }

    // Load groups from group-store (may not exist in all environments)
    try {
      const {getGroupStore} = await import('./group-store');
      const groupStore = getGroupStore();
      const groups = await groupStore.getAll();

      for(const group of groups) {
        try {
          const convId = group.groupId;
          const latestMsgs = await store.getMessages(convId, 1);
          const latest = latestMsgs[0];
          const peerId = group.peerId;

          const chat = this.mapper.createTwebChat({
            chatId: Math.abs(peerId),
            title: group.name,
            membersCount: group.members.length,
            date: group.createdAt
          });

          let mid = 0;
          let topDate = group.createdAt;

          if(latest) {
            if(latest.mid == null) {
              console.error(LOG_PREFIX, 'getDialogs: stored group message missing mid — upstream write path is broken', {eventId: latest.eventId, timestamp: latest.timestamp});
              throw new Error('StoredMessage.mid is required (getDialogs group branch)');
            }
            mid = latest.mid;
            topDate = latest.timestamp;

            const isOutgoing = latest.isOutgoing ?? (latest.senderPubkey === this.ownPubkey);
            const fromUserId = isOutgoing ? 0 :
              await this.mapper.mapPubkey(latest.senderPubkey);

            if(latest.serviceType === 'chatCreate') {
              // Emit a tweb service message so the dialog preview reads "Group
              // created" instead of an empty bubble. See group-service-messages.ts.
              const serviceMsg = {
                _: 'messageService',
                pFlags: isOutgoing ? {out: true} : {},
                id: mid,
                peer_id: {_: 'peerChat', chat_id: Math.abs(peerId)},
                from_id: {_: 'peerUser', user_id: fromUserId},
                date: latest.timestamp,
                action: {
                  _: 'messageActionChatCreate',
                  title: latest.servicePayload?.title ?? group.name,
                  users: latest.servicePayload?.memberPeerIds ?? []
                }
              };
              messages.push(serviceMsg);
            } else {
              const fromPeerId = isOutgoing ? undefined : fromUserId;
              const msg = this.mapper.createTwebMessage({
                mid,
                peerId,
                fromPeerId,
                date: latest.timestamp,
                text: latest.content,
                isOutgoing,
                ...(latest.replyToMid !== undefined ? {replyToMid: latest.replyToMid} : {})
              });
              messages.push(msg);
            }
          }

          // Mark the dialog as fully read by setting both read cursors to the
          // top message id. Without this, tweb's getDialogs branch in
          // appMessagesManager triggers `noIdsDialogs` for every group on every
          // pass (top_message > 0, both read markers 0, unread_count 0) →
          // calls reloadConversation → static stub returns empty → no fix →
          // infinite spam loop. The 1:1 branch above already does this with
          // a real readCursor; groups have no per-cursor read state yet, so
          // mid is the safe lower bound (≥ any historical message we'd have).
          const dialog = this.mapper.createTwebDialog({
            peerId,
            topMessage: mid,
            topMessageDate: topDate,
            isGroup: true,
            readInboxMaxId: mid,
            readOutboxMaxId: mid
          });

          dialogs.push(dialog);
          chats.push(chat);
        } catch(err) {
          console.warn(LOG_PREFIX, 'getDialogs: failed for group', group.groupId, err);
        }
      }
    } catch(_err) {
      // group-store may not exist in test environment — silently ignore
    }

    return {
      _: 'messages.dialogs',
      dialogs,
      messages,
      users,
      chats,
      count: dialogs.length
    };
  }

  private async getHistory(params: any): Promise<any> {
    // If called with a pinned filter, return empty (P2P doesn't support pinning)
    const filterType = params?.filter?._ || '';
    if(filterType === 'inputMessagesFilterPinned') {
      return {_: 'messages.messages', messages: [], users: [], chats: [], count: 0};
    }

    const peerId = extractPeerId(params?.peer);
    if(peerId === null) {
      console.warn(LOG_PREFIX, 'getHistory: could not extract peerId from', params?.peer);
      return {_: 'messages.messages', messages: [], users: [], chats: [], count: 0};
    }

    // Group branch: negative peerId → group chat. Read from message-store by
    // conversationId='group:<groupId>' and skip the user-pubkey path.
    if(peerId < 0) {
      return this.getGroupHistory(peerId, params);
    }

    const absPeerId = Math.abs(peerId);
    const pubkey = await this.cachedGetPubkey(absPeerId);

    if(!pubkey) {
      console.warn(LOG_PREFIX, 'getHistory: no pubkey for peerId', absPeerId);
      return {_: 'messages.messages', messages: [], users: [], chats: [], count: 0};
    }

    const store = getMessageStore();
    const convId = this.ownPubkey ?
      store.getConversationId(this.ownPubkey, pubkey) :
      pubkey;

    const limit = params?.limit ?? 50;
    // When tweb does scroll-restoration it sends offset_id + add_offset (derived
    // from backLimit). PhantomChat previously ignored both, so switching back to
    // a scrolled-up chat re-opened at the newest page instead of the restored
    // position. Use getMessagesByOffsetId to paginate by mid instead of only by
    // timestamp.  For plain newest-first fetches (offset_id = 0, add_offset = 0)
    // this is equivalent to the old behaviour.
    const offsetId  = params?.offset_id  ?? 0;
    const addOffset = params?.add_offset ?? 0;
    const storedMsgs = offsetId || addOffset ?
      await store.getMessagesByOffsetId(convId, limit, offsetId, addOffset) :
      await store.getMessages(convId, limit, params?.offset_date || undefined);

    const messages: any[] = [];
    const users: any[] = [];

    const mapping = await getMapping(pubkey);
    const user = this.mapper.createTwebUser({peerId: absPeerId, firstName: mapping?.displayName, pubkey});
    users.push(user);

    for(const stored of storedMsgs) {
      try {
        // Skip synthetic contact-init entries (empty content, used only for dialog creation)
        if(stored.eventId.startsWith('contact-init-') && !stored.content) continue;

        if(stored.mid == null) {
          console.error(LOG_PREFIX, 'getHistory: stored message missing mid — upstream write path is broken', {eventId: stored.eventId, timestamp: stored.timestamp});
          throw new Error('StoredMessage.mid is required (getHistory)');
        }
        const mid = stored.mid;
        const isOutgoing = stored.isOutgoing ?? (stored.senderPubkey === this.ownPubkey);
        const fromPeerId = isOutgoing ? undefined : absPeerId;

        const media = stored.fileMetadata ? buildPhantomChatMedia(mid, stored.fileMetadata) : undefined;

        const msg = this.mapper.createTwebMessage({
          mid,
          peerId: absPeerId,
          fromPeerId,
          date: stored.timestamp,
          text: stored.content,
          isOutgoing,
          media,
          deliveryState: stored.deliveryState,
          ...(stored.replyToMid !== undefined ? {replyToMid: stored.replyToMid} : {})
        });
        messages.push(msg);
      } catch(err) {
        console.warn(LOG_PREFIX, 'getHistory: failed to map message', stored.eventId, err);
      }
    }

    return {
      _: 'messages.messages',
      messages,
      users,
      chats: [],
      count: messages.length
    };
  }

  /**
   * Group-peer variant of getHistory. Reads from message-store keyed by
   * `conversationId = 'group:<groupId>'` and builds tweb messages with
   * `peer_id: peerChat`. Also emits one user entry per distinct sender so
   * the bubble `from_id` resolves to a known peer (required for avatar +
   * "Alice" prefix in the bubble header).
   */
  private async getGroupHistory(peerId: number, params: any): Promise<any> {
    const {getGroupStore} = await import('./group-store');
    const {groupIdToPeerId: g2p} = await import('./group-types');
    const groupStore = getGroupStore();
    let group = await groupStore.getByPeerId(peerId);

    // Self-heal for orphan groups: messages may exist in message-store under
    // 'group:<groupId>' even when the group record is missing from groupStore
    // (e.g. message arrived before the group_create payload, or the record
    // was dropped by an older client). Resolve by scanning conversation IDs
    // and computing groupIdToPeerId for each — bounded by the number of
    // groups the user has ever exchanged messages with.
    const store = getMessageStore();
    if(!group) {
      try {
        const convIds = await store.getAllConversationIds();
        for(const convId of convIds) {
          if(!convId.startsWith('group:')) continue;
          const candidateId = convId.slice('group:'.length);
          const candidatePeerId = await g2p(candidateId);
          if(candidatePeerId === peerId) {
            // Resurrection guard: if the user deliberately deleted this group,
            // a deletion tombstone exists for its conversation. Never rebuild a
            // tombstoned group — purge the orphan messages so the scan can't
            // keep matching it, and fall through to the empty result. This is
            // the fix for "deleted groups keep coming back".
            const deletedAt = await store.getTombstone(convId);
            if(deletedAt > 0) {
              console.warn(LOG_PREFIX, 'getGroupHistory: group is tombstoned (deleted) — refusing resurrection, purging orphan messages', {groupId: candidateId, peerId, deletedAt});
              try {
                await store.deleteMessages(convId);
              } catch(err) {
                console.warn(LOG_PREFIX, 'getGroupHistory: orphan purge after tombstone failed', err);
              }
              break;
            }
            // Synthesize a minimal record + persist so future lookups hit
            // the indexed path. Members are reconstructed from message
            // senders we have on disk; admin defaults to ownPubkey for
            // safety (worst case the user re-elects on next group_admin_transfer).
            const sample = await store.getMessages(convId, 50);
            const memberSet = new Set<string>();
            let earliest = Math.floor(Date.now() / 1000);
            for(const m of sample) {
              if(m.senderPubkey) memberSet.add(m.senderPubkey);
              if(m.timestamp && m.timestamp < earliest) earliest = m.timestamp;
            }
            if(this.ownPubkey) memberSet.add(this.ownPubkey);
            group = {
              groupId: candidateId,
              name: 'Group',
              adminPubkey: this.ownPubkey || '',
              members: Array.from(memberSet),
              peerId,
              createdAt: earliest,
              updatedAt: earliest
            };
            try {
              await groupStore.save(group);
              console.warn(LOG_PREFIX, 'getGroupHistory: rebuilt orphan group record', {groupId: candidateId, peerId, members: group.members.length});
            } catch(err) {
              console.warn(LOG_PREFIX, 'getGroupHistory: rebuild persist failed (continuing in-memory)', err);
            }
            break;
          }
        }
      } catch(err) {
        console.warn(LOG_PREFIX, 'getGroupHistory: orphan recovery scan failed', err);
      }
    }

    if(!group) {
      console.warn(LOG_PREFIX, 'getGroupHistory: no group found for peerId', peerId);
      return {_: 'messages.messages', messages: [], users: [], chats: [], count: 0};
    }

    const convId = `group:${group.groupId}`;
    const limit = params?.limit ?? 50;
    const offsetId  = params?.offset_id  ?? 0;
    const addOffset = params?.add_offset ?? 0;
    const storedMsgs = offsetId || addOffset ?
      await store.getMessagesByOffsetId(convId, limit, offsetId, addOffset) :
      await store.getMessages(convId, limit, params?.offset_date || undefined);

    const messages: any[] = [];
    const users: any[] = [];
    const usersById = new Map<number, any>();

    // Emit a Chat for this group so the response carries everything tweb
    // needs to resolve the peer without a follow-up roundtrip.
    const absPeerId = Math.abs(peerId);
    const chat = this.mapper.createTwebChat({
      chatId: absPeerId,
      title: group.name || 'Group',
      membersCount: group.members?.length ?? 1,
      date: Math.floor((group.createdAt || Date.now()) / 1000)
    });

    for(const stored of storedMsgs) {
      try {
        if(stored.mid == null) {
          console.error(LOG_PREFIX, 'getGroupHistory: stored message missing mid — upstream write path is broken', {eventId: stored.eventId, timestamp: stored.timestamp});
          throw new Error('StoredMessage.mid is required (getGroupHistory)');
        }
        const mid = stored.mid;
        const isOutgoing = stored.isOutgoing ?? (stored.senderPubkey === this.ownPubkey);

        // Map sender pubkey → fromPeerId for both directions. Without
        // a from_id on outgoing rows, tweb's chat-list preview falls back
        // to peer_id (the group) and renders "<group>: text"; the bubble
        // header attribution likewise resolves to the group instead of
        // the user. We always include the sender User in the response so
        // the rebuilt bubble has a valid peer to resolve against.
        const senderPubkey = isOutgoing ? this.ownPubkey : stored.senderPubkey;
        let fromPeerId: number | undefined;
        if(senderPubkey) {
          fromPeerId = await this.mapper.mapPubkey(senderPubkey);
          if(!usersById.has(fromPeerId)) {
            const mapping = await getMapping(senderPubkey);
            const user = this.mapper.createTwebUser({peerId: fromPeerId, firstName: mapping?.displayName, pubkey: senderPubkey});
            usersById.set(fromPeerId, user);
            users.push(user);
          }
        }

        const media = stored.fileMetadata ? buildPhantomChatMedia(mid, stored.fileMetadata) : undefined;

        const msg = this.mapper.createTwebMessage({
          mid,
          peerId, // negative — peer_id becomes peerChat
          fromPeerId,
          date: stored.timestamp,
          text: stored.content,
          isOutgoing,
          media,
          deliveryState: stored.deliveryState,
          ...(stored.replyToMid !== undefined ? {replyToMid: stored.replyToMid} : {})
        });
        messages.push(msg);
      } catch(err) {
        console.warn(LOG_PREFIX, 'getGroupHistory: failed to map message', stored.eventId, err);
      }
    }

    return {
      _: 'messages.messages',
      messages,
      users,
      chats: [chat],
      count: messages.length
    };
  }

  private async searchMessages(params: any): Promise<any> {
    const filterType = params?.filter?._ || '';

    // P2P messages don't support pinning — return empty for pinned filter
    if(filterType === 'inputMessagesFilterPinned') {
      return {
        _: 'messages.messages',
        messages: [],
        users: [],
        chats: [],
        count: 0
      };
    }

    const query = (params?.q ?? '').toLowerCase();
    const store = getMessageStore();
    const messages: any[] = [];
    const users: any[] = [];
    const usersById = new Map<number, any>();

    try {
      const conversationIds = await store.getAllConversationIds();

      for(const convId of conversationIds) {
        try {
          // Group convs are not searched through this 1:1 path.
          if(!isOneToOneConvId(convId)) continue;

          const allMsgs = await store.getMessages(convId, 200);

          for(const stored of allMsgs) {
            if(!stored.content.toLowerCase().includes(query)) continue;

            const [pubkeyA, pubkeyB] = convId.split(':');
            const peerPubkey = this.ownPubkey && pubkeyA === this.ownPubkey ? pubkeyB :
              this.ownPubkey && pubkeyB === this.ownPubkey ? pubkeyA :
              pubkeyB;

            // Skip self:self conversations — don't surface the user as a result.
            if(peerPubkey === this.ownPubkey) continue;

            const peerId = await this.mapper.mapPubkey(peerPubkey);
            if(stored.mid == null) {
              console.error(LOG_PREFIX, 'searchMessages: stored message missing mid — upstream write path is broken', {eventId: stored.eventId, timestamp: stored.timestamp});
              throw new Error('StoredMessage.mid is required (searchMessages)');
            }
            const mid = stored.mid;
            const isOutgoing = stored.isOutgoing ?? (stored.senderPubkey === this.ownPubkey);
            const fromPeerId = isOutgoing ? undefined : peerId;

            const msg = this.mapper.createTwebMessage({
              mid,
              peerId,
              fromPeerId,
              date: stored.timestamp,
              text: stored.content,
              isOutgoing,
              ...(stored.replyToMid !== undefined ? {replyToMid: stored.replyToMid} : {})
            });
            messages.push(msg);

            if(!usersById.has(peerId)) {
              const searchMapping = await getMapping(peerPubkey);
              const user = this.mapper.createTwebUser({peerId, firstName: searchMapping?.displayName, pubkey: peerPubkey});
              usersById.set(peerId, user);
              users.push(user);
            }
          }
        } catch(err) {
          console.warn(LOG_PREFIX, 'searchMessages: failed for conversation', convId, err);
        }
      }
    } catch(err) {
      console.warn(LOG_PREFIX, 'searchMessages: failed to get conversation IDs', err);
    }

    return {
      _: 'messages.messages',
      messages,
      users,
      chats: [],
      count: messages.length
    };
  }

  private async getContacts(): Promise<any> {
    const store = getMessageStore();
    const contacts: any[] = [];
    const users: any[] = [];

    try {
      const conversationIds = await store.getAllConversationIds();

      for(const convId of conversationIds) {
        try {
          // Group convs don't belong in the contacts list — filter them
          // out before we split into pubkey halves. Previously a group
          // conversationId like '71859748…' (32-hex, no colon) produced
          // `peerPubkey === undefined`, which crashed mapPubkey.
          if(!isOneToOneConvId(convId)) continue;

          const [pubkeyA, pubkeyB] = convId.split(':');
          const peerPubkey = this.ownPubkey && pubkeyA === this.ownPubkey ? pubkeyB :
            this.ownPubkey && pubkeyB === this.ownPubkey ? pubkeyA :
            pubkeyB;

          // Skip self:self conversations — the user is not their own contact.
          if(peerPubkey === this.ownPubkey) continue;

          const peerId = await this.mapper.mapPubkey(peerPubkey);
          const peerMapping = await getMapping(peerPubkey);
          const user = this.mapper.createTwebUser({peerId, firstName: peerMapping?.displayName, pubkey: peerPubkey});

          contacts.push({
            _: 'contact',
            user_id: peerId,
            mutual: false
          });
          users.push(user);
        } catch(err) {
          console.warn(LOG_PREFIX, 'getContacts: failed for conversation', convId, err);
        }
      }
    } catch(err) {
      console.warn(LOG_PREFIX, 'getContacts: failed to get conversation IDs', err);
    }

    return {
      _: 'contacts.contacts',
      contacts,
      saved_count: 0,
      users
    };
  }

  /**
   * Delete one or more contacts.
   *
   * In phantomchat the contact list is DERIVED from conversations (see
   * getContacts) — there is no standalone address book. So "delete contact"
   * only sticks if the underlying conversation is wiped too; otherwise
   * getContacts re-derives the contact on the next refresh and relay replays
   * re-create its dialog. We therefore mirror deleteHistory: wipe local
   * messages + write the deletion watermark (tombstone) so replays can't
   * boomerang it back, then dispatch `phantomchat_conversation_deleted` so the
   * display layer drops the dialog from the chat list.
   *
   * Previously this method had no handler and fell through `fallback()`, which
   * returned `true` and silently dropped the user's request (the reported
   * "deleted people keep coming back" bug).
   */
  private async deleteContacts(params: any): Promise<any> {
    const emptyUpdates = {_: 'updates', updates: [] as any[], users: [] as any[], chats: [] as any[], date: Math.floor(Date.now() / 1000), seq: 0};

    const inputUsers: any[] = Array.isArray(params?.id) ? params.id : [];
    if(inputUsers.length === 0 || !this.ownPubkey) {
      return emptyUpdates;
    }

    const store = getMessageStore();
    const now = Math.floor(Date.now() / 1000);

    for(const input of inputUsers) {
      try {
        const peerId = extractPeerId(input) ?? (typeof input?.user_id !== 'undefined' ? Number(input.user_id) : null);
        if(peerId === null || peerId <= 0) continue;

        const pubkey = await this.cachedGetPubkey(Math.abs(peerId));
        if(!pubkey) {
          console.warn(LOG_PREFIX, 'deleteContacts: no pubkey for peerId', peerId);
          continue;
        }

        const conversationId = store.getConversationId(this.ownPubkey, pubkey);
        await store.deleteMessages(conversationId);
        await store.setTombstone(conversationId, now);
        // Remove the peer from virtual-peers-db too. Tombstones only gate
        // MESSAGE replays; the Contacts tab re-enumerates people straight from
        // getAllMappings(), so without this the deleted contact reappears on
        // every reload (delete-boomerang). removeMapping closes that door.
        try {
          await removeMapping(pubkey);
        } catch(err) {
          console.warn(LOG_PREFIX, 'deleteContacts: removeMapping failed', err);
        }
        console.log(LOG_PREFIX, 'deleteContacts: wiped + tombstoned + unmapped conversation', conversationId);

        // Drop the dialog from the chat list (display layer listens for this).
        try {
          const rs: any = (await import('@lib/rootScope')).default;
          rs.dispatchEvent('phantomchat_conversation_deleted', {peerPubkey: pubkey, conversationId});
        } catch(err) {
          console.warn(LOG_PREFIX, 'deleteContacts: dialog-drop dispatch failed', err);
        }
      } catch(err) {
        console.warn(LOG_PREFIX, 'deleteContacts: failed for input', input, err);
      }
    }

    // Propagate the deletion cross-device (debounced). The contacts-sync
    // adapter derives the tombstone from the watermark written above.
    schedulePublish('contacts');
    return emptyUpdates;
  }

  private async getFullUser(params: any): Promise<any> {
    const peerId = extractPeerId(params?.id) ?? extractPeerId(params);
    if(peerId === null) {
      return {_: 'users.userFull', users: [], full_user: {_: 'userFull', pFlags: {}}};
    }

    const absPeerId = Math.abs(peerId);
    const pubkey = await this.cachedGetPubkey(absPeerId) ?? '';
    const mapping = await getMapping(pubkey);

    // Hydrate `about` (+ the bot flag / advertised commands) from the cached
    // kind-0, then fire a background refresh. The refresh lands via
    // phantomchat_peer_profile_updated and is consumed by the
    // peerPhantomChatProfile store, which drives the User Info rows directly.
    const profile = pubkey ? loadCachedPeerProfile(pubkey)?.profile : undefined;
    let about = '';
    if(pubkey) {
      if(profile?.about) about = profile.about;
      // Fire-and-forget — do NOT await; UI updates via rootScope event.
      refreshPeerProfileFromRelays(pubkey, absPeerId as unknown as PeerId).catch(swallowHandler('VirtualMTProto.refreshPeerProfile'));
    }

    // `bot: true` flips pFlags.bot so appUsersManager.isBot returns true, which
    // is what unlocks the chat input's "/" command menu (CommandsHelper).
    const user = this.mapper.createTwebUser({peerId: absPeerId, firstName: mapping?.displayName, pubkey, bot: !!profile?.bot});

    return {
      _: 'users.userFull',
      users: [user],
      full_user: {
        _: 'userFull',
        id: absPeerId,
        pFlags: {},
        settings: {_: 'peerSettings', pFlags: {}},
        profile_photo: {_: 'photoEmpty', id: 0},
        notify_settings: {_: 'peerNotifySettings', pFlags: {}},
        common_chats_count: 0,
        about,
        // bot_info carries the advertised slash commands so CommandsHelper can
        // render the "/" typeahead. The botInfo shape mirrors Telegram's, so
        // upstream processPeerFullForCommands consumes it unchanged.
        bot_info: buildBotInfo(absPeerId, profile)
      }
    };
  }

  private async getUsers(params: any): Promise<any[]> {
    const ids: any[] = params?.id || [];
    const users: any[] = [];
    for(const inputUser of ids) {
      const userId = inputUser?.user_id ?? inputUser;
      if(!userId) continue;
      const pubkey = await this.cachedGetPubkey(userId);
      if(!pubkey) continue;
      const userMapping = await getMapping(pubkey);
      // Carry the bot flag from the cached kind-0 so isBot stays true whenever a
      // user is re-materialized (e.g. on user_update after a profile refresh) —
      // not just on the getFullUser path.
      const bot = !!loadCachedPeerProfile(pubkey)?.profile.bot;
      const user = this.mapper.createTwebUser({peerId: userId, firstName: userMapping?.displayName, pubkey, bot});
      users.push(user);
    }
    return users;
  }

  private async sendMessage(params: any): Promise<any> {
    const emptyUpdates = {
      _: 'updates',
      updates: [] as any[],
      users: [] as any[],
      chats: [] as any[],
      date: Math.floor(Date.now() / 1000),
      seq: 0
    };

    if(!this.chatAPI || !this.ownPubkey) return emptyUpdates;

    const peerId = extractPeerId(params?.peer);
    if(peerId === null) return emptyUpdates;

    // Group branch: negative peerId in GROUP_PEER_BASE range → delegate to
    // GroupAPI. Without this the Worker's `messages.sendMessage` would
    // silently get `emptyUpdates` back, dropping the message on the floor.
    if(isGroupPeer(peerId)) {
      return this.sendGroupMessage(peerId, params);
    }

    const peerPubkey = await this.cachedGetPubkey(Math.abs(peerId));
    if(!peerPubkey) return emptyUpdates;

    try {
      // ChatAPI.sendText is the SINGLE writer for the IDB row. It carries the
      // full identity triple (mid + twebPeerId + isOutgoing) AND keys the row
      // by `eventId = publishedRumorId` (64-hex), which is the only form
      // accepted as `['e', ...]` in NIP-25 reactions / NIP-09 deletes.
      //
      // Earlier this method also did its own `store.saveMessage({eventId:
      // chat-XXX-N, ...})` after sendText returned. Because saveMessage
      // upserts by the unique `eventId` index, that "second save" produced a
      // SECOND row with a non-hex eventId, which won the cursor scan only
      // when ChatAPI's save was skipped (no `publishedRumorId` from
      // relayPool.publish, or PhantomChatBridge mid compute failure). VMT then
      // looked up that row in `getMessageByPeerMid` and passed the
      // `chat-XXX-N` string into `['e', targetEventId]` — strfry rejects
      // with "invalid: unexpected size for fixed-size tag: e". Removing the
      // duplicate save closes that path.
      const text = params?.message ?? '';
      const twebPeerId = Math.abs(peerId);
      const nowMs = Date.now();
      const now = Math.floor(nowMs / 1000);
      // Sub-second ordering for our OWN outgoing bubble. The wire `ms` tag is
      // minted inside the crypto wrap (a later instant we can't see from here),
      // so this device uses its own send instant — a few ms apart, which is
      // irrelevant: mids are device-local, and all that matters is that OUR
      // bubble orders correctly against the peer's messages in the same second.
      // Handed to sendText so the persisted row derives the SAME mid we paint.
      const msSlot = nowMs % 1000;

      // tweb sends `reply_to: {_: 'inputReplyToMessage', reply_to_msg_id: <mid>}`.
      // Resolve the mid back to the rumor eventId we stored on the original
      // message and forward to ChatAPI so the new rumor carries a NIP-10
      // `['e', <id>, '', 'reply']` tag (the cryptography layer at
      // nostr-crypto.ts:127-139 already supports this).
      let replyTo: {eventId: string} | undefined;
      let replyToMid: number | undefined;
      const replyToMsgId: number | undefined = params?.reply_to?.reply_to_msg_id;
      if(replyToMsgId !== undefined && replyToMsgId !== null) {
        try {
          const original = await getMessageStore().getByMid(replyToMsgId);
          if(original?.eventId) {
            replyTo = {eventId: original.eventId};
            replyToMid = original.mid;
          }
        } catch(e: any) {
          console.warn(LOG_PREFIX, 'sendMessage: reply_to lookup failed:', e?.message);
        }
      }

      // Optimistic local echo: pre-allocate the message id and paint the
      // outgoing bubble BEFORE connect()/encrypt/publish. The bubble's mid is
      // derived purely from (messageId, now) — neither needs relays — so on a
      // cold first send the user's own message appears instantly instead of
      // waiting ~300-700ms for the relay-pool dial + identity decrypt. The same
      // id is then handed to sendText() so the persisted row keys to the same
      // mid. (mapEventId hashes `messageId + timestamp` into a tweb mid the same
      // way ChatAPI does on its row save — see chat-api.ts allocateMessageId.)
      const messageId = this.chatAPI.allocateMessageId();
      const mid = await this.mapper.mapEventId(messageId, now, msSlot);

      // This is the ONLY history_append dispatch path for P2P sends —
      // beforeMessageSending on the Worker side is skipped for P2P peers to
      // avoid duplicate renders. The 1:1 path now mirrors the group path
      // (sendGroupMessage), which already renders optimistically before return.
      await this.injectOutgoingBubble({
        peerId: Math.abs(peerId),
        mid,
        date: now,
        text,
        senderPubkey: this.ownPubkey,
        ...(replyToMid !== undefined ? {replyToMid} : {})
      });

      // Now do the (possibly slow) connect + encrypt + publish + persist in the
      // background of the already-visible bubble. Awaited so the Worker's P2P
      // shortcut still gets {phantomchatMid, phantomchatEventId} to rename the
      // temp mid and so publish failures fall through to the offline queue. The
      // delivery tick (✓ → ✓✓) updates asynchronously from receipts regardless.
      if(this.chatAPI.getActivePeer() !== peerPubkey) {
        await this.chatAPI.connect(peerPubkey);
      }
      await this.chatAPI.sendText(text, {messageId, twebPeerId, timestampSec: now, msSlot, replyTo});

      // Return the mid and date so the Worker's P2P shortcut can
      // re-assign the message's id from the temp value (0.0001) to the
      // real timestamp-based mid.
      return {
        _: 'updates',
        updates: [],
        users: [],
        chats: [],
        date: now,
        seq: 0,
        phantomchatMid: mid,
        phantomchatEventId: messageId
      };
    } catch(err) {
      console.warn(LOG_PREFIX, 'sendMessage: failed', err);
      return emptyUpdates;
    }
  }

  /**
   * Delegate a group send to `GroupAPI` and return an `updates`-shaped
   * response carrying `phantomchatMid` + `phantomchatEventId` so the Worker's
   * post-send shortcut in `appMessagesManager` can rename the temp mid to
   * the real mapped mid and dispatch `message_sent` for the ⏳→✓
   * transition. `GroupAPI.sendMessage` already runs `handleGroupOutgoing`
   * (optimistic main-thread render) before returning.
   */
  private async sendGroupMessage(peerId: number, params: any): Promise<any> {
    const emptyUpdates = {
      _: 'updates',
      updates: [] as any[],
      users: [] as any[],
      chats: [] as any[],
      date: Math.floor(Date.now() / 1000),
      seq: 0
    };

    const text: string = params?.message ?? '';

    let groupId: string;
    try {
      const {getGroupStore} = await import('./group-store');
      const rec = await getGroupStore().getByPeerId(peerId);
      if(!rec) {
        console.warn(LOG_PREFIX, 'sendGroupMessage: no group for peerId', peerId);
        return emptyUpdates;
      }
      groupId = rec.groupId;
    } catch(err) {
      console.warn(LOG_PREFIX, 'sendGroupMessage: getByPeerId failed', err);
      return emptyUpdates;
    }

    // Resolve reply_to symmetrically to the DM sendMessage path: tweb sends
    // `reply_to: {_: 'inputReplyToMessage', reply_to_msg_id: <mid>}`. We
    // resolve the mid back to the parent row's eventId (= rumor id) and
    // forward as `replyToRumorId` so receivers can stamp `replyToMid`
    // locally on incoming. Without this the new group rumor lands without
    // a reply header even though the sender chose "Reply" in the UI
    // (FIND-fcfcdec0 #3).
    let replyToRumorId: string | undefined;
    const replyToMsgId: number | undefined = params?.reply_to?.reply_to_msg_id;
    if(replyToMsgId !== undefined && replyToMsgId !== null) {
      try {
        const original = await getMessageStore().getByMid(replyToMsgId);
        if(original?.eventId) replyToRumorId = original.eventId;
      } catch(err: any) {
        console.warn(LOG_PREFIX, 'sendGroupMessage: reply_to lookup failed:', err?.message);
      }
    }

    try {
      const {getGroupAPI} = await import('./group-api');
      const api = getGroupAPI();
      const {messageId, rumorId, timestampMs} = await api.sendMessage(groupId, text, {replyToRumorId});
      const timestampSec = Math.floor(timestampMs / 1000);
      const mid = await this.mapper.mapEventId(rumorId, timestampSec);

      console.log(LOG_PREFIX, 'sendGroupMessage ok', {groupId: groupId.slice(0, 8), mid, messageId});

      return {
        _: 'updates',
        updates: [] as any[],
        users: [] as any[],
        chats: [] as any[],
        date: timestampSec,
        seq: 0,
        phantomchatMid: mid,
        phantomchatEventId: rumorId
      };
    } catch(err) {
      console.warn(LOG_PREFIX, 'sendGroupMessage: GroupAPI.sendMessage failed', err);
      return emptyUpdates;
    }
  }

  /**
   * Emit a typing / recording indicator over the relay layer (kind-20001,
   * NIP-16 ephemeral). This is the handler for `messages.setTyping`, which used
   * to fall through to the action-prefix no-op (returns `true`, dropped on the
   * floor) — so the local UI detected typing but nothing ever reached the peer.
   *
   * WhatsApp-style privacy coupling: gated on the read-receipts toggle. When the
   * user has read receipts OFF we publish nothing (and the receive side
   * suppresses incoming indicators too — see phantomchat-typing-receive.ts).
   *
   * Always returns `true` (the MTProto contract for messages.setTyping) — a
   * typing tick is fire-and-forget; a publish failure must never surface as a
   * send error in the UI.
   */
  private async setTyping(params: any): Promise<boolean> {
    // Privacy gate — suppress emission entirely when read receipts are off.
    if(!getReadReceiptsEnabled()) return true;
    if(!this.chatAPI || !this.ownPubkey) return true;

    const peerId = extractPeerId(params?.peer);
    if(peerId === null) return true;

    const actionType: string = params?.action?._ ?? '';
    const content = typingContentForAction(actionType);
    // Actions we don't relay (upload progress, etc.) → no-op.
    if(content === null) return true;

    const now = Math.floor(Date.now() / 1000);

    try {
      // GROUP tick: tag the group id (so the receiver routes the dots into the
      // group chat, not the sender's DM) and p-tag every other member so their
      // subscription filter matches. Mirrors how group messages address members.
      if(isGroupPeer(peerId)) {
        const {getGroupStore} = await import('./group-store');
        const rec = await getGroupStore().getByPeerId(peerId);
        if(!rec) return true;
        const tags: string[][] = [['group', rec.groupId]];
        for(const member of rec.members) {
          if(member && member !== this.ownPubkey) tags.push(['p', member]);
        }
        // A group with no other members yet — nothing to notify.
        if(tags.length === 1) return true;
        await this.chatAPI.publishEvent({kind: KIND_TYPING, created_at: now, tags, content});
        return true;
      }

      // 1:1 tick: p-tag the single recipient.
      const peerPubkey = await this.cachedGetPubkey(Math.abs(peerId));
      if(!peerPubkey) return true;
      await this.chatAPI.publishEvent({
        kind: KIND_TYPING,
        created_at: now,
        tags: [['p', peerPubkey]],
        content
      });
      return true;
    } catch(err) {
      console.warn(LOG_PREFIX, 'setTyping: publish failed', err);
      return true;
    }
  }

  /**
   * Group-aware counterpart to `editMessage`. Looks the original row up by
   * mid, sanity-checks ownership + conversation, then delegates to
   * `GroupAPI.editMessage`, which does the local apply + broadcast via the
   * `group_edit_message` control payload. Mirrors the empty-updates +
   * `phantomchatEdit: true` response shape so `appMessagesManager`'s post-edit
   * shortcut treats the edit as successful and leaves the existing bubble
   * mounted (the old fall-through removed the optimistic update bubble
   * without replacing it — FIND-fcfcdec0 #1).
   */
  private async editGroupMessage(peerId: number, params: any): Promise<any> {
    const emptyUpdates = {
      _: 'updates',
      updates: [] as any[],
      users: [] as any[],
      chats: [] as any[],
      date: Math.floor(Date.now() / 1000),
      seq: 0
    };

    const mid: number = params?.id;
    const newText: string = params?.message ?? '';
    if(typeof mid !== 'number') return emptyUpdates;

    try {
      const store = getMessageStore();
      const original = await store.getByMid(mid);
      if(!original) {
        console.warn(LOG_PREFIX, 'editGroupMessage: original mid not in store', mid);
        return emptyUpdates;
      }
      if(original.senderPubkey !== this.ownPubkey) {
        console.warn(LOG_PREFIX, 'editGroupMessage: refusing to edit non-own message');
        return emptyUpdates;
      }
      if(!original.conversationId?.startsWith('group:')) {
        console.warn(LOG_PREFIX, 'editGroupMessage: row is not a group message', {conversationId: original.conversationId});
        return emptyUpdates;
      }
      const groupId = original.conversationId.slice('group:'.length);
      const targetRumorId = original.eventId;
      if(!targetRumorId) {
        console.warn(LOG_PREFIX, 'editGroupMessage: original missing eventId');
        return emptyUpdates;
      }

      const {getGroupAPI} = await import('./group-api');
      await getGroupAPI().editMessage(groupId, targetRumorId, newText);

      return {
        _: 'updates',
        updates: [],
        users: [],
        chats: [],
        date: Math.floor(Date.now() / 1000),
        seq: 0,
        phantomchatMid: mid,
        phantomchatEventId: targetRumorId,
        phantomchatEdit: true
      };
    } catch(err) {
      console.warn(LOG_PREFIX, 'editGroupMessage failed', err);
      // Reference peerId to silence unused-param warning — kept in signature
      // for symmetry with sendGroupMessage and future per-peer routing.
      void peerId;
      return emptyUpdates;
    }
  }

  private async editMessage(params: any): Promise<any> {
    const emptyUpdates = {
      _: 'updates',
      updates: [] as any[],
      users: [] as any[],
      chats: [] as any[],
      date: Math.floor(Date.now() / 1000),
      seq: 0
    };

    if(!this.chatAPI || !this.ownPubkey) return emptyUpdates;

    const peerId = extractPeerId(params?.peer);
    if(peerId === null) return emptyUpdates;

    // Group branch: negative peerId in GROUP_PEER_BASE range → delegate to
    // GroupAPI.editMessage. Without this the call would fall through to
    // the 1-on-1 path which calls `getPubkey(Math.abs(peerId))` against
    // the group peerId — that returns null and the whole edit silently
    // drops (FIND-fcfcdec0 #1).
    if(isGroupPeer(peerId)) {
      return this.editGroupMessage(peerId, params);
    }

    const peerPubkey = await this.cachedGetPubkey(Math.abs(peerId));
    if(!peerPubkey) return emptyUpdates;

    const mid: number = params?.id;
    const newText: string = params?.message ?? '';
    if(typeof mid !== 'number') return emptyUpdates;

    try {
      const store = getMessageStore();
      const original = await store.getByMid(mid);
      if(!original) {
        console.warn(LOG_PREFIX, 'editMessage: original mid not in store', mid);
        return emptyUpdates;
      }
      if(original.senderPubkey !== this.ownPubkey) {
        console.warn(LOG_PREFIX, 'editMessage: refusing to edit non-own message');
        return emptyUpdates;
      }

      // For sender rows the eventId column carries the app-level message id
      // (chat-XXX-N). For receiver rows that would not be true, but we already
      // verified senderPubkey == ownPubkey, so this is always sender-side here.
      const originalAppMessageId = original.appMessageId || original.eventId;

      // Make sure the active peer is correct so the relay subscription is wired
      if(this.chatAPI.getActivePeer() !== peerPubkey) {
        await this.chatAPI.connect(peerPubkey);
      }

      const ok = await this.chatAPI.editMessage(originalAppMessageId, newText);
      if(!ok) {
        console.warn(LOG_PREFIX, 'editMessage: chatAPI.editMessage returned false');
        // Fall through anyway: local store + UI were updated by ChatAPI
      }

      // Patch the main-thread mirror so the bubble re-renders immediately,
      // then dispatch tweb's message_edit event for bubbles.ts to pick up.
      try {
        const apiProxy: any = (await import('@config/debug')).MOUNT_CLASS_TO.apiManagerProxy;
        const storageKey = `${Math.abs(peerId)}_history`;
        const existing = apiProxy?.mirrors?.messages?.[storageKey]?.[mid];
        if(existing) {
          existing.message = newText;
          existing.edit_date = Math.floor(Date.now() / 1000);
        }

        const rs: any = (await import('@lib/rootScope')).default;
        if(typeof rs.dispatchEventSingle === 'function') {
          rs.dispatchEventSingle('message_edit', {
            storageKey,
            peerId: Math.abs(peerId),
            mid,
            message: existing || {mid, peerId: Math.abs(peerId), message: newText, edit_date: Math.floor(Date.now() / 1000)}
          });
        }
      } catch(e: any) { console.debug(LOG_PREFIX, 'editMessage local dispatch failed:', e?.message); }

      return {
        _: 'updates',
        updates: [],
        users: [],
        chats: [],
        date: Math.floor(Date.now() / 1000),
        seq: 0,
        phantomchatMid: mid,
        phantomchatEventId: originalAppMessageId,
        phantomchatEdit: true
      };
    } catch(err) {
      console.warn(LOG_PREFIX, 'editMessage: failed', err);
      return emptyUpdates;
    }
  }

  /**
   * messages.sendReaction — route to kind-7 via phantomchatReactionsPublish.
   *
   * Extracts `peerId`, `mid`, and `emoji` from the tweb-shaped params,
   * resolves the target message's relay event id + sender pubkey via
   * `getMessageByPeerMid`, then invokes `phantomchatReactionsPublish.publish`.
   * Always returns an empty tweb `updates` envelope — the UI reads the
   * reactions store, not the MTProto response.
   */
  private async sendReaction(params: any): Promise<any> {
    const emptyUpdates: any = {
      _: 'updates',
      updates: [],
      users: [],
      chats: [],
      date: Math.floor(Date.now() / 1000),
      seq: 0
    };

    const peerId = Number(params?.message?.peerId);
    const mid = Number(params?.message?.mid);
    const emoji = params?.reaction?.emoticon || '';

    if(!Number.isFinite(peerId) || !Number.isFinite(mid)) return emptyUpdates;

    const resolved = await this.getMessageByPeerMid(peerId, mid);
    if(!resolved?.relayEventId) {
      console.warn(LOG_PREFIX, 'sendReaction: target message not found', {peerId, mid});
      return emptyUpdates;
    }

    if(!RUMOR_ID_RE.test(resolved.relayEventId)) {
      console.warn(LOG_PREFIX, 'sendReaction: target row missing 64-hex rumor id; skipping publish', {peerId, mid, relayEventId: resolved.relayEventId});
      return emptyUpdates;
    }

    // WU-2: group reactions go through the group control channel (N gift-wraps
    // to all members) instead of the 1:1 kind-7 path, which only p-tags the
    // reacted-to author — unreachable for a hash-based group peerId, so other
    // members never saw the reaction.
    if(isGroupPeer(peerId)) {
      try {
        const {getGroupStore} = await import('./group-store');
        const group = await getGroupStore().getByPeerId(peerId);
        if(group?.groupId) {
          const {getGroupAPI} = await import('./group-api');
          await getGroupAPI().reactToMessage(group.groupId, resolved.relayEventId, emoji);
        } else {
          console.warn(LOG_PREFIX, 'sendReaction: no group record for peerId', peerId);
        }
      } catch(e) {
        console.warn(LOG_PREFIX, 'sendReaction: group reaction failed', e);
      }
      return emptyUpdates;
    }

    try {
      const {phantomchatReactionsPublish} = await import('./phantomchat-reactions-publish');
      await phantomchatReactionsPublish.publish({
        targetEventId: resolved.relayEventId,
        targetMid: mid,
        targetPeerId: peerId,
        targetAuthor: resolved.senderPubkey,
        emoji
      });
    } catch(e) {
      console.warn(LOG_PREFIX, 'sendReaction: publish failed', e);
    }

    return emptyUpdates;
  }

  /**
   * Inject an outgoing message bubble into the main-thread bubble pipeline.
   * Used by sendMessage to render the bubble on the sender side with the
   * real timestamp-based mid. beforeMessageSending on the Worker skips
   * its history_append dispatch for P2P peers, so this is the sole render
   * path for P2P outgoing messages.
   */
  private async injectOutgoingBubble(params: {
    peerId: number;
    mid: number;
    date: number;
    text: string;
    senderPubkey: string;
    replyToMid?: number;
    groupedId?: string;
    media?: {
      type: 'image' | 'video' | 'file' | 'voice';
      objectURL: string;
      mimeType: string;
      size: number;
      width?: number;
      height?: number;
      duration?: number;
      waveform?: string;
      uploading: boolean;
    };
  }): Promise<void> {
    try {
      const {peerId, mid, date, text, media, replyToMid, groupedId} = params;

      // Stamp `fromPeerId` to ourselves for every outgoing bubble. For group
      // bubbles the name pill is visible and reads `message.fromId` — without
      // this it renders "Deleted Account" / `data-peer-id="0"` until the relay
      // echo arrives ~0.5–2 s later (FIND-01e78a01 #3). For DM bubbles the text
      // pill is CSS-hidden, but the VOICE-note player header is NOT — it reads
      // `fromId` to label the sender, so an unstamped DM voice note shows
      // "Deleted Account" in the player chrome (FIND-voice-deleted-account).
      // Mapping to self is correct and harmless in every case.
      let fromPeerId: number | undefined;
      if(this.ownPubkey) {
        try {
          fromPeerId = await this.mapper.mapPubkey(this.ownPubkey);
        } catch(err) {
          console.debug(LOG_PREFIX, 'injectOutgoingBubble: mapPubkey(self) failed:', (err as any)?.message);
        }
      }

      const msg = this.mapper.createTwebMessage({
        mid,
        peerId,
        fromPeerId,
        date,
        text,
        isOutgoing: true,
        ...(replyToMid !== undefined ? {replyToMid} : {})
      });
      (msg as any).pFlags ??= {};
      (msg as any).pFlags.out = true;
      delete (msg as any).pFlags.is_outgoing;
      delete (msg as any).pending;
      // Issue #111: stamp grouped_id so album bubbles render attached instead
      // of as N orphan bubbles. The id is the sender-local optimistic id from
      // appMessagesManager.sendGrouped — its only invariant is being identical
      // across the N items of one album send. Bubble renderer keys off this.
      if(groupedId) {
        (msg as any).grouped_id = groupedId;
      }

      if(media) {
        const attributes: any[] = [];
        if(media.type === 'voice' && typeof media.duration === 'number') {
          attributes.push({
            _: 'documentAttributeAudio',
            pFlags: {voice: true},
            duration: media.duration,
            waveform: media.waveform
          });
        }
        if(media.type === 'image') {
          // Render any image as photo, even without explicit dimensions —
          // see FIND-e60cef56 γ. tweb sizes the image bubble by the
          // photoSize w/h, so a sensible square placeholder (320×320) is
          // a better default than collapsing to messageMediaDocument.
          const w = media.width || 320;
          const h = media.height || 320;
          (msg as any).media = {
            _: 'messageMediaPhoto',
            pFlags: {},
            photo: {
              _: 'photo',
              id: `p2p_${mid}`,
              sizes: [{
                _: 'photoSize',
                type: 'x',
                w,
                h,
                size: media.size,
                url: media.objectURL
              }],
              url: media.objectURL,
              pFlags: {}
            }
          };
        } else {
          // Determine the tweb document type from the media class so the
          // bubble renderer (wrappers/document.ts) dispatches to the correct
          // component — AudioElement for voice/audio, video player for video,
          // generic file otherwise.  Without this, voice notes rendered as
          // "Unknown.file" because doc.type was undefined (FIND-voice-unknown).
          const docType = media.type === 'voice' ? 'voice' :
            media.type === 'video' ? 'video' :
            media.mimeType?.startsWith('audio/') ? 'audio' :
            undefined;
          (msg as any).media = {
            _: 'messageMediaDocument',
            pFlags: {},
            document: {
              _: 'document',
              id: `p2p_${mid}`,
              mime_type: media.mimeType,
              size: media.size,
              url: media.objectURL,
              attributes,
              type: docType,
              // Top-level duration mirrors what appDocsManager.saveDoc would set
              // for a normal tweb document. The P2P shape-builder bypasses
              // saveDoc, so without this the AudioElement waveform renderer
              // computes clamp(undefined/60*maxW) → NaN width → zero bars and
              // the voice note collapses to an empty bubble (FIND-voice-empty).
              ...(typeof media.duration === 'number' ? {duration: media.duration} : {}),
              file_name: `file-${mid}`,
              pFlags: {}
            }
          };
        }
        (msg as any).phantomchatUploading = media.uploading;
      }

      // Inject into main-thread mirrors so lookups find it.
      const apiProxy: any = (await import('@config/debug')).MOUNT_CLASS_TO.apiManagerProxy;
      if(apiProxy?.mirrors?.messages) {
        const storageKey = `${peerId}_history`;
        if(!apiProxy.mirrors.messages[storageKey]) apiProxy.mirrors.messages[storageKey] = {};
        apiProxy.mirrors.messages[storageKey][mid] = msg;
      }

      const rs: any = (await import('@lib/rootScope')).default;

      // PAINT FIRST — the user's own bubble must never wait on a worker
      // round-trip. The synchronous main-thread mirror write above already
      // satisfies immediate bubbles.ts lookups, so the history_append render
      // fires right now. dispatchEventSingle fires LOCALLY (no MessagePort
      // forward — also keeps tests working where the port is uninitialized);
      // bubbles.ts dedups by fullMid so repeated dispatches are idempotent.
      try {
        if(typeof rs.dispatchEventSingle === 'function') {
          rs.dispatchEventSingle('history_append', {
            storageKey: `${peerId}_history`,
            message: msg,
            peerId
          });
        }
      } catch(e: any) { console.debug(LOG_PREFIX, 'history_append dispatch failed:', e?.message); }

      // THEN push to the Worker's history storage (so later getHistory calls
      // include the message) — but FIRE-AND-FORGET. Under incoming-message load
      // the worker queue backs up; AWAITING this write here is what stalled the
      // user's own bubble for seconds, because it sat between the mirror write
      // and the paint above. It is a best-effort cache push (ChatAPI.sendText is
      // the authoritative persister), so a failure was already swallowed.
      void Promise.resolve(
        rs.managers.appMessagesManager.setMessageToStorage(`${peerId}_history` as any, msg)
      ).catch((e: any) => console.debug(LOG_PREFIX, 'setMessageToStorage failed:', e?.message));

      // Bump (or create) the sidebar dialog for the outgoing message.
      // Without this dispatch the chat list never reflects a live send —
      // a fresh conversation never appears until reload, an existing one
      // does not move to the top and its preview does not refresh.
      // Two dispatches per bridge-invariants Rule 8: the first triggers
      // sortedList.add (which returns early and skips setLastMessageN),
      // the second hits the existing-dialog branch to render the preview.
      try {
        const dialog: any = this.mapper.createTwebDialog({
          peerId,
          topMessage: mid,
          topMessageDate: date,
          unreadCount: 0
        });
        dialog.topMessage = msg;

        if(apiProxy?.mirrors?.dialogs) {
          apiProxy.mirrors.dialogs[peerId] = dialog;
        }

        const rs: any = (await import('@lib/rootScope')).default;
        const payload = new Map<any, any>([[
          (peerId as any).toPeerId ? (peerId as any).toPeerId(false) : peerId,
          {dialog}
        ]]);
        const dispatch = () => {
          if(typeof rs.dispatchEventSingle === 'function') {
            rs.dispatchEventSingle('dialogs_multiupdate', payload);
          }
        };
        dispatch();
        setTimeout(dispatch, 500);
      } catch(e: any) { console.debug(LOG_PREFIX, 'dialogs_multiupdate dispatch failed:', e?.message); }
    } catch(err) {
      console.warn(LOG_PREFIX, 'injectOutgoingBubble failed:', err);
    }
  }

  private async sendMedia(params: any): Promise<any> {
    // For the legacy MTProto path (non-P2P shortcut), extract the caption
    // and forward as a text-only send. P2P media flows through the dedicated
    // phantomchatSendFile bridge method instead.
    const captionParams = {
      ...params,
      message: params?.message ?? ''
    };
    return this.sendMessage(captionParams);
  }

  private async phantomchatSendFile(params: any): Promise<any> {
    const emptyUpdates = {
      _: 'updates',
      updates: [] as any[],
      users: [] as any[],
      chats: [] as any[],
      date: Math.floor(Date.now() / 1000),
      seq: 0
    };

    if(!this.chatAPI || !this.ownPubkey) {
      console.error(LOG_PREFIX, 'phantomchatSendFile: chatAPI or ownPubkey not initialised', {chatAPI: !!this.chatAPI, ownPubkey: !!this.ownPubkey});
      return emptyUpdates;
    }

    const peerId: number = Number(params?.peerId);
    if(!peerId) {
      console.error(LOG_PREFIX, 'phantomchatSendFile: missing or zero peerId', {params});
      return emptyUpdates;
    }

    const blob: Blob = params?.blob;
    if(!(blob instanceof Blob) || blob.size === 0) {
      console.error(LOG_PREFIX, 'phantomchatSendFile: invalid or empty blob', {type: typeof blob, size: blob?.size});
      return emptyUpdates;
    }

    // Group branch: route through GroupAPI.sendFile instead of the 1:1
    // chatAPI publish. The 1:1 path requires a peerPubkey reverse-lookup
    // that doesn't exist for groups (FIND-3ce67f93 obs (c) carryforward).
    if(isGroupPeer(peerId)) {
      return this.phantomchatSendFileToGroup(peerId, params);
    }

    const peerPubkey = await this.cachedGetPubkey(Math.abs(peerId));
    if(!peerPubkey) {
      console.error(LOG_PREFIX, 'phantomchatSendFile: no pubkey mapping for peerId', Math.abs(peerId));
      return emptyUpdates;
    }

    // Private key is held by the relay pool inside ChatAPI as raw bytes;
    // the orchestrator + blossom-upload-progress expect hex.
    // Retry up to 3 times with 500ms delay — the pool may still be
    // initialising when the user fires a send immediately after open.
    let privkeyBytes: Uint8Array | null = (this.chatAPI as any)?.relayPool?.getPrivateKey?.() ?? null;
    for(let attempt = 0; attempt < 3 && (!privkeyBytes || !(privkeyBytes instanceof Uint8Array) || privkeyBytes.length !== 32); attempt++) {
      console.warn(LOG_PREFIX, `phantomchatSendFile: private key not ready (attempt ${attempt + 1}/3) — retrying in 500ms`);
      await new Promise(r => setTimeout(r, 500));
      privkeyBytes = (this.chatAPI as any)?.relayPool?.getPrivateKey?.() ?? null;
    }
    if(!privkeyBytes || !(privkeyBytes instanceof Uint8Array) || privkeyBytes.length !== 32) {
      console.error(LOG_PREFIX, 'phantomchatSendFile: no 32-byte private key on chatAPI.relayPool after retries', {
        hasPool: !!(this.chatAPI as any)?.relayPool,
        keyType: typeof privkeyBytes,
        keyLen: privkeyBytes?.length
      });
      return emptyUpdates;
    }
    const {bytesToHex} = await import('./file-crypto');
    const privkeyHex = bytesToHex(privkeyBytes);

    const type: 'image' | 'video' | 'file' | 'voice' = params?.type || 'file';
    const caption: string = params?.caption || '';
    const tempMid: number = Number(params?.tempMid);
    const width: number | undefined = params?.width;
    const height: number | undefined = params?.height;
    const duration: number | undefined = params?.duration;
    const waveform: string | undefined = params?.waveform;
    // Issue #111: groupedId is the sender-local optimistic album id from
    // appMessagesManager.sendGrouped. Forwarded to injectOutgoingBubble so
    // bubbles in the same album render attached.
    const groupedId: string | undefined = typeof params?.groupedId === 'string' ? params.groupedId : undefined;

    const {sendFileViaPhantomChat} = await import('./phantomchat-send-file');
    const rs: any = (await import('@lib/rootScope')).default;
    const {getMessageStore} = await import('./message-store');
    const store = getMessageStore();
    const conversationId = store.getConversationId(this.ownPubkey, peerPubkey);

    const result = await sendFileViaPhantomChat(
      {
        ownPubkey: this.ownPubkey,
        privkeyHex,
        peerPubkey,
        chatAPI: this.chatAPI as any,
        dispatch: (name: string, payload: any) => {
          if(typeof rs.dispatchEventSingle === 'function') rs.dispatchEventSingle(name, payload);
        },
        injectBubble: async(p) => {
          const objectURL = URL.createObjectURL(p.blob);
          await this.injectOutgoingBubble({
            peerId: Math.abs(p.peerId),
            mid: p.tempMid,
            date: Math.floor(Date.now() / 1000),
            text: p.caption || '',
            senderPubkey: this.ownPubkey!,
            groupedId,
            media: {
              type: p.type,
              objectURL,
              mimeType: p.blob.type,
              size: p.blob.size,
              width: p.width,
              height: p.height,
              duration: p.duration,
              waveform: p.waveform,
              uploading: true
            }
          });
        },
        saveMessage: async(p) => {
          await store.saveMessage({
            eventId: p.eventId,
            conversationId,
            senderPubkey: this.ownPubkey!,
            content: p.content,
            type: 'file',
            timestamp: Math.floor(Date.now() / 1000),
            deliveryState: 'sent',
            mid: p.mid,
            twebPeerId: Math.abs(p.peerId),
            isOutgoing: true,
            fileMetadata: {
              url: p.url,
              sha256: p.sha256,
              mimeType: p.mimeType,
              size: p.size,
              width: p.width,
              height: p.height,
              keyHex: p.keyHex,
              ivHex: p.ivHex,
              duration: p.duration,
              waveform: p.waveform,
              mediaType: p.mediaType
            }
          });
        },
        log: Object.assign(
          (...a: any[]) => console.log(LOG_PREFIX, ...a),
          {
            warn: (...a: any[]) => console.warn(LOG_PREFIX, ...a),
            error: (...a: any[]) => console.error(LOG_PREFIX, ...a)
          }
        )
      },
      {
        peerId: Math.abs(peerId),
        blob, type, caption, tempMid,
        width, height, duration, waveform
      }
    );

    if(!result.ok) {
      return emptyUpdates;
    }
    return {
      _: 'updates',
      updates: [],
      users: [],
      chats: [],
      date: Math.floor(Date.now() / 1000),
      seq: 0,
      phantomchatMid: result.mid,
      phantomchatEventId: result.eventId
    };
  }

  /**
   * Group-aware counterpart of `phantomchatSendFile`. Encrypts + uploads the
   * blob to Blossom, optimistically renders the sender's bubble with the
   * local objectURL, persists the row keyed by `conversationId='group:<id>'`,
   * then broadcasts a `group_<fileType>` rumor to every member via
   * `GroupAPI.sendFile`. Receivers run `handleGroupIncoming`, which reads
   * `fileMetadata` from the parsed rumor and renders via `buildPhantomChatMedia`.
   */
  private async phantomchatSendFileToGroup(peerId: number, params: any): Promise<any> {
    const emptyUpdates = {
      _: 'updates',
      updates: [] as any[],
      users: [] as any[],
      chats: [] as any[],
      date: Math.floor(Date.now() / 1000),
      seq: 0
    };

    if(!this.chatAPI || !this.ownPubkey) {
      console.error(LOG_PREFIX, 'phantomchatSendFileToGroup: chatAPI or ownPubkey not initialised', {chatAPI: !!this.chatAPI, ownPubkey: !!this.ownPubkey});
      return emptyUpdates;
    }

    const blob: Blob = params?.blob;
    const type: 'image' | 'video' | 'file' | 'voice' = params?.type || 'file';
    const caption: string = params?.caption || '';
    const tempMid: number = Number(params?.tempMid);
    const width: number | undefined = params?.width;
    const height: number | undefined = params?.height;
    const duration: number | undefined = params?.duration;
    const waveform: string | undefined = params?.waveform;
    const groupedId: string | undefined = typeof params?.groupedId === 'string' ? params.groupedId : undefined;

    let groupId: string;
    try {
      const {getGroupStore} = await import('./group-store');
      const rec = await getGroupStore().getByPeerId(peerId);
      if(!rec) {
        console.error(LOG_PREFIX, 'phantomchatSendFileToGroup: no group for peerId', peerId);
        return emptyUpdates;
      }
      groupId = rec.groupId;
    } catch(err) {
      console.error(LOG_PREFIX, 'phantomchatSendFileToGroup: group lookup failed', err);
      return emptyUpdates;
    }

    // Get the private key for the Blossom auth header
    // Retry up to 3 times with 500ms delay — the pool may still be
    // initialising when the user fires a send immediately after open.
    let privkeyBytes: Uint8Array | null = (this.chatAPI as any)?.relayPool?.getPrivateKey?.() ?? null;
    for(let attempt = 0; attempt < 3 && (!privkeyBytes || !(privkeyBytes instanceof Uint8Array) || privkeyBytes.length !== 32); attempt++) {
      console.warn(LOG_PREFIX, `phantomchatSendFileToGroup: private key not ready (attempt ${attempt + 1}/3) — retrying in 500ms`);
      await new Promise(r => setTimeout(r, 500));
      privkeyBytes = (this.chatAPI as any)?.relayPool?.getPrivateKey?.() ?? null;
    }
    if(!privkeyBytes || !(privkeyBytes instanceof Uint8Array) || privkeyBytes.length !== 32) {
      console.error(LOG_PREFIX, 'phantomchatSendFileToGroup: no 32-byte private key after retries', {
        hasPool: !!(this.chatAPI as any)?.relayPool,
        keyType: typeof privkeyBytes,
        keyLen: privkeyBytes?.length
      });
      return emptyUpdates;
    }
    const {bytesToHex} = await import('./file-crypto');
    const privkeyHex = bytesToHex(privkeyBytes);

    // Optimistic sender-side bubble — render the local blob immediately so
    // the user sees the image while the upload + broadcast complete. Pass
    // the NEGATIVE group peerId through (Math.abs would flip it positive
    // and the bubble would land in mirrors.messages[`${positive}_history`]
    // while the receive path stores at `${negative}_history`, causing a
    // multi-second delay before the message_sent reconciler finds it —
    // FIND-e8327b23 §B).
    try {
      const objectURL = URL.createObjectURL(blob);
      await this.injectOutgoingBubble({
        peerId,
        mid: tempMid,
        date: Math.floor(Date.now() / 1000),
        text: caption,
        senderPubkey: this.ownPubkey!,
        groupedId,
        media: {
          type,
          objectURL,
          mimeType: blob.type,
          size: blob.size,
          width,
          height,
          duration,
          waveform,
          uploading: true
        }
      });
    } catch(err) {
      console.warn(LOG_PREFIX, 'phantomchatSendFileToGroup: optimistic bubble failed', err);
    }

    // Encrypt + upload to Blossom. Reuses the 1:1 upload helper since the
    // blob-encryption + Blossom auth flow is peer-agnostic.
    let url: string;
    let sha256Hex: string;
    let keyHex: string;
    let ivHex: string;
    try {
      const {encryptFile} = await import('./file-crypto');
      const enc = await encryptFile(blob);
      keyHex = enc.keyHex;
      ivHex = enc.ivHex;
      sha256Hex = enc.sha256Hex;
      const {uploadToBlossomWithProgress} = await import('./blossom-upload-progress');
      const rs: any = (await import('@lib/rootScope')).default;
      // Dispatch progress + completion with the NEGATIVE group peerId — the
      // listener in bubbles.ts gates on `peerId !== this.peerId` and the
      // active chat container holds the negative group peerId. Positive
      // would silently drop every progress tick for group uploads.
      const upload = await uploadToBlossomWithProgress(enc.ciphertext, privkeyHex, {
        onProgress: (p: number) => {
          if(typeof rs.dispatchEventSingle === 'function') {
            rs.dispatchEventSingle('phantomchat_file_upload_progress', {peerId, mid: tempMid, percent: p});
          }
        }
      });
      url = upload.url;
    } catch(err) {
      console.warn(LOG_PREFIX, 'phantomchatSendFileToGroup: encrypt/upload failed', err);
      const rs: any = (await import('@lib/rootScope')).default;
      if(typeof rs.dispatchEventSingle === 'function') {
        rs.dispatchEventSingle('phantomchat_file_upload_failed', {peerId, mid: tempMid, error: 'encrypt/upload failed'});
      }
      return emptyUpdates;
    }

    const fileMetadata = {
      url,
      sha256: sha256Hex,
      keyHex,
      ivHex,
      mimeType: blob.type,
      size: blob.size,
      ...(width !== undefined ? {width} : {}),
      ...(height !== undefined ? {height} : {}),
      ...(duration !== undefined ? {duration} : {}),
      ...(waveform !== undefined ? {waveform} : {})
    };

    // Broadcast via GroupAPI. Returns the canonical rumor id we then key
    // the persisted row by — matches the rx-side `eventId === rumorId`
    // contract so the receiver's resolver can find this row when, e.g.,
    // a later reaction targets it.
    let messageId: string;
    let rumorId: string;
    let timestampMs: number;
    try {
      const {getGroupAPI} = await import('./group-api');
      const sendRes = await getGroupAPI().sendFile(groupId, type, fileMetadata, caption);
      messageId = sendRes.messageId;
      rumorId = sendRes.rumorId;
      timestampMs = sendRes.timestampMs;
    } catch(err) {
      console.warn(LOG_PREFIX, 'phantomchatSendFileToGroup: GroupAPI.sendFile failed', err);
      return emptyUpdates;
    }

    const timestampSec = Math.floor(timestampMs / 1000);
    let realMid: number;
    try {
      realMid = await this.mapper.mapEventId(rumorId, timestampSec);
    } catch(err) {
      console.warn(LOG_PREFIX, 'phantomchatSendFileToGroup: mapEventId failed', err);
      return emptyUpdates;
    }

    // Persist the authoritative row keyed by rumorId so reactions / replies /
    // edits targeting this message resolve consistently on both sides.
    try {
      const store = getMessageStore();
      await store.saveMessage({
        eventId: rumorId,
        appMessageId: messageId,
        conversationId: `group:${groupId}`,
        senderPubkey: this.ownPubkey,
        content: caption,
        type: 'file',
        timestamp: timestampSec,
        deliveryState: 'sent',
        mid: realMid,
        twebPeerId: peerId,
        isOutgoing: true,
        fileMetadata
      });
    } catch(err) {
      console.warn(LOG_PREFIX, 'phantomchatSendFileToGroup: saveMessage failed', err);
    }

    const rs: any = (await import('@lib/rootScope')).default;
    if(typeof rs.dispatchEventSingle === 'function') {
      rs.dispatchEventSingle('phantomchat_file_upload_completed', {peerId, mid: tempMid, finalMid: realMid});
    }

    return {
      _: 'updates',
      updates: [],
      users: [],
      chats: [],
      date: timestampSec,
      seq: 0,
      phantomchatMid: realMid,
      phantomchatEventId: rumorId
    };
  }

  private async deleteMessages(params: any): Promise<any> {
    const mids: number[] = params?.id || [];
    const revoke: boolean = !!params?.revoke;

    // For "Also delete for {peer}" we collect the rumor eventId + recipient
    // pubkey for each mid BEFORE the local deletion clears the row. The
    // collection is per-peer so peers different from the active conversation
    // (rare; only happens if the caller batches across chats) each get their
    // own gift-wrapped delete-notification.
    const perPeer = new Map<string, string[]>();
    if(revoke && mids.length && this.chatAPI) {
      try {
        const store = getMessageStore();
        for(const mid of mids) {
          const row = await store.getByMid(mid).catch((): null => null);
          if(!row?.eventId) continue;
          const peerPubkey = await this.cachedGetPubkey(Math.abs(row.twebPeerId)).catch((): null => null);
          if(!peerPubkey) continue;
          const arr = perPeer.get(peerPubkey) ?? [];
          arr.push(row.eventId);
          perPeer.set(peerPubkey, arr);
        }
      } catch(err) {
        console.warn(LOG_PREFIX, 'deleteMessages: revoke collection failed:', err);
      }
    }

    // Local deletion (Level 1)
    if(mids.length) {
      try {
        const store = getMessageStore();
        for(const mid of mids) {
          await store.deleteByMid(mid).catch((e) => console.debug('[VirtualMTProto] deleteByMid failed:', e?.message));
        }
        console.log(LOG_PREFIX, 'deleteMessages: deleted', mids.length, 'from store');
      } catch(err) {
        console.warn(LOG_PREFIX, 'deleteMessages error:', err);
      }
    }

    // Wire publish (Levels 2 + 3) — fire-and-forget: never block the MTProto
    // response on relay round-trip. Failures are logged inside ChatAPI.
    if(revoke && perPeer.size > 0 && this.chatAPI) {
      const api = this.chatAPI as any;
      if(typeof api.publishMessageDeletions === 'function') {
        for(const [peerPubkey, eventIds] of perPeer) {
          api.publishMessageDeletions(eventIds, peerPubkey, 'Message deleted').catch((err: any) =>
            console.warn(LOG_PREFIX, 'deleteMessages: revoke publish failed:', err?.message ?? err));
        }
      }
    }

    return {
      _: 'messages.affectedMessages',
      ...this.allocatePts(mids.length)
    };
  }

  // Wipe the message-store rows for a deleted 1:1 or group conversation.
  // Without this the dialog briefly disappears (tweb flushStoragesByPeerId
  // clears its in-memory cache) but every old bubble re-surfaces the moment
  // getDialogs / getHistory re-reads IndexedDB — e.g. when the user reopens
  // the chat from the contact list.
  private async deleteHistory(params: any, isChannel: boolean): Promise<any> {
    const method = isChannel ? 'channels.deleteHistory' : 'messages.deleteHistory';
    const peerId = isChannel ?
      -Math.abs(Number(params?.channel?.channel_id ?? 0)) :
      extractPeerId(params?.peer);

    // messages.deleteHistory expects messages.affectedHistory (offset:0 signals
    // the doFlushHistory loop in appMessagesManager to terminate and call
    // flushStoragesByPeerId). channels.deleteHistory's caller only checks for
    // a truthy result — `true` matches the legacy fallback shape.
    const buildResponse = () => isChannel ? true : {
      _: 'messages.affectedHistory',
      pts: 1,
      pts_count: 0,
      offset: 0
    };

    if(peerId === null || peerId === 0) {
      return buildResponse();
    }

    try {
      const store = getMessageStore();
      let convId: string | null = null;

      if(peerId < 0) {
        const {getGroupStore} = await import('./group-store');
        const group = await getGroupStore().getByPeerId(peerId);
        if(group) convId = `group:${group.groupId}`;
      } else if(this.ownPubkey) {
        const pubkey = await this.cachedGetPubkey(Math.abs(peerId));
        if(pubkey) convId = store.getConversationId(this.ownPubkey, pubkey);
      }

      if(convId) {
        await store.deleteMessages(convId);
        // Record the deletion watermark so relay-replayed gift-wraps (24h TTL)
        // don't re-hydrate the conversation on the next reconnect. Strictly-newer
        // messages still revive it (timestamp-gated; see MessageStore.setTombstone).
        await store.setTombstone(convId, Math.floor(Date.now() / 1000));
        console.log(LOG_PREFIX, method, 'wiped + tombstoned conversation', convId);
      } else {
        console.warn(LOG_PREFIX, method, 'could not resolve conversationId for peerId', peerId);
      }
    } catch(err) {
      console.warn(LOG_PREFIX, method, 'error:', err);
    }

    return buildResponse();
  }

  private async readHistory(params: any): Promise<any> {
    const peerId = extractPeerId(params?.peer);
    const maxId = Number(params?.max_id ?? 0);

    if(peerId !== null && maxId > 0 && this.ownPubkey) {
      try {
        const absPeerId = Math.abs(peerId);
        const pubkey = await this.cachedGetPubkey(absPeerId);
        if(pubkey) {
          const store = getMessageStore();
          const convId = store.getConversationId(this.ownPubkey, pubkey);
          await store.setReadCursor(convId, maxId);
        }
      } catch(err) {
        console.warn(LOG_PREFIX, 'readHistory: failed to advance cursor', err);
      }
    }

    return {
      _: 'messages.affectedMessages',
      pts: 1,
      pts_count: 0
    };
  }

  private async createChat(params: any): Promise<any> {
    const emptyUpdates = {_: 'updates', updates: [] as any[], users: [] as any[], chats: [] as any[], date: Math.floor(Date.now() / 1000), seq: 0};
    const title = params?.title ?? 'Group';
    const userIds: number[] = (params?.users || []).map((u: any) => u?.user_id ?? u).filter(Boolean);

    try {
      const {getGroupStore} = await import('./group-store');
      const groupStore = getGroupStore();
      const memberPubkeys: string[] = [];
      for(const uid of userIds) {
        const pk = await this.cachedGetPubkey(uid);
        if(pk) memberPubkeys.push(pk);
      }
      if(this.ownPubkey) memberPubkeys.unshift(this.ownPubkey);

      const now = Math.floor(Date.now() / 1000);
      const groupId = 'group-' + Date.now();
      const peerId = -(Math.floor(Math.random() * 1e15) + 1);
      const group = {groupId, name: title, adminPubkey: this.ownPubkey || '', members: memberPubkeys, peerId, createdAt: now, updatedAt: now};
      await groupStore.save(group);

      const chatId = Math.abs(peerId);
      const chat = this.mapper.createTwebChat({chatId, title, membersCount: memberPubkeys.length, date: now});

      emptyUpdates.chats.push(chat);
      emptyUpdates.updates.push({_: 'updateNewMessage', message: {_: 'messageService', pFlags: {out: true}, id: 1, peer_id: {_: 'peerChat', chat_id: chatId}, from_id: {_: 'peerUser', user_id: 0}, date: now, action: {_: 'messageActionChatCreate', title, users: userIds}}, ...this.allocatePts(1)});
      console.log(LOG_PREFIX, 'createChat:', title, 'members:', memberPubkeys.length);
    } catch(err) {
      console.warn(LOG_PREFIX, 'createChat failed:', err);
    }
    // appChatsManager.createChat expects a messages.invitedUsers wrapper (res type of messages.createChat).
    // Returning the bare Updates made invitedUsers.updates === [] (the inner array), which crashed
    // apiUpdatesManager.processUpdateMessage reading .date on an array.
    return {_: 'messages.invitedUsers', updates: emptyUpdates, missing_invitees: [] as any[]};
  }

  private async createChannel(params: any): Promise<any> {
    // PhantomChat treats channels as groups. channels.createChannel returns Updates (not messages.invitedUsers),
    // so unwrap the createChat wrapper here.
    const wrapped = await this.createChat({title: params?.title ?? 'Channel', users: []});
    return wrapped?.updates ?? wrapped;
  }

  private async inviteToChannel(params: any): Promise<any> {
    const emptyUpdates = {_: 'updates', updates: [] as any[], users: [] as any[], chats: [] as any[], date: Math.floor(Date.now() / 1000), seq: 0};
    const channelId = params?.channel?.channel_id;
    const userIds: number[] = (params?.users || []).map((u: any) => u?.user_id ?? u).filter(Boolean);

    // channels.inviteToChannel returns messages.invitedUsers (same res type as messages.createChat / addChatUser).
    const wrap = () => ({_: 'messages.invitedUsers', updates: emptyUpdates, missing_invitees: [] as any[]});

    if(!channelId || !userIds.length) return wrap();

    try {
      const {getGroupStore} = await import('./group-store');
      const groupStore = getGroupStore();
      const groups = await groupStore.getAll();
      const group = groups.find((g: any) => Math.abs(g.peerId) === channelId);
      if(!group) {
        console.warn(LOG_PREFIX, 'inviteToChannel: group not found for channelId', channelId);
        return wrap();
      }
      for(const uid of userIds) {
        const pk = await this.cachedGetPubkey(uid);
        if(pk && !group.members.includes(pk)) {
          group.members.push(pk);
        }
      }
      await groupStore.save(group);
      console.log(LOG_PREFIX, 'inviteToChannel:', channelId, 'added', userIds.length, 'users');
    } catch(err) {
      console.warn(LOG_PREFIX, 'inviteToChannel failed:', err);
    }
    return wrap();
  }

  /**
   * Catch-all for MTProto methods that don't have an explicit case in
   * handleMethod. The shape choice is best-effort:
   *
   *   1. ACTION_PATTERNS match → return `true` (Telegram action methods
   *      typically return `Bool`). The CALLER thinks the action succeeded.
   *
   *   2. PHANTOMCHAT_STATIC has an entry → return the canned response.
   *
   *   3. Otherwise → return `{pFlags: {}}` so naive `.pFlags` access on
   *      the result doesn't throw at the call site.
   *
   * IMPORTANT: branch (1) is a SILENT-NOOP trap. Methods that fall through
   * here look successful to tweb's caller but ship nothing on the wire.
   * Any UI surface whose action goes through here will look inert to the
   * peer — same shape as the bugs already fixed:
   *
   *   - messages.deleteMessages (revoke=true) — fixed in 529f1c5b by
   *     adding an explicit handler that publishes a delete-notification.
   *   - messages.updatePinnedMessage — pin UI hidden in 66350b05 because
   *     no pin protocol exists yet.
   *   - reply_to plumbing — wired in 398db7be.
   *
   * Known categories that STILL fall through and are at risk of silent
   * failure on user action (audit in WAVE 7, ranked by user-visibility):
   *
   *   - account.setPrivacy / account.getPrivacy: privacy switches in
   *     Settings → Privacy don't persist nor propagate. Quick win:
   *     hide the Privacy section, or persist locally with localStorage.
   *   - account.updateNotifySettings: per-peer notification config
   *     changes, same silent-noop shape.
   *   - messages.toggleNoForwards: group "restrict forwarding" toggle.
   *   - messages.setTyping: typing indicators don't reach the peer
   *     (probably benign — no UX expectation broken).
   *
   * Future contributors: when adding a UI surface that calls a method
   * through this fallback, EITHER implement an explicit handler that
   * propagates over the relay layer OR feature-flag-hide the UI.
   * Otherwise the fixer agent will find it and the explorer will surface
   * a HIGH-severity finding.
   */
  private fallback(method: string, _params: any): any {
    // Action methods → return true
    for(const pattern of ACTION_PATTERNS) {
      if(method.includes(pattern)) {
        // WU-1 #5: surface the silent no-op in dev/explorer builds (once per
        // method) so an unhandled UI action doesn't vanish unnoticed. The
        // return value is unchanged; this is diagnostic only and off in prod.
        if(IS_DEV_DIAGNOSTICS && !this.warnedFallbacks.has(method)) {
          this.warnedFallbacks.add(method);
          console.warn(LOG_PREFIX, `unhandled action method "${method}" → silent no-op (returns true). If a UI surface depends on it, add an explicit handler or hide the UI.`);
        }
        return true;
      }
    }

    // Known method shapes
    if(PHANTOMCHAT_STATIC[method]) {
      return PHANTOMCHAT_STATIC[method];
    }

    // Default
    return {pFlags: {}};
  }
}
