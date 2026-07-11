/**
 * PhantomChat device-sync — scoped, strict-union history reconciliation between
 * the user's OWN devices.
 *
 * The problem: history lives only in each device's IndexedDB. A device that was
 * offline when a message arrived relies on relay backfill to catch up — and if
 * the relay already dropped the event, that device is missing it forever. Nothing
 * lets the device that HAS the message hand it to the device that doesn't.
 *
 * The insight (from the typing indicator): reliability comes from the REPEAT, not
 * from clever addressing. The typing pulse survives a flaky mobile socket because
 * it re-fires every few seconds — a device that missed one beat catches the next.
 * A one-shot "I'm here" beacon can be missed forever; a heartbeat can't.
 *
 * So device-sync is a heartbeat that carries a DIGEST. For the currently-open
 * chat, each device periodically self-addresses (gift-wrapped to our OWN pubkey,
 * so it reaches our other devices and nobody else) a compact advertisement:
 * "conversation X — I hold `count` messages, newest is `latestId`". When another
 * of our devices hears a digest advertising MORE than it holds, it knows it's
 * behind that conversation.
 *
 * This module is INCREMENT 1: emit the self-digest heartbeat, receive a peer
 * device's digest, and surface a transient "syncing" indicator when we detect
 * we're behind. Increment 2 turns "I'm behind" into an actual scoped, strict-union
 * pull of the missing messages. Increment 3 hardens (chunking, throttle).
 *
 * Design rules baked in (Andrew's brief):
 *   - EPHEMERAL presence, no device roster: we never persist "seen" devices. A
 *     device that stops pulsing simply goes quiet — there is no database of dead
 *     devices. deviceId is a fresh per-session id, forgotten on reload.
 *   - SCOPED to the open chat: we only ever reconcile the conversation you're
 *     looking at ("I just opened / messaged X, let's compare notes on X").
 *   - STRICT UNION (Increment 2): reconciliation only ever ADDS; it never deletes.
 */

const LOG_PREFIX = '[PhantomChatDeviceSync]';

/** How often we re-advertise the open chat's digest (ms). Heartbeat cadence. */
const PULSE_INTERVAL_MS = 45_000;

/** Debounce for send/receive-triggered pulses so a burst collapses to one (ms). */
const POKE_DEBOUNCE_MS = 1_500;

/** Don't re-show the "syncing" indicator more than once per this window (ms). */
const INDICATOR_THROTTLE_MS = 8_000;

/** How long the transient "syncing" indicator stays on screen (ms). */
const INDICATOR_TTL_MS = 4_000;

/** Don't issue more than one sync REQUEST per conversation inside this window (ms). */
const REQUEST_THROTTLE_MS = 6_000;

/** Rows per sync-response chunk, so a big backlog never overflows one gift-wrap. */
const RESPONSE_CHUNK_ROWS = 25;

/** Hard cap on eventIds we advertise in a have-set (bounds a huge conversation). */
const HAVE_IDS_CAP = 5_000;

/**
 * Wire subset of a StoredMessage sufficient to reconstruct + render a bubble on
 * the receiving device. `mid`/`twebPeerId` are deterministic (derived from
 * eventId+timestamp / pubkey) so they are RECOMPUTED on receive, never trusted
 * from the wire.
 */
interface DeviceSyncRow {
  eventId: string;
  conversationId: string;
  senderPubkey: string;
  content: string;
  type: 'text' | 'file';
  timestamp: number;
  deliveryState?: string;
  isOutgoing?: boolean;
  appMessageId?: string;
  replyToMid?: number;
  editedAt?: number;
  fileMetadata?: any;
  serviceType?: 'chatCreate';
  servicePayload?: {title?: string; memberPeerIds?: number[]};
}

/** Per-conversation timestamp of our last outbound sync request (throttle). */
const lastRequestAt = new Map<string, number>();

let ownPubkey: string | null = null;

/**
 * A fresh per-session device identifier. Lets our other devices distinguish a
 * digest we authored (ignore — it's our own echo bouncing back off the relay)
 * from one a DIFFERENT device of ours authored (act on it). Deliberately NOT
 * persisted: presence is ephemeral, there is no roster of devices.
 */
let deviceId = '';

let pulseTimer: ReturnType<typeof setInterval> | null = null;
let pokeTimer: ReturnType<typeof setTimeout> | null = null;
let lastIndicatorAt = 0;

/** The peer whose chat is currently open — the only conversation we reconcile. */
let activePeerPubkey: string | null = null;

/**
 * Latest digest heard from another of our devices, keyed by conversationId.
 * Increment 2 consumes this to decide what to pull. Increment 1 only reads it to
 * flip the "syncing" indicator.
 */
const remoteDigests = new Map<string, {deviceId: string; count: number; latestId: string; at: number}>();

function newDeviceId(): string {
  if(typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Initialize device-sync. Call once after identity is loaded and the relay pool
 * is connected (alongside initPresence).
 */
export async function initDeviceSync(pubkey: string): Promise<void> {
  ownPubkey = pubkey;
  deviceId = newDeviceId();

  // Route inbound digests + sync request/response from our other devices.
  try {
    const pool = (window as any).__phantomchatChatAPI?.relayPool;
    if(pool?.setOnDigest) {
      pool.setOnDigest((d: {deviceId: string; conv: string; count: number; latestId: string}) => onRemoteDigest(d));
    }
    if(pool?.setOnSyncRequest) {
      pool.setOnSyncRequest((r: {deviceId: string; targetId: string; conv: string; haveIds: string[]}) => onSyncRequest(r));
    }
    if(pool?.setOnSyncResponse) {
      pool.setOnSyncResponse((r: {deviceId: string; targetId: string; conv: string; rows: unknown[]; seq: number; last: boolean}) => onSyncResponse(r));
    }
  } catch(err) {
    console.debug(`${LOG_PREFIX} pool wiring failed:`, (err as Error)?.message);
  }

  // Re-advertise the open chat's digest on a heartbeat so a device that connects
  // late catches the next beat (the whole point of a pulse over a one-shot).
  pulseTimer = setInterval(() => void publishActiveDigest(), PULSE_INTERVAL_MS);

  // Advertise (and switch scope) whenever a chat opens.
  await wireChatOpen();

  // Durable reconcile triggers beyond chat-open + heartbeat:
  //  - incoming PEER TYPING: the peer's tick is p-tagged to us, so it wakes BOTH
  //    our devices at the same instant — a free synchronized "compare notes now"
  //    barrier. Re-advertise our digest so the behind device pulls immediately.
  //  - RECONNECT: a socket that just came back re-advertises so a device that was
  //    offline reconciles the open chat without waiting for the next heartbeat.
  //  - FOREGROUND: waking a backgrounded PWA re-advertises for the same reason.
  wireTypingTrigger();
  wireReconnectTrigger();
  wireForegroundTrigger();

  (window as any).__phantomchatDeviceSync = {deviceId, remoteDigests, publishActiveDigest};
  console.log(`${LOG_PREFIX} initialized for ${pubkey.slice(0, 8)}... (device ${deviceId.slice(0, 8)})`);
}

/**
 * Compute the digest for the currently-open conversation and self-publish it.
 * No-op when no P2P chat is open or the pool isn't ready.
 */
export async function publishActiveDigest(): Promise<void> {
  const peer = activePeerPubkey;
  if(!peer || !ownPubkey) return;
  try {
    const pool = (window as any).__phantomchatChatAPI?.relayPool;
    if(!pool?.isConnected?.() || typeof pool.publishSelfDigest !== 'function') return;

    const {getMessageStore} = await import('./message-store');
    const store = getMessageStore();
    const conv = store.getConversationId(ownPubkey, peer);
    const {count, latestId} = await store.getConversationDigest(conv);

    // Nothing to advertise for an empty conversation.
    if(count === 0) return;

    await pool.publishSelfDigest({deviceId, conv, count, latestId});
    console.log(`${LOG_PREFIX} → digest ${conv.slice(0, 12)}… count=${count}`);
  } catch(err) {
    console.debug(`${LOG_PREFIX} publishActiveDigest failed:`, (err as Error)?.message);
  }
}

/**
 * A digest arrived from one of our own devices. Ignore our own echo; otherwise
 * record it and, if it advertises more than we hold for that conversation, show
 * the transient "syncing" indicator. (Increment 2 will pull the gap here.)
 */
export async function onRemoteDigest(d: {deviceId: string; conv: string; count: number; latestId: string}): Promise<void> {
  if(!d || !d.conv) return;
  if(d.deviceId && d.deviceId === deviceId) return; // our own echo — ignore

  remoteDigests.set(d.conv, {deviceId: d.deviceId, count: d.count, latestId: d.latestId, at: Date.now()});
  console.log(`${LOG_PREFIX} ← digest ${d.conv.slice(0, 12)}… count=${d.count} from device ${(d.deviceId || '?').slice(0, 8)}`);

  try {
    const {getMessageStore} = await import('./message-store');
    const store = getMessageStore();
    const local = await store.getConversationDigest(d.conv);

    const behind = d.count > local.count ||
      (d.count === local.count && !!d.latestId && d.latestId !== local.latestId);

    if(behind) {
      console.log(`${LOG_PREFIX} behind on ${d.conv.slice(0, 12)}…: local=${local.count} remote=${d.count} — requesting sync`);
      showSyncingIndicator();
      // Increment 2: pull the gap from the device that advertised more.
      void requestSyncFromDevice(d.conv, d.deviceId);
    }
  } catch(err) {
    console.debug(`${LOG_PREFIX} onRemoteDigest compare failed:`, (err as Error)?.message);
  }
}

/**
 * Nudge a digest pulse after a local change (send/receive) in the active chat, so
 * "I just messaged X, let's compare notes" happens promptly rather than waiting
 * for the next heartbeat. Debounced so a burst of sends collapses to one pulse.
 */
export function pokeDeviceSync(): void {
  if(!activePeerPubkey) return;
  if(pokeTimer) clearTimeout(pokeTimer);
  pokeTimer = setTimeout(() => {
    pokeTimer = null;
    void publishActiveDigest();
  }, POKE_DEBOUNCE_MS);
}

/** Show a brief, self-dismissing "syncing" pill. Throttled + transient. */
function showSyncingIndicator(): void {
  if(typeof document === 'undefined') return;
  const now = Date.now();
  if(now - lastIndicatorAt < INDICATOR_THROTTLE_MS) return;
  lastIndicatorAt = now;

  const pill = document.createElement('div');
  pill.textContent = '🔄 Syncing history from your other device…';
  pill.style.cssText = [
    'position:fixed',
    'top:calc(env(safe-area-inset-top, 0px) + 10px)',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:100000',
    'padding:7px 16px',
    'border-radius:18px',
    'background:rgba(51,144,236,.95)',
    'color:#fff',
    'font-size:13px',
    'font-weight:500',
    'font-family:inherit',
    'line-height:1.2',
    'box-shadow:0 2px 12px rgba(0,0,0,.3)',
    'max-width:92vw',
    'white-space:nowrap',
    'overflow:hidden',
    'text-overflow:ellipsis',
    'pointer-events:none',
    'transition:opacity .3s ease'
  ].join(';');

  document.body.appendChild(pill);
  setTimeout(() => { pill.style.opacity = '0'; }, INDICATOR_TTL_MS - 300);
  setTimeout(() => { pill.remove(); }, INDICATOR_TTL_MS);
}

/**
 * Resolve a peerId to the pubkey of the P2P contact, or null for a non-P2P peer
 * (group/other) so we stop advertising when such a chat is open.
 */
async function resolvePeerPubkey(peerId: number): Promise<string | null> {
  try {
    const {getAllMappings} = await import('@lib/phantomchat/virtual-peers-db');
    const mappings = await getAllMappings();
    for(const m of mappings) {
      if(m.peerId === peerId) return m.pubkey;
    }
  } catch(err) {
    console.debug(`${LOG_PREFIX} resolvePeerPubkey failed:`, (err as Error)?.message);
  }
  return null;
}

/**
 * Hook chat-open so device-sync scopes to — and immediately advertises — the
 * conversation the user just entered. Mirrors phantomchat-presence: `peer_changed`
 * is dispatched on appImManager, NOT rootScope.
 */
async function wireChatOpen(): Promise<void> {
  try {
    const appImManager = (await import('@lib/appImManager')).default;
    appImManager.addEventListener('peer_changed' as any, (payload: any) => {
      const peerId: number | undefined = typeof payload === 'number' ?
        payload :
        (typeof payload?.peerId === 'number' ? payload.peerId : undefined);
      if(typeof peerId !== 'number') return;
      void onChatOpen(peerId);
    });
  } catch(err) {
    console.debug(`${LOG_PREFIX} wireChatOpen failed:`, (err as Error)?.message);
  }
}

async function onChatOpen(peerId: number): Promise<void> {
  const pubkey = await resolvePeerPubkey(peerId);
  activePeerPubkey = pubkey; // null for group/other — stops advertising
  if(!pubkey) return;
  console.log(`${LOG_PREFIX} chat-open: peer ${peerId} (${pubkey.slice(0, 8)}) — advertising digest`);
  void publishActiveDigest();
}

/**
 * Incoming peer-typing trigger. The peer's typing tick is p-tagged to us, so
 * both our devices receive it simultaneously — the perfect moment to compare
 * notes. On any typing edge for a tracked peer, re-advertise the open chat's
 * digest (debounced via pokeDeviceSync) so a behind device pulls right then.
 */
function wireTypingTrigger(): void {
  try {
    // Lazy import to dodge a static cycle; rootScope is the main-thread bus the
    // typing receiver dispatches `peer_typings` on for INCOMING peer ticks.
    void import('@lib/rootScope').then(({default: rootScope}) => {
      rootScope.addEventListener('peer_typings' as any, () => {
        // A typing edge (start OR stop) for whatever chat is open ⇒ nudge a digest.
        pokeDeviceSync();
      });
    }).catch((err) => console.debug(`${LOG_PREFIX} typing trigger wiring failed:`, (err as Error)?.message));
  } catch(err) {
    console.debug(`${LOG_PREFIX} wireTypingTrigger failed:`, (err as Error)?.message);
  }
}

/** Reconnect trigger: when the relay pool reports connectivity restored, re-advertise. */
function wireReconnectTrigger(): void {
  try {
    const pool = (window as any).__phantomchatChatAPI?.relayPool;
    // The pool already exposes a state-change fan-out (connectedCount). Chain onto
    // it without clobbering existing subscribers by wrapping the current callback.
    if(pool && typeof pool.addStateChangeListener === 'function') {
      pool.addStateChangeListener((connected: number) => {
        if(connected > 0) void publishActiveDigest();
      });
    }
  } catch(err) {
    console.debug(`${LOG_PREFIX} wireReconnectTrigger failed:`, (err as Error)?.message);
  }
}

/** Foreground trigger: re-advertise when a backgrounded PWA becomes visible again. */
function wireForegroundTrigger(): void {
  if(typeof document === 'undefined') return;
  try {
    document.addEventListener('visibilitychange', () => {
      if(document.visibilityState === 'visible') void publishActiveDigest();
    });
  } catch(err) {
    console.debug(`${LOG_PREFIX} wireForegroundTrigger failed:`, (err as Error)?.message);
  }
}

/**
 * We're behind on `conv` and `targetDeviceId` advertised more — ask it for the
 * rows we're missing. Sends our have-set (the eventIds we already hold) so the
 * fuller device replies with only the difference. Throttled per conversation.
 */
async function requestSyncFromDevice(conv: string, targetDeviceId: string): Promise<void> {
  if(!targetDeviceId || targetDeviceId === deviceId) return;
  const now = Date.now();
  const last = lastRequestAt.get(conv) || 0;
  if(now - last < REQUEST_THROTTLE_MS) return;
  lastRequestAt.set(conv, now);

  try {
    const pool = (window as any).__phantomchatChatAPI?.relayPool;
    if(!pool?.isConnected?.() || typeof pool.publishSyncRequest !== 'function') return;

    const {getMessageStore} = await import('./message-store');
    const store = getMessageStore();
    let haveIds = await store.getConversationEventIds(conv);
    if(haveIds.length > HAVE_IDS_CAP) haveIds = haveIds.slice(-HAVE_IDS_CAP);

    await pool.publishSyncRequest({deviceId, targetId: targetDeviceId, conv, haveIds});
    console.log(`${LOG_PREFIX} → sync-request ${conv.slice(0, 12)}… have=${haveIds.length} to device ${targetDeviceId.slice(0, 8)}`);
  } catch(err) {
    console.debug(`${LOG_PREFIX} requestSyncFromDevice failed:`, (err as Error)?.message);
  }
}

/**
 * Another of our devices asked us (targetId === us) for the rows it's missing on
 * `conv`. Compute the strict set difference (rows we hold whose eventId isn't in
 * its have-set), chunk it, and answer. No-op when the request isn't aimed at us
 * or we hold nothing extra.
 */
async function onSyncRequest(req: {deviceId: string; targetId: string; conv: string; haveIds: string[]}): Promise<void> {
  if(!req || req.targetId !== deviceId) return;      // not aimed at this device
  if(req.deviceId === deviceId) return;              // our own echo
  try {
    const pool = (window as any).__phantomchatChatAPI?.relayPool;
    if(!pool?.isConnected?.() || typeof pool.publishSyncResponse !== 'function') return;

    const {getMessageStore} = await import('./message-store');
    const store = getMessageStore();
    const rows = await store.getMessages(req.conv, 100_000);
    const have = new Set(req.haveIds);
    const missing = rows.filter((r) => r.eventId && !have.has(r.eventId));

    if(missing.length === 0) {
      console.log(`${LOG_PREFIX} sync-request ${req.conv.slice(0, 12)}… — nothing extra to send`);
      return;
    }

    // Oldest-first so the requester fills gaps in chronological order.
    missing.sort((a, b) => a.timestamp - b.timestamp);
    const wire: DeviceSyncRow[] = missing.map(toWireRow);

    const chunks = Math.ceil(wire.length / RESPONSE_CHUNK_ROWS);
    console.log(`${LOG_PREFIX} → sync-response ${req.conv.slice(0, 12)}… ${wire.length} row(s) in ${chunks} chunk(s) to device ${req.deviceId.slice(0, 8)}`);
    for(let seq = 0; seq < chunks; seq++) {
      const slice = wire.slice(seq * RESPONSE_CHUNK_ROWS, (seq + 1) * RESPONSE_CHUNK_ROWS);
      await pool.publishSyncResponse({
        deviceId,
        targetId: req.deviceId,
        conv: req.conv,
        rows: slice,
        seq,
        last: seq === chunks - 1
      });
    }
  } catch(err) {
    console.debug(`${LOG_PREFIX} onSyncRequest failed:`, (err as Error)?.message);
  }
}

/**
 * A fuller device answered our request with rows we were missing. Strict union:
 * ingest only rows we don't already hold (by eventId); never delete. Each new row
 * is persisted and, if its chat is open, painted live.
 */
async function onSyncResponse(res: {deviceId: string; targetId: string; conv: string; rows: unknown[]; seq: number; last: boolean}): Promise<void> {
  if(!res || res.targetId !== deviceId) return;      // not aimed at this device
  if(res.deviceId === deviceId) return;              // our own echo
  if(!Array.isArray(res.rows) || res.rows.length === 0) return;

  let applied = 0;
  try {
    const {getMessageStore} = await import('./message-store');
    const store = getMessageStore();
    for(const raw of res.rows) {
      const row = raw as DeviceSyncRow;
      if(!row || typeof row.eventId !== 'string' || typeof row.timestamp !== 'number') continue;
      const existing = await store.getByEventId(row.eventId);
      if(existing) continue;                          // strict union — never clobber
      const ok = await ingestPulledRow(row);
      if(ok) applied++;
    }
  } catch(err) {
    console.debug(`${LOG_PREFIX} onSyncResponse failed:`, (err as Error)?.message);
  }
  if(applied > 0) {
    console.log(`${LOG_PREFIX} ← sync-response ${res.conv.slice(0, 12)}… applied ${applied} new row(s) (seq ${res.seq}${res.last ? ', last' : ''})`);
    showSyncingIndicator();
  }
}

/** Serialize a StoredMessage down to the wire subset the peer device needs. */
function toWireRow(r: any): DeviceSyncRow {
  return {
    eventId: r.eventId,
    conversationId: r.conversationId,
    senderPubkey: r.senderPubkey,
    content: r.content,
    type: r.type === 'file' ? 'file' : 'text',
    timestamp: r.timestamp,
    deliveryState: r.deliveryState,
    isOutgoing: !!r.isOutgoing,
    ...(r.appMessageId ? {appMessageId: r.appMessageId} : {}),
    ...(typeof r.replyToMid === 'number' ? {replyToMid: r.replyToMid} : {}),
    ...(typeof r.editedAt === 'number' ? {editedAt: r.editedAt} : {}),
    ...(r.fileMetadata ? {fileMetadata: r.fileMetadata} : {}),
    ...(r.serviceType ? {serviceType: r.serviceType} : {}),
    ...(r.servicePayload ? {servicePayload: r.servicePayload} : {})
  };
}

/**
 * Persist a pulled row and, when its chat is open, paint it live. mid + twebPeerId
 * are recomputed locally from the deterministic maps (never trusted from the wire).
 * Returns true when the row was stored. Handles BOTH directions: an outgoing row
 * (a message WE sent from the other device — Andrew's core "my bubble didn't
 * arrive" case) renders on the right; an incoming row renders on the left.
 */
async function ingestPulledRow(row: DeviceSyncRow): Promise<boolean> {
  if(!ownPubkey) return false;

  // The conversation peer is the participant that isn't us.
  const parts = (row.conversationId || '').split(':');
  const peer = parts.find((p) => p && p !== ownPubkey) || (row.senderPubkey !== ownPubkey ? row.senderPubkey : '');
  if(!peer) return false;

  try {
    const {PhantomChatBridge} = await import('./phantomchat-bridge');
    const bridge = PhantomChatBridge.getInstance();
    const peerId = await bridge.mapPubkeyToPeerId(peer);
    const mid = await bridge.mapEventIdToMid(row.eventId, Math.floor(row.timestamp));
    if(peerId === undefined || mid === undefined) return false;

    const {getMessageStore} = await import('./message-store');
    const store = getMessageStore();
    await store.saveMessage({
      eventId: row.eventId,
      conversationId: row.conversationId,
      senderPubkey: row.senderPubkey,
      content: row.content,
      type: row.type === 'file' ? 'file' : 'text',
      timestamp: row.timestamp,
      deliveryState: (row.deliveryState as any) || (row.isOutgoing ? 'sent' : 'delivered'),
      mid,
      twebPeerId: peerId,
      isOutgoing: !!row.isOutgoing,
      ...(row.appMessageId ? {appMessageId: row.appMessageId} : {}),
      ...(typeof row.replyToMid === 'number' ? {replyToMid: row.replyToMid} : {}),
      ...(typeof row.editedAt === 'number' ? {editedAt: row.editedAt} : {}),
      ...(row.fileMetadata ? {fileMetadata: row.fileMetadata} : {}),
      ...(row.serviceType ? {serviceType: row.serviceType} : {}),
      ...(row.servicePayload ? {servicePayload: row.servicePayload} : {})
    });

    // Live paint only when the pulled row's chat is the one on screen. Otherwise
    // the store row is enough — getHistory renders it (in order) on next open.
    if(activePeerPubkey === peer) {
      await renderPulledRow(row, peerId, mid, peer);
    }
    return true;
  } catch(err) {
    console.debug(`${LOG_PREFIX} ingestPulledRow failed:`, (err as Error)?.message);
    return false;
  }
}

/**
 * Paint a just-ingested row into the open chat. Builds a tweb Message honoring
 * direction (createTwebMessage handles isOutgoing → right-aligned bubble + tick)
 * and dispatches `history_append`; bubbles.ts dedups by mid so a race with
 * getHistory is harmless.
 */
async function renderPulledRow(row: DeviceSyncRow, peerId: number, mid: number, peer: string): Promise<void> {
  try {
    const [{PhantomChatPeerMapper}, {buildPhantomChatMedia}, {default: rootScope}] = await Promise.all([
      import('./phantomchat-peer-mapper'),
      import('./phantomchat-media-shape'),
      import('@lib/rootScope')
    ]);
    const mapper = new PhantomChatPeerMapper();
    const media = row.fileMetadata ? buildPhantomChatMedia(mid, row.fileMetadata) : undefined;
    const msg = mapper.createTwebMessage({
      mid,
      peerId,
      // 1-on-1: for INCOMING the sender is the peer (set from_id); for OUTGOING
      // omit it so `pFlags.out` alone signals ownership (a peer from_id on our own
      // message would render it as peer-authored). Mirrors createTwebMessage's contract.
      ...(row.isOutgoing ? {} : {fromPeerId: peerId}),
      date: Math.floor(row.timestamp),
      text: media ? (row.fileMetadata?.caption || row.content || '') : row.content,
      isOutgoing: !!row.isOutgoing,
      deliveryState: row.deliveryState as any,
      media,
      ...(typeof row.replyToMid === 'number' ? {replyToMid: row.replyToMid} : {})
    } as any);

    try {
      await rootScope.managers.appMessagesManager.invalidateHistoryCache(peerId);
    } catch{ /* non-critical */ }

    rootScope.dispatchEvent('history_append' as any, {
      storageKey: `${peerId}_history`,
      message: msg,
      peerId
    });
    console.log(`${LOG_PREFIX} painted pulled ${row.isOutgoing ? 'outgoing' : 'incoming'} bubble mid=${mid} for peer ${String(peer).slice(0, 8)}`);
  } catch(err) {
    console.debug(`${LOG_PREFIX} renderPulledRow failed:`, (err as Error)?.message);
  }
}

/** Clean up on page unload. */
export function destroyDeviceSync(): void {
  if(pulseTimer) { clearInterval(pulseTimer); pulseTimer = null; }
  if(pokeTimer) { clearTimeout(pokeTimer); pokeTimer = null; }
  remoteDigests.clear();
  lastRequestAt.clear();
  activePeerPubkey = null;
  ownPubkey = null;
  deviceId = '';
}
