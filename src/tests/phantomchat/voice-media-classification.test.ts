/**
 * Regression coverage for the "Unknown file" voice-note bug.
 *
 * A voice note recorded via opus-recorder can arrive with an empty
 * `blob.type` (→ application/octet-stream). The receiver used to re-guess
 * "voice vs file" purely from mime+duration, so the guess failed and the
 * bubble rendered as a generic "Unknown file". The fix threads an explicit
 * `mediaType` onto the wire and makes it the authoritative classifier, with
 * the legacy heuristic kept only as a fallback for pre-`mediaType` messages.
 */
import {describe, it, expect, vi} from 'vitest';
import {buildPhantomChatMedia} from '@lib/phantomchat/phantomchat-media-shape';
import {extractFileMetadata} from '@lib/phantomchat/chat-api-receive';

function baseFm(extra: any = {}) {
  return {
    url: 'https://blossom/x',
    sha256: 'a'.repeat(64),
    mimeType: 'application/octet-stream',
    size: 35000,
    keyHex: 'b'.repeat(64),
    ivHex: 'c'.repeat(32),
    ...extra
  };
}

describe('buildPhantomChatMedia voice classification', () => {
  it('classifies as voice via explicit mediaType even with octet-stream mime', () => {
    const media = buildPhantomChatMedia(1, baseFm({mediaType: 'voice', duration: 3, waveform: 'ff00'}));
    expect(media._).toBe('messageMediaDocument');
    expect(media.document.type).toBe('voice');
    const audio = media.document.attributes.find((a: any) => a._ === 'documentAttributeAudio');
    expect(audio).toBeTruthy();
    expect(audio.pFlags.voice).toBe(true);
    expect(audio.duration).toBe(3);
  });

  it('falls back to the mime+duration heuristic for pre-mediaType messages', () => {
    const media = buildPhantomChatMedia(2, baseFm({mimeType: 'audio/ogg', duration: 5}));
    expect(media.document.type).toBe('voice');
    expect(media.document.attributes.some((a: any) => a._ === 'documentAttributeAudio')).toBe(true);
  });

  it('does NOT classify octet-stream without mediaType as voice (legacy file)', () => {
    // A genuine generic file pre-dating the fix stays a plain document.
    const media = buildPhantomChatMedia(3, baseFm({duration: 0}));
    expect(media.document.type).toBeUndefined();
    expect(media.document.attributes.length).toBe(0);
  });

  it('classifies images via explicit mediaType even without dimensions', () => {
    const media = buildPhantomChatMedia(4, baseFm({mediaType: 'image', mimeType: 'application/octet-stream'}));
    expect(media._).toBe('messageMediaPhoto');
  });

  it('explicit voice mediaType wins over an image-looking mime', () => {
    // Defense-in-depth: the authoritative tag is trusted over the mime.
    const media = buildPhantomChatMedia(5, baseFm({mediaType: 'voice', mimeType: 'image/png', duration: 2}));
    expect(media._).toBe('messageMediaDocument');
    expect(media.document.type).toBe('voice');
  });

  it('decodes the base64 waveform string into packed bytes for the renderer', () => {
    // 'q80=' is base64 for [0xAB, 0xCD]. The bubble's decodeWaveform needs the
    // packed *bytes* — handed the raw string it decodes to all-zero (flat bars).
    const media = buildPhantomChatMedia(6, baseFm({mediaType: 'voice', duration: 4, waveform: 'q80='}));
    const audio = media.document.attributes.find((a: any) => a._ === 'documentAttributeAudio');
    expect(audio.waveform).toBeInstanceOf(Uint8Array);
    expect(Array.from(audio.waveform as Uint8Array)).toEqual([0xab, 0xcd]);
  });

  it('omits the waveform when absent (length-only bubble, no crash)', () => {
    const media = buildPhantomChatMedia(7, baseFm({mediaType: 'voice', duration: 4}));
    const audio = media.document.attributes.find((a: any) => a._ === 'documentAttributeAudio');
    expect(audio.waveform).toBeUndefined();
  });
});

describe('extractFileMetadata mediaType wire field', () => {
  function parse(obj: any) {
    return extractFileMetadata({content: JSON.stringify(obj)});
  }

  it('parses a valid mediaType', () => {
    const fm = parse({url: 'u', sha256: 's', key: 'k', iv: 'i', mediaType: 'voice', duration: 4});
    expect(fm?.mediaType).toBe('voice');
  });

  it('drops an unrecognised mediaType', () => {
    const fm = parse({url: 'u', sha256: 's', key: 'k', iv: 'i', mediaType: 'bogus'});
    expect(fm?.mediaType).toBeUndefined();
  });

  it('leaves mediaType undefined when absent (pre-fix message)', () => {
    const fm = parse({url: 'u', sha256: 's', key: 'k', iv: 'i', mimeType: 'audio/ogg', duration: 2});
    expect(fm?.mediaType).toBeUndefined();
    // …and the heuristic still renders it as voice.
    const media = buildPhantomChatMedia(9, fm as any);
    expect(media.document.type).toBe('voice');
  });
});

describe('end-to-end: send voice → wire → receive classifies as voice', () => {
  it('round-trips an octet-stream voice note as a voice bubble', () => {
    // Simulate the sender serialization (chat-api.sendFileMessage) for a voice
    // note whose blob.type was empty.
    const type = 'voice' as const;
    const mimeType = 'application/octet-stream';
    const effectiveMime = (type === 'voice' && (!mimeType || mimeType === 'application/octet-stream')) ?
      'audio/ogg; codecs=opus' : mimeType;
    const wire = JSON.stringify({
      url: 'https://blossom/v', sha256: 'd'.repeat(64), mimeType: effectiveMime,
      size: 35000, key: 'e'.repeat(64), iv: 'f'.repeat(32), mediaType: type,
      duration: 6, waveform: 'aabb'
    });

    const fm = extractFileMetadata({content: wire});
    expect(fm?.mediaType).toBe('voice');
    expect(fm?.mimeType).toContain('audio');

    const media = buildPhantomChatMedia(42, fm as any);
    expect(media._).toBe('messageMediaDocument');
    expect(media.document.type).toBe('voice');
    expect(media.document.attributes.some((a: any) => a._ === 'documentAttributeAudio')).toBe(true);
  });
});
