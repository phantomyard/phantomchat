// @ts-nocheck
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {TransportSelector} from '@lib/phantomchat/transport/transport-selector';
import {PeerCapabilityRegistry} from '@lib/phantomchat/transport/capability';

const PK = 'b'.repeat(64);
const SELF = 'c'.repeat(64);

// A kind-1059 gift-wrap addressed to `recipient` via its p-tag — the shape the
// selector receives from NostrRelayPool.publish() and ships as ['EVENT', wrap].
function makeWrap(recipient = PK, id = 'wrap-recipient') {
  return {
    id,
    kind: 1059,
    pubkey: 'e'.repeat(64), // ephemeral wrap key
    created_at: 1,
    content: 'ciphertext',
    tags: [['p', recipient]],
    sig: 'f'.repeat(128)
  };
}

// The publish() result: a recipient wrap plus a self wrap (multi-device sync).
function makeWraps(recipient = PK) {
  return [makeWrap(recipient, 'wrap-recipient'), makeWrap(SELF, 'wrap-self')];
}

function makeMesh(overrides = {}) {
  return {
    getStatus: vi.fn().mockReturnValue('disconnected'),
    send: vi.fn().mockReturnValue(true),
    connect: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

function makeLocal(overrides = {}) {
  return {
    ensureConnected: vi.fn().mockResolvedValue(true),
    send: vi.fn().mockReturnValue(true),
    isConnected: vi.fn().mockReturnValue(true),
    close: vi.fn(),
    ...overrides
  };
}

describe('TransportSelector — the gate (regression guarantee)', () => {
  it('no advertisement → declines on relay tier and NEVER touches a transport', async() => {
    const capability = new PeerCapabilityRegistry();
    const mesh = makeMesh();
    const local = makeLocal();
    const sel = new TransportSelector({capability, mesh, local});

    const res = await sel.tryDeliver(PK, makeWraps());

    expect(res).toEqual({tier: 'relay', delivered: false});
    // The whole point: the relay path is left to the caller, nothing probed.
    expect(local.ensureConnected).not.toHaveBeenCalled();
    expect(local.send).not.toHaveBeenCalled();
    expect(mesh.getStatus).not.toHaveBeenCalled();
    expect(mesh.connect).not.toHaveBeenCalled();
    expect(mesh.send).not.toHaveBeenCalled();
  });

  it('advertised but no wraps → declines to relay (nothing to ship)', async() => {
    const capability = new PeerCapabilityRegistry();
    capability.set(PK, {localWs: true, webrtc: true});
    const mesh = makeMesh({getStatus: vi.fn().mockReturnValue('connected')});
    const local = makeLocal();
    const sel = new TransportSelector({capability, mesh, local});

    const res = await sel.tryDeliver(PK, []);

    expect(res).toEqual({tier: 'relay', delivered: false});
    expect(local.send).not.toHaveBeenCalled();
    expect(mesh.send).not.toHaveBeenCalled();
  });

  it('never throws even if a transport blows up — always returns a result', async() => {
    const capability = new PeerCapabilityRegistry();
    capability.set(PK, {webrtc: true});
    const mesh = makeMesh({getStatus: vi.fn(() => { throw new Error('boom'); })});
    const sel = new TransportSelector({capability, mesh, local: null});

    const res = await sel.tryDeliver(PK, makeWraps());
    expect(res).toEqual({tier: 'relay', delivered: false});
  });
});

describe('TransportSelector — frame + recipient wrap selection', () => {
  it('ships the RECIPIENT-addressed wrap as an ["EVENT", wrap] frame', async() => {
    const capability = new PeerCapabilityRegistry();
    capability.set(PK, {localWs: true, localWsPort: 33297, webrtc: true});
    const mesh = makeMesh({getStatus: vi.fn().mockReturnValue('connected')});
    const local = makeLocal();
    const sel = new TransportSelector({capability, mesh, local});

    const res = await sel.tryDeliver(PK, makeWraps());

    expect(res.tier).toBe('local-ws');
    // send(port, frame) — the recipient's advertised port, then the frame.
    expect(local.ensureConnected).toHaveBeenCalledWith(33297);
    expect(local.send.mock.calls[0][0]).toBe(33297);
    const frame = JSON.parse(local.send.mock.calls[0][1]);
    expect(frame[0]).toBe('EVENT');
    // The wrap addressed to PK (not the self wrap) is the one that ships.
    expect(frame[1].id).toBe('wrap-recipient');
    expect(frame[1].tags).toContainEqual(['p', PK]);
  });

  it('single wrap (no self wrap) → ships it as the recipient wrap', async() => {
    const capability = new PeerCapabilityRegistry();
    capability.set(PK, {webrtc: true});
    const mesh = makeMesh({getStatus: vi.fn().mockReturnValue('connected')});
    const sel = new TransportSelector({capability, mesh, local: null});

    const res = await sel.tryDeliver(PK, [makeWrap(PK, 'only')]);

    expect(res.tier).toBe('webrtc');
    const frame = JSON.parse(mesh.send.mock.calls[0][1]);
    expect(frame[1].id).toBe('only');
  });

  it('no wrap addressed to the recipient (only a self wrap) → declines to relay', async() => {
    const capability = new PeerCapabilityRegistry();
    capability.set(PK, {webrtc: true});
    const mesh = makeMesh({getStatus: vi.fn().mockReturnValue('connected')});
    const sel = new TransportSelector({capability, mesh, local: null});

    // Two wraps, neither addressed to PK → cannot pick, declines.
    const res = await sel.tryDeliver(PK, [makeWrap(SELF, 'a'), makeWrap('d'.repeat(64), 'b')]);

    expect(res).toEqual({tier: 'relay', delivered: false});
    expect(mesh.send).not.toHaveBeenCalled();
  });
});

describe('TransportSelector — tier ordering', () => {
  it('prefers local-ws when the peer advertised it and the socket is up', async() => {
    const capability = new PeerCapabilityRegistry();
    capability.set(PK, {localWs: true, localWsPort: 33297, webrtc: true});
    const mesh = makeMesh({getStatus: vi.fn().mockReturnValue('connected')});
    const local = makeLocal();
    const sel = new TransportSelector({capability, mesh, local});

    const res = await sel.tryDeliver(PK, makeWraps());

    expect(res.tier).toBe('local-ws');
    expect(local.send).toHaveBeenCalledTimes(1);
    expect(mesh.send).not.toHaveBeenCalled();
  });

  it('skips local-ws when localWs is advertised but no port is known → webrtc', async() => {
    const capability = new PeerCapabilityRegistry();
    // localWs true but port 0 (stale/missing advert) — can't dial an unknown port.
    capability.set(PK, {localWs: true, localWsPort: 0, webrtc: true});
    const mesh = makeMesh({getStatus: vi.fn().mockReturnValue('connected')});
    const local = makeLocal();
    const sel = new TransportSelector({capability, mesh, local});

    const res = await sel.tryDeliver(PK, makeWraps());

    expect(res.tier).toBe('webrtc');
    expect(local.ensureConnected).not.toHaveBeenCalled();
    expect(mesh.send).toHaveBeenCalledTimes(1);
  });

  it('falls to webrtc when local is not advertised', async() => {
    const capability = new PeerCapabilityRegistry();
    capability.set(PK, {webrtc: true});
    const mesh = makeMesh({getStatus: vi.fn().mockReturnValue('connected')});
    const local = makeLocal();
    const sel = new TransportSelector({capability, mesh, local});

    const res = await sel.tryDeliver(PK, makeWraps());

    expect(res.tier).toBe('webrtc');
    expect(local.ensureConnected).not.toHaveBeenCalled();
    expect(mesh.send).toHaveBeenCalledTimes(1);
  });

  it('dht advertised alone (browser stub) → declines to relay', async() => {
    const capability = new PeerCapabilityRegistry();
    capability.set(PK, {dht: true});
    const mesh = makeMesh();
    const sel = new TransportSelector({capability, mesh, local: null});

    const res = await sel.tryDeliver(PK, makeWraps());
    expect(res).toEqual({tier: 'relay', delivered: false});
    expect(mesh.connect).not.toHaveBeenCalled();
  });
});

describe('TransportSelector — fast-fail down the chain', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('local-ws probe timeout falls through to webrtc without stalling', async() => {
    const capability = new PeerCapabilityRegistry();
    capability.set(PK, {localWs: true, localWsPort: 33297, webrtc: true});
    // ensureConnected never resolves → must be bounded by localTimeoutMs.
    const local = makeLocal({ensureConnected: vi.fn(() => new Promise(() => {}))});
    const mesh = makeMesh({getStatus: vi.fn().mockReturnValue('connected')});
    const sel = new TransportSelector({capability, mesh, local, localTimeoutMs: 80});

    const p = sel.tryDeliver(PK, makeWraps());
    await vi.advanceTimersByTimeAsync(80);
    const res = await p;

    expect(res.tier).toBe('webrtc');
    expect(local.send).not.toHaveBeenCalled();
    expect(mesh.send).toHaveBeenCalledTimes(1);
  });

  it('webrtc connect timeout → declines to relay (peer went offline)', async() => {
    const capability = new PeerCapabilityRegistry();
    capability.set(PK, {webrtc: true});
    // Stays 'connecting' forever → connectMeshWithTimeout must give up.
    const mesh = makeMesh({
      getStatus: vi.fn().mockReturnValue('connecting'),
      connect: vi.fn().mockResolvedValue(undefined)
    });
    const sel = new TransportSelector({capability, mesh, local: null, rtcConnectTimeoutMs: 300, rtcPollMs: 50});

    const p = sel.tryDeliver(PK, makeWraps());
    await vi.advanceTimersByTimeAsync(400);
    const res = await p;

    expect(res).toEqual({tier: 'relay', delivered: false});
    expect(mesh.connect).toHaveBeenCalledTimes(1);
    expect(mesh.send).not.toHaveBeenCalled();
  });

  it('webrtc connects mid-wait → delivers over webrtc', async() => {
    const capability = new PeerCapabilityRegistry();
    capability.set(PK, {webrtc: true});
    let status = 'disconnected';
    const mesh = makeMesh({
      getStatus: vi.fn(() => status),
      connect: vi.fn(async() => { status = 'connecting'; })
    });
    const sel = new TransportSelector({capability, mesh, local: null, rtcConnectTimeoutMs: 500, rtcPollMs: 50});

    const p = sel.tryDeliver(PK, makeWraps());
    // Simulate the channel opening after ~100ms.
    await vi.advanceTimersByTimeAsync(100);
    status = 'connected';
    await vi.advanceTimersByTimeAsync(100);
    const res = await p;

    expect(res.tier).toBe('webrtc');
    expect(mesh.send).toHaveBeenCalledTimes(1);
  });
});
