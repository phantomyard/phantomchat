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

  // Route inbound digests from our other devices to onRemoteDigest.
  try {
    const pool = (window as any).__phantomchatChatAPI?.relayPool;
    if(pool?.setOnDigest) {
      pool.setOnDigest((d: {deviceId: string; conv: string; count: number; latestId: string}) => onRemoteDigest(d));
    }
  } catch(err) {
    console.debug(`${LOG_PREFIX} setOnDigest wiring failed:`, (err as Error)?.message);
  }

  // Re-advertise the open chat's digest on a heartbeat so a device that connects
  // late catches the next beat (the whole point of a pulse over a one-shot).
  pulseTimer = setInterval(() => void publishActiveDigest(), PULSE_INTERVAL_MS);

  // Advertise (and switch scope) whenever a chat opens.
  await wireChatOpen();

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
      console.log(`${LOG_PREFIX} behind on ${d.conv.slice(0, 12)}…: local=${local.count} remote=${d.count} — indicating`);
      showSyncingIndicator();
      // Increment 2: request the missing message ids from the fuller device here.
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

/** Clean up on page unload. */
export function destroyDeviceSync(): void {
  if(pulseTimer) { clearInterval(pulseTimer); pulseTimer = null; }
  if(pokeTimer) { clearTimeout(pokeTimer); pokeTimer = null; }
  remoteDigests.clear();
  activePeerPubkey = null;
  ownPubkey = null;
  deviceId = '';
}
