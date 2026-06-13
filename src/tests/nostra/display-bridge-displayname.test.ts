/**
 * Tests for nostra-display-bridge.ts — deriveDisplayName logic
 *
 * The method is private on NostraDisplayBridge, so we replicate its logic
 * as a standalone function and verify the priority chain:
 * nickname > display_name > name > nip05 > npub fallback
 */

import '../setup';

/**
 * Replicates the deriveDisplayName logic from NostraDisplayBridge (line ~804).
 * Priority: nickname > profile.display_name > profile.name > nip05 > npub fallback
 */
function deriveDisplayName(
  pubkey: string,
  nickname?: string,
  profile?: {display_name?: string; name?: string; nip05?: string} | null,
  npubEncode?: ((hex: string) => string) | null
): string {
  if(nickname?.trim()) return nickname.trim();
  if(profile?.display_name?.trim()) return profile.display_name.trim();
  if(profile?.name?.trim()) return profile.name.trim();
  if(profile?.nip05?.trim()) return profile.nip05.trim();
  if(npubEncode) return npubEncode(pubkey);
  return 'npub...' + pubkey.slice(0, 16);
}

const TEST_PUBKEY = 'a'.repeat(64);

// --- Priority tests ---

describe('deriveDisplayName priority chain', () => {
  test('nickname takes priority over everything', () => {
    const result = deriveDisplayName(TEST_PUBKEY, 'MyNickname', {
      display_name: 'DisplayAlice',
      name: 'alice',
      nip05: 'alice@relay.io'
    });
    expect(result).toBe('MyNickname');
  });

  test('display_name takes priority over name and nip05', () => {
    const result = deriveDisplayName(TEST_PUBKEY, undefined, {
      display_name: 'DisplayAlice',
      name: 'alice',
      nip05: 'alice@relay.io'
    });
    expect(result).toBe('DisplayAlice');
  });

  test('name takes priority over nip05', () => {
    const result = deriveDisplayName(TEST_PUBKEY, undefined, {
      name: 'alice',
      nip05: 'alice@relay.io'
    });
    expect(result).toBe('alice');
  });

  test('nip05 is used when name and display_name are empty', () => {
    const result = deriveDisplayName(TEST_PUBKEY, undefined, {
      display_name: '',
      name: '',
      nip05: 'alice@relay.io'
    });
    expect(result).toBe('alice@relay.io');
  });

  test('nip05 is used when name and display_name are missing', () => {
    const result = deriveDisplayName(TEST_PUBKEY, undefined, {
      nip05: 'user@example.com'
    });
    expect(result).toBe('user@example.com');
  });
});

// --- Fallback tests ---

describe('deriveDisplayName fallback', () => {
  test('falls back to npubEncode when provided and nothing else available', () => {
    const mockNpubEncode = (hex: string) => 'npub1' + hex.slice(0, 8);
    const result = deriveDisplayName(TEST_PUBKEY, undefined, null, mockNpubEncode);
    expect(result).toBe('npub1' + TEST_PUBKEY.slice(0, 8));
  });

  test('falls back to npub... + truncated pubkey without npubEncode', () => {
    const result = deriveDisplayName(TEST_PUBKEY, undefined, null, null);
    expect(result).toBe('npub...' + TEST_PUBKEY.slice(0, 16));
  });

  test('falls back when profile is undefined', () => {
    const result = deriveDisplayName(TEST_PUBKEY, undefined, undefined);
    expect(result).toBe('npub...' + TEST_PUBKEY.slice(0, 16));
  });

  test('falls back when profile is null', () => {
    const result = deriveDisplayName(TEST_PUBKEY, undefined, null);
    expect(result).toBe('npub...' + TEST_PUBKEY.slice(0, 16));
  });

  test('falls back when profile is empty object', () => {
    const result = deriveDisplayName(TEST_PUBKEY, undefined, {});
    expect(result).toBe('npub...' + TEST_PUBKEY.slice(0, 16));
  });

  test('falls back when all profile fields are empty strings', () => {
    const result = deriveDisplayName(TEST_PUBKEY, undefined, {
      display_name: '',
      name: '',
      nip05: ''
    });
    expect(result).toBe('npub...' + TEST_PUBKEY.slice(0, 16));
  });
});

// --- Whitespace handling ---

describe('deriveDisplayName whitespace handling', () => {
  test('empty string nickname is skipped', () => {
    const result = deriveDisplayName(TEST_PUBKEY, '', {name: 'alice'});
    expect(result).toBe('alice');
  });

  test('whitespace-only nickname is skipped', () => {
    const result = deriveDisplayName(TEST_PUBKEY, '   ', {name: 'alice'});
    expect(result).toBe('alice');
  });

  test('whitespace-only display_name is skipped', () => {
    const result = deriveDisplayName(TEST_PUBKEY, undefined, {
      display_name: '  \t ',
      name: 'bob'
    });
    expect(result).toBe('bob');
  });

  test('whitespace-only name is skipped', () => {
    const result = deriveDisplayName(TEST_PUBKEY, undefined, {
      name: '  ',
      nip05: 'user@relay.io'
    });
    expect(result).toBe('user@relay.io');
  });

  test('whitespace-only nip05 is skipped', () => {
    const result = deriveDisplayName(TEST_PUBKEY, undefined, {
      nip05: '   '
    });
    expect(result).toBe('npub...' + TEST_PUBKEY.slice(0, 16));
  });

  test('nickname is trimmed', () => {
    const result = deriveDisplayName(TEST_PUBKEY, '  Alice  ');
    expect(result).toBe('Alice');
  });

  test('display_name is trimmed', () => {
    const result = deriveDisplayName(TEST_PUBKEY, undefined, {
      display_name: '  Alice  '
    });
    expect(result).toBe('Alice');
  });

  test('name is trimmed', () => {
    const result = deriveDisplayName(TEST_PUBKEY, undefined, {
      name: '  bob  '
    });
    expect(result).toBe('bob');
  });

  test('nip05 is trimmed', () => {
    const result = deriveDisplayName(TEST_PUBKEY, undefined, {
      nip05: '  user@relay.io  '
    });
    expect(result).toBe('user@relay.io');
  });
});
