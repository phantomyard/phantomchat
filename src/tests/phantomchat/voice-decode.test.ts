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
  enrichPhantomChatVoiceDoc,
  waveformBytesFromDoc,
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

describe('enrichPhantomChatVoiceDoc', () => {
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
});
