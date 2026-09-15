/*
 * PhantomChat.chat — P2P delivery receipts (phantombot#542, phantomchat#140)
 *
 * WHY. A gift-wrap sent over a WebRTC data channel had no acknowledgement, so
 * neither end could tell a delivered P2P copy from a silently dropped one — and
 * therefore neither end could stop waiting on relays while "P2P locked". The
 * bot's replies to the PWA had no receipt of any kind.
 *
 * THE FRAME. The data channel already speaks the Nostr relay wire (a message is
 * `["EVENT", wrap]`), so the receipt is the relay wire's own acknowledgement:
 * `["OK", <wrap id>, true, "p2p"]`, sent back on the same channel once the wrap
 * has been handed to ingest. It means "this process received the wrap" — not a
 * read or render receipt (those stay NIP-17 delivery/read receipts).
 *
 * COMPATIBILITY. A peer that predates receipts sends none and ignores ours, so
 * the sender simply falls back to relays, exactly as before.
 */

export const P2P_OK_MESSAGE = 'p2p';

/** Longest event id accepted in an OK frame (hex ids are 64 chars). */
const MAX_OK_EVENT_ID_LEN = 128;

export interface ParsedOkFrame {
  eventId: string;
  accepted: boolean;
}

export function buildOkFrame(eventId: string): string {
  return JSON.stringify(['OK', eventId, true, P2P_OK_MESSAGE]);
}

/** Parse `["OK", id, accepted, msg?]`, or null for anything else. Never throws. */
export function parseOkFrame(raw: string): ParsedOkFrame | null {
  if(typeof raw !== 'string' || !raw.startsWith('["OK"')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch{
    return null;
  }
  if(!Array.isArray(parsed) || parsed[0] !== 'OK') return null;
  const [, eventId, accepted] = parsed;
  if(typeof eventId !== 'string' || eventId.length === 0 || eventId.length > MAX_OK_EVENT_ID_LEN) return null;
  if(typeof accepted !== 'boolean') return null;
  return {eventId, accepted};
}

export interface PeerFrameDeps {
  /** Our own pubkey (hex): only wraps addressed to us are acknowledged. */
  ownPubkey: string;
  /** Feed a wrap through the relay-pool ingest (NostrRelayPool.ingestP2PEvent). */
  ingest: (wrap: any) => Promise<void> | void;
  /** Send a raw frame to the peer on its data channel. */
  send: (pubkey: string, frame: string) => boolean;
  /** A receipt arrived from `pubkey` for a wrap we sent it. */
  onAck: (pubkey: string, eventId: string) => void;
  /**
   * A rejection (`["OK", id, false, ...]`) arrived from `pubkey` for a wrap we
   * sent it: settle the pending send immediately instead of waiting out the
   * ack window (phantomchat#142). Optional — absent means "treat as silence".
   */
  onReject?: (pubkey: string, eventId: string) => void;
  /** Hand a non-receipt frame to the mini-relay worker (pre-existing path). */
  forwardToMiniRelay: (pubkey: string, message: string) => void;
}

/**
 * Handle one inbound data-channel message. Never throws.
 *  - `["OK", id, true]`: settles our own pending send; never reaches ingest or
 *    the mini-relay (which would answer it with an "unknown command" notice).
 *  - `["EVENT", wrap]` addressed to us: ingest it, then acknowledge it.
 *  - anything else: mini-relay only, as before.
 */
export async function handlePeerFrame(pubkey: string, message: string, deps: PeerFrameDeps): Promise<void> {
  try {
    const ok = parseOkFrame(message);
    if(ok) {
      if(ok.accepted) deps.onAck(pubkey, ok.eventId);
      else deps.onReject?.(pubkey, ok.eventId);
      return;
    }

    deps.forwardToMiniRelay(pubkey, message);

    let frame: unknown;
    try {
      frame = JSON.parse(message);
    } catch{
      return;
    }
    if(!Array.isArray(frame) || frame[0] !== 'EVENT' || !frame[1]) return;
    const wrap = frame[1] as {id?: unknown; tags?: unknown};

    await deps.ingest(wrap);

    const id = wrap.id;
    if(typeof id !== 'string' || !id) return;
    const tags = Array.isArray(wrap.tags) ? wrap.tags : [];
    const toUs = !!deps.ownPubkey && tags.some((t: any) => Array.isArray(t) && t[0] === 'p' && t[1] === deps.ownPubkey);
    if(!toUs) return;
    // A receipt that can't go out means the sender silently falls back to
    // relays; record why. Wrap id prefix only — never payload (phantomchat#142).
    let sent = false;
    let reason = 'channel not open';
    try {
      sent = deps.send(pubkey, buildOkFrame(id)) === true;
    } catch(err) {
      reason = `send threw: ${(err as Error)?.message ?? String(err)}`;
    }
    if(!sent) {
      console.debug(`[P2PReceipts] could not send receipt ${id.slice(0, 8)} to ${pubkey.slice(0, 8)}: ${reason}`);
    }
  } catch(err) {
    console.debug('[P2PReceipts] handlePeerFrame failed', err);
  }
}
