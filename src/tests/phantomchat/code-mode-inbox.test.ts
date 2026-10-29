/**
 * Code Mode — the inbox list is derived, never stored.
 *
 * Membership is "everything in the phantom mapping store", so the tests that
 * matter are the ones that decide what may appear in the list at all:
 *
 *  - only synthetic phantom peer ids (a Telegram chat must never leak in);
 *  - a contact you just added appears even if it has never said a word;
 *  - ordering is by last activity, with never-used phantoms after the rest;
 *  - duplicates (same peer twice in the mapping store) collapse to one row.
 */
import {describe, it, expect} from 'vitest';
import {
  CODE_MODE_PEER_ID_FLOOR,
  buildCodeModeInbox,
  formatCodeModeAge,
  isCodeModePeerId,
  sortIndexToSeconds
} from '@lib/code-mode';

const P1 = CODE_MODE_PEER_ID_FLOOR + 1;
const P2 = CODE_MODE_PEER_ID_FLOOR + 2;
const P3 = CODE_MODE_PEER_ID_FLOOR + 3;

const pubkey = (n: number) => String(n).padStart(64, '0');

describe('isCodeModePeerId', () => {
  it('accepts synthetic phantom ids only', () => {
    expect(isCodeModePeerId(P1)).toBe(true);
    expect(isCodeModePeerId(CODE_MODE_PEER_ID_FLOOR)).toBe(true);

    for(const other of [0, 1, 1234, -1001234567890, 999_999_999_999]) {
      expect(isCodeModePeerId(other)).toBe(false);
    }
  });

  it('rejects junk instead of throwing on it', () => {
    expect(isCodeModePeerId(undefined as unknown as number)).toBe(false);
    expect(isCodeModePeerId(null as unknown as number)).toBe(false);
    expect(isCodeModePeerId(NaN)).toBe(false);
  });

  it('accepts the string form the bridge sometimes hands over', () => {
    expect(isCodeModePeerId(String(P1))).toBe(true);
  });
});

describe('sortIndexToSeconds', () => {
  it('undoes the dialog sort index scaling', () => {
    const seconds = 1_760_000_000;
    expect(sortIndexToSeconds(seconds * 0x10000)).toBe(seconds);
  });

  it('treats a missing index as "never"', () => {
    expect(sortIndexToSeconds(0)).toBe(0);
    expect(sortIndexToSeconds(-1)).toBe(0);
    expect(sortIndexToSeconds(NaN)).toBe(0);
  });
});

describe('buildCodeModeInbox', () => {
  it('lists a phantom with no messages at all', () => {
    const rows = buildCodeModeInbox([{pubkey: pubkey(1), peerId: P1, displayName: 'max'}], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({peerId: P1, title: 'max', unread: 0, lastActivity: 0});
  });

  it('never shows a non-phantom peer', () => {
    const rows = buildCodeModeInbox([
      {pubkey: pubkey(1), peerId: P1},
      {pubkey: pubkey(2), peerId: 1234}
    ], [{peerId: 1234, sortIndex: 1_760_000_000 * 0x10000}]);
    expect(rows.map((r) => r.peerId)).toEqual([P1]);
  });

  it('sorts by last activity, newest first, then by title', () => {
    const rows = buildCodeModeInbox(
      [
        {pubkey: pubkey(1), peerId: P1, displayName: 'a'},
        {pubkey: pubkey(2), peerId: P2, displayName: 'b'},
        {pubkey: pubkey(3), peerId: P3, displayName: 'c'}
      ],
      [
        {peerId: P1, sortIndex: 1_000 * 0x10000},
        {peerId: P3, sortIndex: 2_000 * 0x10000}
      ]
    );

    expect(rows.map((r) => r.peerId)).toEqual([P3, P1, P2]);
  });

  it('carries the unread count through from the dialog', () => {
    const rows = buildCodeModeInbox(
      [{pubkey: pubkey(1), peerId: P1}],
      [{peerId: P1, sortIndex: 5 * 0x10000, unread: 4}]
    );
    expect(rows[0].unread).toBe(4);
  });

  it('collapses a duplicated mapping to one row', () => {
    const rows = buildCodeModeInbox([
      {pubkey: pubkey(1), peerId: P1, displayName: 'first'},
      {pubkey: pubkey(1), peerId: P1, displayName: 'second'}
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('first');
  });

  it('falls back to a short pubkey when the contact has no name yet', () => {
    const rows = buildCodeModeInbox([{pubkey: pubkey(7), peerId: P1, displayName: '   '}]);
    expect(rows[0].title).toBe(pubkey(7).slice(0, 8));
  });

  it('leaves your own identity out of the inbox', () => {
    // Own pubkey has a mapping like any contact, but you cannot chat with
    // yourself — it must never take a row.
    const rows = buildCodeModeInbox(
      [
        {pubkey: pubkey(1), peerId: P1, displayName: 'me'},
        {pubkey: pubkey(2), peerId: P2, displayName: 'max'}
      ],
      [],
      {excludePubkeys: [pubkey(1)]}
    );
    expect(rows.map((r) => r.title)).toEqual(['max']);
  });

  it('survives junk in the mapping store', () => {
    const rows = buildCodeModeInbox([
      null as any,
      undefined as any,
      {pubkey: pubkey(1), peerId: P1},
      {pubkey: pubkey(2), peerId: NaN}
    ]);
    expect(rows.map((r) => r.peerId)).toEqual([P1]);
  });
});

describe('formatCodeModeAge', () => {
  const now = 1_760_000_000;

  it('renders the compact forms the inbox rows use', () => {
    expect(formatCodeModeAge(now - 10, now)).toBe('now');
    expect(formatCodeModeAge(now - 90, now)).toBe('1m');
    expect(formatCodeModeAge(now - 3 * 3600, now)).toBe('3h');
    expect(formatCodeModeAge(now - 2 * 86400, now)).toBe('2d');
  });

  it('is empty for a chat that never had activity', () => {
    expect(formatCodeModeAge(0, now)).toBe('');
  });

  it('never renders a negative age from a clock skew', () => {
    expect(formatCodeModeAge(now + 600, now)).toBe('now');
  });
});
