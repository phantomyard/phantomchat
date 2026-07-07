import {SIGNAL_KIND, SignalMessage} from '@lib/phantomchat/webrtc-config';

/**
 * WebRTC signaling encode/decode — wire-compatible with phantombot's node
 * (src/p2p/signaling.ts). A signal is JSON-serialized into the NIP-44-encrypted
 * content of a kind-21050 ephemeral event (see SIGNAL_KIND). The NIP-44 crypto
 * and the Nostr publish/subscribe happen in ChatAPI (which owns the keys); this
 * module is the pure, unit-testable schema seam.
 *
 * Was a gift-wrap-rumor scheme ({type:'webrtc-signal', action, sessionId}) that
 * no node spoke. Now the `{t}` schema the node encodes/decodes verbatim.
 */

/** Structural guard for a decoded signal payload. Mirrors the node's guard. */
export function isSignalMessage(value: unknown): value is SignalMessage {
  if(!value || typeof value !== 'object') return false;
  const t = (value as {t?: unknown}).t;
  if(t === 'offer' || t === 'answer') return typeof (value as {sdp?: unknown}).sdp === 'string';
  if(t === 'candidate') return typeof (value as {candidate?: unknown}).candidate === 'string';
  if(t === 'hello' || t === 'bye') return true;
  return false;
}

/**
 * Serialize a signal to the plaintext that gets NIP-44-encrypted into the
 * kind-21050 event content.
 */
export function encodeSignalPayload(msg: SignalMessage): string {
  return JSON.stringify(msg);
}

/**
 * Parse a decrypted kind-21050 signal payload. Returns null if it is not a
 * valid signal (bad JSON, wrong shape). Never throws.
 */
export function decodeSignalPayload(plaintext: string): SignalMessage | null {
  try {
    const parsed = JSON.parse(plaintext) as unknown;
    return isSignalMessage(parsed) ? parsed : null;
  } catch{
    return null;
  }
}

/** Is this Nostr kind a WebRTC signaling event? */
export function isSignalKind(kind: number): boolean {
  return kind === SIGNAL_KIND;
}
