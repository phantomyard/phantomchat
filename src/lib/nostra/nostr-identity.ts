import {privateKeyFromSeedWords, generateSeedWords, validateWords} from 'nostr-tools/nip06';
import {getPublicKey} from 'nostr-tools/pure';
import {npubEncode as nip19NpubEncode, nsecEncode as nip19NsecEncode, decode} from 'nostr-tools/nip19';
import {bytesToHex, hexToBytes} from 'nostr-tools/utils';

export interface NostrIdentity {
  mnemonic: string;
  privateKey: string;
  publicKey: string;
  npub: string;
  nsec: string;
}

/**
 * Generate a new Nostr identity with a random 12-word BIP-39 mnemonic.
 * Derives keypair via NIP-06 (BIP-32 path m/44'/1237'/0'/0/0).
 */
export function generateNostrIdentity(): NostrIdentity {
  const mnemonic = generateSeedWords();
  return deriveIdentity(mnemonic);
}

/**
 * Import an existing identity from a 12-word mnemonic.
 * Throws if the mnemonic is invalid.
 */
export function importFromMnemonic(mnemonic: string): NostrIdentity {
  if(!validateMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic phrase');
  }
  return deriveIdentity(mnemonic);
}

/**
 * Validate a BIP-39 mnemonic phrase.
 */
export function validateMnemonic(mnemonic: string): boolean {
  return validateWords(mnemonic);
}

/**
 * Encode a hex public key as npub (bech32).
 */
export function npubEncode(pubkeyHex: string): string {
  return nip19NpubEncode(pubkeyHex);
}

/**
 * Encode a private key (Uint8Array) as nsec (bech32).
 */
export function nsecEncode(privkeyBytes: Uint8Array): string {
  return nip19NsecEncode(privkeyBytes);
}

/**
 * Decode an npub or hex string to a hex public key.
 */
export function decodePubkey(npubOrHex: string): string {
  if(npubOrHex.startsWith('npub1')) {
    const decoded = decode(npubOrHex);
    if(decoded.type !== 'npub') {
      throw new Error('Expected npub encoding');
    }
    return decoded.data as string;
  }
  return npubOrHex;
}

function deriveIdentity(mnemonic: string): NostrIdentity {
  const privKeyBytes = privateKeyFromSeedWords(mnemonic);
  const privKeyHex = bytesToHex(privKeyBytes);
  const pubKeyHex = getPublicKey(privKeyBytes);
  return {
    mnemonic,
    privateKey: privKeyHex,
    publicKey: pubKeyHex,
    npub: nip19NpubEncode(pubKeyHex),
    nsec: nip19NsecEncode(privKeyBytes)
  };
}
