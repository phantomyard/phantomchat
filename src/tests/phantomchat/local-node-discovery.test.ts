// @ts-nocheck
import {describe, it, expect, vi} from 'vitest';
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';

import {getConversationKey, nip44Encrypt} from '@lib/phantomchat/nostr-crypto';
import {
  LocalNodeDiscovery,
  parseSelfReachability
} from '@lib/phantomchat/transport/local-node-discovery';
import {
  CAPABILITY_D_TAG,
  CAPABILITY_KIND
} from '@lib/phantomchat/transport/capability-ingest';

const NOW_S = 1_800_000_000; // fixed "now" in seconds
const NOW_MS = NOW_S * 1000;

/**
 * Build a capability advert EXACTLY as phantombot `buildCapabilityEvent` does:
 * public booleans + a self-encrypted `enc` blob (NIP-44, self conversation key).
 * This is the cross-repo wire contract — if this construction and
 * parseSelfReachability ever disagree, discovery silently breaks.
 */
function buildAdvert(sk: Uint8Array, opts: {port: number; lanIps?: string[]; createdAt?: number}) {
  const pubHex = getPublicKey(sk);
  const selfKey = getConversationKey(sk, pubHex);
  const enc = nip44Encrypt(
    JSON.stringify({localWsPort: opts.port, lanIps: opts.lanIps ?? []}),
    selfKey
  );
  return {
    kind: CAPABILITY_KIND,
    created_at: opts.createdAt ?? NOW_S,
    tags: [['d', CAPABILITY_D_TAG]],
    content: JSON.stringify({localWs: true, webrtc: true, dht: false, enc})
  };
}

describe('parseSelfReachability — decrypt our own advert', () => {
  it('recovers the port + LAN IPs the node self-encrypted (cross-repo contract)', () => {
    const sk = generateSecretKey();
    const pub = getPublicKey(sk);
    const event = buildAdvert(sk, {port: 54321, lanIps: ['192.168.1.42']});

    const parsed = parseSelfReachability(event, pub, sk);
    expect(parsed).not.toBeNull();
    expect(parsed!.reach).toEqual({localWsPort: 54321, lanIps: ['192.168.1.42']});
    expect(parsed!.createdAt).toBe(NOW_S);
  });

  it('returns null for a DIFFERENT key (only the owner can decrypt)', () => {
    const sk = generateSecretKey();
    const other = generateSecretKey();
    const event = buildAdvert(sk, {port: 54321});
    // Wrong secret key → the self conversation key differs → decrypt fails.
    expect(parseSelfReachability(event, getPublicKey(other), other)).toBeNull();
  });

  it('returns null for wrong kind / missing d-tag / no enc / junk', () => {
    const sk = generateSecretKey();
    const pub = getPublicKey(sk);
    const good = buildAdvert(sk, {port: 1});
    expect(parseSelfReachability({...good, kind: 1}, pub, sk)).toBeNull();
    expect(parseSelfReachability({...good, tags: []}, pub, sk)).toBeNull();
    expect(parseSelfReachability({...good, content: '{"localWs":true}'}, pub, sk)).toBeNull();
    expect(parseSelfReachability({...good, content: 'not json'}, pub, sk)).toBeNull();
  });
});

describe('LocalNodeDiscovery — points the transport at the discovered port', () => {
  function makeDeps(overrides = {}) {
    const sk = generateSecretKey();
    const pub = getPublicKey(sk);
    const setPort = vi.fn();
    const queryLatestEvent = vi.fn();
    const deps = {
      getChatAPI: () => ({queryLatestEvent}),
      getOwnKeys: () => ({pubkey: pub, secretKey: sk}),
      setPort,
      now: () => NOW_MS,
      ...overrides
    };
    return {sk, pub, setPort, queryLatestEvent, deps};
  }

  it('discovers a fresh advert and sets the port', async() => {
    const {sk, setPort, queryLatestEvent, deps} = makeDeps();
    queryLatestEvent.mockResolvedValue(buildAdvert(sk, {port: 61000}));

    const port = await new LocalNodeDiscovery(deps).refresh();
    expect(port).toBe(61000);
    expect(setPort).toHaveBeenCalledWith(61000);
    // Queried our OWN pubkey's advert.
    expect(queryLatestEvent).toHaveBeenCalledWith(
      expect.objectContaining({kinds: [CAPABILITY_KIND], '#d': [CAPABILITY_D_TAG]})
    );
  });

  it('does NOT set a port for a STALE advert (node likely gone)', async() => {
    const {sk, setPort, queryLatestEvent, deps} = makeDeps();
    // 8 days old, past the default 7-day TTL.
    const staleAt = NOW_S - 8 * 24 * 60 * 60;
    queryLatestEvent.mockResolvedValue(buildAdvert(sk, {port: 61000, createdAt: staleAt}));

    expect(await new LocalNodeDiscovery(deps).refresh()).toBeNull();
    expect(setPort).not.toHaveBeenCalled();
  });

  it('no-ops when there is no advert, no identity, or a relay error', async() => {
    // No advert.
    const a = makeDeps();
    a.queryLatestEvent.mockResolvedValue(null);
    expect(await new LocalNodeDiscovery(a.deps).refresh()).toBeNull();
    expect(a.setPort).not.toHaveBeenCalled();

    // No identity yet.
    const b = makeDeps({getOwnKeys: () => null});
    expect(await new LocalNodeDiscovery(b.deps).refresh()).toBeNull();
    expect(b.setPort).not.toHaveBeenCalled();

    // Relay throws → contained, no port applied.
    const c = makeDeps();
    c.queryLatestEvent.mockRejectedValue(new Error('relay down'));
    expect(await new LocalNodeDiscovery(c.deps).refresh()).toBeNull();
    expect(c.setPort).not.toHaveBeenCalled();
  });

  it('ignores an advert whose decrypted port is zero/invalid', async() => {
    const {sk, setPort, queryLatestEvent, deps} = makeDeps();
    queryLatestEvent.mockResolvedValue(buildAdvert(sk, {port: 0}));
    expect(await new LocalNodeDiscovery(deps).refresh()).toBeNull();
    expect(setPort).not.toHaveBeenCalled();
  });
});
