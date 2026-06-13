import {describe, it, expect, beforeEach, afterEach, beforeAll} from 'vitest';
import {parseQRPayload} from '@lib/nostra/qr-payload';
import {generateNostrIdentity} from '@lib/nostra/nostr-identity';

let VALID_NPUB: string;
let VALID_HEX: string;

beforeAll(() => {
  const id = generateNostrIdentity();
  VALID_NPUB = id.npub;
  VALID_HEX = id.publicKey;
});

describe('parseQRPayload', () => {
  beforeEach(() => {
    (window as any).__nostraOwnPubkey = undefined;
  });

  afterEach(() => {
    (window as any).__nostraOwnPubkey = undefined;
  });

  it('accepts raw npub', () => {
    expect(parseQRPayload(VALID_NPUB)).toEqual({npub: VALID_NPUB});
  });

  it('strips nostr: prefix (lowercase)', () => {
    expect(parseQRPayload('nostr:' + VALID_NPUB)).toEqual({npub: VALID_NPUB});
  });

  it('strips NOSTR: prefix (case-insensitive)', () => {
    expect(parseQRPayload('NOSTR:' + VALID_NPUB)).toEqual({npub: VALID_NPUB});
  });

  it('trims surrounding whitespace', () => {
    expect(parseQRPayload('  ' + VALID_NPUB + '\n')).toEqual({npub: VALID_NPUB});
  });

  it('rejects too-short npub', () => {
    expect(parseQRPayload('npub1short')).toEqual({error: 'invalid'});
  });

  it('rejects 64-char hex pubkey as unsupported', () => {
    expect(parseQRPayload(VALID_HEX)).toEqual({error: 'unsupported'});
  });

  it('rejects random string', () => {
    expect(parseQRPayload('hello world')).toEqual({error: 'invalid'});
  });

  it('rejects empty string', () => {
    expect(parseQRPayload('')).toEqual({error: 'invalid'});
  });

  it('returns self error when npub matches own pubkey', () => {
    (window as any).__nostraOwnPubkey = VALID_HEX;
    expect(parseQRPayload(VALID_NPUB)).toEqual({error: 'self'});
  });
});
