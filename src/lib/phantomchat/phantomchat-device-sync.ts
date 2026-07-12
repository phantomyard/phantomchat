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
 * Sync-before-render barrier (Andrew's brief). When an incoming message arrives
 * and one of our OWN other devices is currently live, we do a quick RECENT-ONLY
 * catch-up from that sibling BEFORE painting the incoming bubble — so the new
 * message never lands above a gap the sibling could have filled (crucial for
 * media a sibling already holds). It is a HARD block, but only ever gated behind
 * a live sibling; a single-device user is never delayed.
 */

/** Rows the recent-only barrier reconciles (last-N of the open conversation). */
const RECENT_PULL_ROWS = 25;

/** Hard ceiling on the sync-before-render wait — render anyway past this (ms). */
const RECENT_PULL_CEILING_MS = 5_000;

/** Collapse a burst of incoming messages to one recent-pull per conv (ms). */
const RECENT_PULL_THROTTLE_MS = 2_000;

/**
 * A sibling device is considered "live" if we heard ANY self-control envelope
 * (digest / sync req / sync res) authored by a DIFFERENT device within this
 * window. This is the gate for the sync-before-render barrier.
 */
const SIBLING_LIVE_WINDOW_MS = 90_000;

/**
 * Control envelopes (digest / sync req / sync res) ride the gift-wrap path, which
 * means relays STORE them. A device that connects therefore replays the entire
 * backlog of them — potentially hundreds of digests going back days. Acting on that
 * replay is wrong in two distinct ways:
 *
 *   1. STORM — every replayed digest ran a full compare and could fire a sync
 *      request, so a reconnect kicked off a burst of request/response churn.
 *   2. PHANTOM SIBLING — a replayed digest set `lastSiblingActivityAt = now`, so
 *      `hasLiveSibling()` reported true for 90s even when NO other device was
 *      online. Every incoming message in that window then hard-blocked the
 *      sync-before-render barrier for its full ceiling waiting on a pull that
 *      nobody would ever answer.
 *
 * So a control envelope is only honored when the AUTHORING device stamped it within
 * this window. Replayed history is inert. The window is generous relative to the
 * 45s heartbeat (a live pulse always lands well inside it) and to clock skew between
 * a user's own NTP-synced devices, but far tighter than the age of any backlog.
 *
 * Fail-open on a MISSING stamp: every envelope this code publishes carries one, so
 * absence means an envelope shape we don't know — treat it as live rather than
 * silently deafening device-sync against an older build.
 */
const CONTROL_FRESHNESS_MS = 120_000;

/** Collapse byte-identical digests arriving inside this window (multi-relay fan-in). */
const DIGEST_DEDUP_WINDOW_MS = 10_000;

/** Floor between reciprocal "actually, I hold more" digest replies per conv (ms). */
const DIGEST_REPLY_THROTTLE_MS = 6_000;

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
  /**
   * Millisecond-of-second (0-999) — the sub-second ordering signal. MUST ride
   * the wire: a pulled row's mid is RE-DERIVED on the receiving device, and
   * without this it would fall back to the legacy hash tiebreak and compute a
   * DIFFERENT mid than the device that already holds the row — forking one
   * message into two bubbles across devices. Absent on legacy rows.
   */
  msSlot?: number;
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

/** Per-conversation timestamp of our last recent-only barrier pull (throttle). */
const lastRecentPullAt = new Map<string, number>();

/**
 * In-flight sync-before-render barriers, keyed by conversationId. A pending entry
 * resolves the moment a sibling answers our recent-only request with a `last`
 * chunk (or on the hard ceiling), unblocking the incoming message's render.
 */
const pendingRecentPulls = new Map<string, {resolve: () => void; timer: ReturnType<typeof setTimeout>}>();

/**
 * Wall-clock of the last self-control envelope we heard from ANOTHER device.
 * Drives `hasLiveSibling()` — the gate for the sync-before-render barrier. Only
 * ever advanced by a FRESH envelope (see CONTROL_FRESHNESS_MS); a replayed one
 * must not fake a live sibling.
 */
let lastSiblingActivityAt = 0;

/** Last identical digest we acted on, keyed by digest identity → when we saw it. */
const recentDigestSeen = new Map<string, number>();

/** Digest we last PUBLISHED per conversation — lets the heartbeat skip a no-op. */
const lastPublishedDigest = new Map<string, string>();

/** Per-conversation floor on reciprocal digest replies to a behind sibling. */
const lastDigestReplyAt = new Map<string, number>();

/**
 * True when the authoring device stamped this control envelope recently enough to
 * be a LIVE pulse rather than a replayed backlog entry. Missing stamp → fail open.
 */
function isFreshControl(sentAt?: number): boolean {
  if(typeof sentAt !== 'number' || sentAt <= 0) return true; // unknown shape — fail open
  return (Date.now() - sentAt) < CONTROL_FRESHNESS_MS;
}

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
      pool.setOnDigest((d: {deviceId: string; conv: string; count: number; latestId: string; sentAt?: number}) => onRemoteDigest(d));
    }
    if(pool?.setOnSyncRequest) {
      pool.setOnSyncRequest((r: {deviceId: string; targetId: string; conv: string; haveIds: string[]; recentOnly?: boolean; limit?: number; sentAt?: number}) => onSyncRequest(r));
    }
    if(pool?.setOnSyncResponse) {
      pool.setOnSyncResponse((r: {deviceId: string; targetId: string; conv: string; rows: unknown[]; seq: number; last: boolean; sentAt?: number}) => onSyncResponse(r));
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
 *
 * `force` distinguishes the two reasons we advertise:
 *   - The periodic HEARTBEAT (force=false) exists to catch a device that connected
 *     late. But a digest is a STORED event, so an idle chat re-publishing the same
 *     unchanged digest every 45s writes garbage to the relays forever. So the
 *     heartbeat publishes only when the digest actually CHANGED since our last one.
 *   - An EXPLICIT trigger (force=true) — chat-open, reconnect, foreground, a local
 *     send/receive, or a reciprocal reply to a behind sibling — always publishes,
 *     even unchanged, because those are precisely the moments some other device
 *     needs to hear us. Without the force the change-gate would suppress exactly
 *     the advertisement a freshly-connected sibling is waiting on.
 */
export async function publishActiveDigest(opts?: {force?: boolean}): Promise<void> {
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

    // Idle heartbeat on an unchanged conversation — say nothing, store nothing.
    const key = `${count}:${latestId}`;
    if(!opts?.force && lastPublishedDigest.get(conv) === key) return;

    await pool.publishSelfDigest({deviceId, conv, count, latestId});
    lastPublishedDigest.set(conv, key);
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
export async function onRemoteDigest(d: {deviceId: string; conv: string; count: number; latestId: string; sentAt?: number}): Promise<void> {
  if(!d || !d.conv) return;
  if(d.deviceId && d.deviceId === deviceId) return; // our own echo — ignore

  // Replayed backlog, not a live pulse: don't compare, don't request, and above all
  // don't let it masquerade as a live sibling and arm the render barrier.
  if(!isFreshControl(d.sentAt)) return;

  // Byte-identical digest we just acted on (same event fanned in from several
  // relays). Window is short on purpose: a genuinely REPEATED pulse 45s later must
  // still get through, because the re-send IS the retry that heals a lost pull.
  const now = Date.now();
  const identity = `${d.deviceId}|${d.conv}|${d.count}|${d.latestId}`;
  if(now - (recentDigestSeen.get(identity) || 0) < DIGEST_DEDUP_WINDOW_MS) return;
  recentDigestSeen.set(identity, now);
  // Every distinct digest mints a new key, so drop entries that have aged past the
  // dedup window rather than letting the map grow for the life of the session.
  if(recentDigestSeen.size > 64) {
    for(const [k, seenAt] of recentDigestSeen) {
      if(now - seenAt >= DIGEST_DEDUP_WINDOW_MS) recentDigestSeen.delete(k);
    }
  }

  lastSiblingActivityAt = now; // proof a sibling device is live
  remoteDigests.set(d.conv, {deviceId: d.deviceId, count: d.count, latestId: d.latestId, at: now});
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
      return;
    }

    // The sibling is BEHIND us. Reciprocate: force-publish our digest so it learns
    // we hold more and pulls. This is what keeps catch-up working now that the idle
    // heartbeat is change-gated — an idle-but-fuller device would otherwise stay
    // silent forever and a freshly-connected behind device would never hear anyone
    // advertising more than it holds.
    if(d.count < local.count) {
      // publishActiveDigest only ever speaks for the OPEN chat, so a reciprocal is
      // only meaningful when the sibling is talking about that same conversation.
      const activeConv = activePeerPubkey ? store.getConversationId(ownPubkey, activePeerPubkey) : null;
      if(d.conv !== activeConv) return;
      if(now - (lastDigestReplyAt.get(d.conv) || 0) < DIGEST_REPLY_THROTTLE_MS) return;
      lastDigestReplyAt.set(d.conv, now);
      console.log(`${LOG_PREFIX} sibling behind on ${d.conv.slice(0, 12)}… (theirs=${d.count} ours=${local.count}) — re-advertising`);
      void publishActiveDigest({force: true});
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
    void publishActiveDigest({force: true});
  }, POKE_DEBOUNCE_MS);
}

/** True when a DIFFERENT device of ours pulsed within the live window. */
function hasLiveSibling(): boolean {
  return lastSiblingActivityAt > 0 && (Date.now() - lastSiblingActivityAt) < SIBLING_LIVE_WINDOW_MS;
}

/**
 * Sync-before-render barrier. Call this with the incoming message's peer pubkey
 * BEFORE painting the bubble. If one of our OWN devices is currently live, issue a
 * RECENT-ONLY reconcile for that conversation and BLOCK on it (up to a hard
 * ceiling) so the incoming message lands on top of an up-to-date tail — never
 * above a gap the sibling already holds (media included). When no sibling is live,
 * or the pool isn't ready, it returns immediately: a single-device user is never
 * delayed. Best-effort and self-healing — a lost request just hits the ceiling and
 * renders anyway; the normal digest/heartbeat pull still backfills later.
 */
export async function syncRecentBeforeRender(peerPubkey: string): Promise<void> {
  if(!ownPubkey || !peerPubkey || peerPubkey === ownPubkey) return;
  if(!hasLiveSibling()) return; // no sibling to pull from — don't block

  let conv: string;
  try {
    const {getMessageStore} = await import('./message-store');
    conv = getMessageStore().getConversationId(ownPubkey, peerPubkey);
  } catch{
    return;
  }

  // Collapse a burst of incoming messages to a single recent pull per conversation.
  const now = Date.now();
  if(now - (lastRecentPullAt.get(conv) || 0) < RECENT_PULL_THROTTLE_MS) return;

  const pool = (window as any).__phantomchatChatAPI?.relayPool;
  if(!pool?.isConnected?.() || typeof pool.publishSyncRequest !== 'function') return;
  lastRecentPullAt.set(conv, now);

  try {
    const {getMessageStore} = await import('./message-store');
    const store = getMessageStore();
    // Have-set = our most-recent N eventIds, so the sibling's diff stays bounded
    // to the recent tail rather than the whole conversation.
    const recent = await store.getMessages(conv, RECENT_PULL_ROWS);
    const haveIds = recent.map((r) => r.eventId).filter((id): id is string => typeof id === 'string');

    // Broadcast (empty targetId) so ANY live sibling holding extra answers — we
    // don't need to know which device has it.
    await pool.publishSyncRequest({
      deviceId,
      targetId: '',
      conv,
      haveIds,
      recentOnly: true,
      limit: RECENT_PULL_ROWS
    });
    console.log(`${LOG_PREFIX} → recent-sync (before render) ${conv.slice(0, 12)}… have=${haveIds.length}, blocking ≤${RECENT_PULL_CEILING_MS}ms`);
  } catch(err) {
    console.debug(`${LOG_PREFIX} syncRecentBeforeRender request failed:`, (err as Error)?.message);
    return;
  }

  // Block until a sibling answers with a `last` chunk, or the hard ceiling fires.
  await new Promise<void>((resolve) => {
    const prior = pendingRecentPulls.get(conv);
    if(prior) { clearTimeout(prior.timer); prior.resolve(); }
    const timer = setTimeout(() => {
      pendingRecentPulls.delete(conv);
      resolve();
    }, RECENT_PULL_CEILING_MS);
    pendingRecentPulls.set(conv, {resolve, timer});
  });
}

/** Resolve (unblock) a pending sync-before-render barrier for a conversation. */
function resolveRecentPull(conv: string): void {
  const pending = pendingRecentPulls.get(conv);
  if(!pending) return;
  clearTimeout(pending.timer);
  pendingRecentPulls.delete(conv);
  pending.resolve();
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
  void publishActiveDigest({force: true});
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
        if(connected > 0) void publishActiveDigest({force: true});
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
      if(document.visibilityState === 'visible') void publishActiveDigest({force: true});
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
async function onSyncRequest(req: {deviceId: string; targetId: string; conv: string; haveIds: string[]; recentOnly?: boolean; limit?: number; sentAt?: number}): Promise<void> {
  if(!req || req.deviceId === deviceId) return;      // our own echo
  // targetId '' is a BROADCAST (sync-before-render) that ANY sibling answers; a
  // non-empty targetId must match this device (the classic digest-driven pull).
  if(req.targetId && req.targetId !== deviceId) return;
  // A replayed request is stale by definition — the asking device long since either
  // got its answer or moved on. Answering it would publish a fresh response backlog
  // to the relays for nobody, and fake a live sibling for the render barrier.
  if(!isFreshControl(req.sentAt)) return;
  lastSiblingActivityAt = Date.now();               // proof a sibling is live
  try {
    const pool = (window as any).__phantomchatChatAPI?.relayPool;
    if(!pool?.isConnected?.() || typeof pool.publishSyncResponse !== 'function') return;

    const {getMessageStore} = await import('./message-store');
    const store = getMessageStore();
    // For a recent-only request, only consider the last N rows so the barrier stays
    // cheap; getMessages returns newest-first, so this is exactly the recent tail.
    const scanLimit = req.recentOnly ? (req.limit && req.limit > 0 ? req.limit : RECENT_PULL_ROWS) : 100_000;
    const rows = await store.getMessages(req.conv, scanLimit);
    const have = new Set(req.haveIds);
    const missing = rows.filter((r) => r.eventId && !have.has(r.eventId));

    if(missing.length === 0) {
      console.log(`${LOG_PREFIX} sync-request ${req.conv.slice(0, 12)}… — nothing extra to send`);
      // A recent-only barrier is BLOCKING the requester's render — send an empty
      // `last` ACK so it unblocks immediately instead of waiting out the ceiling.
      if(req.recentOnly) {
        await pool.publishSyncResponse({deviceId, targetId: req.deviceId, conv: req.conv, rows: [], seq: 0, last: true});
      }
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
async function onSyncResponse(res: {deviceId: string; targetId: string; conv: string; rows: unknown[]; seq: number; last: boolean; sentAt?: number}): Promise<void> {
  if(!res || res.targetId !== deviceId) return;      // not aimed at this device
  if(res.deviceId === deviceId) return;              // our own echo
  // Deliberately NOT freshness-gated for INGEST: a response carries real rows, and
  // strict-union ingest is purely additive — a slow response that arrives late is
  // still worth applying. (Replays from a past session are already inert: they
  // target a previous session's deviceId, which the check above rejects.)
  // Liveness, though, must only ever come from a FRESH envelope.
  if(isFreshControl(res.sentAt)) lastSiblingActivityAt = Date.now();

  let applied = 0;
  if(Array.isArray(res.rows) && res.rows.length > 0) {
    try {
      const {getMessageStore} = await import('./message-store');
      const store = getMessageStore();
      for(const raw of res.rows) {
        const row = raw as DeviceSyncRow;
        if(!row || typeof row.eventId !== 'string' || typeof row.timestamp !== 'number') continue;
        const existing = await store.getByEventId(row.eventId);
        if(existing) continue;                        // strict union — never clobber
        const ok = await ingestPulledRow(row);
        if(ok) applied++;
      }
    } catch(err) {
      console.debug(`${LOG_PREFIX} onSyncResponse failed:`, (err as Error)?.message);
    }
  }
  if(applied > 0) {
    console.log(`${LOG_PREFIX} ← sync-response ${res.conv.slice(0, 12)}… applied ${applied} new row(s) (seq ${res.seq}${res.last ? ', last' : ''})`);
    showSyncingIndicator();
  }
  // The final chunk (even an empty ACK) unblocks any sync-before-render barrier
  // waiting on this conversation — rows are already ingested above.
  if(res.last) resolveRecentPull(res.conv);
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
    ...(typeof r.msSlot === 'number' ? {msSlot: r.msSlot} : {}),
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
    const mid = await bridge.mapEventIdToMid(row.eventId, Math.floor(row.timestamp), row.msSlot);
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
      ...(typeof row.msSlot === 'number' ? {msSlot: row.msSlot} : {}),
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
  for(const {timer, resolve} of pendingRecentPulls.values()) { clearTimeout(timer); resolve(); }
  pendingRecentPulls.clear();
  lastRecentPullAt.clear();
  remoteDigests.clear();
  lastRequestAt.clear();
  recentDigestSeen.clear();
  lastPublishedDigest.clear();
  lastDigestReplyAt.clear();
  lastSiblingActivityAt = 0;
  activePeerPubkey = null;
  ownPubkey = null;
  deviceId = '';
}
