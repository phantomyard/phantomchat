import {createHash} from 'node:crypto';
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
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

  describe('UI theme palettes (#317)', () => {
    const setTheme = (value?: string) => {
      if(value) document.documentElement.setAttribute('data-ui-theme', value);
      else document.documentElement.removeAttribute('data-ui-theme');
    };
    // Only neutral greys, or a grey with an alpha suffix (r == g == b within the zinc tint).
    const isGrey = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return Math.max(r, g, b) - Math.min(r, g, b) <= 14;
    };
    const colours = (svg: string) => [...new Set(svg.match(/#[0-9a-f]{6}(?:[0-9a-f]{2})?\b/gi))];
    const seeds = Array.from({length: 200}, (_, i) => `seed-${i}`);

    afterEach(() => setTheme());

    it('leaves Fun and Relaxed byte-identical to the pre-theme generator', () => {
      setTheme();
      // Digest of the generator before this feature existed, wide enough to reach every palette entry.
      const digest = createHash('sha256');
      for(let i = 0; i < 500; i++) {
        digest.update(generatePhantomAvatarSvg(`seed-${i}`));
        digest.update(generatePhantomSquadAvatarSvg(`seed-${i}`));
      }
      expect(digest.digest('hex')).toBe('016d88c62ff82d9b7c4687f602249074f90a6b16be83345f543160a727ae1041');
    });

    it('treats an unknown theme as Fun and Relaxed', () => {
      setTheme();
      const fun = generatePhantomAvatarSvg('seed');
      setTheme('neon-disco');
      expect(generatePhantomAvatarSvg('seed')).toBe(fun);
    });

    it('draws Boring Corporate in muted greys with blue eyes and no glow', () => {
      setTheme('boring-corporate');
      for(const seed of seeds) {
        for(const svg of [generatePhantomAvatarSvg(seed), generatePhantomSquadAvatarSvg(seed)]) {
          expect(svg).not.toMatch(/filter="url\(#glow/);
          expect(colours(svg).filter((hex) => !isGrey(hex)).sort()).toEqual(['#346bf1', '#6d94f5']);
        }
        // Squad key nodes stay white, but no eye highlight on a lone phantom may.
        expect(generatePhantomAvatarSvg(seed)).not.toContain('#ffffff');
      }
    });

    it('keeps the same shapes for a seed, changing only colours', () => {
      const shapes = (svg: string) => svg
      .replace(/ filter="url\(#glow[^"]*"/g, '')
      .replace(/#[0-9a-f]{6}(?:[0-9a-f]{2})?\b/gi, '#');
      for(const seed of seeds) {
        setTheme();
        const user = shapes(generatePhantomAvatarSvg(seed));
        const squad = shapes(generatePhantomSquadAvatarSvg(seed));
        setTheme('boring-corporate');
        expect(shapes(generatePhantomAvatarSvg(seed))).toBe(user);
        expect(shapes(generatePhantomSquadAvatarSvg(seed))).toBe(squad);
      }
    });

    it('does not serve a cached avatar from the other theme', async() => {
      const hex = 'c'.repeat(64);
      setTheme();
      const fun = await generateDicebearAvatar(hex);
      setTheme('boring-corporate');
      const corporate = await generateDicebearAvatar(hex);
      expect(corporate).not.toBe(fun);
      expect(await generateDicebearAvatar(hex)).toBe(corporate);
      setTheme();
      expect(await generateDicebearAvatar(hex)).toBe(fun);
    });
  });
});
