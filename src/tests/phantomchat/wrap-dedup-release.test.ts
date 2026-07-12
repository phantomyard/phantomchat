/**
 * The dedup claim must be ROLLED BACK when a wrap fails to process.
 *
 * Companion to message-loss-recovery.test.ts, which covers the pool half
 * (releaseWrapId + the wiring). This covers the half that actually fires in
 * production: NostrRelay.handleEvent claiming a wrap id, failing to unwrap it,
 * and handing the claim back so a replay can retry.
 *
 * Without the release, a wrap that lands during a frozen unwrap worker is
 * claimed, dropped, and then deduped out of every subsequent replay — on the
 * relay forever, invisible until a reload.
 */

import '../setup';
import {describe, it, expect, beforeEach, vi} from 'vitest';

const {unwrapMock} = vi.hoisted(() => ({unwrapMock: vi.fn()}));

vi.mock('@lib/phantomchat/nostr-unwrap-client', () => ({
  getNostrUnwrapClient: () => ({unwrap: unwrapMock, warm: vi.fn()}),
  disposeNostrUnwrapClient: vi.fn()
}));

vi.mock('@lib/logger', () => ({
  logger: () => {
    const log = (..._a: unknown[]) => {};
    log.warn = (..._a: unknown[]) => {};
    log.error = (..._a: unknown[]) => {};
    log.debug = (..._a: unknown[]) => {};
    return log;
  },
  Logger: class {},
  LogTypes: {None: 0, Error: 1, Warn: 2, Log: 4, Debug: 8}
}));

import {NostrRelay} from '@lib/phantomchat/nostr-relay';

const GIFTWRAP_KIND = 1059;

function makeWrap(id: string) {
  return {
    id,
    pubkey: 'ff'.repeat(32),
    kind: GIFTWRAP_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: 'ciphertext-blob',
    tags: [],
    sig: 'sig-' + id
  } as any;
}

describe('gift-wrap dedup claim/release', () => {
  let relay: NostrRelay;
  let seen: Set<string>;
  let claims: string[];
  let releases: string[];

  beforeEach(() => {
    unwrapMock.mockReset();

    relay = new NostrRelay('wss://test.relay');
    seen = new Set();
    claims = [];
    releases = [];

    // Mirror the pool's real claim/release wiring against a local seen-set.
    relay.setEventDedup((id: string) => {
      claims.push(id);
      if(seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    relay.setEventRelease((id: string) => {
      releases.push(id);
      seen.delete(id);
    });
  });

  it('releases the claim when the unwrap fails, so a replay is re-admitted', async() => {
    const delivered: any[] = [];
    relay.onMessage((m) => delivered.push(m));

    // The unwrap worker is frozen / the decrypt blows up.
    unwrapMock.mockRejectedValueOnce(new Error('unwrap worker frozen'));

    const wrap = makeWrap('wrap-a');
    await relay.ingestExternalEvent(wrap);

    // Nothing was delivered...
    expect(delivered).toHaveLength(0);
    // ...so the claim must have been handed back.
    expect(releases).toEqual(['wrap-a']);
    expect(seen.has('wrap-a')).toBe(false);

    // The relay replays the same wrap. This time the unwrap works.
    unwrapMock.mockResolvedValueOnce({
      id: 'rumor-a',
      pubkey: 'aa'.repeat(32),
      kind: 14,
      content: 'the answer you never saw',
      created_at: Math.floor(Date.now() / 1000),
      tags: []
    });

    await relay.ingestExternalEvent(wrap);

    // Recovered — this is the whole point.
    expect(delivered).toHaveLength(1);
    expect(delivered[0].content).toBe('the answer you never saw');
  });

  it('keeps the claim for a wrap that unwrapped fine (no double delivery)', async() => {
    const delivered: any[] = [];
    relay.onMessage((m) => delivered.push(m));

    unwrapMock.mockResolvedValue({
      id: 'rumor-b',
      pubkey: 'bb'.repeat(32),
      kind: 14,
      content: 'hello',
      created_at: Math.floor(Date.now() / 1000),
      tags: []
    });

    const wrap = makeWrap('wrap-b');
    await relay.ingestExternalEvent(wrap);
    await relay.ingestExternalEvent(wrap); // relay replays it

    expect(releases).toEqual([]);
    expect(delivered).toHaveLength(1); // deduped, not doubled
  });
});
