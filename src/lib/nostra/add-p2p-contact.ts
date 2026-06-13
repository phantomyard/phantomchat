/**
 * addP2PContact — canonical helper for adding a P2P contact.
 *
 * Before this helper existed there were four divergent paths (Contacts tab,
 * Add Contact popup, hamburger menu, KeyExchange scanner) — each seeded a
 * different subset of the state the chat UI expects. Opening a chat right
 * after an add could land in a half-populated mirror and render a blank
 * chat pane; only a full reload reset things.
 *
 * This helper does all the work in a fixed order and awaits the critical
 * IPC so the mirrors / stores / message-store are consistent before the
 * caller opens the chat.
 */
import {NostraBridge} from './nostra-bridge';
import {decodePubkey} from './nostr-identity';
import {NostraPeerMapper} from './nostra-peer-mapper';
import {getMessageStore} from './message-store';
import {dispatchDialogUpdate} from './nostra-message-handler';
import {MOUNT_CLASS_TO} from '@config/debug';
import rootScope from '@lib/rootScope';

export interface AddP2PContactOptions {
  /** npub1… or 64-char hex pubkey */
  pubkey: string;
  /** Optional user-supplied nickname. Wins over kind 0 display_name. */
  nickname?: string;
  /** If true, open the chat via `appImManager.setInnerPeer` once state is ready. */
  openChat?: boolean;
  /** Timeout in ms to wait for ChatAPI.connect before proceeding. Default 3000. */
  connectTimeoutMs?: number;
  /** Logging tag, e.g. 'contacts-tab' | 'qr-scanner' — aids debugging. */
  source?: string;
}

export interface AddP2PContactResult {
  hexPubkey: string;
  peerId: number;
  peerIdTweb: PeerId;
  displayName: string;
  /** True when this is the first time we see this pubkey locally. */
  isNew: boolean;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if(!done) { done = true; resolve(undefined); } }, ms);
    p.then((v) => { if(!done) { done = true; clearTimeout(t); resolve(v); } })
    .catch(() => { if(!done) { done = true; clearTimeout(t); resolve(undefined); } });
  });
}

/**
 * Add a P2P contact with fully-consistent state by the time this function
 * resolves. Safe to call multiple times with the same pubkey (idempotent).
 */
export async function addP2PContact(opts: AddP2PContactOptions): Promise<AddP2PContactResult> {
  const src = opts.source || 'addP2PContact';
  const input = opts.pubkey.trim();
  const hexPubkey = input.startsWith('npub1') ? decodePubkey(input) : input;

  const bridge = NostraBridge.getInstance();
  const peerId = await bridge.mapPubkeyToPeerId(hexPubkey);
  const peerIdTweb = peerId.toPeerId(false);

  // Check for pre-existing mapping so we can report isNew back to the caller
  // and honour an existing nickname if the user didn't supply one.
  let existingDisplayName: string | undefined;
  let isNew = true;
  try {
    const {getMapping} = await import('./virtual-peers-db');
    const existing = await getMapping(hexPubkey);
    if(existing) {
      isNew = false;
      existingDisplayName = existing.displayName;
    }
  } catch{ /* fresh DB — treat as new */ }

  const userNickname = opts.nickname?.trim() || undefined;
  const displayName =
    userNickname ||
    existingDisplayName ||
    'npub...' + hexPubkey.slice(0, 12);

  await bridge.storePeerMapping(hexPubkey, peerId, userNickname || existingDisplayName);

  // Inject User into Worker BEFORE we touch the main-thread mirrors — the
  // bridge needs a Worker-side user so `users.getFullUser` etc. don't race.
  const avatar = bridge.deriveAvatarFromPubkeySync(hexPubkey);
  try {
    await rootScope.managers.appUsersManager.injectP2PUser(
      hexPubkey, peerId, displayName, avatar
    );
  } catch(err) {
    console.warn('[' + src + '] Worker injectP2PUser failed:', err);
  }

  // Main-thread mirrors + Solid store
  const mapper = new NostraPeerMapper();
  const user = mapper.createTwebUser({peerId, firstName: displayName, pubkey: hexPubkey});
  const proxyRef = MOUNT_CLASS_TO.apiManagerProxy;
  if(proxyRef?.mirrors?.peers) proxyRef.mirrors.peers[peerIdTweb] = user;
  try {
    const {reconcilePeer} = await import('@stores/peers');
    reconcilePeer(peerIdTweb, user);
  } catch{ /* store not yet mounted */ }

  // Seed a contact-init message in the store so the Worker's getDialogs()
  // can find this conversation after a reload. VMT.getHistory filters these
  // synthetic entries out so they never render as a bubble.
  //
  // CRITICAL: `seedMid` MUST be non-zero even if ownPubkey is not yet ready.
  // A dialog with top_message=0 enters tweb's "something strange with dialog"
  // branch (appMessagesManager.ts) on every getDialogs pass and breaks the
  // virtual-scroller fetch loop (no progress → infinite refetch). The mid
  // computation does not depend on ownPubkey, only the message-store seed
  // does — so we compute the mid unconditionally and skip the persist when
  // ownPubkey is missing.
  const ownPubkey = (window as any).__nostraOwnPubkey;
  const seedTimestamp = Math.floor(Date.now() / 1000);
  const initEventId = 'contact-init-' + hexPubkey;
  let seedMid = 0;
  try {
    seedMid = await mapper.mapEventId(initEventId, seedTimestamp);
  } catch(err) {
    console.warn('[' + src + '] mapEventId failed:', err);
  }
  if(ownPubkey && seedMid) {
    try {
      const store = getMessageStore();
      const conversationId = store.getConversationId(ownPubkey, hexPubkey);
      await store.saveMessage({
        eventId: initEventId,
        conversationId,
        senderPubkey: hexPubkey,
        content: '',
        type: 'text',
        timestamp: seedTimestamp,
        deliveryState: 'delivered',
        mid: seedMid,
        twebPeerId: peerId,
        isOutgoing: false
      });
    } catch(err) {
      console.warn('[' + src + '] message-store seed failed:', err);
    }
  }

  // Connect the ChatAPI to this peer. First-peer connect initialises the
  // relay pool (can take seconds); subsequent calls are a fast activePeer
  // switch. Bounded wait keeps the UI responsive even if relays are slow.
  const chatAPI = (window as any).__nostraChatAPI;
  if(chatAPI?.connect) {
    await withTimeout(chatAPI.connect(hexPubkey), opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
  }

  // Build a proper top-message + dialog. Attaching the msg object as
  // `(dialog as any).topMessage` is required — without it setLastMessage
  // falls back to getMessageByPeer which fails when hasReachedTheEnd is
  // still false (documented in CLAUDE.md).
  const seedMsg = mapper.createTwebMessage({
    mid: seedMid,
    peerId,
    fromPeerId: peerId,
    date: seedTimestamp,
    text: '',
    isOutgoing: false
  });

  const dialog = mapper.createTwebDialog({
    peerId,
    topMessage: seedMid,
    topMessageDate: seedTimestamp,
    unreadCount: 0
  });
  (dialog as any).topMessage = seedMsg;

  // Dispatch dialog twice (add → preview refresh) per CLAUDE.md rule.
  dispatchDialogUpdate(peerId, dialog);
  rootScope.dispatchEvent('peer_title_edit', {peerId: peerIdTweb});

  // Fire-and-forget kind 0 lookup — populates the peer profile cache so
  // the User Info pane renders Bio / Website / Lightning / NIP-05 rows
  // on first open without a relay round-trip. Optionally upgrades the
  // placeholder displayName when the user did not supply a nickname.
  kickOffKind0Fetch(hexPubkey, peerId, displayName, src, !userNickname)
  .catch(() => { /* non-critical */ });

  if(opts.openChat) {
    try {
      const appImManager = (await import('@lib/appImManager')).default;
      appImManager.setInnerPeer({peerId: peerIdTweb});
    } catch(err) {
      console.warn('[' + src + '] setInnerPeer failed:', err);
    }
  }

  return {hexPubkey, peerId, peerIdTweb, displayName, isNew};
}

async function kickOffKind0Fetch(
  hexPubkey: string,
  peerId: number,
  currentDisplayName: string,
  src: string,
  allowNameUpdate: boolean
): Promise<void> {
  const [
    {profileToDisplayName},
    {updateMappingProfile},
    {refreshPeerProfileFromRelays, loadCachedPeerProfile}
  ] = await Promise.all([
    import('./nostr-profile'),
    import('./virtual-peers-db'),
    import('./peer-profile-cache')
  ]);

  // Parallel fetch + cache write + nostra_peer_profile_updated dispatch.
  // After this resolves, the User Info pane will render the kind 0 fields
  // immediately on first open instead of waiting for an on-mount refresh.
  const peerIdTweb = peerId.toPeerId(false);
  await refreshPeerProfileFromRelays(hexPubkey, peerIdTweb);

  if(!allowNameUpdate) return;

  const cached = loadCachedPeerProfile(hexPubkey);
  if(!cached) return;
  const k0Name = profileToDisplayName(cached.profile);
  if(!k0Name || k0Name === currentDisplayName) return;

  await updateMappingProfile(hexPubkey, k0Name, cached.profile);
  try {
    await rootScope.managers.appUsersManager.updateP2PUserName(peerId, k0Name);
  } catch{ /* non-critical */ }

  const proxyRef = MOUNT_CLASS_TO.apiManagerProxy;
  if(proxyRef?.mirrors?.peers?.[peerIdTweb]) {
    proxyRef.mirrors.peers[peerIdTweb].first_name = k0Name;
    try {
      const {reconcilePeer} = await import('@stores/peers');
      reconcilePeer(peerIdTweb, proxyRef.mirrors.peers[peerIdTweb]);
    } catch{ /* non-critical */ }
  }

  rootScope.dispatchEvent('peer_title_edit', {peerId: peerIdTweb});
  console.log('[' + src + '] kind 0 profile applied:', k0Name, 'for', hexPubkey.slice(0, 8));
}
