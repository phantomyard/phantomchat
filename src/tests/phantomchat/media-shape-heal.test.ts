/**
 * Tests for healStoredFileRow — the render-time heal for stored file rows
 * that lost their nested `fileMetadata` (the #105 queue-flush regression and
 * the interrupted durable-write-first case). The row's `content` still holds
 * the raw file envelope ChatAPI.sendFileMessage built, so the media is fully
 * recoverable.
 */

import '../setup';
import {describe, it, expect} from 'vitest';
import {healStoredFileRow, buildPhantomChatMedia} from '../../lib/phantomchat/phantomchat-media-shape';

/** The exact envelope shape ChatAPI.sendFileMessage serializes into content. */
function makeEnvelope(overrides: Record<string, any> = {}): string {
  return JSON.stringify({
    url: 'https://nostr.download/67f8.bin',
    sha256: '67f8f9ad',
    mimeType: 'audio/ogg; codecs=opus',
    size: 25403,
    key: 'be5a71d6',
    iv: 'de1d5379',
    mediaType: 'voice',
    servers: ['https://nostr.download/67f8.bin', 'https://blossom.ditto.pub/67f8.bin'],
    duration: 4,
    waveform: 'AAAA',
    ...overrides
  });
}

describe('healStoredFileRow', () => {
  it('returns undefined for a healthy row with fileMetadata', () => {
    const fm = {url: 'u', sha256: 's', mimeType: 'audio/ogg', size: 1, keyHex: 'k', ivHex: 'i'};
    expect(healStoredFileRow({type: 'file', content: '', fileMetadata: fm})).toBeUndefined();
  });

  it('returns undefined for text rows and non-JSON content', () => {
    expect(healStoredFileRow({type: 'text', content: makeEnvelope()})).toBeUndefined();
    expect(healStoredFileRow({type: 'file', content: 'hello world'})).toBeUndefined();
    expect(healStoredFileRow({type: 'file', content: ''})).toBeUndefined();
    expect(healStoredFileRow({type: 'file'})).toBeUndefined();
  });

  it('returns undefined for JSON that is not a file envelope', () => {
    expect(healStoredFileRow({type: 'file', content: '{"foo":"bar"}'})).toBeUndefined();
    // Missing key/iv — cannot decrypt, no point rendering media
    expect(healStoredFileRow({type: 'file', content: '{"url":"u","sha256":"s"}'})).toBeUndefined();
  });

  it('recovers fileMetadata from a raw envelope row (the #105 bubble)', () => {
    const healed = healStoredFileRow({type: 'file', content: makeEnvelope()});

    expect(healed).toBeDefined();
    expect(healed!.caption).toBe('');
    expect(healed!.fileMetadata).toMatchObject({
      url: 'https://nostr.download/67f8.bin',
      sha256: '67f8f9ad',
      mimeType: 'audio/ogg; codecs=opus',
      size: 25403,
      keyHex: 'be5a71d6', // wire `key` → keyHex
      ivHex: 'de1d5379', // wire `iv` → ivHex
      duration: 4,
      waveform: 'AAAA',
      mediaType: 'voice',
      servers: ['https://nostr.download/67f8.bin', 'https://blossom.ditto.pub/67f8.bin']
    });
  });

  it('recovers the caption as the bubble text', () => {
    const healed = healStoredFileRow({type: 'file', content: makeEnvelope({caption: 'check this out'})});
    expect(healed!.caption).toBe('check this out');
  });

  it('converts a byte-array waveform to base64 so amplitude bars survive', () => {
    const healed = healStoredFileRow({type: 'file', content: makeEnvelope({waveform: [0, 4, 240, 255, 191]})});
    expect(typeof healed!.fileMetadata.waveform).toBe('string');
    // Round-trip: btoa(String.fromCharCode(...bytes)) — 0,4,240,255,191
    expect(healed!.fileMetadata.waveform).toBe(btoa(String.fromCharCode(0, 4, 240, 255, 191)));
  });

  it('healed metadata builds a voice media bubble end-to-end', () => {
    const healed = healStoredFileRow({type: 'file', content: makeEnvelope()})!;
    const media = buildPhantomChatMedia(999000000001, healed.fileMetadata);

    expect(media._).toBe('messageMediaDocument');
    expect(media.document.type).toBe('voice');
    const audioAttr = media.document.attributes.find((a: any) => a._ === 'documentAttributeAudio');
    expect(audioAttr).toBeDefined();
    expect(audioAttr.pFlags.voice).toBe(true);
    expect(audioAttr.duration).toBe(4);
  });

  it('defaults missing optional fields sensibly', () => {
    const minimal = JSON.stringify({url: 'u', sha256: 's', key: 'k', iv: 'i'});
    const healed = healStoredFileRow({type: 'file', content: minimal})!;

    expect(healed.fileMetadata.mimeType).toBe('application/octet-stream');
    expect(healed.fileMetadata.size).toBe(0);
    expect(healed.fileMetadata.duration).toBeUndefined();
    expect(healed.fileMetadata.waveform).toBeUndefined();
    expect((healed.fileMetadata as any).servers).toBeUndefined();
  });
});
