import {describe, it, expect, beforeEach, vi} from 'vitest';
import {
  generateDicebearAvatar,
  generatePhantomAvatarSvg,
  generatePhantomSquadAvatarSvg,
  clearDicebearCache
} from '@helpers/generateDicebearAvatar';

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

  it('should differentiate group avatars from user avatars for same seed', async() => {
    const seed = 'test-group-seed';
    const userUrl = await generateDicebearAvatar(seed, false);
    const groupUrl = await generateDicebearAvatar(seed, true);
    expect(userUrl).not.toBe(groupUrl);
  });

  it('should generate valid pure SVG markup for user and squad avatars', () => {
    const userSvg = generatePhantomAvatarSvg('user-key-123');
    expect(userSvg).toContain('<svg');
    expect(userSvg).toContain('viewBox="0 0 128 128"');
    expect(userSvg).toContain('clip-path="url(#clip-');

    const squadSvg = generatePhantomSquadAvatarSvg('group-key-456');
    expect(squadSvg).toContain('<svg');
    expect(squadSvg).toContain('viewBox="0 0 128 128"');
    expect(squadSvg).toContain('stroke-dasharray="24 10 14 10 32 10"');
  });

  it('should produce distinct, stable squad avatars per seed', () => {
    const a = generatePhantomSquadAvatarSvg('group-alpha');
    const b = generatePhantomSquadAvatarSvg('group-beta');
    expect(a).not.toBe(b);
    expect(generatePhantomSquadAvatarSvg('group-alpha')).toBe(a);
  });

  it('should return identical avatar for positive and negative peer ID seeds', async() => {
    const posSvg = generatePhantomSquadAvatarSvg('12345678');
    const negSvg = generatePhantomSquadAvatarSvg('-12345678');
    expect(posSvg).toBe(negSvg);

    const posUrl = await generateDicebearAvatar('12345678', true);
    const negUrl = await generateDicebearAvatar('-12345678', true);
    expect(posUrl).toBe(negUrl);
  });

  it('should clear cache when clearDicebearCache is called', async() => {
    const hex = 'c'.repeat(64);
    const url1 = await generateDicebearAvatar(hex);
    clearDicebearCache();
    const url2 = await generateDicebearAvatar(hex);
    expect(url2).toMatch(/^blob:/);
  });
});
