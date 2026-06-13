import * as ed from '@noble/ed25519';
import {sha512} from '@noble/hashes/sha2.js';

// @noble/ed25519 v3 requires sha512 to be configured for sync paths (signAsync/verifyAsync internally)
ed.hashes.sha512 = sha512;

export function bytesToBase64(buf: Uint8Array): string {
  let s = '';
  for(const b of buf) s += String.fromCharCode(b);
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for(let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function verifyDetachedSignature(
  message: Uint8Array,
  signatureB64: string,
  pubkeyB64: string
): Promise<boolean> {
  try {
    const sig = base64ToBytes(signatureB64);
    const pub = base64ToBytes(pubkeyB64);
    if(sig.length !== 64 || pub.length !== 32) return false;
    return await ed.verifyAsync(sig, message, pub);
  } catch{
    return false;
  }
}

export function fingerprintPubkey(pubkeyB64: string): string {
  try {
    const bytes = base64ToBytes(pubkeyB64);
    let hex = '';
    for(const b of bytes) hex += b.toString(16).padStart(2, '0');
    return 'ed25519:' + hex.slice(0, 16);
  } catch{
    return 'ed25519:invalid';
  }
}
