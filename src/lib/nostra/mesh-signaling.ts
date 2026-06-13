import {SIGNAL_KIND, SignalMessage} from '@lib/nostra/webrtc-config';

interface SignalEventInput {
  action: 'offer' | 'answer' | 'ice-candidate';
  sdp?: string;
  candidate?: RTCIceCandidateInit;
  sessionId: string;
}

/**
 * Create a Nostr event body for WebRTC signaling.
 * This is the rumor content inside a NIP-17 gift-wrap.
 */
export function createSignalEvent(input: SignalEventInput): {kind: number; content: string} {
  const signal: SignalMessage = {
    type: 'webrtc-signal',
    action: input.action,
    sessionId: input.sessionId
  };
  if(input.sdp) signal.sdp = input.sdp;
  if(input.candidate) signal.candidate = input.candidate;

  return {
    kind: SIGNAL_KIND,
    content: JSON.stringify(signal)
  };
}

/**
 * Parse signaling content from a decrypted gift-wrap.
 * Returns null if the content is not a WebRTC signal.
 */
export function parseSignalContent(content: string): SignalMessage | null {
  try {
    const parsed = JSON.parse(content);
    if(parsed.type !== 'webrtc-signal') return null;
    if(!parsed.action || !parsed.sessionId) return null;
    return parsed as SignalMessage;
  } catch{
    return null;
  }
}

/**
 * Check if a decrypted rumor kind is a signaling message.
 */
export function isSignalKind(kind: number): boolean {
  return kind === SIGNAL_KIND;
}
