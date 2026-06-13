import {verifyDetachedSignature, base64ToBytes} from './verify';
import {TRUSTED_PUBKEY_B64, TRUSTED_PUBKEY_FINGERPRINT} from './trusted-pubkey.generated';

export interface RotationSpec {
  newPubkey: string;          // base64, 32 bytes
  newFingerprint: string;     // 'ed25519:<16 hex chars>'
  crossCertSig: string;       // base64, 64 bytes — sign(newPubkey_bytes, oldPrivKey)
}

export function getBakedPubkey(): string {
  return TRUSTED_PUBKEY_B64;
}

export function getBakedFingerprint(): string {
  return TRUSTED_PUBKEY_FINGERPRINT;
}

export async function verifyCrossCert(rot: RotationSpec, expectedOldPubkeyB64: string): Promise<boolean> {
  try {
    const newPubBytes = base64ToBytes(rot.newPubkey);
    if(newPubBytes.length !== 32) return false;
    return await verifyDetachedSignature(newPubBytes, rot.crossCertSig, expectedOldPubkeyB64);
  } catch{
    return false;
  }
}

export function getEffectivePubkey(installedPubkey?: string): string {
  if(installedPubkey && installedPubkey.length > 0) return installedPubkey;
  return TRUSTED_PUBKEY_B64;
}
