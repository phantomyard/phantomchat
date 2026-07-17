/*
 * PhantomChat.chat — Blossom upload with progress + abort
 *
 * XHR-based variant used by media send (voice/image/file). Emits progress via
 * callback and supports AbortSignal. Signs one NIP-24242 auth event for the
 * blob (auth tags the content hash) and fans it out to every Blossom host in
 * parallel. A single CDN dying cannot brick the voice note; returns the
 * primary URL plus every successful mirror so the envelope can carry them.
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

// Re-export so callers/tests that read the durability constant off this
// module keep working after the sequential early-stop path went away.
export {BLOSSOM_MIRROR_MIN};

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
  /**
   * Preferred minimum successful mirrors (defaults to BLOSSOM_MIRROR_MIN).
   * With parallel fan-out we try the full list anyway; this is kept for
   * callers / docs as a durability preference signal, not an early-stop gate.
   */
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
 * Fans out PUTs in parallel (`Promise.allSettled`) so the ✓ lands at
 * max(t1, t2, …) rather than t1+t2+… — keeping the "ticks like text"
 * promise. Durability is evaluated after the fan-out: ≥1 floor still
 * required, ≥2 preferred (every fulfilled host becomes a mirror).
 *
 * Progress is pinned to the first server only so a later host can't
 * rewind the bar 0→100→0→100 on a failure/retry.
 *
 * `minMirrors` stays on the options object as a durability preference
 * signal for callers/docs. Parallel fan-out already covers the full
 * list, so it is no longer an early-stop gate.
 */
export async function uploadToBlossomWithProgress(
  blob: Blob,
  privkeyHex: string,
  options: BlossomUploadProgressOptions
): Promise<BlossomUploadProgressResult> {
  const hash = await sha256Hex(blob);
  const servers = await getBlossomServers();
  // minMirrors is retained as API/docs (`BLOSSOM_MIRROR_MIN` default).
  // Parallel fan-out already covers the full list, so it is not an
  // early-stop gate — durability is ≥1 required after settle, ≥2 preferred.
  if(options.minMirrors !== undefined && options.minMirrors < 1) {
    // Reject nonsense so a caller can't silently disable the floor.
    throw new Error('minMirrors must be ≥ 1');
  }
  if(options.signal?.aborted) throw new Error('upload aborted');

  // One auth event covers every server attempt (kind-24242 tags the hash).
  const authHeader = signAuth(privkeyHex, hash);
  const results = await Promise.allSettled(
    servers.map((server, i) =>
      putWithProgress(
        server,
        blob,
        authHeader,
        // Progress pinned to host 0 only — avoids the 0→100→0→100 rewind.
        i === 0 ? options.onProgress : undefined,
        options.signal
      )
    )
  );

  // Abort mid-fan-out must not surface a half-success; cancel killed
  // every leg via the shared signal, so treat the whole upload as aborted.
  if(options.signal?.aborted) throw new Error('upload aborted');

  const errors: string[] = [];
  const mirrors: string[] = [];
  for(let i = 0; i < results.length; i++) {
    const r = results[i];
    const server = servers[i];
    if(r.status === 'fulfilled') {
      if(!mirrors.includes(r.value.url)) mirrors.push(r.value.url);
      // Integrity hash is always our local compute. A server-echoed sha is
      // informational only — never overwrite what the receiver will verify.
      if(r.value.sha256 && r.value.sha256.toLowerCase() !== hash) {
        console.warn(
          `[blossom] ${server} echoed sha256 ${r.value.sha256}, expected ${hash}`
        );
      }
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      // Abort already handled via signal.aborted above; skip the string.
      if(options.signal?.aborted || msg === 'upload aborted') continue;
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
