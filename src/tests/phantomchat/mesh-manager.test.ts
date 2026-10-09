// @ts-nocheck
import {describe, it, expect, vi, beforeEach, afterEach, afterAll} from 'vitest';
import {MeshManager} from '@lib/phantomchat/mesh-manager';

let mockDC;
let mockPC;
let dcEventHandlers;
let pcEventHandlers;

const _origRTCPeerConnection = globalThis.RTCPeerConnection;
const _origRTCSessionDescription = globalThis.RTCSessionDescription;

afterAll(() => {
  globalThis.RTCPeerConnection = _origRTCPeerConnection;
  globalThis.RTCSessionDescription = _origRTCSessionDescription;
});

beforeEach(() => {
  vi.useFakeTimers();

  dcEventHandlers = {};
  pcEventHandlers = {};

  mockDC = {
    readyState: 'connecting',
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn((event, handler) => { dcEventHandlers[event] = handler; }),
    removeEventListener: vi.fn()
  };

  mockPC = {
    createOffer: vi.fn().mockResolvedValue({type: 'offer', sdp: 'v=0\r\noffer...'}),
    createAnswer: vi.fn().mockResolvedValue({type: 'answer', sdp: 'v=0\r\nanswer...'}),
    setLocalDescription: vi.fn(),
    setRemoteDescription: vi.fn(),
    addIceCandidate: vi.fn().mockResolvedValue(undefined),
    createDataChannel: vi.fn().mockReturnValue(mockDC),
    close: vi.fn(),
    connectionState: 'new',
    signalingState: 'stable',
    localDescription: null,
    remoteDescription: null,
    addEventListener: vi.fn((event, handler) => { pcEventHandlers[event] = handler; }),
    removeEventListener: vi.fn()
  };

  // Model realistic signalingState transitions so the wrong-state guards can be
  // exercised the way a browser drives them: an offer applied to a stable pc
  // goes to have-remote-offer, a local offer to have-local-offer, and applying
  // an answer settles back to 'stable'.
  mockPC.setLocalDescription.mockImplementation((desc) => {
    mockPC.localDescription = desc;
    mockPC.signalingState = desc && desc.type === 'offer' ? 'have-local-offer' : 'stable';
    return Promise.resolve(undefined);
  });
  mockPC.setRemoteDescription.mockImplementation((desc) => {
    mockPC.remoteDescription = desc;
    mockPC.signalingState = desc && desc.type === 'offer' ? 'have-remote-offer' : 'stable';
    return Promise.resolve(undefined);
  });

  globalThis.RTCPeerConnection = vi.fn().mockImplementation(() => mockPC);
  globalThis.RTCSessionDescription = vi.fn().mockImplementation((desc) => desc);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeCallbacks() {
  return {
    sendSignal: vi.fn().mockResolvedValue(undefined),
    onPeerMessage: vi.fn(),
    onPeerConnected: vi.fn(),
    onPeerDisconnected: vi.fn()
  };
}

// Independent PC/DC stubs for bulk filler peers: the shared mockPC models ONE
// session's negotiated state, and 49 connect() calls on it would overwrite
// alice's cached answer (localDescription) the at-cap test needs to observe.
function makeStandalonePC() {
  const dc = {
    readyState: 'connecting',
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  };
  const pc: any = {
    createOffer: vi.fn().mockResolvedValue({type: 'offer', sdp: 'v=0\r\nfiller-offer...'}),
    createAnswer: vi.fn().mockResolvedValue({type: 'answer', sdp: 'v=0\r\nfiller-answer...'}),
    setLocalDescription: vi.fn(),
    setRemoteDescription: vi.fn(),
    addIceCandidate: vi.fn().mockResolvedValue(undefined),
    createDataChannel: vi.fn().mockReturnValue(dc),
    close: vi.fn(),
    connectionState: 'new',
    signalingState: 'stable',
    localDescription: null,
    remoteDescription: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  };
  pc.setLocalDescription.mockImplementation((desc) => {
    pc.localDescription = desc;
    pc.signalingState = desc && desc.type === 'offer' ? 'have-local-offer' : 'stable';
    return Promise.resolve(undefined);
  });
  pc.setRemoteDescription.mockImplementation((desc) => {
    pc.remoteDescription = desc;
    pc.signalingState = desc && desc.type === 'offer' ? 'have-remote-offer' : 'stable';
    return Promise.resolve(undefined);
  });
  return pc;
}

describe('MeshManager', () => {
  it('getStatus returns disconnected for unknown peer', () => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);
    expect(manager.getStatus('unknown-pubkey')).toBe('disconnected');
  });

  it('connect() as initiator sets connecting and sends an offer signal', async() => {
    const callbacks = makeCallbacks();
    // ownPubkey '' < 'peer1' → we are the initiator, so we create the offer.
    const manager = new MeshManager(callbacks, undefined, '');

    await manager.connect('peer1');

    expect(manager.getStatus('peer1')).toBe('connecting');
    expect(callbacks.sendSignal).toHaveBeenCalledOnce();
    const [recipientPubkey, signal] = callbacks.sendSignal.mock.calls[0];
    expect(recipientPubkey).toBe('peer1');
    expect(signal.t).toBe('offer');
    expect(signal.sdp).toContain('v=0');
  });

  it('connect() as responder sends a hello nudge and creates no PC', async() => {
    const callbacks = makeCallbacks();
    // ownPubkey 'zzzz' > 'peer1' → we are the responder: nudge + wait for offer.
    const manager = new MeshManager(callbacks, undefined, 'zzzz');

    await manager.connect('peer1');

    expect(callbacks.sendSignal).toHaveBeenCalledWith('peer1', {t: 'hello'});
    expect(globalThis.RTCPeerConnection).not.toHaveBeenCalled();
  });

  it('handleSignal(hello) makes the initiator send an offer', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks, undefined, ''); // initiator vs any peer

    await manager.handleSignal('peer1', {t: 'hello'});

    expect(globalThis.RTCPeerConnection).toHaveBeenCalled();
    expect(callbacks.sendSignal).toHaveBeenCalledWith('peer1', expect.objectContaining({t: 'offer'}));
  });

  it('send() returns false for disconnected peer', () => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    const result = manager.send('nonexistent-peer', 'hello');
    expect(result).toBe(false);
  });

  it('getConnectedPeers() returns empty array initially', () => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    expect(manager.getConnectedPeers()).toEqual([]);
  });

  it('DataChannel open event triggers onPeerConnected callback', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    await manager.connect('peer1');

    mockDC.readyState = 'open';
    dcEventHandlers.open?.();

    expect(manager.getStatus('peer1')).toBe('connected');
    expect(callbacks.onPeerConnected).toHaveBeenCalledWith('peer1');
    expect(manager.getConnectedPeers()).toContain('peer1');
  });

  it('DataChannel message with PING sends PONG back', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    await manager.connect('peer1');

    mockDC.readyState = 'open';
    dcEventHandlers.open?.();

    dcEventHandlers.message?.({data: 'PING'});

    expect(mockDC.send).toHaveBeenCalledWith('PONG');
    expect(callbacks.onPeerMessage).not.toHaveBeenCalled();
  });

  it('DataChannel message with non-PING forwards to onPeerMessage', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    await manager.connect('peer1');

    mockDC.readyState = 'open';
    dcEventHandlers.open?.();

    dcEventHandlers.message?.({data: 'hello world'});

    expect(callbacks.onPeerMessage).toHaveBeenCalledWith('peer1', 'hello world');
  });

  it('disconnect() prevents auto-reconnect', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    await manager.connect('peer1');

    mockDC.readyState = 'open';
    dcEventHandlers.open?.();

    manager.disconnect('peer1');

    expect(manager.getStatus('peer1')).toBe('disconnected');

    // Advance timers well past any reconnect delay
    vi.advanceTimersByTime(30000);

    // RTCPeerConnection should only have been called once (the initial connect)
    expect(globalThis.RTCPeerConnection).toHaveBeenCalledTimes(1);
    expect(manager.getConnectedPeers()).toEqual([]);
  });

  it('handleSignal with offer creates answer and sends it back', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks, undefined, '');

    await manager.handleSignal('alice', {t: 'offer', sdp: 'v=0\r\noffer-from-alice'});

    expect(globalThis.RTCPeerConnection).toHaveBeenCalled();
    expect(mockPC.setRemoteDescription).toHaveBeenCalled();
    expect(mockPC.createAnswer).toHaveBeenCalled();
    expect(mockPC.setLocalDescription).toHaveBeenCalled();
    expect(callbacks.sendSignal).toHaveBeenCalledWith('alice', expect.objectContaining({t: 'answer'}));
    expect(manager.getStatus('alice')).toBe('connecting');
  });

  it('handleSignal with answer sets remote description', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks, undefined, '');

    await manager.connect('bob'); // initiator → creates PC
    mockPC.setRemoteDescription.mockClear();

    await manager.handleSignal('bob', {t: 'answer', sdp: 'v=0\r\nanswer-from-bob'});

    expect(mockPC.setRemoteDescription).toHaveBeenCalledWith(
      expect.objectContaining({type: 'answer', sdp: 'v=0\r\nanswer-from-bob'})
    );
  });

  it('ignores a re-delivered answer after negotiation settled (no wrong-state throw)', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks, undefined, '');

    await manager.connect('bob');
    await manager.handleSignal('bob', {t: 'answer', sdp: 'v=0\r\nanswer-from-bob'});
    expect(mockPC.signalingState).toBe('stable');

    mockPC.setRemoteDescription.mockClear();
    await manager.handleSignal('bob', {t: 'answer', sdp: 'v=0\r\nanswer-from-bob'}); // relay re-delivery

    expect(mockPC.setRemoteDescription).not.toHaveBeenCalled();
  });

  it('ignores a stray answer when no local offer is outstanding', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks, undefined, '');

    await manager.handleSignal('alice', {t: 'offer', sdp: 'v=0\r\noffer-from-alice'});
    // We are the answerer: the pc settled to 'stable'. A wrong-role answer
    // must be a logged no-op, not a wrong-state throw.
    expect(mockPC.signalingState).toBe('stable');
    mockPC.setRemoteDescription.mockClear();

    await manager.handleSignal('alice', {t: 'answer', sdp: 'v=0\r\nstray-answer'});

    expect(mockPC.setRemoteDescription).not.toHaveBeenCalled();
  });

  it('ignores a re-delivered offer whose SDP matches an established session', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks, undefined, '');

    await manager.handleSignal('alice', {t: 'offer', sdp: 'v=0\r\noffer-from-alice'});
    // Establish the session (the answerer's dc arrives via 'datachannel').
    pcEventHandlers.datachannel?.({channel: mockDC});
    mockDC.readyState = 'open';
    dcEventHandlers.open?.();
    expect(manager.getStatus('alice')).toBe('connected');
    const pcCount = globalThis.RTCPeerConnection.mock.calls.length;

    await manager.handleSignal('alice', {t: 'offer', sdp: 'v=0\r\noffer-from-alice'}); // duplicate relay delivery

    expect(globalThis.RTCPeerConnection).toHaveBeenCalledTimes(pcCount);
    expect(callbacks.sendSignal).toHaveBeenCalledTimes(1); // no second answer
  });

  it('resends the cached answer for a re-delivered identical offer after a failed answer publish', async() => {
    const callbacks = makeCallbacks();
    // Model Kai's repro: the first answer publish dies in a relay outage.
    // (The harness's sendSignal used to resolve unconditionally, leaving the
    // publish-failure path unmodeled.)
    callbacks.sendSignal.mockRejectedValueOnce(new Error('relay publish failed'));
    const manager = new MeshManager(callbacks, undefined, '');

    await manager.handleSignal('alice', {t: 'offer', sdp: 'v=0\r\noffer-from-alice'});
    expect(manager.getStatus('alice')).toBe('connecting');
    const pcCount = globalThis.RTCPeerConnection.mock.calls.length;

    // The peer replays the identical offer — its only active recovery.
    await manager.handleSignal('alice', {t: 'offer', sdp: 'v=0\r\noffer-from-alice'});

    // The cached answer is RESENT; the session is neither torn down nor rebuilt.
    expect(globalThis.RTCPeerConnection).toHaveBeenCalledTimes(pcCount);
    const answerSignals = callbacks.sendSignal.mock.calls.filter(([_pk, sig]: [any, any]) => sig.t === 'answer');
    expect(answerSignals).toHaveLength(2);
    expect(answerSignals[1][1].sdp).toBe('v=0\r\nanswer...');

    // The re-sent answer completes the session.
    pcEventHandlers.datachannel?.({channel: mockDC});
    mockDC.readyState = 'open';
    dcEventHandlers.open?.();
    expect(manager.getStatus('alice')).toBe('connected');
  });

  it('an at-cap replay from a tracked peer still resends the cached answer', async() => {
    const callbacks = makeCallbacks();
    callbacks.sendSignal.mockRejectedValueOnce(new Error('relay publish failed'));
    const manager = new MeshManager(callbacks, undefined, '');

    await manager.handleSignal('alice', {t: 'offer', sdp: 'v=0\r\noffer-from-alice'});
    expect(manager.getStatus('alice')).toBe('connecting');

    // Fill the map to exactly MAX_CONNECTIONS (Kai's repro), with alice's
    // shared mockPC kept intact by giving every filler its own PC.
    globalThis.RTCPeerConnection.mockImplementation(() => makeStandalonePC());
    for(let i = 0; i < 49; i++) {
      await manager.connect(`filler-${i}`);
    }
    expect((manager as any).peers.size).toBe(50);
    const pcCount = globalThis.RTCPeerConnection.mock.calls.length;

    // Alice replays the identical offer at the cap: the capacity guard must
    // not shadow the tracked-peer replay path, or her answer is never
    // re-sent and both sides wedge 'connecting'.
    await manager.handleSignal('alice', {t: 'offer', sdp: 'v=0\r\noffer-from-alice'});

    expect(globalThis.RTCPeerConnection).toHaveBeenCalledTimes(pcCount); // no rebuild
    const answerSignals = callbacks.sendSignal.mock.calls.filter(([_pk, sig]: [any, any]) => sig.t === 'answer');
    expect(answerSignals).toHaveLength(2);
    expect(answerSignals[1][1].sdp).toBe('v=0\r\nanswer...'); // the CACHED answer
  });

  it('the connection cap still drops an offer from a NEW peer at capacity', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks, undefined, '');

    globalThis.RTCPeerConnection.mockImplementation(() => makeStandalonePC());
    for(let i = 0; i < 50; i++) {
      await manager.connect(`filler-${i}`);
    }
    expect((manager as any).peers.size).toBe(50);
    const pcCount = globalThis.RTCPeerConnection.mock.calls.length;
    const signalCount = callbacks.sendSignal.mock.calls.length;

    // The cap applies to pubkeys we do not track yet.
    await manager.handleSignal('newcomer', {t: 'offer', sdp: 'v=0\r\noffer-from-newcomer'});

    expect(globalThis.RTCPeerConnection).toHaveBeenCalledTimes(pcCount);
    expect(callbacks.sendSignal.mock.calls.length).toBe(signalCount);
    expect(manager.getStatus('newcomer')).toBe('disconnected');
  });

  it('a different-SDP offer tears the previous session down before replacing it', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks, undefined, '');

    await manager.handleSignal('alice', {t: 'offer', sdp: 'v=0\r\noffer-v1'});
    pcEventHandlers.datachannel?.({channel: mockDC});
    mockDC.readyState = 'open';
    dcEventHandlers.open?.();
    const oldState = (manager as any).peers.get('alice');
    expect(oldState.pingTimer).not.toBeNull();
    expect(oldState.pingTimeoutTimer).not.toBeNull();

    // Genuine renegotiation: same peer, DIFFERENT SDP.
    await manager.handleSignal('alice', {t: 'offer', sdp: 'v=0\r\noffer-v2'});

    // The old session is fully torn down — no orphaned pc or live timers.
    const newState = (manager as any).peers.get('alice');
    expect(newState.sessionId).not.toBe(oldState.sessionId);
    expect(oldState.status).toBe('disconnected');
    expect(oldState.pingTimer).toBeNull();
    expect(oldState.pingTimeoutTimer).toBeNull();
    expect(oldState.reconnectTimer).toBeNull();
    expect(mockDC.close).toHaveBeenCalled();
    expect(mockPC.close).toHaveBeenCalled();

    // The replacement negotiated normally.
    const answerSignals = callbacks.sendSignal.mock.calls.filter(([_pk, sig]: [any, any]) => sig.t === 'answer');
    expect(answerSignals).toHaveLength(2);
  });

  it('a failed replacement apply leaves no live timers or peers behind', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks, undefined, '');

    await manager.handleSignal('alice', {t: 'offer', sdp: 'v=0\r\noffer-v1'});
    pcEventHandlers.datachannel?.({channel: mockDC});
    mockDC.readyState = 'open';
    dcEventHandlers.open?.();
    const oldState = (manager as any).peers.get('alice');

    // The replacement offer's apply fails after the map was overwritten: the
    // old peer must NOT survive as an orphan with live timers.
    mockPC.setRemoteDescription.mockRejectedValueOnce(new Error('bogus SDP'));
    await manager.handleSignal('alice', {t: 'offer', sdp: 'v=0\r\noffer-v2'});

    expect((manager as any).peers.size).toBe(0);
    expect(oldState.pingTimer).toBeNull();
    expect(oldState.pingTimeoutTimer).toBeNull();
    expect(oldState.reconnectTimer).toBeNull();

    // No answer published for the dead replacement.
    const answerSignals = callbacks.sendSignal.mock.calls.filter(([_pk, sig]: [any, any]) => sig.t === 'answer');
    expect(answerSignals).toHaveLength(1);
  });

  it('swallows setRemoteDescription(answer) failures instead of rejecting', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks, undefined, '');

    await manager.connect('bob');
    mockPC.setRemoteDescription.mockRejectedValue(
      new Error("Failed to execute 'setRemoteDescription': Called in wrong state: stable")
    );

    await expect(
      manager.handleSignal('bob', {t: 'answer', sdp: 'v=0\r\nanswer-from-bob'})
    ).resolves.toBeUndefined();

    // Remote description never landed, so a follow-up candidate must still be
    // buffered rather than applied to a bare pc.
    await manager.handleSignal('bob', {
      t: 'candidate',
      candidate: 'candidate:x 1 UDP 1 10.0.0.9 40009 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0
    });
    expect(mockPC.addIceCandidate).not.toHaveBeenCalled();
  });

  it('swallows setRemoteDescription(offer) failures and drops the half-built peer', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks, undefined, '');
    mockPC.setRemoteDescription.mockRejectedValue(new Error('bogus SDP'));

    await expect(
      manager.handleSignal('alice', {t: 'offer', sdp: 'v=0\r\nbad'})
    ).resolves.toBeUndefined();

    expect(callbacks.sendSignal).not.toHaveBeenCalled(); // no answer for a dead pc
    expect(manager.getStatus('alice')).toBe('disconnected');
  });

  it('handleSignal with candidate adds it once the remote description is set', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks, undefined, '');

    await manager.connect('bob'); // initiator: local offer set, remote not yet
    // Answer sets the remote description → candidates may now be applied.
    await manager.handleSignal('bob', {t: 'answer', sdp: 'v=0\r\nanswer-from-bob'});

    await manager.handleSignal('bob', {
      t: 'candidate',
      candidate: 'candidate:1 1 UDP 2122252543 192.168.1.1 50000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0
    });

    expect(mockPC.addIceCandidate).toHaveBeenCalledWith(
      expect.objectContaining({candidate: expect.stringContaining('candidate:1'), sdpMid: '0', sdpMLineIndex: 0})
    );
  });

  it('buffers a candidate that arrives before any peer exists, then flushes it on the offer', async() => {
    const callbacks = makeCallbacks();
    // Responder role: no PC exists until the offer lands. A candidate that beats
    // the offer must be buffered, not dropped.
    const manager = new MeshManager(callbacks, undefined, '');

    await manager.handleSignal('alice', {
      t: 'candidate',
      candidate: 'candidate:early 1 UDP 1 10.0.0.1 40000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0
    });

    // Not applied yet — no peer, no remote description.
    expect(mockPC.addIceCandidate).not.toHaveBeenCalled();

    // Offer arrives → setRemoteDescription → buffered candidate is flushed.
    await manager.handleSignal('alice', {t: 'offer', sdp: 'v=0\r\noffer-from-alice'});

    expect(mockPC.addIceCandidate).toHaveBeenCalledWith(
      expect.objectContaining({candidate: expect.stringContaining('candidate:early')})
    );
  });

  it('buffers a candidate that arrives before the answer, then flushes it', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks, undefined, ''); // initiator

    await manager.connect('bob'); // PC exists, remote description NOT set yet

    await manager.handleSignal('bob', {
      t: 'candidate',
      candidate: 'candidate:pre-answer 1 UDP 1 10.0.0.2 40001 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0
    });

    // Peer exists but no remote description → still buffered, not applied.
    expect(mockPC.addIceCandidate).not.toHaveBeenCalled();

    await manager.handleSignal('bob', {t: 'answer', sdp: 'v=0\r\nanswer-from-bob'});

    expect(mockPC.addIceCandidate).toHaveBeenCalledWith(
      expect.objectContaining({candidate: expect.stringContaining('candidate:pre-answer')})
    );
  });

  it('handleSignal(bye) disconnects the peer', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks, undefined, '');

    await manager.connect('bob');
    await manager.handleSignal('bob', {t: 'bye'});

    expect(manager.getStatus('bob')).toBe('disconnected');
  });

  it('connect() throws when max connections reached', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks, undefined, ''); // always initiator

    for(let i = 0; i < 50; i++) {
      await manager.connect(`peer-${i}`);
    }

    await expect(manager.connect('peer-50')).rejects.toThrow('Max connections');
  });

  it('disconnectAll() disconnects all peers', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    await manager.connect('alice');
    await manager.connect('bob');

    manager.disconnectAll();

    expect(manager.getConnectedPeers()).toEqual([]);
    expect(manager.getStatus('alice')).toBe('disconnected');
    expect(manager.getStatus('bob')).toBe('disconnected');
  });

  it('restartAll() tears down and immediately rebuilds all peers with fresh PCs', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks, undefined, '');

    await manager.connect('alice');
    await manager.connect('bob');

    const initialPcCount = globalThis.RTCPeerConnection.mock.calls.length;

    manager.restartAll();

    // restartAll() calls disconnect() then connect() synchronously.
    // connect() inserts the peer as 'connecting' right away, so there's
    // no transient 'disconnected' window — the fast path is intentional.
    expect(manager.getStatus('alice')).toBe('connecting');
    expect(manager.getStatus('bob')).toBe('connecting');

    // Fresh RTCPeerConnections created (one per peer)
    await vi.advanceTimersByTimeAsync(0);
    expect(globalThis.RTCPeerConnection).toHaveBeenCalledTimes(initialPcCount + 2);
  });

  it('restartAll() cancels pending reconnect timers from a prior disconnect', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks, undefined, '');

    await manager.connect('alice');
    mockDC.readyState = 'open';
    dcEventHandlers.open?.();

    // Trigger a disconnect → schedules a reconnect in 1s
    dcEventHandlers.close?.();
    expect(manager.getStatus('alice')).toBe('disconnected');

    const initialPcCount = globalThis.RTCPeerConnection.mock.calls.length;

    // Restart BEFORE the scheduled reconnect fires
    manager.restartAll();
    await vi.advanceTimersByTimeAsync(0);

    // The scheduled reconnect from handleDisconnect must NOT fire later,
    // because disconnect() set reconnectAttempts = Infinity.
    await vi.advanceTimersByTimeAsync(30000);

    // Only the restartAll reconnect happened (+1 PC), not the old timer too.
    expect(globalThis.RTCPeerConnection).toHaveBeenCalledTimes(initialPcCount + 1);
  });

  it('send() returns true for connected peer with open DataChannel', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    await manager.connect('peer1');
    mockDC.readyState = 'open';
    dcEventHandlers.open?.();

    const result = manager.send('peer1', 'test message');
    expect(result).toBe(true);
    expect(mockDC.send).toHaveBeenCalledWith('test message');
  });

  it('getPeerLatency returns -1 for unknown peer and updates after PONG', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    expect(manager.getPeerLatency('unknown')).toBe(-1);

    await manager.connect('peer1');
    mockDC.readyState = 'open';
    dcEventHandlers.open?.();

    expect(manager.getPeerLatency('peer1')).toBe(-1);
  });

  it('DataChannel close triggers onPeerDisconnected', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    await manager.connect('peer1');
    mockDC.readyState = 'open';
    dcEventHandlers.open?.();

    dcEventHandlers.close?.();

    expect(callbacks.onPeerDisconnected).toHaveBeenCalledWith('peer1');
    expect(manager.getStatus('peer1')).toBe('disconnected');
  });

  it('PC connectionState failed triggers onPeerDisconnected', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    await manager.connect('peer1');
    mockDC.readyState = 'open';
    dcEventHandlers.open?.();

    mockPC.connectionState = 'failed';
    pcEventHandlers.connectionstatechange?.();

    expect(callbacks.onPeerDisconnected).toHaveBeenCalledWith('peer1');
  });

  it('schedules reconnect with increasing delays after disconnect', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    await manager.connect('peer1');
    mockDC.readyState = 'open';
    dcEventHandlers.open?.();

    const initialCallCount = globalThis.RTCPeerConnection.mock.calls.length;

    dcEventHandlers.close?.();

    expect(globalThis.RTCPeerConnection).toHaveBeenCalledTimes(initialCallCount);

    await vi.advanceTimersByTimeAsync(1100);

    expect(globalThis.RTCPeerConnection).toHaveBeenCalledTimes(initialCallCount + 1);
  });

  it('handleSignal ignores non-signal content', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    await manager.handleSignal('alice', 'not json');
    await manager.handleSignal('alice', JSON.stringify({type: 'other'}));

    expect(globalThis.RTCPeerConnection).not.toHaveBeenCalled();
  });

  // #61 R3 — the honest "rock-solid" badge: isVerified is the signal the badge
  // gates green on. A channel that merely fired `open` is NOT verified until a
  // PING/PONG round-trip proves it live.
  describe('isVerified (badge liveness gate)', () => {
    it('is false right after open (channel up, no PONG yet) — no optimistic green', async() => {
      const callbacks = makeCallbacks();
      const manager = new MeshManager(callbacks);

      await manager.connect('peer1');
      mockDC.readyState = 'open';
      dcEventHandlers.open?.();

      // Connected, but not yet proven live.
      expect(manager.getStatus('peer1')).toBe('connected');
      expect(manager.isVerified('peer1')).toBe(false);
      // An immediate verification PING was sent on open.
      expect(mockDC.send).toHaveBeenCalledWith('PING');
    });

    it('becomes true after a PONG and fires onPeerVerified exactly once', async() => {
      const callbacks = {...makeCallbacks(), onPeerVerified: vi.fn()};
      const manager = new MeshManager(callbacks);

      await manager.connect('peer1');
      mockDC.readyState = 'open';
      dcEventHandlers.open?.();

      dcEventHandlers.message?.({data: 'PONG'});
      expect(manager.isVerified('peer1')).toBe(true);
      expect(callbacks.onPeerVerified).toHaveBeenCalledWith('peer1');
      expect(callbacks.onPeerVerified).toHaveBeenCalledTimes(1);

      // A second PONG does not re-fire the rising-edge callback.
      dcEventHandlers.message?.({data: 'PONG'});
      expect(callbacks.onPeerVerified).toHaveBeenCalledTimes(1);
    });

    it('goes false again once the channel disconnects', async() => {
      const callbacks = {...makeCallbacks(), onPeerVerified: vi.fn()};
      const manager = new MeshManager(callbacks);

      await manager.connect('peer1');
      mockDC.readyState = 'open';
      dcEventHandlers.open?.();
      dcEventHandlers.message?.({data: 'PONG'});
      expect(manager.isVerified('peer1')).toBe(true);

      dcEventHandlers.close?.();
      expect(manager.isVerified('peer1')).toBe(false);
    });

    it('is false for an unknown peer', () => {
      const manager = new MeshManager(makeCallbacks());
      expect(manager.isVerified('nobody')).toBe(false);
    });
  });

  // Lena review (#68): a second interval PING must not fire while the previous
  // one is still unanswered — otherwise pingSentTime is overwritten and the
  // latency / verification round-trip is measured against the wrong ping.
  describe('ping cadence (one outstanding at a time)', () => {
    it('does not stack a second PING while a PONG is still pending', async() => {
      const manager = new MeshManager(makeCallbacks());

      await manager.connect('peer1');
      mockDC.readyState = 'open';
      dcEventHandlers.open?.();

      // Immediate verification PING on open.
      expect(mockDC.send).toHaveBeenCalledTimes(1);
      expect(mockDC.send).toHaveBeenLastCalledWith('PING');

      // Interval fires with the first PONG still outstanding → no second PING.
      await vi.advanceTimersByTimeAsync(30000);
      expect(mockDC.send).toHaveBeenCalledTimes(1);

      // The PONG clears the outstanding ping; the next interval sends a fresh one.
      dcEventHandlers.message?.({data: 'PONG'});
      await vi.advanceTimersByTimeAsync(30000);
      expect(mockDC.send).toHaveBeenCalledTimes(2);
      expect(mockDC.send).toHaveBeenLastCalledWith('PING');
    });
  });

  // Lena/Kai review (#82): stale signals from a replaced session must be
  // dropped. If restartAll() fires while an in-flight startOffer() is awaiting
  // createOffer, the old operation must not publish after the new peer state is
  // created.
  describe('generation guard (sessionId) blocks stale signals across restartAll()', () => {
    it('startOffer() aborted after restartAll() does not publish a stale offer', async() => {
      const callbacks = makeCallbacks();
      const manager = new MeshManager(callbacks, undefined, ''); // initiator

      let resolveFirstOffer: (() => void) | null = null;
      let offerCallCount = 0;
      mockPC.createOffer = vi.fn().mockImplementation(() => {
        offerCallCount++;
        if(offerCallCount === 1) {
          return new Promise((resolve) => {
            resolveFirstOffer = () => resolve({type: 'offer', sdp: 'v=0\r\nstale...'});
          });
        }
        return Promise.resolve({type: 'offer', sdp: 'v=0\r\nfresh...'});
      });

      // First connect enters startOffer but createOffer hangs.
      const connectPromise = manager.connect('alice');

      // Restart while the first createOffer is still pending.
      manager.restartAll();
      await vi.advanceTimersByTimeAsync(0);

      // A new 'connecting' session should exist.
      expect(manager.getStatus('alice')).toBe('connecting');

      // The stale createOffer finally resolves → should be dropped by the guard.
      resolveFirstOffer!();
      await Promise.resolve();

      // Only ONE offer should have been published (the fresh session's).
      const offerSignals = callbacks.sendSignal.mock.calls.filter(([_pk, sig]: [any, any]) => sig.t === 'offer');
      expect(offerSignals).toHaveLength(1);
      // setLocalDescription should also only have been called for the fresh session.
      expect(mockPC.setLocalDescription).toHaveBeenCalledTimes(1);

      await connectPromise;
    });

    it('handleOffer() aborted after restartAll() does not publish a stale answer', async() => {
      const callbacks = makeCallbacks();
      // '' < 'alice' → initiator on our side, but here we test the responder
      // path by invoking handleOffer directly.
      const manager = new MeshManager(callbacks, undefined, 'zzzz');

      let resolveSetRemote: (() => void) | null = null;
      mockPC.setRemoteDescription = vi.fn().mockImplementation(() => {
        return new Promise((resolve) => {
          resolveSetRemote = () => resolve(undefined);
        });
      });

      // First offer arrives — handleOffer enters but setRemoteDescription hangs.
      const handlePromise = manager.handleSignal('alice', {t: 'offer', sdp: 'v=0\r\nfirst-offer'});

      // While the responder is still awaiting setRemoteDescription, the initiator
      // restarts and sends a new offer. For this test we simulate restartAll()
      // locally (disconnect + reconnect on the responder side isn't automatic,
      // but a duplicate offer from a new initiator session would arrive).
      manager.disconnect('alice');

      // Now the first (stale) setRemoteDescription resolves.
      resolveSetRemote!();
      await Promise.resolve();

      // The stale handleOffer should have been dropped by the guard before
      // createAnswer / setLocalDescription / sendSignal.
      expect(mockPC.createAnswer).not.toHaveBeenCalled();
      expect(mockPC.setLocalDescription).not.toHaveBeenCalled();
      const answerSignals = callbacks.sendSignal.mock.calls.filter(([_pk, sig]: [any, any]) => sig.t === 'answer');
      expect(answerSignals).toHaveLength(0);

      await handlePromise;
    });

    it('ignores stale ICE candidate signals after restartAll()', async() => {
      const callbacks = makeCallbacks();
      const manager = new MeshManager(callbacks, undefined, '');

      await manager.connect('alice');

      // Capture the first session's sessionId by inspecting internal state.
      // (We can't in production, but for the test we know it was created.)
      const firstState = (manager as any).peers.get('alice');
      const firstSessionId = firstState.sessionId;

      // A candidate arrives for the first session.
      const candidateSignal = {
        t: 'candidate',
        candidate: 'candidate:old 1 UDP 1 10.0.0.1 50000 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0
      } as any;

      // Before it can be applied, restartAll replaces the peer.
      manager.restartAll();
      await vi.advanceTimersByTimeAsync(0);

      // The new peer has a different sessionId.
      const newState = (manager as any).peers.get('alice');
      expect(newState.sessionId).not.toBe(firstSessionId);

      // Now the old candidate is processed. The handler must not add it to
      // the new peer because the sessionId check fails.
      mockPC.addIceCandidate.mockClear();
      await manager.handleSignal('alice', candidateSignal);

      // The candidate should have been buffered but NOT applied.
      expect(mockPC.addIceCandidate).not.toHaveBeenCalled();
    });
  });
});
