import type {ThemeSettings} from '@layer';

// Restore earlier Preview stock palettes at render time only.
// Saved preferences and custom colours remain unchanged.
const mutedPalette = {
  baseThemeClassic: {accent: 0x456783, message: 0x397fc1, intensity: 12, colors: [0xe7edf2, 0xdfe7ee, 0xecf0f4, 0xd8e2ea]},
  baseThemeNight: {accent: 0x8aacc8, message: 0x28649a, intensity: -12, colors: [0x171e26, 0x202b36, 0x1c2530, 0x263340]}
};

const previousPalette = {
  baseThemeClassic: {...mutedPalette.baseThemeClassic, message: 0x456783},
  baseThemeNight: {...mutedPalette.baseThemeNight, message: 0x344b60}
};

export const understatedPalette = {
  baseThemeClassic: {accent: 0x3080FF, message: 0x5CA853, intensity: 50, colors: [0xdbddbb, 0x6ba587, 0xd5d88d, 0x88b884]},
  baseThemeNight: {accent: 0x3080FF, message: 0x3080FF, intensity: -50, colors: [0xfec496, 0xdd6cb9, 0x962fbf, 0x4f5bd5]}
};

const rendered = new WeakMap<ThemeSettings, ThemeSettings>();

export function renderUnderstatedDefaults<T extends ThemeSettings>(settings: T, themeId: string | number): T {
  const base = settings?.base_theme?._;
  if(themeId !== '' || !(base in understatedPalette)) return settings;
  const key = base as keyof typeof understatedPalette;
  const old = settings.message_colors?.[0] === previousPalette[key].message ? previousPalette[key] : mutedPalette[key];
  const next = understatedPalette[base as keyof typeof understatedPalette];
  // Only untouched stock accents are remapped. Custom themes/accents survive.
  if(settings.accent_color !== old.accent || settings.outbox_accent_color !== undefined ||
    settings.message_colors?.length !== 1 || settings.message_colors[0] !== old.message) return settings;
  const wallpaper = settings.wallpaper;
  const background = wallpaper?.settings;
  const colorKeys = ['background_color', 'second_background_color', 'third_background_color', 'fourth_background_color'] as const;
  const stockWallpaper = wallpaper?._ === 'wallPaper' && wallpaper.slug === 'pattern' &&
    background?.intensity === old.intensity && colorKeys.every((key, i) => background[key] === old.colors[i]);
  const cached = rendered.get(settings);
  if(cached?.accent_color === next.accent && (stockWallpaper ? cached.wallpaper !== wallpaper : cached.wallpaper === wallpaper)) return cached as T;
  const result = {
    ...settings,
    accent_color: next.accent,
    message_colors: [next.message],
    ...(stockWallpaper ? {wallpaper: {...wallpaper, settings: {
      ...background,
      intensity: next.intensity,
      ...Object.fromEntries(colorKeys.map((key, i) => [key, next.colors[i]]))
    }}} : {})
  };
  rendered.set(settings, result);
  return result;
}
