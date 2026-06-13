import {describe, it, expect, beforeEach, vi} from 'vitest';
import {generateDicebearAvatar, clearDicebearCache} from '@helpers/generateDicebearAvatar';

// jsdom does not implement URL.createObjectURL — provide a simple stub
let blobCounter = 0;
vi.stubGlobal('URL', {
  createObjectURL: (_blob: Blob) => `blob:mock-${++blobCounter}`,
  revokeObjectURL: (_url: string) => {}
});

describe('generateDicebearAvatar', () => {
  beforeEach(() => {
    clearDicebearCache();
  });

  it('should return a blob URL for a valid hex string', async() => {
    const hex = 'a'.repeat(64);
    const url = await generateDicebearAvatar(hex);
    expect(url).toMatch(/^blob:/);
  });

  it('should return the same URL for the same hex (cached)', async() => {
    const hex = 'b'.repeat(64);
    const url1 = await generateDicebearAvatar(hex);
    const url2 = await generateDicebearAvatar(hex);
    expect(url1).toBe(url2);
  });

  it('should return different URLs for different hex strings', async() => {
    const url1 = await generateDicebearAvatar('a'.repeat(64));
    const url2 = await generateDicebearAvatar('b'.repeat(64));
    expect(url1).not.toBe(url2);
  });

  it('should clear cache when clearDicebearCache is called', async() => {
    const hex = 'c'.repeat(64);
    const url1 = await generateDicebearAvatar(hex);
    clearDicebearCache();
    const url2 = await generateDicebearAvatar(hex);
    expect(url2).toMatch(/^blob:/);
  });
});
