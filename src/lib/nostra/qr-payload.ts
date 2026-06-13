import {decodePubkey} from './nostr-identity';

export type QRPayloadResult =
  | {npub: string}
  | {error: 'invalid' | 'unsupported' | 'self'};

/**
 * Parse a raw string from a scanned QR code into a Nostr npub.
 * Accepts `npub1…` and `nostr:npub1…` (NIP-21). Rejects hex and self.
 */
export function parseQRPayload(raw: string): QRPayloadResult {
  if(!raw) return {error: 'invalid'};

  const trimmed = raw.trim();
  const stripped = trimmed.replace(/^nostr:/i, '');

  if(/^[0-9a-f]{64}$/i.test(stripped)) {
    return {error: 'unsupported'};
  }

  if(!stripped.startsWith('npub1') || stripped.length < 60) {
    return {error: 'invalid'};
  }

  let hex: string;
  try {
    hex = decodePubkey(stripped);
  } catch(_) {
    return {error: 'invalid'};
  }

  if(!/^[0-9a-f]{64}$/i.test(hex)) {
    return {error: 'invalid'};
  }

  const ownHex = (window as any).__nostraOwnPubkey as string | undefined;
  if(ownHex && hex.toLowerCase() === ownHex.toLowerCase()) {
    return {error: 'self'};
  }

  return {npub: stripped};
}
