/**
 * Tests for the client-side voice-note decode enrichment.
 *
 * Context: senders' envelopes can carry audio bytes whose duration/waveform
 * the sender-side parsers can't extract (Ogg-Opus-only parsers vs an
 * OpenAI-compatible TTS provider serving MP3). Instead of trusting the
 * envelope, the receiving client now decodes the bytes locally — Telegram
 * style — and derives real duration + amplitude bars. These tests pin the
 * pure pieces (5-bit packing must round-trip through the bubble's own
 * decodeWaveform, peak bucketing must normalize) and the doc-enrichment
 * contract (patch in place, idempotent, never throws on decode failure).
 */
import '../setup';
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {
  pack5BitWaveform,
  peaksToWaveformValues,
  voiceMetaFromAudioBuffer,
  voiceMetaFromAudioBufferAsync,
  enrichPhantomChatVoiceDoc,
  waveformBytesFromDoc,
  resetVoiceMetaStateForTests,
  flushVoiceMetaCache,
  clearPersistedVoiceMeta,
  VOICE_META_CACHE_KEY,
  VOICE_META_FLUSH_DEBOUNCE_MS,
  WAVEFORM_VALUE_COUNT
} from '@lib/phantomchat/phantomchat-voice-decode';

describe('pack5BitWaveform ↔ Telegram 5-bit decode roundtrip', () => {
  // Local copy of the consumer-side decode (components/audio.ts decodeWaveform,
  // upstream tweb): 5-bit values packed LSB-first, read via little-endian
  // getUint16. Inlined because importing the audio component graph crashes the
  // jsdom unit gate (indexedDB); the algorithm itself is upstream-stable.
  const decodeWaveform = (waveform: Uint8Array) => {
    const bitCount = waveform.length * 8;
    const valueCount = bitCount / 5 | 0;
    if(!valueCount) return new Uint8Array([]);
    const dataView = new DataView(waveform.buffer, waveform.byteOffset, waveform.byteLength);
    const result = new Uint8Array(valueCount);
    for(let i = 0; i < valueCount; i++) {
      const byteIndex = i * 5 / 8 | 0;
      const bitShift = i * 5 % 8;
      const value = dataView.getUint16(byteIndex, true);
      result[i] = (value >> bitShift) & 0b00011111;
    }
    return result;
  };

  it('packed bytes decode back to the original amplitude values', () => {
    const values = Array.from({length: WAVEFORM_VALUE_COUNT}, (_, i) =>
      // exercise the full 0..31 range
      (i * 7 + (i % 3) * 5) % 32);
    const packed = pack5BitWaveform(values);
    // Telegram consumers slice to 63 bytes before decoding (100 values max).
    expect(packed.length).toBeLessThanOrEqual(63);
    const decoded = decodeWaveform(packed.slice(0, 63));
    expect(Array.from(decoded)).toEqual(values);
  });

  it('clamps out-of-range values into 0..31', () => {
    // [-5, 40, 12] clamps to [0, 31, 12]; hand-computed LSB-first packing:
    // byte0 = 31<<5 & 0xff = 0xE0, byte1 = (31>>3) | (12<<2) = 51.
    const packed = pack5BitWaveform([-5, 40, 12]);
    expect(Array.from(packed)).toEqual([224, 51]);
  });
});

describe('peaksToWaveformValues', () => {
  it('normalizes the loudest bucket to 31 and keeps silent buckets at 0', () => {
    const peaks = new Array(200).fill(0);
    peaks[37] = 1.0;   // loudest
    peaks[100] = 0.5;  // half amplitude
    const values = peaksToWaveformValues(peaks, 100);
    expect(values.length).toBe(100);
    expect(values[18]).toBe(31);   // bucket containing index 37
    expect(values[50]).toBe(16);   // 0.5 / 1.0 → ~15.5 → 16
    expect(values[0]).toBe(0);     // silence stays 0
  });

  it('keeps genuinely silent buckets at 0 (renderer has its own height floor)', () => {
    const peaks = new Array(100).fill(0.001);
    peaks[50] = 1;
    const values = peaksToWaveformValues(peaks, 100);
    expect(values[50]).toBe(31);
    expect(values[0]).toBe(0);
  });

  it('returns an empty array for no samples', () => {
    expect(peaksToWaveformValues([], 100)).toEqual([]);
  });
});

describe('voiceMetaFromAudioBuffer', () => {
  const makeBuffer = (seconds: number, sampleRate = 8000) => {
    const length = Math.floor(seconds * sampleRate);
    const data = new Float32Array(length);
    for(let i = 0; i < length; i++) {
      data[i] = Math.sin(i / sampleRate * 2 * Math.PI * 440) * 0.8;
    }
    return {
      duration: seconds,
      sampleRate,
      numberOfChannels: 1,
      getChannelData: (channel: number) => channel === 0 ? data : new Float32Array(length)
    };
  };

  it('derives a whole-second duration and a ≤63-byte packed waveform', () => {
    const meta = voiceMetaFromAudioBuffer(makeBuffer(7.4))!;
    expect(meta.duration).toBe(7);
    expect(meta.waveform.length).toBeLessThanOrEqual(63);
    // a real sine wave must produce visible bars, not a flat line
    const max = Math.max(...Array.from(meta.waveform));
    expect(max).toBeGreaterThan(0);
  });

  it('does not alias a tone whose period matches the bucket stride', () => {
    // Regression (review blocker): the old fixed 64-frame stride sampled one
    // point per stride, so a tone whose period aligns with the stride could
    // land entirely on zero crossings and render as a silent waveform.
    const sampleRate = 8000;
    const length = 8000;
    const period = 64; // tone period matches the stride
    const data = new Float32Array(length);
    for(let i = 0; i < length; i++) {
      data[i] = Math.sin(i / period * 2 * Math.PI) * 0.8;
    }
    const meta = voiceMetaFromAudioBuffer({
      duration: 1,
      sampleRate,
      numberOfChannels: 1,
      getChannelData: () => data
    })!;
    const max = Math.max(...Array.from(meta.waveform));
    expect(max).toBeGreaterThan(20);
  });

  it('mixes stereo channels before bucketing', () => {
    const left = new Float32Array(8000).fill(0.9);
    const right = new Float32Array(8000).fill(0.1);
    const meta = voiceMetaFromAudioBuffer({
      duration: 1,
      sampleRate: 8000,
      numberOfChannels: 2,
      getChannelData: (c) => c === 0 ? left : right
    })!;
    const decodedMax = Math.max(...Array.from(meta.waveform));
    expect(decodedMax).toBeGreaterThan(20);
  });

  it('returns undefined for empty/invalid buffers', () => {
    expect(voiceMetaFromAudioBuffer({duration: 0, sampleRate: 8000, getChannelData: () => new Float32Array(0)})).toBeUndefined();
  });
});

describe('voiceMetaFromAudioBufferAsync (chunked, UI-safe scan)', () => {
  it('produces identical output to the synchronous scan across yield boundaries', async() => {
    // Longer than one YIELD_SAMPLES chunk (524288) so the async scan really
    // yields mid-analysis and must still accumulate peaks across chunks.
    const sampleRate = 48000;
    const length = sampleRate * 14; // 14s → ~1.3 chunks
    const data = new Float32Array(length);
    for(let i = 0; i < length; i++) {
      data[i] = Math.sin(i / sampleRate * 2 * Math.PI * 220) * (0.3 + 0.6 * (i % 3) / 3);
    }
    const buffer = {
      duration: 14,
      sampleRate,
      numberOfChannels: 1,
      getChannelData: () => data
    };
    const sync = voiceMetaFromAudioBuffer(buffer)!;
    const async = await voiceMetaFromAudioBufferAsync(buffer)!;
    expect(async).toBeDefined();
    expect(async.duration).toBe(sync.duration);
    expect(Array.from(async.waveform)).toEqual(Array.from(sync.waveform));
  });

  it('keeps the peak of a loud burst in the second chunk (no chunk-boundary loss)', async() => {
    const sampleRate = 48000;
    const length = 2 * (1 << 20); // > 2 chunks
    const data = new Float32Array(length);
    const burstAt = Math.floor(length * 0.75);
    for(let i = burstAt; i < burstAt + 1000; i++) data[i] = 1;
    const meta = await voiceMetaFromAudioBufferAsync({
      duration: length / sampleRate,
      sampleRate,
      numberOfChannels: 1,
      getChannelData: () => data
    });
    // decode the packed 5-bit waveform before reading amplitude values
    const packed = meta!.waveform;
    let decodedMax = 0;
    for(let i = 0; i < 100; i++) {
      const byteIndex = i * 5 / 8 | 0;
      const bitShift = i * 5 % 8;
      const value = (packed[byteIndex] | (packed[byteIndex + 1] ?? 0) << 8) >> bitShift & 0b11111;
      if(value > decodedMax) decodedMax = value;
    }
    expect(decodedMax).toBe(31);
  });

  it('returns undefined for empty/invalid buffers', async() => {
    expect(await voiceMetaFromAudioBufferAsync({duration: 0, sampleRate: 8000, getChannelData: () => new Float32Array(0)})).toBeUndefined();
  });
});

describe('enrichPhantomChatVoiceDoc', () => {
  beforeEach(() => {
    resetVoiceMetaStateForTests();
  });

  let docSeq = 0;
  const makeDoc = (extra: any = {}) => ({
    id: `phantomchat_${++docSeq}`,
    mime_type: 'audio/mpeg',
    duration: undefined,
    attributes: [{
      _: 'documentAttributeAudio',
      pFlags: {voice: true},
      duration: undefined,
      waveform: undefined
    }],
    phantomchatFileMetadata: {
      url: 'https://blossom/x',
      sha256: 'a'.repeat(64),
      keyHex: 'b'.repeat(64),
      ivHex: 'c'.repeat(32),
      size: 42000,
      mediaType: 'voice',
      mimeType: 'audio/mpeg'
    },
    ...extra
  }) as any;

  const fakeMeta = {duration: 9, waveform: new Uint8Array(63).fill(0xff)};



  it('patches the doc in place with decoded duration + waveform', async() => {
    const download = vi.fn(async() => new Blob([new Uint8Array(16)]));
    const decode = vi.fn(async(): Promise<any> => fakeMeta);
    const doc = makeDoc();
    const patched = await enrichPhantomChatVoiceDoc(doc, {download, decode});
    expect(patched).toBe(true);
    expect(doc.duration).toBe(9);
    expect(doc.attributes[0].duration).toBe(9);
    expect(doc.attributes[0].waveform).toBeInstanceOf(Uint8Array);
    // sidecar mirrors the decode so session re-renders keep the bars
    expect(doc.phantomchatFileMetadata.duration).toBe(9);
    expect(typeof doc.phantomchatFileMetadata.waveform).toBe('string');
    expect(waveformBytesFromDoc(doc)).toBeInstanceOf(Uint8Array);
  });

  it('skips docs that already carry duration + waveform', async() => {
    const download = vi.fn();
    const doc = makeDoc({
      duration: 5,
      attributes: [{_: 'documentAttributeAudio', pFlags: {voice: true}, duration: 5, waveform: new Uint8Array([7])}]
    });
    const patched = await enrichPhantomChatVoiceDoc(doc, {download});
    expect(patched).toBe(false);
    expect(download).not.toHaveBeenCalled();
  });

  it('skips docs without phantomchat file metadata', async() => {
    const download = vi.fn();
    const doc = makeDoc();
    delete doc.phantomchatFileMetadata;
    const patched = await enrichPhantomChatVoiceDoc(doc, {download});
    expect(patched).toBe(false);
  });

  it('returns false (never throws) when the decode fails', async() => {
    const doc = makeDoc();
    const patched = await enrichPhantomChatVoiceDoc(doc, {
      download: async() => new Blob([new Uint8Array(8)]),
      decode: async() => undefined
    });
    expect(patched).toBe(false);
    expect(doc.duration).toBeUndefined();
  });

  it('enriches a doc that has a waveform but no usable duration', async() => {
    // Review blocker: enrichment previously fired only when the waveform was
    // missing, so a voice doc with packed bars but no duration kept
    // doc.duration undefined (NaN-width SVG) and never self-healed.
    const doc = makeDoc({
      attributes: [{_: 'documentAttributeAudio', pFlags: {voice: true}, duration: undefined, waveform: new Uint8Array([7])}]
    });
    const patched = await enrichPhantomChatVoiceDoc(doc, {
      download: async() => new Blob([new Uint8Array(16)]),
      decode: vi.fn(async(): Promise<any> => fakeMeta)
    });
    expect(patched).toBe(true);
    expect(doc.attributes[0].duration).toBe(9);
    expect(doc.duration).toBe(9);
  });

  it('enforces the decode cap on the downloaded blob, not the sender-declared size', async() => {
    const decode = vi.fn(async(): Promise<any> => fakeMeta);
    const doc = makeDoc();
    // sender lies: declares 42 bytes, ships a 9 MB blob
    doc.phantomchatFileMetadata.size = 42;
    const patched = await enrichPhantomChatVoiceDoc(doc, {
      download: async() => new Blob([new Uint8Array(9 * 1024 * 1024)]),
      decode
    });
    expect(patched).toBe(false);
    expect(decode).not.toHaveBeenCalled();
  });

  it('a spent attempt (decode ends without a patch) is not retried', async() => {
    const download = vi.fn(async() => new Blob([new Uint8Array(8)]));
    const decode = vi.fn(async(): Promise<any> => undefined);
    const doc = makeDoc();
    await enrichPhantomChatVoiceDoc(doc, {download, decode});
    expect(await enrichPhantomChatVoiceDoc(doc, {download, decode})).toBe(false);
    expect(download).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('skips oversized media', async() => {
    const download = vi.fn();
    const doc = makeDoc();
    doc.phantomchatFileMetadata.size = 20 * 1024 * 1024;
    const patched = await enrichPhantomChatVoiceDoc(doc, {download});
    expect(patched).toBe(false);
    expect(download).not.toHaveBeenCalled();
  });

  it('coalesces concurrent enrichments of the same doc into one decode', async() => {
    let resolveDecode: (m: any) => void;
    const decode = vi.fn((): Promise<any> => new Promise((r) => { resolveDecode = r; }));
    const doc = makeDoc();
    const p1 = enrichPhantomChatVoiceDoc(doc, {download: async() => new Blob([]), decode});
    const p2 = enrichPhantomChatVoiceDoc(doc, {download: async() => new Blob([]), decode});
    // let the async body reach the decode call before releasing it
    await new Promise((r) => setTimeout(r, 0));
    resolveDecode!(fakeMeta);
    expect(await p1).toBe(true);
    expect(await p2).toBe(true);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('decodeVoiceMetaFromBlob degrades gracefully without AudioContext', async() => {
    const {decodeVoiceMetaFromBlob} = await import('@lib/phantomchat/phantomchat-voice-decode');
    const result = await decodeVoiceMetaFromBlob(new Blob([new Uint8Array(8)]));
    expect(result).toBeUndefined();
  });

  it('a cached decode patches a fresh doc object with no download at all', async() => {
    // The refresh path: history rebuild gives NEW doc objects with the same
    // stable id. The persisted decode must patch them without downloading or
    // decoding a single byte — this is what stops the refresh thundering herd.
    const download = vi.fn(async() => new Blob([new Uint8Array(16)]));
    const decode = vi.fn(async(): Promise<any> => fakeMeta);
    const doc = makeDoc();
    expect(await enrichPhantomChatVoiceDoc(doc, {download, decode})).toBe(true);
    expect(download).toHaveBeenCalledTimes(1);

    // The decode patched memory synchronously; the disk tier is idle-scheduled —
    // land the flush (the controller write resolves in microtasks) before
    // simulating the reload.
    flushVoiceMetaCache();
    await new Promise((r) => setTimeout(r, 0));
    resetVoiceMetaStateForTests(true); // simulate a page reload: session state gone, localStorage kept
    const reloadedDoc = makeDoc({id: doc.id}) as any;
    expect(reloadedDoc).not.toBe(doc);
    const download2 = vi.fn(async() => new Blob([new Uint8Array(16)]));
    const decode2 = vi.fn();
    expect(await enrichPhantomChatVoiceDoc(reloadedDoc, {download: download2, decode: decode2})).toBe(true);
    expect(download2).not.toHaveBeenCalled();
    expect(decode2).not.toHaveBeenCalled();
    expect(reloadedDoc.duration).toBe(9);
    expect(waveformBytesFromDoc(reloadedDoc)).toBeInstanceOf(Uint8Array);
    expect(waveformBytesFromDoc(reloadedDoc)!.length).toBe(fakeMeta.waveform.length);
  });

  it('decodes never touch localStorage synchronously — disk writes ride an idle-scheduled flush', async() => {
    // Kai's review blocker on #178: the hot path must stay pure memory. A
    // decode mutates the in-memory map and ARMS a flush; no localStorage
    // write may happen until the flush explicitly runs — and a whole burst
    // of decodes coalesces into ONE disk write.
    // (jsdom's localStorage getter returns a fresh wrapper per access, so an
    // instance spy sees nothing — stub the global, cleanup-suite style.)
    const store: Record<string, string> = {};
    const setItem = vi.fn((k: string, v: string) => { store[k] = v; });
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem,
      removeItem: (k: string) => { delete store[k]; }
    });
    try {
      const download = async() => new Blob([new Uint8Array(16)]);
      const decode = async(): Promise<any> => fakeMeta;
      const docA = makeDoc();
      const docB = makeDoc();
      expect(await enrichPhantomChatVoiceDoc(docA, {download, decode})).toBe(true);
      expect(await enrichPhantomChatVoiceDoc(docB, {download, decode})).toBe(true);
      expect(setItem).not.toHaveBeenCalled(); // hot path never writes synchronously
      flushVoiceMetaCache(); // the burst lands as one controller write
      await new Promise((r) => setTimeout(r, 0)); // controller write resolves in microtasks
      expect(setItem).toHaveBeenCalledTimes(1);
      const stored = JSON.parse(store[VOICE_META_CACHE_KEY]);
      expect(stored[docA.id]).toBeDefined();
      expect(stored[docB.id]).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('arms requestIdleCallback with a bounded timeout when available, not a timer', async() => {
    // Kai's blocker round 2: the flush must be IDLE-scheduled, routed through
    // LocalStorageController, with the debounce window as the idle-timeout bound.
    const idleCallbacks: Array<() => void> = [];
    let idleOptions: {timeout?: number} | undefined;
    const requestIdleCallback = vi.fn((cb: () => void, opts?: {timeout: number}) => {
      idleCallbacks.push(cb);
      idleOptions = opts;
      return idleCallbacks.length;
    });
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    vi.stubGlobal('cancelIdleCallback', cancelIdleCallback);
    const store: Record<string, string> = {};
    const setItem = vi.fn((k: string, v: string) => { store[k] = v; });
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem,
      removeItem: (k: string) => { delete store[k]; }
    });
    try {
      const doc = makeDoc();
      expect(await enrichPhantomChatVoiceDoc(doc, {
        download: async() => new Blob([new Uint8Array(16)]),
        decode: async(): Promise<any> => fakeMeta
      })).toBe(true);
      expect(requestIdleCallback).toHaveBeenCalledTimes(1);
      expect(idleOptions?.timeout).toBe(VOICE_META_FLUSH_DEBOUNCE_MS); // bounded wait
      expect(setItem).not.toHaveBeenCalled(); // arming writes nothing
      idleCallbacks[0](); // the main thread went idle
      await new Promise((r) => setTimeout(r, 0));
      expect(setItem).toHaveBeenCalledTimes(1);
      expect(JSON.parse(store[VOICE_META_CACHE_KEY])[doc.id]).toBeDefined();
      // A second burst re-arms the idle callback after the previous one fired.
      const doc2 = makeDoc();
      expect(await enrichPhantomChatVoiceDoc(doc2, {
        download: async() => new Blob([new Uint8Array(16)]),
        decode: async(): Promise<any> => fakeMeta
      })).toBe(true);
      expect(requestIdleCallback).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('quota failure evicts the oldest half and retries once at idle — never re-serializes inline', async() => {
    // The old code retried the write inline in the same tick — two full
    // serializations back to back on the main thread. Now a quota failure
    // evicts half, re-arms ONE idle flush, and a second consecutive failure
    // abandons the disk tier (memory keeps serving lookups).
    const quotaError = () => Object.assign(new Error('quota'), {name: 'QuotaExceededError'});
    const setItem = vi.fn((_k: string, _v: string): never => { throw quotaError(); });
    vi.stubGlobal('requestIdleCallback', undefined); // force the deferred-timer fallback
    vi.stubGlobal('cancelIdleCallback', undefined);
    vi.stubGlobal('localStorage', {
      getItem: (): string | null => null,
      setItem,
      removeItem: () => {}
    });
    try {
      const download = async() => new Blob([new Uint8Array(16)]);
      const decode = async(): Promise<any> => fakeMeta;
      const docA = makeDoc();
      const docB = makeDoc();
      expect(await enrichPhantomChatVoiceDoc(docA, {download, decode})).toBe(true);
      expect(await enrichPhantomChatVoiceDoc(docB, {download, decode})).toBe(true);
      flushVoiceMetaCache(); // attempt 1
      await new Promise((r) => setTimeout(r, 0));
      expect(setItem).toHaveBeenCalledTimes(1);
      // The retry rides the re-armed schedule (jsdom has no requestIdleCallback → timer)
      await new Promise((r) => setTimeout(r, VOICE_META_FLUSH_DEBOUNCE_MS + 20));
      expect(setItem).toHaveBeenCalledTimes(2); // exactly one retry, deferred
      const retriedPayload = JSON.parse(setItem.mock.calls[1][1] as string);
      expect(Object.keys(retriedPayload)).toEqual([docB.id]); // oldest half evicted
      // Second consecutive quota failure → disk tier abandoned for good.
      flushVoiceMetaCache();
      await new Promise((r) => setTimeout(r, 0));
      expect(setItem).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('clearPersistedVoiceMeta drops memory + disk + any pending flush', async() => {
    // The cleanup contract (logout / Reset Local Data): after clearing, a
    // fresh doc with the same id must download again — no stale entry served
    // from memory, nothing on disk, and the armed flush cannot resurrect it.
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; }
    });
    try {
      const doc = makeDoc();
      expect(await enrichPhantomChatVoiceDoc(doc, {
        download: async() => new Blob([new Uint8Array(16)]),
        decode: async(): Promise<any> => fakeMeta
      })).toBe(true);
      clearPersistedVoiceMeta();
      expect(store[VOICE_META_CACHE_KEY]).toBeUndefined();
      // pending flush was cancelled, not resurrected:
      await new Promise((r) => setTimeout(r, VOICE_META_FLUSH_DEBOUNCE_MS + 10));
      expect(store[VOICE_META_CACHE_KEY]).toBeUndefined();
      // memory + attempt state gone: the same id re-decodes from scratch
      const reDoc = makeDoc({id: doc.id}) as any;
      const download = vi.fn(async() => new Blob([new Uint8Array(16)]));
      expect(await enrichPhantomChatVoiceDoc(reDoc, {download, decode: async(): Promise<any> => fakeMeta})).toBe(true);
      expect(download).toHaveBeenCalledTimes(1); // cache gone → real decode again
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a corrupted cache entry falls back to a real decode, never throws', async() => {
    const doc = makeDoc();
    localStorage.setItem('phantomchatVoiceMeta.v1', JSON.stringify({[doc.id]: {duration: 3, waveform: '!!!not-base64!!!', t: 1}}));
    const decode = vi.fn(async(): Promise<any> => fakeMeta);
    const patched = await enrichPhantomChatVoiceDoc(doc, {
      download: async() => new Blob([new Uint8Array(16)]),
      decode
    });
    expect(patched).toBe(true);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('serializes decodes: a second doc does not download while the first is in flight', async() => {
    // The refresh lockup: N bubbles enriched in one tick used to fire N
    // parallel download+decode jobs. The queue must run them one at a time.
    let resolveA: (m: any) => void;
    const decodeA = vi.fn((): Promise<any> => new Promise((r) => { resolveA = r; }));
    const downloadB = vi.fn(async() => new Blob([new Uint8Array(16)]));
    const docA = makeDoc();
    const docB = makeDoc();

    const pA = enrichPhantomChatVoiceDoc(docA, {download: async() => new Blob([new Uint8Array(8)]), decode: decodeA});
    const pB = enrichPhantomChatVoiceDoc(docB, {download: downloadB, decode: async(): Promise<any> => fakeMeta});
    // let queued work start and the event loop settle
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(downloadB).not.toHaveBeenCalled(); // B waits behind A

    resolveA!(fakeMeta);
    expect(await pA).toBe(true);
    expect(await pB).toBe(true);
    expect(downloadB).toHaveBeenCalledTimes(1);
  });
});
