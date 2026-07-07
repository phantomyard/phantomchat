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
});
