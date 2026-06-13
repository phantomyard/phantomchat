import {describe, it, expect, vi, beforeAll, afterAll} from 'vitest';

// Polyfill URL.createObjectURL for jsdom so the real generateDicebearAvatar
// can build a blob URL during the fallback path.
let blobCounter = 0;
const originalCreateObjectURL = (URL as any).createObjectURL;
const originalRevokeObjectURL = (URL as any).revokeObjectURL;

beforeAll(() => {
  (URL as any).createObjectURL = vi.fn(() => `blob:fake/${++blobCounter}`);
  (URL as any).revokeObjectURL = vi.fn();
});

import {generateNostrIdentity} from '@lib/nostra/nostr-identity';
import {getAvatarForQR} from '@lib/nostra/avatar-for-qr';
import {clearDicebearCache} from '@helpers/generateDicebearAvatar';

afterAll(() => {
  // Clear dicebear cache FIRST (while polyfilled revokeObjectURL is still installed),
  // then restore the original URL methods so the polyfill does not leak.
  clearDicebearCache();
  (URL as any).createObjectURL = originalCreateObjectURL;
  (URL as any).revokeObjectURL = originalRevokeObjectURL;
  vi.restoreAllMocks();
});

describe('getAvatarForQR', () => {
  it('returns the picture URL unchanged when provided', async() => {
    const {npub} = generateNostrIdentity();
    const picture = 'https://cdn.example.com/avatar.jpg';
    const result = await getAvatarForQR(npub, picture);
    expect(result).toBe(picture);
  });

  it('preserves blossom-style picture URLs unchanged', async() => {
    const {npub} = generateNostrIdentity();
    const picture = 'https://blossom.primal.net/abc123.png';
    const result = await getAvatarForQR(npub, picture);
    expect(result).toBe(picture);
  });

  it('falls back to a blob URL when picture is undefined', async() => {
    const {npub} = generateNostrIdentity();
    const result = await getAvatarForQR(npub, undefined);
    expect(typeof result).toBe('string');
    expect(result.startsWith('blob:')).toBe(true);
  });

  it('falls back to a blob URL when picture is null', async() => {
    const {npub} = generateNostrIdentity();
    const result = await getAvatarForQR(npub, null);
    expect(result.startsWith('blob:')).toBe(true);
  });

  it('falls back to a blob URL when picture is an empty string', async() => {
    const {npub} = generateNostrIdentity();
    const result = await getAvatarForQR(npub, '');
    expect(result.startsWith('blob:')).toBe(true);
  });

  it('falls back to a blob URL when picture is whitespace-only', async() => {
    const {npub} = generateNostrIdentity();
    const result = await getAvatarForQR(npub, '   \t\n');
    expect(result.startsWith('blob:')).toBe(true);
  });

  it('produces a stable fallback URL for the same npub', async() => {
    const {npub} = generateNostrIdentity();
    const a = await getAvatarForQR(npub);
    const b = await getAvatarForQR(npub);
    expect(a).toBe(b);
  });
});
