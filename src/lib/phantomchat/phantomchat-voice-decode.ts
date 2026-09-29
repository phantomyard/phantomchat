/*
 * Client-side voice-note metadata decode (#… "handle every audio format like
 * Telegram does").
 *
 * Senders used to be trusted for voice-note duration + waveform, and the
 * server-side `sendVoice` parsers only understood Ogg-Opus — so an
 * OpenAI-compatible TTS provider that serves MP3 produced envelopes with no
 * duration and no waveform, and the receiving bubble lost its bars and time
 * readout. Telegram's own clients never trusted that metadata: they decode
 * the audio locally and derive duration + amplitude bars from the actual
 * bytes. This module brings that behavior to PhantomChat.
 *
 * Pure pieces (5-bit packing, peak bucketing) are exported for tests; the
 * AudioContext-dependent decode is injectable so vitest can drive the whole
 * enrichment without a real audio stack.
 */

import type {MyDocument} from '@appManagers/appDocsManager';
import LocalStorageController from '@lib/localStorage';
import {swallowHandler} from './log-swallow';
import base64ToBytes from '@helpers/string/base64ToBytes';

/**
 * Decoded-voice metadata cache (localStorage), so a refresh never re-downloads
 * + re-decodes the same voice notes. Keyed by the stable doc id
 * (`phantomchat_<mid>`); entries carry {duration, packed waveform, timestamp}.
 *
 * Storage discipline (AGENTS.md hard rule 5 — no synchronous localStorage on
 * a render/per-message path): the map is loaded ONCE at module init (app
 * bootstrap) and every hot-path lookup after that is pure memory. Disk writes
 * are scheduled during idle time (requestIdleCallback, bounded by the debounce
 * window; plain deferred timer where idle callbacks don't exist) and land as
 * ONE coalesced write per burst through the repository storage controller —
 * plus a last-chance flush on pagehide. Never per decode, never on the render
 * path.
 */
export const VOICE_META_CACHE_KEY = 'phantomchatVoiceMeta.v1';
const VOICE_META_CACHE_MAX_ENTRIES = 2000;
export const VOICE_META_FLUSH_DEBOUNCE_MS = 500;
type VoiceMetaCacheEntry = {duration: number; waveform: string; t: number};
type VoiceMetaStorageValues = {
  [VOICE_META_CACHE_KEY]?: Record<string, VoiceMetaCacheEntry>;
};

// Repository storage controller — AGENTS.md rule 5: no raw localStorage for
// persistence. Keeps its own in-memory copy, so the idle flush is one set()
// per burst, and cleanup deletes through the same controller.
const voiceMetaStorage = new LocalStorageController<VoiceMetaStorageValues>();

let voiceMetaCache: Map<string, VoiceMetaCacheEntry> | undefined;
let voiceMetaCacheDisabled = false;
let voiceMetaFlushTimer: ReturnType<typeof setTimeout> | undefined;
let voiceMetaFlushIdleHandle: number | undefined;
let voiceMetaFlushFailures = 0;

// requestIdleCallback is missing from some lib.dom targets — declare the
// minimal shape we need instead of casting to `any` at each call site.
type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: {timeout: number}) => number;
  cancelIdleCallback?: (handle: number) => void;
};

// Boot-time load — module init runs at app startup, never inside a render.
loadVoiceMetaCache();

// Last-chance flush when the tab goes away, so a debounced write can never
// be lost to a close/refresh that lands between mutation and flush.
if(typeof addEventListener === 'function') {
  addEventListener('pagehide', () => flushVoiceMetaCache());
}

function loadVoiceMetaCache(): Map<string, VoiceMetaCacheEntry> | undefined {
  if(voiceMetaCache) return voiceMetaCache;
  if(voiceMetaCacheDisabled || typeof localStorage === 'undefined') return undefined;
  try {
    const parsed = JSON.parse(localStorage.getItem(VOICE_META_CACHE_KEY) || '{}');
    voiceMetaCache = new Map(Object.entries(parsed));
  } catch{
    voiceMetaCache = new Map();
  }
  return voiceMetaCache;
}

/**
 * Persist the in-memory cache through the storage controller. Only ever runs
 * OFF the render/decode path — from the idle-scheduled flush, the pagehide
 * last-chance flush, or explicit test/cleanup calls — and coalesces any
 * number of pending mutations into a single write.
 */
export function flushVoiceMetaCache() {
  cancelScheduledVoiceMetaFlush();
  if(voiceMetaCacheDisabled || typeof localStorage === 'undefined') return;
  const cache = voiceMetaCache;
  if(!cache) return;
  voiceMetaStorage.set({[VOICE_META_CACHE_KEY]: Object.fromEntries(cache)}).catch((err: unknown) => {
    if((err as {name?: string})?.name !== 'QuotaExceededError') {
      // Storage offline / corrupt: abandon the disk tier — the in-memory
      // cache keeps serving lookups, we just stop persisting.
      voiceMetaCacheDisabled = true;
      return;
    }

    // Quota: drop the oldest half and re-arm ONE idle flush — the smaller
    // payload is serialized later, at idle time, never re-serialized inline.
    // Repeated quota failure abandons the disk tier permanently.
    const entries = [...cache.entries()].sort((a, b) => a[1].t - b[1].t);
    for(let i = 0; i < entries.length / 2; i++) cache.delete(entries[i][0]);
    voiceMetaFlushFailures++;
    if(voiceMetaFlushFailures >= 2 || !cache.size) {
      voiceMetaCacheDisabled = true;
    } else {
      // The failed write flipped the controller's useStorage off — re-enable
      // it so the retried (smaller) flush can persist.
      voiceMetaStorage.toggleStorage(true, false);
      scheduleVoiceMetaFlush();
    }
  });
}

/** Arm the idle flush: the first mutation of a burst pays for the schedule,
 * every later one rides it — one disk write per burst, not one per decode.
 * The serialization + write run in an idle callback so a busy main thread
 * never pays for them; `timeout` bounds the wait so a continuously-busy UI
 * still flushes within the debounce window. Environments without idle
 * callbacks (older browsers, tests) fall back to a plain deferred timer. */
function scheduleVoiceMetaFlush() {
  if(voiceMetaFlushIdleHandle !== undefined || voiceMetaFlushTimer !== undefined || voiceMetaCacheDisabled) return;
  const idleWindow = typeof window === 'undefined' ? undefined : (window as IdleWindow);
  if(idleWindow?.requestIdleCallback) {
    voiceMetaFlushIdleHandle = idleWindow.requestIdleCallback(() => {
      voiceMetaFlushIdleHandle = undefined;
      flushVoiceMetaCache();
    }, {timeout: VOICE_META_FLUSH_DEBOUNCE_MS});
  } else {
    voiceMetaFlushTimer = setTimeout(() => {
      voiceMetaFlushTimer = undefined;
      flushVoiceMetaCache();
    }, VOICE_META_FLUSH_DEBOUNCE_MS);
  }
}

/** Disarm any armed flush (idle handle or fallback timer). */
function cancelScheduledVoiceMetaFlush() {
  if(voiceMetaFlushTimer !== undefined) {
    clearTimeout(voiceMetaFlushTimer);
    voiceMetaFlushTimer = undefined;
  }
  if(voiceMetaFlushIdleHandle !== undefined) {
    const idleWindow = typeof window === 'undefined' ? undefined : (window as IdleWindow);
    idleWindow?.cancelIdleCallback?.(voiceMetaFlushIdleHandle);
    voiceMetaFlushIdleHandle = undefined;
  }
}

function getCachedVoiceMeta(docId: string): DecodedVoiceMeta | undefined {
  const cache = loadVoiceMetaCache();
  const entry = cache?.get(docId);
  if(!entry) return undefined;
  try {
    const bytes = base64ToBytes(entry.waveform);
    if(!bytes?.length) return undefined;
    return {duration: entry.duration, waveform: bytes};
  } catch{
    return undefined;
  }
}

function setCachedVoiceMeta(docId: string, meta: DecodedVoiceMeta) {
  const cache = loadVoiceMetaCache();
  if(!cache) return;
  cache.set(docId, {duration: meta.duration, waveform: bytesToBase64(meta.waveform), t: Date.now()});
  if(cache.size > VOICE_META_CACHE_MAX_ENTRIES) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].t - b[1].t)[0];
    if(oldest) cache.delete(oldest[0]);
  }
  // Memory first (hot path stays pure), disk behind the debounced flush.
  scheduleVoiceMetaFlush();
}

/**
 * Test isolation: forget all module state — the in-memory decode cache,
 * session attempt sets, everything. Pass true to keep the persisted
 * localStorage entries, which is exactly what survives a page reload.
 */
export function resetVoiceMetaStateForTests(keepPersistedStorage = false) {
  cancelScheduledVoiceMetaFlush();
  voiceMetaFlushFailures = 0;
  voiceMetaCache = undefined;
  voiceMetaCacheDisabled = false;
  enrichmentInFlight.clear();
  enrichmentDone.clear();
  try {
    if(typeof localStorage !== 'undefined' && !keepPersistedStorage) {
      localStorage.removeItem(VOICE_META_CACHE_KEY);
    }
  } catch{ /* ignore */ }
}

/**
 * Drop the voice-meta cache entirely — disk, memory, and any pending flush.
 * Called by centralized cleanup (logout / Reset Local Data): a later identity
 * must never consume a stale entry whose timestamp-derived document id
 * collides, so the in-memory map dies with the data set — and a pending
 * debounced flush must not resurrect the disk key after cleanup removed it.
 */
export function clearPersistedVoiceMeta() {
  cancelScheduledVoiceMetaFlush();
  voiceMetaFlushFailures = 0;
  voiceMetaCache = undefined;
  voiceMetaCacheDisabled = false;
  // Attempt bookkeeping belongs to the wiped data set too — a later identity
  // starts with a clean slate, not the previous session's spent attempts.
  enrichmentInFlight.clear();
  enrichmentDone.clear();
  try {
    if(typeof localStorage !== 'undefined') localStorage.removeItem(VOICE_META_CACHE_KEY);
  } catch{ /* ignore */ }
  // The controller keeps its own in-memory copy — drop it too, so a same-session
  // re-login can never read a stale entry the raw removeItem above can't touch.
  voiceMetaStorage.delete(VOICE_META_CACHE_KEY).catch(swallowHandler('VoiceMetaCleanup'));
}

/** Base64 for the fm sidecar, same encoding the sender ships (media-shape). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for(let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Telegram voice waveforms carry 5-bit samples (0..31) packed LSB-first. */
export const WAVEFORM_VALUE_COUNT = 100;

/**
 * Pack amplitude values (0..31) into 5-bit LSB-first bytes — the exact
 * inverse of decodeWaveform in components/audio.ts (getUint16 little-endian,
 * shift by bit-offset, mask 0b11111).
 */
export function pack5BitWaveform(values: number[]): Uint8Array {
  const byteLength = Math.ceil(values.length * 5 / 8);
  const bytes = new Uint8Array(byteLength);
  let bitPos = 0;
  for(const value of values) {
    const v = Math.max(0, Math.min(31, Math.round(value)));
    const byteIndex = bitPos / 8 | 0;
    const bitShift = bitPos % 8;
    bytes[byteIndex] |= (v << bitShift) & 0xff;
    if(bitShift > 3) {
      bytes[byteIndex + 1] |= (v >> (8 - bitShift)) & 0xff;
    }
    bitPos += 5;
  }
  return bytes;
}

/**
 * Bucket absolute sample peaks into `count` normalized values (0..31).
 * Uses max-abs per bucket (Telegram-like amplitude envelope), normalized
 * against the loudest bucket; true silence stays at 0 (the bar renderer
 * applies its own minimum height).
 */
export function peaksToWaveformValues(
  bucketPeaks: number[],
  count = WAVEFORM_VALUE_COUNT
): number[] {
  if(!bucketPeaks.length) return [];
  const buckets: number[] = new Array(count).fill(0);
  const per = bucketPeaks.length / count;
  for(let i = 0; i < count; i++) {
    const start = Math.floor(i * per);
    const end = Math.max(start + 1, Math.floor((i + 1) * per));
    let peak = 0;
    for(let j = start; j < end && j < bucketPeaks.length; j++) {
      if(bucketPeaks[j] > peak) peak = bucketPeaks[j];
    }
    buckets[i] = peak;
  }
  const max = Math.max(...buckets);
  if(!max) return buckets.map(() => 0);
  return buckets.map((p) => Math.min(31, Math.round(p / max * 31)));
}

export interface DecodedVoiceMeta {
  /** Seconds, rounded to the nearest whole second (Telegram-style). */
  duration: number;
  /** 5-bit packed waveform bytes, ≤63 bytes so decodeWaveform sees 100 bars. */
  waveform: Uint8Array;
}

/**
 * Derive duration + waveform values from a decoded AudioBuffer-like object.
 * Accepts the structural shape only, so tests can pass a synthetic buffer.
 */
export function voiceMetaFromAudioBuffer(
  buffer: {
    duration: number;
    sampleRate: number;
    numberOfChannels?: number;
    getChannelData(channel: number): Float32Array;
  },
  count = WAVEFORM_VALUE_COUNT
): DecodedVoiceMeta | undefined {
  return voiceMetaFromChannels(
    channelsOf(buffer),
    buffer.duration,
    buffer.sampleRate,
    count
  ) as DecodedVoiceMeta | undefined;
}

/**
 * Same computation as voiceMetaFromAudioBuffer, but chunked: the per-sample
 * peak scan yields to the event loop every YIELD_SAMPLES samples so long
 * voice notes can't freeze the UI (the scan is plain JS on the main thread).
 */
export async function voiceMetaFromAudioBufferAsync(
  buffer: {
    duration: number;
    sampleRate: number;
    numberOfChannels?: number;
    getChannelData(channel: number): Float32Array;
  },
  count = WAVEFORM_VALUE_COUNT
): Promise<DecodedVoiceMeta | undefined> {
  return voiceMetaFromChannels(channelsOf(buffer), buffer.duration, buffer.sampleRate, count, true);
}

function channelsOf(buffer: {
  numberOfChannels?: number;
  getChannelData(channel: number): Float32Array;
}): Float32Array[] {
  const channelCount = Math.max(1, bufferChannelCount(buffer));
  const channels: Float32Array[] = [];
  for(let c = 0; c < channelCount; c++) channels.push(buffer.getChannelData(c));
  return channels;
}

const YIELD_SAMPLES = 1 << 19; // ~500k samples ≈ 10s of audio per chunk

function voiceMetaFromChannels(
  channels: Float32Array[],
  duration: number,
  sampleRate: number,
  count = WAVEFORM_VALUE_COUNT,
  yieldPeriodically = false
): DecodedVoiceMeta | Promise<DecodedVoiceMeta | undefined> {
  const sampleCount = duration * sampleRate;
  if(!Number.isFinite(sampleCount) || sampleCount <= 0 || !channels.length) return undefined;

  // Mono mixdown: max-abs across all channels per bucket — every sample is
  // inspected, so a signal whose period matches the bucket stride (e.g. a
  // 375 Hz tone at 24 kHz under a fixed 64-frame stride, which samples every
  // zero crossing) cannot alias away into a silent waveform.
  const left = channels[0];
  const bucketCount = Math.max(1, Math.floor(sampleCount / 64));
  const bucketPeaks: number[] = new Array(bucketCount).fill(0);
  return (yieldPeriodically ? computePeaksAsync : computePeaksSync)(
    channels, left, bucketCount, bucketPeaks, count, duration
  );
}

function computePeaksSync(
  channels: Float32Array[],
  left: Float32Array,
  bucketCount: number,
  bucketPeaks: number[],
  count: number,
  duration: number
): DecodedVoiceMeta | undefined {
  for(const data of channels) {
    scanChannelPeaks(data, left, bucketCount, bucketPeaks, 0, Math.min(data.length, left.length));
  }
  return finalizeVoiceMeta(bucketPeaks, count, duration);
}

async function computePeaksAsync(
  channels: Float32Array[],
  left: Float32Array,
  bucketCount: number,
  bucketPeaks: number[],
  count: number,
  duration: number
): Promise<DecodedVoiceMeta | undefined> {
  for(const data of channels) {
    const length = Math.min(data.length, left.length);
    for(let start = 0; start < length; start += YIELD_SAMPLES) {
      scanChannelPeaks(data, left, bucketCount, bucketPeaks, start, Math.min(start + YIELD_SAMPLES, length));
      // Hand the main thread back between chunks — a multi-minute note must
      // never freeze clicks and scrolling while it is being analyzed.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return finalizeVoiceMeta(bucketPeaks, count, duration);
}

function scanChannelPeaks(
  data: Float32Array,
  left: Float32Array,
  bucketCount: number,
  bucketPeaks: number[],
  from: number,
  to: number
) {
  const stride = bucketCount / Math.max(1, Math.min(data.length, left.length));
  for(let i = from; i < to; i++) {
    const b = Math.min(bucketCount - 1, i * stride | 0);
    const v = Math.abs(data[i] || 0);
    if(v > bucketPeaks[b]) bucketPeaks[b] = v;
  }
}

function finalizeVoiceMeta(bucketPeaks: number[], count: number, duration: number): DecodedVoiceMeta | undefined {
  if(!bucketPeaks.length) return undefined;
  return {
    duration: Math.max(1, Math.round(duration)),
    waveform: pack5BitWaveform(peaksToWaveformValues(bucketPeaks, count))
  };
}

function bufferChannelCount(buffer: {numberOfChannels?: number}): number {
  return typeof buffer.numberOfChannels === 'number' && buffer.numberOfChannels > 0 ?
    buffer.numberOfChannels :
    1;
}

/**
 * One shared AudioContext for every decode — constructing one per document
 * both leaks limited hardware contexts (browsers cap them, and past the cap
 * construction THROWS, silently killing every later decode in the session)
 * and burns main-thread setup time on refresh when many bubbles decode at once.
 */
let sharedAudioContext: AudioContext | undefined;
function getSharedAudioContext(): AudioContext | undefined {
  const ctxCtor = (window as any).AudioContext || (window as any).webkitAudioContext;
  if(!ctxCtor) return undefined;
  if(!sharedAudioContext) {
    try {
      sharedAudioContext = new ctxCtor();
    } catch{
      return undefined;
    }
  }
  return sharedAudioContext;
}

/** Decode arbitrary audio bytes (mp3/ogg/wav/…) via the Web Audio API. */
export async function decodeVoiceMetaFromBlob(blob: Blob): Promise<DecodedVoiceMeta | undefined> {
  const ctx = getSharedAudioContext();
  if(!ctx) return undefined;
  try {
    const audioData = await blob.arrayBuffer();
    const buffer: AudioBuffer = await new Promise((resolve, reject) => {
      // callback form for widest compatibility
      ctx.decodeAudioData(audioData, resolve, reject);
    });
    return await voiceMetaFromAudioBufferAsync(buffer);
  } catch{
    return undefined;
  }
}

/**
 * Enrich a PhantomChat voice document whose envelope carried no (or zero)
 * duration/waveform: download + decrypt the bytes through the normal media
 * pipeline, decode them locally, and patch the document in place so the
 * bubble renders real bars and a real length. Idempotent per document id and
 * safe to race — concurrent callers await the same enrichment.
 *
 * Returns true when the document was patched, false when there was nothing
 * to do or the decode failed (bubble keeps its current look — never worse).
 * An attempt is spent at most once per session: an attempt that ends without
 * a patch (oversized/undecodable blob) is also marked done, so a later render
 * never re-downloads + re-decodes the same bytes.
 */
const enrichmentInFlight = new Map<string, Promise<boolean>>();
const enrichmentDone = new Set<string>();
const MAX_DECODE_BYTES = 8 * 1024 * 1024;

export function enrichPhantomChatVoiceDoc(
  doc: MyDocument,
  deps: {
    download?: (doc: MyDocument) => Promise<Blob>;
    decode?: (blob: Blob) => Promise<DecodedVoiceMeta | undefined>;
  } = {}
): Promise<boolean> {
  const fm: any = (doc as any).phantomchatFileMetadata;
  const audioAttribute = doc.attributes?.find((a: any) => a._ === 'documentAttributeAudio') as any;
  const hasWaveform = !!(audioAttribute?.waveform as Uint8Array | undefined)?.length;
  const hasDuration = (doc.duration ?? 0) > 0 || (audioAttribute?.duration ?? 0) > 0;
  if(!fm?.keyHex || !fm?.url || (hasWaveform && hasDuration)) {
    return Promise.resolve(false);
  }
  if(fm.size > MAX_DECODE_BYTES) return Promise.resolve(false);

  const key = String(doc.id);
  const existing = enrichmentInFlight.get(key);
  if(existing) return existing;
  if(enrichmentDone.has(key)) return Promise.resolve(false);

  // Persisted decode → no download at all. This is what keeps a PWA refresh
  // from re-downloading + re-decoding every voice note in history at once
  // (the refresh thundering herd that froze the UI).
  const cached = getCachedVoiceMeta(key);
  if(cached) {
    patchDocWithDecodedMeta(doc, audioAttribute, cached);
    enrichmentDone.add(key);
    return Promise.resolve(true);
  }

  // Decode work is serialized globally: a history (re)load renders many
  // voice bubbles at once, and N parallel downloads + decodes in the same
  // tick is exactly the lockup. One at a time, patched as each completes.
  const promise = runQueued(async() => {
    try {
      const blob = deps.download ?
        await deps.download(doc) :
        await (await import('@lib/appDownloadManager')).default.downloadMedia({media: doc}, 'blob');
      if(!(blob instanceof Blob)) return false;
      // Trust the bytes we actually hold, not the sender-declared fm.size:
      // legacy receive paths normalize a missing size to 0 and the size
      // field is sender-controlled — enforce the cap on the real blob.
      if(blob.size > MAX_DECODE_BYTES) return false;
      const meta = deps.decode ? await deps.decode(blob) : await decodeVoiceMetaFromBlob(blob);
      if(!meta) return false;

      patchDocWithDecodedMeta(doc, audioAttribute, meta);
      setCachedVoiceMeta(key, meta);
      return true;
    } catch{
      return false;
    } finally {
      enrichmentInFlight.delete(key);
      // The attempt is spent regardless of outcome: an attempt that ends
      // without a patch (oversized/undecodable blob) must not be retried on
      // later renders — that would re-download + re-decode every time.
      enrichmentDone.add(key);
    }
  });
  enrichmentInFlight.set(key, promise);
  return promise;
}

/** Serializes decode work so concurrent renders can't stampede the CPU. */
let decodeQueue: Promise<unknown> = Promise.resolve();
function runQueued<T>(work: () => Promise<T>): Promise<T> {
  const result = decodeQueue.then(work, work);
  decodeQueue = result.then((): undefined => undefined, (): undefined => undefined);
  return result;
}

/** Patch a shared doc in place with decoded metadata (used by both the
 * cached and freshly-decoded paths so they can never drift). */
function patchDocWithDecodedMeta(
  doc: MyDocument,
  audioAttribute: any,
  meta: DecodedVoiceMeta
) {
  // Patch in place — the doc object is shared (appDocsManager cache), so
  // every surface reading it now sees real metadata, Telegram-style.
  const attribute: any = audioAttribute ?? {
    _: 'documentAttributeAudio',
    pFlags: {voice: true},
    duration: meta.duration
  };
  attribute.waveform = meta.waveform;
  if(!(attribute.duration > 0)) attribute.duration = meta.duration;
  if(!audioAttribute) doc.attributes.push(attribute);
  if(!((doc as any).duration > 0)) (doc as any).duration = meta.duration;
  // Also mirror onto the sidecar so a re-render rebuilt from fm (media
  // shape) carries the decoded metadata within this session.
  const fm: any = (doc as any).phantomchatFileMetadata;
  if(!(fm.duration > 0)) fm.duration = meta.duration;
  if(!fm.waveform) fm.waveform = bytesToBase64(meta.waveform);
}

/**
 * Rebuild helper used by the voice bubble: convert a patched document back
 * into the waveform bytes the renderer consumes (decodeWaveform's input).
 */
export function waveformBytesFromDoc(doc: MyDocument): Uint8Array | undefined {
  const attribute = doc.attributes?.find((a: any) => a._ === 'documentAttributeAudio') as any;
  const raw = attribute?.waveform;
  if(!raw) return undefined;
  if(raw instanceof Uint8Array) return raw.length ? raw : undefined;
  if(typeof raw === 'string') {
    try {
      const bytes = base64ToBytes(raw);
      return bytes.length ? bytes : undefined;
    } catch{
      return undefined;
    }
  }
  return undefined;
}
