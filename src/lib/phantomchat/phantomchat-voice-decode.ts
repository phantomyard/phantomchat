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
import base64ToBytes from '@helpers/string/base64ToBytes';

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
  const sampleCount = buffer.duration * buffer.sampleRate;
  if(!Number.isFinite(sampleCount) || sampleCount <= 0) return undefined;

  // Mono mixdown: average available channels per sample position.
  const channelCount = Math.max(1, bufferChannelCount(buffer));
  const left = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(left.length / Math.max(1, Math.floor(sampleCount / 64))));
  const bucketPeaks: number[] = [];
  for(let i = 0; i < left.length; i += step) {
    let peak = 0;
    for(let c = 0; c < channelCount; c++) {
      const data = c === 0 ? left : buffer.getChannelData(c);
      const v = Math.abs(data[i] || 0);
      if(v > peak) peak = v;
    }
    bucketPeaks.push(peak);
  }
  if(!bucketPeaks.length) return undefined;

  return {
    duration: Math.max(1, Math.round(buffer.duration)),
    waveform: pack5BitWaveform(peaksToWaveformValues(bucketPeaks, count))
  };
}

function bufferChannelCount(buffer: {numberOfChannels?: number}): number {
  return typeof buffer.numberOfChannels === 'number' && buffer.numberOfChannels > 0 ?
    buffer.numberOfChannels :
    1;
}

/** Decode arbitrary audio bytes (mp3/ogg/wav/…) via the Web Audio API. */
export async function decodeVoiceMetaFromBlob(blob: Blob): Promise<DecodedVoiceMeta | undefined> {
  const ctxCtor = (window as any).AudioContext || (window as any).webkitAudioContext;
  if(!ctxCtor) return undefined;
  const ctx = new ctxCtor();
  try {
    const audioData = await blob.arrayBuffer();
    const buffer: AudioBuffer = await new Promise((resolve, reject) => {
      // callback form for widest compatibility
      ctx.decodeAudioData(audioData, resolve, reject);
    });
    return voiceMetaFromAudioBuffer(buffer);
  } catch{
    return undefined;
  } finally {
    ctx.close?.().catch?.(() => {});
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

  const promise = (async() => {
    try {
      const blob = deps.download ?
        await deps.download(doc) :
        await (await import('@lib/appDownloadManager')).default.downloadMedia({media: doc}, 'blob');
      if(!(blob instanceof Blob)) return false;
      const meta = deps.decode ? await deps.decode(blob) : await decodeVoiceMetaFromBlob(blob);
      if(!meta) return false;

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
      if(!(fm.duration > 0)) fm.duration = meta.duration;
      if(!fm.waveform) fm.waveform = bytesToBase64(meta.waveform);
      enrichmentDone.add(key);
      return true;
    } catch{
      return false;
    } finally {
      enrichmentInFlight.delete(key);
    }
  })();
  enrichmentInFlight.set(key, promise);
  return promise;
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
