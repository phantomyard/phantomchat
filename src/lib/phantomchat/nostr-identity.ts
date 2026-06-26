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
 * Import an existing identity from a raw Nostr private key — an `nsec1…`
 * (NIP-19) or a 64-char hex secret. Used to adopt a key created in another
 * Nostr client (e.g. 0xchat) so both apps drive the same npub.
 *
 * A raw key has no BIP-39 mnemonic (you can't derive the seed words back from
 * a private key), so `mnemonic` is empty — the account simply has no recovery
 * phrase; its backup IS the nsec. Throws on malformed input.
 */
export function importFromNsec(nsecOrHex: string): NostrIdentity {
  const trimmed = nsecOrHex.trim();
  let privKeyBytes: Uint8Array;
  if(trimmed.startsWith('nsec1')) {
    const decoded = decode(trimmed);
    if(decoded.type !== 'nsec') {
      throw new Error('Expected an nsec key');
    }
    privKeyBytes = decoded.data as Uint8Array;
  } else if(/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    privKeyBytes = hexToBytes(trimmed);
  } else {
    throw new Error('Invalid private key — expected nsec1… or 64-char hex');
  }

  const pubKeyHex = getPublicKey(privKeyBytes);
  return {
    mnemonic: '',
    privateKey: bytesToHex(privKeyBytes),
    publicKey: pubKeyHex,
    npub: nip19NpubEncode(pubKeyHex),
    nsec: nip19NsecEncode(privKeyBytes)
  };
}

/**
 * Reconstruct an identity from the material key-storage persisted.
 *
 * Accounts generated in-app keep a BIP-39 `seed` (mnemonic); accounts adopted
 * from another Nostr client via `nsec` have an empty `seed` and only a raw
 * `nsec`. Prefer the mnemonic route only when a non-empty seed is present,
 * otherwise fall back to the nsec route. This is the single entry point every
 * caller that loads `{seed, nsec}` from storage should use — calling
 * `importFromMnemonic` directly breaks nsec-imported accounts, since
 * `validateMnemonic('')` throws "Invalid mnemonic phrase".
 */
export function importFromStored(stored: {seed?: string; nsec?: string}): NostrIdentity {
  const seed = stored.seed?.trim();
  if(seed) {
    return importFromMnemonic(seed);
  }
  if(stored.nsec?.trim()) {
    return importFromNsec(stored.nsec);
  }
  throw new Error('No stored identity material — expected a seed or nsec');
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
