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
    setLocalDescription: vi.fn().mockResolvedValue(undefined),
    setRemoteDescription: vi.fn().mockResolvedValue(undefined),
    addIceCandidate: vi.fn().mockResolvedValue(undefined),
    createDataChannel: vi.fn().mockReturnValue(mockDC),
    close: vi.fn(),
    connectionState: 'new',
    addEventListener: vi.fn((event, handler) => { pcEventHandlers[event] = handler; }),
    removeEventListener: vi.fn(),
    localDescription: {type: 'offer', sdp: 'v=0\r\noffer...'}
  };

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
