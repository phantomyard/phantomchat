import {describe, it, expect, vi} from 'vitest';
import {mirrorsIdbCoherent, peersComplete, storedMessageIdentityComplete} from './state';
import type {FuzzContext, UserHandle} from '../types';

function userWith(evalResult: any): UserHandle {
  return {
    id: 'userA',
    context: null as any,
    page: {evaluate: vi.fn(async() => evalResult)} as any,
    displayName: 'A',
    npub: '',
    remotePeerId: 42,
    consoleLog: [],
    reloadTimes: [Date.now() - 60_000]
  };
}

function ctx(evalResultA: any, evalResultB: any = evalResultA): FuzzContext {
  return {
    users: {userA: userWith(evalResultA), userB: userWith(evalResultB)},
    relay: null as any,
    snapshots: new Map(),
    actionIndex: 10
  };
}

describe('INV-mirrors-idb-coherent', () => {
  it('passes when every mirror mid has a matching idb row', async() => {
    const r = await mirrorsIdbCoherent.check(ctx({mirrorMids: [1, 2], idbMids: [1, 2]}));
    expect(r.ok).toBe(true);
  });

  it('fails when a mirror mid has no idb row', async() => {
    const r = await mirrorsIdbCoherent.check(ctx({mirrorMids: [1, 2, 3], idbMids: [1, 2]}));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/mirror .* not in idb/i);
  });
});

describe('INV-peers-complete', () => {
  it('passes when peer names are real display names', async() => {
    const r = await peersComplete.check(ctx({peers: [{peerId: 42, first_name: 'Alice'}]}));
    expect(r.ok).toBe(true);
  });

  it('fails when a peer name is an 8+ hex-char fallback', async() => {
    const r = await peersComplete.check(ctx({peers: [{peerId: 42, first_name: 'deadbeef01'}]}));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/hex/i);
  });
});

describe('INV-stored-message-identity-complete', () => {
  it('passes when every row has mid+twebPeerId+timestamp', async() => {
    const rows = [
      {eventId: 'ev1', mid: 100, twebPeerId: 7, timestamp: 1000},
      {eventId: 'ev2', mid: 101, twebPeerId: 7, timestamp: 1001}
    ];
    const r = await storedMessageIdentityComplete.check(ctx({rows}));
    expect(r.ok).toBe(true);
  });

  it('fails when a row is missing mid', async() => {
    const rows: Array<{eventId: string; mid: number | null; twebPeerId: number | null; timestamp: number | null}> = [
      {eventId: 'ev1', mid: 100, twebPeerId: 7, timestamp: 1000},
      {eventId: 'evbad', mid: null, twebPeerId: 7, timestamp: 1001}
    ];
    const r = await storedMessageIdentityComplete.check(ctx({rows}));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/missing mid/);
  });

  it('fails when a row is missing twebPeerId', async() => {
    const rows: Array<{eventId: string; mid: number | null; twebPeerId: number | null; timestamp: number | null}> = [
      {eventId: 'evbad', mid: 100, twebPeerId: null, timestamp: 1000}
    ];
    const r = await storedMessageIdentityComplete.check(ctx({rows}));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/missing.*twebPeerId/);
  });

  it('skips synthetic contact-init rows (marker-only, never rendered)', async() => {
    const rows: Array<{eventId: string; mid: number | null | undefined; twebPeerId: number | null | undefined; timestamp: number | null}> = [
      {eventId: 'contact-init-aabbccdd', mid: undefined, twebPeerId: undefined, timestamp: 1000}
    ];
    const r = await storedMessageIdentityComplete.check(ctx({rows}));
    expect(r.ok).toBe(true);
  });
});
