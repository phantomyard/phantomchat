/*
 * Fluent Emoji fallback for Nostra mode.
 *
 * In Nostra mode there are no Telegram sticker sets, so
 * `appStickersManager.getAnimatedEmojiSticker(emoji)` always returns
 * undefined and callers that expect a lottie animation would crash
 * ("no sticker"). This module provides a static-PNG fallback sourced
 * from Microsoft's Fluent Emoji (MIT) so theme chips, big emoji in
 * bubbles, and similar UI surfaces degrade gracefully.
 *
 * Assets live in public/assets/fluent-emoji/ — see LICENSE there.
 * To extend the pack: edit FLUENT_EMOJI_MAP below, then run
 * `node src/scripts/download-fluent-emoji.mjs`.
 */

// Emoji → base slug (also the filename stem under public/assets/fluent-emoji/).
// Both bare emoji and variation-selector-16 forms map to the same slug so
// text-style (e.g. '❤') and emoji-style (e.g. '❤️') inputs both resolve.
const FLUENT_EMOJI_MAP: Readonly<Record<string, string>> = {
  '❤️': 'red_heart', '❤': 'red_heart',
  '👍': 'thumbs_up',
  '👎': 'thumbs_down',
  '🔥': 'fire',
  '🎉': 'party_popper',
  '🎊': 'confetti_ball',
  '🎂': 'birthday_cake',
  '🎁': 'wrapped_gift',
  '🎄': 'christmas_tree',
  '🌲': 'evergreen_tree',
  '🏞️': 'national_park', '🏞': 'national_park',
  '⛺': 'tent',
  '🌌': 'milky_way',
  '🌈': 'rainbow',
  '⭐': 'star',
  '🌙': 'crescent_moon',
  '☀️': 'sun', '☀': 'sun',
  '🌹': 'rose',
  '✨': 'sparkles',
  '🎨': 'artist_palette',
  '😂': 'face_with_tears_of_joy',
  '😍': 'smiling_face_with_heart_eyes',
  '😢': 'crying_face',
  '🙏': 'folded_hands',
  '💯': 'hundred_points'
};

export function getFluentEmojiUrl(emoji: string): string | undefined {
  const slug = FLUENT_EMOJI_MAP[emoji];
  return slug ? `assets/fluent-emoji/${slug}.png` : undefined;
}

export function hasFluentEmoji(emoji: string): boolean {
  return emoji in FLUENT_EMOJI_MAP;
}
