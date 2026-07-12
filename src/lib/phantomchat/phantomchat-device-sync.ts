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
 * A device that hears a digest advertising more than it holds pulls the difference
 * (strict union). Reconciliation is entirely BACKGROUND: it is never awaited by the
 * UI, never gates a render, and never announces itself on screen — see the
 * "reconciliation is never a render gate" note below.
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

/** Don't issue more than one sync REQUEST per conversation inside this window (ms). */
const REQUEST_THROTTLE_MS = 6_000;

/** Rows per sync-response chunk, so a big backlog never overflows one gift-wrap. */
const RESPONSE_CHUNK_ROWS = 25;

/** Hard cap on eventIds we advertise in a have-set (bounds a huge conversation). */
const HAVE_IDS_CAP = 5_000;

/**
 * RECONCILIATION IS NEVER A RENDER GATE (Andrew's brief — supersedes the old
 * sync-before-render barrier).
 *
 * The barrier used to BLOCK an incoming bubble on a recent-only pull from a live
 * sibling. That put a network round-trip on the paint path: a lost request, a
 * sibling that never answers, a pool that isn't ready — each cost a multi-second
 * stall, and any bug in that path could swallow the bubble outright.
 *
 * The rule now: a message that arrives is PAINTED IMMEDIATELY, always. Sync runs
 * BESIDE the render, in the background, and repairs the tail after the fact
 * (ordering, gaps, media a sibling already holds). We're lucky to have received the
 * message at all — never hold it hostage to a sync.
 *
 * Proactive triggers (each SCHEDULES; none blocks, none renders):
 *   1. ALL RELAYS GREEN → FULL sync of the selected chat. Hard rule.
 *   2. CHAT SELECTED    → recent-only sync (last N).
 *   3. TYPING INDICATOR → recent-only sync (last N).
 *   4. MESSAGE RECEIVED → recent-only sync (last N).
 *
 * All of them go through `scheduleSync`, which single-flights per conversation and
 * folds a burst into one run behind a short trailing debounce — so a typing storm or
 * a flurry of inbound messages produces ONE sync, but a sync always follows the burst.
 */

/** Rows a recent-scope sync reconciles (the tail of the conversation). */
const RECENT_SYNC_ROWS = 25;

/**
 * Trailing debounce. The first trigger of a burst arms the timer; every trigger
 * inside the window folds into it. One sync per burst, fired promptly after it.
 */
const SYNC_DEBOUNCE_MS = 500;

/** Floor between two recent-scope syncs of the same conversation (ms). */
const RECENT_SYNC_FLOOR_MS = 2_000;

/**
 * Attempt schedule for a single scheduled sync. A lone request can be lost (flaky
 * socket, sibling mid-reconnect), so we re-ask on a backoff — "multiple attempts as
 * soon as a message is detected". Bails the instant a sibling answers, so the
 * healthy path still costs exactly one request.
 */
const SYNC_RETRY_BACKOFF_MS = [0, 1_500, 4_000];

/**
 * A sibling device is considered "live" if we heard ANY self-control envelope
 * (digest / sync req / sync res) authored by a DIFFERENT device within this window.
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
 *      online, and we published requests nobody could ever answer. (Under the old
 *      barrier this was far worse: every incoming message in that window hard-blocked
 *      the render for its full ceiling waiting on that phantom.)
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

/** Scope of a background sync: the whole conversation, or just its recent tail. */
export type SyncScope = 'full' | 'recent';

/** Debounced, not-yet-fired sync per conversation (the burst-coalescing window). */
const pendingSync = new Map<string, {peer: string; scope: SyncScope; reason: string; timer: ReturnType<typeof setTimeout>}>();

/** Conversations with a sync currently running — the single-flight gate. */
const inFlightSync = new Set<string>();

/** A trigger that landed while a sync was in flight; re-armed when that one ends. */
const rerunSync = new Map<string, {peer: string; scope: SyncScope; reason: string}>();

/** Per-conversation start time of our last background sync (feeds the floor). */
const lastSyncAt = new Map<string, number>();

/** Per-conversation time a sibling last ANSWERED us — lets a retry loop bail early. */
const lastSyncResponseAt = new Map<string, number>();

/** Conversations already FULL-synced this session (chat-open needn't redo one). */
const fullSyncedConvs = new Set<string>();

/**
 * A sync we WANTED to run but nobody was live to answer. Held, not dropped: the
 * moment a sibling proves it's live, it runs. This is what keeps the all-relays-green
 * hard rule honest at cold start — the pool typically goes green BEFORE we've heard a
 * peep from any sibling, and dropping the intent there would silently skip the one
 * full sync the user explicitly asked for.
 */
const deferredSync = new Map<string, {peer: string; scope: SyncScope; reason: string}>();

/** True while every relay socket in the pool is connected (drives the hard rule). */
let allRelaysGreen = false;

/**
 * Bumped by every init/destroy. A sync run captures it and abandons itself the moment
 * it changes: a retry loop can sit in a 4s backoff, and without this a teardown
 * (logout, account switch) would leave it publishing requests for a session that no
 * longer exists.
 */
let epoch = 0;

/**
 * Wall-clock of the last self-control envelope we heard from ANOTHER device.
 * Drives `hasLiveSibling()`. Only ever advanced by a FRESH envelope (see
 * CONTROL_FRESHNESS_MS); a replayed one must not fake a live sibling.
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
  epoch++;

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

  // Proactive reconcile triggers. All of them SCHEDULE background work — none of
  // them can delay, gate, or suppress a render.
  //  1. RELAY STATUS: all sockets green ⇒ FULL sync of the selected chat (hard rule).
  //  2. CHAT SELECTED: wireChatOpen above ⇒ recent-only sync.
  //  3. PEER TYPING:   the peer's tick reaches both our devices at once ⇒ recent sync.
  //  4. MESSAGE RECEIVED: phantomchat-sync calls scheduleSync ⇒ recent sync + retries.
  //  + FOREGROUND: waking a backgrounded PWA re-advertises the digest.
  wireTypingTrigger();
  wireRelayStatusTrigger();
  wireForegroundTrigger();

  // Debug surface: lets a live console (and the tests) see WHY a sync did or didn't
  // happen — which is exactly what was missing when the barrier misbehaved in prod.
  (window as any).__phantomchatDeviceSync = {
    deviceId,
    remoteDigests,
    publishActiveDigest,
    scheduleSync,
    deferredSync,
    hasLiveSibling: () => hasLiveSibling()
  };
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

  markSiblingLive(); // proof a sibling device is live (releases any deferred sync)
  remoteDigests.set(d.conv, {deviceId: d.deviceId, count: d.count, latestId: d.latestId, at: now});
  console.log(`${LOG_PREFIX} ← digest ${d.conv.slice(0, 12)}… count=${d.count} from device ${(d.deviceId || '?').slice(0, 8)}`);

  try {
    const {getMessageStore} = await import('./message-store');
    const store = getMessageStore();
    const local = await store.getConversationDigest(d.conv);

    const behind = d.count > local.count ||
      (d.count === local.count && !!d.latestId && d.latestId !== local.latestId);

    if(behind) {
      console.debug(`${LOG_PREFIX} behind on ${d.conv.slice(0, 12)}…: local=${local.count} remote=${d.count} — requesting sync`);
      // Pull the gap from the device that advertised more. Background, silent: sync
      // is never announced to the user and never blocks anything on screen.
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
 * A FRESH control envelope from another of our devices just landed — proof a sibling
 * is online. Record it, then release any sync we deferred for want of somebody to
 * ask. This is the other half of the deferral: an intent is never dropped, only held
 * until there's a device that can actually answer it.
 */
function markSiblingLive(): void {
  lastSiblingActivityAt = Date.now();
  if(deferredSync.size === 0) return;
  const held = [...deferredSync.values()];
  deferredSync.clear();
  for(const {peer, scope, reason} of held) scheduleSync(peer, scope, reason);
}

/**
 * Schedule a background reconcile of `peerPubkey`'s conversation. FIRE-AND-FORGET
 * by contract: it returns void, never a promise the caller could await, so no
 * call-site can accidentally put a sync in front of a render again.
 *
 * Coalescing: the first trigger of a burst arms a short trailing debounce and every
 * trigger inside that window folds into it — a typing storm or a run of inbound
 * messages costs ONE sync, and a sync always follows the burst. A `full` scope
 * arriving mid-burst upgrades the pending run (the hard rule always wins).
 */
export function scheduleSync(peerPubkey: string, scope: SyncScope, reason: string): void {
  if(!ownPubkey || !peerPubkey || peerPubkey === ownPubkey) return;

  void (async() => {
    let conv: string;
    try {
      const {getMessageStore} = await import('./message-store');
      conv = getMessageStore().getConversationId(ownPubkey, peerPubkey);
    } catch{
      return;
    }

    const pending = pendingSync.get(conv);
    if(pending) {
      // Fold into the armed burst. `full` outranks `recent` — never downgrade.
      if(scope === 'full') { pending.scope = 'full'; pending.reason = reason; }
      return;
    }

    const timer = setTimeout(() => {
      const entry = pendingSync.get(conv);
      pendingSync.delete(conv);
      if(!entry) return;
      void runSync(conv, entry.peer, entry.scope, entry.reason);
    }, SYNC_DEBOUNCE_MS);

    pendingSync.set(conv, {peer: peerPubkey, scope, reason, timer});
  })();
}

/**
 * Run one reconcile for `conv`. Single-flight per conversation: a trigger landing
 * mid-run is remembered and re-armed once this run finishes, rather than stacking a
 * second concurrent sync on the same conversation.
 *
 * Recent-scope runs sit behind a floor so a chatty conversation can't hammer the
 * relays. A FULL run (the all-relays-green hard rule) ignores the floor — it is the
 * one sync the user explicitly asked to always happen.
 */
async function runSync(conv: string, peer: string, scope: SyncScope, reason: string): Promise<void> {
  if(inFlightSync.has(conv)) {
    rerunSync.set(conv, {peer, scope, reason});
    return;
  }

  const startedAt = Date.now();
  if(scope === 'recent' && startedAt - (lastSyncAt.get(conv) || 0) < RECENT_SYNC_FLOOR_MS) return;

  // Advertise our own digest: the reconcile is two-way. A sibling that is BEHIND us
  // learns it from this and pulls, without us having to ask it for anything.
  void publishActiveDigest({force: true});

  // Nobody live to answer. Don't publish a request into the void (a single-device
  // user would otherwise write one to the relays on every keystroke burst) — HOLD the
  // intent instead and run it the instant a sibling pulses. See `deferredSync`.
  if(!hasLiveSibling()) {
    deferredSync.set(conv, {peer, scope, reason});
    console.debug(`${LOG_PREFIX} ${scope}-sync (${reason}) deferred — no live sibling`);
    return;
  }

  inFlightSync.add(conv);
  lastSyncAt.set(conv, startedAt);
  const myEpoch = epoch;

  try {
    for(const backoff of SYNC_RETRY_BACKOFF_MS) {
      if(backoff > 0) {
        await delay(backoff);
        // Device-sync was torn down (or re-inited) under us mid-backoff — this run
        // belongs to a session that no longer exists.
        if(epoch !== myEpoch) return;
        // A sibling already answered this run — re-asking would be pure noise.
        if((lastSyncResponseAt.get(conv) || 0) >= startedAt) break;
        // A newer trigger is already queued behind us. Stop re-asking on behalf of
        // the old one and hand over — otherwise a fresh trigger (a message that just
        // landed, relays going green) would sit behind a stale backoff for seconds.
        if(rerunSync.has(conv)) break;
      }
      const sent = await publishSyncRequest(conv, scope, reason);
      if(!sent) break; // pool isn't ready — retrying on a backoff won't change that
    }

    if(scope === 'full') fullSyncedConvs.add(conv);
  } catch(err) {
    console.debug(`${LOG_PREFIX} runSync failed:`, (err as Error)?.message);
  } finally {
    inFlightSync.delete(conv);
    const rerun = rerunSync.get(conv);
    if(rerun) {
      rerunSync.delete(conv);
      if(epoch === myEpoch) scheduleSync(rerun.peer, rerun.scope, rerun.reason);
    }
  }
}

/**
 * Broadcast one sync request for `conv`. `targetId: ''` is a BROADCAST — ANY live
 * sibling holding rows we lack can answer, so we never need to know which device
 * has them. Returns false when the pool isn't ready (so a retry loop can give up).
 */
async function publishSyncRequest(conv: string, scope: SyncScope, reason: string): Promise<boolean> {
  const pool = (window as any).__phantomchatChatAPI?.relayPool;
  if(!pool?.isConnected?.() || typeof pool.publishSyncRequest !== 'function') return false;

  try {
    const {getMessageStore} = await import('./message-store');
    const store = getMessageStore();

    let haveIds: string[];
    if(scope === 'full') {
      haveIds = await store.getConversationEventIds(conv);
      if(haveIds.length > HAVE_IDS_CAP) haveIds = haveIds.slice(-HAVE_IDS_CAP);
    } else {
      // Have-set = our most-recent N eventIds, so the sibling's diff stays bounded
      // to the recent tail rather than the whole conversation.
      const recent = await store.getMessages(conv, RECENT_SYNC_ROWS);
      haveIds = recent.map((r) => r.eventId).filter((id): id is string => typeof id === 'string');
    }

    await pool.publishSyncRequest({
      deviceId,
      targetId: '',
      conv,
      haveIds,
      ...(scope === 'recent' ? {recentOnly: true, limit: RECENT_SYNC_ROWS} : {})
    });
    console.debug(`${LOG_PREFIX} → ${scope}-sync (${reason}) ${conv.slice(0, 12)}… have=${haveIds.length}`);
    return true;
  } catch(err) {
    console.debug(`${LOG_PREFIX} publishSyncRequest failed:`, (err as Error)?.message);
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/**
 * TRIGGER 2 — a chat was SELECTED. Advertise, then reconcile its recent tail in the
 * background. If every relay is already green and this conversation hasn't had a
 * full sync yet this session, the all-relays-green hard rule applies to the chat the
 * user just selected too: give it the FULL sync rather than only the tail.
 */
async function onChatOpen(peerId: number): Promise<void> {
  const pubkey = await resolvePeerPubkey(peerId);
  activePeerPubkey = pubkey; // null for group/other — stops advertising
  if(!pubkey) return;
  console.debug(`${LOG_PREFIX} chat-open: peer ${peerId} (${pubkey.slice(0, 8)})`);
  void publishActiveDigest({force: true});

  const conv = await convFor(pubkey);
  const wantsFull = allRelaysGreen && !!conv && !fullSyncedConvs.has(conv);
  scheduleSync(pubkey, wantsFull ? 'full' : 'recent', 'chat-open');
}

/** conversationId for a peer, or null when the store isn't reachable. */
async function convFor(peerPubkey: string): Promise<string | null> {
  if(!ownPubkey) return null;
  try {
    const {getMessageStore} = await import('./message-store');
    return getMessageStore().getConversationId(ownPubkey, peerPubkey);
  } catch{
    return null;
  }
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
        // TRIGGER 3 — a typing edge (start OR stop) on the open chat. Both our
        // devices see the peer's tick at the same instant, which makes it a free
        // synchronized "compare notes now". Nudge the digest AND reconcile the tail;
        // the debounce collapses a typing storm into one sync.
        pokeDeviceSync();
        if(activePeerPubkey) scheduleSync(activePeerPubkey, 'recent', 'typing');
      });
    }).catch((err) => console.debug(`${LOG_PREFIX} typing trigger wiring failed:`, (err as Error)?.message));
  } catch(err) {
    console.debug(`${LOG_PREFIX} wireTypingTrigger failed:`, (err as Error)?.message);
  }
}

/**
 * TRIGGER 1 (the hard rule) — RELAY STATUS CHANGE. The moment every relay socket is
 * connected, FULL-sync the selected chat. All-green is the one instant we know the
 * whole pool can both carry our request and deliver a sibling's answer, so it's the
 * cheapest possible moment to buy a complete conversation.
 *
 * Edge-triggered: the pool fans out state changes on every socket transition, so we
 * only act on the not-green → green EDGE, not on every notification while green.
 * Any connectivity at all (>0) still re-advertises the digest, as before.
 */
function wireRelayStatusTrigger(): void {
  try {
    const pool = (window as any).__phantomchatChatAPI?.relayPool;
    // The pool exposes a state-change fan-out. Chain onto it without clobbering
    // existing subscribers.
    if(pool && typeof pool.addStateChangeListener === 'function') {
      pool.addStateChangeListener((connected: number, total: number) => {
        if(connected > 0) void publishActiveDigest({force: true});

        const green = total > 0 && connected >= total;
        const wasGreen = allRelaysGreen;
        allRelaysGreen = green;
        if(!green || wasGreen) return; // only the rising edge

        if(activePeerPubkey) {
          console.debug(`${LOG_PREFIX} all ${total} relay(s) green — full sync of the selected chat`);
          scheduleSync(activePeerPubkey, 'full', 'relays-green');
        }
      });
    }
  } catch(err) {
    console.debug(`${LOG_PREFIX} wireRelayStatusTrigger failed:`, (err as Error)?.message);
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
  markSiblingLive();                                // proof a sibling is live
  try {
    const pool = (window as any).__phantomchatChatAPI?.relayPool;
    if(!pool?.isConnected?.() || typeof pool.publishSyncResponse !== 'function') return;

    const {getMessageStore} = await import('./message-store');
    const store = getMessageStore();
    // For a recent-only request, only consider the last N rows so the answer stays
    // cheap; getMessages returns newest-first, so this is exactly the recent tail.
    const scanLimit = req.recentOnly ? (req.limit && req.limit > 0 ? req.limit : RECENT_SYNC_ROWS) : 100_000;
    const rows = await store.getMessages(req.conv, scanLimit);
    const have = new Set(req.haveIds);
    const missing = rows.filter((r) => r.eventId && !have.has(r.eventId));

    if(missing.length === 0) {
      console.debug(`${LOG_PREFIX} sync-request ${req.conv.slice(0, 12)}… — nothing extra to send`);
      // Still ACK, with an empty `last` chunk. Nothing is blocked on it any more, but
      // the requester retries on a backoff until somebody answers — so "I have
      // nothing for you" is exactly what stops it re-asking two more times.
      await pool.publishSyncResponse({deviceId, targetId: req.deviceId, conv: req.conv, rows: [], seq: 0, last: true});
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
  if(isFreshControl(res.sentAt)) markSiblingLive();

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
    console.debug(`${LOG_PREFIX} ← sync-response ${res.conv.slice(0, 12)}… applied ${applied} new row(s) (seq ${res.seq}${res.last ? ', last' : ''})`);
  }
  // A sibling answered us (even an empty `last` ACK is an answer). Record it so a
  // retry loop still mid-backoff stops re-asking — nothing is waiting on this, the
  // rows above are already ingested and painted.
  if(res.last) lastSyncResponseAt.set(res.conv, Date.now());
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
  epoch++; // orphan every in-flight sync run: they check this after each await
  if(pulseTimer) { clearInterval(pulseTimer); pulseTimer = null; }
  if(pokeTimer) { clearTimeout(pokeTimer); pokeTimer = null; }
  for(const {timer} of pendingSync.values()) clearTimeout(timer);
  pendingSync.clear();
  inFlightSync.clear();
  rerunSync.clear();
  lastSyncAt.clear();
  lastSyncResponseAt.clear();
  fullSyncedConvs.clear();
  deferredSync.clear();
  allRelaysGreen = false;
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
