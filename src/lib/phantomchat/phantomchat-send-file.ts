/*
 * PhantomChat.chat — P2P media send orchestrator.
 *
 * Encrypts a Blob with AES-GCM, uploads the ciphertext to Blossom via XHR
 * with progress and 3-retry backoff, then publishes a NIP-17 kind 15 rumor
 * via ChatAPI. Dispatches phantomchat_file_upload_progress / _completed / _failed
 * on the provided context. Keeps a LRU retry-map (max 20 entries) so the UI
 * can trigger manual retry on hard failure.
 *
 * Transport agnostic: the VirtualMTProtoServer wires a real SendCtx at runtime;
 * unit tests inject mocks to verify retry, abort, and dispatch behaviour.
 */

import {encryptFile} from './file-crypto';
import {uploadToBlossomWithProgress} from './blossom-upload-progress';

// Issue #111: monotonic sub-second slot counter for collision-resistant mids
// when album sends fire N file uploads in the same second. Module-level so
// it survives across the two VMT instances (main + Worker) that drive the
// same logical send pipeline.
let __sendFileMidCounter = 0;

export type PhantomChatFileType = 'image' | 'video' | 'file' | 'voice';

export interface PendingFileSend {
  peerId: number;
  tempMid: number;
  blob: Blob;
  type: PhantomChatFileType;
  caption: string;
  width?: number;
  height?: number;
  duration?: number;
  waveform?: string;
  failedAt?: number;
}

export interface SendCtx {
  ownPubkey: string;
  privkeyHex: string;
  peerPubkey: string;
  chatAPI: {
    getActivePeer(): string | null;
    connect(peerPubkey: string): Promise<void>;
    sendFileMessage(
      type: PhantomChatFileType,
      url: string,
      sha256: string,
      key: string,
      iv: string,
      mimeType: string,
      size: number,
      dim?: {width: number; height: number},
      extras?: {duration?: number; waveform?: string; mid?: number; twebPeerId?: number; timestampSec?: number; caption?: string}
    ): Promise<string>;
  };
  dispatch(name: string, payload: any): void;
  injectBubble(params: {
    peerId: number;
    tempMid: number;
    blob: Blob;
    type: PhantomChatFileType;
    caption: string;
    width?: number;
    height?: number;
    duration?: number;
    waveform?: string;
  }): Promise<void>;
  saveMessage(params: {
    peerId: number;
    mid: number;
    eventId: string;
    content: string;
    mimeType: string;
    size: number;
    url: string;
    sha256: string;
    keyHex: string;
    ivHex: string;
    width?: number;
    height?: number;
    duration?: number;
    waveform?: string;
    mediaType?: PhantomChatFileType;
  }): Promise<void>;
  log: ((...args: any[]) => void) & {warn(...args: any[]): void; error(...args: any[]): void};
}

export interface SendFileArgs {
  peerId: number;
  blob: Blob;
  type: PhantomChatFileType;
  caption: string;
  tempMid: number;
  width?: number;
  height?: number;
  duration?: number;
  waveform?: string;
  signal?: AbortSignal;
}

export interface SendResult {
  ok: boolean;
  mid?: number;
  eventId?: string;
  reason?: string;
}

const PENDING: Map<number, PendingFileSend> = new Map();
const PENDING_CAP = 20;
const FAILED_TTL_MS = 30_000;

let BACKOFF_MS: readonly number[] = [2_000, 4_000, 8_000];
/** Test hook: override the retry backoff schedule. */
export function __setRetryBackoffForTests(ms: readonly number[]): void {
  BACKOFF_MS = ms;
}
export function __resetRetryBackoffForTests(): void {
  BACKOFF_MS = [2_000, 4_000, 8_000];
}

export function getPendingFileSend(tempMid: number): PendingFileSend | undefined {
  return PENDING.get(tempMid);
}
export function getPendingFileSendCount(): number {
  return PENDING.size;
}
export function clearPendingFileSends(): void {
  PENDING.clear();
}

function addPending(entry: PendingFileSend): void {
  PENDING.set(entry.tempMid, entry);
  const now = Date.now();
  for(const [mid, p] of PENDING) {
    if(p.failedAt && now - p.failedAt > FAILED_TTL_MS) PENDING.delete(mid);
  }
  while(PENDING.size > PENDING_CAP) {
    const firstKey = PENDING.keys().next().value;
    if(firstKey === undefined) break;
    PENDING.delete(firstKey);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if(signal?.aborted) { reject(new Error('aborted')); return; }
    const t = setTimeout(() => resolve(), ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, {once: true});
  });
}

async function uploadWithRetry(
  ciphertext: Blob,
  privkeyHex: string,
  onProgress: (p: number) => void,
  signal: AbortSignal | undefined
): Promise<{url: string; sha256: string}> {
  let lastErr: unknown;
  for(let attempt = 0; attempt < 1 + BACKOFF_MS.length; attempt++) {
    if(signal?.aborted) throw new Error('upload aborted');
    try {
      const result = await uploadToBlossomWithProgress(ciphertext, privkeyHex, {onProgress, signal});
      return result;
    } catch(err) {
      lastErr = err;
      if(signal?.aborted) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if(msg === 'upload aborted') throw err;
      if(attempt < BACKOFF_MS.length) {
        await sleep(BACKOFF_MS[attempt], signal);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('upload failed');
}

export async function sendFileViaPhantomChat(
  ctx: SendCtx,
  args: SendFileArgs
): Promise<SendResult> {
  const {peerId, blob, type, caption, tempMid, signal} = args;

  addPending({
    peerId, tempMid, blob, type, caption,
    width: args.width, height: args.height,
    duration: args.duration, waveform: args.waveform
  });

  try {
    await ctx.injectBubble({
      peerId, tempMid, blob, type, caption,
      width: args.width, height: args.height,
      duration: args.duration, waveform: args.waveform
    });
  } catch(err) {
    ctx.log.warn('[sendFile] injectBubble failed:', err);
  }

  let ciphertext: Blob;
  let keyHex: string;
  let ivHex: string;
  let sha256Hex: string;
  try {
    const enc = await encryptFile(blob);
    ciphertext = enc.ciphertext;
    keyHex = enc.keyHex;
    ivHex = enc.ivHex;
    sha256Hex = enc.sha256Hex;
    // Persist the PLAINTEXT blob locally, keyed by the ciphertext sha256 that
    // travels in fileMetadata. The bubble then plays INSTANTLY from here on
    // reload / after the optimistic blob URL is gone — never waiting on (or
    // re-decrypting from) the background Blossom upload. Best-effort: a failure
    // here only costs the fast path, the send proceeds. Fire-and-forget so it
    // never adds latency to the upload.
    void (async() => {
      try {
        const {putLocalMedia} = await import('./phantomchat-local-media');
        await putLocalMedia(sha256Hex, blob);
      } catch{ /* local fast-path is best-effort */ }
    })();
  } catch(err) {
    ctx.log.error('[sendFile] encrypt failed:', err);
    ctx.dispatch('phantomchat_file_upload_failed', {peerId, mid: tempMid, error: 'encrypt failed'});
    const p = PENDING.get(tempMid); if(p) p.failedAt = Date.now();
    return {ok: false, reason: 'encrypt failed'};
  }

  let url: string;
  try {
    const result = await uploadWithRetry(
      ciphertext,
      ctx.privkeyHex,
      (percent) => ctx.dispatch('phantomchat_file_upload_progress', {peerId, mid: tempMid, percent}),
      signal
    );
    url = result.url;
  } catch(err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log.warn('[sendFile] upload failed:', msg);
    ctx.dispatch('phantomchat_file_upload_failed', {peerId, mid: tempMid, error: msg});
    const p = PENDING.get(tempMid); if(p) p.failedAt = Date.now();
    return {ok: false, reason: msg};
  }

  try {
    if(ctx.chatAPI.getActivePeer() !== ctx.peerPubkey) {
      await ctx.chatAPI.connect(ctx.peerPubkey);
    }
    // Identity-triple contract (Phase 2b.1): capture the authoritative
    // creation second ONCE, then derive the mid from it downstream. Pin
    // the same value across ChatAPI's partial save (timestampSec opt) AND
    // the subsequent authoritative save so (eventId, timestamp) is
    // identical across all writers.
    //
    // Issue #111: the previous form (`mid = timestampSec`) collided across
    // rapid-fire album sends — sendGrouped Promise.all's N file details so
    // all N items resolve `Date.now()` inside the same second, derived the
    // same mid, and the sender-side row save coalesced down to one entry
    // (visible as "1 bubble on sender, N on receiver" for a paste batch).
    // Sub-second uniqueness via the same `timestampSec * 1_000_000 + slot`
    // (slot < 1e6) shape that the canonical `mapEventIdToMid` already uses
    // for receiver mids — so file-path sender mids now live in the same
    // numeric range as the receiver's hashed mids and never collide intra-
    // second. The slot is a monotonic per-call counter; values are not
    // expected to match `mapEventIdToMid(eventId, timestampSec)` since the
    // file pipeline has always tracked sender mid locally rather than from
    // the rumor event id.
    //
    // Sub-second ORDERING (ms tiebreak): the slot's high 3 digits are now the
    // millisecond-of-second, mirroring `mapEventIdToMid`'s msSlot shape. A bare
    // counter would have produced a tiny slot (e.g. 5 → sorts as ms=000), so
    // every media send would sink BELOW the same-second text messages around it.
    // The counter survives as the low 3 digits, keeping album items minted in
    // the same millisecond unique and monotonic.
    const nowMs = Date.now();
    const timestampSec = Math.floor(nowMs / 1000);
    const counter = (__sendFileMidCounter = (__sendFileMidCounter + 1) % 1000);
    const slot = (nowMs % 1000) * 1000 + counter;
    const mid = timestampSec * 1_000_000 + slot;
    // Voice notes recorded via opus-recorder can surface with an empty
    // `blob.type` → 'application/octet-stream'. Pin a sensible audio mime so
    // the sender's own stored row (re-rendered via buildPhantomChatMedia on
    // reload/echo) classifies as voice instead of "Unknown file".
    const effectiveMime = (type === 'voice' && (!blob.type || blob.type === 'application/octet-stream')) ?
      'audio/ogg; codecs=opus' :
      (blob.type || 'application/octet-stream');
    const eventId = await ctx.chatAPI.sendFileMessage(
      type, url, sha256Hex, keyHex, ivHex,
      effectiveMime,
      blob.size,
      args.width && args.height ? {width: args.width, height: args.height} : undefined,
      {duration: args.duration, waveform: args.waveform, mid, twebPeerId: Math.abs(peerId), timestampSec, caption: args.caption}
    );

    await ctx.saveMessage({
      peerId, mid, eventId,
      content: args.caption || '',
      mimeType: effectiveMime,
      size: blob.size, url, sha256: sha256Hex,
      keyHex, ivHex,
      width: args.width, height: args.height,
      duration: args.duration, waveform: args.waveform,
      mediaType: type
    });

    // Event name kept for backward compatibility with UI listeners.
    ctx.dispatch('phantomchat_file_upload_completed', {peerId, mid: tempMid, url, realMid: mid});
    PENDING.delete(tempMid);
    return {ok: true, mid, eventId};
  } catch(err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log.error('[sendFile] sendFileMessage failed:', msg);
    ctx.dispatch('phantomchat_file_upload_failed', {peerId, mid: tempMid, error: msg});
    const p = PENDING.get(tempMid); if(p) p.failedAt = Date.now();
    return {ok: false, reason: msg};
  }
}
