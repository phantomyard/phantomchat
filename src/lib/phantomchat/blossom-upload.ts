/*
 * PhantomChat.chat — Blossom upload helper (avatar / non-progress path)
 *
 * Signs a NIP-24242 auth event with the active PhantomChat private key and
 * uploads a blob. Uses the same /blossom.json list as media upload. For
 * avatars we still take the first success (one URL is enough for kind-0);
 * media goes through blossom-upload-progress instead, which multi-mirrors.
 */

import {finalizeEvent} from 'nostr-tools/pure';
import {DEFAULT_BLOSSOM_SERVERS, getBlossomServers} from './blossom-servers';

/** @deprecated Prefer DEFAULT_BLOSSOM_SERVERS / getBlossomServers(). */
export const BLOSSOM_SERVERS = DEFAULT_BLOSSOM_SERVERS;

export interface BlossomUploadResult {
  url: string;
  sha256: string;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for(let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for(let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0');
  }
  return s;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(digest));
}

function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if(typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

export async function uploadToBlossom(
  blob: Blob,
  privkeyHex: string
): Promise<BlossomUploadResult> {
  const bytes = new Uint8Array(await blobToArrayBuffer(blob));
  const hash = await sha256Hex(bytes);

  const privkey = hexToBytes(privkeyHex);
  const expiration = Math.floor(Date.now() / 1000) + 300;

  const event = finalizeEvent({
    kind: 24242,
    created_at: Math.floor(Date.now() / 1000),
    content: 'Upload avatar',
    tags: [
      ['t', 'upload'],
      ['x', hash],
      ['expiration', expiration.toString()]
    ]
  }, privkey);

  const authHeader = 'Nostr ' + btoa(JSON.stringify(event));
  const servers = await getBlossomServers();
  const errors: string[] = [];

  for(const server of servers) {
    try {
      const res = await fetch(server + '/upload', {
        method: 'PUT',
        headers: {
          'Authorization': authHeader,
          'Content-Type': blob.type || 'application/octet-stream'
        },
        body: blob
      });

      if(!res.ok) {
        errors.push(`${server}: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json() as {url: string; sha256?: string};
      if(!data.url) {
        errors.push(`${server}: no url in response`);
        continue;
      }
      // Always return our local hash — server echo is not authoritative.
      if(data.sha256 && data.sha256.toLowerCase() !== hash) {
        console.warn(`[blossom] ${server} echoed sha256 ${data.sha256}, expected ${hash}`);
      }
      return {url: data.url, sha256: hash};
    } catch(err) {
      errors.push(`${server}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`all blossom servers failed: ${errors.join('; ')}`);
}
