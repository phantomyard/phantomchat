/*
 * PhantomChat.chat — Receiver-side fetch + AES-GCM decrypt for Blossom media.
 *
 * Tries the primary URL first, then any mirrors carried in the envelope, then
 * hash-addressed GETs against our known Blossom server list. Verifies sha256
 * of the ciphertext when the sender provided one. In-memory cache keyed by
 * primary URL (reload still refetches — durable receive is a later step).
 */

import {decryptFile} from './file-crypto';
import {expandBlossomFetchUrls, getBlossomServers} from './blossom-servers';

const CACHE = new Map<string, Blob>();

export function clearPhantomChatFileCache(): void {
  CACHE.clear();
}

export interface FetchDecryptOpts {
  /** Ciphertext sha256 from the envelope — verified when present. */
  sha256?: string;
  /** Extra mirror URLs from the envelope (envelope.servers / mirrors). */
  mirrors?: readonly string[];
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let s = '';
  for(let i = 0; i < digest.length; i++) s += digest[i].toString(16).padStart(2, '0');
  return s;
}

export async function fetchAndDecryptPhantomChatFile(
  url: string,
  keyHex: string,
  ivHex: string,
  opts?: FetchDecryptOpts
): Promise<Blob> {
  const cached = CACHE.get(url);
  if(cached) return cached;

  const known = await getBlossomServers();
  const candidates = expandBlossomFetchUrls(url, opts?.sha256, opts?.mirrors, known);
  const errors: string[] = [];

  for(const candidate of candidates) {
    try {
      const res = await fetch(candidate);
      if(!res.ok) {
        errors.push(`${candidate}: HTTP ${res.status}`);
        continue;
      }
      const ciphertext = new Uint8Array(await res.arrayBuffer());
      if(opts?.sha256) {
        const got = await sha256Hex(ciphertext);
        if(got !== opts.sha256.toLowerCase()) {
          errors.push(`${candidate}: sha256 mismatch`);
          continue;
        }
      }
      const blob = await decryptFile(ciphertext, keyHex, ivHex);
      CACHE.set(url, blob);
      return blob;
    } catch(err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${candidate}: ${msg}`);
    }
  }

  throw new Error(`blossom fetch failed: ${errors.join('; ')}`);
}
