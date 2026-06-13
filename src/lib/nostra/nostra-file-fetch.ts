/*
 * Nostra.chat — Receiver-side fetch + AES-GCM decrypt for Blossom media.
 *
 * In-memory cache per URL. Reloads refetch. The decrypted Blob is used to
 * produce a blob: URL for image/audio rendering inside bubbles.
 */

import {decryptFile} from './file-crypto';

const CACHE = new Map<string, Blob>();

export function clearNostraFileCache(): void {
  CACHE.clear();
}

export async function fetchAndDecryptNostraFile(
  url: string,
  keyHex: string,
  ivHex: string
): Promise<Blob> {
  const cached = CACHE.get(url);
  if(cached) return cached;

  const res = await fetch(url);
  if(!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  const ciphertext = new Uint8Array(await res.arrayBuffer());

  const blob = await decryptFile(ciphertext, keyHex, ivHex);
  CACHE.set(url, blob);
  return blob;
}
