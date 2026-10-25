// @vitest-environment node
import {describe, expect, it} from 'vitest';
import {renderUnderstatedDefaults, understatedPalette} from '../helpers/understatedTheme';
import type {ThemeSettings} from '../layer';

function stock(night = false): ThemeSettings {
  return {
    _: 'themeSettings', pFlags: {}, base_theme: {_: night ? 'baseThemeNight' : 'baseThemeClassic'},
    accent_color: 0x3080FF, message_colors: [night ? 0x3080FF : 0x5CA853],
    wallpaper: {_: 'wallPaper', id: '', access_hash: '', slug: 'pattern', pFlags: {pattern: true},
      document: {} as any, settings: {_: 'wallPaperSettings', pFlags: {}, intensity: night ? -50 : 50,
        background_color: night ? 0xfec496 : 0xdbddbb, second_background_color: night ? 0xdd6cb9 : 0x6ba587,
        third_background_color: night ? 0x962fbf : 0xd5d88d, fourth_background_color: night ? 0x4f5bd5 : 0x88b884}}
  };
}
describe('render-only stock theme refresh', () => {
  for(const night of [false, true]) it(`remaps stock ${night ? 'night' : 'day'} without mutating shared preferences`, () => {
    const saved = stock(night), before = JSON.stringify(saved);
    const result = renderUnderstatedDefaults(saved, '');
    const palette = understatedPalette[night ? 'baseThemeNight' : 'baseThemeClassic'];
    expect(result.accent_color).toBe(palette.accent);
    expect(result.message_colors).toEqual([palette.message]);
    expect(result.wallpaper.settings.background_color).toBe(palette.colors[0]);
    expect(result.wallpaper.settings.intensity).toBe(palette.intensity);
    expect(JSON.stringify(saved)).toBe(before);
    expect(renderUnderstatedDefaults(saved, '')).toBe(result);
  });
  for(const night of [false, true]) it(`refreshes saved understated ${night ? 'night' : 'day'} bubbles without rewriting preferences`, () => {
    const saved = stock(night);
    saved.accent_color = night ? 0x8aacc8 : 0x456783;
    saved.message_colors = [night ? 0x344b60 : 0x456783];
    const before = JSON.stringify(saved);
    const result = renderUnderstatedDefaults(saved, '');
    expect(result.message_colors).toEqual([understatedPalette[night ? 'baseThemeNight' : 'baseThemeClassic'].message]);
    expect(JSON.stringify(saved)).toBe(before);
    expect(renderUnderstatedDefaults(saved, '')).toBe(result);
  });
  it('invalidates a stock cache after in-place wallpaper edits in both directions', () => {
    const saved = stock();
    const initial = renderUnderstatedDefaults(saved, '');
    expect(initial.wallpaper).not.toBe(saved.wallpaper);
    saved.wallpaper.settings.background_color = 0x123456;
    const custom = renderUnderstatedDefaults(saved, '');
    expect(custom.wallpaper).toBe(saved.wallpaper);
    expect(custom.wallpaper.settings.background_color).toBe(0x123456);
    saved.wallpaper.settings.background_color = 0xdbddbb;
    const restored = renderUnderstatedDefaults(saved, '');
    expect(restored.wallpaper).not.toBe(saved.wallpaper);
    expect(restored.wallpaper.settings.background_color).toBe(understatedPalette.baseThemeClassic.colors[0]);
  });
  it('preserves custom themes, accents, and outgoing colours', () => {
    const saved = stock();
    expect(renderUnderstatedDefaults(saved, 'custom')).toBe(saved);
    for(const change of [{accent_color: 0xff0000}, {message_colors: [0x123456]}, {outbox_accent_color: 0x123456}]) {
      const custom = {...stock(), ...change};
      expect(renderUnderstatedDefaults(custom, '')).toBe(custom);
    }
  });
  it('preserves a custom wallpaper while rendering stock accents quietly', () => {
    const saved = stock();
    (saved.wallpaper as any).slug = 'custom-photo';
    const result = renderUnderstatedDefaults(saved, '');
    expect(result.wallpaper).toBe(saved.wallpaper);
    expect(result.accent_color).toBe(understatedPalette.baseThemeClassic.accent);
  });
});
