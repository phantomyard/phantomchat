import {createAvatar} from '@dicebear/core';
import {funEmoji} from '@dicebear/collection';

const cache = new Map<string, string>();

/**
 * Generate a deterministic fun-emoji avatar blob URL from a hex pubkey.
 * Results are cached in memory — same hex always returns same blob URL.
 */
export async function generateDicebearAvatar(hex: string): Promise<string> {
  const cached = cache.get(hex);
  if(cached) {
    return cached;
  }

  const avatar = createAvatar(funEmoji, {
    seed: hex,
    size: 128
  });

  const svg = avatar.toString();
  const blob = new Blob([svg], {type: 'image/svg+xml'});
  const url = URL.createObjectURL(blob);
  cache.set(hex, url);
  return url;
}

/**
 * Clear all cached blob URLs. Useful for testing.
 */
export function clearDicebearCache(): void {
  for(const url of cache.values()) {
    URL.revokeObjectURL(url);
  }
  cache.clear();
}
