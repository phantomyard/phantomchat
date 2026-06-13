/**
 * WU-4 #11 — DM image caption was dropped for the receiver.
 *
 * The 1:1 file path put only the file metadata JSON on the wire (no caption),
 * and extractFileMetadata never read one back, so a photo sent with a caption
 * arrived caption-less for the recipient. This locks the caption into the
 * fileContent contract + the extractor (group path already carried it).
 */
import {describe, it, expect} from 'vitest';
import {extractFileMetadata} from '@lib/phantomchat/chat-api-receive';

describe('DM image caption (#11)', () => {
  it('extractFileMetadata reads the caption from fileContent', () => {
    const content = JSON.stringify({
      url: 'https://blossom/x', sha256: 'a'.repeat(64), mimeType: 'image/png',
      size: 1234, width: 100, height: 80, key: 'k'.repeat(64), iv: 'i'.repeat(24),
      caption: 'hello caption'
    });

    const fm = extractFileMetadata({content});
    expect(fm).toBeDefined();
    expect(fm!.caption).toBe('hello caption');
  });

  it('leaves caption undefined when the fileContent has none', () => {
    const content = JSON.stringify({
      url: 'u', sha256: 's', mimeType: 'image/png', size: 1, key: 'k', iv: 'i'
    });

    const fm = extractFileMetadata({content});
    expect(fm).toBeDefined();
    expect(fm!.caption).toBeUndefined();
  });
});
