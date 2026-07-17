/*
 * PhantomChat.chat — Blossom upload with progress + abort
 *
 * XHR-based variant used by media send (voice/image/file). Emits progress via
 * callback and supports AbortSignal. Signs a fresh NIP-24242 auth event per
 * server attempt. Uploads to multiple Blossom servers so a single CDN dying
 * cannot brick the voice note; returns the primary URL plus every successful
 * mirror so the envelope can carry them.
 *
 * Server list comes from /blossom.json (see blossom-servers.ts).
 */

import {finalizeEvent} from 'nostr-tools/pure';
import {logSwallow} from './log-swallow';
import {
  BLOSSOM_MIRROR_MIN,
  DEFAULT_BLOSSOM_SERVERS,
  getBlossomServers
} from './blossom-servers';

/** @deprecated Prefer getBlossomServers() / DEFAULT_BLOSSOM_SERVERS. Kept for tests. */
export const BLOSSOM_SERVERS = DEFAULT_BLOSSOM_SERVERS;

export interface BlossomUploadProgressResult {
  /** Primary URL — first successful PUT. Goes in envelope.url. */
  url: string;
  /** sha256 of the ciphertext (from us; server may echo it). */
  sha256: string;
  /** Every successful URL including primary. Recipient tries these in order. */
  mirrors: string[];
}

export interface BlossomUploadProgressOptions {
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
  /** Min successful mirrors before we stop (defaults to BLOSSOM_MIRROR_MIN). */
  minMirrors?: number;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for(let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function sha256Hex(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let s = '';
  for(let i = 0; i < digest.length; i++) s += digest[i].toString(16).padStart(2, '0');
  return s;
}

function signAuth(privkeyHex: string, hash: string): string {
  const privkey = hexToBytes(privkeyHex);
  const expiration = Math.floor(Date.now() / 1000) + 300;
  const event = finalizeEvent({
    kind: 24242,
    created_at: Math.floor(Date.now() / 1000),
    content: 'Upload media',
    tags: [
      ['t', 'upload'],
      ['x', hash],
      ['expiration', expiration.toString()]
    ]
  }, privkey);
  return 'Nostr ' + btoa(JSON.stringify(event));
}

function putWithProgress(
  server: string,
  blob: Blob,
  authHeader: string,
  onProgress: ((p: number) => void) | undefined,
  signal: AbortSignal | undefined
): Promise<{url: string; sha256: string}> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    const onAbort = () => {
      try { xhr.abort(); } catch(e) { logSwallow('BlossomUpload.abort', e); }
      reject(new Error('upload aborted'));
    };

    if(signal) {
      if(signal.aborted) {
        reject(new Error('upload aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, {once: true});
    }

    xhr.upload.onprogress = (e: any) => {
      if(!e.lengthComputable || !onProgress) return;
      const p = Math.max(0, Math.min(100, Math.floor((e.loaded / e.total) * 100)));
      onProgress(p);
    };

    xhr.onload = () => {
      signal?.removeEventListener('abort', onAbort);
      if(xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`${server}: HTTP ${xhr.status}`));
        return;
      }
      try {
        const data = JSON.parse(xhr.responseText);
        if(!data.url) {
          reject(new Error(`${server}: no url in response`));
          return;
        }
        resolve({url: data.url, sha256: data.sha256 || ''});
      } catch{
        reject(new Error(`${server}: invalid JSON`));
      }
    };

    xhr.onerror = () => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`${server}: network error`));
    };

    xhr.open('PUT', server + '/upload');
    xhr.setRequestHeader('Authorization', authHeader);
    xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
    xhr.send(blob);
  });
}

/**
 * Upload ciphertext to Blossom.
 *
 * Tries servers in order. Collects successful URLs until `minMirrors` is
 * reached (or the list is exhausted). Needs at least one success; prefers
 * ≥2 so the note survives a single CDN outage.
 *
 * Progress is reported from the first attempt only (later mirrors burn silent
 * bandwidth — user already saw 100%).
 */
export async function uploadToBlossomWithProgress(
  blob: Blob,
  privkeyHex: string,
  options: BlossomUploadProgressOptions
): Promise<BlossomUploadProgressResult> {
  const hash = await sha256Hex(blob);
  const servers = await getBlossomServers();
  const minMirrors = Math.max(1, options.minMirrors ?? BLOSSOM_MIRROR_MIN);
  const errors: string[] = [];
  const mirrors: string[] = [];

  for(const server of servers) {
    if(options.signal?.aborted) throw new Error('upload aborted');
    // Stop once we have enough mirrors.
    if(mirrors.length >= minMirrors) break;

    const authHeader = signAuth(privkeyHex, hash);
    // Progress only while still looking for the first success.
    const onProgress = mirrors.length === 0 ? options.onProgress : undefined;
    try {
      const result = await putWithProgress(server, blob, authHeader, onProgress, options.signal);
      if(!mirrors.includes(result.url)) mirrors.push(result.url);
      // Integrity hash is always our local compute. A server-echoed sha is
      // informational only — never overwrite what the receiver will verify.
      if(result.sha256 && result.sha256.toLowerCase() !== hash) {
        console.warn(
          `[blossom] ${server} echoed sha256 ${result.sha256}, expected ${hash}`
        );
      }
    } catch(err) {
      const msg = err instanceof Error ? err.message : String(err);
      if(msg === 'upload aborted') throw err;
      errors.push(msg);
    }
  }

  if(mirrors.length === 0) {
    throw new Error(`all blossom servers failed: ${errors.join('; ')}`);
  }

  return {
    url: mirrors[0],
    sha256: hash,
    mirrors
  };
}
